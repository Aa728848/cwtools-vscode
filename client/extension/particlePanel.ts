import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeDds, decodeTga } from './ddsDecoder';
import { ErrorReporter } from './ai/errorReporter';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import { isPathInsideOrEqual } from './pathScope';
import { parseParticleFile } from './particleAssetParser';
import {
    findEditableSpan,
    getByFieldPath,
    serializeEffect,
    serializeFieldValue,
    setByFieldPath,
} from './particleAssetSerializer';
import type { NumberStyle, ParticleEffect, ParticleRenderPayload, ParticleTexturePayload, Span, Subsystem } from '../webview/particleTypes';

type ParticlePanelMessage =
    | { command: 'selectEffect'; index: number }
    | { command: 'fieldEdit'; effectIndex: number; path: Array<string | number>; value: unknown; reload?: boolean }
    | { command: 'replaceEffect'; effectIndex: number; effect: ParticleEffect }
    | { command: 'openFile' }
    | { command: 'close' }
    | { command: 'undo' }
    | { command: 'redo' }
    | { command: 'screenshot'; data: string }
    | { command: 'log'; text: string; level?: 'info' | 'warn' | 'error' };

interface TextureCacheEntry {
    mtimeMs: number;
    size: number;
    payload: Omit<ParticleTexturePayload, 'file'>;
}

interface EditableFieldTarget {
    span: Span;
    value: unknown;
    numberStyle?: NumberStyle;
    forceQuote?: boolean;
}

export class ParticlePanel {
    public static currentPanel: ParticlePanel | undefined;
    private static readonly viewType = 'cwtools-particle-preview';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _webviewRootPath: string;
    private readonly _disposables: vscode.Disposable[] = [];
    private _document: vscode.TextDocument | undefined;
    private _searchRoots: string[] = [];
    private _selectedEffectIndex = 0;
    private _pendingProgrammaticSaves = 0;
    private readonly _textureCache = new Map<string, TextureCacheEntry>();

    public static async create(extensionPath: string, document: vscode.TextDocument): Promise<void> {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
        if (ParticlePanel.currentPanel) ParticlePanel.currentPanel.dispose();
        const panel = new ParticlePanel(extensionPath, column, document);
        ParticlePanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._document = document;
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');

        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(folder.uri);
        }
        const gamePath = this._getGamePath();
        if (gamePath) localResourceRoots.push(vscode.Uri.file(gamePath));

