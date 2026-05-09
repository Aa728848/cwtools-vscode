/**
 * Entity Preview Panel — manages the webview for 3D entity model visualization.
 * Follows the same architecture as GuiPanel and SolarSystemPanel.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { buildEntityGraph, type EntityDefinition, type EntityGraph, type MeshDefinition } from './entityAssetParser';

// ── WebView message types ──────────────────────────────────────────────────────
type EntityPanelMessage =
    | { command: 'goToLine'; line: number }
    | { command: 'selectState'; stateName: string }
    | { command: 'selectEntity'; index: number }
    | { command: 'openFile' }
    | { command: 'updateLocator'; locatorName: string; position: [number, number, number]; rotation: [number, number, number]; scale: number }
    | { command: 'undo' }
    | { command: 'redo' }
    | { command: 'screenshot'; data: string }
    | { command: 'log'; text: string; level?: 'info' | 'warn' | 'error' };

export class EntityPanel {
    public static currentPanel: EntityPanel | undefined;
    private static readonly viewType = 'cwtools-entity-preview';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _webviewRootPath: string;
    private _document: vscode.TextDocument | undefined;
    private _searchRoots: string[] = [];
    private _entityGraph: EntityGraph | null = null;
    private _skipNextReload = false;
    private _currentEntityName: string | undefined;
    private _currentEntityIndex = 0;
    private static _outputChannel: vscode.OutputChannel | undefined;

    public static async create(extensionPath: string, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (EntityPanel.currentPanel) EntityPanel.currentPanel.dispose();

        const panel = new EntityPanel(extensionPath, column || vscode.ViewColumn.Beside, document);
        EntityPanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        this._document = document;

        // Build resource roots: webview assets + all workspace folders + game path
        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(wf.uri);
        }
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);
        if (modRoot) localResourceRoots.push(vscode.Uri.file(modRoot));

        const gamePath = this._getGamePath();
        if (gamePath) localResourceRoots.push(vscode.Uri.file(gamePath));

        this._panel = vscode.window.createWebviewPanel(
            EntityPanel.viewType,
            `Entity: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async (msg: EntityPanelMessage) => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'goToLine': {
                        const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'selectEntity': {
                        // User selected a different entity from the dropdown
                        await this._loadAndRender(document, msg.index);
                        break;
                    }
                    case 'openFile': {
                        // Open file picker for .asset files
                        const uris = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: false,
                            filters: { 'Asset Files': ['asset'] },
                            title: 'Open Entity Asset File / 打开实体资产文件',
                        });
                        if (uris && uris[0]) {
                            const doc = await vscode.workspace.openTextDocument(uris[0]);
                            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                            // Re-trigger preview
                            this._entityGraph = null;
                            await this._loadAndRender(doc);
                        }
                        break;
                    }
                    case 'updateLocator': {
                        await this._handleUpdateLocator(msg);
                        break;
                    }
                    case 'undo': {
                        if (this._document) {
                            // Focus the text editor so undo targets the .asset file
                            await vscode.window.showTextDocument(this._document.uri, {
                                viewColumn: vscode.ViewColumn.One,
                                preserveFocus: false,
                            });
                            await vscode.commands.executeCommand('undo');
                            // Save and re-render
                            await this._document.save();
                            this._skipNextReload = true;
                            await this._loadAndRender(this._document, this._currentEntityIndex);
                            // Return focus to the webview
                            this._panel.reveal();
                        }
                        break;
                    }
                    case 'redo': {
                        if (this._document) {
                            await vscode.window.showTextDocument(this._document.uri, {
                                viewColumn: vscode.ViewColumn.One,
                                preserveFocus: false,
                            });
                            await vscode.commands.executeCommand('redo');
                            await this._document.save();
                            this._skipNextReload = true;
                            await this._loadAndRender(this._document, this._currentEntityIndex);
                            this._panel.reveal();
                        }
                        break;
                    }
                    case 'screenshot': {
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(
                                path.join(
                                    path.dirname(this._document?.uri.fsPath ?? ''),
                                    `${this._currentEntityName ?? 'entity'}_screenshot.png`,
                                ),
                            ),
                            filters: { 'PNG Image': ['png'] },
                            title: 'Save Screenshot / 保存截图',
                        });
                        if (uri && msg.command === 'screenshot') {
                            const buf = Buffer.from(msg.data, 'base64');
                            await fs.promises.writeFile(uri.fsPath, buf);
                            vscode.window.showInformationMessage(`Screenshot saved: ${path.basename(uri.fsPath)}`);
                        }
                        break;
                    }
                    case 'log': {
                        if (!EntityPanel._outputChannel) {
                            EntityPanel._outputChannel = vscode.window.createOutputChannel('Entity Preview');
                            EntityPanel._outputChannel.show(true); // auto-show, preserve focus
                        }
                        const prefix = msg.level === 'error' ? '❌' : msg.level === 'warn' ? '⚠️' : 'ℹ️';
                        EntityPanel._outputChannel.appendLine(`${prefix} ${msg.text}`);
                        break;
                    }
                }
            }, null, this._disposables),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (savedDoc.uri.fsPath === document.uri.fsPath) {
                    if (this._skipNextReload) {
                        this._skipNextReload = false;
                        return;
                    }
                    this._entityGraph = null; // invalidate cache
                    await this._loadAndRender(savedDoc);
                }
            }),
        );
    }

    /**
     * Handle locator position/rotation update from the webview.
     * - If the locator already exists in the .asset script → update it in-place.
     * - If the locator is mesh-embedded with no script override → insert a new block.
     */
    private async _handleUpdateLocator(msg: { locatorName: string; position: [number, number, number]; rotation: [number, number, number]; scale: number }) {
        if (!this._document) return;
        const doc = this._document;
        const text = doc.getText();
        const lines = text.split('\n');

        // Match locator name (with or without quotes)
        const escapedName = msg.locatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const locNamePattern = new RegExp(`name\\s*=\\s*"?${escapedName}"?`, 'i');

        // First, find the current entity block
        const entityName = this._currentEntityName;
        let entityBlockStart = -1;
        let entityBlockEnd = -1;

        if (entityName) {
            const entityNameEsc = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const entityNamePat = new RegExp(`name\\s*=\\s*"?${entityNameEsc}"?`);
            // Find the entity = { ... } block containing this entity name
            for (let i = 0; i < lines.length; i++) {
                if (/entity\s*=\s*\{/.test(lines[i]!)) {
                    let depth = 0;
                    let blockEnd = i;
                    let hasName = false;
                    for (let j = i; j < lines.length; j++) {
                        for (const ch of lines[j]!) {
                            if (ch === '{') depth++;
                            if (ch === '}') depth--;
                        }
                        if (entityNamePat.test(lines[j]!)) hasName = true;
                        if (depth <= 0) { blockEnd = j; break; }
                    }
                    if (hasName) {
                        entityBlockStart = i;
                        entityBlockEnd = blockEnd;
                        break;
                    }
                }
            }
        }

        // Try to find existing locator block within the entity
        let locLineIndex = -1;
        const searchStart = entityBlockStart >= 0 ? entityBlockStart : 0;
        const searchEnd = entityBlockEnd >= 0 ? entityBlockEnd : lines.length - 1;

        for (let i = searchStart; i <= searchEnd; i++) {
            const line = lines[i]!;
            // Match: locator = { name = xxx ... }
            if (/locator\s*=\s*\{/.test(line) && locNamePattern.test(line)) {
                locLineIndex = i;
                break;
            }
            // Multi-line: locator = { on one line, name = xxx on next
            if (/locator\s*=\s*\{/.test(line)) {
                let depth = 0;
                let blockEnd = i;
                let foundName = false;
                for (let j = i; j <= searchEnd; j++) {
                    for (const ch of lines[j]!) {
                        if (ch === '{') depth++;
                        if (ch === '}') depth--;
                    }
                    if (locNamePattern.test(lines[j]!)) foundName = true;
                    if (depth <= 0) { blockEnd = j; break; }
                }
                if (foundName) {
                    // Replace entire multi-line block
                    const indent = lines[i]!.match(/^(\s*)/)?.[1] ?? '\t';
                    const p = msg.position;
                    const r = msg.rotation;
                    const newLine = `${indent}locator = { name = "${msg.locatorName}" position = { ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} } rotation = { ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)} } }`;
                    const startPos = new vscode.Position(i, 0);
                    const endPos = new vscode.Position(blockEnd, lines[blockEnd]!.length);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, new vscode.Range(startPos, endPos), newLine);
                    this._skipNextReload = true;
                    await vscode.workspace.applyEdit(edit);
                    await doc.save();
                    return;
                }
            }
        }

        if (locLineIndex >= 0) {
            // Update existing single-line locator
            const indent = lines[locLineIndex]!.match(/^(\s*)/)?.[1] ?? '\t';
            const p = msg.position;
            const r = msg.rotation;
            const newLine = `${indent}locator = { name = "${msg.locatorName}" position = { ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} } rotation = { ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)} } }`;
            const range = new vscode.Range(
                new vscode.Position(locLineIndex, 0),
                new vscode.Position(locLineIndex, lines[locLineIndex]!.length),
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, newLine);
            this._skipNextReload = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
        } else if (entityBlockEnd >= 0) {
            // Insert new locator block into entity definition (before closing brace)
            const p = msg.position;
            const r = msg.rotation;
            const newLine = `\tlocator = { name = "${msg.locatorName}" position = { ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} } rotation = { ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)} } }\n`;
            const insertPos = new vscode.Position(entityBlockEnd, 0);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, insertPos, newLine);
            this._skipNextReload = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            console.log(`[EntityPanel] Inserted new locator "${msg.locatorName}" into entity "${entityName}"`);
        } else {
            console.warn(`[EntityPanel] Cannot find entity block to insert locator "${msg.locatorName}"`);
        }
    }

    private _getGamePath(): string | null {
        const config = vscode.workspace.getConfiguration('cwtools');
        const configPath = config.get<string>('cache.stellaris');
        if (configPath && fs.existsSync(configPath)) return configPath;
        return null;
    }

    private _findModRoot(dir: string): string | null {
        let current = dir;
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(current, 'descriptor.mod')) ||
                fs.existsSync(path.join(current, 'common')) ||
                (fs.existsSync(path.join(current, 'interface')) && fs.existsSync(path.join(current, 'gfx')))) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return dir;
    }

    private async _loadAndRender(document: vscode.TextDocument, entityIndex = 0) {
        const content = document.getText();
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);

        // Collect search roots
        const searchRoots: string[] = [];
        if (modRoot) searchRoots.push(modRoot);
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            if (!searchRoots.includes(wf.uri.fsPath)) searchRoots.push(wf.uri.fsPath);
        }
        const gamePath = this._getGamePath();
        if (gamePath && !searchRoots.includes(gamePath)) searchRoots.push(gamePath);
        this._searchRoots = searchRoots;

        // Build entity graph (cached)
        if (!this._entityGraph) {
            this._entityGraph = await this._buildEntityGraph(searchRoots);
        }

        // Find all entities defined in the current file
        const { parseAssetFile } = await import('./entityAssetParser');
        const currentEntities = parseAssetFile(content, document.uri.fsPath).entities;
        if (currentEntities.length === 0) {
            await this._panel.webview.postMessage({
                command: 'error',
                message: 'No entity definitions found in this file',
            });
            return;
        }

        // Send entity list so the webview can show a selector
        await this._panel.webview.postMessage({
            command: 'entityList',
            entities: currentEntities.map((e, i) => ({ name: e.name, index: i })),
            selectedIndex: entityIndex,
        });

        const entity = currentEntities[Math.min(entityIndex, currentEntities.length - 1)]!;
        this._currentEntityName = entity.name;
        this._currentEntityIndex = entityIndex;

        // Resolve mesh file path
        let meshBuffer: ArrayBuffer | undefined;
        let meshFileDir: string | undefined;
        // Per-submesh material overrides from GFX/entity, keyed by mesh index
        const resolvedMeshSettings: Array<{
            name: string;
            index: number;
            diffuse?: string;
            normal?: string;
            specular?: string;
            shader?: string;
        }> = [];
        // Map of relative texture path → webview URI for mesh-embedded materials
        const textureMap: Record<string, string> = {};

        let meshScale: number | undefined;
        if (entity.pdxmesh) {
            const meshDef = this._entityGraph.meshes.get(entity.pdxmesh);
            if (meshDef) {
                meshScale = meshDef.scale;
                // Find the .mesh binary file
                const meshFilePath = this._resolveFilePath(meshDef.file, searchRoots);
                meshFileDir = meshFilePath ? path.dirname(meshFilePath) : undefined;
                if (meshFilePath) {
                    try {
                        const data = await fs.promises.readFile(meshFilePath);
                        const buf = Buffer.from(data);
                        meshBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
                    } catch (e) {
                        console.warn(`Failed to read mesh file: ${meshFilePath}`, e);
                    }
                }

                // Collect ALL meshsettings keyed by NAME+INDEX
                // name = which submesh, index = texture layer (0 = base layer)
                const msMap = new Map<string, { name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>();

                // GFX pdxmesh meshsettings (lower priority)
                for (const ms of meshDef.meshSettings) {
                    const name = ms.name || `__unnamed`;
                    const idx = ms.index ?? 0;
                    const key = `${name}@${idx}`;
                    msMap.set(key, {
                        name,
                        index: idx,
                        diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                        normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                        specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                        shader: ms.shader,
                    });
                }

                // Entity meshsettings override (higher priority)
                for (const ms of entity.meshSettings) {
                    const name = ms.name || `__unnamed`;
                    const idx = ms.index ?? 0;
                    const key = `${name}@${idx}`;
                    const existing = msMap.get(key) ?? { name, index: idx };
                    if (ms.textureDiffuse) existing.diffuse = this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir);
                    if (ms.textureNormal) existing.normal = this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir);
                    if (ms.textureSpecular) existing.specular = this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir);
                    if (ms.shader) existing.shader = ms.shader;
                    msMap.set(key, existing);
                }

                for (const [, ms] of msMap) {
                    resolvedMeshSettings.push(ms);
                }

                // Also scan the mesh file's directory for textures
                if (meshFileDir) {
                    try {
                        const entries = fs.readdirSync(meshFileDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isFile() && /\.(dds|png|tga)$/i.test(entry.name)) {
                                const full = path.join(meshFileDir, entry.name);
                                textureMap[entry.name] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                                // Also add with forward-slash relative path from root
                                for (const root of searchRoots) {
                                    if (full.startsWith(root)) {
                                        const relPath = path.relative(root, full).replace(/\\/g, '/');
                                        textureMap[relPath] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                                    }
                                }
                            }
                        }
                    } catch { /* skip */ }
                }
            }
        }

        // Build textureMap: try to resolve common texture paths from gfx directory
        // This lets the webview look up mesh-embedded material texture paths
        await this._buildTextureMap(textureMap, searchRoots);

        // Recursively resolve attach data (child entities)
        const attachData = await this._resolveAttachData(entity, this._entityGraph!, searchRoots, textureMap, 0, 8);

        // Send data to webview
        let meshBase64: string | undefined;
        if (meshBuffer) {
            meshBase64 = Buffer.from(meshBuffer).toString('base64');
        }

        // Discover animation files for each state (deduplicate by animName)
        const animations: Array<{ stateName: string; animName: string; animBase64: string }> = [];
        const seenAnims = new Set<string>();
        for (const state of entity.states) {
            if (state.animation && !seenAnims.has(state.animation)) {
                seenAnims.add(state.animation);
                const meshDef = entity.pdxmesh ? this._entityGraph?.meshes.get(entity.pdxmesh) : undefined;
                let mappedAnim = meshDef?.animations?.[state.animation];
                if (mappedAnim) {
                    const graphAnim = this._entityGraph?.animations.get(mappedAnim);
                    mappedAnim = graphAnim || mappedAnim;
                    const animFile = this._findAnimFile(mappedAnim, searchRoots, meshFileDir);
                    if (animFile) {
                        try {
                            const animBuffer = fs.readFileSync(animFile);
                            animations.push({
                                stateName: state.name,
                                animName: state.animation,
                                animBase64: animBuffer.toString('base64'),
                            });
                        } catch { /* skip unreadable anim files */ }
                    }
                }
            }
        }

        await this._panel.webview.postMessage({
            command: 'render',
            entity: {
                name: entity.name,
                pdxmesh: entity.pdxmesh,
                scale: entity.scale,
                meshScale,
                resolvedMeshSettings,
                textureMap,
                locators: entity.locators.map(l => ({
                    name: l.name,
                    position: l.position,
                    rotation: l.rotation,
                    scale: l.scale,
                })),
                attaches: entity.attaches,
                states: entity.states.map(s => ({ name: s.name, animation: s.animation })),
                defaultState: entity.defaultState,
                attachData,
            },
            meshBase64,
            animations: animations.length > 0 ? animations : undefined,
            fileName: path.basename(document.fileName),
        });
    }

    private _resolveFilePath(relPath: string, searchRoots: string[]): string | null {
        const normalized = relPath.replace(/\//g, path.sep);
        for (const root of searchRoots) {
            const full = path.join(root, normalized);
            if (fs.existsSync(full)) return full;
        }
        return null;
    }

    /**
     * Search for a .anim file by animation name.
     * Strategy:
     * 1. Direct match: {name}.anim in mesh dir / searchRoots
     * 2. Suffix match: *_{name}.anim in mesh dir (Stellaris convention)
     * 3. Recursive search in gfx/models
     */
    private _findAnimFile(animName: string, searchRoots: string[], meshFileDir?: string): string | null {
        const fileName = animName.endsWith('.anim') ? animName : `${animName}.anim`;
        const suffix = `_${animName}.anim`.toLowerCase();

        // 1. Direct match in mesh directory
        if (meshFileDir) {
            const direct = path.join(meshFileDir, fileName);
            if (fs.existsSync(direct)) return direct;

            // 2. Suffix match: *_{animName}.anim in mesh directory
            try {
                const entries = fs.readdirSync(meshFileDir);
                for (const entry of entries) {
                    if (entry.toLowerCase().endsWith(suffix)) {
                        return path.join(meshFileDir, entry);
                    }
                }
            } catch { /* skip */ }
        }

        // 3. Direct match in searchRoots
        for (const root of searchRoots) {
            const full = path.join(root, fileName);
            if (fs.existsSync(full)) return full;
        }

        // 4. Recursive search in gfx/models subdirectories
        for (const root of searchRoots) {
            const gfxDir = path.join(root, 'gfx', 'models');
            if (fs.existsSync(gfxDir)) {
                const found = this._findFileRecursive(gfxDir, fileName);
                if (found) return found;
            }
        }

        return null;
    }

    private _resolveTextureUri(texPath: string, searchRoots: string[], meshFileDir?: string): string | undefined {
        const normalized = texPath.replace(/\//g, path.sep);
        const extensions = ['.dds', '.png', '.tga'];

        // Helper to try a full path with extension fallbacks
        const tryPath = (base: string): string | undefined => {
            for (const ext of extensions) {
                const p = base.replace(/\.(dds|png|tga)$/i, ext);
                if (fs.existsSync(p)) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(p)).toString();
                }
            }
            // If no extension in original, try adding .dds
            if (!/\.(dds|png|tga)$/i.test(base) && fs.existsSync(base + '.dds')) {
                return this._panel.webview.asWebviewUri(vscode.Uri.file(base + '.dds')).toString();
            }
            return undefined;
        };

        // 1. Try as relative path from each search root
        for (const root of searchRoots) {
            const result = tryPath(path.join(root, normalized));
            if (result) return result;
        }

        // 2. If it's a bare filename (no directory separators), search in the mesh file's directory
        if (meshFileDir && !texPath.includes('/') && !texPath.includes('\\')) {
            const result = tryPath(path.join(meshFileDir, normalized));
            if (result) return result;
        }

        // 3. Try glob-searching in gfx/models under each root for bare filenames
        if (!texPath.includes('/') && !texPath.includes('\\')) {
            for (const root of searchRoots) {
                const found = this._findFileRecursive(path.join(root, 'gfx', 'models'), texPath);
                if (found) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(found)).toString();
                }
            }
        }

        return undefined;
    }

    /**
     * Recursively search for a file by name in a directory (max depth 5).
     */
    private _findFileRecursive(dir: string, filename: string, depth = 0): string | null {
        if (depth > 5) return null;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
                    return full;
                }
                if (entry.isDirectory() && depth < 5) {
                    const found = this._findFileRecursive(full, filename, depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* skip */ }
        return null;
    }

    /**
     * Recursively resolve attach data for child entities.
     * Returns an array of resolved child entity data including mesh buffers and textures.
     */
    private async _resolveAttachData(
        entity: EntityDefinition,
        graph: EntityGraph,
        searchRoots: string[],
        parentTextureMap: Record<string, string>,
        currentDepth: number,
        maxDepth: number,
    ): Promise<Array<{
        locatorName: string;
        entityName: string;
        meshBase64?: string;
        resolvedMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>;
        textureMap: Record<string, string>;
        scale?: number;
        meshScale?: number;
        locators: Array<{ name: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: number }>;
        attachData?: unknown[];
        defaultState?: string;
        getStateFromParent?: boolean;
        animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
    }>> {
        if (currentDepth >= maxDepth || !entity.attaches || entity.attaches.length === 0) {
            return [];
        }

        const results: Array<{
            locatorName: string;
            entityName: string;
            meshBase64?: string;
            resolvedMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }>;
            textureMap: Record<string, string>;
            scale?: number;
            meshScale?: number;
            locators: Array<{ name: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: number }>;
            attachData?: unknown[];
            defaultState?: string;
            getStateFromParent?: boolean;
            animations?: Array<{ stateName: string; animName: string; animBase64: string }>;
        }> = [];

        for (const attach of entity.attaches) {
            try {
                const childEntity = graph.entities.get(attach.entityName);
                if (!childEntity) {
                    console.warn(`[EntityPanel] Attach entity "${attach.entityName}" not found in entity graph (locator: ${attach.locatorName})`);
                    continue;
                }

                // Resolve mesh
                let meshBase64: string | undefined;
                const childMeshSettings: Array<{ name: string; index: number; diffuse?: string; normal?: string; specular?: string; shader?: string }> = [];
                const childTextureMap: Record<string, string> = { ...parentTextureMap };

                let childMeshScale: number | undefined;
                if (childEntity.pdxmesh) {
                    const meshDef = graph.meshes.get(childEntity.pdxmesh);
                    if (meshDef) {
                        childMeshScale = meshDef.scale;
                        const meshFilePath = this._resolveFilePath(meshDef.file, searchRoots);
                        const meshFileDir = meshFilePath ? path.dirname(meshFilePath) : undefined;

                        if (meshFilePath) {
                            try {
                                const data = await fs.promises.readFile(meshFilePath);
                                const buf = Buffer.from(data);
                                meshBase64 = buf.toString('base64');
                            } catch { /* skip */ }
                        }

                        // Resolve meshsettings
                        for (const ms of meshDef.meshSettings) {
                            const name = ms.name || '__unnamed';
                            const idx = ms.index ?? 0;
                            childMeshSettings.push({
                                name, index: idx,
                                diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                                normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                                specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                                shader: ms.shader,
                            });
                        }

                        // Entity-level meshsettings override
                        for (const ms of childEntity.meshSettings) {
                            const name = ms.name || '__unnamed';
                            const idx = ms.index ?? 0;
                            const existing = childMeshSettings.find(s => s.name === name && s.index === idx);
                            if (existing) {
                                if (ms.textureDiffuse) existing.diffuse = this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir);
                                if (ms.textureNormal) existing.normal = this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir);
                                if (ms.textureSpecular) existing.specular = this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir);
                                if (ms.shader) existing.shader = ms.shader;
                            } else {
                                childMeshSettings.push({
                                    name, index: idx,
                                    diffuse: ms.textureDiffuse ? this._resolveTextureUri(ms.textureDiffuse, searchRoots, meshFileDir) : undefined,
                                    normal: ms.textureNormal ? this._resolveTextureUri(ms.textureNormal, searchRoots, meshFileDir) : undefined,
                                    specular: ms.textureSpecular ? this._resolveTextureUri(ms.textureSpecular, searchRoots, meshFileDir) : undefined,
                                    shader: ms.shader,
                                });
                            }
                        }
                    }
                }

                // Recursively resolve child's attaches
                const childAttachData = await this._resolveAttachData(childEntity, graph, searchRoots, childTextureMap, currentDepth + 1, maxDepth);

                // Resolve child's animations (needed for both own-state and parent-state modes)
                let childAnimations: Array<{ stateName: string; animName: string; animBase64: string }> | undefined;
                if (childEntity.states.length > 0) {
                    const meshDef = childEntity.pdxmesh ? graph.meshes.get(childEntity.pdxmesh) : undefined;
                    const childMeshFileDir = meshDef ? (() => { const p = this._resolveFilePath(meshDef.file, searchRoots); return p ? path.dirname(p) : undefined; })() : undefined;
                    childAnimations = [];
                    // Cache loaded anim data by animName (multiple states may share same animation file)
                    const animCache = new Map<string, string>();
                    for (const state of childEntity.states) {
                        if (!state.animation) continue;
                        let base64 = animCache.get(state.animation);
                        if (base64 === undefined) {
                            const meshDef = childEntity.pdxmesh ? graph.meshes.get(childEntity.pdxmesh) : undefined;
                            let mappedAnim = meshDef?.animations?.[state.animation];
                            if (mappedAnim) {
                                mappedAnim = graph.animations.get(mappedAnim) || mappedAnim;
                                const animFile = this._findAnimFile(mappedAnim, searchRoots, childMeshFileDir);
                                if (animFile) {
                                    try {
                                        base64 = fs.readFileSync(animFile).toString('base64');
                                        animCache.set(state.animation, base64);
                                    } catch { /* skip */ }
                                }
                            } else {
                                // No GFX animation mapping for this child state
                            }
                        }
                        if (base64) {
                            childAnimations.push({
                                stateName: state.name,
                                animName: state.animation,
                                animBase64: base64,
                            });
                        }
                    }
                    if (childAnimations.length === 0) childAnimations = undefined;
                }

                results.push({
                    locatorName: attach.locatorName,
                    entityName: attach.entityName,
                    meshBase64,
                    resolvedMeshSettings: childMeshSettings,
                    textureMap: childTextureMap,
                    scale: childEntity.scale,
                    meshScale: childMeshScale,
                    locators: childEntity.locators.map(l => ({
                        name: l.name,
                        position: l.position,
                        rotation: l.rotation,
                        scale: l.scale,
                    })),
                    attachData: childAttachData,
                    defaultState: childEntity.defaultState,
                    getStateFromParent: childEntity.getStateFromParent,
                    animations: childAnimations,
                });
            } catch (e) {
                console.warn(`[EntityPanel] Failed to resolve attach "${attach.entityName}": ${e}`);
            }
        }

        return results;
    }

    /**
     * Build a textureMap by scanning for .dds files near the mesh file.
     * Maps relative paths (e.g. "gfx/models/ships/x_diffuse.dds") to webview URIs
     * so the webview can resolve mesh-embedded material texture references.
     */
    private async _buildTextureMap(textureMap: Record<string, string>, searchRoots: string[]) {
        // Scan gfx/models directories for .dds textures, limited to avoid perf issues
        const maxTextures = 500;
        let count = 0;
        for (const root of searchRoots) {
            const modelsDir = path.join(root, 'gfx', 'models');
            try { await fs.promises.access(modelsDir); } catch { continue; }
            await this._scanTextures(root, modelsDir, textureMap, maxTextures, () => count++, () => count);
        }
    }

    private async _scanTextures(
        rootDir: string,
        dir: string,
        textureMap: Record<string, string>,
        maxTextures: number,
        increment: () => void,
        getCount: () => number,
    ) {
        if (getCount() >= maxTextures) return;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (getCount() >= maxTextures) break;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this._scanTextures(rootDir, full, textureMap, maxTextures, increment, getCount);
                } else if (/\.(dds|png|tga)$/i.test(entry.name)) {
                    const relPath = path.relative(rootDir, full).replace(/\\/g, '/');
                    textureMap[relPath] = this._panel.webview.asWebviewUri(vscode.Uri.file(full)).toString();
                    increment();
                }
            }
        } catch { /* skip inaccessible */ }
    }

    private async _buildEntityGraph(searchRoots: string[]): Promise<EntityGraph> {
        const assetFiles: Array<{ path: string; content: string }> = [];
        const gfxFiles: Array<{ path: string; content: string }> = [];
        const maxFiles = 1000;

        for (const root of searchRoots) {
            const gfxDir = path.join(root, 'gfx');
            try { await fs.promises.access(gfxDir); } catch { continue; }
            await this._findFiles(gfxDir, '.asset', assetFiles, maxFiles);
            await this._findFiles(gfxDir, '.gfx', gfxFiles, maxFiles);
        }

        return buildEntityGraph(assetFiles, gfxFiles);
    }

    private async _findFiles(
        dir: string,
        ext: string,
        result: Array<{ path: string; content: string }>,
        maxFiles: number,
    ) {
        if (result.length >= maxFiles) return;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                if (result.length >= maxFiles) return;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this._findFiles(full, ext, result, maxFiles);
                } else if (entry.name.endsWith(ext)) {
                    try {
                        const content = await fs.promises.readFile(full, 'utf-8');
                        result.push({ path: full, content });
                    } catch { /* skip unreadable */ }
                }
            }));
        } catch { /* skip inaccessible */ }
    }

    public dispose() {
        EntityPanel.currentPanel = undefined;
        this._document = undefined;
        this._searchRoots = [];
        this._entityGraph = null;
        // Tell webview to clean up Three.js resources before destroying
        try {
            this._panel.webview.postMessage({ command: 'dispose' });
        } catch { /* panel may already be disposed */ }
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getHtml(): string {
        const webview = this._panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'entityPreview.js')));
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'entityPreview.css')));
        const locale = vscode.env.language; // e.g. 'zh-cn', 'en'
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};">
    <link rel="stylesheet" href="${cssUri}">
    <title>Entity Preview</title>
