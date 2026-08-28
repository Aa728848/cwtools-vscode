/**
 * External Tool Handler — web fetch, web search, shell commands,
 * TODO list management, and sub-agent dispatch.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TodoItem, TodoWriteResult } from '../types';
import { ScopedTodoStore } from './scopedTodoStore';
import { preflightCommand, type ConfiguredCommandPolicyRule } from '../runner/commandPreflight';
import { hasInlineEvalPayload, PermissionPolicyStore } from '../runner/permissionPolicy';
import { requestPermissionWithAbort as sharedRequestPermissionWithAbort } from '../runner/permissionRequest';
import { processRegistry } from '../runner/processRegistry';
import { BrokeredSandboxRunner, DirectSandboxRunner, detectSandboxBackendAsync, type SandboxRunner } from '../runner/sandboxRunner';
import { getPrivateTopicRoot, getPrivateTopicScratchDir, getPrivateTopicStorageDir } from '../workspacePaths';
import {
    escapeRegExp,
    isPathInsideOrEqual,
    isSecuritySandboxDisabled,
    resolveWorkspacePathInput,
    sanitizePathInput,
} from '../workspaceSandbox';
import { aiText } from '../messages';
import {
    WebAccessService,
    type WebAccessConfig,
    type WebAccessMode,
    type WebSearchContextSize,
    type WebSearchProvider,
} from './webAccess';

const COMMAND_SNAPSHOT_MAX_FILE_BYTES = 500_000;
const COMMAND_SNAPSHOT_MAX_TOTAL_BYTES = 24_000_000;
const COMMAND_SNAPSHOT_MAX_FILES = 8000;
/**
 * Bounded cache of agent-topic directory listings per `.cwtools`-style root,
 * keyed by the root's own mtime (topic dirs appear/disappear when it changes).
 * Avoids re-enumerating every topic on each run_command.
 */
const PROTECTED_TOPIC_DIRS_CACHE = new Map<string, { mtimeMs: number; topicDirs: string[] }>();
const PROTECTED_TOPIC_DIRS_CACHE_MAX = 32;
let sandboxRunnerFactory: (spawnFn: typeof import('child_process').spawn) => SandboxRunner = spawnFn => new BrokeredSandboxRunner(spawnFn);

/** @internal Unit tests must opt into direct execution explicitly. */
export function useDirectSandboxRunnerForTests(enabled: boolean): void {
    sandboxRunnerFactory = enabled
        ? spawnFn => new DirectSandboxRunner(spawnFn)
        : spawnFn => new BrokeredSandboxRunner(spawnFn);
}
const COMMAND_SNAPSHOT_TEXT_EXTENSIONS = new Set([
    '.asset', '.cson', '.css', '.csv', '.cwt', '.fs', '.fsx', '.fxh', '.gfx', '.gui', '.html',
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
    '.cwtools', '.git', '.hg', '.svn', '.tmp-test', '.vscode-test', '.vs', '.idea',
    'node_modules', 'dist', 'out', 'build', 'coverage',
]);
const COMMAND_TEMP_SCRIPT_DIR_NAMES = new Set([
    '.tmp', 'scratch', 'temp', 'tmp',
]);
const COMMAND_TEMP_SCRIPT_NAME_PATTERN = /^(?:agent_helper|helper|tmp|temp|scratch|batch|bulk|replace|rewrite|fix|verify|check|search|scan)(?:[_\-.].*)?\.(?:bat|cmd|cjs|js|mjs|ps1|py|sh)$/i;
const COMMAND_STDOUT_MAX_CHARS = 4000;
const COMMAND_STDERR_MAX_CHARS = 2000;
const COMMAND_PROCESS_KILL_GRACE_MS = 1500;
type RunCommandShell = 'auto' | 'sh' | 'bash' | 'pwsh' | 'powershell';

function normalizeRunCommandShell(value: unknown): RunCommandShell {
    return value === 'sh' || value === 'bash' || value === 'pwsh' || value === 'powershell'
        ? value
        : 'auto';
}

function validateRunCommandShellPlatform(shell: RunCommandShell, platform: NodeJS.Platform): string | undefined {
    if (shell === 'auto') return undefined;
    if (platform === 'win32') {
        return shell === 'sh' || shell === 'bash'
            ? `${shell} is available for run_command only on macOS/Linux. On Windows use shell=auto or shell=pwsh/powershell.`
            : undefined;
    }
    return shell === 'pwsh' || shell === 'powershell'
        ? `${shell} is available for run_command only on Windows. On macOS/Linux use shell=auto, shell=sh, or shell=bash.`
        : undefined;
}

export class HeadTailTextBuffer {
    private head = '';
    private tail = '';
    private omittedChars = 0;
    private readonly headLimit: number;

    constructor(
        private readonly maxChars: number,
        private readonly tailLimit = Math.floor(maxChars / 2)
    ) {
        this.headLimit = Math.max(0, maxChars - tailLimit);
    }

    append(text: string): void {
        if (!text) return;
        let remaining = text;
        if (this.head.length < this.headLimit) {
            const headRoom = this.headLimit - this.head.length;
            this.head += remaining.slice(0, headRoom);
            remaining = remaining.slice(headRoom);
        }
        if (!remaining) return;

        this.tail += remaining;
        if (this.tail.length > this.tailLimit) {
            const drop = this.tail.length - this.tailLimit;
            this.tail = this.tail.slice(drop);
            this.omittedChars += drop;
        }
    }

    toString(): string {
        if (this.omittedChars <= 0) return this.head + this.tail;
        return `${this.head}\n... [${this.omittedChars} chars omitted] ...\n${this.tail}`;
    }
}

interface CommandFileState {
    filePath: string;
    size: number;
    mtimeMs: number;
    previousContent?: string | null;
    contentCaptured: boolean;
    hadBom?: boolean;
}

