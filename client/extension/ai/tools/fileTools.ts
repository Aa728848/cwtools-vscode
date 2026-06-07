/**
 * File Tool Handler - read, write, edit, patch, and directory operations.
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
import { tokenize, TokenType } from '../../pdxTokenizer';
import type { ValidationError } from '../types';
import { getCachedFile, setCachedFile } from '../fileCache';
import { getToolResultBudget } from '../contextBudget';
import { fuzzyReplace } from './replacerSuite';
import { diagnosticMetadata } from './diagnosticMetadata';
import { getTopicStorageDir } from '../workspacePaths';
import {
    isSecuritySandboxDisabled,
    resolveWorkspacePathInput,
    type WorkspacePathResolution,
} from '../workspaceSandbox';

// - Shared file-system helpers -

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

// - Context type -

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
    /** Optional: Get LSP LanguageClient for diagnostic freshness query */
    client?: import('vscode-languageclient/node').LanguageClient;
}

// - Handler class -

export class FileToolHandler {
    /** Per-file edit failure counter - escalates errors for all file types */
    private editFailCount = new Map<string, number>();

    constructor(private ctx: FileToolContext) { }

    /**
     * Build tiered escalation hints based on per-file edit failure count.
     * - YML files -> always redirect to write_localisation
     * - Other files -> gentle hint at 3+, budget exhaustion at 5+
     */
    private buildEditEscalationHint(filePath: string, failCount: number): string {
        const basename = path.basename(filePath);
        if (filePath.endsWith('.yml')) {
            return `\n\nWarning: YML BLOCKED (failure #${failCount}): You MUST NOT use multi_replace_file_content for .yml files. Use write_localisation(filePath, language, entries) instead - it handles encoding, formatting, and insertion correctly.`;
        }
        if (failCount >= 5) {
            return `\n\nStop: EDIT BUDGET EXHAUSTED for ${basename} (${failCount} failures). STOP editing this file. Add \`# TODO\` comments for remaining issues and move on to other files.`;
        }
        if (failCount >= 3) {
            return `\n\nWarning: ${basename} has failed ${failCount} edits. MANDATORY: call \`read_file("${filePath}")\` to get the EXACT current content before your next edit attempt. Your oldString does not match the file.`;
        }
        return '';
    }

    private recordEditFailure(filePath: string): string {
        const failCount = (this.editFailCount.get(filePath) || 0) + 1;
        this.editFailCount.set(filePath, failCount);
        return this.buildEditEscalationHint(filePath, failCount);
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

    private shouldBypassWriteConfirmation(args: unknown, context?: import('../types').AgentToolContext): boolean {
        const record = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
        return record._autoApply === true
            || context?.runnerOptions?.forceAutoApplyWrites === true
            || context?.runnerOptions?.useSlimPrompt === true;
    }

    private normalizeAgentWorkspacePath(filePath: string, context?: import('../types').AgentToolContext): string {
        const topicId = context?.runnerOptions?.topicId;
        if (!topicId) return filePath;

        const normalized = filePath.trim().replace(/\\/g, '/');
        const match = normalized.match(/^\.cwtools-ai(?:\/(.*))?$/i);
        if (!match) return filePath;

        const safeTopicId = topicId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const rest = (match[1] ?? '').split('/').filter(Boolean);
        if (rest[0]?.toLowerCase() === safeTopicId.toLowerCase()) {
            return filePath;
        }

        return path.posix.join('.cwtools-ai', safeTopicId, ...rest);
    }

    private normalizeAgentWorkspaceWritePath(filePath: string, context?: import('../types').AgentToolContext): string {
        return this.normalizeAgentWorkspacePath(filePath, context);
    }

    private resolveWorkspacePath(filePath: string, preferExistingAiPath: boolean, context?: import('../types').AgentToolContext): WorkspacePathResolution {
        const normalizedInput = this.normalizeAgentWorkspacePath(filePath, context);
        return resolveWorkspacePathInput(normalizedInput, this.ctx.workspaceRoot, { preferExistingAiPath });
    }

    private resolveAndAssertInWorkspace(filePath: string, context?: import('../types').AgentToolContext): string {
        const resolution = this.resolveWorkspacePath(filePath, true, context);
        if (isSecuritySandboxDisabled() || resolution.isWithinAnyWorkspace) {
            return resolution.resolved;
        }
        throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
    }

    private async requestPermissionWithAbort(
        id: string,
        tool: string,
        description: string,
        context?: import('../types').AgentToolContext,
        command?: string
    ): Promise<boolean> {
        const onPermissionRequest = context?.onPermissionRequest;
        if (!onPermissionRequest) return false;

        const abortSignal = context?.runnerOptions?.abortSignal;
        if (abortSignal?.aborted) return false;
        if (!abortSignal) {
            return onPermissionRequest(id, tool, description, command);
        }

        let onAbort: (() => void) | undefined;
        const abortDeny = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([
                onPermissionRequest(id, tool, description, command),
                abortDeny,
            ]);
        } finally {
            if (onAbort) abortSignal.removeEventListener('abort', onAbort);
        }
    }

    private shouldBypassReadTrackerCheck(filePath: string): boolean {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        // 1. All writes under the .cwtools-ai folder
        if (normalized.includes('/.cwtools-ai/') || normalized.startsWith('.cwtools-ai/') || normalized.includes('.cwtools-ai')) {
            return true;
        }
        // 2. Common command scripts and helper script suffixes
        const ext = path.extname(filePath).toLowerCase();
        const COMMAND_TEMP_SCRIPT_EXTENSIONS = new Set([
            '.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh',
        ]);
        if (COMMAND_TEMP_SCRIPT_EXTENSIONS.has(ext)) {
            return true;
        }
        return false;
    }

