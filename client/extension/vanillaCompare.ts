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

function normalizeParadoxRelativeDir(fsPath: string): string {
    const normalized = fsPath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const standardDirs = new Set([
        'common', 'events', 'gfx', 'interface', 'localisation', 'localization',
        'map', 'history', 'decisions', 'missions', 'flags', 'prescripted_countries'
    ]);
    for (let i = 0; i < parts.length; i++) {
        if (standardDirs.has(parts[i]!.toLowerCase())) {
            return parts.slice(i).join('/');
        }
    }
    return '';
}

function getGamePath(languageId: string): string | null {
    let targetLang = languageId;
    if (!LANG_TO_CACHE_KEY[targetLang]) {
        const possibleGames = ['stellaris', 'hoi4', 'eu4', 'ck3', 'vic3', 'imperator', 'ck2', 'vic2', 'eu5'];
        
        // 1. Try to infer the game from the workspace .cwtools rules configuration folders
        for (const game of possibleGames) {
            for (const wf of vs.workspace.workspaceFolders ?? []) {
                const wsConfig = path.join(wf.uri.fsPath, '.cwtools', game, 'config');
                if (fs.existsSync(wsConfig)) {
                    targetLang = game;
                    break;
                }
            }
            if (targetLang !== languageId) break;
        }

        // 2. Try to infer from visible text editors with a known Paradox language ID
        if (targetLang === languageId) {
            for (const editor of vs.window.visibleTextEditors) {
                const lang = editor.document.languageId;
                if (lang && lang !== languageId && LANG_TO_CACHE_KEY[lang]) {
                    targetLang = lang;
                    break;
                }
            }
        }

        // 3. Try to locate the vanilla path that actually contains a 'gfx/FX' folder
        if (targetLang === languageId) {
            const config = vs.workspace.getConfiguration('cwtools');
            for (const game of possibleGames) {
                const cacheKey = LANG_TO_CACHE_KEY[game];
                if (cacheKey) {
                    const configPath = config.get<string>(cacheKey);
                    if (configPath && fs.existsSync(configPath)) {
                        if (fs.existsSync(path.join(configPath, 'gfx', 'FX'))) {
                            targetLang = game;
                            break;
                        }
                    }
                }
            }
        }

        // 4. Default fallback
        if (targetLang === languageId) {
            targetLang = 'stellaris';
        }
    }

    const cacheKey = LANG_TO_CACHE_KEY[targetLang];
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

function findTopLevelBlocks(text: string, _idKeys: Set<string> = new Set()): PdxBlock[] {
    const tokens = tokenize(text, { comments: false, percent: false });
    const blocks: PdxBlock[] = [];
    const lines = text.split('\n');
    let depth = 0;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.type === TokenType.LBrace) {
            if (depth === 0) {
                let resolvedKey: string | null = null;
                let resolvedLine = 0;

                if (i >= 2 && tokens[i - 1]!.type === TokenType.Equals && tokens[i - 2]!.type === TokenType.Identifier) {
                    resolvedKey = tokens[i - 2]!.value;
                    resolvedLine = tokens[i - 2]!.line - 1;
                } else if (i >= 1 && tokens[i - 1]!.type === TokenType.Identifier) {
                    resolvedKey = tokens[i - 1]!.value;
                    resolvedLine = tokens[i - 1]!.line - 1;
                }

                if (resolvedKey !== null) {
                    const blockStartLine = resolvedLine;
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
                    blocks.push({ key: resolvedKey, id: blockId, name: blockName, startLine: startIdx, endLine: endIdx, content });
                }
            }
            depth++;
        } else if (tok.type === TokenType.RBrace) {
            depth--;
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
 * Maps block identity → { block, filePath } across vanilla files matching the current extension.
 */
async function buildVanillaBlockIndex(
    vanillaRoot: string,
    relDir: string,
    idKeys: Set<string>,
    ext: string = '.txt',
): Promise<Map<string, { block: PdxBlock; filePath: string }>> {
    const index = new Map<string, { block: PdxBlock; filePath: string }>();
    const vanillaDir = path.join(vanillaRoot, relDir);
    if (!fs.existsSync(vanillaDir)) return index;

    let entries: string[];
    try {
        entries = fs.readdirSync(vanillaDir).filter(f => f.endsWith(ext));
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

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVanillaCompare(context: vs.ExtensionContext): void {

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
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
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

                let relDir = normalizeParadoxRelativeDir(path.dirname(uri.fsPath));
                if (!relDir) {
                    const relPath = vs.workspace.asRelativePath(uri, false);
                    relDir = path.dirname(relPath);
                }

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys, ext);
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

                // Write vanilla block content to a temp file (left / read-only side)
                const tmpDir = path.join(os.tmpdir(), 'cwtools-vanilla-compare');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const vanillaTmpPath = path.join(tmpDir, `vanilla_${identity}.txt`);
                fs.writeFileSync(vanillaTmpPath, match.block.content, 'utf-8');

                // Right side = real mod file (edits sync directly to the actual document)
                await vs.commands.executeCommand('vscode.diff',
                    vs.Uri.file(vanillaTmpPath), uri,
                    `Vanilla vs Mod: ${identity}`,
                    { preview: true, viewColumn: vs.ViewColumn.Beside }
                );

                // Scroll to the relevant block range in the diff editor
                setTimeout(async () => {
                    const diffEditor = vs.window.activeTextEditor;
                    if (diffEditor && diffEditor.document.uri.toString() === uri!.toString()) {
                        const range = new vs.Range(startLine!, 0, endLine!, 0);
                        diffEditor.revealRange(range, vs.TextEditorRevealType.InCenter);
                    }
                }, 300);

                // Clean up vanilla temp file after a delay
                setTimeout(() => { try { fs.unlinkSync(vanillaTmpPath); } catch { /* */ } }, 120_000);
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
                const relPath = vs.workspace.asRelativePath(doc.uri, false);
                let relDir = normalizeParadoxRelativeDir(path.dirname(doc.uri.fsPath));
                if (!relDir) {
                    relDir = path.dirname(relPath);
                }
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
                const modBlocks = findTopLevelBlocks(doc.getText(), idKeys);

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys, ext);

                // Build a vanilla-side file with only blocks that have matches in the mod
                // Right side = real mod file (edits sync directly to the actual document)
                const tmpDir = path.join(os.tmpdir(), 'cwtools-vanilla-compare');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const vanillaTmpPath = path.join(tmpDir, `vanilla_${path.basename(relPath)}`);

                // Reconstruct vanilla file preserving the same block order as the mod
                const vanillaLines: string[] = [];
                let matchCount = 0;
                const modText = doc.getText();
                const allModLines = modText.split('\n');

                for (const modBlock of modBlocks) {
                    const identity = blockIdentity(modBlock, idKeys);
                    if (!identity) {
                        // For unmatched blocks, include mod content as-is to keep line alignment
                        vanillaLines.push(modBlock.content);
                        continue;
                    }

                    const match = vanillaIndex.get(identity);
                    if (!match) {
                        // Block exists in mod but not vanilla — include mod content for alignment
                        vanillaLines.push(modBlock.content);
                        continue;
                    }
                    vanillaLines.push(match.block.content);
                    matchCount++;
                }

                if (matchCount === 0) {
                    vs.window.showInformationMessage('当前文件中未找到与原版匹配的代码块');
                    return;
                }

                // Include any content between/around blocks (comments, blank lines, etc.)
                // by building a full vanilla mirror of the mod file
                const vanillaFullLines: string[] = [];
                let lastEndLine = 0;
                for (const modBlock of modBlocks) {
                    // Preserve inter-block content (comments, whitespace)
                    if (modBlock.startLine > lastEndLine) {
                        for (let i = lastEndLine; i < modBlock.startLine; i++) {
                            vanillaFullLines.push(allModLines[i]!);
                        }
                    }
                    // Use matched vanilla content or original mod content
                    const identity = blockIdentity(modBlock, idKeys);
                    const match = identity ? vanillaIndex.get(identity) : undefined;
                    if (match) {
                        vanillaFullLines.push(match.block.content);
                    } else {
                        vanillaFullLines.push(modBlock.content);
                    }
                    lastEndLine = modBlock.endLine + 1;
                }
                // Trailing content after the last block
                for (let i = lastEndLine; i < allModLines.length; i++) {
                    vanillaFullLines.push(allModLines[i]!);
                }

                fs.writeFileSync(vanillaTmpPath, vanillaFullLines.join('\n'), 'utf-8');

                await vs.commands.executeCommand('vscode.diff',
                    vs.Uri.file(vanillaTmpPath), doc.uri,
                    `Vanilla vs Mod: ${path.basename(relPath)} (${matchCount} blocks)`,
                    { preview: true, viewColumn: vs.ViewColumn.Beside }
                );

                // Clean up vanilla temp file after a delay
                setTimeout(() => {
                    try { fs.unlinkSync(vanillaTmpPath); } catch { /* */ }
                }, 120_000);
            }
        )
    );

    // ── Command: Block-level migration (right-click context menu) ────────
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.vanillaCompare.migrateBlockFromVanilla',
            async (uri?: vs.Uri, startLine?: number, endLine?: number, key?: string) => {
                let modBlock: PdxBlock | null = null;
                const editor = vs.window.activeTextEditor;

                if (!uri || startLine == null || !key) {
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
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
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

                let relDir = normalizeParadoxRelativeDir(path.dirname(uri.fsPath));
                if (!relDir) {
                    const relPath = vs.workspace.asRelativePath(uri, false);
                    relDir = path.dirname(relPath);
                }

                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys, ext);
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

                if (modBlock.content === match.block.content) {
                    vs.window.showInformationMessage(`当前代码块已与原版内容一致`);
                    return;
                }

                const edit = new vs.WorkspaceEdit();
                const endLineText = doc.lineAt(endLine!).text;
                const range = new vs.Range(startLine!, 0, endLine!, endLineText.length);
                edit.replace(uri, range, match.block.content);

                const success = await vs.workspace.applyEdit(edit);
                if (success) {
                    vs.window.showInformationMessage(`已成功从原版迁移代码块: ${identity}`);
                } else {
                    vs.window.showErrorMessage(`迁移代码块失败`);
                }
            }
        )
    );

    // ── Command: File-level bulk interactive migration (editor title bar) ─
    context.subscriptions.push(
        vs.commands.registerCommand('cwtools.vanillaCompare.migrateChangedFromVanilla',
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
                const relPath = vs.workspace.asRelativePath(doc.uri, false);
                let relDir = normalizeParadoxRelativeDir(path.dirname(doc.uri.fsPath));
                if (!relDir) {
                    relDir = path.dirname(relPath);
                }
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
                const modBlocks = findTopLevelBlocks(doc.getText(), idKeys);

                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, idKeys, ext);

                const changedBlocks: { modBlock: PdxBlock; vanillaBlock: PdxBlock; identity: string }[] = [];

                for (const modBlock of modBlocks) {
                    const identity = blockIdentity(modBlock, idKeys);
                    if (!identity) continue;

                    const match = vanillaIndex.get(identity);
                    if (!match) continue;

                    if (modBlock.content !== match.block.content) {
                        changedBlocks.push({
                            modBlock,
                            vanillaBlock: match.block,
                            identity
                        });
                    }
                }

                if (changedBlocks.length === 0) {
                    vs.window.showInformationMessage('当前文件中所有匹配块已与原版内容一致');
                    return;
                }

                const items = changedBlocks.map(item => {
                    const linesChanged = item.modBlock.endLine - item.modBlock.startLine + 1;
                    return {
                        label: item.identity,
                        description: `行: ${item.modBlock.startLine + 1}-${item.modBlock.endLine + 1} (${linesChanged}行)`,
                        picked: true,
                        item
                    };
                });

                const selectedItems = await vs.window.showQuickPick(items, {
                    canPickMany: true,
                    placeHolder: '选择要从原版迁移的代码块（默认全选）',
                    ignoreFocusOut: true
                });

                if (!selectedItems || selectedItems.length === 0) {
                    return;
                }

                if (selectedItems.length >= 10) {
                    const confirm = await vs.window.showWarningMessage(
                        `确认要从原版迁移这 ${selectedItems.length} 个代码块吗？这将会覆盖当前文件中的对应内容。`,
                        { modal: true },
                        '继续迁移'
                    );
                    if (confirm !== '继续迁移') {
                        return;
                    }
                }

                // 从后往前排序，避免行偏移影响
                selectedItems.sort((a, b) => b.item.modBlock.startLine - a.item.modBlock.startLine);

                const edit = new vs.WorkspaceEdit();
                for (const selected of selectedItems) {
                    const modBlock = selected.item.modBlock;
                    const vanillaBlock = selected.item.vanillaBlock;
                    const endLineText = doc.lineAt(modBlock.endLine).text;
                    const range = new vs.Range(modBlock.startLine, 0, modBlock.endLine, endLineText.length);
                    edit.replace(doc.uri, range, vanillaBlock.content);
                }

                const success = await vs.workspace.applyEdit(edit);
                if (success) {
                    vs.window.showInformationMessage(`已成功从原版迁移 ${selectedItems.length} 个代码块`);
                } else {
                    vs.window.showErrorMessage(`批量迁移代码块失败`);
                }
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
