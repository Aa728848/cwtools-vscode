/**
 * Solar System Preview Panel - manages the webview for solar system visualization.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseSolarSystemFile, resolveValue, type SolarSystem, type CelestialBody } from './solarSystemParser';
import { decodeDds, decodeTga } from './ddsDecoder';
import { buildSpriteIndex, type SpriteInfo } from './guiParser';
import { matchesExt, matchesAnyExt } from './fileExtensions';

// Stellaris hard limit: no body may exist beyond this orbit distance from the system center.
// Webview clamps first; these are defense-in-depth checks on the document-editing side.
const MAX_ORBIT_DISTANCE = 500;

function clampOrbitDistance(value: number): number {
    return Math.min(MAX_ORBIT_DISTANCE, Math.max(0, value));
}

// ── WebView message types ──────────────────────────────────────────────────────
type SolarPanelMessage =
    | { command: 'goToLine'; line: number }
    | { command: 'updateProperty'; line: number; property: string; value: string | number; valueType?: 'fixed' | 'range' | 'random' }
    | { command: 'updateOrbit'; line: number; orbitDistance: number; orbitAngle: number }
    | { command: 'movePlanetOrbit'; bodyLine: number; bodyEndLine: number; targetResolvedOrbit: number; targetOrbitAngle: number; isLockedOrbit?: boolean; isRingWorld?: boolean }
    | { command: 'addPlanet'; systemEndLine: number; planetClass: string; orbitDistance: number; orbitAngle: number; size: number }
    | { command: 'addStar'; systemLine: number; systemEndLine: number; firstBodyLine: number; planetClass: string; size: number }
    | { command: 'addMoon'; parentLine: number; parentEndLine: number; planetClass: string; size: number; orbitDistance: number; orbitAngle: number }
    | { command: 'addRingWorld'; systemEndLine: number; orbitDistance: number; segmentCount: number; segmentAngle: number; parentLine?: number; parentEndLine?: number }
    | { command: 'addSibling'; siblingLine: number; siblingEndLine: number; bodyType: string; planetClass: string; size: number; orbitAngle: number }
    | { command: 'deletePlanet'; line: number }
    | { command: 'vscodeUndo' }
    | { command: 'vscodeRedo' }
    | { command: 'saveDocument' };

export class SolarSystemPanel {
    public static currentPanel: SolarSystemPanel | undefined;
    private static readonly viewType = 'cwtools-solar-system-preview';
    private static _outputChannel: vscode.OutputChannel;
    private static _getLog(): vscode.OutputChannel {
        if (!SolarSystemPanel._outputChannel) {
            SolarSystemPanel._outputChannel = vscode.window.createOutputChannel('Solar System Debug');
        }
        return SolarSystemPanel._outputChannel;
    }
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _webviewRootPath: string;
    private _document: vscode.TextDocument | undefined;
    private _skipNextReload = false;
    private _contentSnapshots: string[] = [];
    private _redoSnapshots: string[] = [];
    private _lastSnapshotTime = 0;
    private static readonly MAX_SNAPSHOTS = 20;
    private _searchRoots: string[] = [];
    private _spriteIndexCache: Map<string, SpriteInfo> | null = null;
    private _celestialClassesCache: Array<{ name: string, color: string, isRingWorld: boolean, picture: string, icon: string, iconLarge: string }> | null = null;
    private _portraitsCache: Record<string, string[]> | null = null;
    private _planetIconsCache: Record<string, { uri: string, frame?: number, noOfFrames?: number }> | null = null;
    private _locCache: Record<string, string> | null = null;
    private _textureCache: Map<string, string> = new Map();
    private _textureCacheSize = 0;
    private static readonly MAX_CACHE_BYTES = 50 * 1024 * 1024;
    private _saveSnapshot(doc: vscode.TextDocument) {
        const now = Date.now();
        if (now - this._lastSnapshotTime < 500) return;
        this._lastSnapshotTime = now;
        this._contentSnapshots.push(doc.getText());
        this._redoSnapshots = [];
        if (this._contentSnapshots.length > SolarSystemPanel.MAX_SNAPSHOTS) {
            this._contentSnapshots.shift();
        }
    }
    private _messageQueue: Promise<void> = Promise.resolve();

    public static async create(extensionPath: string, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (SolarSystemPanel.currentPanel) SolarSystemPanel.currentPanel.dispose();

        const panel = new SolarSystemPanel(extensionPath, column || vscode.ViewColumn.Beside, document);
        SolarSystemPanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        this._document = document;

        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];

        this._panel = vscode.window.createWebviewPanel(
            SolarSystemPanel.viewType,
            `Solar System: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );

        // Setup FileSystemWatchers for caching
        const invalidateSpriteCache = (uri: vscode.Uri) => {
            if (!this._spriteIndexCache) return;
            const key = uri.fsPath.replace(/\\/g, '/').toLowerCase();
            if (matchesExt(key, '.gfx')) {
                this._spriteIndexCache = null;
            }
        };
        const gfxWatcher = vscode.workspace.createFileSystemWatcher('**/*.gfx');
        gfxWatcher.onDidChange(invalidateSpriteCache);
        gfxWatcher.onDidCreate(invalidateSpriteCache);
        gfxWatcher.onDidDelete(invalidateSpriteCache);
        this._disposables.push(gfxWatcher);

        const invalidateClassesCache = () => {
            this._celestialClassesCache = null;
            this._portraitsCache = null;
            this._planetIconsCache = null;
            this._textureCache.clear();
            this._textureCacheSize = 0;
        };
        const txtWatcher = vscode.workspace.createFileSystemWatcher('**/{planet_classes,star_classes}/**/*.txt');
        txtWatcher.onDidChange(invalidateClassesCache);
        txtWatcher.onDidCreate(invalidateClassesCache);
        txtWatcher.onDidDelete(invalidateClassesCache);
        this._disposables.push(txtWatcher);

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async (msg: SolarPanelMessage) => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'goToLine': {
                        const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'updateProperty':
                        this._messageQueue = this._messageQueue.then(() => this._handleUpdateProperty(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR updateProperty: ${e}`));
                        break;
                    case 'updateOrbit':
                        this._messageQueue = this._messageQueue.then(() => this._handleUpdateOrbits([msg])).catch(e => SolarSystemPanel._getLog().appendLine(`ERR updateOrbit: ${e}`));
                        break;
                    case 'movePlanetOrbit':
                        this._messageQueue = this._messageQueue.then(() => this._handleMovePlanetOrbit(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR movePlanetOrbit: ${e}`));
                        break;
                    case 'addPlanet':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddPlanet(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addPlanet: ${e}`));
                        break;
                    case 'addStar':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddStar(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addStar: ${e}`));
                        break;
                    case 'addMoon':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddMoon(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addMoon: ${e}`));
                        break;
                    case 'addRingWorld':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddRingWorld(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addRingWorld: ${e}`));
                        break;
                    case 'addSibling':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddSibling(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addSibling: ${e}`));
                        break;
                    case 'deletePlanet':
                        this._messageQueue = this._messageQueue.then(() => this._handleDeletePlanet(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR deletePlanet: ${e}`));
                        break;
                    case 'vscodeUndo':
                        await this._handleVscodeUndo();
                        break;
                    case 'vscodeRedo':
                        await this._handleVscodeRedo();
                        break;
                    case 'saveDocument':
                        if (this._document) await this._document.save();
                        break;
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
                    await this._loadAndRender(savedDoc);
                }
            }),
        );
    }

    private _getGamePath(): string | null {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
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

    private async _buildSpriteIndex(searchRoots: string[]): Promise<Map<string, SpriteInfo>> {
        const gfxContents: Array<{ path: string; content: string }> = [];
        const maxGfxFiles = 2000;

        for (const root of searchRoots) {
            if (gfxContents.length >= maxGfxFiles) break;
            const searchDirs = [
                path.join(root, 'interface'),
                path.join(root, 'gfx'),
            ];

            for (const dir of searchDirs) {
                if (gfxContents.length >= maxGfxFiles) break;
                try { await fs.promises.access(dir); } catch { continue; }
                await this._findGfxFiles(dir, gfxContents, maxGfxFiles);
            }
        }
        return buildSpriteIndex(gfxContents);
    }

    private async _findGfxFiles(dir: string, result: Array<{ path: string; content: string }>, maxFiles: number) {
        try {
            if (result.length >= maxFiles) return;
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this._findGfxFiles(full, result, maxFiles);
                } else if (matchesExt(entry.name, '.gfx')) {
                    try {
                        const content = await fs.promises.readFile(full, 'utf-8');
                        result.push({ path: full, content });
                    } catch { /* skip unreadable */ }
                }
            }));
        } catch { /* skip inaccessible dirs */ }
    }

    private async _collectCelestialClasses(searchRoots: string[]) {
        if (this._celestialClassesCache) return this._celestialClassesCache;
        const classes: Array<{ name: string, color: string, isRingWorld: boolean, picture: string, icon: string, iconLarge: string }> = [];

        for (const root of searchRoots) {
            for (const folder of ['planet_classes', 'star_classes']) {
                const dir = path.join(root, 'common', folder);
                try {
                    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                    await Promise.all(entries.map(async (entry) => {
                        if (!entry.isFile() || !matchesExt(entry.name, '.txt')) return;
                        try {
                            const content = await fs.promises.readFile(path.join(dir, entry.name), 'utf-8');
                            const rootRegex = /(?:^|\n)([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*\{/g;
                            let m;
                            while ((m = rootRegex.exec(content)) !== null) {
                                const name = m[1]!;
                                if (name === 'random_list') continue;

                                const startIdx = m.index + m[0].length;
                                let braces = 1;
                                let endIdx = startIdx;
                                while (braces > 0 && endIdx < content.length) {
                                    if (content[endIdx] === '{') braces++;
                                    else if (content[endIdx] === '}') braces--;
                                    endIdx++;
                                }
                                const block = content.substring(startIdx, endIdx - 1);

                                let hexColor = '';
                                const colorMatch = block.match(/(?:icon_color|color)\s*=\s*(?:hsv\s*)?\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/);
                                if (colorMatch) {
                                    const isHsv = block.match(/(?:icon_color|color)\s*=\s*hsv/);
                                    let r = 0, g = 0, b = 0;
                                    if (isHsv) {
                                        const h = parseFloat(colorMatch[1]!);
                                        const s = parseFloat(colorMatch[2]!);
                                        const v = parseFloat(colorMatch[3]!);
                                        const i = Math.floor(h * 6);
                                        const f = h * 6 - i;
                                        const p = v * (1 - s);
                                        const q = v * (1 - f * s);
                                        const t = v * (1 - (1 - f) * s);
                                        switch (i % 6) {
                                            case 0: r = v; g = t; b = p; break;
                                            case 1: r = q; g = v; b = p; break;
                                            case 2: r = p; g = v; b = t; break;
                                            case 3: r = p; g = q; b = v; break;
                                            case 4: r = t; g = p; b = v; break;
                                            case 5: r = v; g = p; b = q; break;
                                            default: r = v; g = v; b = v; break;
                                        }
                                        r *= 255; g *= 255; b *= 255;
                                    } else {
                                        r = parseFloat(colorMatch[1]!);
                                        g = parseFloat(colorMatch[2]!);
                                        b = parseFloat(colorMatch[3]!);
                                        if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
                                            r *= 255; g *= 255; b *= 255;
                                        }
                                    }
                                    const toHex = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
                                    hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
                                }

                                const isRingWorld = /ringworld\s*=\s*yes/.test(block);
                                const pictureMatch = block.match(/picture\s*=\s*"?([a-zA-Z0-9_]+)"?/);
                                const picture = pictureMatch ? pictureMatch[1]! : name;
                                const iconMatch = block.match(/icon\s*=\s*"?([a-zA-Z0-9_]+)"?/);
                                let icon = iconMatch ? iconMatch[1]! : '';
                                const iconLargeMatch = block.match(/icon_large\s*=\s*"?([a-zA-Z0-9_]+)"?/);
                                let iconLarge = iconLargeMatch ? iconLargeMatch[1]! : '';
                                if (!icon && folder === 'planet_classes') {
                                    icon = `GFX_planet_type_${picture}`;
                                }
                                if (!iconLarge && icon) {
                                    iconLarge = `${icon}_big`;
                                }
                                
                                classes.push({ name, color: hexColor, isRingWorld, picture, icon, iconLarge });
                            }
                        } catch {}
                    }));
                } catch {}
            }
        }
        
        const unique = new Map<string, typeof classes[0]>();
        for (const cls of classes) {
            if (!unique.has(cls.name)) unique.set(cls.name, cls);
        }
        this._celestialClassesCache = Array.from(unique.values());
        return this._celestialClassesCache;
    }

    private async _decodeTexture(filePath: string) {
        if (this._textureCache.has(filePath)) return this._textureCache.get(filePath)!;
        const ext = path.extname(filePath).toLowerCase();
        let result: import('./ddsDecoder').DdsResult | null = null;
        if (ext === '.dds') result = decodeDds(filePath);
        else if (ext === '.tga') result = decodeTga(filePath);
        else if (ext === '.png') {
            const buffer = await fs.promises.readFile(filePath);
            result = { width: 0, height: 0, dataUri: `data:image/png;base64,${buffer.toString('base64')}` };
        }

        if (result && result.dataUri) {
            const entrySize = result.dataUri.length;
            while (this._textureCacheSize + entrySize > SolarSystemPanel.MAX_CACHE_BYTES && this._textureCache.size > 0) {
                const oldestKey = this._textureCache.keys().next().value;
                if (oldestKey) {
                    const old = this._textureCache.get(oldestKey);
                    this._textureCacheSize -= old?.length ?? 0;
                    this._textureCache.delete(oldestKey);
                }
            }
            this._textureCache.set(filePath, result.dataUri);
            this._textureCacheSize += entrySize;
            return result.dataUri;
        }
        return null;
    }

    private async _resolveEnvironmentPortraits(searchRoots: string[], classes: Array<{ picture: string }>) {
        if (this._portraitsCache) return this._portraitsCache;
        const portraits: Record<string, string[]> = {};
        const picNames = new Set(classes.map(c => c.picture));
        
        for (const pic of picNames) {
            let foundLayers = false;
            const layerGroups: Record<string, string[]> = {};
            
            for (const root of searchRoots) {
                const envDir = path.join(root, 'gfx', 'portraits', 'environments');
                try {
                    const entries = await fs.promises.readdir(envDir, { withFileTypes: true });
                    for (const e of entries) {
                        if (e.isFile() && e.name.toLowerCase().startsWith(pic.toLowerCase() + '_') && matchesAnyExt(e.name, ['.dds', '.png', '.tga'])) {
                            const match = e.name.substring(pic.length + 1).match(/^(sky|l0[0-9])/i);
                            if (match) {
                                const group = match[1]!.toLowerCase();
                                if (!layerGroups[group]) layerGroups[group] = [];
                                layerGroups[group]!.push(path.join(envDir, e.name));
                                foundLayers = true;
                            }
                        }
                    }
                } catch {}
                if (foundLayers) break;
            }
            
            if (foundLayers) {
                const groups = Object.keys(layerGroups).sort();
                const uris: string[] = [];
                for (const g of groups) {
                    const paths = layerGroups[g]!;
                    const chosen = paths[Math.floor(Math.random() * paths.length)]!;
                    const uri = await this._decodeTexture(chosen);
                    if (uri) uris.push(uri);
                }
                if (uris.length > 0) portraits[pic] = uris;
            }
        }
        this._portraitsCache = portraits;
        return portraits;
    }

    private async _resolvePlanetIcons(searchRoots: string[], classes: Array<{ icon: string, iconLarge?: string }>) {
        if (this._planetIconsCache) return this._planetIconsCache;
        const planetIcons: Record<string, { uri: string, frame?: number, noOfFrames?: number }> = {};
        
        if (!this._spriteIndexCache) {
            this._spriteIndexCache = await this._buildSpriteIndex(searchRoots);
        }
        const spriteIndex = this._spriteIndexCache;

        const iconNames = new Set<string>();
        for (const cls of classes) {
            if (cls.icon) iconNames.add(cls.icon);
            if (cls.iconLarge) iconNames.add(cls.iconLarge);
        }

        for (const icon of iconNames) {
            const spriteInfo = spriteIndex.get(icon);
            if (!spriteInfo) continue;

            let actualSprite = spriteInfo;
            if (spriteInfo.sprite_sheet_sprite_type) {
                const sheet = spriteIndex.get(spriteInfo.sprite_sheet_sprite_type);
                if (sheet) actualSprite = sheet;
            }

            if (!actualSprite.texturefile) continue;

            const relPath = actualSprite.texturefile.replace(/\//g, path.sep);
            for (const root of searchRoots) {
                const fullDds = path.join(root, relPath);
                const fullPng = fullDds.replace(/\.dds$/i, '.png');
                let targetFile = '';
                if (fs.existsSync(fullPng)) targetFile = fullPng;
                else if (fs.existsSync(fullDds)) targetFile = fullDds;
                
                if (targetFile) {
                    const uri = await this._decodeTexture(targetFile);
                    if (uri) {
                        planetIcons[icon] = {
                            uri,
                            frame: spriteInfo.default_frame,
                            noOfFrames: actualSprite.noOfFrames
                        };
                    }
                    break;
                }
            }
        }
        this._planetIconsCache = planetIcons;
        return planetIcons;
    }

    private async _loadAndRender(document: vscode.TextDocument) {
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);
        const searchRoots: string[] = [];
        if (modRoot) searchRoots.push(modRoot);
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            if (!searchRoots.includes(wf.uri.fsPath)) searchRoots.push(wf.uri.fsPath);
        }
        const gamePath = this._getGamePath();
        if (gamePath && !searchRoots.includes(gamePath)) searchRoots.push(gamePath);

        const celestialClasses = await this._collectCelestialClasses(searchRoots);
        const ringWorlds = new Set(celestialClasses.filter(c => c.isRingWorld).map(c => c.name));

        const content = document.getText();
        const systems = parseSolarSystemFile(content, ringWorlds);

        const portraits = await this._resolveEnvironmentPortraits(searchRoots, celestialClasses);
        const planetIcons = await this._resolvePlanetIcons(searchRoots, celestialClasses);

        const fullLocDict = await this._getLocDict(searchRoots);
        const neededLoc: Record<string, string> = {};
        const addLoc = (key: string | undefined) => {
            if (key && fullLocDict[key]) neededLoc[key] = fullLocDict[key]!;
        };
        for (const cls of celestialClasses) {
            addLoc(cls.name);
        }
        for (const sys of systems) {
            addLoc(sys.displayName);
            addLoc(sys.key);
            addLoc(sys.starClass);
            const collectKeys = (bodies: CelestialBody[]) => {
                for (const b of bodies) {
                    addLoc(b.name);
                    addLoc(b.planetClass);
                    collectKeys(b.moons);
                    collectKeys(b.subPlanets);
                }
            };
            collectKeys(sys.bodies);
        }

        this._panel.webview.postMessage({
            command: 'render',
            data: systems,
            fileName: path.basename(document.fileName),
            dynamicClasses: celestialClasses,
            portraits,
            planetIcons,
            locDict: neededLoc
        });
    }

    private async _getLocDict(searchRoots: string[]) {
        if (this._locCache) return this._locCache;
        
        const locMap: Record<string, string> = {};
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const locLangs = config.get<string[]>('localisation.languages') || ['English'];
        let targetLangs = locLangs.map(l => l.toLowerCase());
        if (targetLangs.length >= 2 && targetLangs.includes('chinese')) {
            targetLangs = ['simp_chinese', 'chinese'];
        } else {
            targetLangs = targetLangs.map(l => l === 'english' ? 'english' : l === 'chinese' ? 'simp_chinese' : l);
        }

        const linePattern = /^\s*([a-zA-Z0-9_.:-]+)\s*:\d*\s*"(.*)"\s*$/;

        const scanDir = async (dirPath: string) => {
            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                for (const e of entries) {
                    if (e.isDirectory()) {
                        await scanDir(path.join(dirPath, e.name));
                    } else if (e.isFile() && matchesExt(e.name, '.yml')) {
                        const isTarget = targetLangs.some(lang => e.name.toLowerCase().includes(`l_${lang}.yml`));
                        if (isTarget) {
                            try {
                                const content = await fs.promises.readFile(path.join(dirPath, e.name), 'utf-8');
                                for (const line of content.split('\n')) {
                                    const m = linePattern.exec(line);
                                    if (m) {
                                        locMap[m[1]!] = m[2]!.replace(/§[RGBYWHETLMSPr!]/g, '');
                                    }
                                }
                            } catch { }
                        }
                    }
                }
            } catch { }
        };

        for (const root of searchRoots) {
            for (const locDir of ['localisation', 'localisation_synced', 'localization']) {
                await scanDir(path.join(root, locDir));
            }
        }
        
        // Resolve $key$ interpolations in localization values
        const resolveInterpolation = (text: string, visited: Set<string>): string => {
            if (!text.includes('$')) return text;
            return text.replace(/\$([a-zA-Z0-9_.:-]+)\$/g, (match, key) => {
                if (visited.has(key)) return match; // prevent infinite loops
                const val = locMap[key];
                if (!val) return match; // if not found, leave it as is
                visited.add(key);
                const resolved = resolveInterpolation(val, visited);
                visited.delete(key);
                return resolved;
            });
        };

        for (const key of Object.keys(locMap)) {
            locMap[key] = resolveInterpolation(locMap[key]!, new Set([key]));
        }

        this._locCache = locMap;
        return locMap;
    }

    public dispose() {
        SolarSystemPanel.currentPanel = undefined;
        this._document = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ── Property editing ────────────────────────────────────────────────────

    /**
     * Format a property value as PDX script text.
     */
    private _formatValue(property: string, value: unknown, valueType?: string): string {
        if (valueType === 'range' && typeof value === 'object' && value !== null) {
            const rangeVal = value as { min: number; max: number };
            return `{ min = ${rangeVal.min} max = ${rangeVal.max} }`;
        }
        if (valueType === 'random') return 'random';
        if (typeof value === 'number') {
            return Number.isInteger(value) ? String(value) : value.toFixed(1);
        }
        if (typeof value === 'string') {
            if (/\s/.test(value) || value.length === 0) return `"${value}"`;
            return value;
        }
        return String(value);
    }

    /**
     * Handle updateProperty from webview.
     * Supports inline (single-line) and multiline property formats.
     */
    private async _handleUpdateProperty(msg: {
        line: number;
        property: string;
        value: unknown;
        valueType?: 'fixed' | 'range' | 'random';
    }) {
        if (!this._document) return;
        const doc = this._document;

        // Save snapshot for undo
        const now = Date.now();
        if (now - this._lastSnapshotTime > 500) {
            this._saveSnapshot(doc);
            this._lastSnapshotTime = now;
        }

        const property = msg.property;
        // Defense in depth: orbit_distance may not exceed the Stellaris system radius limit
        if (property === 'orbit_distance') {
            if (typeof msg.value === 'number') {
                msg.value = Math.min(MAX_ORBIT_DISTANCE, msg.value);
            } else if (msg.value && typeof msg.value === 'object') {
                const range = msg.value as { min?: number; max?: number };
                if (typeof range.min === 'number') range.min = Math.min(MAX_ORBIT_DISTANCE, range.min);
                if (typeof range.max === 'number') range.max = Math.min(MAX_ORBIT_DISTANCE, range.max);
            }
        }
        const newValueStr = this._formatValue(property, msg.value, msg.valueType);

        // Search for the property starting from the given line
        // Support both:
        // 1. Standalone line: `\t\torbit_distance = 80`
        // 2. Inline: `planet = { class = pc_xx orbit_distance = 80 size = 10 }`
        let found = false;
        for (let i = msg.line - 1; i < Math.min(msg.line + 30, doc.lineCount); i++) {
            const lineText = doc.lineAt(i).text;

            // Build a regex to match `property = <value>` within the line
            // <value> can be: a number, a word, "quoted string", random, or { ... }
            const propPattern = new RegExp(
                `(${property}\\s*=\\s*)` +       // group 1: key = 
                `(\\{[^}]*\\}|"[^"]*"|\\S+)`,    // group 2: value (block, quoted, or word)
            );
            const match = propPattern.exec(lineText);
            if (match) {
                 
                const startCol = match.index + match[1]!.length;
                 
                const endCol = startCol + match[2]!.length;
                const range = new vscode.Range(
                    new vscode.Position(i, startCol),
                    new vscode.Position(i, endCol),
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, range, newValueStr);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                found = true;
                break;
            }

            // Also check for multi-line block e.g.:
            // orbit_angle = {
            //     min = 90 max = 270
            // }
            const multiLineKeyPattern = new RegExp(`(${property}\\s*=\\s*)\\{\\s*$`);
            const multiMatch = multiLineKeyPattern.exec(lineText);
            if (multiMatch) {
                // Find the closing brace
                let endLineIdx = i;
                for (let j = i + 1; j < doc.lineCount; j++) {
                    if (doc.lineAt(j).text.includes('}')) {
                        endLineIdx = j;
                        break;
                    }
                }
                 
                const startCol = multiMatch.index + multiMatch[1]!.length;
                const endLine = doc.lineAt(endLineIdx);
                const closeBraceCol = endLine.text.indexOf('}') + 1;
                const range = new vscode.Range(
                    new vscode.Position(i, startCol),
                    new vscode.Position(endLineIdx, closeBraceCol),
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, range, newValueStr);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                found = true;
                break;
            }

            // Stop at closing brace (only if it's a standalone closing brace)
            if (lineText.trim() === '}' && i > msg.line - 1) break;
        }

        if (!found) {
            // Property not found — insert inline or as new line
            const targetLine = doc.lineAt(msg.line - 1);
            const lineText = targetLine.text;

            // If the element is inline (single line with { ... })
            // Insert the property before the closing brace
            const lastBrace = lineText.lastIndexOf('}');
            if (lastBrace > 0 && lineText.includes('{')) {
                const insertPos = new vscode.Position(msg.line - 1, lastBrace);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, insertPos, `${property} = ${newValueStr} `);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
            } else {
                // Multi-line block: insert on next line
                const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
                const childIndent = indent + '\t';
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, new vscode.Position(msg.line - 1, lineText.length),
                    '\n' + childIndent + `${property} = ${newValueStr}`);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
            }
        }

        // Re-render
        await this._loadAndRender(doc);
        if (found) {
            await doc.save();
        }
    }

    /**
     * Handle adding a new planet to the system.
     * msg: { command, systemEndLine, orbitDistance, orbitAngle, planetClass, size }
     */
    private async _handleAddPlanet(msg: {
        systemEndLine: number;
        orbitDistance: number;
        orbitAngle: number;
        planetClass: string;
        size: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        // Save snapshot
        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        // Insert before the system's closing brace
        const insertLineIdx = msg.systemEndLine - 1; // 1-indexed to 0-indexed
        const closingLine = doc.lineAt(insertLineIdx);
        const indent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const planetIndent = indent + '\t';

        const planetCode = `${planetIndent}planet = { class = ${msg.planetClass} orbit_distance = ${clampOrbitDistance(msg.orbitDistance)} orbit_angle = ${msg.orbitAngle} size = ${msg.size} }\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), planetCode);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    /**
     * Handle adding a star (first body with orbit_distance = 0).
     */
    private async _handleAddStar(msg: {
        systemLine: number;
        systemEndLine: number;
        firstBodyLine: number; // 0 if no bodies exist
        planetClass: string;
        size: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        // Insert before the first body, or before system closing brace
        const insertLineIdx = msg.firstBodyLine > 0 ? msg.firstBodyLine - 1 : msg.systemEndLine - 1;
        const refLine = doc.lineAt(insertLineIdx);
        const indent = refLine.text.match(/^(\s*)/)?.[1] ?? '';
        const starIndent = msg.firstBodyLine > 0 ? indent : indent + '\t';

        const starCode = `${starIndent}planet = { class = ${msg.planetClass} orbit_distance = 0 size = ${msg.size} }\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), starCode);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    /**
     * Handle adding a moon inside a parent planet block.
     */
    private async _handleAddMoon(msg: {
        parentLine: number;
        parentEndLine: number;
        planetClass: string;
        size: number;
        orbitDistance: number;
        orbitAngle: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        const edit = new vscode.WorkspaceEdit();

        if (msg.parentLine === msg.parentEndLine) {
            // Single-line parent: expand it and add moon
            const lineIdx = msg.parentLine - 1;
            const lineText = doc.lineAt(lineIdx).text;
            const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
            const moonIndent = indent + '\t';

            // Remove trailing } and expand to multi-line with proper indentation
            const openBrace = lineText.indexOf('{');
            const lastBrace = lineText.lastIndexOf('}');
            if (openBrace >= 0 && lastBrace > openBrace) {
                const prefix = lineText.substring(0, openBrace + 1); // e.g. "\tmoon = {"
                const innerContent = lineText.substring(openBrace + 1, lastBrace).trim(); // properties
                const moonLine = `${moonIndent}moon = { class = ${msg.planetClass} orbit_distance = ${msg.orbitDistance} orbit_angle = ${msg.orbitAngle} size = ${msg.size} }`;
                const newContent = `${prefix}\n${moonIndent}${innerContent}\n${moonLine}\n${indent}}`;
                edit.replace(doc.uri, new vscode.Range(lineIdx, 0, lineIdx, lineText.length), newContent);
            }
        } else {
            // Multi-line parent: insert before closing brace
            const insertLineIdx = msg.parentEndLine - 1;
            const closingLine = doc.lineAt(insertLineIdx);
            const indent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
            const moonIndent = indent + '\t';
            const moonCode = `${moonIndent}moon = { class = ${msg.planetClass} orbit_distance = ${msg.orbitDistance} orbit_angle = ${msg.orbitAngle} size = ${msg.size} }\n`;
            edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), moonCode);
        }

        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }
    /**
     * Handle adding a sibling body at the same orbit as the clicked body.
     * Inserts the new body right after the sibling with orbit_distance = 0.
     */
    private async _handleAddSibling(msg: {
        siblingLine: number;
        siblingEndLine: number;
        bodyType: string;
        planetClass: string;
        size: number;
        orbitAngle: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        const edit = new vscode.WorkspaceEdit();

        // Determine the keyword based on body type
        const keyword = msg.bodyType === 'moon' ? 'moon' : 'planet';

        // Find the indentation of the sibling line
        const sibLineIdx = msg.siblingLine - 1;
        const sibLineText = doc.lineAt(sibLineIdx).text;
        const indent = sibLineText.match(/^(\s*)/)?.[1] ?? '';

        // Insert right after the sibling's end line
        const insertLineIdx = msg.siblingEndLine; // 0-based: line AFTER the sibling end
        const newBody = `${indent}${keyword} = { class = ${msg.planetClass} orbit_distance = 0 orbit_angle = ${msg.orbitAngle} size = ${msg.size} }\n`;
        edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), newBody);

        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    /**
     * Handle adding a complete ring world (change_orbit + ring segments).
     */
    private async _handleAddRingWorld(msg: {
        systemEndLine: number;
        orbitDistance: number;
        segmentCount: number;
        segmentAngle: number;
        parentLine?: number;
        parentEndLine?: number;
    }) {
        if (!this._document) return;
        const doc = this._document;
        const log = SolarSystemPanel._getLog();

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        // Build segment classes: habitable, seam, tech (repeating)
        const segClasses = [];
        const pattern = ['pc_ringworld_habitable', 'pc_ringworld_seam', 'pc_ringworld_tech'];
        for (let i = 0; i < msg.segmentCount; i++) {
            segClasses.push(pattern[i % pattern.length]);
        }

        const edit = new vscode.WorkspaceEdit();

        if (msg.parentLine && msg.parentEndLine) {
            // Nested inside a planet block as moons
            // Inside a planet, cumulative orbit starts from 0. change_orbit is just the orbit distance.
            const changeOrbitValue = msg.orbitDistance;
            log.appendLine(`  RING CREATE (moon): parent L${msg.parentLine}-${msg.parentEndLine} change_orbit=${changeOrbitValue}`);

            if (msg.parentLine === msg.parentEndLine) {
                // Single-line parent star: expand it
                const lineIdx = msg.parentLine - 1;
                const lineText = doc.lineAt(lineIdx).text;
                const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
                const pi = indent + '\t';

                const openBrace = lineText.indexOf('{');
                const lastBrace = lineText.lastIndexOf('}');
                if (openBrace >= 0 && lastBrace > openBrace) {
                    const prefix = lineText.substring(0, openBrace + 1);
                    const innerContent = lineText.substring(openBrace + 1, lastBrace).trim();
                    let inner = `\n${pi}${innerContent}\n${pi}change_orbit = ${changeOrbitValue}`;
                    for (const cls of segClasses) {
                        inner += `\n${pi}moon = { class = ${cls} orbit_angle = ${msg.segmentAngle} orbit_distance = 0 }`;
                    }
                    const newContent = `${prefix}${inner}\n${indent}}`;
                    edit.replace(doc.uri, new vscode.Range(lineIdx, 0, lineIdx, lineText.length), newContent);
                }
            } else {
                // Multi-line parent: insert before closing brace
                const insertLineIdx = msg.parentEndLine - 1;
                const closingLine = doc.lineAt(insertLineIdx);
                const indent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
                const pi = indent + '\t';

                let code = `${pi}change_orbit = ${changeOrbitValue}\n`;
                for (const cls of segClasses) {
                    code += `${pi}moon = { class = ${cls} orbit_angle = ${msg.segmentAngle} orbit_distance = 0 }\n`;
                }
                edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), code);
            }
        } else {
            // System-level ring world (legacy path)
            const content = doc.getText();
            const systems = parseSolarSystemFile(content);
            let cumulativeOrbit = 0;
            for (const sys of systems) {
                if (sys.endLine === msg.systemEndLine) {
                    for (const b of sys.bodies) {
                        const bodyEndOrbit = b.resolvedOrbitRadius;
                        if (bodyEndOrbit > cumulativeOrbit) {
                            cumulativeOrbit = bodyEndOrbit;
                        }
                    }
                    break;
                }
            }
            const changeOrbitValue = msg.orbitDistance - cumulativeOrbit;
            log.appendLine(`  RING CREATE (system): cumOrbit=${cumulativeOrbit} change_orbit=${changeOrbitValue}`);

            const insertLineIdx = msg.systemEndLine - 1;
            const closingLine = doc.lineAt(insertLineIdx);
            const indent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
            const pi = indent + '\t';

            let code = `${pi}change_orbit = ${changeOrbitValue}\n`;
            for (const cls of segClasses) {
                code += `${pi}planet = { class = ${cls} orbit_angle = ${msg.segmentAngle} orbit_distance = 0 }\n`;
            }
            edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), code);
        }

        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    /**
     * Handle batch orbit update (distance + angle in a single edit).
     */
    private async _handleUpdateOrbits(updates: Array<{
        line: number;
        orbitDistance?: number;
        orbitAngle?: number;
    }>) {
        if (!this._document) return;
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        const edit = new vscode.WorkspaceEdit();
        let anyFound = false;

        for (const update of updates) {
            let foundDist = false, foundAngle = false;
            const distStr = update.orbitDistance !== undefined ? this._formatValue('orbit_distance', update.orbitDistance, 'fixed') : null;
            const angleStr = update.orbitAngle !== undefined ? this._formatValue('orbit_angle', update.orbitAngle, 'fixed') : null;

            for (let i = update.line - 1; i < Math.min(update.line + 30, doc.lineCount); i++) {
                const lineText = doc.lineAt(i).text;

                if (!foundDist && distStr !== null) {
                    const distPattern = /(orbit_distance\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/;
                    const m = distPattern.exec(lineText);
                    if (m) {
                         
                        const startCol = m.index + m[1]!.length;
                         
                        edit.replace(doc.uri, new vscode.Range(i, startCol, i, startCol + m[2]!.length), distStr);
                        foundDist = true;
                        anyFound = true;
                    }
                }
                if (!foundAngle && angleStr !== null) {
                    const anglePattern = /(orbit_angle\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/;
                    const m = anglePattern.exec(lineText);
                    if (m) {
                         
                        const startCol = m.index + m[1]!.length;
                         
                        edit.replace(doc.uri, new vscode.Range(i, startCol, i, startCol + m[2]!.length), angleStr);
                        foundAngle = true;
                        anyFound = true;
                    }
                }

                if ((distStr === null || foundDist) && (angleStr === null || foundAngle)) break;
                if (lineText.trim() === '}' && i > update.line - 1) break;
            }
        }

        if (anyFound) {
            this._skipNextReload = true;
            await vscode.workspace.applyEdit(edit);
        }
        await this._loadAndRender(doc);
        if (anyFound) {
            await doc.save();
        }
    }

    /**
     * Update only the orbit_angle of a body (used for orbit_distance=0 same-orbit siblings).
     */
    private async _handleUpdateOrbitAngleOnly(msg: {
        line: number;
        orbitAngle: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        const angleStr = this._formatValue('orbit_angle', msg.orbitAngle, 'fixed');
        const edit = new vscode.WorkspaceEdit();
        let found = false;

        for (let i = msg.line - 1; i < Math.min(msg.line + 30, doc.lineCount); i++) {
            const lineText = doc.lineAt(i).text;
            if (!found) {
                const anglePattern = /(orbit_angle\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/;
                const m = anglePattern.exec(lineText);
                if (m) {
                     
                    const startCol = m.index + m[1]!.length;
                     
                    edit.replace(doc.uri, new vscode.Range(i, startCol, i, startCol + m[2]!.length), angleStr);
                    found = true;
                }
            }
            if (found) break;
            if (lineText.trim() === '}' && i > msg.line - 1) break;
        }

        if (found) {
            this._skipNextReload = true;
            await vscode.workspace.applyEdit(edit);
        }
        await this._loadAndRender(doc);
        if (found) {
            await doc.save();
        }
    }

    /**
     * Handle deleting a planet/body from the system.
     */
    private async _handleDeletePlanet(msg: { line: number }) {
        if (!this._document) return;
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        const startLineIdx = msg.line - 1;
        const lineText = doc.lineAt(startLineIdx).text;

        let endLineIdx = startLineIdx;

        // Check if it's an inline definition (has both { and } on the same line)
        if (lineText.includes('{') && lineText.includes('}')) {
            endLineIdx = startLineIdx;
        } else if (lineText.includes('{')) {
            // Multi-line block: find the matching closing brace
            let depth = 0;
            for (let i = startLineIdx; i < doc.lineCount; i++) {
                const lt = doc.lineAt(i).text;
                for (const ch of lt) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (depth <= 0) {
                    endLineIdx = i;
                    break;
                }
            }
        }

        // Delete from start of startLine to start of endLine+1 (removes entire lines)
        const deleteEnd = endLineIdx + 1 < doc.lineCount
            ? new vscode.Position(endLineIdx + 1, 0)
            : doc.lineAt(endLineIdx).range.end;
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(new vscode.Position(startLineIdx, 0), deleteEnd));
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    /**
     * Handle moving a planet to a new orbit, potentially reordering code blocks.
     * Stellaris orbit_distance is cumulative: each planet's resolved orbit =
     * cumulative_from_previous_bodies + own orbit_distance.
     * Inter-body change_orbit blocks also affect the cumulative chain.
     */
    private async _handleMovePlanetOrbit(msg: {
        bodyLine: number;
        bodyEndLine: number;
        targetResolvedOrbit: number;
        targetOrbitAngle: number;
        isRingWorld?: boolean;
        ringChangeOrbitLine?: number;
        ringOldOrbitRadius?: number;
        ringFirstLine?: number;
        ringLastEndLine?: number;
        ringTargetSegCount?: number;
        ringNewAngle?: number;
        ringOrigSegCount?: number;
        isLockedOrbit?: boolean;
    }) {
        const log = SolarSystemPanel._getLog();
        // Defense in depth: keep the absolute orbit within the Stellaris system radius limit
        msg.targetResolvedOrbit = Math.min(MAX_ORBIT_DISTANCE, msg.targetResolvedOrbit);
        log.appendLine(`--- movePlanetOrbit msg: bodyLine=${msg.bodyLine} endLine=${msg.bodyEndLine} targetOrbit=${msg.targetResolvedOrbit} angle=${msg.targetOrbitAngle} isRing=${msg.isRingWorld}`);

        if (!this._document) { log.appendLine('  ABORT: no document'); return; }
        const doc = this._document;

        this._saveSnapshot(doc);
        this._lastSnapshotTime = Date.now();

        // ── Locked orbit (orbit_distance=0): only update angle ──────────────
        if (msg.isLockedOrbit) {
            log.appendLine(`  LOCKED ORBIT: only updating angle to ${msg.targetOrbitAngle}`);
            await this._handleUpdateOrbitAngleOnly({
                line: msg.bodyLine,
                orbitAngle: Math.round(msg.targetOrbitAngle),
            });
            return;
        }

        // ── Ring world move: modify the change_orbit before the ring ─────────
        if (msg.isRingWorld && msg.ringChangeOrbitLine && msg.ringChangeOrbitLine > 0) {
            const content = doc.getText();
            const lines = content.split(/\r?\n/);
            const changeOrbitIdx = msg.ringChangeOrbitLine - 1;
             
            const oldLine = lines[changeOrbitIdx]!;
            log.appendLine(`  RING: changeOrbitLine=${msg.ringChangeOrbitLine} oldLine="${oldLine}"`);

            // Compute the delta
            const systems = parseSolarSystemFile(content);
            let ringGroup: any = null;
            const searchRingGroup = (bodies: CelestialBody[]) => {
                for (const b of bodies) {
                    if (b.ringGroup && b.line === msg.bodyLine) {
                        ringGroup = b.ringGroup;
                        return;
                    }
                    searchRingGroup(b.moons);
                    if (ringGroup) return;
                    searchRingGroup(b.subPlanets);
                    if (ringGroup) return;
                }
            };
            for (const s of systems) {
                searchRingGroup(s.bodies);
                if (ringGroup) break;
            }
            const oldRadius = ringGroup?.orbitRadius ?? msg.ringOldOrbitRadius ?? 0;
            const delta = msg.targetResolvedOrbit - oldRadius;

            // Parse old change_orbit value and compute new
            const match = oldLine.match(/change_orbit\s*=\s*(-?\d+)/);
            if (match) {
                 
                const oldValue = parseInt(match[1]!);
                const newValue = oldValue + Math.round(delta);
                const newLine = oldLine.replace(/change_orbit\s*=\s*-?\d+/, `change_orbit = ${newValue}`);
                lines[changeOrbitIdx] = newLine;
                log.appendLine(`  RING: oldValue=${oldValue} delta=${Math.round(delta)} newValue=${newValue}`);

                // ── Ring expansion: update orbit_angles and add new segments ──
                const origSegCount = msg.ringOrigSegCount ?? ringGroup?.segments?.length ?? 0;
                const targetSegCount = msg.ringTargetSegCount ?? origSegCount;
                const newAngle = msg.ringNewAngle ?? (origSegCount > 0 ? 360 / origSegCount : 30);

                log.appendLine(`  RING EXPAND: origSegs=${origSegCount} targetSegs=${targetSegCount} newAngle=${newAngle}`);

                if (targetSegCount > origSegCount && ringGroup?.segments) {
                    // 1. Update all existing segments' orbit_angle
                    //    Must search all lines within each segment's block (multi-line planets)
                    for (const seg of ringGroup.segments) {
                        for (let li = seg.line - 1; li < seg.endLine && li < lines.length; li++) {
                             
                            if (/orbit_angle\s*=/.test(lines[li]!)) {
                                 
                                lines[li] = lines[li]!.replace(
                                    /orbit_angle\s*=\s*\S+/,
                                    `orbit_angle = ${newAngle}`,
                                );
                                break;
                            }
                        }
                    }

                    // 2. Determine indentation from last segment
                    const lastSeg = ringGroup.segments[ringGroup.segments.length - 1];
                    const lastSegLine = lines[lastSeg.endLine - 1] || '';
                    const indent = lastSegLine.match(/^(\s*)/)?.[1] ?? '\t';

                    // 3. Build new segment lines (cycle: seam, tech, habitable)
                    const newSegsToAdd = targetSegCount - origSegCount;
                    const newSegLines: string[] = [];
                    const expandPattern = ['pc_ringworld_seam', 'pc_ringworld_tech', 'pc_ringworld_habitable'];
                    // Determine keyword: if ring is nested inside a planet (moon syntax)
                    const ringLine = lines[ringGroup.segments[0].line - 1] || '';
                    const useMoon = /^\s*moon\s*=/.test(ringLine);
                    const keyword = useMoon ? 'moon' : 'planet';
                    for (let i = 0; i < newSegsToAdd; i++) {
                        const cls = expandPattern[i % expandPattern.length];
                        newSegLines.push(`${indent}${keyword} = { class = ${cls} orbit_angle = ${newAngle} orbit_distance = 0 }`);
                    }

                    // 4. Insert after the last existing ring segment
                    const insertAt = lastSeg.endLine; // 1-indexed endLine → insert at this 0-indexed position
                    lines.splice(insertAt, 0, ...newSegLines);

                    log.appendLine(`  RING EXPAND: added ${newSegsToAdd} seam segments after line ${lastSeg.endLine}`);
                } else if (targetSegCount < origSegCount && ringGroup?.segments) {
                    // SHRINK: remove excess segments from the end and update orbit_angles
                    const segsToRemove = origSegCount - targetSegCount;
                    log.appendLine(`  RING SHRINK: removing ${segsToRemove} segments from end`);

                    // 1. Update all remaining segments' orbit_angle
                    for (let si = 0; si < targetSegCount; si++) {
                        const seg = ringGroup.segments[si];
                        for (let li = seg.line - 1; li < seg.endLine && li < lines.length; li++) {
                             
                            if (/orbit_angle\s*=/.test(lines[li]!)) {
                                 
                                lines[li] = lines[li]!.replace(
                                    /orbit_angle\s*=\s*\S+/,
                                    `orbit_angle = ${newAngle}`,
                                );
                                break;
                            }
                        }
                    }

                    // 2. Remove segments from end (reverse order to preserve line numbers)
                    for (let si = origSegCount - 1; si >= targetSegCount; si--) {
                        const seg = ringGroup.segments[si];
                        const startIdx = seg.line - 1;
                        const endIdx = seg.endLine - 1;
                        lines.splice(startIdx, endIdx - startIdx + 1);
                        log.appendLine(`  RING SHRINK: removed segment at lines ${seg.line}-${seg.endLine}`);
                    }
                }

                const newContent = lines.join('\n');
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    doc.lineAt(doc.lineCount - 1).range.end,
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, fullRange, newContent);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await this._loadAndRender(doc);
                await doc.save();
            } else {
                log.appendLine(`  RING: could not parse change_orbit line`);
            }
            return;
        }

        const content = doc.getText();
        const systems = parseSolarSystemFile(content);
        log.appendLine(`  parsed ${systems.length} systems`);

        // Find the system and body (search recursively through all nesting levels)
        let system: SolarSystem | undefined;
        let movedBody: CelestialBody | undefined;
        let isMoon = false;
        const searchBody = (bodies: CelestialBody[], asMoon: boolean) => {
            for (const b of bodies) {
                if (b.line === msg.bodyLine) { movedBody = b; isMoon = asMoon; return; }
                searchBody(b.moons, true);
                if (movedBody) return;
                searchBody(b.subPlanets, asMoon);
                if (movedBody) return;
            }
        };
        for (const s of systems) {
            searchBody(s.bodies, false);
            if (movedBody) { system = s; break; }
        }

        if (!system || !movedBody) {
            log.appendLine(`  FALLBACK: system=${!!system} movedBody=${!!movedBody} isMoon=${isMoon}`);
            // Log all body lines for debugging
            for (const s of systems) {
                log.appendLine(`  system "${s.key}" bodies: ${s.bodies.map(b => `L${b.line}(${b.bodyType})`).join(', ')}`);
                for (const b of s.bodies) {
                    if (b.moons.length) log.appendLine(`    moons of L${b.line}: ${b.moons.map(m => `L${m.line}`).join(', ')}`);
                }
            }
            await this._handleUpdateOrbits([{
                line: msg.bodyLine,
                orbitDistance: Math.round(msg.targetResolvedOrbit),
                orbitAngle: Math.round(msg.targetOrbitAngle),
            }]);
            return;
        }

        // For moons: compute correct cumulative and update in-place
        if (isMoon) {
            const rawDist = resolveValue(movedBody.orbitDistance);
            const cumAtPos = movedBody.resolvedOrbitRadius - rawDist;
            const newDist = Math.max(0, Math.round(msg.targetResolvedOrbit - cumAtPos));
            log.appendLine(`  MOON: rawDist=${rawDist} cum=${cumAtPos} newDist=${newDist}`);
            await this._handleUpdateOrbits([{
                line: msg.bodyLine,
                orbitDistance: newDist,
                orbitAngle: Math.round(msg.targetOrbitAngle),
            }]);
            return;
        }

        // For planets: compute cumulative correctly
        const planets = system.bodies.filter(b => b.bodyType !== 'star');
        const currentIdx = planets.indexOf(movedBody);
        if (currentIdx < 0) { log.appendLine(`  ABORT: currentIdx < 0`); return; }

        // True cumulative at this body's position = resolvedOrbit - rawOrbitDistance
        const rawDist = resolveValue(movedBody.orbitDistance);
        const cumAtCurrentPos = movedBody.resolvedOrbitRadius - rawDist;
        const inPlaceNewDist = Math.round(msg.targetResolvedOrbit - cumAtCurrentPos); // Allow negative

        log.appendLine(`  PLANET: idx=${currentIdx} resolved=${movedBody.resolvedOrbitRadius} rawDist=${rawDist} cum=${cumAtCurrentPos}`);
        log.appendLine(`  inPlaceNewDist=${inPlaceNewDist} target=${msg.targetResolvedOrbit}`);

        const updates: Array<{ line: number; orbitDistance?: number; orbitAngle?: number }> = [
            {
                line: msg.bodyLine,
                orbitDistance: inPlaceNewDist,
                orbitAngle: Math.round(msg.targetOrbitAngle),
            }
        ];

        // To prevent subsequent planets from shifting their absolute orbits,
        // we adjust the immediate next sibling planet's orbit_distance in the opposite direction.
        let nextBody: CelestialBody | null = null;
        for (let ni = currentIdx + 1; ni < planets.length; ni++) {
            const candidate = planets[ni]!;
            const candDist = candidate.orbitDistance.type === 'fixed' ? candidate.orbitDistance.value : -1;
            if (candDist !== 0) {
                nextBody = candidate;
                break;
            }
        }

        if (nextBody && nextBody.orbitDistance.type === 'fixed') {
            // Target absolute for next body: nextBody.resolvedOrbitRadius
            // Its new cumulative starting point: msg.targetResolvedOrbit
            const nextNewDist = Math.round(nextBody.resolvedOrbitRadius - msg.targetResolvedOrbit);
            log.appendLine(`  ADJUST NEXT: line=${nextBody.line} oldDist=${nextBody.orbitDistance.value} newDist=${nextNewDist}`);
            updates.push({
                line: nextBody.line,
                orbitDistance: nextNewDist,
            });
        }

        // Simple in-place update without reordering code blocks, preserving script formatting
        // and relative cumulative chaining for subsequent planets.
        await this._handleUpdateOrbits(updates);
    }

    private async _handleVscodeUndo() {
        if (!this._document) return;
        const snapshot = this._contentSnapshots.pop();
        if (!snapshot) return;
        const doc = this._document;
        this._redoSnapshots.push(doc.getText());
        if (this._redoSnapshots.length > SolarSystemPanel.MAX_SNAPSHOTS) {
            this._redoSnapshots.shift();
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end,
        );
        edit.replace(doc.uri, fullRange, snapshot);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    private async _handleVscodeRedo() {
        if (!this._document) return;
        const snapshot = this._redoSnapshots.pop();
        if (!snapshot) return;
        const doc = this._document;
        this._contentSnapshots.push(doc.getText());
        if (this._contentSnapshots.length > SolarSystemPanel.MAX_SNAPSHOTS) {
            this._contentSnapshots.shift();
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end,
        );
        edit.replace(doc.uri, fullRange, snapshot);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
        await doc.save();
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRootPath, 'solarSystemPreview.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRootPath, 'solarSystemPreview.js'))
        );
        const nonce = getNonce();
        const lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
        const title = panelText('Solar System Preview', '星系预览');

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this._panel.webview.cspSource} data: https: blob:; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>${title}</title>
</head>
<body>
    <div id="toolbar">
        <span id="title">${title}</span>
        <div id="controls">
            <select id="system-select" title="${panelText('Select system', '选择星系')}"></select>
            <span class="separator">|</span>
            <button id="btn-scale-mode" title="${panelText('Toggle readable / true scale', '切换可读比例 / 真实比例')}" aria-label="${panelText('Toggle scale mode', '切换比例模式')}">${panelText('Readable scale', '可读比例')}</button>
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="${panelText('Zoom in', '放大')}">+</button>
            <span id="zoom-level">100%</span>
            <button id="btn-zoom-out" title="${panelText('Zoom out', '缩小')}">−</button>
            <button id="btn-fit" title="${panelText('Fit to window', '适应窗口')}">⊡</button>
            <button id="btn-reset" title="${panelText('Reset view', '重置视角')}">↻</button>
            <span class="separator">|</span>
            <span id="tilt-level">55°</span>
            <span class="separator">|</span>
            <button id="btn-edit" title="${panelText('Toggle edit mode (E)', '切换编辑模式 (E)')}" class="edit-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg></button>
            <button id="btn-labels" title="${panelText('Toggle labels', '切换标签')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"></path><path d="M7 7h.01"></path></svg></button>
            <button id="btn-orbits" title="${panelText('Toggle orbit lines', '切换轨道线')}">◎</button>
            <span class="separator">|</span>
            <button id="btn-undo" title="${panelText('Undo edit (Ctrl+Z)', '撤销编辑 (Ctrl+Z)')}" aria-label="${panelText('Undo', '撤销')}">↶</button>
            <button id="btn-redo" title="${panelText('Redo edit', '重做编辑')}" aria-label="${panelText('Redo', '重做')}">↷</button>
            <button id="btn-save" title="${panelText('Save current file', '保存当前文件')}" aria-label="${panelText('Save', '保存')}">${panelText('Save', '保存')}</button>
            <span id="edit-status">${panelText('Synced', '已同步')}</span>
        </div>
    </div>
    <div id="main-layout">
        <div id="viewport">
            <canvas id="solar-canvas"></canvas>
        </div>
        <div id="side-panel">
            <div id="side-panel-tabs">
                <button id="tab-info" class="tab active">${panelText('Info', '信息')}</button>
                <button id="tab-properties" class="tab">${panelText('Properties', '属性')}</button>
            </div>
            <div id="info-panel">
                <div id="system-info">${panelText('Select a system to view details', '选择一个星系查看详情')}</div>
            </div>
            <div id="properties-panel" class="hidden">
                <div id="props-content">${panelText('Select a body to edit properties', '选择一个天体以编辑属性')}</div>
            </div>
        </div>
    </div>
    <div id="tooltip" class="hidden"></div>
    <div id="context-menu" class="hidden" style="max-height: 400px; overflow-y: auto; overflow-x: hidden;">
        <div id="ctx-planets">
            <div class="ctx-title">${panelText('Add body', '添加天体')}</div>
            <div class="ctx-content"></div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.1);margin:4px 0" id="ctx-ring-sep"></div>
        <div id="ctx-ringworld"><button data-action="add-ringworld"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="none" stroke="#ffd700" stroke-width="2"/></svg> ${panelText('Ringworld', '环形世界')}</button></div>
        <div style="border-top:1px solid rgba(255,255,255,0.1);margin:4px 0;display:none" id="ctx-moon-sep"></div>
        <div id="ctx-moons" style="display:none">
            <div class="ctx-title" id="ctx-moon-title">${panelText('Add moon', '添加卫星')}</div>
            <div class="ctx-content"></div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.1);margin:4px 0;display:none" id="ctx-sibling-sep"></div>
        <div id="ctx-sibling" style="display:none">
            <div class="ctx-title" id="ctx-sibling-title">${panelText('Create on same orbit', '在同轨道创建')}</div>
            <div class="ctx-content"></div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}

function panelText(en: string, zh: string): string {
    return vscode.env.language.toLowerCase().startsWith('zh') ? zh : en;
}