        this._panel = vscode.window.createWebviewPanel(
            ParticlePanel.viewType,
            `Particle: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );
        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg as ParticlePanelMessage), null, this._disposables),
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (this._document && savedDoc.uri.fsPath === this._document.uri.fsPath) {
                    if (this._pendingProgrammaticSaves > 0) {
                        this._pendingProgrammaticSaves--;
                        return;
                    }
                    await this._loadAndRender(savedDoc, this._selectedEffectIndex);
                }
            }),
        );
    }

    private async _handleMessage(msg: ParticlePanelMessage): Promise<void> {
        if (!msg?.command) return;
        try {
            switch (msg.command) {
                case 'selectEffect':
                    if (this._document) await this._loadAndRender(this._document, msg.index);
                    break;
                case 'fieldEdit':
                    await this._handleFieldEdit(msg);
                    break;
                case 'replaceEffect':
                    await this._handleReplaceEffect(msg.effectIndex, msg.effect);
                    break;
                case 'openFile':
                    await this._handleOpenFile();
                    break;
                case 'close':
                    this.dispose();
                    break;
                case 'undo':
                case 'redo':
                    await this._handleUndoRedo(msg.command);
                    break;
                case 'screenshot':
                    await this._handleScreenshot(msg.data);
                    break;
                case 'log':
                    if (msg.level === 'error') ErrorReporter.warn('ParticlePanel', msg.text);
                    else ErrorReporter.debug('ParticlePanel', msg.text);
                    break;
            }
        } catch (error) {
            ErrorReporter.warn('ParticlePanel', `Failed to handle ${msg.command}`, error);
            await vscode.window.showErrorMessage(`Particle editor error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async _handleOpenFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Asset Files': ['asset'] },
            title: 'Open Particle Asset File / 打开粒子资产文件',
        });
        if (!uris?.[0]) return;
        const doc = await vscode.workspace.openTextDocument(uris[0]);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        this._document = doc;
        this._selectedEffectIndex = 0;
        this._panel.title = `Particle: ${path.basename(doc.fileName)}`;
        await this._loadAndRender(doc);
    }

    private async _handleUndoRedo(command: 'undo' | 'redo'): Promise<void> {
        if (!this._document) return;
        await vscode.window.showTextDocument(this._document.uri, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
        await vscode.commands.executeCommand(command);
        await this._saveProgrammatic(this._document);
        await this._loadAndRender(this._document, this._selectedEffectIndex);
        this._panel.reveal();
    }

    private async _handleScreenshot(data: string): Promise<void> {
        const doc = this._document;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(doc?.uri.fsPath ?? ''), `${path.basename(doc?.uri.fsPath ?? 'particle', '.asset')}_particle.png`)),
            filters: { 'PNG Image': ['png'] },
            title: 'Save Particle Screenshot / 保存粒子截图',
        });
        if (!uri) return;
        await fs.promises.writeFile(uri.fsPath, Buffer.from(data, 'base64'));
        await vscode.window.showInformationMessage(`Screenshot saved: ${path.basename(uri.fsPath)}`);
    }

    private async _handleFieldEdit(msg: Extract<ParticlePanelMessage, { command: 'fieldEdit' }>): Promise<void> {
        const previousPath = this._document?.uri.fsPath;
        const doc = await this._ensureWritableDocument();
        if (!doc) return;
        const createdCopy = !!previousPath && doc.uri.fsPath !== previousPath;
        const parsed = parseParticleFile(doc.getText(), doc.uri.fsPath);
        const effect = parsed.effects[msg.effectIndex];
        if (!effect) return;

        const originalValue = getByFieldPath(effect, msg.path);
        setByFieldPath(effect, msg.path, msg.value);
        const target = this._editableTargetForFieldPath(effect, msg.path, originalValue);
        const replacement = target ? serializeFieldValue(target.value, target.numberStyle, target.forceQuote) : undefined;

        if (!target || replacement === undefined) {
            const fieldName = msg.path.map(String).join('.');
            ErrorReporter.warn('ParticlePanel', `Refused field edit without a safe source span: ${fieldName}`);
            await vscode.window.showWarningMessage(`Particle field "${fieldName}" is not present in the source file. Use Save after adding structural fields.`);
            await this._loadAndRender(doc, msg.effectIndex);
            return;
        }

        await this._replaceText(doc, target.span, replacement, createdCopy || !!msg.reload || this._fieldEditNeedsReload(msg.path), msg.effectIndex);
    }

    private async _handleReplaceEffect(effectIndex: number, effect: ParticleEffect): Promise<void> {
        const doc = await this._ensureWritableDocument();
        if (!doc) return;
        const parsed = parseParticleFile(doc.getText(), doc.uri.fsPath);
        const current = parsed.effects[effectIndex];
        if (!current?.span) return;
        effect.span = current.span;
        await this._replaceEffectBlock(doc, effect, effectIndex);
    }

    private _editableTargetForFieldPath(effect: ParticleEffect, pathParts: Array<string | number>, value: unknown): EditableFieldTarget | undefined {
        const direct = findEditableSpan(value);
        if (direct) {
            return {
                span: direct,
                value: getByFieldPath(effect, pathParts),
                numberStyle: this._numberStyleForFieldPath(effect, pathParts),
                forceQuote: this._forceQuoteForFieldPath(pathParts),
            };
        }
        if (pathParts.length === 0) return undefined;
        const parentPath = pathParts.slice(0, -1);
        const key = String(pathParts[pathParts.length - 1]);
        const parent = parentPath.length ? getByFieldPath(effect, parentPath) : effect;
        const spans = (parent as { spans?: Record<string, Span> } | undefined)?.spans;
        if (spans?.[key]) {
            return {
                span: spans[key],
                value: getByFieldPath(effect, pathParts),
                numberStyle: this._numberStyleForFieldPath(effect, pathParts),
                forceQuote: this._forceQuoteForFieldPath(pathParts),
            };
        }

        if (pathParts.length >= 2) {
            const aggregatePath = pathParts.slice(0, -1);
            const aggregateKey = String(pathParts[pathParts.length - 2]);
            const containerPath = pathParts.slice(0, -2);
            const container = containerPath.length ? getByFieldPath(effect, containerPath) : effect;
            const aggregateSpan = (container as { spans?: Record<string, Span> } | undefined)?.spans?.[aggregateKey];
            if (aggregateSpan) {
                return {
                    span: aggregateSpan,
                    value: getByFieldPath(effect, aggregatePath),
                    numberStyle: this._numberStyleForFieldPath(effect, aggregatePath),
                    forceQuote: this._forceQuoteForFieldPath(aggregatePath),
                };
            }
        }
        return undefined;
    }

    private _numberStyleForFieldPath(effect: ParticleEffect, pathParts: Array<string | number>): NumberStyle | undefined {
        if (pathParts.length === 0) return undefined;
        const parentPath = pathParts.slice(0, -1);
        const key = String(pathParts[pathParts.length - 1]);
        const parent = parentPath.length ? getByFieldPath(effect, parentPath) : effect;
        return (parent as { numberStyles?: Record<string, NumberStyle> } | undefined)?.numberStyles?.[key];
    }

    private _forceQuoteForFieldPath(pathParts: Array<string | number>): boolean {
        const key = String(pathParts[pathParts.length - 1] ?? '');
        return key === 'name' || key === 'file' || key === 'shader' || key === 'op' || key === 'time' ||
            key === 'emitterType' || key === 'sort' || key === 'type';
    }

    private _fieldEditNeedsReload(pathParts: Array<string | number>): boolean {
        return pathParts.includes('texture') && String(pathParts[pathParts.length - 1] ?? '') === 'file';
    }

    private async _replaceText(doc: vscode.TextDocument, span: Span, replacement: string, reload = false, effectIndex = this._selectedEffectIndex): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(span.startOffset), doc.positionAt(span.endOffset)), replacement);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) return;
        await this._saveProgrammatic(doc);
        if (reload) await this._loadAndRender(doc, effectIndex);
    }

    private async _replaceEffectBlock(doc: vscode.TextDocument, effect: ParticleEffect, effectIndex: number): Promise<void> {
        const parsed = parseParticleFile(doc.getText(), doc.uri.fsPath);
        const current = parsed.effects[effectIndex];
        if (!current?.span) return;
        const replacement = serializeEffect(effect);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(current.span.startOffset), doc.positionAt(current.span.endOffset)), replacement);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) return;
        await this._saveProgrammatic(doc);
        await this._loadAndRender(doc, effectIndex);
    }

    private async _ensureWritableDocument(): Promise<vscode.TextDocument | undefined> {
        const doc = this._document;
        if (!doc) return undefined;
        if (this._isEditableFile(doc.uri.fsPath)) return doc;

        const save = await vscode.window.showWarningMessage(
            'This particle asset is outside the workspace. Save a mod copy before editing?',
            'Save Copy',
            'Cancel',
        );
        if (save !== 'Save Copy') return undefined;

        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        const workspaceRoot = workspaceRoots.find(root => !this._isGameFile(root));
        if (!workspaceRoot) {
            await vscode.window.showErrorMessage('Open a mod workspace before editing vanilla particle assets.');
            return undefined;
        }
        const defaultUri = vscode.Uri.file(path.join(workspaceRoot, 'gfx', 'particles', path.basename(doc.uri.fsPath)));
        let target: vscode.Uri | undefined;
        while (!target) {
            const candidate = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'Asset Files': ['asset'] },
            title: 'Save Particle Asset Copy / 保存粒子资产副本',
            });
            if (!candidate) return undefined;
            if (this._isEditableFile(candidate.fsPath)) {
                target = candidate;
            } else {
                await vscode.window.showErrorMessage('Particle copies must be saved inside a mod workspace, not the vanilla game directory.');
            }
        }
        await fs.promises.mkdir(path.dirname(target.fsPath), { recursive: true });
        await fs.promises.writeFile(target.fsPath, doc.getText(), 'utf8');
        const newDoc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.One);
        this._document = newDoc;
        this._panel.title = `Particle: ${path.basename(newDoc.fileName)}`;
        await this._loadAndRender(newDoc, this._selectedEffectIndex);
        return newDoc;
    }

    private _isWorkspaceFile(filePath: string): boolean {
        return (vscode.workspace.workspaceFolders ?? []).some(folder => isPathInsideOrEqual(filePath, folder.uri.fsPath));
    }

    private _isGameFile(filePath: string): boolean {
        const gamePath = this._getGamePath();
        return !!gamePath && isPathInsideOrEqual(filePath, gamePath);
    }

    private _isEditableFile(filePath: string): boolean {
        return this._isWorkspaceFile(filePath) && !this._isGameFile(filePath);
    }

    private async _saveProgrammatic(doc: vscode.TextDocument): Promise<boolean> {
        this._pendingProgrammaticSaves++;
        const saved = await doc.save();
        if (!saved) {
            this._pendingProgrammaticSaves = Math.max(0, this._pendingProgrammaticSaves - 1);
        }
        return saved;
    }

    private async _loadAndRender(document: vscode.TextDocument, selectedEffectIndex = 0): Promise<void> {
        this._document = document;
        this._selectedEffectIndex = selectedEffectIndex;
        this._searchRoots = this._buildSearchRoots(document);
        const parsed = parseParticleFile(document.getText(), document.uri.fsPath);
        const selectedIndex = Math.min(Math.max(selectedEffectIndex, 0), Math.max(parsed.effects.length - 1, 0));
        this._selectedEffectIndex = selectedIndex;
        const textures = await this._buildTexturePayloads(parsed.effects, document);
        const payload: ParticleRenderPayload = {
            effects: parsed.effects,
            diagnostics: parsed.diagnostics,
            fileName: path.basename(document.fileName),
            selectedEffectIndex: selectedIndex,
            textures,
            readonly: !this._isEditableFile(document.uri.fsPath),
        };
        await this._panel.webview.postMessage({ command: 'render', ...payload });
    }

    private _buildSearchRoots(document: vscode.TextDocument): string[] {
        const roots: string[] = [];
        const modRoot = this._findModRoot(path.dirname(document.uri.fsPath));
        if (modRoot) roots.push(modRoot);
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (!roots.includes(folder.uri.fsPath)) roots.push(folder.uri.fsPath);
        }
        const gamePath = this._getGamePath();
        if (gamePath && !roots.includes(gamePath)) roots.push(gamePath);
        return roots;
    }

    private async _buildTexturePayloads(effects: ParticleEffect[], document: vscode.TextDocument): Promise<Record<string, ParticleTexturePayload>> {
        const textureFiles = new Set<string>();
        const collect = (subsystem: Subsystem): void => {
            if (subsystem.texture?.file) textureFiles.add(subsystem.texture.file);
            for (const child of subsystem.childsystems ?? []) collect(child);
        };
        for (const effect of effects) {
            for (const subsystem of effect.subsystems) collect(subsystem);
        }

        const payloads: Record<string, ParticleTexturePayload> = {};
        for (const file of textureFiles) {
            const resolved = this._resolveTexturePath(file, document);
            if (!resolved) continue;
            const decoded = this._decodeTexture(resolved);
            if (decoded) {
                payloads[file] = { file, ...decoded };
            }
        }
        return payloads;
    }

    private _decodeTexture(filePath: string): Omit<ParticleTexturePayload, 'file'> | undefined {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch (error) {
            ErrorReporter.debug('ParticlePanel', `Failed to stat texture ${filePath}`, error);
            this._textureCache.delete(filePath);
            return undefined;
        }
        const cached = this._textureCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.payload;
        }

        const ext = path.extname(filePath).toLowerCase();
        let payload: Omit<ParticleTexturePayload, 'file'> | undefined;
        if (ext === '.dds') payload = decodeDds(filePath) ?? undefined;
        else if (ext === '.tga') payload = decodeTga(filePath) ?? undefined;
        if (ext === '.png') {
            try {
                const data = fs.readFileSync(filePath);
                const dimensions = readPngDimensions(data);
                payload = {
                    dataUri: `data:image/png;base64,${data.toString('base64')}`,
                    width: dimensions?.width ?? 1,
                    height: dimensions?.height ?? 1,
                };
            } catch (error) {
                ErrorReporter.debug('ParticlePanel', `Failed to read PNG texture ${filePath}`, error);
            }
        }
        if (payload) {
            this._textureCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
        } else {
            this._textureCache.delete(filePath);
        }
        return payload;
    }

    private _resolveTexturePath(texturePath: string, document: vscode.TextDocument): string | undefined {
        const normalized = texturePath.trim().replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, '');
        const candidates: string[] = [];
        if (path.isAbsolute(texturePath)) candidates.push(texturePath);
        for (const root of this._searchRoots) candidates.push(path.join(root, normalized));
        candidates.push(path.join(path.dirname(document.uri.fsPath), normalized));

        const withFallbackExtensions = (candidate: string): string[] => {
            if (/\.(dds|png|tga)$/i.test(candidate)) {
                return [candidate, candidate.replace(/\.(dds|png|tga)$/i, '.png'), candidate.replace(/\.(dds|png|tga)$/i, '.tga')];
            }
            return [`${candidate}.dds`, `${candidate}.png`, `${candidate}.tga`];
        };

        for (const candidate of candidates.flatMap(withFallbackExtensions)) {
            const resolved = fs.existsSync(candidate) ? candidate : resolveCaseInsensitivePath(candidate);
            if (resolved) return resolved;
        }
        return undefined;
    }

    private _getGamePath(): string | null {
        const configPath = vscode.workspace.getConfiguration('cwtools').get<string>('cache.stellaris');
        return configPath && fs.existsSync(configPath) ? configPath : null;
    }

    private _findModRoot(dir: string): string | null {
        let current = dir;
        for (let i = 0; i < 6; i++) {
            if (
                fs.existsSync(path.join(current, 'descriptor.mod')) ||
                fs.existsSync(path.join(current, 'common')) ||
                fs.existsSync(path.join(current, 'gfx'))
            ) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    }

    public dispose(): void {
        ParticlePanel.currentPanel = undefined;
        this._document = undefined;
        this._searchRoots = [];
        this._textureCache.clear();
        try {
            void this._panel.webview.postMessage({ command: 'dispose' });
        } catch {
            // Panel may already be gone.
        }
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _getHtml(): string {
        const webview = this._panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'particlePreview.js')));
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'particlePreview.css')));
        const nonce = getNonce();
        const locale = vscode.env.language;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};">
    <link rel="stylesheet" href="${cssUri}">
    <title>Particle Editor</title>
