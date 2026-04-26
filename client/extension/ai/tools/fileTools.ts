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
import type {
    ValidationError,
} from '../types';

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
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class FileToolHandler {
    constructor(private ctx: FileToolContext) { }

    private resolveAndAssertInWorkspace(filePath: string): string {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.ctx.workspaceRoot, filePath);
        const normalized = path.resolve(absolutePath);
        const wsRoot = path.resolve(this.ctx.workspaceRoot);
        if (!normalized.startsWith(wsRoot)) {
            throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
        }
        return normalized;
    }

    private readTextFile(filePath: string): { content: string; hasBom: boolean } {
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
        } else if (filePath.endsWith('.yml') && (filePath.replace(/\\/g, '/').includes('/localisation/'))) {
            shouldAddBom = true;
        }

        const finalContent = shouldAddBom ? '\uFEFF' + content : content;
        fs.writeFileSync(filePath, finalContent, 'utf-8');
    }

    // ─── readFile ────────────────────────────────────────────────────────────

    async readFile(args: { file: string; startLine?: number; endLine?: number }): Promise<import('../types').ReadFileResult> {
        try {
            args.file = this.resolveAndAssertInWorkspace(args.file);

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
                return { content: `读取文件出错：${String(e)}`, totalLines: 0, truncated: false };
            }

            const end = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;

            if (totalLines > threshold && !args.startLine && !args.endLine) {
                return {
                    content: '',
                    totalLines,
                    truncated: true,
                    _hint: `文件共有 ${totalLines} 行 — 太长无法完整读取。` +
                        `建议：先调用 document_symbols("${args.file}") 定位你所需的部分，` +
                        `然后再使用 startLine 和 endLine 参数重新调用 read_file（每次最多读取 ${threshold} 行）。`,
                };
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
                    ? resultContent + `\n[... 已在 ~${MAX_READ_CHARS} 字符处截断 ...]`
                    : resultContent,
                totalLines,
                truncated,
                ...(truncated ? {
                    _hint: `输出已截断。文件总行数为 ${totalLines}。` +
                        `当前显示的最后一行约在 ~${lastLineReturned}。` +
                        `要读取下一部分，请使用 startLine=${lastLineReturned + 1} 重新调用 read_file。`,
                } : {}),
            };
        } catch (e) {
            return { content: `读取文件出错：${String(e)}`, totalLines: 0, truncated: false };
        }
    }

    // ─── writeFile ───────────────────────────────────────────────────────────

    async writeFile(args: { file: string; content: string; encoding?: string }): Promise<import('../types').WriteFileResult> {
        try {
            args.file = this.resolveAndAssertInWorkspace(args.file);
            const { content: originalContent, hasBom } = this.readTextFile(args.file);
            this.ctx.onBeforeFileWrite?.(args.file, originalContent);

            const _diff = this.buildUnifiedDiff(args.file, originalContent ?? '', args.content);

            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
                const messageId = `write_${crypto.randomUUID()}`;
                const confirmed = await this.ctx.onPendingWrite(args.file, args.content, messageId);
                if (!confirmed) {
                    return { success: false, message: '用户取消了写入操作' };
                }
            } else if (this.ctx.onAutoWritten) {
                const isNewFile = !fs.existsSync(args.file);
                this.ctx.onAutoWritten(args.file, isNewFile);
            }

            this.writeTextFile(args.file, args.content, hasBom, args.encoding);
            return { success: true, message: `文件已写入: ${args.file}` };
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }
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
                message: '错误：缺少或无效的 "filePath" 参数。必须提供绝对文件路径。示例：edit_file({ "filePath": "/path/to/file.txt", "oldString": "...", "newString": "..." })',
            } as any;
        }
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
                return { success: false, message: 'oldString 与 newString 完全相同，无需修改' };
            }
            const ending = this.detectLineEnding(originalContent);
            const old = this.convertLineEnding(this.normalizeLineEndings(args.oldString), ending);
            const next = this.convertLineEnding(this.normalizeLineEndings(args.newString), ending);
            try {
                newContent = this.replace(originalContent, old, next, args.replaceAll ?? false);
            } catch (e) {
                return { success: false, message: String(e) };
            }
        }

        const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
            const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `edit_${Date.now()}`);
            if (!confirmed) {
                return { success: false, message: '用户取消了编辑操作', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        try {
            this.writeTextFile(filePath, newContent, hasBom, args.encoding);
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }

        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        // Only return diagnostics near the edited region to save context
        const editedLines = new Set<number>();
        const newLines = args.newString.split('\n');
        // P2 Fix: use newContent directly instead of re-reading the file (eliminates
        // redundant I/O and TOCTOU risk — newContent is exactly what was just written)
        const newContentLines = newContent.split('\n');
        for (let li = 0; li < newContentLines.length; li++) {
            if (newLines.some(nl => {
                const trimmed = nl.trim();
                return trimmed.length > 8 && newContentLines[li].includes(trimmed);
            })) {
                for (let r = -10; r <= 10; r++) {
                    const idx = li + r;
                    if (idx >= 0 && idx < newContentLines.length) editedLines.add(idx);
                }
            }
        }
        const nearbyDiags = editedLines.size > 0
            ? diagnostics.filter(d => editedLines.has(d.line))
            : diagnostics; // fallback: return all if we can't identify region
        let message = `文件已更新: ${path.basename(filePath)}`;
        const errors = nearbyDiags.filter(d => d.severity === 'error');
        if (errors.length > 0) {
            message += `\n\nLSP 检测到 ${errors.length} 个错误，请修复：\n` +
                errors.slice(0, 5).map(e => `  第 ${e.line + 1} 行: ${e.message}`).join('\n');
        }
        return {
            success: true, message, diff, diagnostics: nearbyDiags,
            ...(diagnostics.length > nearbyDiags.length ? { totalDiagnostics: diagnostics.length } : {}),
        } as any;
    }

    // ─── astMutate ───────────────────────────────────────────────────────────

    async astMutate(args: import('../types').AstMutateArgs): Promise<import('../types').AstMutateResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: '错误：缺少或无效的 "filePath" 参数。必须提供绝对文件路径。',
            } as any;
        }
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

        const ending = originalContent.includes('\r\n') ? '\r\n' : '\n';
        const payloadLines = args.payload ? args.payload.replace(/\r\n/g, '\n').split('\n').map((l: string) => l + (ending === '\r\n' ? '\r' : '')) : [];

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
                return { success: false, message: '用户取消了编辑操作', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        try {
            this.writeTextFile(filePath, newContent, hasBom, args.encoding);
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }

        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        return {
            success: true,
            nodeFound: true,
            message: `AST surgery successful (${args.action} on ${args.targetPath.join(' -> ')}). 文件已更新: ${path.basename(filePath)}`,
            diff,
            diagnostics
        };
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
                message: '错误：缺少或无效的 "filePath" 参数。必须提供绝对文件路径。',
            } as any;
        }
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
            const edit = args.edits[i];
            if (edit.oldString === edit.newString) continue;
            const old = this.convertLineEnding(this.normalizeLineEndings(edit.oldString), ending);
            const next = this.convertLineEnding(this.normalizeLineEndings(edit.newString), ending);
            try {
                content = this.replace(content, old, next, edit.replaceAll ?? false);
            } catch (e) {
                // P1 Fix: fail-fast — stop on first error to avoid misleading messages
                // from subsequent edits operating on an inconsistent intermediate state
                errors.push(`编辑块 #${i + 1} 失败：${e instanceof Error ? e.message : String(e)}`);
                break;
            }
        }

        if (errors.length > 0) {
            return {
                success: false,
                message: `${errors.length} 个编辑块应用失败，文件未做任何修改：\n${errors.join('\n')}`,
            };
        }

        const diff = this.buildUnifiedDiff(filePath, originalContent, content);
        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !(args as any)._autoApply) {
            const messageId = `multiedit_${crypto.randomUUID()}`;
            const confirmed = await this.ctx.onPendingWrite(filePath, content, messageId);
            if (!confirmed) {
                return { success: false, message: '用户取消了编辑操作', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        try {
            this.writeTextFile(filePath, content, hasBom, args.encoding);
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
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
                    return trimmed.length > 8 && finalLines[li].includes(trimmed);
                })) {
                    for (let r = -10; r <= 10; r++) {
                        const idx = li + r;
                        if (idx >= 0 && idx < finalLines.length) editedRegionLines.add(idx);
                    }
                }
            }
        }
        const nearbyDiags = editedRegionLines.size > 0
            ? diagnostics.filter(d => editedRegionLines.has(d.line))
            : diagnostics;
        let message = `multiedit: ${args.edits.length} 个编辑已应用到 ${path.basename(filePath)}`;
        const errorDiags = nearbyDiags.filter(d => d.severity === 'error');
        if (errorDiags.length > 0) {
            message += `\n\nLSP 检测到 ${errorDiags.length} 个错误：\n` +
                errorDiags.slice(0, 5).map(e => `  第 ${e.line + 1} 行: ${e.message}`).join('\n');
        }
        return {
            success: true, message, diff, diagnostics: nearbyDiags,
            ...(diagnostics.length > nearbyDiags.length ? { totalDiagnostics: diagnostics.length } : {}),
        } as any;
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
            const line = lines[i];
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
                while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
                    const hunkLine = lines[i];
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
            return { success: false, filesChanged: [], errors: ['补丁中未找到有效的修改块（hunks）'] };
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
                        errors: [`${path.basename(filePath)}: 用户取消了写入操作，所有文件均未修改`],
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
                errors.push(`写入 ${path.basename(filePath)} 失败：${e instanceof Error ? e.message : String(e)}`);
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
            const dirPath = path.isAbsolute(args.directory)
                ? args.directory
                : path.join(this.ctx.workspaceRoot, args.directory);

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

    private normalizeLineEndings(text: string): string { return text.split('\r\n').join('\n'); }
    private detectLineEnding(text: string): '\n' | '\r\n' { return text.includes('\r\n') ? '\r\n' : '\n'; }
    private convertLineEnding(text: string, ending: '\n' | '\r\n'): string {
        return ending === '\n' ? text : text.split('\n').join('\r\n');
    }

    // P2-12 Fix: Rolling-array Levenshtein — O(min(n,m)) space instead of O(n*m)
    private levenshtein(a: string, b: string): number {
        if (!a.length || !b.length) return Math.max(a.length, b.length);
        // Ensure b is the shorter string for minimal memory usage
        if (a.length < b.length) { const t = a; a = b; b = t; }
        let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
        let curr = new Array<number>(b.length + 1);
        for (let i = 1; i <= a.length; i++) {
            curr[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const c = a[i - 1] === b[j - 1] ? 0 : 1;
                curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + c);
            }
            [prev, curr] = [curr, prev];
        }
        return prev[b.length];
    }

    private *simpleReplacer(_c: string, find: string): Generator<string> { yield find; }

    private *lineTrimmedReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL[sL.length - 1] === '') sL.pop();
        for (let i = 0; i <= oL.length - sL.length; i++) {
            if (sL.every((s, j) => oL[i + j].trim() === s.trim())) {
                let st = 0; for (let k = 0; k < i; k++) st += oL[k].length + 1;
                let en = st; for (let k = 0; k < sL.length; k++) { en += oL[i + k].length; if (k < sL.length - 1) en += 1; }
                yield content.substring(st, en);
            }
        }
    }

    private *blockAnchorReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL.length < 3) return;
        if (sL[sL.length - 1] === '') sL.pop();
        const first = sL[0].trim(), last = sL[sL.length - 1].trim();
        const cands: { s: number; e: number }[] = [];
        for (let i = 0; i < oL.length; i++) {
            if (oL[i].trim() !== first) continue;
            for (let j = i + 2; j < oL.length; j++) { if (oL[j].trim() === last) { cands.push({ s: i, e: j }); break; } }
        }
        if (!cands.length) return;
        const score = (s: number, e: number) => {
            const check = Math.min(sL.length - 2, e - s - 1);
            if (check <= 0) return 1.0;
            let sim = 0;
            for (let j = 1; j < sL.length - 1 && j < e - s; j++) {
                const mx = Math.max(oL[s + j].trim().length, sL[j].trim().length);
                if (mx) sim += (1 - this.levenshtein(oL[s + j].trim(), sL[j].trim()) / mx) / check;
            }
            return sim;
        };
        const extract = (s: number, e: number) => {
            let st = 0; for (let k = 0; k < s; k++) st += oL[k].length + 1;
            let en = st; for (let k = s; k <= e; k++) { en += oL[k].length; if (k < e) en += 1; }
            return content.substring(st, en);
        };
        if (cands.length === 1) { if (score(cands[0].s, cands[0].e) >= 0) yield extract(cands[0].s, cands[0].e); return; }
        let best = cands[0], bestSim = -1;
        for (const { s, e } of cands) { const sim = score(s, e); if (sim > bestSim) { bestSim = sim; best = { s, e }; } }
        if (bestSim >= 0.3) yield extract(best.s, best.e);
    }

    private *whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
        const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
        const nF = norm(find), lns = content.split('\n'), fL = find.split('\n');
        if (fL.length === 1) { for (const l of lns) { if (norm(l) === nF) yield l; } return; }
        for (let i = 0; i <= lns.length - fL.length; i++)
            if (norm(lns.slice(i, i + fL.length).join('\n')) === nF) yield lns.slice(i, i + fL.length).join('\n');
    }

    private *indentationFlexibleReplacer(content: string, find: string): Generator<string> {
        const strip = (text: string) => {
            const lns = text.split('\n'), ne = lns.filter(l => l.trim().length > 0);
            if (!ne.length) return text;
            const min = Math.min(...ne.map(l => { const m = l.match(/^(\s*)/); return m ? m[1].length : 0; }));
            return lns.map(l => l.trim().length === 0 ? l : l.slice(min)).join('\n');
        };
        const nF = strip(find), lns = content.split('\n'), fL = find.split('\n');
        for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (strip(b) === nF) yield b;
        }
    }

    private *escapeNormalizedReplacer(content: string, find: string): Generator<string> {
        const un = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, c: string) =>
            ({ n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', '$': '$' }[c] ?? _m));
        const uF = un(find);
        if (content.includes(uF)) { yield uF; return; }
        const lns = content.split('\n'), fL = uF.split('\n');
        if (fL.length > 1) for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (un(b) === uF) yield b;
        }
    }

    private *trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
        const trimmed = find.trim();
        if (trimmed === find) return;
        if (content.includes(trimmed)) { yield trimmed; return; }
        const lns = content.split('\n'), fL = find.split('\n');
        for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (b.trim() === trimmed) yield b;
        }
    }

    private *contextAwareReplacer(content: string, find: string): Generator<string> {
        const fL = find.split('\n');
        if (fL.length < 3) return;
        if (fL[fL.length - 1] === '') fL.pop();
        const cL = content.split('\n');
        const fl = fL[0].trim(), ll = fL[fL.length - 1].trim();
        for (let i = 0; i < cL.length; i++) {
            if (cL[i].trim() !== fl) continue;
            for (let j = i + 2; j < cL.length; j++) {
                if (cL[j].trim() !== ll) continue;
                const b = cL.slice(i, j + 1);
                if (b.length !== fL.length) break;
                let hit = 0, tot = 0;
                for (let k = 1; k < b.length - 1; k++) {
                    if (b[k].trim().length || fL[k].trim().length) { tot++; if (b[k].trim() === fL[k].trim()) hit++; }
                }
                if (tot === 0 || hit / tot >= 0.5) { yield b.join('\n'); break; }
                break;
            }
        }
    }

    /** Main replace: try each of the 8 Replacers in order, first match wins */
    replace(content: string, oldString: string, newString: string, replaceAll: boolean): string {
        if (oldString === newString) throw new Error('oldString 与 newString 完全相同，无需修改');
        const replacers = [
            this.simpleReplacer.bind(this),
            this.lineTrimmedReplacer.bind(this),
            this.blockAnchorReplacer.bind(this),
            this.whitespaceNormalizedReplacer.bind(this),
            this.indentationFlexibleReplacer.bind(this),
            this.escapeNormalizedReplacer.bind(this),
            this.trimmedBoundaryReplacer.bind(this),
            this.contextAwareReplacer.bind(this),
        ] as const;
        for (const replacer of replacers) {
            for (const search of replacer(content, oldString)) {
                const idx = content.indexOf(search);
                if (idx === -1) continue;
                if (replaceAll) return search.length > 0 ? content.split(search).join(newString) : content;
                const lastIdx = content.lastIndexOf(search);
                if (idx !== lastIdx) throw new Error(
                    '在文件中找到多个匹配项。请在 oldString 中提供更多上下文使其唯一，或使用 replaceAll=true。'
                );
                return content.substring(0, idx) + newString + content.substring(idx + search.length);
            }
        }
        throw new Error(
            '找不到该内容。严禁在 oldString 中省略上下文或使用 "..." 代表未修改代码！请完整包含从替换起点到终点的所有代码文本，确保空白符完全对齐。\n' +
            '提示：务必先使用 read_file 获取确切文本，然后再在 oldString 中提供与文件完全相同的片段。'
        );
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
        return changed === 0 ? diff + '(无变更)\n' : diff;
    }
}
