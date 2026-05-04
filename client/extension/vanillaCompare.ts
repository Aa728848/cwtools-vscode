/**
 * Vanilla Code Comparison Module
 * - Block-level diff: right-click context menu on any code block
 * - File-level diff: editor title bar button (only compares matched blocks)
 * - Scans vanilla directory for matching blocks when filenames differ
 */
import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { tokenize, TokenType, type Token } from './pdxTokenizer';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdxBlock {
    key: string;         // syntactic key (e.g. "building_academy", "country_event")
    id: string | null;   // event id only (e.g. "crisis.6052"), null for non-event blocks
    name: string | null; // name field (e.g. for GUI elements or ship designs)
    startLine: number;
    endLine: number;
    content: string;
}

// ─── CWT Config Parsing ──────────────────────────────────────────────────────

function parseEventSubtypesFromCwt(configDir: string): Set<string> {
    const result = new Set<string>();
    try {
        const eventsCwtPath = path.join(configDir, 'events.cwt');
        if (!fs.existsSync(eventsCwtPath)) return result;
        const content = fs.readFileSync(eventsCwtPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.match(/^##\s*type_key_filter\s*=\s*(\w+)/);
            if (match) result.add(match[1]!);
        }
    } catch { /* ignore */ }
    return result;
}

function resolveCwtConfigDir(languageId: string): string | null {
    const langToGame: Record<string, string> = {
        stellaris: 'stellaris', eu4: 'eu4', hoi4: 'hoi4',
        ck2: 'ck2', imperator: 'imperator', vic2: 'vic2',
        ck3: 'ck3', vic3: 'vic3', eu5: 'eu5',
    };
    const game = langToGame[languageId];
    if (!game) return null;
    for (const wf of vs.workspace.workspaceFolders ?? []) {
        const wsConfig = path.join(wf.uri.fsPath, '.cwtools', game, 'config');
        if (fs.existsSync(wsConfig)) return wsConfig;
    }
    const submodulePath = path.join(__dirname, '..', '..', '..', 'submodules', `cwtools-${game}-config`, 'config');
    if (fs.existsSync(submodulePath)) return submodulePath;
    return null;
}

let _eventLikeKeysCache: Set<string> | null = null;
function getEventLikeKeys(languageId: string): Set<string> {
    if (_eventLikeKeysCache) return _eventLikeKeysCache;
    const configDir = resolveCwtConfigDir(languageId);
    _eventLikeKeysCache = configDir ? parseEventSubtypesFromCwt(configDir) : new Set<string>();
    if (_eventLikeKeysCache.size === 0) {
        _eventLikeKeysCache = new Set(['country_event', 'event']);
    }
    return _eventLikeKeysCache;
}

// ─── LRU Cache ────────────────────────────────────────────────────────────────

class LRUCache<K, V> {
    private readonly max: number;
    private readonly map = new Map<K, V>();
    constructor(max: number) { this.max = max; }

    get(key: K): V | undefined {
        const val = this.map.get(key);
        if (val !== undefined) { this.map.delete(key); this.map.set(key, val); }
        return val;
    }

    set(key: K, val: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, val);
        if (this.map.size > this.max) {
            const oldest = this.map.keys().next().value!;
            this.map.delete(oldest);
        }
    }

    clear(): void { this.map.clear(); }
}

// ─── Vanilla Path Resolution ──────────────────────────────────────────────────

const LANG_TO_CACHE_KEY: Record<string, string> = {
    stellaris: 'cache.stellaris', eu4: 'cache.eu4', hoi4: 'cache.hoi4',
    ck2: 'cache.ck2', imperator: 'cache.imperator', vic2: 'cache.vic2',
    ck3: 'cache.ck3', vic3: 'cache.vic3', eu5: 'cache.eu5',
};

