/**
 * PDX Shader Workspace Index
 *
 * Provides workspace-level symbol indexing for .shader and .fxh files.
 * Design choices:
 * - Lazy initialization: index is built on first query, not at activation.
 * - Incremental updates: file watcher re-parses changed files individually.
 * - Document-version caching: avoids re-parsing unchanged TextDocuments.
 * - Idle reclamation: drops the index after 5 minutes of inactivity.
 */
import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parsePdxShader, PdxShaderDocument, PdxShaderNode } from './shaderParser';

// ─── Document Cache (version-keyed) ─────────────────────────────────────────

interface CachedParse {
    version: number;
    doc: PdxShaderDocument;
}

const documentCache = new Map<string, CachedParse>();

/**
 * Get a parsed PdxShaderDocument, returning a cached copy if the document
 * version has not changed.  This is the single entry-point that all
 * providers should use instead of calling parsePdxShader directly.
 */
export function getCachedParse(document: vs.TextDocument): PdxShaderDocument {
    const key = document.uri.toString();
    const cached = documentCache.get(key);
    if (cached && cached.version === document.version) {
        return cached.doc;
    }
    const doc = parsePdxShader(key, document.getText());
    documentCache.set(key, { version: document.version, doc });
    return doc;
}

/** Evict a specific URI from the cache (e.g. when a file is deleted). */
export function evictCachedParse(uri: string): void {
    documentCache.delete(uri);
}

// ─── Workspace Shader Index ─────────────────────────────────────────────────

export interface ShaderSymbolHit {
    uri: string;
    node: PdxShaderNode;
}

export class ShaderIndex {
    private documents = new Map<string, PdxShaderDocument>();
    private ready = false;
    private building = false;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    /** Lazy — builds the index on first call, subsequent calls are no-ops. */
    async ensureReady(): Promise<void> {
        this.touchIdle();
        if (this.ready || this.building) return;
        this.building = true;
        try {
            // 1. Scan workspace .shader/.fxh files
            const files = await vs.workspace.findFiles('**/*.{shader,fxh}', '**/node_modules/**', 500);
            for (const file of files) {
                this.indexFile(file.fsPath, file.toString());
            }

            // 2. Scan vanilla Stellaris gfx/FX directory
            this.scanVanillaFxDirectory();

            this.ready = true;
        } finally {
            this.building = false;
        }
    }

    /** Scan the vanilla Stellaris installation's gfx/FX directory for shared shader definitions. */
    private scanVanillaFxDirectory(): void {
        const config = vs.workspace.getConfiguration('cwtools');
        const gamePath = config.get<string>('cache.stellaris');
        if (!gamePath) return;

        const fxDir = path.join(gamePath, 'gfx', 'FX');
        if (!fs.existsSync(fxDir)) return;

        try {
            const entries = fs.readdirSync(fxDir);
            for (const entry of entries) {
                if (entry.endsWith('.shader') || entry.endsWith('.fxh')) {
                    const filePath = path.join(fxDir, entry);
                    const uri = vs.Uri.file(filePath).toString();
                    if (!this.documents.has(uri)) {
                        this.indexFile(filePath, uri);
                    }
                }
            }
        } catch {
            // Vanilla directory unreadable — skip silently
        }
    }

    /** Parse and index a single file. */
    private indexFile(fsPath: string, uri: string): void {
        try {
            const content = fs.readFileSync(fsPath, 'utf8');
            const doc = parsePdxShader(uri, content);
            this.documents.set(uri, doc);
        } catch {
            // Skip unreadable files silently
        }
    }

    /** Incremental update for a single file (called by file watcher). */
    onDocumentChanged(uri: vs.Uri): void {
        if (!this.ready) return;
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const doc = parsePdxShader(uri.toString(), content);
            this.documents.set(uri.toString(), doc);
        } catch {
            this.documents.delete(uri.toString());
        }
        this.touchIdle();
    }

    /** Remove a deleted file from the index. */
    onDocumentDeleted(uri: vs.Uri): void {
        this.documents.delete(uri.toString());
        evictCachedParse(uri.toString());
    }

    /** Force-update from an open TextDocument (fresher than disk). */
    updateFromTextDocument(document: vs.TextDocument): void {
        if (!this.ready) return;
        const doc = getCachedParse(document);
        this.documents.set(document.uri.toString(), doc);
    }

    // ─── Query API ───────────────────────────────────────────────────────

    findMainCode(name: string): ShaderSymbolHit[] {
        const hits: ShaderSymbolHit[] = [];
        for (const [uri, doc] of this.documents) {
            for (const mc of doc.allMainCodes) {
                if (mc.name === name) hits.push({ uri, node: mc });
            }
        }
        return hits;
    }

    findConstantBuffer(name: string): ShaderSymbolHit[] {
        const hits: ShaderSymbolHit[] = [];
        for (const [uri, doc] of this.documents) {
            for (const cb of doc.constantBuffers) {
                if (cb.name === name) hits.push({ uri, node: cb });
            }
        }
        return hits;
    }

    findEffect(name: string): ShaderSymbolHit[] {
        const hits: ShaderSymbolHit[] = [];
        for (const [uri, doc] of this.documents) {
            for (const e of doc.effects) {
                if (e.name === name) hits.push({ uri, node: e });
            }
        }
        return hits;
    }

    findAllEffectNames(): string[] {
        const names = new Set<string>();
        for (const doc of this.documents.values()) {
            for (const e of doc.effects) {
                if (e.name) names.add(e.name);
            }
        }
        return Array.from(names);
    }

    findAllMainCodeNames(): string[] {
        const names = new Set<string>();
        for (const doc of this.documents.values()) {
            for (const mc of doc.allMainCodes) {
                if (mc.name) names.add(mc.name);
            }
        }
        return Array.from(names);
    }

    findAllConstantBufferNames(): string[] {
        const names = new Set<string>();
        for (const doc of this.documents.values()) {
            for (const cb of doc.constantBuffers) {
                if (cb.name) names.add(cb.name);
            }
        }
        return Array.from(names);
    }

    getDocument(uri: string): PdxShaderDocument | undefined {
        return this.documents.get(uri);
    }

    get isReady(): boolean {
        return this.ready;
    }

    // ─── Idle reclamation ────────────────────────────────────────────────

    private touchIdle(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.dispose(), ShaderIndex.IDLE_TIMEOUT_MS);
    }

    dispose(): void {
        this.documents.clear();
        this.ready = false;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}
