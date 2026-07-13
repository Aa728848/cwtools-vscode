/**
 * Tech Tree Panel — VS Code Webview host for the Technology Tree Visualizer.
 *
 * Behaviour:
 * 1. Scans ALL common/technology/**\/*.txt files in the workspace
 * 2. Parses tech nodes and prerequisite edges
 * 3. If an active tech file is open, seeds from its techs (BFS-expand to show their tree)
 * 4. Resolves localization titles using the configured language
 * 5. Sends the graph to the webview for rendering
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ErrorReporter } from './ai/errorReporter';
import { decodeDds, decodeTga } from './ddsDecoder';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import { getLocalisationDirectoryGlob } from './gameProfiles';
import { parseLocFile, stripLocalisationColorMarkers } from './indexing/locParser';
import {
    applyTechLocalisation,
    parseTechFile,
    mergeTechGraphs,
    extractTechSubgraph,
    type TechGraph,
    type TechNode,
} from './techTreeParser';

// ─── Nonce generator ─────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function panelText(en: string, zh: string): string {
    return vscode.env.language.toLowerCase().startsWith('zh') ? zh : en;
}

const TECH_ICON_DIR = 'gfx/interface/icons/technologies';
const TECH_ICON_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const TECH_ICON_EXTENSIONS = ['.dds', '.png', '.tga', '.jpg', '.jpeg'];
const TECH_FILE_LIMIT_PER_ROOT = 2000;
const TECH_LOC_FILE_LIMIT_PER_ROOT = 3000;

interface TechIconCacheEntry {
    mtimeMs: number;
    size: number;
    uri: string;
    bytes: number;
}

type TechTreeViewMode = 'context' | 'all';

interface TechTreeScanOptions {
    includeVanilla: boolean;
    useSeed: boolean;
    viewMode: TechTreeViewMode;
}

interface TechScanRoot {
    uri: vscode.Uri;
    kind: 'workspace' | 'vanilla';
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export class TechTreePanel {
    public static currentPanel: TechTreePanel | undefined;
    private static readonly viewType = 'cwtools-tech-tree';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _seedDocument: vscode.TextDocument | undefined;
    private _searchRoots: string[] = [];
    private readonly _iconCache = new Map<string, TechIconCacheEntry>();
    private _iconCacheBytes = 0;

    public static async create(extensionPath: string, document?: vscode.TextDocument) {
        const column = vscode.ViewColumn.Beside;
        const seedDoc = document ?? vscode.window.activeTextEditor?.document;

        if (TechTreePanel.currentPanel) {
            TechTreePanel.currentPanel._seedDocument = seedDoc;
            TechTreePanel.currentPanel._panel.reveal(column);
            await TechTreePanel.currentPanel._scanAndRender();
            return;
        }

        const panel = new TechTreePanel(extensionPath, column, seedDoc);
        TechTreePanel.currentPanel = panel;
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, seedDoc?: vscode.TextDocument) {
        this._extensionPath = extensionPath;
        this._seedDocument = seedDoc;
        const webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        const gamePath = this._getGamePath();
        this._refreshSearchRoots(gamePath);
        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(webviewRootPath)];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(folder.uri);
        }
        if (gamePath) localResourceRoots.push(vscode.Uri.file(gamePath));

        const title = seedDoc
            ? panelText(`Tech Tree: ${path.basename(seedDoc.fileName)}`, `科技树: ${path.basename(seedDoc.fileName)}`)
            : panelText('Tech Tree Visualizer', '科技树可视化');

        this._panel = vscode.window.createWebviewPanel(
            TechTreePanel.viewType,
            title,
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
            this._panel.webview.onDidReceiveMessage(async msg => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'ready':
                        await this._scanAndRender();
                        break;
                    case 'goToTech':
                        await this._goToTech(msg.file, msg.line);
                        break;
                    case 'showAllTechnologies':
                        await this._scanAndRender({ includeVanilla: true, useSeed: false, viewMode: 'all' });
                        break;
                    case 'exportTechTreeImage':
                        await this._saveExportedImage(msg.dataUri, msg.fileName);
                        break;
                }
            }, null, this._disposables),
        );
    }

    public dispose() {
        TechTreePanel.currentPanel = undefined;
        this._seedDocument = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getGamePath(): string | null {
        const configPath = vscode.workspace.getConfiguration('stellarisLanguageServices').get<string>('cache.stellaris');
        return configPath && fs.existsSync(configPath) ? configPath : null;
    }

    private _refreshSearchRoots(gamePath = this._getGamePath()) {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        this._searchRoots = this._dedupeFsPaths(gamePath ? [gamePath, ...workspaceRoots] : workspaceRoots);
    }

    // ── Scan & render ─────────────────────────────────────────────────────────

    private async _scanAndRender(options?: Partial<TechTreeScanOptions>) {
        const scanOptions: TechTreeScanOptions = {
            includeVanilla: options?.includeVanilla ?? false,
            useSeed: options?.useSeed ?? true,
            viewMode: options?.viewMode ?? 'context',
        };
        this._panel.webview.postMessage({
            command: 'loading',
            text: scanOptions.includeVanilla
                ? panelText('Scanning workspace and vanilla technology files...', '扫描工作区和原版科技文件...')
                : panelText('Scanning technology files...', '扫描科技文件...'),
        });
        try {
            const graph = await this._buildTechGraph(scanOptions);
            this._panel.webview.postMessage({ command: 'render', data: graph, viewMode: scanOptions.viewMode });
        } catch (e) {
            ErrorReporter.debug('TechTreePanel', 'Failed to scan tech files', e);
            this._panel.webview.postMessage({ command: 'render', data: { nodes: [], edges: [] }, viewMode: scanOptions.viewMode });
        }
    }

    private async _buildTechGraph(options: TechTreeScanOptions): Promise<TechGraph> {
        const gamePath = this._getGamePath();
        this._refreshSearchRoots(gamePath);
        const scanRoots = this._getTechnologyScanRoots(options.includeVanilla, gamePath);
        if (scanRoots.length === 0) return { nodes: [], edges: [] };

        // Determine seed tech IDs from the active file (if it's a tech file)
        let seedIds = new Set<string>();
        if (options.useSeed && this._seedDocument) {
            const seedPath = vscode.workspace.asRelativePath(this._seedDocument.uri).toLowerCase();
            if (seedPath.includes('technology')) {
                const seedGraph = parseTechFile(this._seedDocument.getText(),
                    vscode.workspace.asRelativePath(this._seedDocument.uri));
                seedIds = new Set(seedGraph.nodes.map(n => n.id));
            }
        }

        // ── Phase 1: Scan all tech files ──────────────────────────────────────
        this._panel.webview.postMessage({
            command: 'loading',
            text: options.includeVanilla && gamePath
                ? panelText('Scanning workspace and vanilla common/technology/ files...', '扫描工作区和原版 common/technology/ 文件...')
                : panelText('Scanning common/technology/ files...', '扫描 common/technology/ 文件...'),
        });

        const graphs: TechGraph[] = [];

        for (const root of scanRoots) {
            const techFiles = await this._findTechnologyFiles(root.uri);
            for (const fileUri of techFiles) {
                try {
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    const filePath = root.kind === 'workspace'
                        ? vscode.workspace.asRelativePath(fileUri)
                        : fileUri.fsPath;
                    const g = parseTechFile(doc.getText(), filePath);
                    if (g.nodes.length > 0) graphs.push(g);
                } catch { /* skip */ }
            }
        }

        // ── Phase 2: Merge & BFS-expand ───────────────────────────────────────
        this._panel.webview.postMessage({ command: 'loading', text: panelText('Building technology relationship graph...', '构建科技关系图...') });

        const fullGraph = mergeTechGraphs(graphs);

        // If we have seeds, show that subgraph (BFS from seed in both directions)
        // Otherwise show the entire graph
        const graph = seedIds.size > 0
            ? extractTechSubgraph(fullGraph, seedIds, 10)
            : fullGraph;

        // ── Phase 3: Resolve localization titles ──────────────────────────────
        this._panel.webview.postMessage({ command: 'loading', text: panelText('Resolving localisation text...', '解析本地化文本...') });
        await this._resolveLocTitles(graph.nodes);
        this._panel.webview.postMessage({ command: 'loading', text: panelText('Resolving technology icons...', '解析科技图标...') });
        this._resolveTechIcons(graph.nodes);

        return graph;
    }

    private _getTechnologyScanRoots(includeVanilla: boolean, gamePath: string | null): TechScanRoot[] {
        const roots: TechScanRoot[] = [];
        if (includeVanilla && gamePath) {
            roots.push({ uri: vscode.Uri.file(gamePath), kind: 'vanilla' });
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            roots.push({ uri: folder.uri, kind: 'workspace' });
        }

        const seen = new Set<string>();
        return roots.filter(root => {
            const key = process.platform === 'win32' ? root.uri.fsPath.toLowerCase() : root.uri.fsPath;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private async _findTechnologyFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
        const techPattern = new vscode.RelativePattern(root, '**/common/technology/**/*.txt');
        return (await vscode.workspace.findFiles(
            techPattern,
            '**/{node_modules,.git,.cwtools}/**',
            TECH_FILE_LIMIT_PER_ROOT,
        )).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    }

    private async _resolveLocTitles(nodes: TechNode[]) {
        if (nodes.length === 0) return;

        const locMap = await this._loadLocalisationMap();
        if (locMap.size === 0) return;

        applyTechLocalisation(nodes, key => this._resolveLocKey(key, locMap));
    }

    private async _loadLocalisationMap(): Promise<Map<string, string>> {
        const locMap = new Map<string, string>();
        const locDirectoryGlob = getLocalisationDirectoryGlob();
        const roots = this._getLocalisationRoots();
        const targetTags = this._getTargetLocalisationTags();

        for (const root of roots) {
            for (const tag of targetTags) {
                const locPattern = new vscode.RelativePattern(
                    vscode.Uri.file(root),
                    `**/${locDirectoryGlob}/**/*${tag}.yml`,
                );
                const locFiles = (await vscode.workspace.findFiles(
                    locPattern,
                    '**/{node_modules,.git,.cwtools}/**',
                    TECH_LOC_FILE_LIMIT_PER_ROOT,
                )).sort((a, b) => this._compareLocalisationFilePriority(a.fsPath, b.fsPath));

                for (const fileUri of locFiles) {
                    try {
                        const data = await vscode.workspace.fs.readFile(fileUri);
                        const text = new TextDecoder('utf-8').decode(data);
                        for (const entry of parseLocFile(text, fileUri.fsPath)) {
                            locMap.set(entry.key, entry.value);
                        }
                    } catch { /* skip */ }
                }
            }
        }

        return locMap;
    }

    private _getLocalisationRoots(): string[] {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        const roots: string[] = [];
        const gamePath = this._getGamePath();
        if (gamePath) roots.push(gamePath);
        roots.push(...workspaceRoots);
        return this._dedupeFsPaths(roots);
    }

    private _dedupeFsPaths(paths: string[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const rawPath of paths) {
            const resolved = path.resolve(rawPath);
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(resolved);
        }
        return result;
    }

    private _getTargetLocalisationTags(): string[] {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const locLangs = config.get<string[]>('localisation.languages') || ['English'];
        const normalized = locLangs
            .map(language => this._normalizeLocalisationTag(language))
            .filter((tag): tag is string => !!tag);

        const hasChinese = normalized.includes('l_chinese') || normalized.includes('l_simp_chinese');
        const tags = hasChinese && normalized.length >= 2
            ? ['l_simp_chinese', 'l_chinese']
            : normalized.map(tag => tag === 'l_chinese' ? 'l_simp_chinese' : tag);

        return [...new Set(tags.length > 0 ? tags : ['l_english'])];
    }

    private _normalizeLocalisationTag(language: string): string | undefined {
        const value = language.trim().toLowerCase().replace(/[-\s]+/g, '_');
        if (!value) return undefined;
        if (value === 'chinese') return 'l_simp_chinese';
        return value.startsWith('l_') ? value : `l_${value}`;
    }

    private _compareLocalisationFilePriority(a: string, b: string): number {
        const priorityDiff = this._localisationFilePriority(a) - this._localisationFilePriority(b);
        return priorityDiff !== 0 ? priorityDiff : a.localeCompare(b);
    }

    private _localisationFilePriority(filePath: string): number {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        return normalized.includes('/replace/') ? 1 : 0;
    }

    private _resolveLocKey(key: string, locMap: Map<string, string>): string | undefined {
        const value = locMap.get(key);
        if (value === undefined) return undefined;

        const resolved = this._resolveLocReferences(value, locMap, new Set([key]));
        const cleaned = this._cleanLocText(resolved);
        return cleaned || undefined;
    }

    private _resolveLocReferences(value: string, locMap: Map<string, string>, seen: Set<string>): string {
        return value.replace(/\$([a-zA-Z0-9_.:-]+)\$/g, (match, key: string) => {
            if (seen.has(key)) return match;
            const replacement = locMap.get(key);
            if (replacement === undefined) return match;

            seen.add(key);
            const resolved = this._resolveLocReferences(replacement, locMap, seen);
            seen.delete(key);
            return resolved;
        });
    }

    private _cleanLocText(value: string): string {
        return stripLocalisationColorMarkers(value)
            .replace(/£[^£\s]+(?:\|[^£\s]+)?£/g, '')
            .replace(/\\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private _resolveTechIcons(nodes: TechNode[]) {
        for (const node of nodes) {
            node.iconUri = this._resolveTechIcon(node);
        }
    }

    private _resolveTechIcon(node: TechNode): string | undefined {
        for (const candidate of this._getTechIconCandidates(node)) {
            const resolved = this._resolveAssetPath(candidate);
            if (!resolved) continue;
            const uri = this._getIconUri(resolved);
            if (uri) return uri;
        }
        return undefined;
    }

    private _getTechIconCandidates(node: TechNode): string[] {
        const refs = new Set<string>();
        if (node.icon) refs.add(node.icon);
        refs.add(node.id);

        const candidates: string[] = [];
        for (const ref of refs) {
            candidates.push(...this._expandIconReference(ref));
        }
        return [...new Set(candidates)];
    }

    private _expandIconReference(rawRef: string): string[] {
        const ref = rawRef.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        if (!ref) return [];

        const names = new Set<string>([ref]);
        if (ref.startsWith('GFX_')) names.add(ref.substring(4));

        const candidates: string[] = [];
        for (const name of names) {
            const hasDirectory = name.includes('/');
            const hasExtension = /\.(dds|png|tga|jpe?g)$/i.test(name);
            if (hasDirectory || hasExtension) {
                candidates.push(...this._withFallbackExtensions(name));
            }
            if (!hasDirectory) {
                const baseName = hasExtension ? name.replace(/\.(dds|png|tga|jpe?g)$/i, '') : name;
                candidates.push(`assets/img/${baseName}.png`);
                candidates.push(...this._withFallbackExtensions(`${TECH_ICON_DIR}/${baseName}`));
            }
        }
        return candidates;
    }

    private _withFallbackExtensions(assetPath: string): string[] {
        if (/\.(dds|png|tga|jpe?g)$/i.test(assetPath)) return [assetPath];
        return TECH_ICON_EXTENSIONS.map(ext => `${assetPath}${ext}`);
    }

    private _resolveAssetPath(assetPath: string): string | undefined {
        const normalized = assetPath.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, '');
        const candidates = path.isAbsolute(assetPath)
            ? [assetPath]
            : this._searchRoots.map(root => path.join(root, normalized));

        for (const candidate of candidates) {
            const resolved = fs.existsSync(candidate) ? candidate : resolveCaseInsensitivePath(candidate);
            if (resolved) return resolved;
        }
        return undefined;
    }

    private _getIconUri(filePath: string): string | undefined {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            ErrorReporter.debug('TechTreePanel', `Failed to stat technology icon ${filePath}`, e);
            this._removeIconCacheEntry(filePath);
            return undefined;
        }

        const cached = this._iconCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            this._iconCache.delete(filePath);
            this._iconCache.set(filePath, cached);
            return cached.uri;
        }

        const ext = path.extname(filePath).toLowerCase();
        let uri: string | undefined;
        try {
            if (ext === '.dds') {
                uri = decodeDds(filePath)?.dataUri;
            } else if (ext === '.tga') {
                uri = decodeTga(filePath)?.dataUri;
            } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                uri = this._panel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
            }
        } catch (e) {
            ErrorReporter.debug('TechTreePanel', `Failed to decode technology icon ${filePath}`, e);
            this._removeIconCacheEntry(filePath);
            return undefined;
        }

        if (!uri) {
            this._removeIconCacheEntry(filePath);
            return undefined;
        }

        this._setIconCacheEntry(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, uri, bytes: uri.length });
        return uri;
    }

    private _setIconCacheEntry(filePath: string, entry: TechIconCacheEntry) {
        this._removeIconCacheEntry(filePath);
        this._iconCache.set(filePath, entry);
        this._iconCacheBytes += entry.bytes;

        while (this._iconCacheBytes > TECH_ICON_CACHE_MAX_BYTES && this._iconCache.size > 0) {
            const oldestKey = this._iconCache.keys().next().value;
            if (!oldestKey) break;
            this._removeIconCacheEntry(oldestKey);
        }
    }

    private _removeIconCacheEntry(filePath: string) {
        const old = this._iconCache.get(filePath);
        if (!old) return;
        this._iconCacheBytes -= old.bytes;
        this._iconCache.delete(filePath);
    }

    private async _goToTech(filePath: string, line: number) {
        if (!filePath) return;
        const uri = this._resolveSourceUri(filePath);
        if (!uri) return;

        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }

    private _resolveSourceUri(filePath: string): vscode.Uri | undefined {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const candidate = vscode.Uri.joinPath(folder.uri, filePath);
            if (fs.existsSync(candidate.fsPath)) return candidate;
        }

        for (const root of this._searchRoots) {
            const candidate = path.join(root, filePath);
            if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
        }

        return undefined;
    }

    private async _saveExportedImage(dataUri: unknown, fileName: unknown) {
        if (typeof dataUri !== 'string') return;
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
        if (!match) {
            vscode.window.showErrorMessage(panelText('Failed to export technology tree image.', '导出科技树图片失败。'));
            return;
        }
        const pngBase64 = match[1];
        if (!pngBase64) {
            vscode.window.showErrorMessage(panelText('Failed to export technology tree image.', '导出科技树图片失败。'));
            return;
        }

        const safeName = this._sanitizeExportFileName(fileName);
        const defaultUri = vscode.workspace.workspaceFolders?.[0]
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, safeName)
            : undefined;

        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { [panelText('PNG Image', 'PNG 图片')]: ['png'] },
        });
        if (!target) return;

        try {
            await vscode.workspace.fs.writeFile(target, Buffer.from(pngBase64, 'base64'));
            vscode.window.showInformationMessage(panelText('Technology tree image exported.', '科技树图片已导出。'));
        } catch (e) {
            ErrorReporter.debug('TechTreePanel', 'Failed to save exported technology tree image', e);
            vscode.window.showErrorMessage(panelText('Failed to export technology tree image.', '导出科技树图片失败。'));
        }
    }

    private _sanitizeExportFileName(fileName: unknown): string {
        if (typeof fileName !== 'string') return 'tech-tree.png';
        const normalized = fileName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!normalized) return 'tech-tree.png';
        return normalized.toLowerCase().endsWith('.png') ? normalized : `${normalized}.png`;
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _getHtml(webviewRootPath: string): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'techTreePreview.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'techTreePreview.js'))
        );
        const nonce = getNonce();
        const csp = this._panel.webview.cspSource;
        const lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
        const title = panelText('Tech Tree Visualizer', '科技树可视化');

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
        <span class="title">
            <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="3" fill="#4fc3f7"/>
                <line x1="8" y1="1" x2="8" y2="5" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="8" y1="11" x2="8" y2="15" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="1" y1="8" x2="5" y2="8" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="11" y1="8" x2="15" y2="8" stroke="#4fc3f7" stroke-width="1.5"/>
            </svg>
            ${title}
        </span>
        <div class="controls">
            <select id="area-filter" title="${panelText('Area filter', '领域筛选')}" aria-label="${panelText('Filter by area', '按领域过滤')}">
                <option value="__all__">${panelText('All areas', '全部领域')}</option>
                <option value="physics">${panelText('Physics', '物理学')}</option>
                <option value="society">${panelText('Society', '社会学')}</option>
                <option value="engineering">${panelText('Engineering', '工程学')}</option>
            </select>
            <span class="separator">|</span>
            <select id="tier-filter" title="${panelText('Tier filter', '层级筛选')}" aria-label="${panelText('Filter by tier', '按层级过滤')}">
                <option value="__all__">${panelText('All tiers', '全部层级')}</option>
            </select>
            <span class="separator">|</span>
            <input type="text" id="search-input" placeholder="${panelText('Search technology ID...', '搜索科技 ID...')}" aria-label="${panelText('Search technologies', '搜索科技')}" />
            <span class="separator">|</span>
            <label class="toggle-label" title="${panelText('Show rare technologies', '显示稀有科技')}">
                <input type="checkbox" id="show-rare" checked /> ${panelText('Rare', '稀有')}
            </label>
            <span class="separator">|</span>
            <button id="btn-show-all" title="${panelText('Show all technologies, including vanilla when configured', '显示全部科技；已配置原版路径时包含原版科技')}" aria-label="${panelText('Show all technologies', '显示全部科技')}">${panelText('All + Vanilla', '全部+原版')}</button>
            <button id="btn-export" title="${panelText('Export technology tree as PNG', '导出科技树为 PNG 图片')}" aria-label="${panelText('Export technology tree as PNG', '导出科技树为 PNG 图片')}">PNG</button>
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="${panelText('Zoom in', '放大')}" aria-label="${panelText('Zoom in', '放大')}">+</button>
            <button id="btn-zoom-out" title="${panelText('Zoom out', '缩小')}" aria-label="${panelText('Zoom out', '缩小')}">−</button>
            <button id="btn-fit" title="${panelText('Fit to window', '适应窗口')}" aria-label="${panelText('Fit to window', '适应窗口')}">⊡</button>
        </div>
    </div>

    <div id="cy-container">
        <div id="loading">${panelText('Scanning technology files...', '扫描科技文件...')}</div>
        <div id="empty-state">
            <div style="font-size:24px; opacity:0.3;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"></path><path d="m13.56 11.747 4.332-.924"></path><path d="m16 21-3.105-6.21"></path><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"></path><path d="m6.158 8.633 1.114 4.456"></path><path d="m8 21 3.105-6.21"></path><circle cx="12" cy="13" r="2"></circle></svg></div>
            <div>${panelText('No technology definitions found', '未发现科技定义')}</div>
            <div style="font-size:10px;">${panelText('Make sure the workspace contains a common/technology/ directory.', '请确保工作区包含 common/technology/ 目录')}</div>
        </div>
        <div id="legend">
            <div class="legend-title">${panelText('Legend', '图例')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#4fc3f7;"></span> ${panelText('Physics', '物理学')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#81c784;"></span> ${panelText('Society', '社会学')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ffb74d;"></span> ${panelText('Engineering', '工程学')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ce93d8; border-style:dashed; border-width:1px;"></span> ${panelText('Rare technology', '稀有科技')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ef5350;"></span> ${panelText('Dangerous technology', '危险科技')}</div>
        </div>
        <aside id="details-panel" class="empty" aria-live="polite">
            <div class="details-empty">
                <div class="details-empty-title">${panelText('Select a technology node', '选择科技节点')}</div>
                <div class="details-empty-copy">${panelText('View its area, tier, cost, source location, prerequisites, and follow-up technologies.', '查看领域、层级、费用、来源位置，以及它的前置和后续科技。')}</div>
            </div>
        </aside>
    </div>

    <div id="stats-bar"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
