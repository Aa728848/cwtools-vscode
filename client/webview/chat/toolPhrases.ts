/**
 * Tool Phrases — PDX-specialised human-readable labels and category mapping
 *
 * Each tool is assigned a semantic category and a short phrase.
 * `groupToolCalls` groups consecutive tool calls by category and produces
 * a summary label for collapsed rendering in the message timeline.
 *
 * @module toolPhrases
 */

import type { RendererStep } from '../messageRenderer';

// ── Category ─────────────────────────────────────────────────────────────────

export type ToolCategory = 'read' | 'write' | 'query' | 'validate' | 'execute' | 'orchestrate' | 'other';

export interface ToolPhraseMeta {
    category: ToolCategory;
    /** Emoji icon for the group summary. */
    icon: string;
    /** Human-readable verb phrase (Chinese). */
    phrase: string;
}

// ── Phrase registry ──────────────────────────────────────────────────────────

const TOOL_PHRASES: Record<string, ToolPhraseMeta> = {
    // Read
    read_file:                 { category: 'read',        icon: '📖', phrase: '读取文件' },
    get_file_context:          { category: 'read',        icon: '📖', phrase: '获取文件上下文' },
    get_pdx_block:             { category: 'read',        icon: '📖', phrase: '提取脚本块' },
    list_directory:            { category: 'read',        icon: '📖', phrase: '列出目录' },
    glob_files:                { category: 'read',        icon: '📖', phrase: '搜索文件' },
    search_mod_files:          { category: 'read',        icon: '📖', phrase: '搜索 Mod 文件' },
    codesearch:                { category: 'read',        icon: '📖', phrase: '代码搜索' },

    // Write
    edit_file:                 { category: 'write',       icon: '✏️', phrase: '编辑文件' },
    multiedit:                 { category: 'write',       icon: '✏️', phrase: '多处编辑' },
    write_file:                { category: 'write',       icon: '✏️', phrase: '写入文件' },
    create_file:               { category: 'write',       icon: '✏️', phrase: '创建文件' },
    apply_patch:               { category: 'write',       icon: '✏️', phrase: '应用补丁' },
    delete_file:               { category: 'write',       icon: '✏️', phrase: '删除文件' },
    write_localisation:        { category: 'write',       icon: '✏️', phrase: '写入本地化' },
    save_workflow:             { category: 'write',       icon: '✏️', phrase: '保存工作流' },
    todo_write:                { category: 'write',       icon: '✏️', phrase: '更新待办' },

    // Query
    query_workspace_index:     { category: 'query',       icon: '🔍', phrase: '搜索符号索引' },
    query_localisation_index:  { category: 'query',       icon: '🔍', phrase: '搜索本地化' },
    document_symbols:          { category: 'query',       icon: '🔍', phrase: '获取文档符号' },
    workspace_symbols:         { category: 'query',       icon: '🔍', phrase: '搜索工作区符号' },
    query_scope:               { category: 'query',       icon: '🔍', phrase: '查询作用域' },
    query_types:               { category: 'query',       icon: '🔍', phrase: '查询类型' },
    query_rules:               { category: 'query',       icon: '🔍', phrase: '查询规则' },
    query_references:          { category: 'query',       icon: '🔍', phrase: '查询引用' },
    query_blackboard:          { category: 'query',       icon: '🔍', phrase: '查询黑板' },
    search_web:                { category: 'query',       icon: '🔍', phrase: '搜索网页' },
    web_fetch:                 { category: 'query',       icon: '🔍', phrase: '抓取网页' },
    get_completion_at:          { category: 'query',       icon: '🔍', phrase: '获取补全' },

    // Validate
    get_diagnostics:           { category: 'validate',    icon: '🩺', phrase: '获取诊断' },
    validate_code:             { category: 'validate',    icon: '🩺', phrase: '验证代码' },

    // Execute
    run_command:               { category: 'execute',     icon: '⚡', phrase: '执行命令' },

    // Orchestrate
    dispatch_agents:           { category: 'orchestrate', icon: '🎯', phrase: '分派子任务' },
    merge_results:             { category: 'orchestrate', icon: '🎯', phrase: '合并结果' },
};

/** Look up the phrase meta for a tool name, falling back to a generic entry. */
export function getToolPhrase(toolName: string): ToolPhraseMeta {
    return TOOL_PHRASES[toolName] ?? { category: 'other', icon: '⚙', phrase: toolName };
}

// ── Dynamic phrase (parameter-aware, dual-state) ─────────────────────────────

