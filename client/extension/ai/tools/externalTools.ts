/**
 * External Tool Handler — web fetch, web search, shell commands,
 * TODO list management, and sub-agent dispatch.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TodoItem, TodoWriteResult } from '../types';
import { preflightCommand } from '../runner/commandPreflight';
import { PermissionPolicyStore } from '../runner/permissionPolicy';
import { getAiStorageRoot, getAiStorageRootCandidates, getTopicScratchDir, getTopicStorageDir } from '../workspacePaths';
import {
    escapeRegExp,
    isPathInsideOrEqual,
    isSecuritySandboxDisabled,
    resolveWorkspacePathInput,
    sanitizePathInput,
} from '../workspaceSandbox';

const COMMAND_SNAPSHOT_MAX_FILE_BYTES = 500_000;
const COMMAND_SNAPSHOT_MAX_TOTAL_BYTES = 24_000_000;
const COMMAND_SNAPSHOT_MAX_FILES = 8000;
const COMMAND_SNAPSHOT_TEXT_EXTENSIONS = new Set([
    '.asset', '.cson', '.css', '.csv', '.cwt', '.fs', '.fsx', '.gfx', '.gui', '.html',
    '.ini', '.js', '.json', '.jsonc', '.jsx', '.loc', '.lua', '.md', '.mod', '.pdxtxt',
    '.ps1', '.py', '.rules', '.sfx', '.shader', '.txt', '.ts', '.tsx', '.xml', '.yaml',
    '.yml',
]);
const COMMAND_SNAPSHOT_TEXT_FILENAMES = new Set([
    'cwtools.md', 'readme', 'license', 'changelog', 'makefile', 'dockerfile',
]);
const COMMAND_TEMP_SCRIPT_EXTENSIONS = new Set([
    '.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh',
]);
const COMMAND_SNAPSHOT_EXCLUDED_DIRS = new Set([
    '.cwtools-ai', '.git', '.hg', '.svn', '.tmp-test', '.vscode-test', '.vs', '.idea',
    'node_modules', 'dist', 'out', 'build', 'coverage',
]);
const COMMAND_TEMP_SCRIPT_DIR_NAMES = new Set([
    '.tmp', 'scratch', 'temp', 'tmp',
]);
const COMMAND_TEMP_SCRIPT_NAME_PATTERN = /^(?:agent_helper|helper|tmp|temp|scratch|batch|bulk|replace|rewrite|fix|verify|check|search|scan)(?:[_\-.].*)?\.(?:bat|cmd|cjs|js|mjs|ps1|py|sh)$/i;

interface CommandFileState {
    filePath: string;
    size: number;
    mtimeMs: number;
    previousContent?: string | null;
    contentCaptured: boolean;
    hadBom?: boolean;
}

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties ExternalToolHandler reads from the executor. */
export interface ExternalToolContext {
    readonly workspaceRoot: string;
    parentRunnerOptions?: import('../agentRunner').AgentRunnerOptions;
    parentTokenAccumulator?: import('../types').TokenUsage;
    /** C5: File write hook for sub-agent isolation (mirrors FileToolContext.onBeforeFileWrite) */
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class ExternalToolHandler {
    private currentTodos: TodoItem[] = [];
    private ignoredCommandTempArtifacts = new Set<string>();

    constructor(private ctx: ExternalToolContext) {}

    private isWithinAnyWorkspace(candidate: string): boolean {
        return resolveWorkspacePathInput(candidate, this.ctx.workspaceRoot, { preferExistingAiPath: true }).isWithinAnyWorkspace;
    }

    private isTrustedCommandWorkspace(candidate: string): boolean {
        return resolveWorkspacePathInput(candidate, this.ctx.workspaceRoot, { preferExistingAiPath: true }).isTrusted;
    }

    private resolveWorkspacePath(inputPath: string): string {
        return resolveWorkspacePathInput(inputPath, this.ctx.workspaceRoot, { preferExistingAiPath: true }).resolved;
    }

    // ─── Permission request assistance: compete with AbortSignal, automatically deny when abort ────────────────

    private quoteCommandPath(filePath: string, alreadyQuoted: boolean): string {
        if (alreadyQuoted) return filePath;
        return /[\s&()!^%;,]/.test(filePath) ? `"${filePath.replace(/"/g, '\\"')}"` : filePath;
    }

    private relativizeCommandPathsForCwd(command: string, cwd: string): string {
        const rewritePath = (rawPath: string): string => {
            if (!path.isAbsolute(rawPath) || !isPathInsideOrEqual(rawPath, cwd)) {
                return rawPath;
            }
            const relPath = path.relative(cwd, rawPath);
            return process.platform === 'win32'
                ? (relPath || '.')
                : (relPath || '.').replace(/\\/g, '/');
        };

        // Pass 1: quoted absolute paths. Model-generated commands sometimes
        // preserve JSON-style escaped quotes, e.g. \"C:\path\" or \"C:\path".
        const quotedOrEscapedPattern = /(^|[\s(])(\\?)(["'])([A-Za-z]:[\\/][^"']+?)(\\?)\3/g;
        const withEscapedQuotedPaths = command.replace(quotedOrEscapedPattern, (match: string, prefix: string, openingEscape: string, quote: string, rawPath: string, closingEscape: string) => {
            const rewritten = rewritePath(rawPath);
            return rewritten === rawPath && !openingEscape && !closingEscape
                ? match
                : `${prefix}${quote}${rewritten.replace(/"/g, '\\"')}${quote}`;
        });

        // Pass 2: normally-quoted paths, e.g. "C:\path with spaces"
        const quotedPattern = /(["'])([A-Za-z]:[\\/][^"']+)\1/g;
        const withQuotedPaths = withEscapedQuotedPaths.replace(quotedPattern, (match: string, _quote: string, rawPath: string) => {
            const rewritten = rewritePath(rawPath);
            if (rewritten === rawPath) return match;
            // Always re-wrap in double-quotes; relative paths may contain spaces
            return `"${rewritten.replace(/"/g, '\\"')}"`;
        });

        // Pass 3: bare (unquoted) absolute paths.
        // Use a character-level scan so we skip any double-quoted spans that were
        // already produced by Passes 1/2, preventing double-rewriting.
        let result = '';
        let pos = 0;
        const src = withQuotedPaths;
        while (pos < src.length) {
            const ch = src[pos]!;
            // Skip double-quoted spans verbatim
            if (ch === '"') {
                const close = src.indexOf('"', pos + 1);
                if (close === -1) { result += src.slice(pos); break; }
                result += src.slice(pos, close + 1);
                pos = close + 1;
                continue;
            }
            // A bare absolute path must be preceded by whitespace, '(' or start-of-string
            if (pos === 0 || ch === ' ' || ch === '\t' || ch === '(') {
                const startOfPath = pos === 0 ? pos : pos + 1;
                const after = src.slice(startOfPath);
                const m = /^([A-Za-z]:[\\/][^\s"';&|<>]+)/.exec(after);
                if (m) {
                    const rawPath = m[1]!;
                    const rewritten = rewritePath(rawPath);
                    if (rewritten !== rawPath) {
                        result += (pos === 0 ? '' : ch) + this.quoteCommandPath(rewritten, false);
                        pos = startOfPath + rawPath.length;
                        continue;
                    }
                }
            }
            result += ch;
            pos++;
        }
        return result;
    }

    private normalizeAgentWorkspaceCommand(command: string, topicId: string): string {
        const aiRoot = getAiStorageRoot(this.ctx.workspaceRoot);
        const aiRoots = getAiStorageRootCandidates(this.ctx.workspaceRoot);
        const safeTopicId = (topicId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const safeTopicLower = safeTopicId.toLowerCase();
        const rewriteAgentPath = (rawPath: string): string => {
            const normalized = rawPath.replace(/\\/g, '/');
            const rest = normalized.replace(/^\.cwtools-ai(?:[\\/]|$)/i, '').replace(/^\/+/, '');
            if (!rest) return aiRoot || '.cwtools-ai';

            const restSegments = rest.split('/').filter(Boolean);
            const firstSegment = restSegments[0]?.toLowerCase() ?? '';
            const explicitlyScopedTopic = firstSegment === safeTopicLower || firstSegment.startsWith('topic_');
            const targetSegments = firstSegment === 'scratch'
                ? [safeTopicId, 'scratch', ...restSegments.slice(1)]
                : explicitlyScopedTopic
                    ? restSegments
                    : [safeTopicId, ...restSegments];

            if (!aiRoot) {
                return `.cwtools-ai/${targetSegments.join('/')}`;
            }

            const candidates: string[] = [];
            for (const root of aiRoots) {
                candidates.push(path.join(root, ...targetSegments));
                if (!explicitlyScopedTopic && firstSegment !== 'scratch') {
                    candidates.push(path.join(root, safeTopicId, 'scratch', ...restSegments));
                }
            }
            const existingCandidate = candidates.find(candidate => fs.existsSync(candidate));
            if (existingCandidate) {
                return existingCandidate;
            }

            return path.join(aiRoot, ...targetSegments);
        };

        const quotedAgentPathPattern = /(^|[\s(])\\?(["'])(\.cwtools-ai(?:[\\/][^"']+?)?)\\?\2/g;
        const withEscapedQuotedPaths = command.replace(quotedAgentPathPattern, (_match, prefix: string, quote: string, agentPath: string) =>
            `${prefix}${quote}${rewriteAgentPath(agentPath)}${quote}`
        );

        const quotedPattern = /(^|[\s(])(["'])(\.cwtools-ai(?:[\\/][^"']+)?)\2/g;
        const withQuotedPaths = withEscapedQuotedPaths.replace(quotedPattern, (_match, prefix: string, quote: string, agentPath: string) =>
            `${prefix}${quote}${rewriteAgentPath(agentPath)}${quote}`
        );

        const barePattern = /(^|[\s(])(\.cwtools-ai(?:[\\/][^\s"';&|<>]+)?)/g;
        return withQuotedPaths.replace(barePattern, (_match, prefix: string, agentPath: string) =>
            `${prefix}${this.quoteCommandPath(rewriteAgentPath(agentPath), false)}`
        );
    }

    private normalizeWorkspaceFolderAliasCommand(command: string): { command: string; crossWorkspacePathAccess: boolean } {
        let normalizedCommand = command;
        let crossWorkspacePathAccess = false;
        const folders = vs.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            const alias = path.basename(folder.uri.fsPath);
            if (!alias || alias.toLowerCase() === '.cwtools-ai') continue;
            const aliasPattern = escapeRegExp(alias);

            const rewriteAliasPath = (aliasPath: string): string | null => {
                const rest = aliasPath.slice(alias.length).replace(/^[\\/]+/, '');
                const segments = rest.split(/[\\/]+/).filter(Boolean);
                const resolved = path.resolve(folder.uri.fsPath, ...segments);
                return isPathInsideOrEqual(resolved, folder.uri.fsPath) ? resolved : null;
            };

            const quotedPattern = new RegExp(`(^|[\\s(])(["'])(${aliasPattern}[\\\\/][^"']+)\\2`, 'g');
            normalizedCommand = normalizedCommand.replace(quotedPattern, (match, prefix: string, quote: string, aliasPath: string) => {
                const resolved = rewriteAliasPath(aliasPath);
                if (resolved && !this.isTrustedCommandWorkspace(resolved)) crossWorkspacePathAccess = true;
                return resolved ? `${prefix}${quote}${resolved}${quote}` : match;
            });

            const barePattern = new RegExp(`(^|[\\s(])(${aliasPattern}[\\\\/][^\\s"';&|<>]+)`, 'g');
            normalizedCommand = normalizedCommand.replace(barePattern, (match, prefix: string, aliasPath: string) => {
                const resolved = rewriteAliasPath(aliasPath);
                if (resolved && !this.isTrustedCommandWorkspace(resolved)) crossWorkspacePathAccess = true;
                return resolved ? `${prefix}${this.quoteCommandPath(resolved, false)}` : match;
            });
        }
        return { command: normalizedCommand, crossWorkspacePathAccess };
    }

    private commandSnapshotKey(filePath: string): string {
        const resolved = path.resolve(filePath);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    private getCommandSnapshotRoots(): string[] {
        const roots: string[] = [];
        const addRoot = (root: string | undefined) => {
            if (!root || path.basename(root).toLowerCase() === '.cwtools-ai') return;
            const resolved = path.resolve(root);
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (!roots.some(existing => this.commandSnapshotKey(existing) === key)) {
                roots.push(resolved);
            }
        };

        for (const folder of vs.workspace.workspaceFolders ?? []) {
            addRoot(folder.uri.fsPath);
        }
        addRoot(this.ctx.workspaceRoot);
        return roots;
    }

    private shouldSkipCommandSnapshotDir(entryName: string): boolean {
        return COMMAND_SNAPSHOT_EXCLUDED_DIRS.has(entryName.toLowerCase());
    }

    private getCommandSnapshotRelativePath(filePath: string): string {
        const resolved = path.resolve(filePath);
        for (const root of this.getCommandSnapshotRoots()) {
            if (isPathInsideOrEqual(resolved, root)) {
                return path.relative(root, resolved).replace(/\\/g, '/');
            }
        }
        return path.basename(resolved);
    }

    private shouldIgnoreCommandChange(filePath: string, isNewFile = false): boolean {
        const snapshotKey = this.commandSnapshotKey(filePath);
        if (this.ignoredCommandTempArtifacts.has(snapshotKey)) return true;

        const relPath = this.getCommandSnapshotRelativePath(filePath);
        const segments = relPath.split('/').filter(Boolean).map(segment => segment.toLowerCase());
        if (segments[0] === '.cwtools-ai') return true;

        const basename = path.basename(filePath).toLowerCase();
        const ext = path.extname(basename).toLowerCase();
        if (!COMMAND_TEMP_SCRIPT_EXTENSIONS.has(ext)) return false;
        if (segments.some(segment => COMMAND_TEMP_SCRIPT_DIR_NAMES.has(segment))
            || basename === 'agent_helper.py'
            || (isNewFile && COMMAND_TEMP_SCRIPT_NAME_PATTERN.test(basename))) {
            this.ignoredCommandTempArtifacts.add(snapshotKey);
            return true;
        }
        return false;
    }

    private isCommandSnapshotTextFile(filePath: string): boolean {
        const basename = path.basename(filePath).toLowerCase();
        if (COMMAND_SNAPSHOT_TEXT_FILENAMES.has(basename)) return true;
        return COMMAND_SNAPSHOT_TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
    }

    private async collectCommandFileState(captureContent: boolean): Promise<Map<string, CommandFileState>> {
        const files = new Map<string, CommandFileState>();
        let capturedBytes = 0;
        let hitFileLimit = false;

        const walk = async (dir: string): Promise<void> => {
            if (hitFileLimit) return;
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (hitFileLimit) return;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!this.shouldSkipCommandSnapshotDir(entry.name)) {
                        await walk(fullPath);
                    }
                    continue;
                }
                if (!entry.isFile() || !this.isCommandSnapshotTextFile(fullPath)) {
                    continue;
                }

                let stat: fs.Stats;
                try {
                    stat = await fs.promises.stat(fullPath);
                } catch {
                    continue;
                }
                if (!stat.isFile()) continue;
                if (files.size >= COMMAND_SNAPSHOT_MAX_FILES) {
                    hitFileLimit = true;
                    return;
                }

                let previousContent: string | null | undefined;
                let contentCaptured = false;
                let hadBom = false;
                if (captureContent
                    && stat.size <= COMMAND_SNAPSHOT_MAX_FILE_BYTES
                    && capturedBytes + stat.size <= COMMAND_SNAPSHOT_MAX_TOTAL_BYTES) {
                    try {
                        const rawBuffer = await fs.promises.readFile(fullPath);
                        hadBom = rawBuffer.length >= 3 && rawBuffer[0] === 0xEF && rawBuffer[1] === 0xBB && rawBuffer[2] === 0xBF;
                        const content = rawBuffer.toString('utf-8');
                        if (!content.includes('\u0000')) {
                            previousContent = content;
                            contentCaptured = true;
                            capturedBytes += stat.size;
                        }
                    } catch {
                        previousContent = undefined;
                    }
                }

                files.set(this.commandSnapshotKey(fullPath), {
                    filePath: fullPath,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    previousContent,
                    contentCaptured,
                    hadBom,
                });
            }
        };

        for (const root of this.getCommandSnapshotRoots()) {
            await walk(root);
        }
        return files;
    }

    private getCommandSnapshotCallback(context?: import('../types').AgentToolContext):
        | ((filePath: string, previousContent: string | null) => void)
        | undefined {
        return context?.onBeforeFileWrite
            ?? context?.runnerOptions?.onBeforeFileWrite
            ?? this.ctx.onBeforeFileWrite;
    }

    private async recordCommandFileChanges(
        before: Map<string, CommandFileState> | undefined,
        context?: import('../types').AgentToolContext
    ): Promise<number> {
        if (!before) return 0;
        const record = this.getCommandSnapshotCallback(context);
        if (!record) return 0;

        const after = await this.collectCommandFileState(false);

        // ─── 自动纠正变动文件的编码格式 (主动防御机制) ───
        for (const [key, afterState] of after) {
            const beforeState = before.get(key);
            if (beforeState) {
                // 如果是已存在的文件，且大小或时间变了（说明被修改过）
                if (beforeState.size !== afterState.size || Math.abs(beforeState.mtimeMs - afterState.mtimeMs) >= 1) {
                    await this.ensureCorrectEncodingAfterCommand(afterState.filePath, beforeState.hadBom ?? false, false);
                }
            } else {
                // 如果是新创建的文件
                if (!this.shouldIgnoreCommandChange(afterState.filePath, true)) {
                    await this.ensureCorrectEncodingAfterCommand(afterState.filePath, null, true);
                }
            }
        }

        // 刷新 after 状态，因为前面执行的自动编码修复可能会改变 after 文件的大小和修改时间
        const refreshedAfter = await this.collectCommandFileState(false);

        let recorded = 0;

        for (const [key, beforeState] of before) {
            if (this.shouldIgnoreCommandChange(beforeState.filePath)) {
                continue;
            }
            const afterState = refreshedAfter.get(key);
            if (!afterState) {
                if (beforeState.contentCaptured && beforeState.previousContent !== undefined) {
                    record(beforeState.filePath, beforeState.previousContent);
                    recorded++;
                }
                continue;
            }

            if (beforeState.size === afterState.size
                && Math.abs(beforeState.mtimeMs - afterState.mtimeMs) < 1) {
                continue;
            }
            if (!beforeState.contentCaptured || beforeState.previousContent === undefined) {
                continue;
            }

            try {
                if (afterState.size <= COMMAND_SNAPSHOT_MAX_FILE_BYTES) {
                    const current = await fs.promises.readFile(afterState.filePath, 'utf-8');
                    if (current === beforeState.previousContent) {
                        continue;
                    }
                }
            } catch {
                // If the file changed but cannot be read now, still keep the old snapshot.
            }

            record(beforeState.filePath, beforeState.previousContent);
            recorded++;
        }

        for (const [key, afterState] of refreshedAfter) {
            if (before.has(key)) continue;
            if (this.shouldIgnoreCommandChange(afterState.filePath, true)) continue;
            if (afterState.size > COMMAND_SNAPSHOT_MAX_FILE_BYTES) continue;
            record(afterState.filePath, null);
            recorded++;
        }

        return recorded;
    }

    private async ensureCorrectEncodingAfterCommand(
        filePath: string,
        hadBomBefore: boolean | null,
        isNewFile: boolean
    ): Promise<void> {
        try {
            if (!fs.existsSync(filePath)) return;
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile() || stat.size > 10_000_000) return; // 忽略大型或非文本文件

            const buffer = await fs.promises.readFile(filePath);
            
            // 1. 检测当前的编码格式 (检测 UTF-16LE, UTF-16BE, UTF-8 BOM)
            const isUtf16le = buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE;
            const isUtf16be = buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF;
            const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;

            let textContent = '';
            let decoded = false;

            // 如果被 PowerShell 错误地写成了 UTF-16LE，先用对应的编码解码为文本
            if (isUtf16le) {
                textContent = buffer.toString('utf16le');
                decoded = true;
            } else if (isUtf16be) {
                textContent = buffer.toString('utf16le'); // fallback
                decoded = true;
            }

            // 2. 决定预期的 BOM 状态
            let shouldHaveBom = false;
            if (isNewFile) {
                const ext = path.extname(filePath).toLowerCase();
                const normalPath = filePath.replace(/\\/g, '/').toLowerCase();
                // 凡是 Paradox 本地化 YML 文件或处于 localisation 目录下的，都必须使用 UTF-8 with BOM
                if (ext === '.yml' || normalPath.includes('/localisation/') || normalPath.includes('/localization/')) {
                    shouldHaveBom = true;
                } else {
                    shouldHaveBom = false;
                }
            } else {
                shouldHaveBom = hadBomBefore === true;
            }

            // 3. 执行校正并重新写回
            if (decoded) {
                let outputBuffer: Buffer;
                if (shouldHaveBom) {
                    outputBuffer = Buffer.concat([
                        Buffer.from([0xEF, 0xBB, 0xBF]),
                        Buffer.from(textContent, 'utf8')
                    ]);
                } else {
                    outputBuffer = Buffer.from(textContent, 'utf8');
                }
                await fs.promises.writeFile(filePath, outputBuffer);
            } else {
                if (shouldHaveBom && !hasUtf8Bom) {
                    // 预期带 BOM，但没有：补全 BOM
                    const outputBuffer = Buffer.concat([
                        Buffer.from([0xEF, 0xBB, 0xBF]),
                        buffer
                    ]);
                    await fs.promises.writeFile(filePath, outputBuffer);
                } else if (!shouldHaveBom && hasUtf8Bom) {
                    // 预期不带 BOM，但带有：剥离 BOM
                    const outputBuffer = buffer.subarray(3);
                    await fs.promises.writeFile(filePath, outputBuffer);
                }
            }
        } catch (e) {
            console.error(`[EncodingCheck] 修复文件编码格式失败: ${filePath}`, e);
        }
    }

    private async requestPermissionWithAbort(
        onPermissionRequest: (
            id: string,
            tool: string,
            description: string,
            command?: string,
            context?: import('../types').AgentToolContext,
        ) => Promise<boolean>,
        id: string, tool: string, description: string,
        context?: import('../types').AgentToolContext,
        command?: string
    ): Promise<boolean> {
        const abortSignal = context?.runnerOptions?.abortSignal;
        if (abortSignal?.aborted) return false;
        if (!abortSignal) {
            return onPermissionRequest(id, tool, description, command, context);
        }
        let onAbort: (() => void) | undefined;
        const abortDeny = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([
                onPermissionRequest(id, tool, description, command, context),
                abortDeny,
            ]);
        } finally {
            if (onAbort) {
                abortSignal.removeEventListener('abort', onAbort);
            }
        }
    }

    // ─── todoWrite ───────────────────────────────────────────────────────────

    // Conservative auto-approval classifier for shell commands that only read or format output.
    private isReadOnlyRunCommand(command: string): boolean {
        const trimmed = command.trim();
        if (!trimmed) return false;

        const unsafePatterns = [
            /&&/,
            /;\s*\S/,
            /\d*>{1,2}\s*\S/,
            /</,
            /(^|[^&])&(?!&)/,
            /\b(?:rm|del|erase|rmdir|remove-item|ri|rd|format|shutdown|reboot|mkfs|shred)\b/i,
            /\b(?:set-content|add-content|out-file|tee-object|export-\w+|new-item|ni|copy-item|cp|move-item|mv|rename-item|ren|set-item|set-location|cd|push-location|pop-location)\b/i,
            // POSIX write/modify commands — never classify as read-only
            /\b(?:mkdir|touch|ln|chmod|chown|truncate|tee|install|mkfifo)\b/i,
            // Hidden writes/exec behind flags: sed -i, find -delete/-exec, awk redirect/system()
            /\bsed\b[^|]*\s-i\b/i,
            /\bfind\b[^|]*\s-(?:delete|exec|execdir|ok)\b/i,
            /\bawk\b[^|]*(?:>|\bsystem\s*\()/i,
            /\b(?:start-process|invoke-expression|iex|invoke-webrequest|iwr|invoke-restmethod|curl|wget)\b/i,
            /\b(?:node|python|py|powershell|pwsh)\s+-(?:e|c|command|encodedcommand)\b/i,
        ];
        if (unsafePatterns.some(pattern => pattern.test(trimmed))) return false;

        const readOnlySegmentPatterns = [
            /^git\s+(?:log|status|diff|show|rev-parse|branch|tag|remote)(?:\s|$)/i,
            /^git\s+stash\s+list(?:\s|$)/i,
            /^(?:dotnet\s+(?:--version|--info)|node\s+--version|npm\s+(?:list|ls|--version)|npx\s+--version|mmx\s+--version)$/i,
            /^(?:cat|type|echo|dir|ls|grep|rg|wc|head|tail|which|where|findstr|stat|file|basename|dirname|realpath|readlink|printenv|cut|tr|comm|column|nl|tree)(?:\s|$)/i,
            /^(?:get-childitem|gci|get-content|gc|select-string|sls|get-item|gi|test-path|resolve-path|get-location|pwd|get-command|get-help|get-module)(?:\s|$)/i,
            /^(?:where-object|\?|select-object|sort-object|measure-object|format-table|format-list|format-wide|out-string)(?:\s|$)/i,
        ];

        return trimmed
            .split('|')
            .map(segment => segment.trim())
            .filter(Boolean)
            .every(segment => readOnlySegmentPatterns.some(pattern => pattern.test(segment)));
    }

    async todoWrite(args: { todos: TodoItem[] }, context?: import('../types').AgentToolContext): Promise<TodoWriteResult> {
        console.time('todoWrite_exec');
        this.currentTodos = args.todos;
        const onTodoUpdate = context?.onTodoUpdate;
        if (onTodoUpdate) {
            onTodoUpdate(this.currentTodos);
        }
        console.timeEnd('todoWrite_exec');
        return {
            success: true,
            todoCount: this.currentTodos.length,
        };
    }

    getTodos(): TodoItem[] { return [...this.currentTodos]; }
    clearTodos(): void { this.currentTodos = []; }

    // ─── ignoreValidationError ───────────────────────────────────────────────

    async ignoreValidationError(args: { errorId: string; reason: string }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string }> {
        const onPermissionRequest = context?.onPermissionRequest;
        if (!onPermissionRequest) {
            return { success: false, message: 'Permission handler not configured. Cannot ignore validation errors.' };
        }

        const permId = `perm_${Date.now()}`;
        const allowed = await this.requestPermissionWithAbort(
            onPermissionRequest, permId,
            'ignore_validation_error',
            `AI 请求忽略（IGNORE）此 LSP 验证错误：\n\n【错误详情】：${args.errorId}\n【判断理由】：${args.reason}\n\n您是否同意将此规则永久加入本地白名单 (.cwtools-ai-memory.md) 以免除后续报错？`,
            context
        );

        if (!allowed) {
            return { success: false, message: 'User denied the request to ignore the validation error.' };
        }

        try {
            const memoryPath = path.join(this.ctx.workspaceRoot, '.cwtools-ai-memory.md');
            const entry = `\n- **Ignored Validation Error / Whitelist**: \`${args.errorId}\` (Reason: ${args.reason})\n`;
            
            if (fs.existsSync(memoryPath)) {
                fs.appendFileSync(memoryPath, entry, 'utf8');
            } else {
                fs.writeFileSync(memoryPath, `# CWTools AI Local Memory\n${entry}`, 'utf8');
            }

            return { success: true, message: 'Error successfully whitelisted and saved to local memory.' };
        } catch (e) {
            return { success: false, message: `Failed to save memory: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    // ─── removeIgnoredDiagnostic ──────────────────────────────────────────────

    async removeIgnoredDiagnostic(args: { diagnosticKey: string; reason: string }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string }> {
        const vs = await import('vscode');
        const fileWriteMode = vs.workspace.getConfiguration('cwtools.ai').get<string>('agentFileWriteMode', 'confirm');

        // Auto mode -> strictly follow whitelist without asking
        if (fileWriteMode === 'auto') {
            return { success: false, message: 'Current execution is in Auto Mode. AI is configured to strictly follow the whitelist without prompting for removal.' };
        }

        const onPermissionRequest = context?.onPermissionRequest;
        if (!onPermissionRequest) {
            return { success: false, message: 'Permission handler not configured.' };
        }

        const permId = `perm_${Date.now()}`;
        const allowed = await this.requestPermissionWithAbort(
            onPermissionRequest, permId,
            'remove_ignored_diagnostic',
            `AI 建议从白名单中移除被忽略的报错关键字：\n\n【关键字】：${args.diagnosticKey}\n【判断理由】：${args.reason}\n\n您是否同意将此规则从您的 .vscode 设置中移除，恢复对此关键字的报错提示？`,
            context
        );

        if (!allowed) {
            return { success: false, message: 'User denied the request to remove the ignored diagnostic.' };
        }

        try {
            const vs = await import('vscode');
            const config = vs.workspace.getConfiguration('cwtools.ai');
            const ignored = config.get<string[]>('ignoredDiagnostics', []);
            const updated = ignored.filter(k => k !== args.diagnosticKey);
            await config.update('ignoredDiagnostics', updated, vs.ConfigurationTarget.Workspace);

            // Rebuild diagnostics via extension settings refresh might happen automatically,
            // but we can also trigger a cache invalidation if needed. For now, updating settings is enough.
            return { success: true, message: 'Diagnostic key successfully removed from whitelist.' };
        } catch (e) {
            return { success: false, message: `Failed to update settings: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    // ─── getIgnoredDiagnostics ────────────────────────────────────────────────

    async getIgnoredDiagnostics(): Promise<{ success: boolean; ignoredKeys: string[]; count: number }> {
        try {
            const vs = await import('vscode');
            const ignored = vs.workspace.getConfiguration('cwtools.ai').get<string[]>('ignoredDiagnostics', []);
            return { success: true, count: ignored.length, ignoredKeys: ignored };
        } catch {
            return { success: false, count: 0, ignoredKeys: [] };
        }
    }

    // ─── webFetch ────────────────────────────────────────────────────────────

    async webFetch(args: { url: string; maxChars?: number }, context?: import('../types').AgentToolContext): Promise<{ content: string; url: string; truncated: boolean }> {
        const maxChars = Math.min(args.maxChars ?? 8000, 16000);

        if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
            return { content: 'Error: only http/https URLs are supported', url: args.url, truncated: false };
        }

        try {
            const urlObj = new URL(args.url);
            const host = urlObj.hostname;
            
            const dns = await import('dns');
            const { address } = await dns.promises.lookup(host);

            const isLocalIPv4 = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(address);
            const isLocalIPv6 = /^(::1|fd[0-9a-f]{2}:.+|fe80::.+)$/i.test(address);
            
            if (host === 'localhost' || isLocalIPv4 || isLocalIPv6 || host.endsWith('.local')) {
                return { content: 'Error: Access to local/internal network addresses via SSRF is prohibited for security reasons.', url: args.url, truncated: false };
            }
        } catch (e) {
            return { content: `Error: DNS resolution failed or Invalid URL format. ${e instanceof Error ? e.message : String(e)}`, url: args.url, truncated: false };
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            const abortSignal = context?.runnerOptions?.abortSignal;
            const onParentAbort = () => controller.abort(abortSignal?.reason);
            if (abortSignal) {
                if (abortSignal.aborted) throw new Error('Aborted by user');
                abortSignal.addEventListener('abort', onParentAbort);
            }

            let response: Response;
            try {
                response = await fetch(args.url, {
                    headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
                    signal: controller.signal as any
                });
            } finally {
                clearTimeout(timeoutId);
                if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
            }
            if (!response.ok) {
                return { content: `HTTP ${response.status}: ${response.statusText}`, url: args.url, truncated: false };
            }

            const contentType = response.headers.get('content-type') ?? '';
            let text = await response.text();

            // 🔒 Prevent event loop blocking: limit the original response body size
            // response.text() itself is asynchronous and will not block, but subsequent synchronous regular processing
            // Oversized text will exclusively occupy the JS main thread, causing the Extension Host to completely freeze.
            // Even AbortController and Promise.race timeouts cannot be triggered.
            const MAX_RAW_BODY = 512_000; // 512KB — Any meaningful web content falls within this range
            if (text.length > MAX_RAW_BODY) {
                text = text.substring(0, MAX_RAW_BODY);
            }

            if (contentType.includes('html')) {
                // 🔒 HTML regular safety upper limit: 6 full .replace() takes about 1-3ms on 100KB,
                // But on 5MB it may take 30s+, completely freezing the event loop.
                const SAFE_REGEX_LIMIT = 100_000;
                if (text.length > SAFE_REGEX_LIMIT) {
                    text = text.substring(0, SAFE_REGEX_LIMIT);
                }
                text = text
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/\s{3,}/g, '\n\n')
                    .trim();
            }

            const truncated = text.length > maxChars;
            return {
                content: truncated ? text.substring(0, maxChars) + '\n... [truncated]' : text,
                url: args.url,
                truncated,
            };
        } catch (e) {
            return {
                content: `Fetch error: ${e instanceof Error ? e.message : String(e)}`,
                url: args.url,
                truncated: false,
            };
        }
    }

    // ─── runCommand ──────────────────────────────────────────────────────────

    async runCommand(args: { command: string; cwd?: string; timeoutMs?: number; requestEscalation?: boolean }, context?: import('../types').AgentToolContext): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut?: boolean;
    }> {
        // Safety: deny obviously dangerous commands and shell control operators.
        // Utility mode is intentionally broader for project tooling/scripts, so it
        // may invoke PowerShell hosts; other modes still require escalation there.
        const mode = context?.runnerOptions?.mode;
        const isUtilityMode = mode === 'utility';
        const topicId = context?.runnerOptions?.topicId || 'default';
        args.command = this.normalizeAgentWorkspaceCommand(args.command, topicId);
        const aliasNormalized = this.normalizeWorkspaceFolderAliasCommand(args.command);
        args.command = aliasNormalized.command;
        const crossWorkspacePathAccess = aliasNormalized.crossWorkspacePathAccess;
        const DESTRUCTIVE_BLOCKED = [
            /\brm\s+-[a-z]*r[a-z]*f/i,                          // rm -rf, -Rf, -rdf…
            /\brm\s+-[a-z]*f[a-z]*r/i,                          // rm -fr, -fdr…
            /\brm\b(?=[^|]*\s-r\b)(?=[^|]*\s-f\b)/i,            // rm -r … -f (any order)
            /\brm\b(?=[^|]*--recursive\b)(?=[^|]*--force\b)/i,  // rm --recursive --force
            /\bdel\s+\/[fqs]/i, /\bformat\b/i,
            /\brmdir\b.*\/s/i, /\bshutdown\b/i, /\breboot\b/i,
            /\bmkfs\b/i, /\bshred\b/i, /\bfind\b[^|]*\s-delete\b/i,
            /\bcurl\b.*\|\s*bash/i, /\bwget\b.*\|\s*sh/i,
        ];
        // Inline interpreter commands: not destructive, but should never be auto-approved.
        // In confirm mode → normal permission prompt; in auto mode → still requires explicit confirmation.
        const INTERPRETER_INLINE = [/\bnode\b\s+-e/i, /\bpython\b\s+-c/i];
        const isInterpreterInline = INTERPRETER_INLINE.some(pat => pat.test(args.command));
        const MODE_BLOCKED: RegExp[] = [];
        const ALWAYS_BLOCKED = [...DESTRUCTIVE_BLOCKED, ...MODE_BLOCKED];
        const PIPE_REDIRECT_BLOCKED = [
            /\|/,               // pipe operator
            /&&/,               // command chaining
            /;\s*\S/,           // semicolon followed by next command (allow trailing ;)
            /\d*>{1,2}\s*\S/,   // output redirect (> file, >> file, 2> err)
            /</,                // input redirect
        ];
        // P2-11: Commands that are inherently read-only skip pipe/redirect checks
        // (complex safe commands still go through the user permission prompt)
        const SAFE_COMMAND_PREFIXES = [
            'git log', 'git status', 'git diff', 'git show',
            'git stash list', 'git rev-parse',
            'dotnet --version', 'dotnet --info', 'node --version',
            'npm list', 'npm ls', 'npm --version', 'npx --version',
            'cat', 'type', 'echo', 'dir', 'ls', 'grep', 'rg',
            'wc', 'head', 'tail', 'which', 'where', 'mmx --version',
            'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink',
            'printenv', 'cut', 'tr', 'comm', 'column', 'nl', 'tree',
        ];
        const cmdLower = args.command.trim().toLowerCase();
        const startsWithCommandPrefix = (prefix: string) =>
            cmdLower === prefix || cmdLower.startsWith(`${prefix} `);
        const isSafePrefix = SAFE_COMMAND_PREFIXES.some(startsWithCommandPrefix);
        const isReadOnlyCommand = this.isReadOnlyRunCommand(args.command);
        const AUTO_APPROVE_CONTROL_BLOCKED = [
            /&&/,
            /;\s*\S/,
            /\d*>{1,2}\s*\S/,
            /</,
            /(^|[^&])&(?!&)/, // single-ampersand shell chaining
        ];
        const hasShellControlOperator = AUTO_APPROVE_CONTROL_BLOCKED.some(pat => pat.test(args.command));
        const SAFE_AUTO_APPROVE_PATTERNS = [
            /^git\s+(?:log|status|diff|show|rev-parse)(?:\s|$)/i,
            /^git\s+stash\s+list(?:\s|$)/i,
            /^git\s+branch(?:\s+(?:--show-current|--list|-a|-r|-v|-vv|--verbose))?(?:\s|$)/i,
            /^git\s+tag(?:\s+(?:--list|-l))?(?:\s|$)/i,
            /^git\s+remote(?:\s+(?:-v|show))?(?:\s|$)/i,
            /^dotnet\s+(?:--version|--info)$/i,
            /^node\s+--version$/i,
            /^npm\s+(?:list|ls|--version)(?:\s|$)/i,
            /^npx\s+--version$/i,
            /^(?:cat|type|echo|dir|ls|grep|rg|wc|head|tail|which|where|stat|file|basename|dirname|realpath|readlink|printenv|cut|tr|comm|column|nl|tree)(?:\s|$)/i,
            /^mmx\s+--version$/i,
        ];
        const isSingleSafeCommand = !args.command.includes('|') && SAFE_AUTO_APPROVE_PATTERNS.some(pat => pat.test(cmdLower));
        const isAutoApproveSafeCommand = isReadOnlyCommand || isSingleSafeCommand;

        const bypassSandbox = isSecuritySandboxDisabled();
        const fileWriteMode = vs.workspace.getConfiguration('cwtools.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm');
        let escalationReason = '';

        if (!bypassSandbox) {
            let triggeredBlock: RegExp | null = null;
            for (const pat of ALWAYS_BLOCKED) {
                if (pat.test(args.command)) { triggeredBlock = pat; break; }
            }
            if (!triggeredBlock && !isSafePrefix && !isReadOnlyCommand) {
                for (const pat of PIPE_REDIRECT_BLOCKED) {
                    if (pat.test(args.command)) { triggeredBlock = pat; break; }
                }
            }
            
            if (triggeredBlock) {
                if (args.requestEscalation) {
                    escalationReason = `触发沙盒规则: ${triggeredBlock.source}`;
                } else {
                    return { stdout: '', stderr: `Blocked: Command execution prohibited due to matching safety pattern (${triggeredBlock.source}). If you are ABSOLUTELY sure this is required, you can retry with "requestEscalation": true to ask the user for a one-time privilege override.`, exitCode: 1 };
                }
            }
        }

        let cwd: string;
        try {
            const requestedCwd = typeof args.cwd === 'string' && args.cwd.trim()
                ? sanitizePathInput(args.cwd)
                : this.ctx.workspaceRoot;
            const cwdResolution = resolveWorkspacePathInput(requestedCwd, this.ctx.workspaceRoot, { preferExistingAiPath: true });
            cwd = cwdResolution.resolved;

            if (!cwdResolution.isTrusted && !bypassSandbox) {
                if (cwdResolution.isWithinAnyWorkspace) {
                    if (!isAutoApproveSafeCommand) {
                        escalationReason = escalationReason || '跨工作区工作目录访问';
                    }
                } else if (args.requestEscalation) {
                    escalationReason = escalationReason || '工作目录越界访问';
                } else {
                    return { stdout: '', stderr: 'Blocked: Working directory must be within the workspace root or another workspace folder. If this is required, retry with "requestEscalation": true to ask the user for a one-time privilege override.', exitCode: 1 };
                }
            }
        } catch {
            return { stdout: '', stderr: `Blocked: Invalid working directory`, exitCode: 1 };
        }

        args.command = this.relativizeCommandPathsForCwd(args.command, cwd);

        if (crossWorkspacePathAccess && !isAutoApproveSafeCommand && !bypassSandbox) {
            escalationReason = escalationReason || '跨工作区路径访问';
        }

        // Preflight shell command segment risk analysis
        const preflight = preflightCommand(args.command);
        const currentEscalationReason = escalationReason || (preflight.requiresEscalation ? preflight.blockedReason : '');
        
        // Destructive check
        if (!preflight.safe && !args.requestEscalation && !bypassSandbox) {
            return { 
                stdout: '', 
                stderr: `Prohibited destructive shell operation. Command: "${args.command}". Error: ${preflight.blockedReason ?? 'High risk segment detected.'}`, 
                exitCode: 1 
            };
        }

        const approvedByPolicy = PermissionPolicyStore.getInstance().isApproved(
            'run_command',
            { CommandLine: args.command, Cwd: cwd },
            preflight.riskLevel
        );
        const safeAutoApprove = isAutoApproveSafeCommand && !hasShellControlOperator && !args.requestEscalation && !currentEscalationReason;
        const utilityAutoApprove = isUtilityMode && fileWriteMode === 'auto' && !args.requestEscalation && !currentEscalationReason;
        // Command auto-runs only when the tool classifies it as safe or it matches pre-approved session policy
        let requiresPermission = (isInterpreterInline || !(safeAutoApprove || utilityAutoApprove)) && !approvedByPolicy;
        
        // Escalation overrides MUST always prompt user regardless of policy/auto configurations
        if (preflight.requiresEscalation || currentEscalationReason) {
            requiresPermission = true;
        }
        // Interpreter inline commands (python -c, node -e) always require explicit user permission,
        // even in auto mode, to prevent silent arbitrary code execution.
        // let requiresPermission resolved by preflight store above
        const onPermissionRequest = context?.onPermissionRequest;

        if (requiresPermission && onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            // Build rich detailed telemetry payload for Webview visual enhancement
            const preflightPayload = {
                command: args.command,
                cwd,
                classification: preflight.segments.map(s => s.classification),
                riskLevel: preflight.riskLevel,
                escalation: !!currentEscalationReason,
                reasons: preflight.segments.map(s => s.reason)
            };
            const description = currentEscalationReason 
                ? `[ESCALATION] AI requests a sandbox override (${currentEscalationReason}): ${args.command}`
                : `AI 请求执行终端命令：${args.command}`;
            
            const allowed = await this.requestPermissionWithAbort(
                onPermissionRequest, permId, 'run_command', description, { ...context, preflight: preflightPayload } as any, args.command
            );
            if (!allowed) {
                return { stdout: '', stderr: '用户拒绝了此命令的执行权限', exitCode: 1 };
            }
        } else if (requiresPermission) {
            return { stdout: '', stderr: 'run_command: no permission handler configured', exitCode: 1 };
        }

        const timeoutMs = Math.min(args.timeoutMs ?? 30000, 120000);
        const { spawn } = await import('child_process');

        // Parse command into binary + args on the platform shell
        const isWindows = process.platform === 'win32';
        const shell = isWindows
            ? 'powershell.exe'
            : '/bin/sh';
        const shellArgs = isWindows
            ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', args.command]
            : ['-c', args.command];
        const agentWorkspaceDir = getTopicStorageDir(topicId, this.ctx.workspaceRoot);
        const scratchDir = getTopicScratchDir(topicId, this.ctx.workspaceRoot);
        const helperScript = scratchDir ? path.join(scratchDir, 'agent_helper.py') : '';
        const mediaDir = agentWorkspaceDir ? path.join(agentWorkspaceDir, 'media') : '';
        try {
            if (agentWorkspaceDir) fs.mkdirSync(agentWorkspaceDir, { recursive: true });
            if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });
            if (mediaDir) fs.mkdirSync(mediaDir, { recursive: true });
        } catch { /* best effort */ }
        const commandEnv = {
            ...process.env,
            CWT_WORKSPACE_ROOT: this.ctx.workspaceRoot,
            CWT_AGENT_TOPIC_ID: topicId,
            CWT_AGENT_WORKSPACE_DIR: agentWorkspaceDir,
            CWT_AGENT_SCRATCH_DIR: scratchDir,
            CWT_AGENT_HELPER_SCRIPT: helperScript,
            CWT_AGENT_MEDIA_DIR: mediaDir,
        };

        let stdoutBuf = '';
        let stderrBuf = '';
        const MAX_OUTPUT = 4000;
        let commandChangeBaseline: Map<string, CommandFileState> | undefined;
        if (this.getCommandSnapshotCallback(context)
            && !(isAutoApproveSafeCommand && !hasShellControlOperator)) {
            try {
                commandChangeBaseline = await this.collectCommandFileState(true);
            } catch {
                commandChangeBaseline = undefined;
            }
        }

        const commandResult = await new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
            timedOut?: boolean;
        }>(resolve => {
            let proc: ReturnType<typeof spawn>;
            try {
                proc = spawn(shell, shellArgs, { cwd, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                resolve({
                    stdout: '',
                    stderr: `Failed to start command in cwd "${cwd}": ${e instanceof Error ? e.message : String(e)}`,
                    exitCode: 1,
                });
                return;
            }
            let settled = false;
            // eslint-disable-next-line prefer-const -- deferred initialization
            let timer: ReturnType<typeof setTimeout> | undefined;
            // eslint-disable-next-line prefer-const -- deferred initialization
            let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
            const abortSignal = context?.runnerOptions?.abortSignal;

            const finish = (result: { stdout: string; stderr: string; exitCode: number; timedOut?: boolean }) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
                resolve(result);
            };

            const onParentAbort = () => {
                const reason = abortSignal?.reason;
                const abortedByTimeout = reason instanceof Error && reason.name === 'TimeoutError';
                proc.kill();
                finish({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT) + (abortedByTimeout ? '\n[... 超时已终止]' : '\n[... 被用户中止]'),
                    stderr: stderrBuf.substring(0, 2000),
                    exitCode: -1,
                    timedOut: abortedByTimeout,
                });
            };
            if (abortSignal) {
                if (abortSignal.aborted) {
                    onParentAbort();
                    return;
                }
                abortSignal.addEventListener('abort', onParentAbort);
            }

            proc.on('error', (e: Error) => {
                finish({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT),
                    stderr: `Command failed to start in cwd "${cwd}": ${e.message}`,
                    exitCode: 1,
                });
            });

            const startedAt = Date.now();
            heartbeatTimer = setInterval(() => {
                if (settled) return;
                const onStep = context?.onStep;
                const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                onStep?.({
                    type: 'orchestrator_progress',
                    content: `run_command 正在执行中 (${elapsed}s): ${args.command.slice(0, 120)}`,
                    timestamp: Date.now(),
                });
            }, 15_000);

            timer = setTimeout(() => {
                proc.kill();
                finish({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT) + '\n[... 超时已终止]',
                    stderr: stderrBuf.substring(0, 2000),
                    exitCode: -1,
                    timedOut: true,
                });
            }, timeoutMs);

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stdoutBuf += text;
                // Stream chunks to UI in real time
                const onStep = context?.onStep;
                onStep?.({
                    type: 'thinking',
                    content: text.substring(0, 200),
                    timestamp: Date.now(),
                });
            });

            proc.stderr?.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString();
                const onStep = context?.onStep;
                onStep?.({
                    type: 'thinking',
                    content: chunk.toString().substring(0, 200),
                    timestamp: Date.now(),
                });
            });

            proc.on('close', code => {
                finish({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT),
                    stderr: stderrBuf.substring(0, 2000),
                    exitCode: code ?? 0,
                });
            });

            proc.on('error', err => {
                finish({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT),
                    stderr: `spawn error: ${err.message}`,
                    exitCode: 1,
                });
            });
        });

        try {
            const recordedChanges = await this.recordCommandFileChanges(commandChangeBaseline, context);
            if (recordedChanges > 0) {
                context?.onStep?.({
                    type: 'thinking',
                    content: `run_command recorded ${recordedChanges} file change(s) for the workspace panel.`,
                    timestamp: Date.now(),
                });
            }
        } catch {
            // File-change capture is best-effort; command output remains authoritative.
        }

        return commandResult;
    }

    // ─── searchWeb ───────────────────────────────────────────────────────────

    async searchWeb(args: { query: string; maxResults?: number }, context?: import('../types').AgentToolContext): Promise<{
        results: Array<{ title: string; url: string; description: string }>;
        source: 'brave' | 'duckduckgo';
        query: string;
    }> {
        const maxResults = Math.min(args.maxResults ?? 5, 10);
        const query = args.query.trim();

        // Try Brave Search API first
        const braveKey = vs.workspace.getConfiguration('cwtools.ai').get<string>('braveSearchApiKey') ?? '';
        if (braveKey) {
            try {
                const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const abortSignal = context?.runnerOptions?.abortSignal;
                const onParentAbort = () => controller.abort(abortSignal?.reason);
                if (abortSignal) {
                    if (abortSignal.aborted) throw new Error('Aborted by user');
                    abortSignal.addEventListener('abort', onParentAbort);
                }

                let resp: Response;
                try {
                    resp = await fetch(url, {
                        headers: {
                            'Accept': 'application/json',
                            'Accept-Encoding': 'gzip',
                            'X-Subscription-Token': braveKey,
                        },
                        signal: controller.signal as any
                    });
                } finally {
                    clearTimeout(timeoutId);
                    if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
                }
                if (resp.ok) {
                    const data = await resp.json() as {
                        web?: { results?: Array<{ title: string; url: string; description?: string }> }
                    };
                    const results = (data.web?.results ?? []).slice(0, maxResults).map(r => ({
                        title: r.title,
                        url: r.url,
                        description: r.description ?? '',
                    }));
                    return { results, source: 'brave', query };
                }
            } catch { /* fall through to DuckDuckGo */ }
        }

        // Fallback: DuckDuckGo HTML scraping
        try {
            const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const abortSignal = context?.runnerOptions?.abortSignal;
            const onParentAbort = () => controller.abort(abortSignal?.reason);
            if (abortSignal) {
                if (abortSignal.aborted) throw new Error('Aborted by user');
                abortSignal.addEventListener('abort', onParentAbort);
            }

            let resp: Response;
            try {
                resp = await fetch(ddgUrl, {
                    headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
                    signal: controller.signal as any
                });
            } finally {
                clearTimeout(timeoutId);
                if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
            }
            let html = await resp.text();
            // 🔒 Prevent event loop blocking: limit DuckDuckGo response body size
            // Normal search results page < 100KB, but abnormal pages (verification codes/errors) may be larger
            if (html.length > 200_000) {
                html = html.substring(0, 200_000);
            }

            const results: Array<{ title: string; url: string; description: string }> = [];
            const linkRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
            const snippetRe = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/gi;
            const links: Array<{ url: string; title: string }> = [];
            const snippets: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = linkRe.exec(html)) !== null && links.length < maxResults) {
                 
                let url = m[1]!;
                if (url.startsWith('/l/?uddg=')) {
                    try { url = decodeURIComponent(url.replace('/l/?uddg=', '')); } catch { /* keep */ }
                }
                 
                links.push({ url, title: m[2]!.trim() });
            }
            while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
                 
                snippets.push(m[1]!.trim());
            }
            for (let i = 0; i < links.length; i++) {
                results.push({
                     
                    title: links[i]!.title,
                     
                    url: links[i]!.url,
                     
                    description: snippets[i]! ?? '',
                });
            }
            return { results, source: 'duckduckgo', query };
        } catch {
            return { results: [], source: 'duckduckgo', query };
        }
    }

    // ─── searchCode ────────────────────────────────────────────────────────────

    async searchCode(args: { query: string; maxResults?: number }, context?: import('../types').AgentToolContext): Promise<{
        results: Array<{ title: string; url: string; description: string }>;
        source: 'exa' | 'brave';
        query: string;
    }> {
        const maxResults = Math.min(args.maxResults ?? 5, 10);
        const query = args.query.trim();

        // Try Exa semantic code search first
        const exaKey = vs.workspace.getConfiguration('cwtools.ai').get<string>('exaApiKey') ?? '';
        if (exaKey) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const abortSignal = context?.runnerOptions?.abortSignal;
                const onParentAbort = () => controller.abort(abortSignal?.reason);
                if (abortSignal) {
                    if (abortSignal.aborted) throw new Error('Aborted by user');
                    abortSignal.addEventListener('abort', onParentAbort);
                }

                let resp: Response;
                try {
                    resp = await fetch('https://api.exa.ai/search', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': exaKey,
                        },
                        body: JSON.stringify({
                            query,
                            numResults: maxResults,
                            type: 'auto',
                            contents: { text: { maxCharacters: 300 } },
                        }),
                        signal: controller.signal as any
                    });
                } finally {
                    clearTimeout(timeoutId);
                    if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
                }
                if (resp.ok) {
                    const data = await resp.json() as {
                        results?: Array<{ title?: string; url?: string; text?: string }>;
                    };
                    const results = (data.results ?? []).slice(0, maxResults).map(r => ({
                        title: r.title ?? '',
                        url: r.url ?? '',
                        description: r.text ?? '',
                    }));
                    return { results, source: 'exa', query };
                }
            } catch { /* fall through to Brave fallback */ }
        }

        // Fallback: use Brave Search (or DuckDuckGo) with code-oriented query modifiers
        const codeQuery = `site:github.com OR site:stackoverflow.com OR site:stellaris.paradoxwikis.com ${query}`;
        const webResult = await this.searchWeb({ query: codeQuery, maxResults }, context);
        return { ...webResult, source: 'brave' as const, query };
    }

    /** Ensure the topic-scoped media output directory exists and return its path. */
    private async getMediaOutputDir(context?: import('../types').AgentToolContext): Promise<string> {
        const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId ?? 'session';
        const mediaDir = path.join(getTopicStorageDir(topicId, this.ctx.workspaceRoot), 'media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }
        return mediaDir;
    }

    /** Pure local command executor (no permission interception, no MMX check) for secure format conversion tools (ImageMagick/ffmpeg) */
    private async execLocalCommand(
        command: string,
        timeoutMs: number = 60000,
        context?: import('../types').AgentToolContext
    ): Promise<{ success: boolean; stdout: string; stderr: string; message: string }> {
        const onStep = context?.onStep;
        const abortSignal = context?.runnerOptions?.abortSignal;
        const label = '[Local Convert]';
        onStep?.({
            type: 'thinking',
            content: `${label} Executing: ${command.substring(0, 200)}...`,
            timestamp: Date.now(),
        });

        const startedAt = Date.now();
        let heartbeatId: ReturnType<typeof setInterval> | undefined;
        if (onStep) {
            heartbeatId = setInterval(() => {
                if (abortSignal?.aborted) return;
                const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                onStep({
                    type: 'orchestrator_progress',
                    content: `${label} still running (${elapsed}s): ${command.substring(0, 120)}`,
                    timestamp: Date.now(),
                });
            }, 15_000);
        }

        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            const { stdout, stderr } = await execAsync(command, {
                timeout: timeoutMs,
                cwd: this.ctx.workspaceRoot,
                signal: abortSignal,
                maxBuffer: 10 * 1024 * 1024,
            });

            onStep?.({
                type: 'thinking',
                content: `${label} Completed: ${stdout.trim().substring(0, 300)}`,
                timestamp: Date.now(),
            });

            return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), message: 'OK' };
        } catch (err) {
            const e = err as Error & { stdout?: string; stderr?: string; code?: string };
            const errMsg = e instanceof Error ? e.message : String(err);
            const stdout = typeof e.stdout === 'string' ? e.stdout.trim() : '';
            const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : errMsg;
            const reason = abortSignal?.reason;
            const abortedByTimeout = reason instanceof Error && reason.name === 'TimeoutError';
            const aborted = abortSignal?.aborted || e.name === 'AbortError' || /aborted/i.test(errMsg);
            const message = abortedByTimeout
                ? `Local conversion timed out after ${Math.round(timeoutMs / 1000)}s`
                : aborted
                    ? 'Local conversion was cancelled'
                    : `Execution failed: ${errMsg}`;
            return { success: false, stdout, stderr: stderr || errMsg, message };
        } finally {
            if (heartbeatId) clearInterval(heartbeatId);
        }
    }


    // ─── Media Asset Conversion Tools ────────────────────────────────────

    /** Cached result of ImageMagick availability check (null = not checked yet) */
    private imageMagickAvailable: boolean | null = null;
    /** Cached result of ffmpeg availability check (null = not checked yet) */
    private ffmpegAvailable: boolean | null = null;

    /** Resolve the ImageMagick binary path (custom setting or default 'magick'). */
    private getImageMagickBin(): string {
        return vs.workspace.getConfiguration('cwtools.ai').get<string>('imageMagickPath') || 'magick';
    }

    /** Resolve the ffmpeg binary path (custom setting or default 'ffmpeg'). */
    private getFfmpegBin(): string {
        return vs.workspace.getConfiguration('cwtools.ai').get<string>('ffmpegPath') || 'ffmpeg';
    }

    /** Check if ImageMagick is installed and accessible. Caches result for the session. */
    private async ensureImageMagickAvailable(): Promise<boolean> {
        if (this.imageMagickAvailable !== null) return this.imageMagickAvailable;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync(`${this.getImageMagickBin()} --version`, { timeout: 10000 });
            this.imageMagickAvailable = true;
        } catch {
            this.imageMagickAvailable = false;
        }
        return this.imageMagickAvailable;
    }

    /** Check if ffmpeg is installed and accessible. Caches result for the session. */
    private async ensureFfmpegAvailable(): Promise<boolean> {
        if (this.ffmpegAvailable !== null) return this.ffmpegAvailable;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync(`${this.getFfmpegBin()} -version`, { timeout: 10000 });
            this.ffmpegAvailable = true;
        } catch {
            this.ffmpegAvailable = false;
        }
        return this.ffmpegAvailable;
    }

    // ─── convert_image_to_dds ───────────────────────────────────────────

    async convertImageToDds(args: {
        sourcePath: string;
        outputDir?: string;
        compression?: 'dxt5' | 'dxt1' | 'none';
        generateMipmaps?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureImageMagickAvailable())) {
            return {
                success: false,
                message: `ImageMagick is not installed or not found at "${this.getImageMagickBin()}". Please install ImageMagick (https://imagemagick.org/) and ensure it is in your PATH, or set the custom path in cwtools.ai.imageMagickPath.`,
            };
        }

        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }

        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? this.resolveWorkspacePath(args.outputDir)
            : path.dirname(sourcePath);
        if (!this.isWithinAnyWorkspace(outDir)) {
            return { success: false, message: `Output directory must be within the workspace: ${args.outputDir}` };
        }
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Build output filename: same basename, .dds extension
        const baseName = path.basename(sourcePath, path.extname(sourcePath));
        const outFile = path.join(outDir, `${baseName}.dds`);

        // Build ImageMagick command
        const magickBin = this.getImageMagickBin();
        const compression = args.compression ?? 'dxt5';
        const mipmaps = args.generateMipmaps !== false; // default true

        // ImageMagick DDS defines
        let ddsDefines = '';
        if (compression === 'dxt5') {
            ddsDefines = '-define dds:compression=dxt5';
        } else if (compression === 'dxt1') {
            ddsDefines = '-define dds:compression=dxt1';
        } else {
            ddsDefines = '-define dds:compression=none';
        }
        if (mipmaps) {
            ddsDefines += ' -define dds:mipmaps=true';
        } else {
            ddsDefines += ' -define dds:mipmaps=0';
        }

        const cmd = `${magickBin} convert "${sourcePath}" ${ddsDefines} "${outFile}"`;

        const result = await this.execLocalCommand(cmd, 60000, context);
        if (!result.success) {
            return { success: false, message: `ImageMagick conversion failed: ${result.stderr || result.message}` };
        }

        if (!fs.existsSync(outFile)) {
            return { success: false, message: `Conversion completed but output file not found: ${outFile}` };
        }

        return {
            success: true,
            message: `Image converted to DDS (${compression}, mipmaps=${mipmaps}): ${outFile}`,
            outputFile: outFile,
        };
    }

    // ─── convert_audio ──────────────────────────────────────────────────

    async convertAudio(args: {
        sourcePath: string;
        outputDir?: string;
        targetFormat: 'ogg' | 'wav';
        sampleRate?: number;
        channels?: number;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureFfmpegAvailable())) {
            return {
                success: false,
                message: `ffmpeg is not installed or not found at "${this.getFfmpegBin()}". Please install ffmpeg (https://ffmpeg.org/) and ensure it is in your PATH, or set the custom path in cwtools.ai.ffmpegPath.`,
            };
        }

        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }

        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? this.resolveWorkspacePath(args.outputDir)
            : path.dirname(sourcePath);
        if (!this.isWithinAnyWorkspace(outDir)) {
            return { success: false, message: `Output directory must be within the workspace: ${args.outputDir}` };
        }
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const baseName = path.basename(sourcePath, path.extname(sourcePath));
        const outFile = path.join(outDir, `${baseName}.${args.targetFormat}`);
        const ffmpegBin = this.getFfmpegBin();

        // Build ffmpeg command based on target format
        let cmd: string;
        if (args.targetFormat === 'ogg') {
            // Vorbis encoding, quality 4 (~128kbps)
            cmd = `${ffmpegBin} -y -i "${sourcePath}" -c:a libvorbis -q:a 4`;
        } else {
            // WAV: 16-bit PCM, default 44100 Hz
            const sr = args.sampleRate ?? 44100;
            cmd = `${ffmpegBin} -y -i "${sourcePath}" -acodec pcm_s16le -ar ${sr}`;
        }

        // Optional sample rate override for OGG
        if (args.targetFormat === 'ogg' && args.sampleRate) {
            cmd += ` -ar ${args.sampleRate}`;
        }

        // Optional channel override
        if (args.channels) {
            cmd += ` -ac ${args.channels}`;
        }

        cmd += ` "${outFile}"`;

        const result = await this.execLocalCommand(cmd, 60000, context);
        if (!result.success) {
            return { success: false, message: `ffmpeg conversion failed: ${result.stderr || result.message}` };
        }

        if (!fs.existsSync(outFile)) {
            return { success: false, message: `Conversion completed but output file not found: ${outFile}` };
        }

        return {
            success: true,
            message: `Audio converted to ${args.targetFormat.toUpperCase()}: ${outFile}`,
            outputFile: outFile,
        };
    }

    // ─── deploy_mod_asset ───────────────────────────────────────────────

    async deployModAsset(args: {
        sourcePath: string;
        targetRelativePath: string;
        overwrite?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; finalPath?: string }> {
        const sourcePath = this.resolveWorkspacePath(args.sourcePath);
        if (!this.isWithinAnyWorkspace(sourcePath)) {
            return { success: false, message: `Source file must be within the workspace: ${args.sourcePath}` };
        }
        if (!fs.existsSync(sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Compute absolute target path
        const targetPath = this.resolveWorkspacePath(args.targetRelativePath);
        if (!this.isWithinAnyWorkspace(targetPath)) {
            return { success: false, message: `Target path must be within the workspace: ${args.targetRelativePath}` };
        }
        const targetDir = path.dirname(targetPath);

        // Check overwrite safety
        if (fs.existsSync(targetPath) && !args.overwrite) {
            return {
                success: false,
                message: `Target file already exists: ${targetPath}. Set overwrite=true to replace it.`,
            };
        }

        // Request user permission
        const onPermissionRequest = context?.onPermissionRequest;
        if (onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const allowed = await this.requestPermissionWithAbort(
                onPermissionRequest, permId, 'deploy_mod_asset',
                `AI 请求将媒体资产部署到 Mod 工作区：\n\n【源文件】：${sourcePath}\n【目标位置】：${args.targetRelativePath}\n【覆盖现有】：${args.overwrite ? '是' : '否'}`,
                context
            );
            if (!allowed) {
                return { success: false, message: '用户拒绝了此资产部署请求。' };
            }
        }

        try {
            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Snapshot for retract system (before writing)
            const previousContent = fs.existsSync(targetPath)
                ? fs.readFileSync(targetPath).toString('base64')
                : null;
            this.ctx.onBeforeFileWrite?.(targetPath, previousContent);

            // Copy the file
            fs.copyFileSync(sourcePath, targetPath);

            const onStep = context?.onStep;
            onStep?.({
                type: 'thinking',
                content: `[Deploy] ${path.basename(sourcePath)} → ${args.targetRelativePath}`,
                timestamp: Date.now(),
            });

            return {
                success: true,
                message: `Asset deployed: ${args.targetRelativePath}`,
                finalPath: targetPath,
            };
        } catch (e) {
            return {
                success: false,
                message: `Failed to deploy asset: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
}
