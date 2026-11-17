import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseGuiFile, buildSpriteIndex, type SpriteInfo } from './guiParser';
import type { GuiElement } from '../shared/guiPreview';
import { decodeDds, decodeTga, type DdsResult } from './ddsDecoder';
import { walkFiles } from './fileWalker';
import { isPathInsideOrEqual } from './pathScope';

export interface LoadedGuiPreview {
    elements: GuiElement[];
    spriteNames: string[];
    effectNames: string[];
    searchRoots: string[];
}

/** Shared parser, sprite index and bounded texture cache for GUI preview surfaces. */
export class GuiPreviewLoader {
    public textureCache: Map<string, DdsResult | null> = new Map();
    public textureCacheBytes = 0;
    private readonly captureCache = new Map<string, string>();
    private captureCacheBytes = 0;
    private static readonly MAX_CAPTURE_CACHE_BYTES = 20 * 1024 * 1024;
    public spriteIndexCache: Map<string, SpriteInfo> | null = null;
    public effectNamesCache: string[] | null = null;
    public searchRoots: string[] = [];
    public readonly scanAbortController = new AbortController();
    private static readonly MAX_CACHE_BYTES = 50 * 1024 * 1024;

    public getGamePath(): string | null {
        const configured = vscode.workspace.getConfiguration('stellarisLanguageServices').get<string>('cache.stellaris');
        return configured && fs.existsSync(configured) ? configured : null;
    }