</head>
<body data-locale="${locale}">
    <div id="particle-root">
        <aside id="particle-left" class="side-pane">
            <header class="left-header">
                <h1>Particle Editor</h1>
                <div class="loaded-effect">Loaded effect: <span id="loaded-effect-name">particle</span></div>
                <label id="effect-row" class="left-control-row"><span>Effect</span><select id="effect-select"></select></label>
                <label class="left-control-row"><span>Subsystem</span><select id="subsystem-select"></select></label>
                <label class="left-check-row"><span>Hide other subsystems</span><input id="hide-others-toggle" type="checkbox"></label>
                <label class="left-check-row"><span>Emitter Visuals (Previewer only)</span><input id="emitter-visuals-toggle" type="checkbox"></label>
                <button id="btn-restart" class="wide-button" title="Restart effect">Restart effect</button>
            </header>
            <div id="readonly-banner" class="readonly hidden" data-i18n="readonly">Read-only source. Editing will save a mod copy first.</div>
            <details class="left-section" open>
                <summary>Main controls</summary>
                <div class="button-stack">
                    <button id="btn-save" title="Save">Save</button>
                    <button id="btn-undo" title="Undo">Undo</button>
                    <button id="btn-redo" title="Redo">Redo</button>
                    <button id="btn-open" title="Open">Open</button>
                    <button id="btn-close" title="Exit">Exit</button>
                </div>
            </details>
            <details class="left-section" open>
                <summary>Subsystems</summary>
                <div class="button-stack">
                    <button id="btn-add-subsystem" title="Add subsystem">Add subsystem</button>
                    <button id="btn-clone-subsystem" title="Clone subsystem">Clone subsystem</button>
                    <button id="btn-move-up" title="Forward subsystem">Forward subsystem</button>
                    <button id="btn-move-down" title="Back subsystem">Back subsystem</button>
                    <button id="btn-remove-subsystem" title="Remove subsystem">Remove subsystem</button>
                </div>
            </details>
            <details class="left-section" open>
                <summary data-i18n="curves">Curves</summary>
                <select id="curve-select"></select>
                <canvas id="curve-canvas" width="320" height="180"></canvas>
                <div class="button-stack">
                    <button id="btn-add-curve">Add Curve</button>
                    <button id="btn-remove-curve">Remove Curve</button>
                </div>
            </details>
            <details class="left-section" open>
                <summary data-i18n="forces">Forces</summary>
                <select id="force-select"></select>
                <div class="button-stack">
                    <button id="btn-add-force">Add Force</button>
                    <button id="btn-remove-force">Remove Force</button>
                </div>
                <div id="force-inspector"></div>
            </details>
        </aside>
        <main id="particle-stage">
            <div id="viewport"></div>
            <div id="viewport-overlay">
                <span id="particle-title">Particle Editor</span>
                <span id="approx-label" data-i18n="approx">Approximate simulation</span>
            </div>
            <div id="playbar">
                <button id="btn-play" title="Play/Pause">Pause</button>
                <label><input id="loop-toggle" type="checkbox" checked> <span data-i18n="loop">Loop</span></label>
                <input id="time-scrub" type="range" min="0" max="1000" value="0">
                <span id="time-label">0.00s</span>
                <button id="btn-screenshot" title="Screenshot">PNG</button>
            </div>
            <div id="empty-state" data-i18n="empty">Open a particle .asset file to preview.</div>
        </main>
        <aside id="particle-right" class="side-pane">
            <div class="pane-title" data-i18n="properties">Properties</div>
            <div id="inspector"></div>
        </aside>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

function readPngDimensions(data: Buffer): { width: number; height: number } | undefined {
    if (
        data.length < 24 ||
        data[0] !== 0x89 ||
        data[1] !== 0x50 ||
        data[2] !== 0x4e ||
        data[3] !== 0x47
    ) {
        return undefined;
    }
    return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
    };
}
