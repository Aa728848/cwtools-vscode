/**
 * Target Weight Panel — Webview host for the Stellaris targeting-weight analyzer.
 *
 * 数据流（与 techTreePanel 同构）：
 * 1. 在工作区与「已配置游戏根」下枚举 common/component_templates/*.txt 与 common/ship_sizes/*.txt
 * 2. 用纯函数 targetWeightExtract.ts 提取索敌字段（一切文件 I/O 只在 Host 侧）
 * 3. 用户在 webview 里填候选目标参数 → postMessage 回 Host
 * 4. Host 调 ai/targetingWeights.ts 的 computeTargetingChain，把完整乘法链回传渲染
 *
 * 机制与公式见 docs/stellaris-targeting-weight-4.5.2.md §2/§3/§5。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { panelLocale, panelText } from './panelI18n';
import { ErrorReporter } from './ai/errorReporter';
import { getConfiguredGameRoots } from './configuredGameRoots';
import type { IndexService } from './indexing/indexService';
import { getDefaultLocalisationLanguagesForUiLocale, getPreferredLocalisationLanguageTags, pickPreferredLocalisationEntry } from './localisationLanguagePreference';
import { parseLocFile } from './indexing/locParser';
import {
    computeTargetingChain,
    parseTargetingChainInput,
    type TargetingChainInput,
} from './ai/targetingWeights';
import {
    TARGETING_FIELD_FALLBACKS,
    applyCsvWeaponStats,
    buildInlineScriptRegistry,
    collectLocalisationReferences,
    expandInlineScriptFields,
    extractShipSizeDetails,
    extractTargetingFields,
    findComponentTemplateIdAtLine,
    formatComponentDisplayLabel,
    isTargetingRelevant,
    mergeComputeWeaponInput,
    mergeCsvStatMaps,
    mergeScriptedVariables,
    mergeShipSizeDetails,
    mergeWeaponTargetingEntries,
    normalizeInlineScriptKey,
    parseInlineScriptTemplate,
    parseScriptedVariables,
    parseWeaponComponentsCsv,
    resolveLocalisationReferences,
    type CsvStatsSourceGroup,
    type InlineScriptSourceGroup,
    type ShipSizeDetail,
    type ShipSizeDetailGroup,
    type WeaponTargetingEntry,
    type WeaponTargetingSourceGroup,
} from './ai/targetWeightExtract';

/** 与 techTreePanel 的 TECH_FILE_LIMIT_PER_ROOT 同量级的文件数上限，避免超大 mod 拖死扫描。 */
const TARGET_WEIGHT_FILE_LIMIT_PER_ROOT = 2000;
const TARGET_WEIGHT_FILE_GLOB = '**/common/component_templates/*.txt';
const SHIP_SIZE_FILE_GLOB = '**/common/ship_sizes/*.txt';
/** vanilla 的武器战斗数值在 CSV（weapon_components.csv），mod 也可自带。 */
const COMPONENT_CSV_GLOB = '**/common/component_templates/*.csv';
/** ship_size 的 size_multiplier 等常用 @脚本变量，需要跨根合并后解析。 */
const SCRIPTED_VARIABLES_GLOB = '**/common/scripted_variables/*.txt';
/** mod 常把武器数值写进 inline_script 参数（KEY/ACCURACY/MULT…），需要脚本注册表做字段级展开。 */
const INLINE_SCRIPT_GLOB = '**/common/inline_scripts/**/*.txt';
/** 本地化 $ref$ 解析用的每「根+语言」全量键值上限（仅在有 $ref$ 时惰性构建）。 */
const VANILLA_LOC_REF_ENTRY_LIMIT = 200_000;
/** vanilla 本地化定向扫描的每语言文件数上限（IndexService 只索引工作区本地化）。 */
const VANILLA_LOC_FILE_LIMIT_PER_LANGUAGE = 400;
const TARGET_WEIGHT_EXCLUDE_GLOB = '**/{node_modules,.git,.cwtools}/**';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

/**
 * 回跳白名单用的路径键：Windows 上 fsPath 的大小写与分隔符都可能与扫描时不一致，
 * 统一成「反斜杠 + 小写」再比对，否则白名单会把合法来源文件判成越权路径。
 */