/**
 * A context-aware phrase pair for rendering tool calls.
 * `label` is shown after completion; `loadingLabel` during streaming.
 */
export interface ToolDynamicPhrase {
    /** 完成态短语: "读取 bar.ts 第 10-60 行" */
    label: string;
    /** 进行时态短语: "正在读取 bar.ts..." */
    loadingLabel: string;
}

/** Extract basename from a file path. */
function basename(path: string): string {
    return (path || '').replace(/\\/g, '/').split('/').pop() || path;
}

/** Truncate text to a max length. */
function truncateStr(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Build a dual-state phrase pair from a label. */
function dualPhrase(label: string): ToolDynamicPhrase {
    return { label, loadingLabel: `正在${label}...` };
}

/**
 * Generate a context-aware dynamic phrase from tool name and arguments.
 * Falls back to the static phrase registry if no args are available.
 */
export function getToolDynamicPhrase(
    toolName: string,
    toolArgs?: Record<string, unknown>,
): ToolDynamicPhrase {
    const args = toolArgs || {};
    const meta = getToolPhrase(toolName);

    switch (toolName) {
        case 'read_file': {
            const fp = args.AbsolutePath ?? args.file_path ?? args.filePath;
            if (typeof fp === 'string') {
                const name = basename(fp);
                const start = typeof args.StartLine === 'number' ? args.StartLine : undefined;
                const end = typeof args.EndLine === 'number' ? args.EndLine : undefined;
                if (start != null && end != null) return dualPhrase(`读取 ${name} 第 ${start}-${end} 行`);
                if (start != null) return dualPhrase(`读取 ${name} 从第 ${start} 行`);
                return dualPhrase(`读取 ${name}`);
            }
            return dualPhrase(meta.phrase);
        }
        case 'edit_file':
        case 'multiedit': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : '文件';
            return dualPhrase(`编辑 ${name}`);
        }
        case 'write_file':
        case 'create_file': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : '文件';
            return dualPhrase(`写入 ${name}`);
        }
        case 'delete_file': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : '文件';
            return dualPhrase(`删除 ${name}`);
        }
        case 'run_command': {
            const cmd = args.CommandLine ?? args.command;
            if (typeof cmd === 'string') return dualPhrase(`执行 ${truncateStr(cmd, 80)}`);
            return dualPhrase(meta.phrase);
        }
        case 'list_directory': {
            const dp = args.DirectoryPath ?? args.path;
            if (typeof dp === 'string') return dualPhrase(`列出 ${basename(dp)}/`);
            return dualPhrase(meta.phrase);
        }
        case 'glob_files':
        case 'search_mod_files': {
            const pattern = args.Pattern ?? args.pattern ?? args.query;
            if (typeof pattern === 'string') return dualPhrase(`搜索文件 ${truncateStr(pattern, 60)}`);
            return dualPhrase(meta.phrase);
        }
        case 'codesearch': {
            const query = args.Query ?? args.query ?? args.pattern;
            if (typeof query === 'string') return dualPhrase(`代码搜索 ${truncateStr(query, 60)}`);
            return dualPhrase(meta.phrase);
        }
        case 'search_web': {
            const query = args.query ?? args.Query;
            if (typeof query === 'string') return dualPhrase(`搜索 "${truncateStr(query, 60)}"`);
            return dualPhrase(meta.phrase);
        }
        case 'web_fetch': {
            const url = args.url ?? args.Url;
            if (typeof url === 'string') return dualPhrase(`抓取 ${truncateStr(url, 60)}`);
            return dualPhrase(meta.phrase);
        }
        case 'get_diagnostics':
        case 'validate_code': {
            const fp = args.file ?? args.filePath ?? args.AbsolutePath;
            if (typeof fp === 'string') return dualPhrase(`诊断 ${basename(fp)}`);
            return dualPhrase(meta.phrase);
        }
        case 'query_workspace_index': {
            const query = args.query ?? args.Query ?? args.keyword;
            if (typeof query === 'string') return dualPhrase(`查索引 "${truncateStr(query, 50)}"`);
            return dualPhrase(meta.phrase);
        }
        case 'dispatch_agents': {
            const desc = args.description ?? args.prompt;
            if (typeof desc === 'string') return dualPhrase(`分派 ${truncateStr(desc, 60)}`);
            return dualPhrase(meta.phrase);
        }
        case 'get_pdx_block': {
            const fp = args.file ?? args.filePath;
            const key = args.key ?? args.blockKey;
            if (typeof fp === 'string' && typeof key === 'string') return dualPhrase(`提取 ${basename(fp)} → ${truncateStr(key, 40)}`);
            if (typeof fp === 'string') return dualPhrase(`提取 ${basename(fp)} 脚本块`);
            return dualPhrase(meta.phrase);
        }
        case 'write_localisation': {
            const key = args.key ?? args.locKey;
            if (typeof key === 'string') return dualPhrase(`写入本地化 ${truncateStr(key, 50)}`);
            return dualPhrase(meta.phrase);
        }
        case 'save_workflow': {
            const title = args.title ?? args.id;
            if (typeof title === 'string') return dualPhrase(`保存工作流 ${truncateStr(title, 50)}`);
            return dualPhrase(meta.phrase);
        }
        case 'apply_patch': {
            const fp = args.TargetFile ?? args.file_path;
            if (typeof fp === 'string') return dualPhrase(`补丁 ${basename(fp)}`);
            return dualPhrase(meta.phrase);
        }
        default:
            return dualPhrase(meta.phrase);
    }
}