function getGamePath(languageId: string): string | null {
    const cacheKey = LANG_TO_CACHE_KEY[languageId];
    if (!cacheKey) return null;
    const config = vs.workspace.getConfiguration('cwtools');
    const configPath = config.get<string>(cacheKey);
    if (configPath && fs.existsSync(configPath)) return configPath;
    return null;
}

// ─── Vanilla File Cache ───────────────────────────────────────────────────────

const vanillaFileCache = new LRUCache<string, string | null>(64);

async function loadVanillaFile(vanillaPath: string): Promise<string | null> {
    const cached = vanillaFileCache.get(vanillaPath);
    if (cached !== undefined) return cached;
    try {
        const content = fs.readFileSync(vanillaPath, 'utf-8');
        vanillaFileCache.set(vanillaPath, content);
        return content;
    } catch {
        vanillaFileCache.set(vanillaPath, null);
        return null;
    }
}

// ─── Block Detection ──────────────────────────────────────────────────────────

/** Extract a field value (e.g. `id` or `name`) from the first tokens inside a block. */
function extractBlockField(tokens: Token[], lbraceIndex: number, fieldName: string, maxTokens: number = 80): string | null {
    for (let i = lbraceIndex + 1; i < tokens.length && i < lbraceIndex + maxTokens; i++) {
        const tok = tokens[i]!;
        if (tok.type === TokenType.Identifier && tok.value === fieldName) {
            const next = tokens[i + 1];
            const val = tokens[i + 2];
            if (next?.type === TokenType.Equals && val && (val.type === TokenType.Identifier || val.type === TokenType.String || val.type === TokenType.Number)) {
                return val.value;
            }
        }
        if (tok.type === TokenType.LBrace) break;
    }
    return null;
}

function findTopLevelBlocks(text: string, idKeys: Set<string> = new Set()): PdxBlock[] {
    const tokens = tokenize(text, { comments: false, percent: false });
    const blocks: PdxBlock[] = [];
    const lines = text.split('\n');
    let depth = 0;
    let pendingKey: string | null = null;
    let pendingKeyLine = 0;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.type === TokenType.LBrace) {
            if (depth === 0 && pendingKey !== null) {
                const blockStartLine = pendingKeyLine;
                let braceDepth = 1;
                let endLine = tok.line - 1;
                for (let j = i + 1; j < tokens.length; j++) {
                    const inner = tokens[j]!;
                    if (inner.type === TokenType.LBrace) braceDepth++;
                    else if (inner.type === TokenType.RBrace) {
                        braceDepth--;
                        if (braceDepth === 0) { endLine = inner.line - 1; break; }
                    }
                }
                const startIdx = blockStartLine;
                const endIdx = Math.min(endLine, lines.length - 1);
                const content = lines.slice(startIdx, endIdx + 1).join('\n');
                const blockId = extractBlockField(tokens, i, 'id');
                const blockName = extractBlockField(tokens, i, 'name');
                blocks.push({ key: pendingKey, id: blockId, name: blockName, startLine: startIdx, endLine: endIdx, content });
                pendingKey = null;
            }
            depth++;
        } else if (tok.type === TokenType.RBrace) {
            depth--;
        } else if (depth === 0 && tok.type === TokenType.Identifier) {
            const nextTok = tokens[i + 1];
            if (nextTok?.type === TokenType.Equals) {
                pendingKey = tok.value;
                pendingKeyLine = tok.line - 1;
            }
        }
    }
    return blocks;
}

function findEnclosingBlock(blocks: PdxBlock[], line: number): PdxBlock | null {
    return blocks.find(b => line >= b.startLine && line <= b.endLine) ?? null;
}

/**
 * Get the match identity for a block:
 * - Events (have `id`): use `id` (e.g. "crisis.6052").
 * - GUI/Entities (have `name`): use `name`.
 * - Everything else: use syntactic key (e.g. "building_academy", "tech_corvettes").
 * Returns null if it's an event-like block but lacks an id/name, to prevent matching unrelated events.
 */