function scannedPathKey(filePath: string): string {
    // path.normalize 在 win32 上已把 '/' 统一成 '\'，再比大小写即可。
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

interface TargetWeightWeaponOption {
    id: string;
    displayLabel: string;
    templateTypeKey: string;
    type?: string;
    source: 'workspace' | 'vanilla';
    useShipMainTarget: boolean;
    targetWeightKeys: string[];
    missingKeys: string[];
    dynamicKeys: string[];
    /** 由 weapon_components.csv 补入的字段（webview 显示「CSV」徽标）。 */
    csvKeys: string[];
}

/** init 载荷里的 ship_size 选项：本地化名 + 从 ship_sizes 定义解析出的预填值。 */
interface ShipSizeOption {
    id: string;
    label: string;
    /** size_multiplier（σ）；定义里解析不出（如 @变量缺失）时缺省。 */
    sizeMultiplier?: number;
    /** 基础闪避（0..1；modifier.ship_evasion_add 百分制 ÷100，不含推进器等加成）。 */
    evasion?: number;
    /** max_hitpoints → 船体上限预填。 */
    maxHitpoints?: number;
}

/** 打开面板时可带的一次性上下文。 */
export interface TargetWeightOpenOptions {
    /** 本地化索引：把组件 id 解析成本地化名显示在下拉里。 */
    indexService?: IndexService;
    /** 编辑器右键菜单入口：光标所在的顶层块，用于预选中对应武器模板。 */
    cursor?: { document: vscode.TextDocument; line: number };
}

interface ScanRoot {
    uri: vscode.Uri;
    source: 'workspace' | 'vanilla';
}

interface ScanStats {
    files: number;
    templates: number;
}

interface TargetWeightScanResult {
    weapons: WeaponTargetingEntry[];
    shipSizes: ShipSizeDetail[];
    stats: Record<'workspace' | 'vanilla', ScanStats>;
}

export class TargetWeightPanel {
    public static currentPanel: TargetWeightPanel | undefined;
    private static readonly viewType = 'cwtools-target-weights';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private readonly _indexService: IndexService | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _weapons: WeaponTargetingEntry[] = [];
    private _scannedFiles = new Set<string>();
    private _loaded = false;
    /** 目录扫描结果，等 _loadAndSendCatalogue 用它渲染下拉。 */
    private _scan: TargetWeightScanResult = {
        weapons: [],
        shipSizes: [],
        stats: { workspace: { files: 0, templates: 0 }, vanilla: { files: 0, templates: 0 } },
    };
    /** 编辑器右键菜单带入的初始选中项；加载完目录后用一次。 */
    private _pendingInitialId: string | undefined;
    /** vanilla 本地化全量键值缓存（`根|语言` 键）：只在遇到 $ref$ 引用时惰性构建。 */
    private readonly _locRefCache = new Map<string, Map<string, string>>();

    public static async create(extensionPath: string, options: TargetWeightOpenOptions = {}) {
        const initialId = await TargetWeightPanel._resolveCursorTemplateId(options.cursor);
        if (TargetWeightPanel.currentPanel) {
            TargetWeightPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            if (initialId) TargetWeightPanel.currentPanel._queueInitialId(initialId);
            return;
        }
        TargetWeightPanel.currentPanel = new TargetWeightPanel(extensionPath, vscode.ViewColumn.Beside, options);
        if (initialId) TargetWeightPanel.currentPanel._queueInitialId(initialId);
    }

    /** 光标行 → 所属顶层块的组件模板 id（编辑器右键菜单入口）。 */
    private static async _resolveCursorTemplateId(
        cursor: TargetWeightOpenOptions['cursor'],
    ): Promise<string | undefined> {
        if (!cursor) return undefined;
        try {
            return findComponentTemplateIdAtLine(cursor.document.getText(), cursor.line);
        } catch (error) {
            ErrorReporter.debug('TargetWeightPanel', 'Failed to resolve the template at the cursor', error);
            return undefined;
        }
    }

    private constructor(
        extensionPath: string,
        column: vscode.ViewColumn,
        options: TargetWeightOpenOptions,
    ) {
        this._extensionPath = extensionPath;
        this._indexService = options.indexService;
        const webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(webviewRootPath)];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(folder.uri);
        }

        this._panel = vscode.window.createWebviewPanel(
            TargetWeightPanel.viewType,
            panelText('Targeting Weight Analysis', '索敌权重分析'),
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots,
            },
        );

        this._panel.webview.html = this._getHtml(webviewRootPath);
        this._panel.iconPath = vscode.Uri.file(path.join(extensionPath, 'images', 'icon.png'));
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async (message: unknown) => {
                if (!isUnknownRecord(message)) return;
                if (typeof message.command !== 'string') return;
                try {
                    switch (message.command) {
                        case 'ready':
                            await this._loadAndSendCatalogue();
                            break;
                        case 'selectWeapon':
                            await this._sendWeapon(String(message.id ?? ''));
                            break;
                        case 'compute':
                            await this._compute(message);
                            break;
                        case 'revealWeapon':
                            await this._revealWeapon(String(message.id ?? ''));
                            break;
                    }
                } catch (error) {
                    ErrorReporter.debug('TargetWeightPanel', `Failed to handle ${message.command}`, error);
                    this._post({
                        command: 'error',
                        message: panelText(
                            `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
                            `分析失败：${error instanceof Error ? error.message : String(error)}`,
                        ),
                    });
                }
            }, null, this._disposables),
        );
    }

    public dispose() {
        TargetWeightPanel.currentPanel = undefined;
        this._weapons = [];
        this._scannedFiles = new Set();
        this._locRefCache.clear();
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _post(message: Record<string, unknown>): void {
        void this._panel.webview.postMessage(message);
    }

    private _queueInitialId(id: string): void {
        this._pendingInitialId = id;
        if (this._loaded) void this._applyInitialWeapon();
    }

    // ── Scanning ────────────────────────────────────────────────────────────────

    private _getScanRoots(): ScanRoot[] {
        const roots: ScanRoot[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            roots.push({ uri: folder.uri, source: 'workspace' });
        }
        for (const gameRoot of getConfiguredGameRoots()) {
            roots.push({ uri: vscode.Uri.file(gameRoot.root), source: 'vanilla' });
        }
        const seen = new Set<string>();
        return roots.filter(root => {
            const key = process.platform === 'win32' ? root.uri.fsPath.toLowerCase() : root.uri.fsPath;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private async _scanAll(): Promise<TargetWeightScanResult> {
        const stats: Record<'workspace' | 'vanilla', ScanStats> = {
            workspace: { files: 0, templates: 0 },
            vanilla: { files: 0, templates: 0 },
        };
        const weaponGroups: WeaponTargetingSourceGroup[] = [];
        const sizeGroups: ShipSizeDetailGroup[] = [];
        const csvGroups: CsvStatsSourceGroup[] = [];
        const inlineGroups: InlineScriptSourceGroup[] = [];
        const variableGroups: Array<{ source: 'workspace' | 'vanilla'; vars: Map<string, number> }> = [];

        const roots = this._getScanRoots();
        const readFiles = async (root: ScanRoot, glob: string): Promise<vscode.Uri[]> => {
            const pattern = new vscode.RelativePattern(root.uri, glob);
            const files = await vscode.workspace.findFiles(
                pattern,
                TARGET_WEIGHT_EXCLUDE_GLOB,
                TARGET_WEIGHT_FILE_LIMIT_PER_ROOT,
            );
            return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        };
        const readText = async (fileUri: vscode.Uri): Promise<string> => {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            return new TextDecoder('utf-8').decode(bytes);
        };

        // 先合并全部根的脚本变量：工作区的 ship_size 可能引用 vanilla 定义的 @变量。
        for (const root of roots) {
            try {
                for (const fileUri of await readFiles(root, SCRIPTED_VARIABLES_GLOB)) {
                    try {
                        variableGroups.push({ source: root.source, vars: parseScriptedVariables(await readText(fileUri)) });
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to scan ${root.uri.fsPath}`, error);
            }
        }
        const scriptedVars = mergeScriptedVariables(variableGroups);

        // inline script 注册表与脚本变量同为先置：组件块的 key/数值可能全部由
        // inline 参数承载（KEY/ACCURACY/MULT…），展开需要完整的注册表与变量表。
        for (const root of roots) {
            try {
                const inlineRoot = path.join(root.uri.fsPath, 'common', 'inline_scripts');
                for (const fileUri of await readFiles(root, INLINE_SCRIPT_GLOB)) {
                    try {
                        const template = parseInlineScriptTemplate(await readText(fileUri));
                        if (template.bindings.size > 0 || template.nested.length > 0) {
                            inlineGroups.push({
                                source: root.source,
                                file: normalizeInlineScriptKey(path.relative(inlineRoot, fileUri.fsPath)),
                                template,
                            });
                        }
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to scan ${root.uri.fsPath}`, error);
            }
        }
        const inlineRegistry = buildInlineScriptRegistry(inlineGroups);

        for (const root of roots) {
            try {
                for (const fileUri of await readFiles(root, TARGET_WEIGHT_FILE_GLOB)) {
                    this._scannedFiles.add(scannedPathKey(fileUri.fsPath));
                    stats[root.source].files++;
                    try {
                        const entries = extractTargetingFields(await readText(fileUri));
                        for (const entry of entries) expandInlineScriptFields(entry, inlineRegistry, scriptedVars);
                        // inline 展开后仍取不到 id、或展开后仍不含任何索敌字段的块
                        // （inline 写的护盾/装甲等 utility 组件）不进下表。
                        const kept = entries.filter(entry => entry.componentId !== '' && isTargetingRelevant(entry));
                        if (kept.length > 0) {
                            stats[root.source].templates += kept.length;
                            weaponGroups.push({ source: root.source, file: fileUri.fsPath, entries: kept });
                        }
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
                for (const fileUri of await readFiles(root, COMPONENT_CSV_GLOB)) {
                    try {
                        const csvStats = parseWeaponComponentsCsv(await readText(fileUri));
                        if (csvStats.size > 0) csvGroups.push({ source: root.source, file: fileUri.fsPath, stats: csvStats });
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
                for (const fileUri of await readFiles(root, SHIP_SIZE_FILE_GLOB)) {
                    try {
                        const entries = extractShipSizeDetails(await readText(fileUri), scriptedVars);
                        if (entries.length > 0) sizeGroups.push({ source: root.source, file: fileUri.fsPath, entries });
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to scan ${root.uri.fsPath}`, error);
            }
        }

        const weapons = mergeWeaponTargetingEntries(weaponGroups);
        // CSV 只补 txt 没有的字段（txt 显式值优先），补进来的字段记入 csvKeys。
        const csvStats = mergeCsvStatMaps(csvGroups);
        for (const entry of weapons) applyCsvWeaponStats(entry, csvStats);

        return {
            weapons,
            shipSizes: mergeShipSizeDetails(sizeGroups),
            stats,
        };
    }

    /** 语言优先级：显式配置优先；未配置时跟随 VS Code 界面语言（与 locDecorations 的 hover 一致）。 */
    private _preferredLocTags(): string[] {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const inspected = config.inspect<string[]>('localisation.languages');
        const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
        const languages = configured && configured.length > 0
            ? configured
            : getDefaultLocalisationLanguagesForUiLocale(vscode.env.language);
        return getPreferredLocalisationLanguageTags(languages);
    }

    /**
     * id → 本地化显示名。组件名的 loc 键就是组件 key；ship_size 的 loc 键是大写 id，
     * 所以每个 id 都试「原样 + 全大写」两个键。IndexService 只索引工作区本地化，
     * 查不到的再对游戏根的语言目录做定向扫描（_resolveVanillaDisplayNames）。
     */
    private async _resolveDisplayNames(ids: string[]): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        if (ids.length === 0) return names;
        const tags = this._preferredLocTags();
        const indexService = this._indexService;
        const missing: string[] = [];
        for (const id of ids) {
            let value: string | undefined;
            if (indexService) {
                for (const key of [id, id.toUpperCase()]) {
                    try {
                        const entries = await indexService.queryLocalisationAsync({ key, limit: 64 });
                        const entry = pickPreferredLocalisationEntry(entries, tags);
                        if (entry) {
                            value = entry.value;
                            break;
                        }
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to resolve localisation for ${id}`, error);
                        break;
                    }
                }
            }
            if (value === undefined) missing.push(id);
            else names.set(id, value);
        }
        if (missing.length > 0) {
            const vanillaNames = await this._resolveVanillaDisplayNames(missing, tags);
            for (const [id, value] of vanillaNames) names.set(id, value);
        }
        await this._expandLocReferences(names, tags);
        return names;
    }

    /**
     * 解析值里的 `$other_key$` 引用（vanilla 的船型名多为引用链，如
     * `military_arkship_tier_1: "$military_arkship_name$ I"`）。
     * 分轮收集引用键 → 批量查 IndexService，查不到再惰性构建 vanilla 全量键值表；
     * 轮数与每轮键数都有限额，替换本身由纯函数 resolveLocalisationReferences 完成。
     * 解析不出的引用保留原样，webview 侧的 $ 护栏会回退到裸 id。
     */
    private async _expandLocReferences(names: Map<string, string>, tags: string[]): Promise<void> {
        const hasRefs = [...names.values()].some(value => collectLocalisationReferences(value).length > 0);
        if (!hasRefs) return;
        const resolved = new Map<string, string>();
        const MAX_ROUNDS = 4;
        const MAX_KEYS_PER_ROUND = 48;
        for (let round = 0; round < MAX_ROUNDS; round++) {
            const pending = new Set<string>();
            for (const value of names.values()) {
                for (const ref of collectLocalisationReferences(value)) {
                    if (!resolved.has(ref)) pending.add(ref);
                }
            }
            if (pending.size === 0) return;
            for (const key of [...pending].slice(0, MAX_KEYS_PER_ROUND)) {
                try {
                    const value = await this._lookupLocRefKey(key, tags);
                    if (value !== undefined) resolved.set(key, value);
                } catch (error) {
                    ErrorReporter.debug('TargetWeightPanel', `Failed to resolve loc reference ${key}`, error);
                }
            }
            for (const [id, value] of names) {
                names.set(id, resolveLocalisationReferences(value, key => resolved.get(key), 1));
            }
        }
    }

    /** 单个引用键的取值：先工作区索引（IndexService），再 vanilla 全量键值表（惰性构建）。 */
    private async _lookupLocRefKey(key: string, tags: string[]): Promise<string | undefined> {
        const indexService = this._indexService;
        if (indexService) {
            try {
                const entries = await indexService.queryLocalisationAsync({ key, limit: 16 });
                const entry = pickPreferredLocalisationEntry(entries, tags);
                if (entry) return entry.value;
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to query loc key ${key}`, error);
            }
        }
        for (const tag of tags) {
            for (const root of getConfiguredGameRoots()) {
                const map = await this._vanillaLocReferenceMap(root.root, tag);
                const value = map.get(key);
                if (value !== undefined) return value;
            }
        }
        return undefined;
    }

    /**
     * vanilla 某「根+语言」的全量本地化键值表：只在遇到 `$ref$` 引用时构建一次并缓存，
     * 条目数有上限（VANILLA_LOC_REF_ENTRY_LIMIT），面板 dispose 时清空。
     */
    private async _vanillaLocReferenceMap(root: string, tag: string): Promise<Map<string, string>> {
        const cacheKey = `${root}|${tag}`;
        const cached = this._locRefCache.get(cacheKey);
        if (cached) return cached;
        const map = new Map<string, string>();
        const directory = tag.replace(/^l_/, '');
        if (directory) {
            const locRoot = vscode.Uri.file(path.join(root, 'localisation', directory));
            let files: vscode.Uri[] = [];
            try {
                files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(locRoot, '*.yml'),
                    undefined,
                    VANILLA_LOC_FILE_LIMIT_PER_LANGUAGE,
                );
                files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            } catch {
                files = [];
            }
            for (const file of files) {
                if (map.size >= VANILLA_LOC_REF_ENTRY_LIMIT) break;
                try {
                    const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
                    for (const entry of parseLocFile(text, file.fsPath)) {
                        if (!map.has(entry.key)) map.set(entry.key, entry.value);
                        if (map.size >= VANILLA_LOC_REF_ENTRY_LIMIT) break;
                    }
                } catch (error) {
                    ErrorReporter.debug('TargetWeightPanel', `Failed to parse ${file.fsPath}`, error);
                }
            }
        }
        this._locRefCache.set(cacheKey, map);
        return map;
    }

    /**
     * vanilla 本地化的定向扫描：按语言偏好顺序读 <游戏根>/localisation/<语言目录>/*.yml，
     * 只收集仍缺失的键（原样 + 大写），找齐或扫完即止；每语言文件数有上限。
     */
    private async _resolveVanillaDisplayNames(ids: string[], tags: string[]): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        const roots = getConfiguredGameRoots();
        if (roots.length === 0 || ids.length === 0 || tags.length === 0) return names;
        const keyToId = new Map<string, string>();
        for (const id of ids) {
            keyToId.set(id, id);
            keyToId.set(id.toUpperCase(), id);
        }
        const remaining = new Set(ids);
        for (const tag of tags) {
            if (remaining.size === 0) break;
            const directory = tag.replace(/^l_/, '');
            if (!directory) continue;
            for (const root of roots) {
                if (remaining.size === 0) break;
                const locRoot = vscode.Uri.file(path.join(root.root, 'localisation', directory));
                let files: vscode.Uri[];
                try {
                    files = await vscode.workspace.findFiles(
                        new vscode.RelativePattern(locRoot, '*.yml'),
                        undefined,
                        VANILLA_LOC_FILE_LIMIT_PER_LANGUAGE,
                    );
                } catch {
                    continue;
                }
                files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
                for (const file of files) {
                    if (remaining.size === 0) break;
                    let text: string;
                    try {
                        text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
                    } catch {
                        continue;
                    }
                    try {
                        for (const entry of parseLocFile(text, file.fsPath)) {
                            const id = keyToId.get(entry.key);
                            if (id === undefined || !remaining.has(id)) continue;
                            names.set(id, entry.value);
                            remaining.delete(id);
                        }
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to parse ${file.fsPath}`, error);
                    }
                }
            }
        }
        return names;
    }

    private async _loadAndSendCatalogue(): Promise<void> {
        if (!this._loaded) {
            this._post({
                command: 'loading',
                text: panelText(
                    'Scanning common/component_templates and common/ship_sizes...',
                    '扫描 common/component_templates 与 common/ship_sizes...',
                ),
            });
            this._scan = await this._scanAll();
            this._weapons = this._scan.weapons;
            this._loaded = true;
        }
        const displayNames = await this._resolveDisplayNames(this._weapons.map(entry => entry.componentId));
        const options: TargetWeightWeaponOption[] = this._weapons.map(entry => ({
            id: entry.componentId,
            displayLabel: formatComponentDisplayLabel(entry.componentId, displayNames.get(entry.componentId)),
            templateTypeKey: entry.templateTypeKey,
            type: entry.componentType,
            source: entry.source,
            useShipMainTarget: entry.useShipMainTarget === true,
            targetWeightKeys: Object.keys(entry.targetWeights).sort((a, b) => a.localeCompare(b)),
            missingKeys: [...entry.missingKeys],
            dynamicKeys: [...entry.dynamicKeys],
            csvKeys: [...entry.csvKeys],
        }));
        const shipSizeNames = await this._resolveDisplayNames(this._scan.shipSizes.map(detail => detail.id));
        const shipSizeOptions: ShipSizeOption[] = this._scan.shipSizes.map(detail => ({
            id: detail.id,
            label: formatComponentDisplayLabel(detail.id, shipSizeNames.get(detail.id)),
            sizeMultiplier: detail.sizeMultiplier,
            evasion: detail.evasionPercent === undefined ? undefined : detail.evasionPercent / 100,
            maxHitpoints: detail.maxHitpoints,
        }));
        this._post({
            command: 'init',
            locale: panelLocale(),
            weapons: options,
            shipSizes: this._scan.shipSizes.map(detail => detail.id),
            shipSizeOptions,
            weaponDefaults: { ...TARGETING_FIELD_FALLBACKS },
            scannedFileCount: this._scannedFiles.size,
            stats: this._scan.stats,
        });
        await this._applyInitialWeapon();
    }

    /** 初始选中：右键菜单带入的 id 优先，否则退回第一条。 */
    private async _applyInitialWeapon(): Promise<void> {
        const pending = this._pendingInitialId;
        this._pendingInitialId = undefined;
        if (pending) {
            if (this._findWeapon(pending)) {
                await this._sendWeapon(pending);
                return;
            }
            this._post({
                command: 'error',
                message: panelText(
                    `No weapon template "${pending}" was found in the scanned roots; the first template is preselected instead.`,
                    `在已扫描的根目录里找不到武器模板「${pending}」，已改为预选第一条。`,
                ),
            });
        }
        const first = this._weapons[0];
        if (first) await this._sendWeapon(first.componentId);
    }

    // ── Weapon payloads ─────────────────────────────────────────────────────────

    private _findWeapon(id: string): WeaponTargetingEntry | undefined {
        if (!id) return undefined;
        return this._weapons.find(entry => entry.componentId === id);
    }

    /** 无模板时的缺省武器输入（字段缺失按缺省估算，由 webview 标注）。 */
    private static _defaultWeaponInput(): Record<string, unknown> {
        return {
            minDamage: TARGETING_FIELD_FALLBACKS.min_damage,
            maxDamage: TARGETING_FIELD_FALLBACKS.max_damage,
            accuracy: TARGETING_FIELD_FALLBACKS.accuracy,
            tracking: TARGETING_FIELD_FALLBACKS.tracking,
            shieldDamage: TARGETING_FIELD_FALLBACKS.shield_damage,
            armorDamage: TARGETING_FIELD_FALLBACKS.armor_damage,
            hullDamage: TARGETING_FIELD_FALLBACKS.hull_damage,
            shieldPenetration: TARGETING_FIELD_FALLBACKS.shield_penetration,
            armorPenetration: TARGETING_FIELD_FALLBACKS.armor_penetration,
            sizeDamageFactor: TARGETING_FIELD_FALLBACKS.size_damage_factor,
            targetWeights: {} as Record<string, number>,
        };
    }

    private _toWeaponInput(entry: WeaponTargetingEntry | undefined): Record<string, unknown> {
        if (!entry) return TargetWeightPanel._defaultWeaponInput();
        return {
            minDamage: entry.minDamage ?? TARGETING_FIELD_FALLBACKS.min_damage,
            maxDamage: entry.maxDamage ?? TARGETING_FIELD_FALLBACKS.max_damage,
            accuracy: entry.accuracy ?? TARGETING_FIELD_FALLBACKS.accuracy,
            tracking: entry.tracking ?? TARGETING_FIELD_FALLBACKS.tracking,
            shieldDamage: entry.shieldDamage ?? TARGETING_FIELD_FALLBACKS.shield_damage,
            armorDamage: entry.armorDamage ?? TARGETING_FIELD_FALLBACKS.armor_damage,
            hullDamage: entry.hullDamage ?? TARGETING_FIELD_FALLBACKS.hull_damage,
            shieldPenetration: entry.shieldPenetration ?? TARGETING_FIELD_FALLBACKS.shield_penetration,
            armorPenetration: entry.armorPenetration ?? TARGETING_FIELD_FALLBACKS.armor_penetration,
            sizeDamageFactor: entry.sizeDamageFactor ?? TARGETING_FIELD_FALLBACKS.size_damage_factor,
            targetWeights: { ...entry.targetWeights },
        };
    }

    private async _sendWeapon(id: string): Promise<void> {
        const entry = this._findWeapon(id);
        if (!entry) {
            this._post({
                command: 'error',
                message: panelText('Weapon template not found in the scanned roots.', '在已扫描的根目录中找不到该武器模板。'),
            });
            return;
        }
        const displayNames = await this._resolveDisplayNames([entry.componentId]);
        this._post({
            command: 'weapon',
            weapon: {
                id: entry.componentId,
                displayLabel: formatComponentDisplayLabel(entry.componentId, displayNames.get(entry.componentId)),
                templateTypeKey: entry.templateTypeKey,
                type: entry.componentType,
                source: entry.source,
                useShipMainTarget: entry.useShipMainTarget === true,
                input: this._toWeaponInput(entry),
                targetableShipSizes: [...entry.targetableShipSizes],
                targetWeightKeys: Object.keys(entry.targetWeights).sort((a, b) => a.localeCompare(b)),
                missingKeys: [...entry.missingKeys],
                dynamicKeys: [...entry.dynamicKeys],
                csvKeys: [...entry.csvKeys],
            },
        });
    }

    // ── Compute ─────────────────────────────────────────────────────────────────

    private async _compute(message: Record<string, unknown>): Promise<void> {
        const weaponId = typeof message.weaponId === 'string' ? message.weaponId : '';
        const entry = this._findWeapon(weaponId);
        const rawWeapon = isUnknownRecord(message.weapon) ? message.weapon : undefined;
        const useShipMainTarget = typeof rawWeapon?.useShipMainTarget === 'boolean'
            ? rawWeapon.useShipMainTarget
            : entry?.useShipMainTarget === true;
        // webview 的消息与任何外部输入一样不可信：先按 TargetingChainInput 收窄再计算。
        const input: TargetingChainInput = parseTargetingChainInput({
            attacker: message.attacker,
            weapon: mergeComputeWeaponInput(this._toWeaponInput(entry), rawWeapon),
            target: message.target,
            rho: message.rho,
            targetWeightMultModifier: message.targetWeightMultModifier,
            randomRoll: message.randomRoll,
            useRandom: message.useRandom,
            fleetHasHittable: message.fleetHasHittable,
            targetFocus: message.targetFocus,
        });
        const result = computeTargetingChain(input);
        this._post({
            command: 'result',
            weaponId: entry?.componentId ?? '',
            usesShipMainTarget: useShipMainTarget,
            result,
        });
    }

    // ── Source navigation ───────────────────────────────────────────────────────

    private async _revealWeapon(id: string): Promise<void> {
        const entry = this._findWeapon(id);
        if (!entry) {
            this._post({
                command: 'error',
                message: panelText('Weapon template not found in the scanned roots.', '在已扫描的根目录中找不到该武器模板。'),
            });
            return;
        }
        // 只允许回跳本次扫描真正读过的文件，避免 webview 给出任意路径。
        if (!this._scannedFiles.has(scannedPathKey(entry.file))) {
            this._post({
                command: 'error',
                message: panelText(
                    'Refused to open a file outside the scanned roots.',
                    '拒绝打开扫描范围之外的文件。',
                ),
            });
            return;
        }
        try {
            const uri = vscode.Uri.file(entry.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const position = new vscode.Position(Math.max(0, entry.line - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            ErrorReporter.debug('TargetWeightPanel', `Failed to open ${entry.file}`, error);
            this._post({
                command: 'error',
                message: panelText(
                    `Failed to open ${path.basename(entry.file)}: ${error instanceof Error ? error.message : String(error)}`,
                    `无法打开 ${path.basename(entry.file)}：${error instanceof Error ? error.message : String(error)}`,
                ),
            });
        }
    }

    // ── HTML ────────────────────────────────────────────────────────────────────

    private _getHtml(webviewRootPath: string): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'targetWeightPreview.css')),
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'targetWeightPreview.js')),
        );
        const nonce = getNonce();
        const csp = this._panel.webview.cspSource;
        const lang = panelLocale() === 'zh-cn' ? 'zh-CN' : 'en';
        const title = panelText('Targeting Weight Analysis', '索敌权重分析');

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; script-src 'nonce-${nonce}'; style-src ${csp} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>${title}</title>
</head>
<body>
    <div id="toolbar">
        <span class="title">${title}</span>
        <div class="controls">
            <input id="preset-combo" type="text" autocomplete="off" spellcheck="false"
                placeholder="${panelText('Ship size (type to filter)', '目标船型（输入筛选）')}"
                aria-label="${panelText('Target ship size', '目标船型')}"
                title="${panelText('Pick a ship size to prefill σ / ε / hull (from vanilla and workspace definitions)', '选择船型以预填 σ/ε/船体上限（取自原版与工作区定义）')}" />
            <span class="separator">|</span>
            <input id="weapon-search" type="text" autocomplete="off" spellcheck="false"
                placeholder="${panelText('Weapon template id (filterable)', '武器模板 id（可输入筛选）')}"
                aria-label="${panelText('Weapon template', '武器模板')}"
                title="${panelText('Type to filter; leave empty to use manual parameters only', '输入即筛选；留空表示只用手动参数')}" />
            <button id="btn-reveal" title="${panelText('Open the weapon template at its block', '跳转到武器模板定义行')}"
                aria-label="${panelText('Open source file', '打开源文件')}">↗</button>
            <button id="btn-compute" title="${panelText('Recompute the chain', '重新计算乘法链')}">
                ${panelText('Analyze', '分析')}
            </button>
        </div>
    </div>

    <div id="status" class="status" aria-live="polite"></div>

    <main id="main">
        <section id="form-panel" aria-label="${panelText('Candidate target parameters', '候选目标参数')}">
            <h2 class="section-title">${panelText('Candidate target', '候选目标')}</h2>
            <div id="form-body" class="form-grid"></div>

            <h2 class="section-title">${panelText('Attacker ship', '攻击方舰船')}</h2>
            <div id="attacker-body" class="form-grid"></div>

            <h2 class="section-title">${panelText('Weapon parameters', '武器参数')}</h2>
            <div id="weapon-body" class="form-grid"></div>
            <div id="weapon-facts" class="facts"></div>

            <h2 class="section-title">${panelText('Weight inputs', '权重输入')}</h2>
            <div id="options-body" class="form-grid"></div>
        </section>

        <section id="result-panel" aria-label="${panelText('Weight chain result', '权重链结果')}">
            <div id="ship-chain"></div>
            <div id="weapon-chain"></div>
            <div id="notes"></div>
        </section>
    </main>

    <div id="loading">${panelText('Scanning common/component_templates...', '扫描 common/component_templates...')}</div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