    private async resolveAndAuthorizeWrite(filePath: string, toolName: string, context?: import('../types').AgentToolContext): Promise<string> {
        const resolution = this.resolveWorkspacePath(this.normalizeAgentWorkspaceWritePath(filePath, context), false, context);
        if (!isSecuritySandboxDisabled()) {
            if (!resolution.isWithinAnyWorkspace) {
                throw new Error(`Access denied: Path '${filePath}' is outside the workspace root.`);
            }
            if (resolution.scope === 'workspace') {
                const allowed = await this.requestPermissionWithAbort(
                    `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    toolName,
                    `[ESCALATION] AI requests permission to modify another workspace root: ${resolution.resolved}`,
                    context,
                    resolution.resolved
                );
                if (!allowed) {
                    throw new Error(`Access denied: User denied cross-workspace write for '${resolution.resolved}'.`);
                }
            }
        }
        // ReadTracker write-gate safety interception (D1)
        const readTracker = (context?.agentRunner as any)?.readTracker;
        if (readTracker && !this.shouldBypassReadTrackerCheck(resolution.resolved)) {
            const check = readTracker.canWrite(resolution.resolved);
            if (!check.ok) {
                throw new Error(`ReadTracker Blocked: ${check.reason}. You must read the file context first using read_file or get_file_context. If you have already read it, the file might have been modified externally; please perform a fresh read_file to synchronize, and then retry your edit.`);
            }
        }
        return resolution.resolved;
    }

    private workspaceRelativePath(filePath: string): string {
        const resolution = resolveWorkspacePathInput(filePath, this.ctx.workspaceRoot, { preferExistingAiPath: true });
        const root = resolution.workspaceFolder ?? this.ctx.workspaceRoot;
        return path.relative(root, resolution.resolved).replace(/\\/g, '/');
    }

    private isLocalisationPath(filePath: string): boolean {
        const relPath = this.workspaceRelativePath(filePath).toLowerCase();
        return relPath.startsWith('localisation/')
            || relPath.startsWith('localisation_synced/')
            || relPath.startsWith('localization/');
    }

    private rejectGenericYmlWrite(toolName: string, filePath: string): import('../types').WriteFileResult | null {
        if (!filePath.toLowerCase().endsWith('.yml')) return null;

        return {
            success: false,
            message: `${toolName} refused to write a .yml localisation file. Use write_localisation with a real localisation path under localisation/, localisation_synced/, or localization/. Do not write localisation YAML into .cwtools-ai scratch/topic folders.`,
        };
    }

    private validateLocalisationTarget(filePath: string): string | null {
        if (!filePath.toLowerCase().endsWith('.yml')) {
            return 'write_localisation only works with .yml files.';
        }
        if (!this.isLocalisationPath(filePath)) {
            return `write_localisation refused '${this.workspaceRelativePath(filePath)}'. Localisation files must be written under localisation/, localisation_synced/, or localization/, never under .cwtools-ai scratch/topic folders.`;
        }
        return null;
    }

    private isPdxStructureGuardedPath(filePath: string): boolean {
        return ['.txt', '.gui', '.gfx', '.asset', '.entity'].includes(path.extname(filePath).toLowerCase());
    }

    private inspectPdxBraceStructure(content: string): {
        balanced: boolean;
        openCount: number;
        closeCount: number;
        unmatchedOpenCount: number;
        firstExtraCloseLine?: number;
    } {
        let depth = 0;
        let openCount = 0;
        let closeCount = 0;
        let firstExtraCloseLine: number | undefined;

        for (const token of tokenize(content)) {
            if (token.type === TokenType.LBrace) {
                depth++;
                openCount++;
            } else if (token.type === TokenType.RBrace) {
                depth--;
                closeCount++;
                if (depth < 0 && firstExtraCloseLine === undefined) {
                    firstExtraCloseLine = token.line;
                }
            }
        }

        return {
            balanced: depth === 0 && firstExtraCloseLine === undefined,
            openCount,
            closeCount,
            unmatchedOpenCount: Math.max(depth, 0),
            firstExtraCloseLine,
        };
    }

    private rejectUnsafePdxStructureWrite(toolName: string, filePath: string, originalContent: string, newContent: string): string | null {
        if (!this.isPdxStructureGuardedPath(filePath) || originalContent === newContent) return null;

        const originalStructure = this.inspectPdxBraceStructure(originalContent);
        if (!originalStructure.balanced) {
            // Existing broken files still need to be repairable.
            return null;
        }

        const nextStructure = this.inspectPdxBraceStructure(newContent);
        if (nextStructure.balanced) return null;

        const problem = nextStructure.firstExtraCloseLine !== undefined
            ? `first unmatched "}" at line ${nextStructure.firstExtraCloseLine}`
            : `${nextStructure.unmatchedOpenCount} unmatched "{" brace(s) remain`;
        return `${toolName} refused to write ${path.basename(filePath)} because it would unbalance the PDX brace structure (${problem}; openings: ${nextStructure.openCount}, closings: ${nextStructure.closeCount}). Re-read the exact block/context and retry with the surrounding braces intact.`;
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
        const readTracker = (context?.agentRunner as any)?.readTracker;
        if (readTracker) { readTracker.markWritten(filePath); }
    }

    // - readFile -

    async readFile(args: { file: string; startLine?: number; endLine?: number }, context?: import('../types').AgentToolContext): Promise<import('../types').ReadFileResult> {
        try {
            args.file = this.resolveAndAssertInWorkspace(args.file, context);
            const readTracker = (context?.agentRunner as any)?.readTracker;
            if (readTracker) { readTracker.markRead(args.file); }

            const ext = path.extname(args.file).toLowerCase();
            const IMAGE_EXTS = ['.dds', '.tga', '.png', '.jpg', '.jpeg', '.bmp'];
            if (IMAGE_EXTS.includes(ext)) {
                return await this.readImageMetadata(args.file);
            }

            // - Cache: serve full-file reads from memory -
            if (!args.startLine && !args.endLine) {
                const cached = getCachedFile(args.file);
                if (cached !== null) {
                    const lines = cached.split('\n');
                    const totalLines = lines.length;
                    let threshold = 150;
                    if (args.file.endsWith('.yml')) {
                        threshold = 50;
                    }

                    if (totalLines > threshold) {
                        const headLines = lines.slice(0, 80);
                        const tailLines = lines.slice(-20);
                        const headContent = headLines.map((l, i) => `${1 + i} | ${l}`).join('\n');
                        const tailContent = tailLines.map((l, i) => `${totalLines - 19 + i} | ${l}`).join('\n');
                        
                        let gapInfo = `\n... [${totalLines - 100} lines omitted - use document_symbols to locate, then read_file for specifics] ...\n`;
                        let hint = `The file has ${totalLines} lines in total. The first 100 lines and the last 20 lines are displayed. Suggestion: call document_symbols("${args.file}") to get the structure, then use read_file(startLine, endLine) to read precisely (each time up to ${threshold} lines).`;

                        if (args.file.endsWith('.txt')) {
                            gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! DO NOT READ FULL FILE! Use document_symbols + get_pdx_block] ...\n`;
                            hint = `Warning: FILE TOO LARGE. The first 100 lines and last 20 are displayed. For PDX scripts (.txt), you MUST call document_symbols("${args.file}") to get the structure, then use get_pdx_block("${args.file}", symbol) to extract the specific block you need. DO NOT use read_file for large PDX scripts.`;
                        } else if (args.file.endsWith('.yml')) {
                            gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! YML IS TOO LARGE. Use search_mod_files or grep] ...\n`;
                            hint = `Warning: YML TOO LARGE. You MUST NOT read entire localisation files. Use grep or search_mod_files to find specific keys instead.`;
                        }

                        hint += ' Do not conclude that a key/ID is missing from this truncated view; use grep/search_mod_files or verify_pdx_identifier for absence checks.';

                        return {
                            content: headContent + gapInfo + tailContent,
                            totalLines,
                            truncated: true,
                            _hint: hint,
                        };
                    }
                    return { content: cached, totalLines, truncated: false };
                }
            }
            // -

            let threshold = 150;
            if (args.file.endsWith('.yml')) {
                threshold = 50;
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
                    ? null  // partial read - don't cache
                    : slice.join('\n');
                if (fullContent !== null) {
                    const stat = fs.statSync(args.file);
                    setCachedFile(args.file, fullContent, stat.mtimeMs);
                }
            } catch { /* stat may fail; skip cache */ }
            
            if (totalLines > threshold && !args.startLine && !args.endLine) {
                const headLines = slice.slice(0, 80);
                const tailLines = slice.slice(-20);
                const headContent = headLines.map((l, i) => `${1 + i} | ${l}`).join('\n');
                const tailContent = tailLines.map((l, i) => `${totalLines - 19 + i} | ${l}`).join('\n');
                let gapInfo = `\n... [${totalLines - 100} lines omitted - use document_symbols to locate, then read_file for specifics (max ${threshold} lines at a time)] ...\n`;
                let hint = `The file has ${totalLines} lines in total. The first 100 lines and the last 20 lines are displayed. Suggestion: call document_symbols("${args.file}") to get the structure, then use read_file(startLine, endLine) to read precisely (each time up to ${threshold} lines).`;

                if (args.file.endsWith('.txt')) {
                    gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! DO NOT READ FULL FILE! Use document_symbols + get_pdx_block] ...\n`;
                    hint = `Warning: FILE TOO LARGE. The first 100 lines and last 20 are displayed. For PDX scripts (.txt), you MUST call document_symbols("${args.file}") to get the structure, then use get_pdx_block("${args.file}", symbol) to extract the specific block you need. DO NOT use read_file for large PDX scripts.`;
                } else if (args.file.endsWith('.yml')) {
                    gapInfo = `\n... [${totalLines - 100} lines omitted - Stop: STOP! YML IS TOO LARGE. Use search_mod_files or grep] ...\n`;
                    hint = `Warning: YML TOO LARGE. You MUST NOT read entire localisation files. Use grep or search_mod_files to find specific keys instead.`;
                }

                hint += ' Do not conclude that a key/ID is missing from this truncated view; use grep/search_mod_files or verify_pdx_identifier for absence checks.';

                return {
                    content: headContent + gapInfo + tailContent,
                    totalLines,
                    truncated: true,
                    _hint: hint,
                };
            }

            // Strip BOM from first line (readline doesn't strip it, but readTextFile/editFile do,
            // causing BOM mismatch when the AI copies text from read_file into edit_file's oldString)
            if (slice.length > 0 && slice[0]!.charCodeAt(0) === 0xFEFF) {
                slice[0] = slice[0]!.slice(1);
            }

            // Format with succinct line prefix (saves ~1 token per line vs "1234: ")
            const numbered = slice.map((l, i) => `${start + i} | ${l}`).join('\n');

            const MAX_READ_CHARS = getToolResultBudget(context?.runnerOptions?.maxContextTokens);
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

    private async readImageMetadata(filePath: string): Promise<any> {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const stat = await fs.promises.stat(filePath);
            const fileSize = stat.size;

            const metadata: any = { type: 'image_metadata', ext, fileSize };

            if (ext === '.dds') {
                const fd = await fs.promises.open(filePath, 'r');
                try {
                    const buf = Buffer.alloc(128);
                    await fd.read(buf, 0, 128, 0);
                    // DDS magic is 'DDS '
                    if (buf.toString('utf8', 0, 4) === 'DDS ') {
                        metadata.height = buf.readUInt32LE(12);
                        metadata.width = buf.readUInt32LE(16);
                        metadata.mipmaps = buf.readUInt32LE(28);
                        
                        // Pixel format starts at 76
                        const flags = buf.readUInt32LE(80);
                        const fourCC = buf.toString('utf8', 84, 88);
                        if (flags & 0x4) {
                            metadata.format = fourCC; // e.g. DXT1, DXT5, DX10
                        } else {
                            metadata.format = 'Uncompressed/RGB';
                        }
                    }
                } finally {
                    await fd.close();
                }
            } else if (ext === '.tga') {
                const fd = await fs.promises.open(filePath, 'r');
                try {
                    const buf = Buffer.alloc(18);
                    await fd.read(buf, 0, 18, 0);
                    metadata.width = buf.readUInt16LE(12);
                    metadata.height = buf.readUInt16LE(14);
                    const bpp = buf.readUInt8(16);
                    metadata.format = `TGA ${bpp}bpp`;
                } finally {
                    await fd.close();
                }
            } else {
                metadata.format = ext.replace('.', '').toUpperCase();
                metadata.hint = 'To view exact dimensions of png/jpg, use an image preview or node image-size library. Standard read gives only basic metadata.';
            }

            return {
                content: JSON.stringify(metadata, null, 2),
                totalLines: 1,
                truncated: false,
            };
        } catch (e: any) {
            return { content: `Error reading image metadata: ${e.message}`, totalLines: 0, truncated: false };
        }
    }