function blockIdentity(block: PdxBlock, idKeys: Set<string>): string | null {
    if (block.id) return block.id;
    if (block.name) return block.name;

    // If it's explicitly an event type, or ends with _event, it MUST have an identity to be compared.
    // Otherwise, all 'planet_event' blocks without an id would match each other.
    if (idKeys.has(block.key) || block.key.endsWith('_event') || block.key === 'event') {
        return null;
    }

    return block.key;
}

/**
 * Scan vanilla directory and build a unified block index.
 * Maps block identity → { block, filePath } across ALL vanilla .txt files.
 */
async function buildVanillaBlockIndex(
    vanillaRoot: string,
    relDir: string,
    idKeys: Set<string>,
): Promise<Map<string, { block: PdxBlock; filePath: string }>> {
    const index = new Map<string, { block: PdxBlock; filePath: string }>();
    const vanillaDir = path.join(vanillaRoot, relDir);
    if (!fs.existsSync(vanillaDir)) return index;

    let entries: string[];
    try {
        entries = fs.readdirSync(vanillaDir).filter(f => f.endsWith('.txt'));
    } catch {
        return index;
    }

    for (const entry of entries) {
        const filePath = path.join(vanillaDir, entry);
        const content = await loadVanillaFile(filePath);
        if (!content) continue;
        for (const block of findTopLevelBlocks(content, idKeys)) {
            const identity = blockIdentity(block, idKeys);
            if (identity && !index.has(identity)) {
                index.set(identity, { block, filePath });
            }
        }
    }
    return index;
}

// ─── Vanilla Content Provider ─────────────────────────────────────────────────

class VanillaContentProvider implements vs.TextDocumentContentProvider {
    private _content = '';
    readonly onDidChange = new vs.EventEmitter<vs.Uri>().event;