// ── Grouping ─────────────────────────────────────────────────────────────────

export interface ToolCallPair {
    call: RendererStep;
    result: RendererStep | undefined;
}

export interface ToolGroup {
    category: ToolCategory;
    icon: string;
    /** e.g. "读取了 3 个文件" */
    summaryLabel: string;
    pairs: ToolCallPair[];
}

/** Minimum tool calls required to enable grouped rendering. */
const GROUP_THRESHOLD = 3;

/**
 * Group tool call/result pairs by category for collapsed rendering.
 * Returns `null` if there are fewer than GROUP_THRESHOLD calls (caller
 * should fall through to the default per-pair rendering).
 */
export function groupToolCalls(
    calls: RendererStep[],
    results: RendererStep[],
): ToolGroup[] | null {
    if (calls.length < GROUP_THRESHOLD) return null;

    // Pair calls with results (consume results in order)
    const resultsCopy = [...results];
    const pairs: ToolCallPair[] = calls.map(call => {
        const idx = resultsCopy.findIndex(r => r.toolName === call.toolName);
        let result: RendererStep | undefined;
        if (idx >= 0) {
            result = resultsCopy.splice(idx, 1)[0];
        }
        return { call, result };
    });

    // Group consecutive pairs by category
    const groups: ToolGroup[] = [];
    let current: { category: ToolCategory; pairs: ToolCallPair[] } | null = null;

    for (const pair of pairs) {
        const meta = getToolPhrase(pair.call.toolName || '');
        if (current && current.category === meta.category) {
            current.pairs.push(pair);
        } else {
            if (current) groups.push(finalizeGroup(current));
            current = { category: meta.category, pairs: [pair] };
        }
    }
    if (current) groups.push(finalizeGroup(current));

    return groups;
}

/** Build the summary label for a group. */
function finalizeGroup(raw: { category: ToolCategory; pairs: ToolCallPair[] }): ToolGroup {
    const firstPair = raw.pairs[0] as ToolCallPair | undefined;
    const meta = getToolPhrase(firstPair?.call.toolName || '');
    const count = raw.pairs.length;
    const label = buildGroupLabel(raw.category, count, raw.pairs);
    return { category: raw.category, icon: meta.icon, summaryLabel: label, pairs: raw.pairs };
}

function buildGroupLabel(category: ToolCategory, count: number, pairs: ToolCallPair[]): string {
    // Single item: use the specific phrase
    if (count === 1) {
        const firstPair = pairs[0] as ToolCallPair | undefined;
        const p = getToolPhrase(firstPair?.call.toolName || '');
        return p.phrase;
    }
    switch (category) {
        case 'read':        return `读取了 ${count} 个文件`;
        case 'write':       return `修改了 ${count} 个文件`;
        case 'query':       return `执行了 ${count} 次查询`;
        case 'validate':    return `运行了 ${count} 次验证`;
        case 'execute':     return `执行了 ${count} 条命令`;
        case 'orchestrate': return `编排了 ${count} 个子任务`;
        default:            return `调用了 ${count} 个工具`;
    }
}

// ── Category CSS class mapping ───────────────────────────────────────────────

/** CSS modifier class for a category (used for colour coding). */
export function categoryClass(category: ToolCategory): string {
    switch (category) {
        case 'read':        return 'tg-cat-read';
        case 'write':       return 'tg-cat-write';
        case 'query':       return 'tg-cat-query';
        case 'validate':    return 'tg-cat-validate';
        case 'execute':     return 'tg-cat-execute';
        case 'orchestrate': return 'tg-cat-orchestrate';
        default:            return 'tg-cat-other';
    }
}
