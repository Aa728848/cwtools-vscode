/**
 * File Tool Handler — read, write, edit, patch, and directory operations.
 *
 * Includes the OpenCode Replacer Suite (8 fuzzy-match strategies) ported from
 * opencode/packages/opencode/src/tool/edit.ts.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { parsePdx, PdxNode } from '../../guiParser';
import type { ValidationError } from '../types';
import { getCachedFile, setCachedFile } from '../fileCache';
import { fuzzyReplace } from './replacerSuite';

// ─── Shared file-system helpers ──────────────────────────────────────────────

/** Recursively find files with a given extension under `dir`. */
export function findFiles(dir: string, ext: string, maxFiles = 500): string[] {
    const results: string[] = [];
    try { walkDir(dir, ext, results, maxFiles); } catch { /* skip */ }
    return results;
}

function walkDir(dir: string, ext: string, results: string[], maxFiles: number): void {
    if (results.length >= maxFiles) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (results.length >= maxFiles) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walkDir(fullPath, ext, results, maxFiles);
            }
        } else if (entry.name.endsWith(ext)) {
            results.push(fullPath);
        }
    }
}

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties FileToolHandler reads from the executor. */
export interface FileToolContext {
    readonly workspaceRoot: string;
    fileWriteMode: 'confirm' | 'auto';
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    onAutoWritten?: (file: string, isNewFile: boolean) => void;
    vfsOverlay?: Map<string, string>;
    vfsLocks?: Map<string, Promise<void>>;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class FileToolHandler {
    /** Per-file edit failure counter — used to escalate .yml errors */
    private editFailCount = new Map<string, number>();

    constructor(private ctx: FileToolContext) { }

    private async executeWithLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
        if (!this.ctx.vfsLocks) return operation();

        const prevLock = this.ctx.vfsLocks.get(filePath) || Promise.resolve();
        let release!: () => void;
        const newLock = new Promise<void>(resolve => release = resolve);
        
        this.ctx.vfsLocks.set(filePath, prevLock.then(() => newLock));
        await prevLock;
        
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private resolveAndAssertInWorkspace(filePath: string): string {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.ctx.workspaceRoot, filePath);
        const normalized = path.resolve(absolutePath);
        
        const bypassSandbox = vs.workspace.getConfiguration('cwtools.ai.developer').get<boolean>('disableSecuritySandbox') === true;
        if (bypassSandbox) {
            return normalized;
        }

        const isWindows = process.platform === 'win32';
        const checkPath = isWindows ? normalized.toLowerCase() : normalized;
        
        // 1. Check primary workspace root (from context)
        const wsRoot = path.resolve(this.ctx.workspaceRoot);
        const checkWsRoot = isWindows ? wsRoot.toLowerCase() : wsRoot;
        if (checkPath.startsWith(checkWsRoot)) {
            return normalized;
        }

        // 2. Check all other VS Code workspace folders (multi-root support)
        const wsFolders = vs.workspace.workspaceFolders;
        if (wsFolders) {
            for (const folder of wsFolders) {
                const folderRoot = path.resolve(folder.uri.fsPath);
                const checkFolderRoot = isWindows ? folderRoot.toLowerCase() : folderRoot;
                if (checkPath.startsWith(checkFolderRoot)) {
                    return normalized;
                }
            }
        }

        throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
    }

