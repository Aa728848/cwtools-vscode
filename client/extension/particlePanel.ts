import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeDds, decodeTga } from './ddsDecoder';
import { ErrorReporter } from './ai/errorReporter';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import { isPathInsideOrEqual } from './pathScope';
import { parseParticleFile } from './particleAssetParser';
import { serializeEffect } from './particleAssetSerializer';
import type {
    ParticleEffect,
    ParticleRenderPayload,
    ParticleTextureCandidate,
    ParticleTextureCandidateSource,
    ParticleTexturePayload,
    Subsystem,
} from '../webview/particleTypes';

const TEXTURE_CANDIDATE_LIMIT = 3000;

type ParticlePanelMessage =
    | { command: 'selectEffect'; index: number }
    | { command: 'dirtyState'; dirty: boolean }
    | { command: 'previewEffects'; requestId: number; effects: ParticleEffect[] }
    | { command: 'saveEffects'; selectedEffectIndex: number; effects: ParticleEffect[]; dirtyEffectIndices: number[] }
    | { command: 'openFile' }
    | { command: 'close' }
    | { command: 'screenshot'; data: string }
    | { command: 'log'; text: string; level?: 'info' | 'warn' | 'error' };

interface TextureCacheEntry {
    mtimeMs: number;
    size: number;
    payload: Omit<ParticleTexturePayload, 'file'>;
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
    private _hasUnsavedPreviewChanges = false;
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
                    if (this._hasUnsavedPreviewChanges) {
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
                    this._selectedEffectIndex = msg.index;
                    break;
                case 'dirtyState':
                    this._hasUnsavedPreviewChanges = msg.dirty;
                    break;
                case 'previewEffects':
                    await this._handlePreviewEffects(msg.effects, msg.requestId);
                    break;
                case 'saveEffects':
                    await this._handleSaveEffects(msg);
                    break;
                case 'openFile':
                    await this._handleOpenFile();
                    break;
                case 'close':
                    this.dispose();
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
        if (this._hasUnsavedPreviewChanges) {
            const choice = await vscode.window.showWarningMessage(
                'The particle editor has unsaved cached changes. Open another file and discard them?',
                'Discard and Open',
                'Cancel',
            );
            if (choice !== 'Discard and Open') return;
            this._hasUnsavedPreviewChanges = false;
        }
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

    private async _handlePreviewEffects(effects: ParticleEffect[], requestId: number): Promise<void> {
        const doc = this._document;
        if (!doc) return;
        const textures = await this._buildTexturePayloads(effects, doc);
        await this._panel.webview.postMessage({ command: 'textures', requestId, textures });
    }

    private async _handleSaveEffects(msg: Extract<ParticlePanelMessage, { command: 'saveEffects' }>): Promise<void> {
        const doc = await this._ensureWritableDocument();
        if (!doc) return;
        this._selectedEffectIndex = msg.selectedEffectIndex;

        const parsed = parseParticleFile(doc.getText(), doc.uri.fsPath);
        const edit = new vscode.WorkspaceEdit();
        const dirtyIndices = [...new Set(msg.dirtyEffectIndices)]
            .filter(index => Number.isInteger(index) && index >= 0 && index < msg.effects.length)
            .sort((a, b) => b - a);

        let replacementCount = 0;
        for (const index of dirtyIndices) {
            const current = parsed.effects[index];
            const effect = msg.effects[index];
            if (!current?.span || !effect) continue;
            effect.span = current.span;
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(current.span.startOffset), doc.positionAt(current.span.endOffset)), serializeEffect(effect));
            replacementCount++;
        }