    // - writeFile -

    async writeFile(args: { file: string; content: string; encoding?: string }, context?: import('../types').AgentToolContext): Promise<import('../types').WriteFileResult> {
        return this.executeWithLock(args.file, async () => {
            try {
                args.file = await this.resolveAndAuthorizeWrite(args.file, 'write_file', context);
                const ymlReject = this.rejectGenericYmlWrite('write_file', args.file);
                if (ymlReject) return ymlReject;
                
                // Security blocking has been removed: allowing AI to overwrite files directly
                const { content: originalContent, hasBom } = this.readTextFile(args.file, context);
                (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(args.file, originalContent);

                const pdxStructureReject = this.rejectUnsafePdxStructureWrite('write_file', args.file, originalContent, args.content);
                if (pdxStructureReject) {
                    return { success: false, message: pdxStructureReject };
                }

                const _diff = this.buildUnifiedDiff(args.file, originalContent ?? '', args.content);

                const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                    const messageId = `write_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(args.file, args.content, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User cancelled the write operation' };
                    }
                } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                    const isNewFile = !fs.existsSync(args.file);
                    this.ctx.onAutoWritten(args.file, isNewFile);
                }

                const preWriteEpoch = (await this.queryDiagnosticsFresh(args.file))?.epoch ?? 0;
                this.writeTextFile(args.file, args.content, hasBom, args.encoding, context);
                const freshResult = await this.getLspDiagnosticsForFileFresh(args.file, preWriteEpoch);
                return {
                    success: true,
                    message: `File written: ${args.file}. Freshness: ${freshResult.freshness}`,
                    diagnostics: freshResult.diagnostics,
                    freshness: freshResult.freshness,
                    pendingGlobalKinds: freshResult.pendingGlobalKinds,
                };
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }
        });
    }


    async editFile(args: import('../types').EditFileArgs, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return { success: false, message: 'Error: missing or invalid "filePath".' };
        }
        if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
            return { success: false, message: 'Error: edit_file requires string oldString and newString.' };
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'edit_file', context);
                const ymlReject = this.rejectGenericYmlWrite('edit_file', args.filePath);
                if (ymlReject) return ymlReject as any;
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
            const fileExists = fs.existsSync(filePath);
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            let newContent: string;

            try {
                if (args.oldString.length === 0) {
                    if (fileExists && originalContent.length > 0) {
                        const hint = this.recordEditFailure(filePath);
                        return { success: false, message: `edit_file refused an empty oldString for existing file ${path.basename(filePath)}. Use write_file for whole-file replacement or provide the exact text to replace.${hint}` };
                    }
                    newContent = args.newString;
                } else {
                    const oldText = this.convertLineEnding(this.normalizeLineEndings(args.oldString), this.detectLineEnding(originalContent));
                    const nextText = this.convertLineEnding(this.normalizeLineEndings(args.newString), this.detectLineEnding(originalContent));
                    newContent = this.replace(originalContent, oldText, nextText, args.replaceAll === true);
                }
            } catch (e) {
                const hint = this.recordEditFailure(filePath);
                return { success: false, message: `edit_file failed for ${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}${hint}` };
            }

            if (newContent === originalContent) {
                return { success: true, message: `edit_file made no changes to ${path.basename(filePath)}.` };
            }

            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('edit_file', filePath, originalContent, newContent);
            if (pdxStructureReject) {
                const hint = this.recordEditFailure(filePath);
                return { success: false, message: pdxStructureReject + hint };
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);
            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `edit_${crypto.randomUUID()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the edit_file operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, !fileExists);
            }

            const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0;
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, fileExists ? originalContent : null);
            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            this.editFailCount.delete(filePath);
            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch);
            const diagnostics = freshResult.diagnostics;
            const oldLineCount = originalContent.length === 0 ? 0 : originalContent.split(/\r?\n/).length;
            const newLineCount = newContent.length === 0 ? 0 : newContent.split(/\r?\n/).length;
            return {
                success: true,
                message: `edit_file: updated ${path.basename(filePath)}`,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
                stats: {
                    linesAdded: Math.max(0, newLineCount - oldLineCount),
                    linesRemoved: Math.max(0, oldLineCount - newLineCount),
                },
            };
        });
    }


    // - astMutate -

    async astMutate(args: import('../types').AstMutateArgs, context?: import('../types').AgentToolContext): Promise<import('../types').AstMutateResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return {
                success: false,
                message: 'Error: missing or invalid "filePath" parameter. Must provide an absolute file path.',
            } as any;
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'ast_mutate', context);
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
        const pdxStructureReject = this.rejectUnsafePdxStructureWrite('ast_mutate', filePath, originalContent, newContent);
        if (pdxStructureReject) {
            return { success: false, message: pdxStructureReject };
        }
        const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context)) {
            const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `ast_${Date.now()}`);
            if (!confirmed) {
                return { success: false, message: 'User cancelled the edit operation', pendingDiff: diff };
            }
        } else if (this.ctx.onAutoWritten) {
            this.ctx.onAutoWritten(filePath, false);
        }

        const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0;
        try {
            this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
        } catch (e) {
            return { success: false, message: `Write failed: ${String(e)}` };
        }

            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch);
            const diagnostics = freshResult.diagnostics;
            return {
                success: true,
                nodeFound: true,
                message: `AST surgery successful (${args.action} on ${args.targetPath.join(' -> ')}). File updated: ${path.basename(filePath)}`,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
            };
        });
    }



    // - multiReplaceFileContent -

    async multiReplaceFileContent(args: {
        TargetFile: string;
        Instruction: string;
        ReplacementChunks: Array<{
            StartLine: number;
            EndLine: number;
            TargetContent: string;
            ReplacementContent: string;
        }>;
        encoding?: string;
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        if (!args.TargetFile || typeof args.TargetFile !== 'string') {
            return { success: false, message: 'Error: missing or invalid "TargetFile".' } as any;
        }

        return this.executeWithLock(args.TargetFile, async () => {
            try {
                args.TargetFile = await this.resolveAndAuthorizeWrite(args.TargetFile, 'multi_replace_file_content', context);
                const ymlReject = this.rejectGenericYmlWrite('multi_replace_file_content', args.TargetFile);
                if (ymlReject) return ymlReject as any;
            } catch (e) {
                return { success: false, message: String(e) };
            }
            const filePath = args.TargetFile;
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            let content = originalContent;
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent || null);

            const ending = this.detectLineEnding(content);
            const lines = content.split(/\r?\n/);

            const errors: string[] = [];

            // Sort chunks by StartLine descending to avoid offset issues when mutating line by line
            const chunks = [...args.ReplacementChunks].sort((a, b) => b.StartLine - a.StartLine);

            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i]!;
                const startIdx = chunk.StartLine - 1;
                const endIdx = chunk.EndLine - 1;
                
                if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
                    errors.push(`Chunk ${i+1}: Invalid line range [${chunk.StartLine}, ${chunk.EndLine}] for file with ${lines.length} lines.`);
                    continue;
                }

                // Get target section
                const section = lines.slice(startIdx, endIdx + 1).join('\n');
                
                // Process strings for replacement
                const oldText = this.convertLineEnding(this.normalizeLineEndings(chunk.TargetContent), '\n');
                const nextText = this.convertLineEnding(this.normalizeLineEndings(chunk.ReplacementContent), '\n');
                
                if (oldText === nextText) {
                    // No change
                    continue;
                }

                if (!section.includes(oldText)) {
                    try {
                        const fuzzySection = this.replace(section, oldText, nextText, false);
                        const newSectionLines = fuzzySection.split('\n');
                        lines.splice(startIdx, endIdx - startIdx + 1, ...newSectionLines);
                        continue;
                    } catch {
                        errors.push(`Chunk ${i+1}: TargetContent not found in the specified line range [${chunk.StartLine}, ${chunk.EndLine}]. Check your string matching.`);
                        continue;
                    }
                }
                
                const newSection = section.replace(oldText, nextText);
                const newSectionLines = newSection.split('\n');
                
                // Replace lines in array
                lines.splice(startIdx, endIdx - startIdx + 1, ...newSectionLines);
            }

            if (errors.length > 0) {
                return { success: false, message: `Multi-replace failed with ${errors.length} error(s):\\n- ${errors.join('\\n- ')}` + this.recordEditFailure(filePath) } as any;
            }

            content = lines.join(ending);
            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('multi_replace_file_content', filePath, originalContent, content);
            if (pdxStructureReject) {
                return { success: false, message: pdxStructureReject + this.recordEditFailure(filePath) } as any;
            }
            const diff = this.buildUnifiedDiff(filePath, originalContent, content);

            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, content, `multireplace_${Date.now()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the multi_replace operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0;
            try {
                this.writeTextFile(filePath, content, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            this.editFailCount.delete(filePath);
            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch);
            const diagnostics = freshResult.diagnostics;
            
            let message = `multi_replace_file_content: ${chunks.length} replacement(s) applied to ${path.basename(filePath)}`;
            const errorsDiags = diagnostics.filter((d: any) => d.severity === 'error');
            if (errorsDiags.length > 0) {
                message += `\\n\\nLSP detected ${errorsDiags.length} error(s) - please fix:\\n` +
                    errorsDiags.slice(0, 5).map((e: any) => `  Line ${e.line + 1}: ${e.message}`).join('\\n');
            }

            return {
                success: true, message, diff, diagnostics: diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
            } as any;
        });
    }

    // - applyPatch -

    async replaceLines(args: import('../types').ReplaceLinesArgs, context?: import('../types').AgentToolContext): Promise<import('../types').ReplaceLinesResult> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            return { success: false, message: 'Error: missing or invalid "filePath".' };
        }

        return this.executeWithLock(args.filePath, async () => {
            try {
                args.filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'replace_lines', context);
                const ymlReject = this.rejectGenericYmlWrite('replace_lines', args.filePath);
                if (ymlReject) return ymlReject as any;
            } catch (e) {
                return { success: false, message: String(e) };
            }

            const filePath = args.filePath;
            const { content: originalContent, hasBom } = this.readTextFile(filePath, context);
            const lines = originalContent.split(/\r?\n/);
            const startLine = Math.trunc(args.startLine);
            const endLine = Math.trunc(args.endLine);

            if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
                return { success: false, message: 'replace_lines requires numeric startLine and endLine.' + this.recordEditFailure(filePath) };
            }
            if (startLine < 1 || endLine < startLine || endLine > lines.length) {
                return { success: false, message: `Invalid line range [${args.startLine}, ${args.endLine}] for file with ${lines.length} lines.` + this.recordEditFailure(filePath) };
            }

            const ending = this.detectLineEnding(originalContent);
            const currentRange = lines.slice(startLine - 1, endLine).join('\n');
            const normalizedCurrentRange = this.convertLineEnding(this.normalizeLineEndings(currentRange), '\n');
            const guardErrors: string[] = [];

            if (typeof args.expectedContent === 'string') {
                const expected = this.convertLineEnding(this.normalizeLineEndings(args.expectedContent), '\n');
                if (normalizedCurrentRange !== expected) {
                    guardErrors.push('expectedContent did not match the current line range');
                }
            }
            if (typeof args.expectedHash === 'string' && args.expectedHash.trim()) {
                const actualHash = crypto.createHash('sha256').update(normalizedCurrentRange, 'utf8').digest('hex');
                if (actualHash.toLowerCase() !== args.expectedHash.trim().toLowerCase()) {
                    guardErrors.push(`expectedHash did not match current line range (actual sha256: ${actualHash})`);
                }
            }
            if (typeof args.expectedStartText === 'string' && args.expectedStartText.trim()) {
                const expectedStart = this.convertLineEnding(this.normalizeLineEndings(args.expectedStartText), '\n').trimStart();
                if (!normalizedCurrentRange.trimStart().startsWith(expectedStart)) {
                    guardErrors.push('expectedStartText did not match the current line range');
                }
            }
            if (typeof args.expectedEndText === 'string' && args.expectedEndText.trim()) {
                const expectedEnd = this.convertLineEnding(this.normalizeLineEndings(args.expectedEndText), '\n').trimEnd();
                if (!normalizedCurrentRange.trimEnd().endsWith(expectedEnd)) {
                    guardErrors.push('expectedEndText did not match the current line range');
                }
            }
            if (guardErrors.length > 0) {
                const preview = normalizedCurrentRange.split('\n').slice(0, 12).join('\n');
                return {
                    success: false,
                    message: `replace_lines safety check failed for ${path.basename(filePath)} lines ${startLine}-${endLine}: ${guardErrors.join('; ')}. The file may have changed since the line numbers were chosen. Re-read the current context with get_file_context/read_file, then retry with updated line numbers and expectedContent.` + this.recordEditFailure(filePath),
                    currentContentPreview: preview,
                } as any;
            }

            const replacement = this.convertLineEnding(this.normalizeLineEndings(args.newContent), '\n');
            const replacementLines = replacement.length === 0 ? [] : replacement.split('\n');
            lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
            const newContent = lines.join(ending);

            if (newContent === originalContent) {
                return { success: true, message: `replace_lines made no changes to ${path.basename(filePath)}.` };
            }

            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('replace_lines', filePath, originalContent, newContent);
            if (pdxStructureReject) {
                return { success: false, message: pdxStructureReject + this.recordEditFailure(filePath) };
            }

            const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);
            const vfsOverlay = context?.runnerOptions?.vfsOverlay ?? this.ctx.vfsOverlay;
            if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, `replace_lines_${Date.now()}`);
                if (!confirmed) {
                    return { success: false, message: 'User cancelled the replace_lines operation', pendingDiff: diff };
                }
            } else if (this.ctx.onAutoWritten && !vfsOverlay) {
                this.ctx.onAutoWritten(filePath, false);
            }

            const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0;
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(filePath, originalContent || null);
            try {
                this.writeTextFile(filePath, newContent, hasBom, args.encoding, context);
            } catch (e) {
                return { success: false, message: `Write failed: ${String(e)}` };
            }

            this.editFailCount.delete(filePath);
            const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch);
            const diagnostics = freshResult.diagnostics;
            let message = `replace_lines: replaced lines ${startLine}-${endLine} in ${path.basename(filePath)}`;
            const errorsDiags = diagnostics.filter((d: any) => d.severity === 'error');
            if (errorsDiags.length > 0) {
                message += `\n\nLSP detected ${errorsDiags.length} error(s) - please fix:\n` +
                    errorsDiags.slice(0, 5).map((e: any) => `  Line ${e.line + 1}: ${e.message}`).join('\n');
            }

            return {
                success: true,
                message,
                diff,
                diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
            };
        });
    }

    async applyPatch(args: { patch: string; cwd?: string }, context?: import('../types').AgentToolContext): Promise<{
        success: boolean;
        filesChanged: string[];
        errors: string[];
        diagnostics?: Array<{
            file: string;
            diagnostics: ValidationError[];
            freshness: 'fresh' | 'pending' | 'stale';
            pendingGlobalKinds: string[];
        }>;
    }> {
        const cwd = args.cwd ?? this.ctx.workspaceRoot;

        try {
            this.resolveAndAssertInWorkspace(cwd, context);
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
                        currentFile = await this.resolveAndAuthorizeWrite(currentFile, 'apply_patch', context);
                        const ymlReject = this.rejectGenericYmlWrite('apply_patch', currentFile);
                        if (ymlReject) {
                            return { success: false, filesChanged: [], errors: [ymlReject.message] };
                        }
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
            const hints: string[] = [];
            for (const filePath of byFile.keys()) {
                const hint = this.recordEditFailure(filePath);
                if (hint) hints.push(hint.trim());
            }
            if (hints.length > 0) {
                errors.push(...hints);
            }
            return { success: false, filesChanged: [], errors };
        }

        for (const { filePath, newContent } of pendingWrites) {
            const originalContent = byFile.get(filePath)?.content ?? '';
            const pdxStructureReject = this.rejectUnsafePdxStructureWrite('apply_patch', filePath, originalContent, newContent);
            if (pdxStructureReject) {
                errors.push(pdxStructureReject);
            }
        }

        if (errors.length > 0) {
            const hints: string[] = [];
            for (const filePath of byFile.keys()) {
                const hint = this.recordEditFailure(filePath);
                if (hint) hints.push(hint.trim());
            }
            if (hints.length > 0) {
                errors.push(...hints);
            }
            return { success: false, filesChanged: [], errors };
        }

        // P1-5 Fix: capture snapshots of original content BEFORE the confirmation loop.
        // This prevents a bug where user hand-edits a file between the confirm prompt
        // and the actual write - ensuring retract restores the true pre-AI state.
        const originalContents = new Map<string, string | null>();
        for (const { filePath } of pendingWrites) {
            const { content: prevContent } = this.readTextFile(filePath);
            originalContents.set(filePath, prevContent !== '' ? prevContent : null);
        }

        const filesChanged: string[] = [];
        const preWriteEpochs = new Map<string, number>();
        if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context)) {
            for (const { filePath, newContent } of pendingWrites) {
                const messageId = `patch_${crypto.randomUUID()}`;
                const confirmed = await this.ctx.onPendingWrite(filePath, newContent, messageId);
                if (!confirmed) {
                    return {
                        success: false,
                        filesChanged: [],
                        errors: [`${path.basename(filePath)}: User cancelled write - no files were modified`],
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
            preWriteEpochs.set(filePath, (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0);
            try {
                this.writeTextFile(filePath, newContent, hasBom, undefined, context);
                filesChanged.push(path.relative(this.ctx.workspaceRoot, filePath).replace(/\\/g, '/'));
            } catch (e) {
                errors.push(`Writing ${path.basename(filePath)} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        const diagnostics: Array<{ file: string; diagnostics: ValidationError[]; freshness: 'fresh' | 'pending' | 'stale'; pendingGlobalKinds: string[] }> = [];
        for (const filePath of filesChanged) {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.ctx.workspaceRoot, filePath);
            const freshResult = await this.getLspDiagnosticsForFileFresh(absolutePath, preWriteEpochs.get(absolutePath) ?? 0);
            diagnostics.push({
                file: filePath,
                diagnostics: freshResult.diagnostics,
                freshness: freshResult.freshness,
                pendingGlobalKinds: freshResult.pendingGlobalKinds,
            });
        }

        return {
            success: errors.length === 0,
            filesChanged,
            errors,
            diagnostics,
        };
    }

    // - listDirectory -

    async listDirectory(args: { directory: string; recursive?: boolean }, context?: import('../types').AgentToolContext): Promise<import('../types').ListDirectoryResult> {
        try {
            const dirPath = this.resolveAndAssertInWorkspace(args.directory, context);
            const limit = 200;

            if (!fs.existsSync(dirPath)) {
                return { entries: [], path: dirPath, truncated: false, hasMore: false, returnedCount: 0, limit };
            }

            const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];
            this.listDirRecursive(dirPath, dirPath, entries, args.recursive ?? false, 0, 3, limit + 1);
            const hasMore = entries.length > limit;

            return { entries: entries.slice(0, limit), path: dirPath, truncated: hasMore, hasMore, returnedCount: Math.min(entries.length, limit), limit };
        } catch (e) {
            return { entries: [], path: args.directory, truncated: false, hasMore: false, returnedCount: 0, limit: 200, error: e instanceof Error ? e.message : String(e) };
        }
    }

    private listDirRecursive(
        baseDir: string,
        currentDir: string,
        results: Array<{ name: string; type: 'file' | 'directory'; size?: number }>,
        recursive: boolean,
        depth: number,
        maxDepth: number,
        maxEntries = 200
    ): void {
        if (depth > maxDepth || results.length >= maxEntries) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxEntries) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const relPath = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                results.push({ name: relPath + '/', type: 'directory' });
                if (recursive) {
                    this.listDirRecursive(baseDir, path.join(currentDir, entry.name), results, recursive, depth + 1, maxDepth, maxEntries);
                }
            } else {
                const stat = fs.statSync(path.join(currentDir, entry.name));
                results.push({ name: relPath, type: 'file', size: stat.size });
            }
        }
    }

    // - globFiles -

    async globFiles(args: { pattern: string; limit?: number }): Promise<{ files: string[]; truncated: boolean; hasMore: boolean; returnedCount: number; limit: number; error?: string }> {
        try {
            const limit = Math.min(args.limit ?? 200, 500);
            const uris = await vs.workspace.findFiles(args.pattern, '**/node_modules/**', limit + 1);
            const hasMore = uris.length > limit;
            const files = uris.slice(0, limit).map(u => u.fsPath);
            return { files, truncated: hasMore, hasMore, returnedCount: files.length, limit };
        } catch (e) {
            return { files: [], truncated: false, hasMore: false, returnedCount: 0, limit: Math.min(args.limit ?? 200, 500), error: e instanceof Error ? e.message : String(e) };
        }
    }

