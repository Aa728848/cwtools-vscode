/**
 * External Tool Handler — web fetch, web search, shell commands,
 * TODO list management, and sub-agent dispatch.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TodoItem, TodoWriteResult } from '../types';

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties ExternalToolHandler reads from the executor. */
export interface ExternalToolContext {
    readonly workspaceRoot: string;
    onPermissionRequest?: (
        id: string,
        tool: string,
        description: string,
        command?: string
    ) => Promise<boolean>;
    onTodoUpdate?: (todos: TodoItem[]) => void;
    /** Step callback for real-time UI progress (shared with AgentToolExecutor) */
    onStep?: (step: import('../types').AgentStep) => void;
    agentRunnerRef?: {
        runSubAgent(
            prompt: string,
            mode: 'explore' | 'general' | 'build' | 'review' | 'gui_expert' | 'script_reviewer',
            parentOptions?: import('../agentRunner').AgentRunnerOptions,
            onStep?: (step: import('../types').AgentStep) => void,
            parentAccumulator?: import('../types').TokenUsage,
            onFileWrite?: (filePath: string, prevContent: string | null) => void,
            parentContextHint?: string,
        ): Promise<string>;
        pendingTransactions: Map<string, Map<string, string>>;
    };
    parentRunnerOptions?: import('../agentRunner').AgentRunnerOptions;
    parentTokenAccumulator?: import('../types').TokenUsage;
    /** C5: File write hook for sub-agent isolation (mirrors FileToolContext.onBeforeFileWrite) */
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    suspendLsp?: () => void;
    resumeLsp?: () => void;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class ExternalToolHandler {
    private currentTodos: TodoItem[] = [];

    constructor(private ctx: ExternalToolContext) {}

    // ─── todoWrite ───────────────────────────────────────────────────────────

    async todoWrite(args: { todos: TodoItem[] }): Promise<TodoWriteResult> {
        this.currentTodos = args.todos;
        this.ctx.onTodoUpdate?.(this.currentTodos);
        return {
            success: true,
            todoCount: this.currentTodos.length,
        };
    }

    getTodos(): TodoItem[] { return [...this.currentTodos]; }
    clearTodos(): void { this.currentTodos = []; }

    // ─── ignoreValidationError ───────────────────────────────────────────────

    async ignoreValidationError(args: { errorId: string; reason: string }): Promise<{ success: boolean; message: string }> {
        if (!this.ctx.onPermissionRequest) {
            return { success: false, message: 'Permission handler not configured. Cannot ignore validation errors.' };
        }

        const permId = `perm_${Date.now()}`;
        const allowed = await this.ctx.onPermissionRequest(
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
            const response = await fetch(args.url, {
                headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
            });
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

    async runCommand(args: { command: string; cwd?: string; timeoutMs?: number }): Promise<{
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
            'wc ', 'head ', 'tail ', 'which ', 'where ',
        ];
        const cmdLower = args.command.trim().toLowerCase();
        const isSafePrefix = SAFE_COMMAND_PREFIXES.some(p => cmdLower.startsWith(p));

        const bypassSandbox = vs.workspace.getConfiguration('cwtools.ai.developer').get<boolean>('disableSecuritySandbox') === true;

        if (!bypassSandbox) {
            for (const pat of ALWAYS_BLOCKED) {
                if (pat.test(args.command)) {
                    return { stdout: '', stderr: `Blocked: Command execution prohibited due to matching safety pattern (${pat.source}). Please use built-in tools instead of generic shell pipes/chains.`, exitCode: 1 };
                }
            }
            if (!isSafePrefix) {
                for (const pat of PIPE_REDIRECT_BLOCKED) {
                    if (pat.test(args.command)) {
                        return { stdout: '', stderr: `Blocked: Command execution prohibited due to matching safety pattern (${pat.source}). Please use built-in tools instead of generic shell pipes/chains.`, exitCode: 1 };
                    }
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
                return { stdout: '', stderr: `Blocked: Working directory must be within the workspace root`, exitCode: 1 };
            }
        } catch (e) {
            return { stdout: '', stderr: `Blocked: Invalid working directory`, exitCode: 1 };
        }

        if (this.ctx.onPermissionRequest) {
            const permId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const allowed = await this.ctx.onPermissionRequest(
                permId,
                'run_command',
                `AI 请求执行终端命令：${args.command}`,
                args.command
            );
            if (!allowed) {
                return { stdout: '', stderr: '用户拒绝了此命令的执行权限', exitCode: 1 };
            }
        } else {
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
                this.ctx.onStep?.({
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
                const resp = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Encoding': 'gzip',
                        'X-Subscription-Token': braveKey,
                    },
                });
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
            const resp = await fetch(ddgUrl, {
                headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
            });
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
                const resp = await fetch('https://api.exa.ai/search', {
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
                });
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

    // ─── spawnSubAgents ──────────────────────────────────────────────────────

    async spawnSubAgents(args: import('../types').SpawnSubAgentsArgs): Promise<import('../types').SpawnSubAgentsResult> {
        if (!this.ctx.agentRunnerRef) {
            return {
                results: [{
                    description: args.description || 'Unknown task',
                    result: 'Sub-agent dispatch not available: agentRunnerRef not set',
                }]
            };
        }

        const taskList = args.tasks && Array.isArray(args.tasks) ? args.tasks : [];
        if (taskList.length === 0 && args.prompt && args.description) {
            taskList.push({
                id: `task_${Date.now()}`,
                description: args.description,
                prompt: args.prompt,
                subagent_type: args.subagent_type || 'general'
            });
        }

        if (taskList.length === 0) {
            return { results: [{ description: 'Error', result: 'No tasks provided' }] };
        }

        // Limit to max 5 parallel tasks for DAG
        const tasksToRun = taskList.slice(0, 5);
        const globalSnapshots: Array<{ filePath: string; previousContent: string | null }> = [];

        this.ctx.suspendLsp?.();

        const vfsOverlay = new Map<string, string>();
        const subAgentOptions = { ...this.ctx.parentRunnerOptions, vfsOverlay };

        // Build a lightweight parent context hint so sub-agents don't start from scratch.
        // Includes sibling task descriptions and workspace root for file awareness.
        const siblingDescs = taskList.map((t: any) => `- ${t.description ?? '(no description)'}`).join('\n');
        const parentContextHint = [
            `Workspace: ${this.ctx.workspaceRoot}`,
            siblingDescs ? `Sibling tasks:\n${siblingDescs}` : null,
        ].filter(Boolean).join('\n');

        try {
            const executeTask = async (task: any, idx: number) => {
                const mode = (task.subagent_type ?? 'build') as 'explore' | 'general' | 'build' | 'review' | 'gui_expert' | 'script_reviewer';
                this.ctx.onStep?.({
                    type: 'subtask_start',
                    content: `Sub-task ${idx + 1}/${tasksToRun.length}: ${task.description}`,
                    subagentType: mode,
                    timestamp: Date.now(),
                });

                let lastError = '';
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const modifiedPrompt = task.prompt + (attempt > 1 ? `\n\n[System] Previous attempt failed with error: ${lastError}. Please fix the issue and try again.` : '');
                        const runPromise = this.ctx.agentRunnerRef!.runSubAgent(
                            modifiedPrompt,
                            mode,
                            subAgentOptions,
                            () => { /* no-op */ },
                            this.ctx.parentTokenAccumulator,
                            (filePath, prevContent) => {
                                if (!globalSnapshots.some(s => s.filePath === filePath)) {
                                    globalSnapshots.push({ filePath, previousContent: prevContent });
                                }
                                this.ctx.onBeforeFileWrite?.(filePath, prevContent);
                            },
                            parentContextHint
                        );

                        let r: string;
                        if (task.deadlineMs && task.deadlineMs > 0) {
                            r = await Promise.race([
                                runPromise,
                                new Promise<string>((_, reject) =>
                                    setTimeout(() => reject(new Error(`TIMEOUT:${task.deadlineMs}`)), task.deadlineMs)
                                ),
                            ]);
                        } else {
                            r = await runPromise;
                        }

                        this.ctx.onStep?.({
                            type: 'subtask_complete',
                            content: `✓ ${task.description}`,
                            subagentType: mode,
                            timestamp: Date.now(),
                        });

                        return { description: task.description, result: r };
                    } catch (e) {
                        lastError = e instanceof Error ? e.message : String(e);
                        // Timeout: return partial result immediately, don't retry
                        if (lastError.startsWith('TIMEOUT:')) {
                            const ms = parseInt(lastError.slice(8), 10) || 0;
                            this.ctx.onStep?.({
                                type: 'subtask_complete',
                                content: `⏱ ${task.description} (超时截断, ${ms}ms)`,
                                subagentType: mode,
                                timestamp: Date.now(),
                            });
                            return { description: task.description, result: `(超时截断: ${ms}ms) 子任务在截止时间前未完成。` };
                        }
                        if (attempt === 2) {
                            this.ctx.onStep?.({
                                type: 'subtask_complete',
                                content: `✗ ${task.description}: ${lastError} (Failed after retry)`,
                                subagentType: mode,
                                timestamp: Date.now(),
                            });
                            throw e; // Propagate to DAG handler
                        } else {
                            this.ctx.onStep?.({
                                type: 'thinking',
                                content: `Subtask failed (${lastError}), retrying 1/2...`,
                                timestamp: Date.now()
                            });
                        }
                    }
                }
                throw new Error('Unreachable');
            };

            let completed: Array<{ description: string; result: string }> = [];

            if (args.sequential) {
                // Execute sequentially
                for (let i = 0; i < tasksToRun.length; i++) {
                    completed.push(await executeTask(tasksToRun[i], i));
                }
            } else {
                // Topological DAG Runner
                const taskMap = new Map<string, any>();
                const inDegree = new Map<string, number>();
                const adj = new Map<string, string[]>();

                tasksToRun.forEach(t => {
                    const id = (t as any).id || Math.random().toString(36).substring(7);
                    (t as any)._id = id;
                    taskMap.set(id, t);
                    inDegree.set(id, 0);
                    if (!adj.has(id)) adj.set(id, []);
                });

                tasksToRun.forEach(t => {
                    const id = (t as any)._id;
                    if (t.dependsOn && Array.isArray(t.dependsOn)) {
                        t.dependsOn.forEach((dep: string) => {
                            if (taskMap.has(dep)) {
                                if (!adj.has(dep)) adj.set(dep, []);
                                adj.get(dep)!.push(id);
                                inDegree.set(id, (inDegree.get(id) || 0) + 1);
                            }
                        });
                    }
                });

                await new Promise<void>((resolve, reject) => {
                    const running = new Set<string>();
                    
                    const checkQueue = () => {
                        if (taskMap.size === 0 && running.size === 0) {
                            resolve();
                            return;
                        }
                        
                        for (const [id, t] of taskMap.entries()) {
                            if (inDegree.get(id) === 0 && !running.has(id)) {
                                running.add(id);
                                taskMap.delete(id); // remove from pending
                                
                                executeTask(t, completed.length).then((res) => {
                                    completed.push(res);
                                    running.delete(id);
                                    for (const dependent of adj.get(id) || []) {
                                        inDegree.set(dependent, inDegree.get(dependent)! - 1);
                                    }
                                    checkQueue();
                                }).catch(err => {
                                    // Partial Success: Log failure, cascade-drop dependents, continue independent branches
                                    const errMsg = err instanceof Error ? err.message : String(err);
                                    completed.push({ description: t.description, result: `FAILED: ${errMsg}` });
                                    running.delete(id);
                                    
                                    const dropQueue = [...(adj.get(id) || [])];
                                    while (dropQueue.length > 0) {
                                        const dropId = dropQueue.shift()!;
                                        if (taskMap.has(dropId)) {
                                            const dt = taskMap.get(dropId);
                                            completed.push({ description: dt.description, result: `SKIPPED: Dependency failed` });
                                            taskMap.delete(dropId);
                                            dropQueue.push(...(adj.get(dropId) || []));
                                        }
                                    }
                                    checkQueue();
                                });
                            }
                        }
                    };
                    checkQueue();
                });
            }

            // At the end, if there are files in vfsOverlay, we emit a batch request
            if (vfsOverlay.size > 0) {
                const filesRequested = Array.from(vfsOverlay.keys());
                const txId = `tx_${Date.now()}`;
                
                this.ctx.onStep?.({
                    type: 'thinking',
                    content: `Batching ${filesRequested.length} file modifications for human review...`,
                    timestamp: Date.now(),
                    transactionCard: {
                        id: txId,
                        filesRequested,
                        status: 'pending'
                    }
                });
                
                this.ctx.agentRunnerRef!.pendingTransactions.set(txId, vfsOverlay);
                
                completed.push({
                    description: 'Transaction Batch Emit',
                    result: `Emitted transaction ${txId} with ${filesRequested.length} files. Awaiting user approval.`
                });
            }

            this.ctx.resumeLsp?.();
            return { results: completed };

        } catch (e) {
            // Transactional Rollback is practically instantaneous because writes were memory-bound
            vfsOverlay.clear();
            
            this.ctx.resumeLsp?.();
            const actualError = e instanceof Error ? e.message : String(e);
            return {
                results: [{
                    description: 'Transaction Rollback',
                    result: `Dispatch failed: ${actualError}. Memory batch dropped.`,
                }]
            };
        }
    }
}