    public findModRoot(directory: string): string {
        let current = directory;
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(current, 'descriptor.mod'))
                || fs.existsSync(path.join(current, 'common'))
                || (fs.existsSync(path.join(current, 'interface')) && fs.existsSync(path.join(current, 'gfx')))) return current;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return directory;
    }

    public async load(document: vscode.TextDocument, webview: vscode.Webview, contentOverride?: string): Promise<LoadedGuiPreview> {
        const modRoot = this.findModRoot(path.dirname(document.uri.fsPath));
        const roots: string[] = [modRoot];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (!roots.includes(folder.uri.fsPath)) roots.push(folder.uri.fsPath);
        }
        const gamePath = this.getGamePath();
        if (gamePath && !roots.includes(gamePath)) roots.push(gamePath);
        this.searchRoots = roots;
        if (!this.spriteIndexCache) this.spriteIndexCache = await this.buildSpriteIndex(roots);
        const parsed = parseGuiFile(contentOverride ?? document.getText(), this.spriteIndexCache);
        const elements = this.resolveTextures(parsed, roots, webview);
        if (!this.effectNamesCache) this.effectNamesCache = await this.collectButtonEffects(roots);
        return {
            elements,
            spriteNames: Array.from(this.spriteIndexCache.keys()).sort(),
            effectNames: this.effectNamesCache,
            searchRoots: roots,
        };
    }

    public clearTextureCache(): void {
        this.textureCache.clear();
        this.textureCacheBytes = 0;
        this.captureCache.clear();
        this.captureCacheBytes = 0;
    }

    public invalidateGfx(uri: vscode.Uri): void {
        if (!this.spriteIndexCache) return;
        const directory = path.dirname(uri.fsPath);
        const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
        for (const key of this.spriteIndexCache.keys()) {
            if (normalize(key).startsWith(normalize(directory))) this.spriteIndexCache.delete(key);
        }
    }

    public dispose(): void {
        this.scanAbortController.abort();
        this.clearTextureCache();
        this.spriteIndexCache = null;
        this.effectNamesCache = null;
        this.searchRoots = [];
    }

    private async buildSpriteIndex(roots: string[]): Promise<Map<string, SpriteInfo>> {
        const maxGfxFiles = 500;
        const contents: Array<{ path: string; content: string }> = [];
        for (const root of roots) {
            if (contents.length >= maxGfxFiles) break;
            for (const directory of [path.join(root, 'interface'), path.join(root, 'gfx')]) {
                if (contents.length >= maxGfxFiles) break;
                try { await fs.promises.access(directory); } catch { continue; }
                const found = await walkFiles(directory, {
                    ext: '.gfx',
                    maxFiles: maxGfxFiles - contents.length,
                    signal: this.scanAbortController.signal,
                });
                contents.push(...found.map(file => ({ path: file.path, content: file.content })));
            }
        }
        return buildSpriteIndex(contents);
    }

    private async collectButtonEffects(roots: string[]): Promise<string[]> {
        const names = new Set<string>();
        for (const root of roots) {
            const files = await walkFiles(path.join(root, 'common', 'button_effects'), {
                ext: '.txt', recursive: false, signal: this.scanAbortController.signal,
            });
            for (const file of files) {
                const regex = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*\{/gm;
                let match: RegExpExecArray | null;
                while ((match = regex.exec(file.content)) !== null) names.add(match[1]!);
            }
        }
        return Array.from(names).sort();
    }

    private resolveTextures(elements: GuiElement[], roots: string[], webview: vscode.Webview): GuiElement[] {
        const resolve = (element: GuiElement): GuiElement => {
            let textureUri: string | undefined;
            let captureTexture: string | undefined;
            let textureWidth: number | undefined;
            let textureHeight: number | undefined;
            if (element.spriteTexture) {
                const relative = element.spriteTexture.replace(/\//g, path.sep);
                for (const root of roots) {
                    const fullDds = path.resolve(root, relative);
                    if (!isPathInsideOrEqual(fullDds, root)) continue;
                    const fullPng = fullDds.replace(/\.dds$/i, '.png');
                    const fullTga = fullDds.replace(/\.dds$/i, '.tga');
                    if (fs.existsSync(fullPng)) {
                        textureUri = webview.asWebviewUri(vscode.Uri.file(fullPng)).toString();
                        captureTexture = this.cachedPngCapture(fullPng);
                        break;
                    }
                    if (fs.existsSync(fullDds)) {
                        const result = this.cachedTexture(fullDds, decodeDds);
                        textureUri = result ? result.dataUri : `dds:${element.spriteTexture}`;
                        textureWidth = result?.width;
                        textureHeight = result?.height;
                        break;
                    }
                    if (fs.existsSync(fullTga)) {
                        const result = this.cachedTexture(fullTga, decodeTga);
                        textureUri = result ? result.dataUri : `tga:${element.spriteTexture}`;
                        textureWidth = result?.width;
                        textureHeight = result?.height;
                        break;
                    }
                }
            }
            return {
                ...element,
                spriteTexture: textureUri ?? element.spriteTexture,
                ...(captureTexture ? { captureTexture } : {}),
                textureWidth: textureWidth ?? element.textureWidth,
                textureHeight: textureHeight ?? element.textureHeight,
                children: element.children.map(resolve),
            };
        };
        return elements.map(resolve);
    }

    private cachedPngCapture(filePath: string): string | undefined {
        const cached = this.captureCache.get(filePath);
        if (cached) return cached;
        try {
            const size = fs.statSync(filePath).size;
            if (size <= 0 || size > GuiPreviewLoader.MAX_CAPTURE_CACHE_BYTES) return undefined;
            const dataUrl = `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
            const entrySize = dataUrl.length;
            while (this.captureCacheBytes + entrySize > GuiPreviewLoader.MAX_CAPTURE_CACHE_BYTES && this.captureCache.size > 0) {
                const oldestKey = this.captureCache.keys().next().value as string | undefined;
                if (!oldestKey) break;
                this.captureCacheBytes -= this.captureCache.get(oldestKey)?.length ?? 0;
                this.captureCache.delete(oldestKey);
            }
            this.captureCache.set(filePath, dataUrl);
            this.captureCacheBytes += entrySize;
            return dataUrl;
        } catch {
            return undefined;
        }
    }

    private cachedTexture(filePath: string, decode: (path: string) => DdsResult | null): DdsResult | null {
        if (this.textureCache.has(filePath)) return this.textureCache.get(filePath) ?? null;
        const result = decode(filePath);
        const size = result?.dataUri?.length ?? 0;
        while (this.textureCacheBytes + size > GuiPreviewLoader.MAX_CACHE_BYTES && this.textureCache.size > 0) {
            const oldestKey = this.textureCache.keys().next().value as string | undefined;
            if (!oldestKey) break;
            this.textureCacheBytes -= this.textureCache.get(oldestKey)?.dataUri?.length ?? 0;
            this.textureCache.delete(oldestKey);
        }
        this.textureCache.set(filePath, result);
        this.textureCacheBytes += size;
        return result;
    }
}
