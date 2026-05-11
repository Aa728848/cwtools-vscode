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
    /** Step callback for real-time UI events (Fallback, overwritten by AgentToolContext) */
    onStep?: (step: import('../types').AgentStep) => void;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class FileToolHandler {
    /** Per-file edit failure counter — escalates errors for all file types */
    private editFailCount = new Map<string, number>();

    constructor(private ctx: FileToolContext) { }

    /**
     * Build tiered escalation hints based on per-file edit failure count.
     * - YML files → always redirect to write_localisation
     * - Other files → gentle hint at 3+, budget exhaustion at 5+
     */
    private buildEditEscalationHint(filePath: string, failCount: number): string {
        const basename = path.basename(filePath);
        if (filePath.endsWith('.yml')) {
            return `\n\n🚨 YML BLOCKED (failure #${failCount}): You MUST NOT use edit_file/multiedit for .yml files. Use write_localisation(filePath, language, entries) instead — it handles encoding, formatting, and insertion correctly.`;
        }
        if (failCount >= 5) {
            return `\n\n🛑 EDIT BUDGET EXHAUSTED for ${basename} (${failCount} failures). STOP editing this file. Add \`# TODO\` comments for remaining issues and move on to other files.`;
        }
        if (failCount >= 3) {
            return `\n\n⚠️ ${basename} has failed ${failCount} edits. MANDATORY: call \`read_file("${filePath}")\` to get the EXACT current content before your next edit attempt. Your oldString does not match the file.`;
        }
        return '';
    }

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

    private readTextFile(filePath: string, context?: import('../types').AgentToolContext): { content: string; hasBom: boolean } {
        const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
        if (vfsOverlay && vfsOverlay.has(filePath)) {
            let content = vfsOverlay.get(filePath)!;
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

    private writeTextFile(filePath: string, content: string, hasBom: boolean, requestedEncoding?: string, context?: import('../types').AgentToolContext): void {
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
        const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
        if (vfsOverlay) {
            vfsOverlay.set(filePath, finalContent);
        } else {
            fs.writeFileSync(filePath, finalContent, 'utf-8');
        }
    }

    // ─── readFile ────────────────────────────────────────────────────────────

    async readFile(args: { file: string; startLine?: number; endLine?: number }, context?: import('../types').AgentToolContext): Promise<import('../types').ReadFileResult> {
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

    async writeFile(args: { file: string; content: string; encoding?: string }, context?: import('../types').AgentToolContext): Promise<import('../types').WriteFileResult> {
        return this.executeWithLock(args.file, async () => {
            try {
                args.file = this.resolveAndAssertInWorkspace(args.file);
                
                // 安全阻断已被移除：允许AI直接覆写文件
                const lowerFile = args.file.toLowerCase();

                const { content: originalContent, hasBom } = this.readTextFile(args.file, context);
                (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(args.file, originalContent);

                const _diff = this.buildUnifiedDiff(args.file, originalContent ?? '', args.content);

                const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply && !vfsOverlay) {
                    const messageId = `write_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(args.file, args.content, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User cancelled the write operation' };
                    }
                } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                    const isNewFile = !fs.existsSync(args.file);
                    this.ctx.onAutoWritten(args.file, isNewFile);
                }

                this.writeTextFile(args.file, args.content, hasBom, args.encoding, context);
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
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
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
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);

            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, args.oldString === '' ? null : originalContent);

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
                    const failCount = (this.editFailCount.get(filePath) || 0) + 1;
                    this.editFailCount.set(filePath, failCount);
                    return { success: false, message: errMsg + this.buildEditEscalationHint(filePath, failCount) };
                }
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply && !vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `edit_${Date.now()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }
            // Reset failure counter on successful edit
            this.editFailCount.delete(filePath);

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

    // ─── replaceLines (line-range-based replacement) ─────────────────────────

    async replaceLines(args: import('../types').ReplaceLinesArgs, context?: import('../types').AgentToolContext): Promise<import('../types').ReplaceLinesResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return { success: false, message: 'Error: missing or invalid "filePath" parameter.' };
        }
        if (typeof args.startLine !== 'number' || typeof args.endLine !== 'number') {
            return { success: false, message: 'Error: startLine and endLine must be numbers (1-based).' };
        }
        if (args.startLine < 1 || args.endLine < args.startLine) {
            return { success: false, message: `Error: invalid line range [${args.startLine}, ${args.endLine}]. startLine must be ≥ 1 and endLine ≥ startLine.` };
        }
        if (typeof args.newContent !== 'string') {
            return { success: false, message: 'Error: newContent must be a string.' };
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = this.resolveAndAssertInWorkspace(args.filePath);
            } catch (e) {
                return { success: false, message: String(e) };
            }
            const filePath = args.filePath;
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            const ending = originalContent.includes('\r\n') ? '\r\n' as const : '\n' as const;
            // Normalize to LF for consistent line splitting — prevents \r\r\n corruption
            const normalizedContent = originalContent.replace(/\r\n/g, '\n');
            const lines = normalizedContent.split('\n');

            // Validate line numbers against file
            if (args.startLine > lines.length) {
                return { success: false, message: `Error: startLine ${args.startLine} exceeds file length (${lines.length} lines).` };
            }
            if (args.endLine > lines.length) {
                return { success: false, message: `Error: endLine ${args.endLine} exceeds file length (${lines.length} lines). File has ${lines.length} lines.` };
            }

            // Extract the target range (convert 1-based to 0-based)
            const startIdx = args.startLine - 1;
            const endIdx = args.endLine - 1;
            const targetLines = lines.slice(startIdx, endIdx + 1);

            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent);

            // Build new content by replacing the line range
            // Normalize newContent to LF too so everything is consistent
            const newContentLines = args.newContent.replace(/\r\n/g, '\n').split('\n');
            const before = lines.slice(0, startIdx);
            const after = lines.slice(endIdx + 1);
            const newLines = [...before, ...newContentLines, ...after];
            // Join with LF, then convert back to original line ending
            const joined = newLines.join('\n');
            const newContent = ending === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined;

            if (newContent === originalContent) {
                return { success: false, message: 'No change: the replacement content is identical to the existing content at the specified line range.' };
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply && !vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `replace_lines_${Date.now()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the replace_lines operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            // Reset edit failure counter on successful line replacement
            this.editFailCount.delete(filePath);

            const diagnostics = await this.getLspDiagnosticsForFile(filePath);
            // Filter to nearby diagnostics (within the replaced range ± 10 lines)
            const editedLines = new Set<number>();
            for (let i = startIdx - 10; i <= startIdx + newContentLines.length + 10; i++) {
                if (i >= 0 && i < newLines.length) editedLines.add(i);
            }
            const nearbyDiags = editedLines.size > 0
                ? diagnostics.filter(d => editedLines.has(d.line))
                : diagnostics;

            let message = `Lines ${args.startLine}-${args.endLine} replaced in ${path.basename(filePath)} (${targetLines.length} lines → ${newContentLines.length} lines)`;
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

    async astMutate(args: import('../types').AstMutateArgs, context?: import('../types').AgentToolContext): Promise<import('../types').AstMutateResult> {
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
        const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
        (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent);

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
            this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
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
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
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
        const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
        let content = originalContent;
        (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent || null);

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
            const failCount = (this.editFailCount.get(filePath) || 0) + 1;
            this.editFailCount.set(filePath, failCount);
            let msg = `${errors.length} edit block(s) failed — file was not modified:\n${errors.join('\n')}`;
            msg += this.buildEditEscalationHint(filePath, failCount);
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
            this.writeTextFile(filePath, content, hasBom, args.encoding, context);
        } catch (e) {
            return { success: false, message: `Write failed: ${String(e)}` };
        }
        // Reset failure counter on successful multiedit
        this.editFailCount.delete(filePath);

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

    async applyPatch(args: { patch: string; cwd?: string }, context?: import('../types').AgentToolContext): Promise<{
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
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContents.get(filePath) ?? null);
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
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
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
                const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;

                if (vfsOverlay && vfsOverlay.has(filePath)) {
                    const raw = vfsOverlay.get(filePath)!;
                    originalContent = raw;
                    hasBom = raw.charCodeAt(0) === 0xFEFF;
                    const clean = hasBom ? raw.slice(1) : raw;
                    lines = clean.split(/\r?\n/);
                } else if (fs.existsSync(filePath)) {
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
                    (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, null);
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
                    (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent);
                }

                // Confirm mode
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !vfsOverlay) {
                    const messageId = `writeloc_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(filePath, withBom, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User rejected localisation write.' };
                    }
                }

                // Write
                if (vfsOverlay) {
                    vfsOverlay.set(filePath, withBom);
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

    // ─── writeDesignBlueprint ────────────────────────────────────────────────

    async writeDesignBlueprint(args: import('../types').WriteDesignBlueprintArgs, context?: import('../types').AgentToolContext): Promise<import('../types').WriteDesignBlueprintResult> {
        try {
            // Save to topic-scoped folder (same as Implementation_Plan.md)
            const topicId = context?.runnerOptions?.topicId || 'default';
            const blueprintDir = path.join(this.ctx.workspaceRoot, '.cwtools-ai', topicId);
            if (!fs.existsSync(blueprintDir)) fs.mkdirSync(blueprintDir, { recursive: true });
            const blueprintPath = path.join(blueprintDir, 'design_blueprint.md');

            const lines: string[] = [];
            lines.push(`# Design Blueprint: ${args.title}`);
            lines.push('');
            lines.push(`> Auto-generated by AI Agent — Plan Mode`);
            lines.push(`> Generated: ${new Date().toISOString()}`);
            lines.push('');

            // Entity Topology Map
            lines.push('## Entity Topology (Cascading Trigger Pipeline)');
            lines.push('');
            lines.push('| # | Entity ID | Type | File | Triggered By | Fires | Scope Context |');
            lines.push('|---|-----------|------|------|-------------|-------|---------------|');
            for (let i = 0; i < args.entities.length; i++) {
                const e = args.entities[i]!;
                const fires = e.fires?.join(', ') || '\u2014';
                const triggeredBy = e.triggeredBy || '\u2014';
                const scope = e.scopeContext || '\u2014';
                lines.push(`| ${i + 1} | \`${e.id}\` | ${e.type} | \`${e.file}\` | ${triggeredBy} | ${fires} | ${scope} |`);
            }
            lines.push('');

            // Trigger flow visualization
            lines.push('### Trigger Flow');
            lines.push('```');
            for (let i = 0; i < args.entities.length; i++) {
                const e = args.entities[i]!;
                const prefix = i === 0 ? '[START]' : '  ->';
                const scopeNote = e.scopeContext ? ` (${e.scopeContext})` : '';
                lines.push(`${prefix} [${e.type}] ${e.id}${scopeNote}`);
                if (e.fires && e.fires.length > 0) {
                    for (const target of e.fires) {
                        lines.push(`      +-- fires -> ${target}`);
                    }
                }
            }
            lines.push('```');
            lines.push('');

            // Event ID Allocation
            if (args.eventIdAllocation) {
                lines.push('## Event ID Allocation');
                lines.push('');
                lines.push(`- **Namespace**: \`${args.eventIdAllocation.namespace}\``);
                lines.push(`- **Ranges**: ${args.eventIdAllocation.ranges}`);
                lines.push('');
            }

            // Localisation Keys
            if (args.localisationKeys && args.localisationKeys.length > 0) {
                lines.push('## Localisation Key Prefixes');
                lines.push('');
                for (const key of args.localisationKeys) {
                    lines.push(`- \`${key}\``);
                }
                lines.push('');
            }

            // Dependency Order
            lines.push('## File Dependency Order (Write Sequence)');
            lines.push('');
            for (let i = 0; i < args.dependencyOrder.length; i++) {
                lines.push(`${i + 1}. \`${args.dependencyOrder[i]}\``);
            }
            lines.push('');

            // Notes
            if (args.notes) {
                lines.push('## Design Notes');
                lines.push('');
                lines.push(args.notes);
                lines.push('');
            }

            // Scope Chain Verification Checklist
            lines.push('## Scope Chain Verification Checklist');
            lines.push('');
            lines.push('⚠️ Before Build phase, verify each entity\'s scope matches CWT rules:');
            lines.push('');
            // Detect entity types and generate relevant checklist items
            const entityTypes = new Set(args.entities.map(e => e.type));
            if (entityTypes.has('archaeological_site_type') || entityTypes.has('fleet_event')) {
                lines.push('- [ ] Arc site stage events use `fleet_event` (NOT planet_event) with `archaeology = yes`');
                lines.push('- [ ] Stage event scope: `this=fleet, from=archaeological_site`');
                lines.push('- [ ] Country access via `owner = { }`, planet via `from = { planet = { } }`');
            }
            if (entityTypes.has('special_project')) {
                lines.push('- [ ] Special project `event_scope` field matches intended on_success scope');
                lines.push('- [ ] on_success: `this=event_scope, from=creation_scope`');
                lines.push('- [ ] fail_trigger/abort_trigger: `this=country, from=event_scope (MIGHT NOT EXIST)`');
            }
            if (entityTypes.has('relic')) {
                lines.push('- [ ] Relic active_effect/possible: `this=country, root=country`');
            }
            if (entityTypes.has('situation_type')) {
                lines.push('- [ ] Situation on_start/on_fail/on_progress_complete scope matches situation context');
            }
            // Always add cross-scope persistence check
            lines.push('- [ ] Cross-scope references use `save_event_target_as` / `event_target:`');
            lines.push('- [ ] All entity IDs are unique and follow project namespace conventions');
            lines.push('');

            const content = lines.join('\n');
            fs.writeFileSync(blueprintPath, content, 'utf-8');

            // Emit step event so chatPanel can display the blueprint in the UI
            const onStep = context?.onStep ?? this.ctx.onStep;
            onStep?.({
                type: 'blueprint_card',
                content: blueprintPath,
                timestamp: Date.now(),
            } as any);

            return {
                success: true,
                message: `Design blueprint saved to ${blueprintPath}. User should review this blueprint before proceeding to Build phase.`,
                filePath: blueprintPath,
            };
        } catch (e) {
            return {
                success: false,
                message: `Failed to write design blueprint: ${e instanceof Error ? e.message : String(e)}`,
                filePath: '',
            };
        }
    }

    // ─── Git Operations ──────────────────────────────────────────────────────

    /**
     * Execute safe git operations: status, diff, checkout (revert file to HEAD).
     * Only works when the workspace has a git repository.
     */
    async gitOps(args: { action: 'status' | 'diff' | 'checkout'; file?: string }): Promise<{ success: boolean; message: string; output?: string }> {
        const { execSync } = await import('child_process');
        const wsRoot = this.ctx.workspaceRoot;

        // Check if git repo exists
        const gitDir = path.join(wsRoot, '.git');
        if (!fs.existsSync(gitDir)) {
            return { success: false, message: 'No git repository found in workspace root. git_ops requires the workspace to be a git repo.' };
        }

        const MAX_OUTPUT = 8000;

        try {
            switch (args.action) {
                case 'status': {
                    const raw = execSync('git status --porcelain', { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });
                    const lines = raw.trim().split('\n').filter(Boolean);
                    if (lines.length === 0) {
                        return { success: true, message: 'Working tree clean — no modified files.', output: '' };
                    }
                    const output = lines.slice(0, 100).join('\n');
                    return {
                        success: true,
                        message: `${lines.length} modified file(s).`,
                        output: output.length > MAX_OUTPUT ? output.substring(0, MAX_OUTPUT) + '\n... (truncated)' : output,
                    };
                }
                case 'diff': {
                    if (!args.file) {
                        return { success: false, message: 'The "diff" action requires a "file" parameter.' };
                    }
                    const filePath = path.isAbsolute(args.file) ? path.relative(wsRoot, args.file) : args.file;
                    const raw = execSync(`git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`, { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });
                    if (!raw.trim()) {
                        return { success: true, message: `No changes detected for ${filePath}.`, output: '' };
                    }
                    return {
                        success: true,
                        message: `Diff for ${filePath}:`,
                        output: raw.length > MAX_OUTPUT ? raw.substring(0, MAX_OUTPUT) + '\n... (truncated)' : raw,
                    };
                }
                case 'checkout': {
                    if (!args.file) {
                        return { success: false, message: 'The "checkout" action requires a "file" parameter.' };
                    }
                    const absPath = path.isAbsolute(args.file) ? args.file : path.join(wsRoot, args.file);
                    const relPath = path.relative(wsRoot, absPath);

                    // Snapshot for retract support
                    if (fs.existsSync(absPath)) {
                        const prev = fs.readFileSync(absPath, 'utf-8');
                        this.ctx.onBeforeFileWrite?.(absPath, prev);
                    }

                    execSync(`git checkout HEAD -- "${relPath.replace(/"/g, '\\"')}"`, { cwd: wsRoot, encoding: 'utf-8', timeout: 15_000 });

                    // Reset edit failure counter since the file is now back to a known-good state
                    this.editFailCount.delete(absPath);

                    return {
                        success: true,
                        message: `Successfully reverted ${relPath} to last committed state (HEAD).`,
                    };
                }
                default:
                    return { success: false, message: `Unknown git action: "${args.action}". Supported: status, diff, checkout.` };
            }
        } catch (e) {
            return { success: false, message: `git ${args.action} failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }
}
