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
import { ErrorReporter } from './ai/errorReporter';
import { getAllProfiles } from './gameProfiles';
import {
    matchPdxDefinitionType,
    parsePdxSemanticCatalog,
    type PdxDefinitionType,
} from '../shared/pdxSemanticCatalog';

function tr(en: string, zh: string): string {
    return vs.env.language.toLowerCase().startsWith('zh') ? zh : en;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdxBlock {
    key: string;
    declaredIdentity: string | null;
    requiresDeclaredIdentity: boolean;
    name: string | null;
    startLine: number;
    endLine: number;
    content: string;
}

async function getSemanticDefinitionTypes(): Promise<readonly PdxDefinitionType[]> {
    try {
        const raw = await vs.commands.executeCommand<unknown>('cwtools.ai.getSemanticCatalog', [], []);
        const catalog = parsePdxSemanticCatalog(raw);
        return catalog?.status === 'unavailable' ? [] : catalog?.definitionTypes ?? [];
    } catch (error) {
        ErrorReporter.debug('VanillaCompare', 'Active CWTools semantic catalog is unavailable', error);
        return [];
    }
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

function normalizeParadoxRelativeDir(fsPath: string): string {
    const uri = vs.Uri.file(fsPath);
    const folder = vs.workspace.getWorkspaceFolder(uri);
    return folder ? path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/') : '';
}

function getGamePath(languageId: string): string | null {
    const profiles = getAllProfiles();
    const activeProfile = profiles.find(profile => profile.languageId === languageId || profile.id === languageId)
        ?? vs.window.visibleTextEditors
            .map(editor => profiles.find(profile => profile.languageId === editor.document.languageId))
            .find((profile): profile is NonNullable<typeof profile> => !!profile);
    if (!activeProfile) return null;
    const config = vs.workspace.getConfiguration('stellarisLanguageServices');
    const configPath = config.get<string>(activeProfile.cacheSettingKey.replace('stellarisLanguageServices.', ''));
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

function findTopLevelBlocks(
    text: string,
    filePath: string,
    definitionTypes: readonly PdxDefinitionType[],
): PdxBlock[] {
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
                    const definition = matchPdxDefinitionType(definitionTypes, filePath, resolvedKey);
                    const declaredIdentity = definition?.nameField
                        ? extractBlockField(tokens, i, definition.nameField)
                        : null;
                    const blockName = extractBlockField(tokens, i, 'name');
                    blocks.push({
                        key: resolvedKey,
                        declaredIdentity,
                        requiresDeclaredIdentity: !!definition?.nameField,
                        name: blockName,
                        startLine: startIdx,
                        endLine: endIdx,
                        content,
                    });
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
 * CWTools name_field is authoritative. Named assets use their structural name,
 * while ordinary definitions use the top-level key.
 */
function blockIdentity(block: PdxBlock): string | null {
    if (block.declaredIdentity) return block.declaredIdentity;
    if (block.requiresDeclaredIdentity) return null;
    if (block.name) return block.name;
    return block.key;
}

/**
 * Scan vanilla directory and build a unified block index.
 * Maps block identity → { block, filePath } across vanilla files matching the current extension.
 */
async function buildVanillaBlockIndex(
    vanillaRoot: string,
    relDir: string,
    definitionTypes: readonly PdxDefinitionType[],
    ext: string = '.txt',
): Promise<Map<string, { block: PdxBlock; filePath: string }>> {
    const index = new Map<string, { block: PdxBlock; filePath: string }>();
    const ambiguous = new Set<string>();
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
        for (const block of findTopLevelBlocks(content, filePath, definitionTypes)) {
            const identity = blockIdentity(block);
            if (!identity || ambiguous.has(identity)) continue;
            if (index.has(identity)) {
                index.delete(identity);
                ambiguous.add(identity);
                continue;
            }
            index.set(identity, { block, filePath });
        }
    }
    return index;
}

// ─── Registration ─────────────────────────────────────────────────────────────

const ACTIVE_COMPARISON_CONTEXT = 'cwtools.vanillaCompare.activeComparison';

export function registerVanillaCompare(context: vs.ExtensionContext): void {
    const comparisonDocuments = new Set<string>();

    const refreshActiveComparisonContext = () => {
        const activeUri = vs.window.activeTextEditor?.document.uri.toString();
        const activeComparison = !!activeUri && comparisonDocuments.has(activeUri);
        void vs.commands.executeCommand('setContext', ACTIVE_COMPARISON_CONTEXT, activeComparison);
    };

    const markComparisonDocument = (uri: vs.Uri) => {
        comparisonDocuments.add(uri.toString());
        refreshActiveComparisonContext();
        setTimeout(refreshActiveComparisonContext, 250);
    };

    context.subscriptions.push(
        vs.window.onDidChangeActiveTextEditor(refreshActiveComparisonContext),
        vs.window.onDidChangeVisibleTextEditors(editors => {
            const visibleUris = new Set(editors.map(editor => editor.document.uri.toString()));
            for (const uri of comparisonDocuments) {
                if (!visibleUris.has(uri)) {
                    comparisonDocuments.delete(uri);
                }
            }
            refreshActiveComparisonContext();
        })
    );
    refreshActiveComparisonContext();

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
                    
                    const ext = path.extname(uri.fsPath).toLowerCase();
                    const isShader = ext === '.shader' || ext === '.fxh';
                    if (isShader) {
                        vs.window.showInformationMessage(tr('Shader files do not support block-level comparison. Opening a full file comparison instead.', 'Shader 文件不支持块级对比，已自动为您打开文件级全量对比'));
                        vs.commands.executeCommand('cwtools.vanillaCompare.fileDiff');
                        return;
                    }

                    const definitionTypes = await getSemanticDefinitionTypes();
                    const blocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);
                    modBlock = findEnclosingBlock(blocks, editor.selection.active.line);
                    if (!modBlock) {
                        const relFilePath = normalizeParadoxRelativeDir(uri.fsPath);
                        const langId = doc.languageId;
                        const vanillaRoot = getGamePath(langId);
                        const vanillaFilePath = (relFilePath && vanillaRoot) ? path.join(vanillaRoot, relFilePath) : null;
                        if (vanillaFilePath && fs.existsSync(vanillaFilePath)) {
                            const openFullDiff = tr('Open full comparison', '打开全量对比');
                            const action = await vs.window.showInformationMessage(
                                tr('The cursor is not inside a valid Paradox block. Open a full file comparison instead?', '当前光标不在任何有效的 Paradox 代码块内，是否要进行文件级全量对比？'),
                                openFullDiff
                            );
                            if (action === openFullDiff) {
                                vs.commands.executeCommand('cwtools.vanillaCompare.fileDiff');
                            }
                            return;
                        }

                        vs.window.showInformationMessage(tr('The cursor is not inside any code block.', '光标不在任何代码块内'));
                        return;
                    }
                    startLine = modBlock.startLine;
                    endLine = modBlock.endLine;
                    key = modBlock.key;
                }

                const doc = await vs.workspace.openTextDocument(uri);
                const langId = doc.languageId;
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
                
                const isShader = ext === '.shader' || ext === '.fxh';
                if (isShader) {
                    vs.window.showInformationMessage(tr('Shader files do not support block-level comparison. Opening a full file comparison instead.', 'Shader 文件不支持块级对比，已自动为您打开文件级全量对比'));
                    vs.commands.executeCommand('cwtools.vanillaCompare.fileDiff');
                    return;
                }

                const vanillaRoot = getGamePath(langId);
                if (!vanillaRoot) {
                    vs.window.showWarningMessage(tr('The vanilla game path is not configured. Configure stellarisLanguageServices.cache.* in settings.', '未配置原版游戏路径，请在设置中配置 stellarisLanguageServices.cache.*'));
                    return;
                }

                const definitionTypes = await getSemanticDefinitionTypes();

                if (!modBlock) {
                    const blocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);
                    modBlock = blocks.find(b => b.startLine === startLine && b.key === key) ?? null;
                }
                if (!modBlock) return;

                let relDir = normalizeParadoxRelativeDir(path.dirname(uri.fsPath));
                if (!relDir) {
                    const relPath = vs.workspace.asRelativePath(uri, false);
                    relDir = path.dirname(relPath);
                }

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, definitionTypes, ext);
                const identity = blockIdentity(modBlock);
                if (!identity) {
                    vs.window.showInformationMessage(tr('Could not determine a unique identifier for the current block (missing id or name).', '无法确定当前代码块的唯一标识（缺少 id 或 name）'));
                    return;
                }

                const match = vanillaIndex.get(identity);

                if (!match) {
                    vs.window.showInformationMessage(tr(`No matching block was found in vanilla: ${identity}`, `原版中未找到代码块: ${identity}`));
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
                markComparisonDocument(uri);

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
                    vs.window.showWarningMessage(tr('The vanilla game path is not configured. Configure stellarisLanguageServices.cache.* in settings.', '未配置原版游戏路径，请在设置中配置 stellarisLanguageServices.cache.*'));
                    return;
                }

                const definitionTypes = await getSemanticDefinitionTypes();
                const relPath = vs.workspace.asRelativePath(doc.uri, false);
                let relDir = normalizeParadoxRelativeDir(path.dirname(doc.uri.fsPath));
                if (!relDir) {
                    relDir = path.dirname(relPath);
                }
                const ext = path.extname(doc.uri.fsPath).toLowerCase();

                // 优先使用 Git 风格的物理同名文件进行全量直接比对
                const relFilePath = normalizeParadoxRelativeDir(doc.uri.fsPath);
                const vanillaFilePath = relFilePath ? path.join(vanillaRoot, relFilePath) : null;
                if (vanillaFilePath && fs.existsSync(vanillaFilePath)) {
                    await vs.commands.executeCommand('vscode.diff',
                        vs.Uri.file(vanillaFilePath), doc.uri,
                        `Vanilla vs Mod (Full): ${path.basename(doc.uri.fsPath)}`,
                        { preview: true, viewColumn: vs.ViewColumn.Beside }
                    );
                    markComparisonDocument(doc.uri);
                    return;
                }

                // 只有原版无同名物理文件时，才 Fallback 使用 block 对齐拼装对比
                const modBlocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);

                // Build vanilla block index for the directory
                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, definitionTypes, ext);

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
                    const identity = blockIdentity(modBlock);
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
                    vs.window.showInformationMessage(tr('No blocks in the current file matched vanilla.', '当前文件中未找到与原版匹配的代码块'));
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
                    const identity = blockIdentity(modBlock);
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
                markComparisonDocument(doc.uri);

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
                    
                    const ext = path.extname(uri.fsPath).toLowerCase();
                    const isShader = ext === '.shader' || ext === '.fxh';
                    if (isShader) {
                        vs.window.showWarningMessage(tr('Shader files do not support block-level migration.', 'Shader 文件不支持块级迁移'));
                        return;
                    }

                    const doc = editor.document;
                    const definitionTypes = await getSemanticDefinitionTypes();
                    const blocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);
                    modBlock = findEnclosingBlock(blocks, editor.selection.active.line);
                    if (!modBlock) {
                        vs.window.showInformationMessage(tr('The cursor is not inside any code block.', '光标不在任何代码块内'));
                        return;
                    }
                    startLine = modBlock.startLine;
                    endLine = modBlock.endLine;
                    key = modBlock.key;
                }

                const doc = await vs.workspace.openTextDocument(uri);
                const langId = doc.languageId;
                const ext = path.extname(doc.uri.fsPath).toLowerCase();

                const isShader = ext === '.shader' || ext === '.fxh';
                if (isShader) {
                    vs.window.showWarningMessage(tr('Shader files do not support block-level migration.', 'Shader 文件不支持块级迁移'));
                    return;
                }

                const vanillaRoot = getGamePath(langId);
                if (!vanillaRoot) {
                    vs.window.showWarningMessage(tr('The vanilla game path is not configured. Configure stellarisLanguageServices.cache.* in settings.', '未配置原版游戏路径，请在设置中配置 stellarisLanguageServices.cache.*'));
                    return;
                }

                const definitionTypes = await getSemanticDefinitionTypes();

                if (!modBlock) {
                    const blocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);
                    modBlock = blocks.find(b => b.startLine === startLine && b.key === key) ?? null;
                }
                if (!modBlock) return;

                let relDir = normalizeParadoxRelativeDir(path.dirname(uri.fsPath));
                if (!relDir) {
                    const relPath = vs.workspace.asRelativePath(uri, false);
                    relDir = path.dirname(relPath);
                }

                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, definitionTypes, ext);
                const identity = blockIdentity(modBlock);
                if (!identity) {
                    vs.window.showInformationMessage(tr('Could not determine a unique identifier for the current block (missing id or name).', '无法确定当前代码块的唯一标识（缺少 id 或 name）'));
                    return;
                }

                const match = vanillaIndex.get(identity);
                if (!match) {
                    vs.window.showInformationMessage(tr(`No matching block was found in vanilla: ${identity}`, `原版中未找到代码块: ${identity}`));
                    return;
                }

                if (modBlock.content === match.block.content) {
                    vs.window.showInformationMessage(tr('The current block already matches vanilla.', '当前代码块已与原版内容一致'));
                    return;
                }

                const edit = new vs.WorkspaceEdit();
                const endLineText = doc.lineAt(endLine!).text;
                const range = new vs.Range(startLine!, 0, endLine!, endLineText.length);
                edit.replace(uri, range, match.block.content);

                const success = await vs.workspace.applyEdit(edit);
                if (success) {
                    vs.window.showInformationMessage(tr(`Migrated block from vanilla: ${identity}`, `已成功从原版迁移代码块: ${identity}`));
                } else {
                    vs.window.showErrorMessage(tr('Failed to migrate block.', '迁移代码块失败'));
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
                    vs.window.showWarningMessage(tr('The vanilla game path is not configured. Configure stellarisLanguageServices.cache.* in settings.', '未配置原版游戏路径，请在设置中配置 stellarisLanguageServices.cache.*'));
                    return;
                }

                const definitionTypes = await getSemanticDefinitionTypes();
                const relPath = vs.workspace.asRelativePath(doc.uri, false);
                let relDir = normalizeParadoxRelativeDir(path.dirname(doc.uri.fsPath));
                if (!relDir) {
                    relDir = path.dirname(relPath);
                }
                const ext = path.extname(doc.uri.fsPath).toLowerCase();
                const modBlocks = findTopLevelBlocks(doc.getText(), doc.uri.fsPath, definitionTypes);

                const vanillaIndex = await buildVanillaBlockIndex(vanillaRoot, relDir, definitionTypes, ext);

                const changedBlocks: { modBlock: PdxBlock; vanillaBlock: PdxBlock; identity: string }[] = [];

                for (const modBlock of modBlocks) {
                    const identity = blockIdentity(modBlock);
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
                    vs.window.showInformationMessage(tr('All matching blocks in the current file already match vanilla.', '当前文件中所有匹配块已与原版内容一致'));
                    return;
                }

                const items = changedBlocks.map(item => {
                    const linesChanged = item.modBlock.endLine - item.modBlock.startLine + 1;
                    return {
                        label: item.identity,
                        description: tr(`Lines: ${item.modBlock.startLine + 1}-${item.modBlock.endLine + 1} (${linesChanged} lines)`, `行: ${item.modBlock.startLine + 1}-${item.modBlock.endLine + 1} (${linesChanged}行)`),
                        picked: true,
                        item
                    };
                });

                const selectedItems = await vs.window.showQuickPick(items, {
                    canPickMany: true,
                    placeHolder: tr('Select blocks to migrate from vanilla (all selected by default)', '选择要从原版迁移的代码块（默认全选）'),
                    ignoreFocusOut: true
                });

                if (!selectedItems || selectedItems.length === 0) {
                    return;
                }

                if (selectedItems.length >= 10) {
                    const continueMigration = tr('Continue migration', '继续迁移');
                    const confirm = await vs.window.showWarningMessage(
                        tr(
                            `Migrate ${selectedItems.length} blocks from vanilla? This will overwrite the matching content in the current file.`,
                            `确认要从原版迁移这 ${selectedItems.length} 个代码块吗？这将会覆盖当前文件中的对应内容。`,
                        ),
                        { modal: true },
                        continueMigration
                    );
                    if (confirm !== continueMigration) {
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
                    vs.window.showInformationMessage(tr(`Migrated ${selectedItems.length} blocks from vanilla.`, `已成功从原版迁移 ${selectedItems.length} 个代码块`));
                } else {
                    vs.window.showErrorMessage(tr('Failed to migrate blocks in bulk.', '批量迁移代码块失败'));
                }
            }
        )
    );

    // ── Event: Clear cache on config change ────────────────────────────────
    context.subscriptions.push(
        vs.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('stellarisLanguageServices.cache')) {
                vanillaFileCache.clear();
            }
        })
    );
}
