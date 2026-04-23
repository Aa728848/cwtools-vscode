/**
 * External Tool Handler — web fetch, web search, shell commands,
 * TODO list management, and sub-agent dispatch.
 */

import * as vs from 'vscode';
import * as path from 'path';
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
            mode: 'explore' | 'general',
            parentOptions?: import('../agentRunner').AgentRunnerOptions,
            onStep?: (step: import('../types').AgentStep) => void,
            parentAccumulator?: import('../types').TokenUsage
        ): Promise<string>;
    };
    parentRunnerOptions?: import('../agentRunner').AgentRunnerOptions;
    parentTokenAccumulator?: import('../types').TokenUsage;
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

    // ─── webFetch ────────────────────────────────────────────────────────────

    async webFetch(args: { url: string; maxChars?: number }): Promise<{ content: string; url: string; truncated: boolean }> {
        const maxChars = Math.min(args.maxChars ?? 8000, 16000);

        if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
            return { content: 'Error: only http/https URLs are supported', url: args.url, truncated: false };
        }

        try {
            const urlObj = new URL(args.url);
            const host = urlObj.hostname;
            const isLocalIPv4 = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(host);
            const isLocalIPv6 = /^(::1|fd[0-9a-f]{2}:.+|fe80::.+)$/i.test(host);
            
            if (host === 'localhost' || isLocalIPv4 || isLocalIPv6 || host.endsWith('.local')) {
                return { content: 'Error: Access to local/internal network addresses is prohibited for security reasons.', url: args.url, truncated: false };
            }
        } catch (e) {
            return { content: 'Error: Invalid URL format', url: args.url, truncated: false };
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
        // Safety: deny obviously dangerous commands and pipe operations
        const BLOCKED_PATTERNS = [
            /\brm\s+-rf\b/i, /\bdel\s+\/[fqs]/i, /\bformat\b/i,
            /\brmdir\b.*\/s/i, /\bshutdown\b/i, /\breboot\b/i,
            /\bpowershell\b/i, /\bpwsh\b/i, /\bnode\b\s+-e/i, /\bpython\b\s+-c/i,
            /\bcurl\b.*\|\s*bash/i, /\bwget\b.*\|\s*sh/i,
            /\|/, /&&/, /;/, />/, /</ // Prevent command chaining and piping
        ];
        for (const pat of BLOCKED_PATTERNS) {
            if (pat.test(args.command)) {
                return { stdout: '', stderr: `Blocked: Command execution prohibited due to matching safety pattern (${pat.source}). Please use built-in tools instead of generic shell pipes/chains.`, exitCode: 1 };
            }
        }

        let cwd: string;
        try {
            cwd = path.resolve(args.cwd ?? this.ctx.workspaceRoot);
            const wsRoot = path.resolve(this.ctx.workspaceRoot);
            if (!cwd.startsWith(wsRoot)) {
                return { stdout: '', stderr: `Blocked: Working directory must be within the workspace root`, exitCode: 1 };
            }
        } catch (e) {
            return { stdout: '', stderr: `Blocked: Invalid working directory`, exitCode: 1 };
        }

        if (this.ctx.onPermissionRequest) {
            const permId = `perm_${Date.now()}`;
            const allowed = await this.ctx.onPermissionRequest(
                permId,
                'run_command',
                `AI wants to run: ${args.command}`,
                args.command
            );
            if (!allowed) {
                return { stdout: '', stderr: '用户拒绝了此命令的执行权限', exitCode: 1 };
            }
        } else {
            return { stdout: '', stderr: 'run_command: no permission handler configured', exitCode: 1 };
        }

        const timeoutMs = Math.min(args.timeoutMs ?? 15000, 60000);
        const { exec } = await import('child_process');

        return new Promise(resolve => {
            const _proc = exec(
                args.command,
                { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    resolve({
                        stdout: stdout.substring(0, 4000),
                        stderr: stderr.substring(0, 2000),
                        exitCode: error?.code ?? 0,
                        timedOut: error?.signal === 'SIGTERM',
                    });
                }
            );
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
                let url = m[1];
                if (url.startsWith('/l/?uddg=')) {
                    try { url = decodeURIComponent(url.replace('/l/?uddg=', '')); } catch { /* keep */ }
                }
                links.push({ url, title: m[2].trim() });
            }
            while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
                snippets.push(m[1].trim());
            }
            for (let i = 0; i < links.length; i++) {
                results.push({
                    title: links[i].title,
                    url: links[i].url,
                    description: snippets[i] ?? '',
                });
            }
            return { results, source: 'duckduckgo', query };
        } catch (e) {
            return { results: [], source: 'duckduckgo', query };
        }
    }

    // ─── dispatchSubTask ─────────────────────────────────────────────────────

    async dispatchSubTask(args: import('../types').TaskArgs): Promise<import('../types').TaskResult> {
        if (!this.ctx.agentRunnerRef) {
            return {
                results: [{
                    description: args.description || 'Unknown task',
                    result: 'Sub-agent dispatch not available: agentRunnerRef not set',
                }]
            };
        }

        const taskList = args.tasks && Array.isArray(args.tasks) ? args.tasks : [];
        // Legacy single task fallback
        if (taskList.length === 0 && args.prompt && args.description) {
            taskList.push({
                description: args.description,
                prompt: args.prompt,
                subagent_type: args.subagent_type || 'general'
            });
        }

        if (taskList.length === 0) {
            return { results: [{ description: 'Error', result: 'No tasks provided' }] };
        }

        // Limit to max 3 parallel tasks
        const tasksToRun = taskList.slice(0, 3);
        
        try {
            const promises = tasksToRun.map(async (task, idx) => {
                const mode = (task.subagent_type ?? 'general') as 'explore' | 'general';
                // Emit subtask_start for UI progress visualization
                this.ctx.onStep?.({
                    type: 'subtask_start',
                    content: `Sub-task ${idx + 1}/${tasksToRun.length}: ${task.description}`,
                    subagentType: mode,
                    timestamp: Date.now(),
                });
                try {
                    const result = await this.ctx.agentRunnerRef!.runSubAgent(
                        task.prompt,
                        mode,
                        this.ctx.parentRunnerOptions,
                        undefined,
                        this.ctx.parentTokenAccumulator
                    );
                    // Emit subtask_complete for UI
                    this.ctx.onStep?.({
                        type: 'subtask_complete',
                        content: `✓ ${task.description}`,
                        subagentType: mode,
                        timestamp: Date.now(),
                    });
                    return { description: task.description, result };
                } catch (e) {
                    this.ctx.onStep?.({
                        type: 'subtask_complete',
                        content: `✗ ${task.description}: ${e instanceof Error ? e.message : String(e)}`,
                        subagentType: mode,
                        timestamp: Date.now(),
                    });
                    return {
                        description: task.description,
                        result: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`,
                    };
                }
            });

            const completed = await Promise.all(promises);
            return { results: completed };
        } catch (e) {
            return {
                results: [{
                    description: 'Global task error',
                    result: `Dispatch failed: ${e instanceof Error ? e.message : String(e)}`,
                }]
            };
        }
    }
}
