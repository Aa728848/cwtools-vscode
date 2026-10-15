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
import { getPreferredLocalisationLanguageTags, pickPreferredLocalisationEntry } from './localisationLanguagePreference';
import {
    computeTargetingChain,
    parseTargetingChainInput,
    type TargetingChainInput,
} from './ai/targetingWeights';
import {
    TARGETING_FIELD_FALLBACKS,
    extractShipSizeIds,
    extractTargetingFields,
    findComponentTemplateIdAtLine,
    formatComponentDisplayLabel,
    mergeComputeWeaponInput,
    mergeShipSizeIds,
    mergeWeaponTargetingEntries,
    type WeaponTargetingEntry,
    type WeaponTargetingSourceGroup,
    type ShipSizeSourceGroup,
} from './ai/targetWeightExtract';

/** 与 techTreePanel 的 TECH_FILE_LIMIT_PER_ROOT 同量级的文件数上限，避免超大 mod 拖死扫描。 */
const TARGET_WEIGHT_FILE_LIMIT_PER_ROOT = 2000;
const TARGET_WEIGHT_FILE_GLOB = '**/common/component_templates/*.txt';
const SHIP_SIZE_FILE_GLOB = '**/common/ship_sizes/*.txt';
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
}

/** webview 下拉里的一行数据（不含宿主绝对路径以外的可写字段）。 */
export interface TargetWeightPreset {
    id: string;
    sizeMultiplier: number;
    evasion: number;
    distance: number;
    hull: number;
    maxHull: number;
    shield: number;
    armor: number;
    armed: boolean;
    isStarbase: boolean;
    shipSizeId: string;
}

/**
 * 两组预置目标。corvette 取自 docs/stellaris-targeting-weight-4.5.2.md §6 的护卫舰算例
 * （σ=5 / ε=0.6 / d=72 / 240 船体 + 225 盾 + 225 甲）；battleship 用同级巨舰量级做对照。
 */
const TARGET_PRESETS: TargetWeightPreset[] = [
    {
        id: 'corvette',
        sizeMultiplier: 5,
        evasion: 0.6,
        distance: 72,
        hull: 240,
        maxHull: 300,
        shield: 225,
        armor: 225,
        armed: true,
        isStarbase: false,
        shipSizeId: 'corvette',
    },
    {
        id: 'battleship',
        sizeMultiplier: 10,
        evasion: 0.2,
        distance: 150,
        hull: 2400,
        maxHull: 3000,
        shield: 1500,
        armor: 900,
        armed: true,
        isStarbase: false,
        shipSizeId: 'battleship',
    },
];

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
    shipSizes: string[];
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
        const sizeGroups: ShipSizeSourceGroup[] = [];

        for (const root of this._getScanRoots()) {
            const readFiles = async (glob: string): Promise<vscode.Uri[]> => {
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

            try {
                for (const fileUri of await readFiles(TARGET_WEIGHT_FILE_GLOB)) {
                    this._scannedFiles.add(scannedPathKey(fileUri.fsPath));
                    stats[root.source].files++;
                    try {
                        const entries = extractTargetingFields(await readText(fileUri));
                        if (entries.length > 0) {
                            stats[root.source].templates += entries.length;
                            weaponGroups.push({ source: root.source, file: fileUri.fsPath, entries });
                        }
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
                for (const fileUri of await readFiles(SHIP_SIZE_FILE_GLOB)) {
                    try {
                        const ids = extractShipSizeIds(await readText(fileUri));
                        if (ids.length > 0) sizeGroups.push({ source: root.source, file: fileUri.fsPath, ids });
                    } catch (error) {
                        ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                    }
                }
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to scan ${root.uri.fsPath}`, error);
            }
        }

        return {
            weapons: mergeWeaponTargetingEntries(weaponGroups),
            shipSizes: mergeShipSizeIds(sizeGroups),
            stats,
        };
    }

    /** 用户配置的语言优先级（与 locDecorations 的 hover 一致）。 */
    private _preferredLocTags(): string[] {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        return getPreferredLocalisationLanguageTags(config.get<string[]>('localisation.languages', ['English']));
    }

    /**
     * 组件 id → 本地化显示名。组件名的 loc 键就是组件 key；
     * 索引里查不到（或只剩标记）时返回 undefined，由 formatComponentDisplayLabel 回退 id。
     */
    private async _resolveDisplayNames(ids: string[]): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        const indexService = this._indexService;
        if (!indexService || ids.length === 0) return names;
        const tags = this._preferredLocTags();
        for (const id of ids) {
            try {
                const entries = await indexService.queryLocalisationAsync({ key: id, limit: 64 });
                const entry = pickPreferredLocalisationEntry(entries, tags);
                if (entry) names.set(id, entry.value);
            } catch (error) {
                ErrorReporter.debug('TargetWeightPanel', `Failed to resolve localisation for ${id}`, error);
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
        }));
        this._post({
            command: 'init',
            locale: panelLocale(),
            weapons: options,
            shipSizes: this._scan.shipSizes,
            weaponDefaults: { ...TARGETING_FIELD_FALLBACKS },
            presets: TARGET_PRESETS.map(preset => ({
                ...preset,
                label: preset.id === 'corvette'
                    ? panelText('Corvette (σ=5 / ε=0.6)', '护卫舰（σ=5 / ε=0.6）')
                    : panelText('Battleship class', '战列舰级'),
            })),
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
            <select id="preset-select" aria-label="${panelText('Target preset', '目标预设')}"
                title="${panelText('Preset candidate target parameters', '预置候选目标参数')}"></select>
            <span class="separator">|</span>
            <input id="weapon-search" type="text" list="weapon-options" autocomplete="off" spellcheck="false"
                placeholder="${panelText('Weapon template id (filterable)', '武器模板 id（可输入筛选）')}"
                aria-label="${panelText('Weapon template', '武器模板')}"
                title="${panelText('Type to filter; leave empty to use manual parameters only', '输入即筛选；留空表示只用手动参数')}" />
            <datalist id="weapon-options"></datalist>
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
