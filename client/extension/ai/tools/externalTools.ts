/**
 * External Tool Handler — web fetch, web search, shell commands,
 * TODO list management, and sub-agent dispatch.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentMode, TodoItem, TodoWriteResult } from '../types';

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

    constructor(private ctx: ExternalToolContext) {}

    // ─── todoWrite ───────────────────────────────────────────────────────────

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
        const allowed = await onPermissionRequest(
            permId,
            'ignore_validation_error',
            `AI 请求忽略（IGNORE）此 LSP 验证错误：\n\n【错误详情】：${args.errorId}\n【判断理由】：${args.reason}\n\n您是否同意将此规则永久加入本地白名单 (.cwtools-ai-memory.md) 以免除后续报错？`
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
        const allowed = await onPermissionRequest(
            permId,
            'remove_ignored_diagnostic',
            `AI 建议从白名单中移除被忽略的报错关键字：\n\n【关键字】：${args.diagnosticKey}\n【判断理由】：${args.reason}\n\n您是否同意将此规则从您的 .vscode 设置中移除，恢复对此关键字的报错提示？`
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
        } catch (e) {
            return { success: false, count: 0, ignoredKeys: [] };
        }
    }

    // ─── webFetch ────────────────────────────────────────────────────────────

    async webFetch(args: { url: string; maxChars?: number }): Promise<{ content: string; url: string; truncated: boolean }> {
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
            let response: Response;
            try {
                response = await fetch(args.url, {
                    headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
                    signal: controller.signal as any
                });
            } finally {
                clearTimeout(timeoutId);
            }
            if (!response.ok) {
                return { content: `HTTP ${response.status}: ${response.statusText}`, url: args.url, truncated: false };
            }

            const contentType = response.headers.get('content-type') ?? '';
            let text = await response.text();

            if (contentType.includes('html')) {
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
        // Safety: deny obviously dangerous commands and pipe/chain operations
        // P2-11 Fix: two-tier filter — destructive commands always blocked; pipe/redirect
        // checked separately with a whitelist for known-safe tools.
        const ALWAYS_BLOCKED = [
            /\brm\s+-rf\b/i, /\bdel\s+\/[fqs]/i, /\bformat\b/i,
            /\brmdir\b.*\/s/i, /\bshutdown\b/i, /\breboot\b/i,
            /\bpowershell\b/i, /\bpwsh\b/i, /\bnode\b\s+-e/i, /\bpython\b\s+-c/i,
            /\bcurl\b.*\|\s*bash/i, /\bwget\b.*\|\s*sh/i,
        ];
        const PIPE_REDIRECT_BLOCKED = [
            /\|/,               // pipe operator
            /&&/,               // command chaining
            /;\s*\S/,           // semicolon followed by next command (allow trailing ;)
            /\d*>{1,2}\s*\S/,   // output redirect (> file, >> file, 2> err)
            /</,                // input redirect
        ];
        // P2-11: Commands that are inherently read-only skip pipe/redirect checks
        // (they still go through the user permission prompt)
        const SAFE_COMMAND_PREFIXES = [
            'git log', 'git status', 'git diff', 'git show', 'git branch',
            'git tag', 'git stash list', 'git remote', 'git rev-parse',
            'dotnet --version', 'dotnet --info', 'node --version',
            'npm list', 'npm ls', 'npm --version', 'npx --version',
            'cat ', 'type ', 'echo ', 'dir ', 'ls ', 'find ', 'grep ',
            'wc ', 'head ', 'tail ', 'which ', 'where ', 'mmx ', 'mmx --version',
        ];
        const cmdLower = args.command.trim().toLowerCase();
        const isSafePrefix = SAFE_COMMAND_PREFIXES.some(p => cmdLower.startsWith(p));

        const bypassSandbox = vs.workspace.getConfiguration('cwtools.ai.developer').get<boolean>('disableSecuritySandbox') === true;
        let escalationReason = '';

        if (!bypassSandbox) {
            let triggeredBlock: RegExp | null = null;
            for (const pat of ALWAYS_BLOCKED) {
                if (pat.test(args.command)) { triggeredBlock = pat; break; }
            }
            if (!triggeredBlock && !isSafePrefix) {
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
            cwd = path.resolve(args.cwd ?? this.ctx.workspaceRoot);
            
            const isWindows = process.platform === 'win32';
            const checkCwd = isWindows ? cwd.toLowerCase() : cwd;
            
            let isWithinWorkspace = false;
            
            const wsRoot = path.resolve(this.ctx.workspaceRoot);
            const checkWsRoot = isWindows ? wsRoot.toLowerCase() : wsRoot;
            if (checkCwd.startsWith(checkWsRoot)) {
                isWithinWorkspace = true;
            }

            const wsFolders = vs.workspace.workspaceFolders;
            if (!isWithinWorkspace && wsFolders) {
                for (const folder of wsFolders) {
                    const folderRoot = path.resolve(folder.uri.fsPath);
                    const checkFolderRoot = isWindows ? folderRoot.toLowerCase() : folderRoot;
                    if (checkCwd.startsWith(checkFolderRoot)) {
                        isWithinWorkspace = true;
                        break;
                    }
                }
            }

            if (!isWithinWorkspace && !bypassSandbox) {
                if (args.requestEscalation) {
                    escalationReason = '工作目录越界访问';
                } else {
                    return { stdout: '', stderr: `Blocked: Working directory must be within the workspace root. If you are ABSOLUTELY sure this is required, you can retry with "requestEscalation": true to ask the user for a one-time privilege override.`, exitCode: 1 };
                }
            }
        } catch (e) {
            return { stdout: '', stderr: `Blocked: Invalid working directory`, exitCode: 1 };
        }

        const requiresPermission = true;
        const onPermissionRequest = context?.onPermissionRequest;

        if (requiresPermission && onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const description = escalationReason 
                ? `⚠️ AI 申请提权越过安全沙盒执行高危操作 (${escalationReason})：${args.command}`
                : `AI 请求执行终端命令：${args.command}`;
            
            const allowed = await onPermissionRequest(
                permId,
                'run_command',
                description,
                args.command
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
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', args.command] : ['-c', args.command];

        let stdoutBuf = '';
        let stderrBuf = '';
        const MAX_OUTPUT = 4000;

        return new Promise(resolve => {
            const proc = spawn(shell, shellArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

            const timer = setTimeout(() => {
                proc.kill();
                resolve({
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
            });

            proc.on('close', code => {
                clearTimeout(timer);
                resolve({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT),
                    stderr: stderrBuf.substring(0, 2000),
                    exitCode: code ?? 0,
                });
            });

            proc.on('error', err => {
                clearTimeout(timer);
                resolve({
                    stdout: stdoutBuf.substring(0, MAX_OUTPUT),
                    stderr: `spawn error: ${err.message}`,
                    exitCode: 1,
                });
            });
        });
    }

    // ─── searchWeb ───────────────────────────────────────────────────────────

    async searchWeb(args: { query: string; maxResults?: number }): Promise<{
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
            let resp: Response;
            try {
                resp = await fetch(ddgUrl, {
                    headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
                    signal: controller.signal as any
                });
            } finally {
                clearTimeout(timeoutId);
            }
            const html = await resp.text();

            const results: Array<{ title: string; url: string; description: string }> = [];
            const linkRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
            const snippetRe = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/gi;
            const links: Array<{ url: string; title: string }> = [];
            const snippets: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = linkRe.exec(html)) !== null && links.length < maxResults) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                let url = m[1]!;
                if (url.startsWith('/l/?uddg=')) {
                    try { url = decodeURIComponent(url.replace('/l/?uddg=', '')); } catch { /* keep */ }
                }
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                links.push({ url, title: m[2]!.trim() });
            }
            while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                snippets.push(m[1]!.trim());
            }
            for (let i = 0; i < links.length; i++) {
                results.push({
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    title: links[i]!.title,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    url: links[i]!.url,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    description: snippets[i]! ?? '',
                });
            }
            return { results, source: 'duckduckgo', query };
        } catch (e) {
            return { results: [], source: 'duckduckgo', query };
        }
    }

    // ─── searchCode ────────────────────────────────────────────────────────────

    async searchCode(args: { query: string; maxResults?: number }): Promise<{
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
        const webResult = await this.searchWeb({ query: codeQuery, maxResults });
        return { ...webResult, source: 'brave' as const, query };
    }


    // ─── MiniMax CLI Media Generation Tools ─────────────────────────────

    /** Cached result of mmx CLI availability check (null = not checked yet) */
    private mmxAvailable: boolean | null = null;

    /** Check if mmx CLI is installed and accessible. Caches result for the session. */
    private async ensureMmxAvailable(): Promise<boolean> {
        if (this.mmxAvailable !== null) return this.mmxAvailable;
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            await execAsync('mmx --version', { timeout: 10000 });
            this.mmxAvailable = true;
        } catch {
            this.mmxAvailable = false;
        }
        return this.mmxAvailable;
    }

    /** Ensure the media output directory exists and return its path. */
    private async getMediaOutputDir(): Promise<string> {
        const mediaDir = path.join(this.ctx.workspaceRoot, '.cwtools-ai', 'media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }
        return mediaDir;
    }

    /** Execute an mmx command with permission gating and streaming output. */
    private async execMmx(
        toolLabel: string,
        command: string,
        timeoutMs: number = 120000,
        context?: import('../types').AgentToolContext
    ): Promise<{ success: boolean; stdout: string; stderr: string; message: string }> {
        if (!(await this.ensureMmxAvailable())) {
            return {
                success: false, stdout: '', stderr: '',
                message: 'MiniMax CLI (mmx) is not installed. Please run `npm install -g mmx-cli` and `mmx auth login --api-key <key>` first.'
            };
        }

        const onPermissionRequest = context?.onPermissionRequest;
        // Request user permission
        if (onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const allowed = await onPermissionRequest(
                permId,
                toolLabel,
                `AI 请求使用 MiniMax CLI 执行媒体生成：\n\n${command}`,
                command
            );
            if (!allowed) {
                return { success: false, stdout: '', stderr: '', message: '用户拒绝了此媒体生成请求。' };
            }
        }

        const onStep = context?.onStep;
        onStep?.({
            type: 'thinking',
            content: `[MiniMax CLI] Executing: ${command.substring(0, 200)}...`,
            timestamp: Date.now(),
        });

        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            const { stdout, stderr } = await execAsync(command, {
                timeout: timeoutMs,
                cwd: this.ctx.workspaceRoot,
            });

            onStep?.({
                type: 'thinking',
                content: `[MiniMax CLI] Completed: ${stdout.trim().substring(0, 300)}`,
                timestamp: Date.now(),
            });

            return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), message: 'OK' };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return { success: false, stdout: '', stderr: errMsg, message: `MiniMax CLI execution failed: ${errMsg}` };
        }
    }

    // ─── mmx_generate_image ─────────────────────────────────────────────

    async mmxGenerateImage(args: {
        prompt: string;
        aspectRatio?: string;
        count?: number;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; files?: string[] }> {
        const outDir = await this.getMediaOutputDir();
        const timestamp = Date.now();
        const outPath = path.join(outDir, `image_${timestamp}`);

        let cmd = `mmx image generate --prompt "${args.prompt.replace(/"/g, '\\"')}" --non-interactive --no-color --out-dir "${outPath}"`;
        if (args.aspectRatio) cmd += ` --aspect-ratio ${args.aspectRatio}`;
        if (args.count && args.count > 1) cmd += ` --n ${Math.min(args.count, 4)}`;

        const result = await this.execMmx('mmx_generate_image', cmd, 120000, context);
        if (!result.success) return { success: false, message: result.message };

        // Collect generated files
        const files: string[] = [];
        if (fs.existsSync(outPath)) {
            const entries = fs.readdirSync(outPath);
            for (const entry of entries) {
                files.push(path.join(outPath, entry));
            }
        }

        return {
            success: true,
            message: `Generated ${files.length} image(s) in ${outPath}`,
            files,
        };
    }

    // ─── mmx_generate_video ─────────────────────────────────────────────

    async mmxGenerateVideo(args: {
        prompt: string;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; file?: string }> {
        const outDir = await this.getMediaOutputDir();
        const timestamp = Date.now();
        const outFile = path.join(outDir, `video_${timestamp}.mp4`);

        const cmd = `mmx video generate --prompt "${args.prompt.replace(/"/g, '\\"')}" --non-interactive --no-color --download "${outFile}"`;

        const result = await this.execMmx('mmx_generate_video', cmd, 300000, context);
        if (!result.success) return { success: false, message: result.message };

        return {
            success: true,
            message: `Video generated: ${outFile}`,
            file: fs.existsSync(outFile) ? outFile : undefined,
        };
    }

    // ─── mmx_generate_music ─────────────────────────────────────────────

    async mmxGenerateMusic(args: {
        prompt: string;
        lyrics?: string;
        instrumental?: boolean;
        lyricsOptimizer?: boolean;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; file?: string }> {
        const outDir = await this.getMediaOutputDir();
        const timestamp = Date.now();
        const outFile = path.join(outDir, `music_${timestamp}.mp3`);

        let cmd = `mmx music generate --prompt "${args.prompt.replace(/"/g, '\\"')}" --non-interactive --no-color --out "${outFile}"`;
        if (args.lyrics) cmd += ` --lyrics "${args.lyrics.replace(/"/g, '\\"')}"`;
        if (args.instrumental) cmd += ' --instrumental';
        if (args.lyricsOptimizer) cmd += ' --lyrics-optimizer';

        const result = await this.execMmx('mmx_generate_music', cmd, 300000, context);
        if (!result.success) return { success: false, message: result.message };

        return {
            success: true,
            message: `Music generated: ${outFile}`,
            file: fs.existsSync(outFile) ? outFile : undefined,
        };
    }

    // ─── mmx_generate_speech ────────────────────────────────────────────

    async mmxGenerateSpeech(args: {
        text: string;
        voice?: string;
        speed?: number;
    }, context?: import('../types').AgentToolContext): Promise<{ success: boolean; message: string; file?: string }> {
        const outDir = await this.getMediaOutputDir();
        const timestamp = Date.now();
        const outFile = path.join(outDir, `speech_${timestamp}.mp3`);

        let cmd = `mmx speech synthesize --text "${args.text.replace(/"/g, '\\"')}" --non-interactive --no-color --out "${outFile}"`;
        if (args.voice) cmd += ` --voice ${args.voice}`;
        if (args.speed && args.speed !== 1.0) cmd += ` --speed ${args.speed}`;

        const result = await this.execMmx('mmx_generate_speech', cmd, 60000, context);
        if (!result.success) return { success: false, message: result.message };

        return {
            success: true,
            message: `Speech generated: ${outFile}`,
            file: fs.existsSync(outFile) ? outFile : undefined,
        };
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
    }): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureImageMagickAvailable())) {
            return {
                success: false,
                message: `ImageMagick is not installed or not found at "${this.getImageMagickBin()}". Please install ImageMagick (https://imagemagick.org/) and ensure it is in your PATH, or set the custom path in cwtools.ai.imageMagickPath.`,
            };
        }

        if (!fs.existsSync(args.sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? (path.isAbsolute(args.outputDir) ? args.outputDir : path.join(this.ctx.workspaceRoot, args.outputDir))
            : path.dirname(args.sourcePath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Build output filename: same basename, .dds extension
        const baseName = path.basename(args.sourcePath, path.extname(args.sourcePath));
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

        const cmd = `${magickBin} convert "${args.sourcePath}" ${ddsDefines} "${outFile}"`;

        const result = await this.execMmx('convert_image_to_dds', cmd, 60000);
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
    }): Promise<{ success: boolean; message: string; outputFile?: string }> {
        if (!(await this.ensureFfmpegAvailable())) {
            return {
                success: false,
                message: `ffmpeg is not installed or not found at "${this.getFfmpegBin()}". Please install ffmpeg (https://ffmpeg.org/) and ensure it is in your PATH, or set the custom path in cwtools.ai.ffmpegPath.`,
            };
        }

        if (!fs.existsSync(args.sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Resolve output directory
        const outDir = args.outputDir
            ? (path.isAbsolute(args.outputDir) ? args.outputDir : path.join(this.ctx.workspaceRoot, args.outputDir))
            : path.dirname(args.sourcePath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const baseName = path.basename(args.sourcePath, path.extname(args.sourcePath));
        const outFile = path.join(outDir, `${baseName}.${args.targetFormat}`);
        const ffmpegBin = this.getFfmpegBin();

        // Build ffmpeg command based on target format
        let cmd: string;
        if (args.targetFormat === 'ogg') {
            // Vorbis encoding, quality 4 (~128kbps)
            cmd = `${ffmpegBin} -y -i "${args.sourcePath}" -c:a libvorbis -q:a 4`;
        } else {
            // WAV: 16-bit PCM, default 44100 Hz
            const sr = args.sampleRate ?? 44100;
            cmd = `${ffmpegBin} -y -i "${args.sourcePath}" -acodec pcm_s16le -ar ${sr}`;
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

        const result = await this.execMmx('convert_audio', cmd, 60000);
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
        if (!fs.existsSync(args.sourcePath)) {
            return { success: false, message: `Source file not found: ${args.sourcePath}` };
        }

        // Compute absolute target path
        const targetPath = path.join(this.ctx.workspaceRoot, args.targetRelativePath);
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
            const allowed = await onPermissionRequest(
                permId,
                'deploy_mod_asset',
                `AI 请求将媒体资产部署到 Mod 工作区：\n\n【源文件】：${args.sourcePath}\n【目标位置】：${args.targetRelativePath}\n【覆盖现有】：${args.overwrite ? '是' : '否'}`,
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
            fs.copyFileSync(args.sourcePath, targetPath);

            const onStep = context?.onStep;
            onStep?.({
                type: 'thinking',
                content: `[Deploy] ${path.basename(args.sourcePath)} → ${args.targetRelativePath}`,
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