</head>
<body data-locale="${locale}">
    <div id="error-banner"></div>

    <div id="toolbar">
        <span class="entity-name" data-i18n="title">Entity Preview</span>
        <select id="sel-entity" style="display:none"></select>
        <select id="sel-state" style="display:none"></select>
        <span class="toolbar-separator"></span>
        <button id="btn-focus" class="toolbar-btn" title="F"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="3"/></svg> <span data-i18n="focus">Focus (F)</span></button>
        <span class="toolbar-separator"></span>
        <button id="btn-translate" class="toolbar-btn tool-mode active" title="W" data-mode="translate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="14,7 19,12 14,17"/><line x1="12" y1="5" x2="12" y2="19"/><polyline points="7,14 12,19 17,14"/></svg> <span>W</span></button>
        <button id="btn-rotate" class="toolbar-btn tool-mode" title="E" data-mode="rotate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/><polyline points="21,3 21,9 15,9"/></svg> <span>E</span></button>
        <span class="toolbar-separator"></span>
        <label><input type="checkbox" id="chk-wireframe"> <span data-i18n="wireframe">Wireframe</span></label>
        <label><input type="checkbox" id="chk-locators" checked> <span data-i18n="locators">Locators</span></label>
        <label><input type="checkbox" id="chk-bones"> <span data-i18n="bones">Bones</span></label>
        <label><input type="checkbox" id="chk-normals"> <span data-i18n="disableNormals">Disable Normals</span></label>
    </div>

    <div id="canvas-container">
        <div id="loading-overlay">
            <div class="spinner"></div>
            <div class="progress-text" data-i18n="loading">Loading...</div>
            <div class="progress-bar"><div class="progress-bar-fill"></div></div>
        </div>
        <div id="empty-state">
            <div class="empty-icon">📦</div>
            <div class="empty-text" data-i18n="noEntity">No entity loaded</div>
            <div class="empty-hint" data-i18n="openHint">Open a .asset file and click preview</div>
        </div>
        <div id="transform-hint" class="hidden"></div>
    </div>

    <div id="timeline" style="display:none">
        <button id="btn-anim-play" class="timeline-btn" title="Play/Pause">▶</button>
        <input type="range" id="anim-scrub" min="0" max="1000" value="0" class="timeline-scrub">
        <span id="anim-time" class="timeline-time">0.0 / 0.0s</span>
        <button id="btn-anim-loop" class="timeline-btn" title="Loop">🔁</button>
        <button id="btn-anim-speed" class="timeline-btn" title="Speed">1x</button>
    </div>

    <div id="properties-panel" class="hidden">
        <div class="props-header">
            <span class="props-title">Properties</span>
            <span class="props-name" id="props-locator-name"></span>
            <button class="props-close" id="btn-props-close">&times;</button>
        </div>
        <div class="props-body">
            <div class="props-row"><label>Position X</label><input type="number" step="0.1" id="prop-px"></div>
            <div class="props-row"><label>Position Y</label><input type="number" step="0.1" id="prop-py"></div>
            <div class="props-row"><label>Position Z</label><input type="number" step="0.1" id="prop-pz"></div>
            <div class="props-row"><label>Rotation X</label><input type="number" step="1" id="prop-rx"></div>
            <div class="props-row"><label>Rotation Y</label><input type="number" step="1" id="prop-ry"></div>
            <div class="props-row"><label>Rotation Z</label><input type="number" step="1" id="prop-rz"></div>
            <div class="props-actions">
                <button class="toolbar-btn" id="btn-apply" data-i18n="apply">Apply</button>
                <button class="toolbar-btn secondary" id="btn-reset" data-i18n="reset">Reset</button>
            </div>
        </div>
    </div>
    <div id="entity-tree"></div>
    <div id="info-panel"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