    setContent(text: string): void { this._content = text; }
    provideTextDocumentContent(): string { return this._content; }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVanillaCompare(context: vs.ExtensionContext): void {
    const vanillaProvider = new VanillaContentProvider();

    context.subscriptions.push(
        vs.workspace.registerTextDocumentContentProvider('cwtools-vanilla', vanillaProvider)
    );

    // ── Command: Block-level diff (right-click context menu) ──────────────
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.vanillaCompare.diff',
            async (uri?: vs.Uri, startLine?: number, endLine?: number, key?: string) => {
                let modBlock: PdxBlock | null = null;

                if (!uri || startLine == null || !key) {
                    const editor = vs.window.activeTextEditor;
                    if (!editor) return;
                    uri = editor.document.uri;
                    const doc = editor.document;
                    const idKeys = getEventLikeKeys(doc.languageId);
                    const blocks = findTopLevelBlocks(doc.getText(), idKeys);
                    modBlock = findEnclosingBlock(blocks, editor.selection.active.line);
                    if (!modBlock) {
                        vs.window.showInformationMessage('光标不在任何代码块内');
                        return;
                    }
                    startLine = modBlock.startLine;
                    endLine = modBlock.endLine;
                    key = modBlock.key;
                }

                const doc = await vs.workspace.openTextDocument(uri);
                const langId = doc.languageId;
                const vanillaRoot = getGamePath(langId);
                if (!vanillaRoot) {
                    vs.window.showWarningMessage('未配置原版游戏路径，请在设置中配置 cwtools.cache.*');
                    return;
                }

                const idKeys = getEventLikeKeys(langId);

                if (!modBlock) {
                    const blocks = findTopLevelBlocks(doc.getText(), idKeys);
                    modBlock = blocks.find(b => b.startLine === startLine && b.key === key) ?? null;
                }
                if (!modBlock) return;

                const relPath = vs.workspace.asRelativePath(uri);
                const relDir = path.dirname(relPath);

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys);
                const identity = blockIdentity(modBlock, idKeys);
                if (!identity) {
                    vs.window.showInformationMessage(`无法确定当前代码块的唯一标识（缺少 id 或 name）`);
                    return;
                }

                const match = vanillaIndex.get(identity);

                if (!match) {
                    vs.window.showInformationMessage(`原版中未找到代码块: ${identity}`);
                    return;
                }

                // Open diff view: vanilla block vs mod block
                vanillaProvider.setContent(match.block.content);
                const vanillaUri = vs.Uri.parse(`cwtools-vanilla:/${identity}.txt`);

                const modLines = doc.getText().split('\n');
                const modBlockText = modLines.slice(startLine, endLine! + 1).join('\n');

                const tmpDir = path.join(os.tmpdir(), 'cwtools-vanilla-compare');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const modTmpPath = path.join(tmpDir, `mod_${identity}.txt`);
                fs.writeFileSync(modTmpPath, modBlockText, 'utf-8');

                await vs.commands.executeCommand('vscode.diff',
                    vanillaUri, vs.Uri.file(modTmpPath),
                    `Vanilla vs Mod: ${identity}`,
                    { preview: true, viewColumn: vs.ViewColumn.Beside }
                );

                setTimeout(() => { try { fs.unlinkSync(modTmpPath); } catch { /* */ } }, 60_000);
            }
        )
    );

    // ── Command: File-level diff (editor title bar) ───────────────────────
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.vanillaCompare.fileDiff',
            async () => {
                const editor = vs.window.activeTextEditor;
                if (!editor) return;
                const doc = editor.document;
                const langId = doc.languageId;
                const vanillaRoot = getGamePath(langId);
                if (!vanillaRoot) {
                    vs.window.showWarningMessage('未配置原版游戏路径，请在设置中配置 cwtools.cache.*');
                    return;
                }

                const idKeys = getEventLikeKeys(langId);
                const relPath = vs.workspace.asRelativePath(doc.uri);
                const relDir = path.dirname(relPath);
                const modBlocks = findTopLevelBlocks(doc.getText(), idKeys);

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys);

                // Match each mod block independently
                const vanillaLines: string[] = [];
                const modLines: string[] = [];
                let matchCount = 0;

                for (const modBlock of modBlocks) {
                    const identity = blockIdentity(modBlock, idKeys);
                    if (!identity) continue; // Skip blocks that don't have a unique identity

                    const match = vanillaIndex.get(identity);
                    if (!match) continue;
                    vanillaLines.push(match.block.content);
                    modLines.push(modBlock.content);
                    matchCount++;
                }

                if (matchCount === 0) {
                    vs.window.showInformationMessage('当前文件中未找到与原版匹配的代码块');
                    return;
                }

                // Write matched blocks to temp files and diff
                const tmpDir = path.join(os.tmpdir(), 'cwtools-vanilla-compare');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const vanillaTmpPath = path.join(tmpDir, 'vanilla_matched.txt');
                const modTmpPath = path.join(tmpDir, 'mod_matched.txt');
                fs.writeFileSync(vanillaTmpPath, vanillaLines.join('\n\n'), 'utf-8');
                fs.writeFileSync(modTmpPath, modLines.join('\n\n'), 'utf-8');

                await vs.commands.executeCommand('vscode.diff',
                    vs.Uri.file(vanillaTmpPath), vs.Uri.file(modTmpPath),
                    `Vanilla vs Mod: ${path.basename(relPath)} (${matchCount} blocks)`,
                    { preview: true, viewColumn: vs.ViewColumn.Beside }
                );

                setTimeout(() => {
                    try { fs.unlinkSync(vanillaTmpPath); } catch { /* */ }
                    try { fs.unlinkSync(modTmpPath); } catch { /* */ }
                }, 60_000);
            }
        )
    );

    // ── Event: Clear cache on config change ────────────────────────────────
    context.subscriptions.push(
        vs.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cwtools.cache')) {
                vanillaFileCache.clear();
                _eventLikeKeysCache = null;
            }
        })
    );
}
