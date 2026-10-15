/**
 * Target Weight Panel — Webview host for the Stellaris targeting-weight analyzer.
 *
 * 数据流（与 techTreePanel 同构）：
 * 1. 在工作区与「已配置游戏根」下枚举 common/component_templates/*.txt
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
import {
    computeTargetingChain,
    parseTargetingChainInput,
    type TargetingChainInput,
} from './ai/targetingWeights';
import {
    TARGETING_FIELD_FALLBACKS,
    extractTargetingFields,
    mergeWeaponTargetingEntries,
    type WeaponTargetingEntry,
    type WeaponTargetingSourceGroup,
} from './ai/targetWeightExtract';

/** 与 techTreePanel 的 TECH_FILE_LIMIT_PER_ROOT 同量级的文件数上限，避免超大 mod 拖死扫描。 */
const TARGET_WEIGHT_FILE_LIMIT_PER_ROOT = 2000;
const TARGET_WEIGHT_FILE_GLOB = '**/common/component_templates/*.txt';
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

interface TargetWeightWeaponOption {
    id: string;
    templateTypeKey: string;
    type?: string;
    source: 'workspace' | 'vanilla';
    file: string;
    line: number;
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

interface ScanRoot {
    uri: vscode.Uri;
    source: 'workspace' | 'vanilla';
}

export class TargetWeightPanel {
    public static currentPanel: TargetWeightPanel | undefined;
    private static readonly viewType = 'cwtools-target-weights';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _weapons: WeaponTargetingEntry[] = [];
    private _scannedFiles = new Set<string>();
    private _loaded = false;

    public static create(extensionPath: string) {
        if (TargetWeightPanel.currentPanel) {
            TargetWeightPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        TargetWeightPanel.currentPanel = new TargetWeightPanel(extensionPath, vscode.ViewColumn.Beside);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn) {
        this._extensionPath = extensionPath;
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

    private async _scanWeapons(): Promise<WeaponTargetingEntry[]> {
        const groups: WeaponTargetingSourceGroup[] = [];
        for (const root of this._getScanRoots()) {
            const pattern = new vscode.RelativePattern(root.uri, TARGET_WEIGHT_FILE_GLOB);
            const files = (await vscode.workspace.findFiles(
                pattern,
                TARGET_WEIGHT_EXCLUDE_GLOB,
                TARGET_WEIGHT_FILE_LIMIT_PER_ROOT,
            )).sort((a, b) => a.fsPath.localeCompare(b.fsPath));

            for (const fileUri of files) {
                this._scannedFiles.add(fileUri.fsPath);
                try {
                    const bytes = await vscode.workspace.fs.readFile(fileUri);
                    const text = new TextDecoder('utf-8').decode(bytes);
                    const entries = extractTargetingFields(text);
                    if (entries.length > 0) {
                        groups.push({ source: root.source, file: fileUri.fsPath, entries });
                    }
                } catch (error) {
                    ErrorReporter.debug('TargetWeightPanel', `Failed to read ${fileUri.fsPath}`, error);
                }
            }
        }
        return mergeWeaponTargetingEntries(groups);
    }

    private async _loadAndSendCatalogue(): Promise<void> {
        if (!this._loaded) {
            this._post({
                command: 'loading',
                text: panelText('Scanning common/component_templates...', '扫描 common/component_templates...'),
            });
            this._weapons = await this._scanWeapons();
            this._loaded = true;
        }
        const options: TargetWeightWeaponOption[] = this._weapons.map(entry => ({
            id: entry.componentId,
            templateTypeKey: entry.templateTypeKey,
            type: entry.componentType,
            source: entry.source,
            file: entry.file,
            line: entry.line,
            useShipMainTarget: entry.useShipMainTarget === true,
            targetWeightKeys: Object.keys(entry.targetWeights).sort((a, b) => a.localeCompare(b)),
            missingKeys: [...entry.missingKeys],
            dynamicKeys: [...entry.dynamicKeys],
        }));
        this._post({
            command: 'init',
            locale: panelLocale(),
            weapons: options,
            presets: TARGET_PRESETS.map(preset => ({
                ...preset,
                label: preset.id === 'corvette'
                    ? panelText('Corvette (σ=5 / ε=0.6)', '护卫舰（σ=5 / ε=0.6）')
                    : panelText('Battleship class', '战列舰级'),
            })),
            scannedFileCount: this._scannedFiles.size,
        });
        const first = options[0];
        if (first) {
            await this._sendWeapon(first.id);
        }
    }

    // ── Weapon payloads ─────────────────────────────────────────────────────────

    private _findWeapon(id: string): WeaponTargetingEntry | undefined {
        return this._weapons.find(entry => entry.componentId === id);
    }

    private _toWeaponInput(entry: WeaponTargetingEntry) {
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
        this._post({
            command: 'weapon',
            weapon: {
                id: entry.componentId,
                templateTypeKey: entry.templateTypeKey,
                type: entry.componentType,
                source: entry.source,
                useShipMainTarget: entry.useShipMainTarget === true,
                input: this._toWeaponInput(entry),
                targetWeights: { ...entry.targetWeights },
                targetableShipSizes: [...entry.targetableShipSizes],
                missingKeys: [...entry.missingKeys],
                dynamicKeys: [...entry.dynamicKeys],
            },
        });
    }

    // ── Compute ─────────────────────────────────────────────────────────────────

    private async _compute(message: Record<string, unknown>): Promise<void> {
        const weaponId = typeof message.weaponId === 'string' ? message.weaponId : '';
        const entry = this._findWeapon(weaponId);
        if (!entry) {
            this._post({
                command: 'error',
                message: panelText('Select a weapon template first.', '请先选择一个武器模板。'),
            });
            return;
        }
        // webview 的消息与任何外部输入一样不可信：先按 TargetingChainInput 收窄再计算。
        const input: TargetingChainInput = parseTargetingChainInput({
            attacker: message.attacker,
            weapon: this._toWeaponInput(entry),
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
            weaponId: entry.componentId,
            usesShipMainTarget: entry.useShipMainTarget === true,
            result,
        });
    }

    // ── Source navigation ───────────────────────────────────────────────────────

    private async _revealWeapon(id: string): Promise<void> {
        const entry = this._findWeapon(id);
        // 只允许回跳本次扫描真正读过的文件，避免 webview 给出任意路径。
        if (!entry || !this._scannedFiles.has(entry.file)) return;
        try {
            const uri = vscode.Uri.file(entry.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const position = new vscode.Position(Math.max(0, entry.line - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            ErrorReporter.debug('TargetWeightPanel', `Failed to open ${entry.file}`, error);
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
            <select id="weapon-select" aria-label="${panelText('Weapon template', '武器模板')}"
                title="${panelText('Weapon component template', '武器组件模板')}"></select>
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

            <h2 class="section-title">${panelText('Weight inputs', '权重输入')}</h2>
            <div id="options-body" class="form-grid"></div>

            <div id="weapon-facts" class="facts"></div>
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