interface CommandFileChangeResult {
    changedFiles: string[];
    recordedSnapshots: number;
}

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties ExternalToolHandler reads from the executor. */
export interface ExternalToolContext {
    readonly workspaceRoot: string;
    /** Resolve search-provider credentials from VS Code SecretStorage. */
    getWebSearchApiKey?: (provider: Exclude<WebSearchProvider, 'auto' | 'duckduckgo' | 'searxng'>) => Promise<string | undefined>;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class ExternalToolHandler {
    private readonly todoStore = new ScopedTodoStore();
    private ignoredCommandTempArtifacts = new Set<string>();
    private readonly webAccess: WebAccessService;

    constructor(private ctx: ExternalToolContext) {
        this.webAccess = new WebAccessService({
            getConfig: () => this.getWebAccessConfig(),
            getApiKey: provider => this.ctx.getWebSearchApiKey?.(provider) ?? Promise.resolve(undefined),
        });
    }

    /** Topic dirs of an agent storage root, cached until the root's own mtime changes. */
    private cachedAgentTopicDirs(agentRoot: string): string[] {
        try {
            const stat = fs.statSync(agentRoot);
            const cached = PROTECTED_TOPIC_DIRS_CACHE.get(agentRoot);
            if (cached && cached.mtimeMs === stat.mtimeMs) return cached.topicDirs;
            const topicDirs = fs.readdirSync(agentRoot, { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name);
            if (PROTECTED_TOPIC_DIRS_CACHE.size >= PROTECTED_TOPIC_DIRS_CACHE_MAX) {
                PROTECTED_TOPIC_DIRS_CACHE.clear();
            }
            PROTECTED_TOPIC_DIRS_CACHE.set(agentRoot, { mtimeMs: stat.mtimeMs, topicDirs });
            return topicDirs;
        } catch {
            return [];
        }
    }

    private getWebAccessConfig(): WebAccessConfig {
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web');
        const providers = new Set<WebSearchProvider>(['auto', 'openai', 'brave', 'exa', 'tavily', 'serper', 'serpapi', 'searxng', 'duckduckgo']);
        const modes = new Set<WebAccessMode>(['disabled', 'indexed', 'live']);
        const contextSizes = new Set<WebSearchContextSize>(['low', 'medium', 'high']);
        const provider = cfg.get<string>('provider', 'auto') as WebSearchProvider;
        const mode = cfg.get<string>('mode', 'indexed') as WebAccessMode;
        const contextSize = cfg.get<string>('contextSize', 'medium') as WebSearchContextSize;
        const fallbackProviders = cfg.get<string[]>('fallbackProviders', [])
            .filter((value): value is WebSearchProvider => providers.has(value as WebSearchProvider));
        return {
            mode: modes.has(mode) ? mode : 'indexed',
            provider: providers.has(provider) ? provider : 'auto',
            fallbackProviders,
            contextSize: contextSizes.has(contextSize) ? contextSize : 'medium',
            allowedDomains: cfg.get<string[]>('allowedDomains', []),
            blockedDomains: cfg.get<string[]>('blockedDomains', []),
            country: cfg.get<string>('country', '').trim() || undefined,
            searxngEndpoint: cfg.get<string>('searxngEndpoint', '').trim() || undefined,
            openaiModel: cfg.get<string>('openaiModel', '').trim() || undefined,
            cacheTtlMs: cfg.get<number>('cacheTtlMs', 300_000),
            allowSyntheticProxyAddresses: cfg.get<boolean>('allowSyntheticProxyAddresses', false),
        };
    }

    private terminateProcessTree(proc: import('child_process').ChildProcess, spawnFn: typeof import('child_process').spawn): void {
        const pid = proc.pid;
        if (pid && process.platform === 'win32') {
            try {
                const killer = spawnFn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
                killer.on('error', () => {});
            } catch {
                // Fall through to direct process termination below.
            }
        } else if (pid) {
            try {
                process.kill(-pid, 'SIGTERM');
            } catch {
                try { proc.kill('SIGTERM'); } catch { /* best effort */ }
            }
        }

        try { proc.kill('SIGTERM'); } catch { /* best effort */ }

        const hardKill = setTimeout(() => {
            if (pid && process.platform !== 'win32') {
                try {
                    process.kill(-pid, 'SIGKILL');
                    return;
                } catch {
                    // Fall through to direct process termination below.
                }
            }
            if (proc.killed) return;
            try { proc.kill('SIGKILL'); } catch { /* best effort */ }
        }, COMMAND_PROCESS_KILL_GRACE_MS);
        hardKill.unref?.();
    }

    private isWithinAnyWorkspace(candidate: string): boolean {
        return resolveWorkspacePathInput(candidate, this.ctx.workspaceRoot).isWithinAnyWorkspace;
    }

    private isTrustedCommandWorkspace(candidate: string): boolean {
        return resolveWorkspacePathInput(candidate, this.ctx.workspaceRoot).isTrusted;
    }

    private resolveWorkspacePath(inputPath: string): string {
        return resolveWorkspacePathInput(inputPath, this.ctx.workspaceRoot).resolved;
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
        const topicRoot = getPrivateTopicRoot(this.ctx.workspaceRoot);
        const safeTopicId = (topicId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const safeTopicLower = safeTopicId.toLowerCase();
        const rewriteAgentPath = (rawPath: string): string => {
            const normalized = rawPath.replace(/\\/g, '/');
            const rest = normalized.replace(/^\.cwtools(?:[\\/]|$)/i, '').replace(/^\/+/, '');
            if (!rest) return topicRoot || '.cwtools';

            const restSegments = rest.split('/').filter(Boolean);
            const firstSegment = restSegments[0]?.toLowerCase() ?? '';
            const explicitlyScopedTopic = firstSegment === safeTopicLower || firstSegment.startsWith('topic_');
            const targetSegments = firstSegment === 'scratch'
                ? [safeTopicId, 'scratch', ...restSegments.slice(1)]
                : explicitlyScopedTopic
                    ? restSegments
                    : [safeTopicId, ...restSegments];

            if (!topicRoot) {
                return `.cwtools/${targetSegments.join('/')}`;
            }
            return path.join(topicRoot, ...targetSegments);
        };

        const quotedAgentPathPattern = /(^|[\s(])\\?(["'])(\.cwtools(?:[\\/][^"']+?)?)\\?\2/g;
        const withEscapedQuotedPaths = command.replace(quotedAgentPathPattern, (_match, prefix: string, quote: string, agentPath: string) =>
            `${prefix}${quote}${rewriteAgentPath(agentPath)}${quote}`
        );

        const quotedPattern = /(^|[\s(])(["'])(\.cwtools(?:[\\/][^"']*)?)\2/g;
        const withQuotedPaths = withEscapedQuotedPaths.replace(quotedPattern, (_match, prefix: string, quote: string, agentPath: string) =>
            `${prefix}${quote}${rewriteAgentPath(agentPath)}${quote}`
        );

        const barePattern = /(^|[\s(])(\.cwtools(?:[\\/][^\s"';&|<>]+)?)/g;
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
            if (!alias || alias.toLowerCase() === '.cwtools') continue;
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
            if (!root || path.basename(root).toLowerCase() === '.cwtools') return;
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
        if (segments[0] === '.cwtools') return true;

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
                let hadBom: boolean | undefined;
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
                } else {
                    try {
                        const handle = await fs.promises.open(fullPath, 'r');
                        try {
                            const bomBuffer = Buffer.alloc(3);
                            const read = await handle.read(bomBuffer, 0, 3, 0);
                            hadBom = read.bytesRead >= 3 && bomBuffer[0] === 0xEF && bomBuffer[1] === 0xBB && bomBuffer[2] === 0xBF;
                        } finally {
                            await handle.close();
                        }
                    } catch {
                        hadBom = undefined;
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
            ?? context?.runnerOptions?.onBeforeFileWrite;
    }

    private async recordCommandFileChanges(
        before: Map<string, CommandFileState> | undefined,
        context?: import('../types').AgentToolContext
    ): Promise<CommandFileChangeResult> {
        if (!before) return { changedFiles: [], recordedSnapshots: 0 };
        const record = this.getCommandSnapshotCallback(context);
        const after = await this.collectCommandFileState(false);
        const changedFiles: string[] = [];
        const changedKeys = new Set<string>();
        const addChangedFile = (filePath: string) => {
            const key = this.commandSnapshotKey(filePath);
            if (changedKeys.has(key)) return;
            changedKeys.add(key);
            changedFiles.push(filePath);
        };

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

        let recordedSnapshots = 0;

        for (const [key, beforeState] of before) {
            if (this.shouldIgnoreCommandChange(beforeState.filePath)) {
                continue;
            }
            const afterState = refreshedAfter.get(key);
            if (!afterState) {
                addChangedFile(beforeState.filePath);
                if (record && beforeState.contentCaptured && beforeState.previousContent !== undefined) {
                    record(beforeState.filePath, beforeState.previousContent);
                    recordedSnapshots++;
                }
                continue;
            }

            if (beforeState.size === afterState.size
                && Math.abs(beforeState.mtimeMs - afterState.mtimeMs) < 1) {
                continue;
            }

            if (beforeState.contentCaptured && beforeState.previousContent !== undefined) {
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
            }

            addChangedFile(beforeState.filePath);
            if (record && beforeState.contentCaptured && beforeState.previousContent !== undefined) {
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
                recordedSnapshots++;
            }
        }

        for (const [key, afterState] of refreshedAfter) {
            if (before.has(key)) continue;
            if (this.shouldIgnoreCommandChange(afterState.filePath, true)) continue;
            addChangedFile(afterState.filePath);
            if (record && afterState.size <= COMMAND_SNAPSHOT_MAX_FILE_BYTES) {
                record(afterState.filePath, null);
                recordedSnapshots++;
            }
        }

        return { changedFiles, recordedSnapshots };
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
        // Single implementation lives in runner/permissionRequest so the policy
        // engine and evidence gate share the same abort semantics.
        return sharedRequestPermissionWithAbort(
            onPermissionRequest as import('../runner/permissionRequest').PermissionRequestFn,
            { id, tool, description, command, context },
            context?.runnerOptions?.abortSignal,
        );
    }

    // ─── todoWrite ───────────────────────────────────────────────────────────

    // Conservative auto-approval classifier for shell commands that only read or format output.
    private isReadOnlyRunCommand(command: string): boolean {
        const result = preflightCommand(command);
        return result.segments.length > 0
            && !result.requiresPermission
            && !result.requiresEscalation
            && result.segments.every(segment => segment.classification === 'readonly');
    }

    async todoWrite(args: { todos: TodoItem[] }, context?: import('../types').AgentToolContext): Promise<TodoWriteResult> {
        console.time('todoWrite_exec');
        const agentId = context?.runnerOptions?.agentId;
        const currentTodos = this.todoStore.set(args.todos, agentId);
        const onTodoUpdate = context?.onTodoUpdate;
        if (onTodoUpdate) {
            onTodoUpdate(currentTodos, {
                agentId,
                threadId: context?.runnerOptions?.threadId,
                runId: context?.runnerOptions?.runRecord?.runId ?? context?.runEventSink?.runId,
            });
        }
        console.timeEnd('todoWrite_exec');
        return {
            success: true,
            todoCount: currentTodos.length,
        };
    }

    getTodos(agentId?: string): TodoItem[] { return this.todoStore.get(agentId); }
    restoreTodos(todos: readonly TodoItem[], agentId?: string): void {
        this.todoStore.set(todos, agentId);
    }
    clearTodos(agentId?: string): void { this.todoStore.clear(agentId); }

    private canAccessProcess(record: ReturnType<typeof processRegistry.get>, context?: import('../types').AgentToolContext): boolean {
        if (!record) return false;
        const threadId = context?.runnerOptions?.threadId;
        const runId = context?.runnerOptions?.runRecord?.runId;
        if (!threadId && !runId) return true;
        if (threadId && record.threadId) return record.threadId === threadId;
        if (runId && record.runId) return record.runId === runId;
        return false;
    }

    listProcesses(args: { status?: string } = {}, context?: import('../types').AgentToolContext): { processes: ReturnType<typeof processRegistry.list> } {
        const processes = processRegistry.list().filter(record => this.canAccessProcess(record, context) && (!args.status || record.status === args.status));
        return { processes };
    }

    readProcess(args: { processId: string }, context?: import('../types').AgentToolContext): { success: boolean; process?: ReturnType<typeof processRegistry.get>; error?: string } {
        const process = processRegistry.get(args.processId);
        return this.canAccessProcess(process, context) ? { success: true, process } : { success: false, error: `Unknown or inaccessible process: ${args.processId}` };
    }

    writeProcessStdin(args: { processId: string; text: string; submit?: boolean }, context?: import('../types').AgentToolContext): { success: boolean; error?: string } {
        if (!this.canAccessProcess(processRegistry.get(args.processId), context)) return { success: false, error: `Unknown or inaccessible process: ${args.processId}` };
        const text = args.submit === false ? args.text : `${args.text.replace(/\r?\n$/, '')}\n`;
        return processRegistry.writeStdin(args.processId, text)
            ? { success: true }
            : { success: false, error: `Process ${args.processId} is not running or does not accept input.` };
    }

    terminateProcess(args: { processId: string }, context?: import('../types').AgentToolContext): { success: boolean; error?: string } {
        if (!this.canAccessProcess(processRegistry.get(args.processId), context)) return { success: false, error: `Unknown or inaccessible process: ${args.processId}` };
        return processRegistry.terminate(args.processId, context?.runEventSink)
            ? { success: true }
            : { success: false, error: `Process ${args.processId} is not running.` };
    }

    // ─── ignoreValidationError ───────────────────────────────────────────────

    async ignoreValidationError(args: { errorId: string; reason: string }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; terminalOutcome?: import('../types').ToolTerminalOutcome }> {
        const onPermissionRequest = context?.onPermissionRequest;
        if (!onPermissionRequest) {
            return { success: false, message: 'Permission handler not configured. Cannot ignore validation errors.' };
        }

        const permId = `perm_${Date.now()}`;
        const allowed = await this.requestPermissionWithAbort(
            onPermissionRequest, permId,
            'ignore_validation_error',
            aiText(
                `AI requests to ignore this LSP validation error:\n\nError details: ${args.errorId}\nReason: ${args.reason}\n\nDo you want to permanently add this rule to the local whitelist (.cwtools-memory.md) to suppress future reports?`,
                `AI 请求忽略（IGNORE）此 LSP 验证错误：\n\n【错误详情】：${args.errorId}\n【判断理由】：${args.reason}\n\n您是否同意将此规则永久加入本地白名单 (.cwtools-memory.md) 以免除后续报错？`,
            ),
            context
        );

        if (!allowed) {
            return { success: false, message: 'User denied the request to ignore the validation error.', terminalOutcome: 'permission_denied' };
        }

        try {
            const { MemoryParser } = await import('../memoryParser');
            const topicId = context?.runnerOptions?.topicId;
            const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
            const result = await parser.appendMemory({
                key: 'Ignored Validation Error / Whitelist',
                content: `\`${args.errorId}\` (Reason: ${args.reason})`,
                priority: 'high',
            });

            return result.success
                ? { success: true, message: 'Error successfully whitelisted and saved to local memory.' }
                : result;
        } catch (e) {
            return { success: false, message: `Failed to save memory: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    // ─── removeIgnoredDiagnostic ──────────────────────────────────────────────

    async removeIgnoredDiagnostic(args: { diagnosticKey: string; reason: string }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; terminalOutcome?: import('../types').ToolTerminalOutcome }> {
        const vs = await import('vscode');
        const fileWriteMode = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('agentFileWriteMode', 'auto');

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
            aiText(
                `AI suggests removing this ignored diagnostic keyword from the whitelist:\n\nKeyword: ${args.diagnosticKey}\nReason: ${args.reason}\n\nDo you want to remove this rule from your .vscode settings and restore diagnostics for this keyword?`,
                `AI 建议从白名单中移除被忽略的报错关键字：\n\n【关键字】：${args.diagnosticKey}\n【判断理由】：${args.reason}\n\n您是否同意将此规则从您的 .vscode 设置中移除，恢复对此关键字的报错提示？`,
            ),
            context
        );

        if (!allowed) {
            return { success: false, message: 'User denied the request to remove the ignored diagnostic.', terminalOutcome: 'permission_denied' };
        }

        try {
            const vs = await import('vscode');
            const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
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

    async getIgnoredDiagnostics(): Promise<{
        success: boolean;
        ignoredKeys: string[];
        count: number;
        audit?: Array<{
            key: string;
            category: 'exact_id' | 'message_fragment' | 'type_name' | 'broad_pattern' | 'unmatched';
            stillHits: boolean;
            matchCount: number;
        }>;
    }> {
        try {
            const vs = await import('vscode');
            const ignored = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string[]>('ignoredDiagnostics', []);
            // Audit every ignore entry against the current diagnostics so the
            // model can distinguish exact suppressions from dangerous broad
            // patterns and stale entries that no longer match anything.
            const allDiags: Array<{ code: string; message: string; source: string }> = [];
            for (const [, diags] of vs.languages.getDiagnostics()) {
                for (const d of diags) {
                    const code = typeof d.code === 'object' && d.code !== null
                        ? String((d.code as { value?: unknown }).value ?? '')
                        : String(d.code ?? '');
                    allDiags.push({ code, message: d.message, source: String(d.source ?? '') });
                }
            }
            const audit = ignored.map(key => {
                const trimmed = key.trim();
                let category: 'exact_id' | 'message_fragment' | 'type_name' | 'broad_pattern' | 'unmatched' = 'unmatched';
                const lowerKey = trimmed.toLowerCase();
                const broad = /^[a-z0-9_ -]+$/i.test(trimmed)
                    && !trimmed.includes(':')
                    && trimmed.split(/[\s_-]+/).filter(Boolean).length <= 2;
                const exactHits = allDiags.filter(d => d.code.toLowerCase() === lowerKey);
                const fragmentHits = allDiags.filter(d => d.message.toLowerCase().includes(lowerKey) || d.source.toLowerCase().includes(lowerKey));
                const matchCount = exactHits.length + fragmentHits.length;
                category = trimmed.includes(':') && exactHits.length > 0
                    ? 'exact_id'
                    : broad && matchCount === 0
                        ? 'broad_pattern'
                        : broad
                            ? 'broad_pattern'
                            : fragmentHits.length > 0
                                ? 'message_fragment'
                                : matchCount > 0
                                    ? 'type_name'
                                    : 'unmatched';
                return {
                    key: trimmed,
                    category,
                    stillHits: matchCount > 0,
                    matchCount,
                };
            });
            return { success: true, count: ignored.length, ignoredKeys: ignored, audit };
        } catch {
            return { success: false, count: 0, ignoredKeys: [] };
        }
    }

    // ─── Web access ─────────────────────────────────────────────────────────

    async webOpen(args: import('./webAccess').WebOpenArgs, context?: import('../types').AgentToolContext): Promise<Record<string, unknown>> {
        return this.webAccess.open(args, context?.runnerOptions?.abortSignal);
    }

    async webSearch(args: import('./webAccess').WebSearchArgs, context?: import('../types').AgentToolContext): Promise<import('./webAccess').WebSearchResult> {
        return this.webAccess.search(args, context?.runnerOptions?.abortSignal);
    }

    webFind(args: import('./webAccess').WebFindArgs): Record<string, unknown> {
        return this.webAccess.find(args);
    }

    resolveWebReference(ref: string): string {
        return this.webAccess.resolveReference(ref);
    }

    async runCommand(args: { command: string; shell?: RunCommandShell; cwd?: string; timeoutMs?: number; background?: boolean; requestEscalation?: boolean; unsandboxed?: boolean; executionMode?: 'captured' | 'terminal'; networkAccess?: boolean; networkHosts?: string[] }, context?: import('../types').AgentToolContext): Promise<{
        success?: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
        processId?: string;
        status?: 'started' | 'completed';
        timedOut?: boolean;
        changedFiles?: string[];
        writtenFiles?: string[];
        recordedSnapshots?: number;
        terminalOutcome?: import('../types').ToolTerminalOutcome;
    }> {
        // Safety: deny obviously dangerous commands and shell control operators.
        // Approval behavior is mode-agnostic: every mode shares the same
        // safe-command auto-approval, learned rules, and approval boundary.
        const topicId = context?.runnerOptions?.topicId || 'default';
        const requestedShell = normalizeRunCommandShell(args.shell);
        const shellPlatformError = validateRunCommandShellPlatform(requestedShell, process.platform);
        if (shellPlatformError) {
            return { stdout: '', stderr: `Blocked: ${shellPlatformError}`, exitCode: 1 };
        }
        args.command = this.normalizeAgentWorkspaceCommand(args.command, topicId);
        const aliasNormalized = this.normalizeWorkspaceFolderAliasCommand(args.command);
        args.command = aliasNormalized.command;
        const crossWorkspacePathAccess = aliasNormalized.crossWorkspacePathAccess;
        const commandRules = vs.workspace.getConfiguration('stellarisLanguageServices.ai')
            .get<ConfiguredCommandPolicyRule[]>('shell.commandRules', []);
        const preflight = preflightCommand(args.command, commandRules);
        const opaqueExecution = preflight.opaqueExecution || hasInlineEvalPayload(args.command);
        const isReadOnlyCommand = this.isReadOnlyRunCommand(args.command);
        const isAutoApproveSafeCommand = preflight.decision === 'allow';

        const bypassSandbox = isSecuritySandboxDisabled();
        const directExecution = bypassSandbox || args.unsandboxed === true;
        let escalationReason = '';
        const detectedNetworkHosts = [...args.command.matchAll(/https?:\/\/([^\s/'"`<>]+)/gi)]
            .map(match => match[1]!.split(':')[0]!.toLowerCase());
        const requestedNetworkHosts = [...new Set([...(args.networkHosts ?? []), ...detectedNetworkHosts]
            .map(host => host.trim().toLowerCase()).filter(Boolean))];
        const isPrivateNetworkHost = (host: string) => host === 'localhost' || host.endsWith('.local')
            || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
            || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || host === '::1';
        if (args.networkAccess && requestedNetworkHosts.some(isPrivateNetworkHost) && !args.requestEscalation && !bypassSandbox) {
            return {
                stdout: '',
                stderr: 'Blocked: local/private network destinations require requestEscalation=true and explicit approval.',
                exitCode: 1,
            };
        }
        if (args.networkAccess && requestedNetworkHosts.some(isPrivateNetworkHost) && args.requestEscalation) {
            escalationReason = aiText('local/private network destination', '本地/私有网络目标');
        }

        if (args.unsandboxed && !args.requestEscalation && !bypassSandbox) {
            return {
                stdout: '',
                stderr: 'Unsandboxed execution requires requestEscalation=true and an explicit one-time user approval.',
                exitCode: 1,
            };
        }

        if (args.executionMode === 'terminal' && !bypassSandbox && !args.requestEscalation) {
            return {
                stdout: '',
                stderr: 'Interactive terminal execution is user-visible but not OS-sandboxed. Retry with requestEscalation=true to request explicit approval.',
                exitCode: 1,
            };
        }

        let cwd: string;
        try {
            const requestedCwd = typeof args.cwd === 'string' && args.cwd.trim()
                ? sanitizePathInput(args.cwd)
                : this.ctx.workspaceRoot;
            const cwdResolution = resolveWorkspacePathInput(requestedCwd, this.ctx.workspaceRoot);
            cwd = cwdResolution.resolved;

            if (!cwdResolution.isTrusted && !bypassSandbox) {
                if (cwdResolution.isWithinAnyWorkspace) {
                    if (!isReadOnlyCommand) {
                        escalationReason = escalationReason || aiText('cross-workspace working directory access', '跨工作区工作目录访问');
                    }
                } else if (args.requestEscalation) {
                    escalationReason = escalationReason || aiText('working directory outside workspace', '工作目录越界访问');
                } else {
                    return { stdout: '', stderr: 'Blocked: Working directory must be within the workspace root or another workspace folder. If this is required, retry with "requestEscalation": true to ask the user for a one-time privilege override.', exitCode: 1 };
                }
            }
        } catch {
            return { stdout: '', stderr: `Blocked: Invalid working directory`, exitCode: 1 };
        }

        args.command = this.relativizeCommandPathsForCwd(args.command, cwd);

        if (crossWorkspacePathAccess && !isReadOnlyCommand && !bypassSandbox) {
            escalationReason = escalationReason || aiText('cross-workspace path access', '跨工作区路径访问');
        }

        const gitMetadataMutation = preflight.segments.length > 0
            && preflight.segments.every(segment => segment.command === 'git')
            && preflight.segments.some(segment => segment.classification !== 'readonly');
        const gitMetadataAllowedByRule = gitMetadataMutation
            && preflight.segments.every(segment => segment.classification === 'readonly'
                || (!!segment.matchedRule && segment.decision === 'allow'));
        const mutatesProtectedPath = preflight.segments.some(segment => segment.classification !== 'readonly'
            && /(?:^|[\s"'\\/])\.(?:git|agents|codex)(?:$|[\s"'\\/])/i.test(segment.raw));
        if (mutatesProtectedPath && !args.unsandboxed && !bypassSandbox) {
            return {
                stdout: '',
                stderr: 'Blocked: commands cannot mutate protected Git/agent control paths inside the workspace sandbox. Retry only with requestEscalation=true and unsandboxed=true for a one-time explicit approval.',
                exitCode: 1,
            };
        }
        const currentEscalationReason = escalationReason || (preflight.requiresEscalation ? preflight.blockedReason : '');
        const requestedWritableRoots = [this.ctx.workspaceRoot];
        if (currentEscalationReason && !isPathInsideOrEqual(cwd, this.ctx.workspaceRoot)) requestedWritableRoots.push(cwd);
        
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
        const safeAutoApprove = isAutoApproveSafeCommand && !args.requestEscalation && !currentEscalationReason;
        const configuredRuleRequiresPrompt = preflight.segments.some(segment =>
            !!segment.matchedRule && segment.decision !== 'allow');
        // Command auto-runs only when the tool classifies it as safe or it matches pre-approved session policy.
        // All agent modes share this gate; mode-specific privileges were removed so the
        // approval boundary (learned rules -> auto-review -> user) is the single decision point.
        let requiresPermission = opaqueExecution
            || configuredRuleRequiresPrompt
            || (!safeAutoApprove && !approvedByPolicy);
        
        // Escalation overrides MUST always prompt user regardless of policy/auto configurations
        if (preflight.requiresEscalation || currentEscalationReason) {
            requiresPermission = true;
        }
        if (args.networkAccess === true) requiresPermission = true;
        // The explicit workspace-session/persistent Full Access profile disables
        // the approval boundary as advertised. One-shot `unsandboxed` calls do
        // not set bypassSandbox and still require their own approval.
        if (bypassSandbox) requiresPermission = false;
        const onPermissionRequest = context?.onPermissionRequest;
        let grantedPermissionId: string | undefined;

        if (requiresPermission && onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const leavesOsSandbox = args.unsandboxed === true || args.executionMode === 'terminal';
            // Build rich detailed telemetry payload for Webview visual enhancement
            const preflightPayload = {
                command: args.command,
                shell: requestedShell,
                cwd,
                opaqueExecution,
                classification: preflight.segments.map(s => s.classification),
                riskLevel: preflight.riskLevel,
                escalation: !!currentEscalationReason || args.unsandboxed === true || gitMetadataMutation,
                reasons: [
                    ...preflight.segments.map(s => s.reason),
                    ...(gitMetadataMutation ? [aiText('This approval temporarily permits Git metadata writes for this command only.', '此审批仅为本次命令临时允许写入 Git 元数据。')] : []),
                    ...(args.executionMode === 'terminal' ? [aiText('The agent may send input to or terminate this task-owned terminal through process controls.', 'Agent 可通过进程控制向此任务所属终端发送输入或终止它。')] : []),
                ],
                networkAccess: leavesOsSandbox || args.networkAccess === true,
                networkHosts: requestedNetworkHosts,
                networkEnforcement: leavesOsSandbox
                    ? 'unrestricted'
                    : args.networkAccess === true
                    ? (requestedNetworkHosts.length > 0 ? 'declared-only' : 'broad')
                    : 'blocked',
                sandboxMode: args.executionMode === 'terminal' ? 'user-approved-terminal' : args.unsandboxed ? 'disabled' : 'workspace-write',
                unsandboxed: leavesOsSandbox,
                writableRoots: leavesOsSandbox ? undefined : [...new Set(requestedWritableRoots.map(root => path.resolve(root)))],
                protectedPathOverrides: gitMetadataMutation ? ['.git'] : undefined,
            };
            const description = args.executionMode === 'terminal'
                ? `[UNSANDBOXED TERMINAL] AI requests a one-time visible VS Code terminal with unrestricted process, filesystem, and network access: ${args.command}`
                : args.unsandboxed
                ? `[UNSANDBOXED] AI requests a one-time command run with the OS sandbox disabled: ${args.command}`
                : currentEscalationReason
                ? `[ESCALATION] AI requests additional sandbox scope (${currentEscalationReason}): ${args.command}`
                : aiText(`AI requests to run terminal command: ${args.command}`, `AI 请求执行终端命令：${args.command}`);
            
            const allowed = await this.requestPermissionWithAbort(
                onPermissionRequest, permId, 'run_command', description, { ...context, preflight: preflightPayload } as any, args.command
            );
            if (!allowed) {
                return {
                    success: false,
                    stdout: '',
                    stderr: aiText('User denied permission to run this command', '用户拒绝了此命令的执行权限'),
                    exitCode: 1,
                    terminalOutcome: 'permission_denied',
                };
            }
            grantedPermissionId = permId;
        } else if (requiresPermission) {
            return { stdout: '', stderr: 'run_command: no permission handler configured', exitCode: 1 };
        }

        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30000, 1000), 3_600_000);
        const { spawn } = await import('child_process');

        // Parse command into binary + args on the platform shell
        const isWindows = process.platform === 'win32';
        const detectedSandbox = directExecution ? undefined : await detectSandboxBackendAsync();
        const useWslSandbox = isWindows && detectedSandbox?.backend === 'wsl-bubblewrap';
        if (useWslSandbox && preflight.segments.some(segment => /^(?:get-|set-|new-|remove-|select-|where-|format-|out-|write-|resolve-|test-)/i.test(segment.command))) {
            return {
                stdout: '',
                stderr: 'The enforced Windows fallback is WSL2 + bubblewrap, but this command uses PowerShell-only cmdlets. Use a portable command, install the native Windows helper, or request a visible terminal explicitly.',
                exitCode: 1,
            };
        }
        if (useWslSandbox && (requestedShell === 'pwsh' || requestedShell === 'powershell')) {
            return {
                stdout: '',
                stderr: 'The enforced Windows fallback is WSL2 + bubblewrap, so explicit PowerShell shells cannot be honored. Use shell=auto with portable POSIX syntax, install the native Windows helper, or request a visible terminal explicitly.',
                exitCode: 1,
            };
        }
        const shell = useWslSandbox
            ? '/bin/sh'
            : isWindows
            ? (requestedShell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe')
            : requestedShell === 'bash'
            ? 'bash'
            : '/bin/sh';
        const commandText = isWindows && !useWslSandbox
            ? '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; ' + args.command
            : args.command;
        const shellArgs = isWindows && !useWslSandbox
            ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', commandText]
            : [requestedShell === 'bash' ? '-lc' : '-c', commandText];
        const agentWorkspaceDir = getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot);
        const scratchDir = getPrivateTopicScratchDir(topicId, this.ctx.workspaceRoot);
        const helperScript = scratchDir ? path.join(scratchDir, 'agent_helper.py') : '';
        const mediaDir = agentWorkspaceDir ? path.join(agentWorkspaceDir, 'media') : '';
        try {
            if (agentWorkspaceDir) fs.mkdirSync(agentWorkspaceDir, { recursive: true });
            if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });
            if (mediaDir) fs.mkdirSync(mediaDir, { recursive: true });
        } catch { /* best effort */ }
        const commandEnv: Record<string, string | undefined> = {
            ...process.env,
            CWT_WORKSPACE_ROOT: this.ctx.workspaceRoot,
            CWT_AGENT_TOPIC_ID: topicId,
            CWT_AGENT_WORKSPACE_DIR: agentWorkspaceDir,
            CWT_AGENT_SCRATCH_DIR: scratchDir,
            CWT_AGENT_HELPER_SCRIPT: helperScript,
            CWT_AGENT_MEDIA_DIR: mediaDir,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            LC_ALL: process.env.LC_ALL || 'C.UTF-8',
            LANG: process.env.LANG || 'C.UTF-8',
        };
        // Env allowlist: 'log' shadow-reports what enforcement would drop; 'enforce' filters.
        let spawnEnv = commandEnv;
        try {
            const shellCfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
            const envMode = shellCfg.get<string>('shell.envAllowlist', 'log');
            if (envMode === 'log' || envMode === 'enforce') {
                const { buildSandboxedEnv } = await import('../runner/shellEnv');
                const { env, dropped } = buildSandboxedEnv(commandEnv, {
                    userAdditions: shellCfg.get<string[]>('shell.envAllowlistAdditions', []),
                });
                if (envMode === 'enforce') spawnEnv = env;
                else if (dropped.length > 0) {
                    const { ErrorReporter } = await import('../errorReporter');
                    ErrorReporter.debug('shellEnv', `env allowlist would drop ${dropped.length} vars: ${dropped.slice(0, 20).join(', ')}`);
                }
            }
        } catch { /* allowlist must not break command execution */ }

        const eventSink = context?.runEventSink ?? context?.runnerOptions?.runEventSink;
        if (args.executionMode === 'terminal') {
            const terminal = vs.window.createTerminal({
                name: `CWTools Agent · ${topicId}`,
                cwd,
                env: spawnEnv,
                isTransient: false,
            });
            const record = processRegistry.register(args.command, cwd, undefined, eventSink, {
                sandboxMode: 'user-approved-terminal',
                networkAccess: true,
                authorization: bypassSandbox
                    ? { type: 'full-access' }
                    : { type: 'one-shot', permissionId: grantedPermissionId },
            }, {
                executionMode: 'terminal',
                runId: context?.runnerOptions?.runRecord?.runId,
                threadId: context?.runnerOptions?.threadId,
                topicId: context?.runnerOptions?.topicId,
                terminate: () => terminal.dispose(),
                writeStdin: text => terminal.sendText(text.replace(/\r?\n$/, ''), /\r?\n$/.test(text)),
            });
            void terminal.processId.then(pid => processRegistry.setPid(record.processId, pid));
            const closeDisposable = vs.window.onDidCloseTerminal(closed => {
                if (closed !== terminal) return;
                const exitCode = closed.exitStatus?.code;
                if (typeof exitCode === 'number') processRegistry.complete(record.processId, exitCode, eventSink);
                else processRegistry.markTerminated(record.processId, eventSink);
                closeDisposable.dispose();
            });
            terminal.show(true);
            terminal.sendText(args.command, true);
            return {
                stdout: `Command started in a visible VS Code terminal. Process id: ${record.processId}`,
                stderr: '',
                exitCode: 0,
                processId: record.processId,
                status: 'started',
            };
        }

        const stdoutBuf = new HeadTailTextBuffer(COMMAND_STDOUT_MAX_CHARS);
        const stderrBuf = new HeadTailTextBuffer(COMMAND_STDERR_MAX_CHARS);
        // Approval and sandboxing are independent. A normal escalation grants
        // only the requested cwd/network scope; direct execution requires the
        // explicit unsandboxed flag (or the persistent full-access setting).
        const workspaceRoots = [...new Set([this.ctx.workspaceRoot, ...(vs.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)].filter(Boolean))];
        const writableRoots = requestedWritableRoots;
        const protectedNames = gitMetadataMutation && (!!grantedPermissionId || gitMetadataAllowedByRule)
            ? ['.agents', '.codex']
            : ['.git', '.agents', '.codex'];
        const rootsToProtect = [...new Set([...workspaceRoots, cwd])];
        const protectedPaths = rootsToProtect.flatMap(root => protectedNames.map(name => path.join(root, name)));
        for (const root of rootsToProtect) {
            const gitMarker = path.join(root, '.git');
            try {
                if (fs.statSync(gitMarker).isFile()) {
                    const match = fs.readFileSync(gitMarker, 'utf8').match(/^gitdir:\s*(.+)$/im);
                    if (match?.[1]) protectedPaths.push(path.resolve(root, match[1].trim()));
                }
            } catch { /* non-worktree or inaccessible marker */ }
            const agentRoots = [path.join(root, '.cwtools')];
            const privateNames = ['runs', 'threads', 'goals', 'blackboard', 'resume_state.json', 'resume_state.json.bak'];
            for (const agentRoot of agentRoots) {
                for (const topic of this.cachedAgentTopicDirs(agentRoot)) {
                    for (const name of privateNames) protectedPaths.push(path.join(agentRoot, topic, name));
                }
            }
        }
        const sandboxProfile = {
            sandboxMode: directExecution ? 'disabled' : 'workspace-write',
            networkAccess: directExecution ? true : args.networkAccess === true,
            writableRoots: [...new Set(writableRoots.map(root => path.resolve(root)))],
            protectedPaths: [...new Set(protectedPaths.map(protectedPath => path.resolve(protectedPath)))],
            authorization: directExecution
                ? (bypassSandbox ? { type: 'full-access' as const } : { type: 'one-shot' as const, permissionId: grantedPermissionId })
                : undefined,
        };
        let commandChangeBaseline: Map<string, CommandFileState> | undefined;
        const shouldTrackCommandChanges = !isReadOnlyCommand;
        if (shouldTrackCommandChanges) {
            try {
                commandChangeBaseline = await this.collectCommandFileState(!!this.getCommandSnapshotCallback(context));
            } catch {
                commandChangeBaseline = undefined;
            }
        }

        if (args.background) {
            try {
                const sandboxRunner = sandboxRunnerFactory(spawn);
                const proc = sandboxRunner.spawn({
                    command: shell,
                    args: shellArgs,
                    options: {
                        cwd,
                        env: spawnEnv,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        detached: !isWindows,
                        windowsHide: true,
                    },
                    profile: sandboxProfile,
                });
                const record = processRegistry.register(args.command, cwd, proc.pid, eventSink, sandboxProfile, {
                    executionMode: 'captured',
                    runId: context?.runnerOptions?.runRecord?.runId,
                    threadId: context?.runnerOptions?.threadId,
                    topicId: context?.runnerOptions?.topicId,
                    terminate: () => this.terminateProcessTree(proc, spawn),
                    writeStdin: text => {
                        if (!proc.stdin || proc.stdin.destroyed) throw new Error('Process stdin is unavailable');
                        proc.stdin.write(text);
                    },
                });
                let capturedChanges = false;
                const captureChanges = () => {
                    if (capturedChanges) return;
                    capturedChanges = true;
                    void this.recordCommandFileChanges(commandChangeBaseline, context).then(changes => {
                        if (changes.changedFiles.length > 0) {
                            context?.onStep?.({
                                type: 'thinking',
                                content: `run_command recorded ${changes.changedFiles.length} background workspace file change(s).`,
                                timestamp: Date.now(),
                            });
                        }
                    }).catch(() => {});
                };
                proc.stdout?.on('data', (chunk: Buffer) => processRegistry.appendOutput(record.processId, 'stdout', chunk.toString(), eventSink));
                proc.stderr?.on('data', (chunk: Buffer) => processRegistry.appendOutput(record.processId, 'stderr', chunk.toString(), eventSink));
                proc.on('error', (error: Error) => {
                    processRegistry.appendOutput(record.processId, 'stderr', `spawn error: ${error.message}`, eventSink);
                    processRegistry.complete(record.processId, 1, eventSink);
                    captureChanges();
                });
                proc.on('close', code => {
                    processRegistry.complete(record.processId, code ?? 0, eventSink);
                    captureChanges();
                });
                const timer = setTimeout(() => {
                    this.terminateProcessTree(proc, spawn);
                    processRegistry.appendOutput(record.processId, 'stderr', '\n[... stopped after timeout]', eventSink);
                    processRegistry.markTerminated(record.processId, eventSink);
                    captureChanges();
                }, timeoutMs);
                timer.unref?.();
                proc.once('close', () => clearTimeout(timer));
                return {
                    stdout: `Captured background command started. Process id: ${record.processId}`,
                    stderr: '',
                    exitCode: 0,
                    processId: record.processId,
                    status: 'started',
                };
            } catch (error) {
                return {
                    stdout: '',
                    stderr: `Failed to start background command in cwd "${cwd}": ${error instanceof Error ? error.message : String(error)}`,
                    exitCode: 1,
                };
            }
        }

        const commandResult = await new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
            processId?: string;
            timedOut?: boolean;
        }>(resolve => {
            let proc: ReturnType<typeof spawn>;
            let processId: string | undefined;
            try {
                const sandboxRunner = sandboxRunnerFactory(spawn);
                proc = sandboxRunner.spawn({
                    command: shell,
                    args: shellArgs,
                    options: {
                        cwd,
                        env: spawnEnv,
                        stdio: ['ignore', 'pipe', 'pipe'],
                        detached: !isWindows,
                        windowsHide: true,
                    },
                    profile: sandboxProfile,
                });
                processId = processRegistry.register(args.command, cwd, proc.pid, eventSink, sandboxProfile, {
                    executionMode: 'captured',
                    runId: context?.runnerOptions?.runRecord?.runId,
                    threadId: context?.runnerOptions?.threadId,
                    topicId: context?.runnerOptions?.topicId,
                    terminate: () => this.terminateProcessTree(proc, spawn),
                }).processId;
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

            const finish = (result: { stdout: string; stderr: string; exitCode: number; processId?: string; timedOut?: boolean }) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                if (abortSignal) abortSignal.removeEventListener('abort', onParentAbort);
                resolve(processId ? { ...result, processId } : result);
            };

            const onParentAbort = () => {
                const reason = abortSignal?.reason;
                const abortedByTimeout = reason instanceof Error && reason.name === 'TimeoutError';
                this.terminateProcessTree(proc, spawn);
                if (processId) processRegistry.markTerminated(processId, eventSink);
                stdoutBuf.append(abortedByTimeout
                    ? aiText('\n[... stopped after timeout]', '\n[... 超时已终止]')
                    : aiText('\n[... stopped by user]', '\n[... 被用户中止]'));
                finish({
                    stdout: stdoutBuf.toString(),
                    stderr: stderrBuf.toString(),
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
                if (!settled && processId) processRegistry.complete(processId, 1, eventSink);
                finish({
                    stdout: stdoutBuf.toString(),
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
                    content: aiText(`Command is still running (${elapsed}s).`, `命令仍在执行中 (${elapsed}s)。`),
                    timestamp: Date.now(),
                });
            }, 15_000);

            timer = setTimeout(() => {
                this.terminateProcessTree(proc, spawn);
                if (processId) processRegistry.markTerminated(processId, eventSink);
                stdoutBuf.append(aiText('\n[... stopped after timeout]', '\n[... 超时已终止]'));
                finish({
                    stdout: stdoutBuf.toString(),
                    stderr: stderrBuf.toString(),
                    exitCode: -1,
                    timedOut: true,
                });
            }, timeoutMs);

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stdoutBuf.append(text);
                if (processId) processRegistry.appendOutput(processId, 'stdout', text, eventSink);
            });

            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrBuf.append(text);
                if (processId) processRegistry.appendOutput(processId, 'stderr', text, eventSink);
            });

            proc.on('close', code => {
                if (!settled && processId) processRegistry.complete(processId, code ?? 0, eventSink);
                finish({
                    stdout: stdoutBuf.toString(),
                    stderr: stderrBuf.toString(),
                    exitCode: code ?? 0,
                });
            });

            proc.on('error', err => {
                if (!settled && processId) processRegistry.complete(processId, 1, eventSink);
                finish({
                    stdout: stdoutBuf.toString(),
                    stderr: `spawn error: ${err.message}`,
                    exitCode: 1,
                });
            });
        });

        let commandChanges: CommandFileChangeResult = { changedFiles: [], recordedSnapshots: 0 };
        try {
            commandChanges = await this.recordCommandFileChanges(commandChangeBaseline, context);
            if (commandChanges.changedFiles.length > 0) {
                context?.onStep?.({
                    type: 'thinking',
                    content: `run_command recorded ${commandChanges.changedFiles.length} workspace file change(s).`,
                    timestamp: Date.now(),
                });
            }
        } catch {
            // File-change capture is best-effort; command output remains authoritative.
        }

        if (commandChanges.changedFiles.length > 0) {
            return {
                ...commandResult,
                changedFiles: commandChanges.changedFiles,
                writtenFiles: commandChanges.changedFiles,
                recordedSnapshots: commandChanges.recordedSnapshots,
            };
        }
        return commandResult;
    }

    /** Ensure the topic-scoped media output directory exists and return its path. */
    private async getMediaOutputDir(context?: import('../types').AgentToolContext): Promise<string> {
        const topicId = context?.runnerOptions?.topicId ?? 'session';
        const mediaDir = path.join(getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot), 'media');
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
        return vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('imageMagickPath') || 'magick';
    }

    /** Resolve the ffmpeg binary path (custom setting or default 'ffmpeg'). */
    private getFfmpegBin(): string {
        return vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('ffmpegPath') || 'ffmpeg';
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
        compression?: 'dxt5' | 'dxt1' | 'dxt3' | 'none';
        generateMipmaps?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureImageMagickAvailable())) {
            return {
                success: false,
                message: `ImageMagick is not installed or not found at "${this.getImageMagickBin()}". Please install ImageMagick (https://imagemagick.org/) and ensure it is in your PATH, or set the custom path in stellarisLanguageServices.ai.imageMagickPath.`,
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
        const mipmaps = args.generateMipmaps === true; // default false

        // ImageMagick DDS defines
        let ddsDefines = '';
        if (compression === 'dxt5') {
            ddsDefines = '-define dds:compression=dxt5';
        } else if (compression === 'dxt1') {
            ddsDefines = '-define dds:compression=dxt1';
        } else if (compression === 'dxt3') {
            ddsDefines = '-define dds:compression=dxt3';
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
                message: `ffmpeg is not installed or not found at "${this.getFfmpegBin()}". Please install ffmpeg (https://ffmpeg.org/) and ensure it is in your PATH, or set the custom path in stellarisLanguageServices.ai.ffmpegPath.`,
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
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; finalPath?: string; writtenFiles?: string[]; terminalOutcome?: import('../types').ToolTerminalOutcome }> {
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
                aiText(
                    `AI requests to deploy a media asset into the mod workspace:\n\nSource file: ${sourcePath}\nTarget path: ${args.targetRelativePath}\nOverwrite existing: ${args.overwrite ? 'yes' : 'no'}`,
                    `AI 请求将媒体资产部署到 Mod 工作区：\n\n【源文件】：${sourcePath}\n【目标位置】：${args.targetRelativePath}\n【覆盖现有】：${args.overwrite ? '是' : '否'}`,
                ),
                context
            );
            if (!allowed) {
                return {
                    success: false,
                    message: aiText('User denied this asset deployment request.', '用户拒绝了此资产部署请求。'),
                    terminalOutcome: 'permission_denied',
                };
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
            (context?.onBeforeFileWrite ?? context?.runnerOptions?.onBeforeFileWrite)?.(targetPath, previousContent);

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
                writtenFiles: [targetPath],
            };
        } catch (e) {
            return {
                success: false,
                message: `Failed to deploy asset: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
}