// - getLspDiagnosticsForFile -

    /** Extract diagnostics from Problems panel and format */
    private static mapDiagnostics(uri: vs.Uri): ValidationError[] {
        return vs.languages.getDiagnostics(uri).map(d => {
            const metadata = diagnosticMetadata(d);
            return {
                code: String(d.code ?? ''),
                severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                        : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                message: d.message,
                line: d.range.start.line,
                column: d.range.start.character,
                category: metadata.category,
                repairHint: metadata.repairHint,
                expectedType: metadata.expectedType,
                actualType: metadata.actualType,
                scope: metadata.scope,
                symbol: metadata.symbol,
                confidence: metadata.confidence,
                metadataSource: metadata.metadataSource,
                data: metadata.data,
            } as ValidationError;
        });
    }


    /** 
* Query the LSP for the current diagnostic status of the file (return immediately, without blocking). 
* Returning null indicates that the LSP is unavailable. 
*/
    private async queryDiagnosticsFresh(filePath: string): Promise<{
        freshness: 'fresh' | 'pending' | 'stale';
        epoch: number;
        pendingGlobalKinds: string[];
        diagnostics?: ValidationError[];
    } | null> {
        try {
            const client = (this.ctx as any).client;
            if (!client) return null;
            const uri = vs.Uri.file(filePath);
            const result = await client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.getDiagnosticsFresh',
                arguments: [uri.toString()],
            }) as Record<string, unknown> | null;
            if (result && typeof result === 'object' && 'freshness' in result) {
                return {
                    freshness: String(result.freshness) as 'fresh' | 'pending' | 'stale',
                    epoch: typeof result.epoch === 'number' ? result.epoch : 0,
                    pendingGlobalKinds: Array.isArray(result.pendingGlobalKinds)
                        ? (result.pendingGlobalKinds as string[]) : [],
                    diagnostics: Array.isArray(result.diagnostics)
                        ? (result.diagnostics as ValidationError[]) : undefined,
                };
            }
        } catch { /* LSP is not available */ }
        return null;
    }

    /** 
* The client side polls getDiagnosticsFresh and waits for epoch > minEpoch (i.e. the new lint has completed). 
* Does not hold any server-side locks to avoid deadlocks. Wait at most timeoutMs (default 3000ms). 
* 
* @param minEpoch epoch value before writing, waiting for epoch > minEpoch means lint has processed this write 
*/
    async getLspDiagnosticsForFileFresh(filePath: string, minEpoch = 0): Promise<{
        diagnostics: ValidationError[];
        freshness: 'fresh' | 'pending' | 'stale';
        pendingGlobalKinds: string[];
        epoch: number;
        timedOut?: boolean;
    }> {
        const timeoutMs = 3000;
        const pollIntervalMs = 100;
        const uri = vs.Uri.file(filePath);
        try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }

        //Client-side polling getDiagnosticsFresh (returns immediately, does not hold a lock)
        let elapsed = 0;
        let lastState: Awaited<ReturnType<typeof this.queryDiagnosticsFresh>> = null;
        while (elapsed < timeoutMs) {
            lastState = await this.queryDiagnosticsFresh(filePath);
            if (lastState) {
                // Waiting conditions: epoch > minEpoch (indicating that the new lint has been completed), and freshness != stale
                if (lastState.epoch > minEpoch && lastState.freshness !== 'stale') {
                    return {
                        diagnostics: lastState.diagnostics ?? FileToolHandler.mapDiagnostics(uri),
                        freshness: lastState.freshness,
                        pendingGlobalKinds: lastState.pendingGlobalKinds,
                        epoch: lastState.epoch,
                        timedOut: false,
                    };
                }
            } else {
                break; // LSP is unavailable, go to fallback
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
            elapsed += pollIntervalMs;
        }

        // Timed out but LSP available - return current state + timedOut
        if (lastState) {
            return {
                diagnostics: lastState.diagnostics ?? FileToolHandler.mapDiagnostics(uri),
                freshness: lastState.freshness,
                pendingGlobalKinds: lastState.pendingGlobalKinds,
                epoch: lastState.epoch,
                timedOut: true,
            };
        }

        // Fallback: LSP is not available, use the old Problems panel to debounce and wait
        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        return {
            diagnostics,
            freshness: 'pending',
            pendingGlobalKinds: [],
            epoch: 0,
        };
    }

    /** Wait (up to 2s) for LSP to process a file, then return its diagnostics (fallback) */
    async getLspDiagnosticsForFile(filePath: string): Promise<ValidationError[]> {
        try {
            const uri = vs.Uri.file(filePath);
            try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
            // P3 Fix: debounce diagnostic events - wait 300ms after last change
            // to avoid returning incomplete diagnostics from intermediate LSP states
            await new Promise<void>((resolve) => {
                let settled = false;
                let debounce: ReturnType<typeof setTimeout> | null = null;
                // eslint-disable-next-line prefer-const -- deferred initialization
                let sub: vs.Disposable | undefined;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (debounce) clearTimeout(debounce);
                    clearTimeout(maxTimeout);
                    sub?.dispose();
                    resolve();
                };
                const maxTimeout = setTimeout(finish, 2000);
                sub = vs.languages.onDidChangeDiagnostics((e) => {
                    if (e.uris.some(u => u.fsPath === uri.fsPath)) {
                        if (debounce) clearTimeout(debounce);
                        debounce = setTimeout(finish, 300);
                    }
                });
            });
            return vs.languages.getDiagnostics(uri).map(d => {
                const metadata = diagnosticMetadata(d);
                return {
                    code: String(d.code ?? ''),
                    severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                            : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                    message: d.message,
                    line: d.range.start.line,
                    column: d.range.start.character,
                    category: metadata.category,
                    repairHint: metadata.repairHint,
                    expectedType: metadata.expectedType,
                    actualType: metadata.actualType,
                    scope: metadata.scope,
                    symbol: metadata.symbol,
                    confidence: metadata.confidence,
                    metadataSource: metadata.metadataSource,
                    data: metadata.data,
                } as ValidationError;
            });
        } catch { return []; }
    }

    // - OpenCode Replacer Suite -
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

    // - write_localisation -

    async writeLocalisation(args: {
        filePath: string;
        language: string;
        entries: Array<{ key: string; value: string; number?: number; comment?: string }>;
    }, context?: import('../types').AgentToolContext): Promise<import('../types').EditFileResult> {
        return this.executeWithLock(args.filePath, async () => {
            try {
                const filePath = await this.resolveAndAuthorizeWrite(args.filePath, 'write_localisation', context);
                const targetError = this.validateLocalisationTarget(filePath);
                if (targetError) {
                    return { success: false, message: targetError };
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

                // Build a map of existing keys -> line index for O(1) lookup
                const keyLineMap = new Map<string, number>();
                // Match any Stellaris loc key: leading space, key chars, colon, optional digits, then space or quote
                const keyRegex = /^\s+([\w.-]+):\d*\s*(?:"|$)/;
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
                    // AI sends JSON \n -> 0x0A newline; or JSON \\n -> literal \n
                    // Stellaris needs literal \n (backslash+n) for in-game line breaks
                    const val = entry.value
                        .replace(/\r\n/g, String.raw`\n`)     // CRLF -> literal \n
                        .replace(/\n/g, String.raw`\n`)        // LF -> literal \n
                        .replace(/\r/g, '')                     // stray CR -> remove
                        .replace(/\t/g, String.raw`\t`)        // tab -> literal \t
                        .replace(/\u201C|\u201D/g, '"')         // smart quotes -> ASCII
                        .replace(/\u2018|\u2019/g, "'");        // smart apostrophes -> ASCII
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
                if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !this.shouldBypassWriteConfirmation(args, context) && !vfsOverlay) {
                    const messageId = `writeloc_${crypto.randomUUID()}`;
                    const confirmed = await this.ctx.onPendingWrite(filePath, withBom, messageId);
                    if (!confirmed) {
                        return { success: false, message: 'User rejected localisation write.' };
                    }
                }

                const preWriteEpoch = (await this.queryDiagnosticsFresh(filePath))?.epoch ?? 0;

                // Write
                if (vfsOverlay) {
                    vfsOverlay.set(filePath, withBom);
                } else {
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    await fs.promises.writeFile(filePath, withBom, 'utf-8');
                }
                const readTracker = (context?.agentRunner as any)?.readTracker;
                if (readTracker) { readTracker.markWritten(filePath); }

                // Clear failure counter for this file since we succeeded
                this.editFailCount.delete(filePath);

                const diff = this.buildUnifiedDiff(filePath, originalContent, withBom);

                // Get the diagnostic freshness after localized writing
                const freshResult = await this.getLspDiagnosticsForFileFresh(filePath, preWriteEpoch);
                const diagnostics = freshResult.diagnostics;
                const finalKeySet = new Set<string>();
                for (const line of finalContent.split(/\r?\n/)) {
                    const m = line.match(keyRegex);
                    if (m) finalKeySet.add(m[1]!);
                }
                const localKeyIndexed = args.entries.every(entry => finalKeySet.has(entry.key));
                const fileSyntaxFresh = !diagnostics.some(d => d.severity === 'error' && /^CW001/.test(d.code));
                const globalLocalisationFresh = freshResult.freshness === 'fresh' && !freshResult.pendingGlobalKinds.includes('localisation');

                return {
                    success: true,
                    message: `Localisation updated: ${added} added, ${updated} updated. Total entries: ${args.entries.length}. Freshness: ${freshResult.freshness}`,
                    diff,
                    diagnostics,
                    freshness: freshResult.freshness,
                    pendingGlobalKinds: freshResult.pendingGlobalKinds,
                    fileSyntaxFresh,
                    localKeyIndexed,
                    globalLocalisationFresh,
                    stats: { linesAdded: added, linesRemoved: 0 },
                };
            } catch (e) {
                return { success: false, message: `write_localisation failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });
    }

    // - writeDesignBlueprint -

    async writeDesignBlueprint(args: import('../types').WriteDesignBlueprintArgs, context?: import('../types').AgentToolContext): Promise<import('../types').WriteDesignBlueprintResult> {
        try {
            const failBlueprint = (message: string): import('../types').WriteDesignBlueprintResult => ({
                success: false,
                message,
                filePath: '',
            });
            const hasItems = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0;
            const requiredSections: Array<[string, unknown]> = [
                ['entities', args.entities],
                ['commonDirectoryReview', args.commonDirectoryReview],
                ['subsystemPlan', args.subsystemPlan],
                ['triggerPlan', args.triggerPlan],
                ['rewardPlan', args.rewardPlan],
                ['cleanupPlan', args.cleanupPlan],
                ['evidence', args.evidence],
                ['dependencyOrder', args.dependencyOrder],
            ];
            const missingSections = requiredSections
                .filter(([, value]) => !hasItems(value))
                .map(([name]) => name);
            if (missingSections.length > 0) {
                return failBlueprint(`Design blueprint refused: missing required planning section(s): ${missingSections.join(', ')}. For complex PDXScript pipelines, include common/ capability review, subsystem plan, trigger plan, reward plan, cleanup plan, evidence, and dependency order.`);
            }

            const commonReview = args.commonDirectoryReview!;
            const hasSelectedCommon = commonReview.some(item => item.selected === true);
            const hasRejectedCommon = commonReview.some(item => item.selected === false);
            if (!hasSelectedCommon || !hasRejectedCommon) {
                return failBlueprint('Design blueprint refused: commonDirectoryReview must include at least one selected and one rejected common/ candidate so the plan shows a real design-space comparison.');
            }
            const commonWithoutFindings = commonReview
                .filter(item => !String(item.findings ?? '').trim())
                .map(item => item.directory);
            if (commonWithoutFindings.length > 0) {
                return failBlueprint(`Design blueprint refused: commonDirectoryReview entries need concrete CWT/project/vanilla findings. Missing findings for: ${commonWithoutFindings.join(', ')}.`);
            }

            const entitiesMissingScope = args.entities
                .filter(entity => !String(entity.scopeContext ?? '').trim())
                .map(entity => entity.id);
            if (entitiesMissingScope.length > 0) {
                return failBlueprint(`Design blueprint refused: every entity needs a scopeContext, even if it is "definition/no runtime scope". Missing scopeContext for: ${entitiesMissingScope.join(', ')}.`);
            }

            const rewardWithoutImplementation = args.rewardPlan!
                .filter(reward => !String(reward.directory ?? '').trim() || !String(reward.entityType ?? '').trim() || !String(reward.implementation ?? '').trim())
                .map(reward => reward.rewardId);
            if (rewardWithoutImplementation.length > 0) {
                return failBlueprint(`Design blueprint refused: every reward must name a concrete directory/entity type and implementation path. Incomplete reward(s): ${rewardWithoutImplementation.join(', ')}.`);
            }

            const cleanupWithoutMechanism = args.cleanupPlan!
                .filter(item => !String(item.cleanup ?? '').trim())
                .map(item => item.target);
            if (cleanupWithoutMechanism.length > 0) {
                return failBlueprint(`Design blueprint refused: cleanupPlan entries need exact cleanup or closure mechanisms. Missing cleanup for: ${cleanupWithoutMechanism.join(', ')}.`);
            }

            const evidence = args.evidence!;
            const evidenceText = evidence
                .map(item => `${item.sourceType} ${item.source} ${item.insight}`)
                .join('\n')
                .toLowerCase();
            if (!/(cwt|lsp|query_rules|query_scope|query_types|scope|rule)/.test(evidenceText)) {
                return failBlueprint('Design blueprint refused: evidence must include at least one CWT/LSP or typed-rule verification source.');
            }
            if (!/(common_inventory|common\/|list_directory\("common"\)|list_directory\('common'\)|common directory)/.test(evidenceText)) {
                return failBlueprint('Design blueprint refused: evidence must include the common/ inventory or common directory findings used to choose subsystems.');
            }

            // Save to topic-scoped folder (same as Implementation_Plan.md)
            const topicId = context?.runnerOptions?.topicId || 'default';
            const blueprintDir = getTopicStorageDir(topicId, this.ctx.workspaceRoot);
            if (!fs.existsSync(blueprintDir)) fs.mkdirSync(blueprintDir, { recursive: true });
            const blueprintPath = path.join(blueprintDir, 'design_blueprint.md');
            const previousContent = fs.existsSync(blueprintPath) ? fs.readFileSync(blueprintPath, 'utf-8') : null;

            const lines: string[] = [];
            lines.push(`# Design Blueprint: ${args.title}`);
            lines.push('');
            lines.push(`> Auto-generated by AI Agent - Plan Mode`);
            lines.push(`> Generated: ${new Date().toISOString()}`);
            lines.push('');

            lines.push('## Blueprint Completeness Gate');
            lines.push('');
            lines.push('- [x] Common directory review includes selected and rejected candidates');
            lines.push('- [x] Entity topology includes scopeContext for every entity');
            lines.push('- [x] Trigger, reward, cleanup, and dependency plans are present');
            lines.push('- [x] Evidence includes CWT/LSP verification and common/ inventory findings');
            lines.push('');

            const cell = (value: unknown): string => {
                if (value === undefined || value === null || value === '') return '-';
                return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
            };
            const listCell = (values?: string[]): string => values && values.length > 0 ? values.map(cell).join(', ') : '-';

            // Common directory capability review
            if (args.commonDirectoryReview && args.commonDirectoryReview.length > 0) {
                lines.push('## Common Directory Capability Review');
                lines.push('');
                lines.push('| Directory | Role Considered | Candidate Types | Used | Rationale | Findings |');
                lines.push('|-----------|-----------------|-----------------|------|-----------|----------|');
                for (const item of args.commonDirectoryReview) {
                    lines.push(`| \`${cell(item.directory)}\` | ${cell(item.role)} | ${listCell(item.candidateTypes)} | ${item.selected ? 'yes' : 'no'} | ${cell(item.rationale)} | ${cell(item.findings)} |`);
                }
                lines.push('');
            }

            // Engine subsystem plan
            if (args.subsystemPlan && args.subsystemPlan.length > 0) {
                lines.push('## Engine Subsystem Plan');
                lines.push('');
                lines.push('| Layer | Common Directories | Entities | Requirement Source | Rationale |');
                lines.push('|-------|--------------------|----------|--------------------|-----------|');
                for (const item of args.subsystemPlan) {
                    lines.push(`| ${cell(item.layer)} | ${listCell(item.directories)} | ${listCell(item.entities)} | ${cell(item.requirementSource)} | ${cell(item.rationale)} |`);
                }
                lines.push('');
            }

            // Entity Topology Map
            lines.push('## Entity Topology (Cascading Trigger Pipeline)');
            lines.push('');
            lines.push('| # | Entity ID | Type | File | Triggered By | Fires | Scope Context |');
            lines.push('|---|-----------|------|------|-------------|-------|---------------|');
            for (let i = 0; i < args.entities.length; i++) {
                const e = args.entities[i]!;
                const fires = listCell(e.fires);
                const triggeredBy = cell(e.triggeredBy);
                const scope = cell(e.scopeContext);
                lines.push(`| ${i + 1} | \`${cell(e.id)}\` | ${cell(e.type)} | \`${cell(e.file)}\` | ${triggeredBy} | ${fires} | ${scope} |`);
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

            // Trigger and pacing plan
            if (args.triggerPlan && args.triggerPlan.length > 0) {
                lines.push('## Trigger and Pacing Plan');
                lines.push('');
                lines.push('| Node | Mechanism | Scope Bridge | Timing | Rationale |');
                lines.push('|------|-----------|--------------|--------|-----------|');
                for (const item of args.triggerPlan) {
                    lines.push(`| \`${cell(item.nodeId)}\` | ${cell(item.mechanism)} | ${cell(item.scopeBridge)} | ${cell(item.timing)} | ${cell(item.rationale)} |`);
                }
                lines.push('');
            }

            // Branching and convergence plan
            if (args.branchingPlan && args.branchingPlan.length > 0) {
                lines.push('## Branching and Convergence Plan');
                lines.push('');
                lines.push('| Branch | Starts From | Choices | Converges At | Consequences |');
                lines.push('|--------|-------------|---------|--------------|--------------|');
                for (const item of args.branchingPlan) {
                    lines.push(`| \`${cell(item.branchId)}\` | \`${cell(item.fromEntity)}\` | ${listCell(item.choices)} | ${cell(item.convergence)} | ${cell(item.consequences)} |`);
                }
                lines.push('');
            }

            // Reward and outcome plan
            if (args.rewardPlan && args.rewardPlan.length > 0) {
                lines.push('## Reward and Outcome Plan');
                lines.push('');
                lines.push('| Reward | Directory | Entity Type | Player Value | Implementation | Balance Notes |');
                lines.push('|--------|-----------|-------------|--------------|----------------|---------------|');
                for (const item of args.rewardPlan) {
                    lines.push(`| \`${cell(item.rewardId)}\` | \`${cell(item.directory)}\` | ${cell(item.entityType)} | ${cell(item.playerValue)} | ${cell(item.implementation)} | ${cell(item.balanceNotes)} |`);
                }
                lines.push('');
            }

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

            // Cleanup and lifecycle closure plan
            if (args.cleanupPlan && args.cleanupPlan.length > 0) {
                lines.push('## Cleanup and Closure Plan');
                lines.push('');
                lines.push('| Target | Lifecycle | Cleanup Mechanism | Owner |');
                lines.push('|--------|-----------|-------------------|-------|');
                for (const item of args.cleanupPlan) {
                    lines.push(`| \`${cell(item.target)}\` | ${cell(item.lifecycle)} | ${cell(item.cleanup)} | ${cell(item.owner)} |`);
                }
                lines.push('');
            }

            // Evidence used to build the design
            if (args.evidence && args.evidence.length > 0) {
                lines.push('## Evidence Studied');
                lines.push('');
                lines.push('| Source Type | Source | Design Insight |');
                lines.push('|-------------|--------|----------------|');
                for (const item of args.evidence) {
                    lines.push(`| ${cell(item.sourceType)} | \`${cell(item.source)}\` | ${cell(item.insight)} |`);
                }
                lines.push('');
            }

            // Risk register
            if (args.riskRegister && args.riskRegister.length > 0) {
                lines.push('## Risk Register');
                lines.push('');
                for (const risk of args.riskRegister) {
                    lines.push(`- ${cell(risk)}`);
                }
                lines.push('');
            }

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
            lines.push('Warning: Before Build phase, verify each entity\'s scope matches CWT rules:');
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
            (context?.onBeforeFileWrite ?? this.ctx.onBeforeFileWrite)?.(blueprintPath, previousContent);
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

    // - Git Operations -

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
                        return { success: true, message: 'Working tree clean - no modified files.', output: '' };
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