        if (replacementCount > 0) {
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) return;
            const saved = await this._saveProgrammatic(doc);
            if (!saved) return;
        }

        this._hasUnsavedPreviewChanges = false;
        await this._postSaveComplete(doc, msg.effects, msg.selectedEffectIndex);
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
        this._hasUnsavedPreviewChanges = false;
        this._searchRoots = this._buildSearchRoots(document);
        const parsed = parseParticleFile(document.getText(), document.uri.fsPath);
        const selectedIndex = Math.min(Math.max(selectedEffectIndex, 0), Math.max(parsed.effects.length - 1, 0));
        this._selectedEffectIndex = selectedIndex;
        const textures = await this._buildTexturePayloads(parsed.effects, document);
        const textureCandidates = this._buildTextureCandidates();
        const payload: ParticleRenderPayload = {
            effects: parsed.effects,
            diagnostics: parsed.diagnostics,
            fileName: path.basename(document.fileName),
            selectedEffectIndex: selectedIndex,
            textures,
            textureCandidates,
            readonly: !this._isEditableFile(document.uri.fsPath),
        };
        await this._panel.webview.postMessage({ command: 'render', ...payload });
    }

    private async _postSaveComplete(document: vscode.TextDocument, effects: ParticleEffect[], selectedEffectIndex: number): Promise<void> {
        this._document = document;
        this._selectedEffectIndex = selectedEffectIndex;
        this._searchRoots = this._buildSearchRoots(document);
        const textures = await this._buildTexturePayloads(effects, document);
        const textureCandidates = this._buildTextureCandidates();
        await this._panel.webview.postMessage({
            command: 'saved',
            fileName: path.basename(document.fileName),
            selectedEffectIndex,
            textures,
            textureCandidates,
            readonly: !this._isEditableFile(document.uri.fsPath),
        });
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

    private _buildTextureCandidates(): ParticleTextureCandidate[] {
        const sourcesByFile = new Map<string, Set<Exclude<ParticleTextureCandidateSource, 'mod+vanilla'>>>();
        let count = 0;
        for (const root of this._searchRoots) {
            if (count >= TEXTURE_CANDIDATE_LIMIT) break;
            count += this._collectTextureCandidates(root, sourcesByFile, TEXTURE_CANDIDATE_LIMIT - count);
        }
        return [...sourcesByFile.entries()]
            .map(([file, sources]) => ({
                file,
                source: this._textureCandidateSource(sources),
            }))
            .sort((a, b) => {
                const sourceOrder = this._textureSourceSort(a.source) - this._textureSourceSort(b.source);
                return sourceOrder || a.file.localeCompare(b.file, undefined, { sensitivity: 'base' });
            });
    }

    private _collectTextureCandidates(
        root: string,
        sourcesByFile: Map<string, Set<Exclude<ParticleTextureCandidateSource, 'mod+vanilla'>>>,
        remaining: number,
    ): number {
        const baseDir = path.join(root, 'gfx', 'particles');
        if (remaining <= 0 || !fs.existsSync(baseDir)) return 0;
        const source: Exclude<ParticleTextureCandidateSource, 'mod+vanilla'> = this._isGameFile(baseDir) ? 'vanilla' : 'mod';
        const stack: Array<{ dir: string; depth: number }> = [{ dir: baseDir, depth: 0 }];
        let added = 0;

        while (stack.length && added < remaining) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current.dir, { withFileTypes: true });
            } catch (error) {
                ErrorReporter.debug('ParticlePanel', `Failed to scan particle texture directory ${current.dir}`, error);
                continue;
            }

            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            for (const entry of entries) {
                const fullPath = path.join(current.dir, entry.name);
                if (entry.isDirectory() && current.depth < 4) {
                    stack.push({ dir: fullPath, depth: current.depth + 1 });
                    continue;
                }
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.dds') continue;
                const texturePath = path.relative(root, fullPath).split(path.sep).join('/');
                const sources = sourcesByFile.get(texturePath) ?? new Set<Exclude<ParticleTextureCandidateSource, 'mod+vanilla'>>();
                const hadSource = sources.has(source);
                sources.add(source);
                sourcesByFile.set(texturePath, sources);
                if (!hadSource) added++;
                if (added >= remaining) break;
            }
        }
        return added;
    }

    private _textureCandidateSource(sources: Set<Exclude<ParticleTextureCandidateSource, 'mod+vanilla'>>): ParticleTextureCandidateSource {
        return sources.size > 1 ? 'mod+vanilla' : sources.has('mod') ? 'mod' : 'vanilla';
    }

    private _textureSourceSort(source: ParticleTextureCandidateSource): number {
        if (source === 'mod') return 0;
        if (source === 'mod+vanilla') return 1;
        return 2;
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
                <div class="loaded-effect">Loaded particle: <span id="loaded-effect-name">particle</span></div>
                <label id="effect-row" class="left-control-row">
                    <span>Particle</span>
                    <div class="effect-load-control">
                        <select id="effect-select"></select>
                        <button id="btn-load-effect" type="button" title="Load selected particle">Load</button>
                    </div>
                </label>
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