    private readTextFile(filePath: string): { content: string; hasBom: boolean } {
        if (this.ctx.vfsOverlay && this.ctx.vfsOverlay.has(filePath)) {
            let content = this.ctx.vfsOverlay.get(filePath)!;
            const hasBom = content.charCodeAt(0) === 0xFEFF;
            if (hasBom) content = content.slice(1);
            return { content, hasBom };
        }
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false };
        let content = fs.readFileSync(filePath, 'utf-8');
        const hasBom = content.charCodeAt(0) === 0xFEFF;
        if (hasBom) content = content.slice(1);
        return { content, hasBom };
    }

    private writeTextFile(filePath: string, content: string, hasBom: boolean, requestedEncoding?: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let shouldAddBom = hasBom;
        if (requestedEncoding) {
            shouldAddBom = requestedEncoding === 'utf8bom';
        } else if (filePath.endsWith('.yml')) {
            shouldAddBom = true;
        } else {
            shouldAddBom = false; // Fallback to no BOM for all other files if requestedEncoding is not set and hasBom is false for a new file.
            if (hasBom) shouldAddBom = true; // Preserve an existing BOM
        }

        const finalContent = shouldAddBom ? '\uFEFF' + content : content;
        if (this.ctx.vfsOverlay) {
            this.ctx.vfsOverlay.set(filePath, finalContent);
        } else {
            fs.writeFileSync(filePath, finalContent, 'utf-8');
        }
    }

    // ─── readFile ────────────────────────────────────────────────────────────

    async readFile(args: { file: string; startLine?: number; endLine?: number }): Promise<import('../types').ReadFileResult> {
        try {
            args.file = this.resolveAndAssertInWorkspace(args.file);

            // ── Cache: serve full-file reads from memory ───────────────────
            if (!args.startLine && !args.endLine) {
                const cached = getCachedFile(args.file);
                if (cached !== null) {
                    const lines = cached.split('\n');
                    const totalLines = lines.length;
                    let threshold = 150;
                    if (args.file.endsWith('.gui') || args.file.endsWith('.gfx') || args.file.endsWith('.txt') || args.file.endsWith('.yml')) {
                        threshold = 500;
                    }
                    if (totalLines > threshold) {
                        return {
                            content: '',
                            totalLines,
                            truncated: true,
                            _hint: `File has ${totalLines} lines — too long to read in full. Suggestion: call document_symbols("${args.file}") to locate the section you need, then re-invoke read_file with startLine and endLine parameters (max ${threshold} lines per call).`,
                        };
                    }
                    return { content: cached, totalLines, truncated: false };
                }
            }
            // ────────────────────────────────────────────────────────────────

            let threshold = 150;
            if (args.file.endsWith('.gui') || args.file.endsWith('.gfx') || args.file.endsWith('.txt') || args.file.endsWith('.yml')) {
                threshold = 500;
            }

            // Single-pass streaming: count total lines AND extract the requested slice simultaneously.
            // When no range is specified, we need the full count to decide whether the file is too large.
            // When a range IS specified, we still need totalLines for the response metadata.
            const start = args.startLine ? Math.max(1, args.startLine) : 1;
            const requestedEnd = args.endLine ?? Infinity; // resolved after counting

            const slice: string[] = [];
            let totalLines = 0;
            let sliceFinished = false;

            try {
                const rl = readline.createInterface({
                    input: fs.createReadStream(args.file, { encoding: 'utf-8' }),
                    crlfDelay: Infinity,
                });
                for await (const line of rl) {
                    totalLines++;
                    if (!sliceFinished) {
                        if (totalLines >= start && totalLines <= requestedEnd) {
                            slice.push(line);
                        }
                        if (totalLines > requestedEnd) {
                            sliceFinished = true;
                            // If we also have startLine/endLine, we still need totalLines,
                            // so we continue counting. But if no endLine was given and file
                            // is small, we just collect everything anyway.
                        }
                    }
                }
            } catch (e) {
                return { content: `Error reading file:${String(e)}`, totalLines: 0, truncated: false };
            }

            // Cache the full content for potential re-reads within this loop
            try {
                const fullContent = (args.startLine !== undefined || args.endLine !== undefined)
                    ? null  // partial read — don't cache
                    : slice.join('\n');
                if (fullContent !== null) {
                    const stat = fs.statSync(args.file);
                    setCachedFile(args.file, fullContent, stat.mtimeMs);
                }
            } catch { /* stat may fail; skip cache */ }
            
            const end = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;

            if (totalLines > threshold && !args.startLine && !args.endLine) {
                return {
                    content: '',
                    totalLines,
                    truncated: true,
                    _hint: `File has ${totalLines} lines — too long to read in full. ` +
                        `Suggestion: call document_symbols("${args.file}") to locate the section you need, ` +
                        `then re-invoke read_file with startLine and endLine parameters (max ${threshold} lines per call).`,
                };
            }

            // Strip BOM from first line (readline doesn't strip it, but readTextFile/editFile do,
            // causing BOM mismatch when the AI copies text from read_file into edit_file's oldString)
            if (slice.length > 0 && slice[0]!.charCodeAt(0) === 0xFEFF) {
                slice[0] = slice[0]!.slice(1);
            }

            // Format with succinct line prefix (saves ~1 token per line vs "1234: ")
            const numbered = slice.map((l, i) => `${start + i} | ${l}`).join('\n');

            const MAX_READ_CHARS = 12000;
            const truncated = numbered.length > MAX_READ_CHARS;
            let resultContent: string;
            if (truncated) {
                // Truncate at line boundary to avoid broken last line
                const lines2 = numbered.split('\n');
                let charCount = 0;
                let lineCount = 0;
                for (const line of lines2) {
                    if (charCount + line.length + 1 > MAX_READ_CHARS) break;
                    charCount += line.length + 1;
                    lineCount++;
                }
                resultContent = lines2.slice(0, Math.max(1, lineCount)).join('\n');
            } else {
                resultContent = numbered;
            }

            const lastLineReturned = start + (truncated
                ? resultContent.split('\n').length - 1
                : slice.length - 1);

            return {
                content: truncated
                    ? resultContent + `\n[... truncated at ~${MAX_READ_CHARS} chars ...]`
                    : resultContent,
                totalLines,
                truncated,
                ...(truncated ? {
                    _hint: `Output truncated. Total lines: ${totalLines}. ` +
                        `Last displayed line: ~${lastLineReturned}. ` +
                        `To read the next section, call read_file with startLine=${lastLineReturned + 1}.`,
                } : {}),
            };
        } catch (e) {
            return { content: `Error reading file:${String(e)}`, totalLines: 0, truncated: false };
        }
    }

    // ─── writeFile ───────────────────────────────────────────────────────────

    async writeFile(args: { file: string; content: string; encoding?: string }): Promise<import('../types').WriteFileResult> {
        return this.executeWithLock(args.file, async () => {
            try {
                args.file = this.resolveAndAssertInWorkspace(args.file);
                
                // 安全阻断：禁止覆写（但允许 .md 格式被覆写）
                const lowerFile = args.file.toLowerCase();
                if (fs.existsSync(args.file) && !this.ctx.vfsOverlay && !lowerFile.endsWith('.md')) {
                    return { success: false, message: "File already exists. To prevent destructive overwrites, write_file cannot overwrite existing files — use edit_file, multiedit, or write_localisation (for .yml) instead. Only .md documents can be overwritten." };
                }

                const { content: originalContent, hasBom } = this.readTextFile(args.file);
                this.ctx.onBeforeFileWrite?.(args.file, originalContent);

                const _diff = this.buildUnifiedDiff(args.file, originalContent ?? '', args.content);

                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply && !this.ctx.vfsOverlay) {
                    const messageId = `write_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(args.file, args.content, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User cancelled the write operation' };
                    }
                } else if (this.ctx.onAutoWritten && !this.ctx.vfsOverlay) {
                    const isNewFile = !fs.existsSync(args.file);
                    this.ctx.onAutoWritten(args.file, isNewFile);
                }

                this.writeTextFile(args.file, args.content, hasBom, args.encoding);
                return { success: true, message: `File written: ${args.file}` };
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }
        });
    }

    // ─── editFile (OpenCode-style) ───────────────────────────────────────────

    async editFile(args: {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
        encoding?: string;
    }): Promise<import('../types').EditFileResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: 'Error: missing or invalid "filePath" parameter. Must provide an absolute file path. Example: edit_file({ "filePath": "/path/to/file.txt", "oldString": "...", "newString": "..." })',
            } as any;
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = this.resolveAndAssertInWorkspace(args.filePath);
            } catch (e) {
                return { success: false, message: String(e) };
            }
            const filePath = args.filePath;
            const { content: originalContent, hasBom } = this.readTextFile(filePath);

            this.ctx.onBeforeFileWrite?.(filePath, args.oldString === '' ? null : originalContent);

            let newContent: string;
            if (args.oldString === '') {
                newContent = args.newString;
            } else {
                if (args.oldString === args.newString) {
                    return { success: false, message: 'oldString and newString are identical — no change needed' };
                }
                const ending = this.detectLineEnding(originalContent);
                const old = this.convertLineEnding(this.normalizeLineEndings(args.oldString), ending);
                const next = this.convertLineEnding(this.normalizeLineEndings(args.newString), ending);
                try {
                    newContent = this.replace(originalContent, old, next, args.replaceAll ?? false);
                } catch (e) {
                    const errMsg = String(e);
                    // For .yml files, escalate with per-file failure count
                    if (filePath.endsWith('.yml')) {
                        const failCount = (this.editFailCount.get(filePath) || 0) + 1;
                        this.editFailCount.set(filePath, failCount);
                        return {
                            success: false,
                            message: errMsg + `\n\n🚨 YML BLOCKED (failure #${failCount}): You MUST NOT use edit_file/multiedit for .yml files. Use write_localisation(filePath, language, entries) instead — it handles encoding, formatting, and insertion correctly.`,
                        };
                    }
                    return { success: false, message: errMsg };
                }
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply && !this.ctx.vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `edit_${Date.now()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !this.ctx.vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            const diagnostics = await this.getLspDiagnosticsForFile(filePath);
            const editedLines = new Set<number>();
            const newLines = args.newString.split('\n');
            const newContentLines = newContent.split('\n');
            for (let li = 0; li < newContentLines.length; li++) {
                if (newLines.some(nl => {
                    const trimmed = nl.trim();
                    return trimmed.length > 8 && newContentLines[li]!.includes(trimmed);
                })) {
                    for (let r = -10; r <= 10; r++) {
                        const idx = li + r;
                        if (idx >= 0 && idx < newContentLines.length) editedLines.add(idx);
                    }
                }
            }
            const nearbyDiags = editedLines.size > 0
                ? diagnostics.filter(d => editedLines.has(d.line))
                : diagnostics;
            let message = `File updated: ${path.basename(filePath)}`;
            const errors = nearbyDiags.filter(d => d.severity === 'error');
            if (errors.length > 0) {
                message += `\n\nLSP detected ${errors.length} error(s) — please fix:\n` +
                    errors.slice(0, 5).map(e => `  Line ${e.line + 1}: ${e.message}`).join('\n');
            }
            return {
                success: true, message, diff, diagnostics: nearbyDiags,
                ...(diagnostics.length > nearbyDiags.length ? { totalDiagnostics: diagnostics.length } : {}),
            } as any;
        });
    }

    // ─── astMutate ───────────────────────────────────────────────────────────

    async astMutate(args: import('../types').AstMutateArgs): Promise<import('../types').AstMutateResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: 'Error: missing or invalid "filePath" parameter. Must provide an absolute file path.',
            } as any;
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = this.resolveAndAssertInWorkspace(args.filePath);
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
        const { content: originalContent, hasBom } = this.readTextFile(filePath);
        this.ctx.onBeforeFileWrite?.(filePath, originalContent);

        let nodes: PdxNode[] = [];
        try {
            nodes = parsePdx(originalContent);
        } catch (e) {
            return { success: false, message: `AST parsing failed: ${e}` };
        }

        let currentLevel = nodes;
        let matchedNode: PdxNode | undefined;
        let parentContext = '';

        for (const target of args.targetPath) {
            const fuzzyMatch = currentLevel.find(n => {
                const kv = n.value !== undefined ? `${n.key}=${n.value}` : n.key;
                return kv.toLowerCase().includes(target.toLowerCase());
            });

            if (!fuzzyMatch) {
                const available = currentLevel.map(n => n.value !== undefined ? `${n.key}=${n.value}` : n.key).slice(0, 10).join(', ');
                return {
                    success: false,
                    message: `AST traversal failed. Could not find node matching '${target}' in ${parentContext || 'root'}. Available nodes: [${available}${currentLevel.length > 10 ? '...' : ''}]`
                };
            }

            matchedNode = fuzzyMatch;
            currentLevel = fuzzyMatch.children || [];
            parentContext = target;
        }

        if (!matchedNode) {
            return { success: false, message: 'AST traversal failed. Empty target path?' };
        }

        if ((args.action === 'append' || args.action === 'prepend') && matchedNode.endLine === undefined) {
             return { success: false, message: `AST node '${matchedNode.key}' is not a block. Cannot ${args.action}.` };
        }

        const lines = originalContent.split('\n');
        const startLineIdx = Math.max(0, matchedNode.line - 1);
        const endLineIdx = matchedNode.endLine ? Math.max(0, matchedNode.endLine - 1) : startLineIdx;

        // Intelligent indentation tracking
        const baseIndentMatch = (lines[startLineIdx] || '').match(/^[\s\t]*/);
        const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
        const targetIndent = (args.action === 'append' || args.action === 'prepend') ? baseIndent + '\t' : baseIndent;
        const ending = originalContent.includes('\r\n') ? '\r\n' : '\n';
        
        const rawPayloadLines = args.payload ? args.payload.replace(/\r\n/g, '\n').split('\n') : [];
        const minIndent = rawPayloadLines.filter(l => l.trim().length > 0).reduce((min, l) => {
             const match = l.match(/^[\s\t]*/);
             return Math.min(min, match ? match[0].length : 0);
        }, Infinity);

        const payloadLines = rawPayloadLines.map(l => {
            if (l.trim().length === 0) return (ending === '\r\n' ? '\r' : '');
            const relativeLine = l.substring(minIndent === Infinity ? 0 : minIndent);
            return targetIndent + relativeLine + (ending === '\r\n' ? '\r' : '');
        });

        const newLines = [...lines];
        if (args.action === 'replace') {
            newLines.splice(startLineIdx, endLineIdx - startLineIdx + 1, ...payloadLines);
        } else if (args.action === 'delete') {
            newLines.splice(startLineIdx, endLineIdx - startLineIdx + 1);
        } else if (args.action === 'prepend') {
            newLines.splice(startLineIdx + 1, 0, ...payloadLines);
        } else if (args.action === 'append') {
            newLines.splice(endLineIdx, 0, ...payloadLines);
        }

        const newContent = newLines.join('\n');
        const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
            const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `ast_${Date.now()}`);
            if (!confirmed) {
                return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        try {
            this.writeTextFile(filePath, newContent, hasBom, args.encoding);
        } catch (e) {
            return { success: false, message: `Write failed: ${String(e)}` };
        }

            const diagnostics = await this.getLspDiagnosticsForFile(filePath);
            return {
                success: true,
                nodeFound: true,
                message: `AST surgery successful (${args.action} on ${args.targetPath.join(' -> ')}). File updated: ${path.basename(filePath)}`,
                diff,
                diagnostics
            };
        });
    }

    // ─── multiEdit ───────────────────────────────────────────────────────────

    async multiEdit(args: {
        filePath: string;
        edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
        encoding?: string;
    }): Promise<import('../types').EditFileResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: 'Error: missing or invalid "filePath" parameter. Must provide an absolute file path.',
            } as any;
        }
        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = this.resolveAndAssertInWorkspace(args.filePath);
            } catch (e) {
                return { success: false, message: String(e) };
            }
            const filePath = args.filePath;
        const { content: originalContent, hasBom } = this.readTextFile(filePath);
        let content = originalContent;
        this.ctx.onBeforeFileWrite?.(filePath, originalContent || null);

        const ending = this.detectLineEnding(content);
        const errors: string[] = [];

        for (let i = 0; i < args.edits.length; i++) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const edit = args.edits[i]!;
            if (edit.oldString === edit.newString) continue;
            const old = this.convertLineEnding(this.normalizeLineEndings(edit.oldString), ending);
            const next = this.convertLineEnding(this.normalizeLineEndings(edit.newString), ending);
            try {
                content = this.replace(content, old, next, edit.replaceAll ?? false);
            } catch (e) {
                // P1 Fix: fail-fast — stop on first error to avoid misleading messages
                // from subsequent edits operating on an inconsistent intermediate state
                errors.push(`Edit block #${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
                break;
            }
        }

        if (errors.length > 0) {
            let msg = `${errors.length} edit block(s) failed — file was not modified:\n${errors.join('\n')}`;
            if (filePath.endsWith('.yml')) {
                const failCount = (this.editFailCount.get(filePath) || 0) + 1;
                this.editFailCount.set(filePath, failCount);
                msg += `\n\n🚨 YML BLOCKED (failure #${failCount}): You MUST NOT use multiedit for .yml files. Use write_localisation(filePath, language, entries) instead — it handles encoding, formatting, and insertion correctly.`;
            }
            return { success: false, message: msg };
        }

        const diff = this.buildUnifiedDiff(filePath, originalContent, content);
        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
            const messageId = `multiedit_${crypto.randomUUID()}`;
            const confirmed = await this.ctx.onPendingWrite(filePath, content, messageId);
            if (!confirmed) {
                return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        try {
            this.writeTextFile(filePath, content, hasBom, args.encoding);
        } catch (e) {
            return { success: false, message: `Write failed: ${String(e)}` };
        }

        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        // P0-1 Fix: use in-memory `content` directly instead of re-reading the file
        // (eliminates redundant I/O and TOCTOU risk — `content` is exactly what was just written)
        // P2 Fix: stricter matching (min 8 chars) to reduce false positives
        const editedRegionLines = new Set<number>();
        const finalLines = content.split('\n');
        for (const edit of args.edits) {
            const editLines = edit.newString.split('\n');
            for (let li = 0; li < finalLines.length; li++) {
                if (editLines.some(el => {
                    const trimmed = el.trim();
                    return trimmed.length > 8 && finalLines[li]!.includes(trimmed);
                })) {
                    for (let r = -10; r <= 10; r++) {
                        const idx = li + r;
                        if (idx >= 0 && idx < finalLines.length) editedRegionLines.add(idx);
                    }
                }
            }
        }
        let nearbyDiags = editedRegionLines.size > 0
            ? diagnostics.filter(d => editedRegionLines.has(d.line))
            : diagnostics;
        
        // Cap diagnostics output to prevent LLM doom-loop from spammy vanilla rules
        if (nearbyDiags.length > 20) {
             const errorDiags = nearbyDiags.filter(d => d.severity === 'error');
             if (errorDiags.length >= 20) {
                 nearbyDiags = errorDiags.slice(0, 20);
             } else if (errorDiags.length > 0) {
                 nearbyDiags = [...errorDiags, ...nearbyDiags.filter(d => d.severity !== 'error').slice(0, 20 - errorDiags.length)];
             } else {
                 nearbyDiags = nearbyDiags.slice(0, 20);
             }
        }

        let message = `multiedit: ${args.edits.length} edit(s) applied to ${path.basename(filePath)}`;
        const errorDiags = nearbyDiags.filter(d => d.severity === 'error');
        if (errorDiags.length > 0) {
            message += `\n\nLSP detected ${errorDiags.length} error(s):\n` +
                errorDiags.slice(0, 5).map(e => `  Line ${e.line + 1}: ${e.message}`).join('\n');
        }
        return {
            success: true, message, diff, diagnostics: nearbyDiags,
            ...(diagnostics.length > nearbyDiags.length ? { totalDiagnostics: diagnostics.length } : {}),
        } as any;
        });
    }

    // ─── applyPatch ──────────────────────────────────────────────────────────

    async applyPatch(args: { patch: string; cwd?: string }): Promise<{
        success: boolean;
        filesChanged: string[];
        errors: string[];
    }> {
        const cwd = args.cwd ?? this.ctx.workspaceRoot;

        try {
            this.resolveAndAssertInWorkspace(cwd);
        } catch (e) {
            return { success: false, filesChanged: [], errors: [String(e)] };
        }

        interface HunkPatch {
            filePath: string;
            oldString: string;
            newString: string;
        }
        const hunks: HunkPatch[] = [];

        const lines = args.patch.split('\n');
        let currentFile: string | null = null;
        let i = 0;

        while (i < lines.length) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const line = lines[i]!;
            if (line.startsWith('--- ')) {
                const nextLine = lines[i + 1] ?? '';
                if (nextLine.startsWith('+++ ')) {
                    let filePath = nextLine.slice(4).trim();
                    if (filePath.startsWith('b/')) filePath = filePath.slice(2);
                    currentFile = path.isAbsolute(filePath)
                        ? filePath
                        : path.join(cwd, filePath);
                    try {
                        this.resolveAndAssertInWorkspace(currentFile);
                    } catch (e) {
                        return { success: false, filesChanged: [], errors: [String(e)] };
                    }
                    i += 2;
                    continue;
                }
            }
            if (line.startsWith('@@') && currentFile) {
                i++;
                const oldLines: string[] = [];
                const newLines: string[] = [];
                while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('--- ')) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const hunkLine = lines[i]!;
                    if (hunkLine.startsWith('-')) {
                        oldLines.push(hunkLine.slice(1));
                    } else if (hunkLine.startsWith('+')) {
                        newLines.push(hunkLine.slice(1));
                    } else {
                        oldLines.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine);
                        newLines.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine);
                    }
                    i++;
                }
                hunks.push({
                    filePath: currentFile,
                    oldString: oldLines.join('\n'),
                    newString: newLines.join('\n'),
                });
                continue;
            }
            i++;
        }

        if (hunks.length === 0) {
            return { success: false, filesChanged: [], errors: ['No valid hunks found in patch'] };
        }

        const byFile = new Map<string, { content: string; hasBom: boolean; hunks: HunkPatch[] }>();
        for (const hunk of hunks) {
            if (!byFile.has(hunk.filePath)) {
                const { content, hasBom } = this.readTextFile(hunk.filePath);
                byFile.set(hunk.filePath, { content, hasBom, hunks: [] });
            }
            byFile.get(hunk.filePath)!.hunks.push(hunk);
        }

        const errors: string[] = [];
        const pendingWrites: Array<{ filePath: string; newContent: string; hasBom: boolean }> = [];

        for (const [filePath, { content, hasBom, hunks: fileHunks }] of byFile) {
            let currentContent = content;
            const ending = this.detectLineEnding(currentContent);
            for (const hunk of fileHunks) {
                const old = this.convertLineEnding(this.normalizeLineEndings(hunk.oldString), ending);
                const next = this.convertLineEnding(this.normalizeLineEndings(hunk.newString), ending);
                try {
                    currentContent = this.replace(currentContent, old, next, false);
                } catch (e) {
                    errors.push(`${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (errors.length === 0) {
                pendingWrites.push({ filePath, newContent: currentContent, hasBom });
            }
        }

        if (errors.length > 0) {
            return { success: false, filesChanged: [], errors };
        }

        // P1-5 Fix: capture snapshots of original content BEFORE the confirmation loop.
        // This prevents a bug where user hand-edits a file between the confirm prompt
        // and the actual write — ensuring retract restores the true pre-AI state.
        const originalContents = new Map<string, string | null>();
        for (const { filePath } of pendingWrites) {
            const { content: prevContent } = this.readTextFile(filePath);
            originalContents.set(filePath, prevContent !== '' ? prevContent : null);
        }

        const filesChanged: string[] = [];
        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
            for (const { filePath, newContent } of pendingWrites) {
                const messageId = `patch_${crypto.randomUUID()}`;
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, messageId);
                if (!confirmed) {
                    return {
                        success: false,
                        filesChanged: [],
                        errors: [`${path.basename(filePath)}: User cancelled write — no files were modified`],
                    };
                }
            }
        } else if (this.ctx.onAutoWritten) {
            for (const { filePath } of pendingWrites) {
                this.ctx.onAutoWritten(filePath, false);
            }
        }
        for (const { filePath, newContent, hasBom } of pendingWrites) {
            this.ctx.onBeforeFileWrite?.(filePath, originalContents.get(filePath) ?? null);
            try {
                this.writeTextFile(filePath, newContent, hasBom);
                filesChanged.push(path.relative(this.ctx.workspaceRoot, filePath).replace(/\\/g, '/'));
            } catch (e) {
                errors.push(`Writing ${path.basename(filePath)} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        return {
            success: errors.length === 0,
            filesChanged,
            errors,
        };
    }

    // ─── listDirectory ───────────────────────────────────────────────────────

    async listDirectory(args: { directory: string; recursive?: boolean }): Promise<import('../types').ListDirectoryResult> {
        try {
            const dirPath = this.resolveAndAssertInWorkspace(
                path.isAbsolute(args.directory)
                    ? args.directory
                    : path.join(this.ctx.workspaceRoot, args.directory)
            );

            if (!fs.existsSync(dirPath)) {
                return { entries: [], path: dirPath };
            }

            const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];
            this.listDirRecursive(dirPath, dirPath, entries, args.recursive ?? false, 0, 3);

            return { entries: entries.slice(0, 200), path: dirPath };
        } catch (e) {
            return { entries: [], path: args.directory };
        }
    }

    private listDirRecursive(
        baseDir: string,
        currentDir: string,
        results: Array<{ name: string; type: 'file' | 'directory'; size?: number }>,
        recursive: boolean,
        depth: number,
        maxDepth: number
    ): void {
        if (depth > maxDepth || results.length >= 200) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= 200) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const relPath = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                results.push({ name: relPath + '/', type: 'directory' });
                if (recursive) {
                    this.listDirRecursive(baseDir, path.join(currentDir, entry.name), results, recursive, depth + 1, maxDepth);
                }
            } else {
                const stat = fs.statSync(path.join(currentDir, entry.name));
                results.push({ name: relPath, type: 'file', size: stat.size });
            }
        }
    }

    // ─── globFiles ───────────────────────────────────────────────────────────

    async globFiles(args: { pattern: string; limit?: number }): Promise<{ files: string[]; total: number }> {
        try {
            const limit = Math.min(args.limit ?? 200, 500);
            const uris = await vs.workspace.findFiles(args.pattern, '**/node_modules/**', limit);
            const files = uris.map(u => u.fsPath);
            return { files, total: files.length };
        } catch (e) {
            return { files: [], total: 0 };
        }
    }

    // ─── getLspDiagnosticsForFile ─────────────────────────────────────────────

    /** Wait (up to 2s) for LSP to process a file, then return its diagnostics */
    async getLspDiagnosticsForFile(filePath: string): Promise<ValidationError[]> {
        try {
            const uri = vs.Uri.file(filePath);
            try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
            // P3 Fix: debounce diagnostic events — wait 300ms after last change
            // to avoid returning incomplete diagnostics from intermediate LSP states
            await new Promise<void>((resolve) => {
                const maxTimeout = setTimeout(() => { sub.dispose(); resolve(); }, 2000);
                let debounce: ReturnType<typeof setTimeout> | null = null;
                const sub = vs.languages.onDidChangeDiagnostics((e) => {
                    if (e.uris.some(u => u.fsPath === uri.fsPath)) {
                        if (debounce) clearTimeout(debounce);
                        debounce = setTimeout(() => {
                            clearTimeout(maxTimeout); sub.dispose(); resolve();
                        }, 300);
                    }
                });
            });
            return vs.languages.getDiagnostics(uri).map(d => ({
                code: String(d.code ?? ''),
                severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                        : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                message: d.message,
                line: d.range.start.line,
                column: d.range.start.character,
            } as ValidationError));
        } catch { return []; }
    }

    // ─── OpenCode Replacer Suite ─────────────────────────────────────────────
    // Ported from: opencode/packages/opencode/src/tool/edit.ts
    // Strategies extracted to ./replacerSuite.ts for testability.

    private normalizeLineEndings(text: string): string { return text.split('\r\n').join('\n'); }
    private detectLineEnding(text: string): '\n' | '\r\n' { return text.includes('\r\n') ? '\r\n' : '\n'; }
    private convertLineEnding(text: string, ending: '\n' | '\r\n'): string {
        return ending === '\n' ? text : text.split('\n').join('\r\n');
    }

    /** Main replace: delegates to fuzzyReplace (8 strategies, first match wins) */
    replace(content: string, oldString: string, newString: string, replaceAll: boolean): string {
        return fuzzyReplace(content, oldString, newString, replaceAll);
    }

    private buildUnifiedDiff(filePath: string, original: string, modified: string): string {
        const name = path.basename(filePath);
        const oL = original.split('\n'), mL = modified.split('\n');
        let diff = `--- ${name}\n+++ ${name}\n`, changed = 0;
        let i = 0, j = 0;
        while ((i < oL.length || j < mL.length) && changed < 80) {
            if (oL[i] === mL[j]) { i++; j++; }
            else { changed++; if (i < oL.length) { diff += `- ${oL[i++]}\n`; } if (j < mL.length) { diff += `+ ${mL[j++]}\n`; } }
        }
        return changed === 0 ? diff + '(no changes)\n' : diff;
    }

    // ─── write_localisation ──────────────────────────────────────────────

    async writeLocalisation(args: {
        filePath: string;
        language: string;
        entries: Array<{ key: string; value: string; number?: number; comment?: string }>;
    }): Promise<import('../types').EditFileResult> {
        return this.executeWithLock(args.filePath, async () => {
            try {
                const filePath = this.resolveAndAssertInWorkspace(args.filePath);
                if (!filePath.toLowerCase().endsWith('.yml')) {
                    return { success: false, message: 'write_localisation only works with .yml files.' };
                }
                if (!args.entries || args.entries.length === 0) {
                    return { success: false, message: 'No entries provided.' };
                }

                const BOM = '\uFEFF';
                let lines: string[];
                let hasBom = true;
                let originalContent = '';

                if (fs.existsSync(filePath)) {
                    // Read existing file
                    const raw = await fs.promises.readFile(filePath, 'utf-8');
                    originalContent = raw;
                    hasBom = raw.startsWith(BOM);
                    const clean = hasBom ? raw.slice(1) : raw;
                    lines = clean.split(/\r?\n/);
                } else {
                    // Create new file with header
                    const lang = args.language || 'l_english';
                    lines = [`${lang}:`];
                    this.ctx.onBeforeFileWrite?.(filePath, null);
                }

                // Build a map of existing keys → line index for O(1) lookup
                const keyLineMap = new Map<string, number>();
                // Match any Stellaris loc key: leading space, key chars, colon, optional digits, then space or quote
                const keyRegex = /^\s+([\w.\-]+):\d*\s*(?:"|$)/;
                for (let i = 0; i < lines.length; i++) {
                    const m = lines[i]!.match(keyRegex);
                    if (m) keyLineMap.set(m[1]!, i);
                }

                // Process entries: update existing or append new
                const appendLines: string[] = [];
                let updated = 0, added = 0;

                for (const entry of args.entries) {
                    const num = entry.number ?? 0;
                    // Sanitize value for Stellaris yml format
                    // AI sends JSON \n → 0x0A newline; or JSON \\n → literal \n
                    // Stellaris needs literal \n (backslash+n) for in-game line breaks
                    const val = entry.value
                        .replace(/\r\n/g, String.raw`\n`)     // CRLF → literal \n
                        .replace(/\n/g, String.raw`\n`)        // LF → literal \n
                        .replace(/\r/g, '')                     // stray CR → remove
                        .replace(/\t/g, String.raw`\t`)        // tab → literal \t
                        .replace(/\u201C|\u201D/g, '"')         // smart quotes → ASCII
                        .replace(/\u2018|\u2019/g, "'");        // smart apostrophes → ASCII
                    const formattedLine = ` ${entry.key}:${num} "${val}"`;

                    if (keyLineMap.has(entry.key)) {
                        // Update existing key in-place
                        const lineIdx = keyLineMap.get(entry.key)!;
                        lines[lineIdx] = formattedLine;
                        updated++;
                    } else {
                        // Append: add section comment if provided
                        if (entry.comment) {
                            appendLines.push(` ${entry.comment}`);
                        }
                        appendLines.push(formattedLine);
                        added++;
                    }
                }

                // Append new entries at end of file
                if (appendLines.length > 0) {
                    // Remove trailing empty lines to prevent double-blank-line accumulation
                    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
                        lines.pop();
                    }
                    lines.push(...appendLines);
                }

                // Ensure file ends cleanly (remove trailing empty lines, add single newline)
                while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
                    lines.pop();
                }
                const finalContent = lines.join('\n') + '\n';
                const withBom = (hasBom ? BOM : '') + finalContent;

                if (fs.existsSync(filePath)) {
                    this.ctx.onBeforeFileWrite?.(filePath, originalContent);
                }

                // Confirm mode
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.ctx.vfsOverlay) {
                    const messageId = `writeloc_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(filePath, withBom, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User rejected localisation write.' };
                    }
                }

                // Write
                if (this.ctx.vfsOverlay) {
                    this.ctx.vfsOverlay.set(filePath, withBom);
                } else {
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    await fs.promises.writeFile(filePath, withBom, 'utf-8');
                }

                // Clear failure counter for this file since we succeeded
                this.editFailCount.delete(filePath);

                const diff = this.buildUnifiedDiff(filePath, originalContent, withBom);

                return {
                    success: true,
                    message: `Localisation updated: ${added} added, ${updated} updated. Total entries: ${args.entries.length}`,
                    diff,
                    stats: { linesAdded: added, linesRemoved: 0 },
                };
            } catch (e) {
                return { success: false, message: `write_localisation failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });
    }
}
