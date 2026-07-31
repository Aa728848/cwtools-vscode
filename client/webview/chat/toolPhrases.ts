/**
 * Tool Phrases - PDX-specialised human-readable labels and category mapping.
 *
 * Rendering defaults to English so missed locale plumbing fails toward the
 * extension's default language instead of leaking Chinese into English UI.
 */

import type { RendererStep } from '../messageRenderer';

export type ToolPhraseLocale = 'en' | 'zh-cn';
export type ToolCategory = 'read' | 'write' | 'query' | 'validate' | 'execute' | 'orchestrate' | 'other';

export interface ToolPhraseMeta {
    category: ToolCategory;
    /** Emoji icon for the group summary. */
    icon: string;
    /** Human-readable verb phrase in the requested locale. */
    phrase: string;
}

interface ToolPhraseEntry {
    category: ToolCategory;
    icon: string;
    en: string;
    zh: string;
}

const TOOL_PHRASES: Record<string, ToolPhraseEntry> = {
    explore_pdx_project:       { category: 'query',       icon: '🕸️', en: 'Explore semantic graph', zh: '探索语义图' },
    read_file:                 { category: 'read',        icon: '📖', en: 'Read file', zh: '读取文件' },
    get_file_context:          { category: 'read',        icon: '📖', en: 'Get file context', zh: '获取文件上下文' },
    get_pdx_block:             { category: 'read',        icon: '📖', en: 'Extract script block', zh: '提取脚本块' },
    list_directory:            { category: 'read',        icon: '📖', en: 'List directory', zh: '列出目录' },
    glob_files:                { category: 'read',        icon: '📖', en: 'Search files', zh: '搜索文件' },
    search_mod_files:          { category: 'read',        icon: '📖', en: 'Search mod files', zh: '搜索 Mod 文件' },
    web_find:                 { category: 'read',        icon: '📖', en: 'Find in web page', zh: '在网页中查找' },
    codesearch:                { category: 'read',        icon: '📖', en: 'Code search', zh: '代码搜索' },

    edit_file:                 { category: 'write',       icon: '✏️', en: 'Edit file', zh: '编辑文件' },
    multiedit:                 { category: 'write',       icon: '✏️', en: 'Multi-edit', zh: '多处编辑' },
    write_file:                { category: 'write',       icon: '✏️', en: 'Write file', zh: '写入文件' },
    create_file:               { category: 'write',       icon: '✏️', en: 'Create file', zh: '创建文件' },
    apply_patch:               { category: 'write',       icon: '✏️', en: 'Apply patch', zh: '应用补丁' },
    delete_file:               { category: 'write',       icon: '✏️', en: 'Delete file', zh: '删除文件' },
    write_localisation:        { category: 'write',       icon: '✏️', en: 'Write localisation', zh: '写入本地化' },
    save_workflow:             { category: 'write',       icon: '✏️', en: 'Save workflow', zh: '保存工作流' },
    todo_write:                { category: 'write',       icon: '✏️', en: 'Update todos', zh: '更新待办' },

    query_workspace_index:     { category: 'query',       icon: '🔍', en: 'Search symbol index', zh: '搜索符号索引' },
    query_localisation_index:  { category: 'query',       icon: '🔍', en: 'Search localisation', zh: '搜索本地化' },
    document_symbols:          { category: 'query',       icon: '🔍', en: 'Get document symbols', zh: '获取文档符号' },
    workspace_symbols:         { category: 'query',       icon: '🔍', en: 'Search workspace symbols', zh: '搜索工作区符号' },
    go_to_definition:          { category: 'query',       icon: '🔍', en: 'Go to definition', zh: '跳转到定义' },
    find_references:           { category: 'query',       icon: '🔍', en: 'Find references', zh: '查找引用' },
    hover_symbol:              { category: 'query',       icon: '🔍', en: 'Inspect symbol', zh: '查看符号信息' },
    rename_symbol:             { category: 'write',       icon: '✏️', en: 'Rename symbol', zh: '重命名符号' },
    query_scope:               { category: 'query',       icon: '🔍', en: 'Query scope', zh: '查询作用域' },
    query_types:               { category: 'query',       icon: '🔍', en: 'Query types', zh: '查询类型' },
    query_rules:               { category: 'query',       icon: '🔍', en: 'Query rules', zh: '查询规则' },
    query_interface_knowledge: { category: 'query',       icon: '🔍', en: 'Query Interface knowledge', zh: '查询界面知识' },
    query_references:          { category: 'query',       icon: '🔍', en: 'Query references', zh: '查询引用' },
    query_blackboard:          { category: 'query',       icon: '🔍', en: 'Query blackboard', zh: '查询黑板' },
    web_search:                { category: 'query',       icon: '🔍', en: 'Search web', zh: '搜索网页' },
    web_open:                  { category: 'query',       icon: '🔍', en: 'Open web page', zh: '打开网页' },
    search_web:                { category: 'query',       icon: '🔍', en: 'Search web', zh: '搜索网页' },
    web_fetch:                 { category: 'query',       icon: '🔍', en: 'Fetch web page', zh: '抓取网页' },
    get_completion_at:         { category: 'query',       icon: '🔍', en: 'Get completion', zh: '获取补全' },

    get_diagnostics:           { category: 'validate',    icon: '🩺', en: 'Get diagnostics', zh: '获取诊断' },
    validate_code:             { category: 'validate',    icon: '🩺', en: 'Validate code', zh: '验证代码' },

    run_command:               { category: 'execute',     icon: '⚡', en: 'Run command', zh: '执行命令' },
    list_processes:            { category: 'execute',     icon: '⚡', en: 'List command processes', zh: '列出命令进程' },
    read_process:              { category: 'execute',     icon: '⚡', en: 'Read command process', zh: '读取命令进程' },
    write_process_stdin:       { category: 'execute',     icon: '⚡', en: 'Send process input', zh: '发送进程输入' },
    terminate_process:         { category: 'execute',     icon: '⚡', en: 'Stop command process', zh: '停止命令进程' },

    dispatch_agents:           { category: 'orchestrate', icon: '🎯', en: 'Dispatch subtasks', zh: '分派子任务' },
    merge_results:             { category: 'orchestrate', icon: '🎯', en: 'Merge results', zh: '合并结果' },
};

function normalizeLocale(locale?: string | null): ToolPhraseLocale {
    return (locale || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

function text(entry: ToolPhraseEntry, locale?: string | null): string {
    return normalizeLocale(locale) === 'zh-cn' ? entry.zh : entry.en;
}

/** Look up the phrase meta for a tool name, falling back to a generic entry. */
export function getToolPhrase(toolName: string, locale?: string | null): ToolPhraseMeta {
    const entry = TOOL_PHRASES[toolName];
    if (!entry) return { category: 'other', icon: '⚙', phrase: toolName };
    return { category: entry.category, icon: entry.icon, phrase: text(entry, locale) };
}

export interface ToolDynamicPhrase {
    /** Label shown after completion. */
    label: string;
    /** Label shown while the tool is running. */
    loadingLabel: string;
}

function basename(path: string): string {
    return (path || '').replace(/\\/g, '/').split('/').pop() || path;
}

function truncateStr(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
}

function dualPhrase(label: string, locale?: string | null, loadingLabel?: string): ToolDynamicPhrase {
    if (normalizeLocale(locale) === 'zh-cn') {
        return { label, loadingLabel: loadingLabel ?? `正在${label}...` };
    }
    return { label, loadingLabel: loadingLabel ?? `${label}...` };
}

function fileWord(locale?: string | null): string {
    return normalizeLocale(locale) === 'zh-cn' ? '文件' : 'file';
}

export function getToolDynamicPhrase(
    toolName: string,
    toolArgs?: Record<string, unknown>,
    locale?: string | null,
): ToolDynamicPhrase {
    const args = toolArgs || {};
    const meta = getToolPhrase(toolName, locale);
    const zh = normalizeLocale(locale) === 'zh-cn';

    switch (toolName) {
        case 'read_file': {
            const fp = args.AbsolutePath ?? args.file_path ?? args.filePath;
            if (typeof fp === 'string') {
                const name = basename(fp);
                const start = typeof args.StartLine === 'number' ? args.StartLine : undefined;
                const end = typeof args.EndLine === 'number' ? args.EndLine : undefined;
                if (zh) {
                    if (start != null && end != null) return dualPhrase(`读取 ${name} 第 ${start}-${end} 行`, locale);
                    if (start != null) return dualPhrase(`读取 ${name} 从第 ${start} 行`, locale);
                    return dualPhrase(`读取 ${name}`, locale);
                }
                if (start != null && end != null) return dualPhrase(`Read ${name} lines ${start}-${end}`, locale, `Reading ${name} lines ${start}-${end}...`);
                if (start != null) return dualPhrase(`Read ${name} from line ${start}`, locale, `Reading ${name} from line ${start}...`);
                return dualPhrase(`Read ${name}`, locale, `Reading ${name}...`);
            }
            return dualPhrase(meta.phrase, locale, zh ? undefined : 'Reading file...');
        }
        case 'edit_file':
        case 'multiedit': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : fileWord(locale);
            return zh ? dualPhrase(`编辑 ${name}`, locale) : dualPhrase(`Edit ${name}`, locale, `Editing ${name}...`);
        }
        case 'write_file':
        case 'create_file': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : fileWord(locale);
            return zh ? dualPhrase(`写入 ${name}`, locale) : dualPhrase(`Write ${name}`, locale, `Writing ${name}...`);
        }
        case 'delete_file': {
            const fp = args.TargetFile ?? args.file_path ?? args.filePath;
            const name = typeof fp === 'string' ? basename(fp) : fileWord(locale);
            return zh ? dualPhrase(`删除 ${name}`, locale) : dualPhrase(`Delete ${name}`, locale, `Deleting ${name}...`);
        }
        case 'run_command': {
            const cmd = args.CommandLine ?? args.command;
            if (typeof cmd === 'string') {
                const short = truncateStr(cmd, 80);
                return zh ? dualPhrase(`执行 ${short}`, locale) : dualPhrase(`Run ${short}`, locale, `Running ${short}...`);
            }
            return dualPhrase(meta.phrase, locale, zh ? undefined : 'Running command...');
        }
        case 'list_directory': {
            const dp = args.DirectoryPath ?? args.path;
            if (typeof dp === 'string') {
                const dir = `${basename(dp)}/`;
                return zh ? dualPhrase(`列出 ${dir}`, locale) : dualPhrase(`List ${dir}`, locale, `Listing ${dir}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'glob_files':
        case 'search_mod_files': {
            const pattern = args.Pattern ?? args.pattern ?? args.query;
            if (typeof pattern === 'string') {
                const short = truncateStr(pattern, 60);
                return zh ? dualPhrase(`搜索文件 ${short}`, locale) : dualPhrase(`Search files ${short}`, locale, `Searching files ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'web_find':
        case 'codesearch': {
            const query = args.Query ?? args.query ?? args.pattern;
            if (typeof query === 'string') {
                const short = truncateStr(query, 60);
                return zh ? dualPhrase(`代码搜索 ${short}`, locale) : dualPhrase(`Code search ${short}`, locale, `Searching code for ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'web_search':
        case 'search_web': {
            const query = args.query ?? args.Query;
            if (typeof query === 'string') {
                const short = truncateStr(query, 60);
                return zh ? dualPhrase(`搜索 "${short}"`, locale) : dualPhrase(`Search "${short}"`, locale, `Searching "${short}"...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'web_open':
        case 'web_fetch': {
            const url = args.ref ?? args.url ?? args.Url;
            if (typeof url === 'string') {
                const short = truncateStr(url, 60);
                return zh ? dualPhrase(`抓取 ${short}`, locale) : dualPhrase(`Fetch ${short}`, locale, `Fetching ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'get_diagnostics':
        case 'validate_code': {
            const fp = args.file ?? args.filePath ?? args.AbsolutePath;
            if (typeof fp === 'string') {
                const name = basename(fp);
                return zh ? dualPhrase(`诊断 ${name}`, locale) : dualPhrase(`Diagnose ${name}`, locale, `Diagnosing ${name}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'explore_pdx_project': {
            const query = args.query ?? args.Query ?? args.keyword;
            if (typeof query === 'string') {
                const short = truncateStr(query, 50);
                return zh ? dualPhrase(`探索语义图“${short}”`, locale) : dualPhrase(`Explore graph "${short}"`, locale, `Exploring graph "${short}"...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'query_workspace_index': {
            const query = args.query ?? args.Query ?? args.keyword;
            if (typeof query === 'string') {
                const short = truncateStr(query, 50);
                return zh ? dualPhrase(`查索引 "${short}"`, locale) : dualPhrase(`Search index "${short}"`, locale, `Searching index "${short}"...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'dispatch_agents': {
            const desc = args.description ?? args.prompt;
            if (typeof desc === 'string') {
                const short = truncateStr(desc, 60);
                return zh ? dualPhrase(`分派 ${short}`, locale) : dualPhrase(`Dispatch ${short}`, locale, `Dispatching ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'get_pdx_block': {
            const fp = args.file ?? args.filePath;
            const key = args.key ?? args.blockKey;
            if (typeof fp === 'string' && typeof key === 'string') {
                const label = zh ? `提取 ${basename(fp)} -> ${truncateStr(key, 40)}` : `Extract ${basename(fp)} -> ${truncateStr(key, 40)}`;
                return dualPhrase(label, locale, zh ? undefined : `${label}...`);
            }
            if (typeof fp === 'string') {
                const name = basename(fp);
                return zh ? dualPhrase(`提取 ${name} 脚本块`, locale) : dualPhrase(`Extract script block from ${name}`, locale, `Extracting script block from ${name}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'write_localisation': {
            const key = args.key ?? args.locKey;
            if (typeof key === 'string') {
                const short = truncateStr(key, 50);
                return zh ? dualPhrase(`写入本地化 ${short}`, locale) : dualPhrase(`Write localisation ${short}`, locale, `Writing localisation ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'save_workflow': {
            const title = args.title ?? args.id;
            if (typeof title === 'string') {
                const short = truncateStr(title, 50);
                return zh ? dualPhrase(`保存工作流 ${short}`, locale) : dualPhrase(`Save workflow ${short}`, locale, `Saving workflow ${short}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        case 'apply_patch': {
            const fp = args.TargetFile ?? args.file_path;
            if (typeof fp === 'string') {
                const name = basename(fp);
                return zh ? dualPhrase(`补丁 ${name}`, locale) : dualPhrase(`Patch ${name}`, locale, `Patching ${name}...`);
            }
            return dualPhrase(meta.phrase, locale);
        }
        default:
            return dualPhrase(meta.phrase, locale);
    }
}

export interface ToolCallPair {
    call: RendererStep;
    result: RendererStep | undefined;
}

export interface ToolGroup {
    category: ToolCategory;
    icon: string;
    /** e.g. "Read 3 files" */
    summaryLabel: string;
    pairs: ToolCallPair[];
}

const GROUP_THRESHOLD = 3;

export function groupToolCalls(
    calls: RendererStep[],
    results: RendererStep[],
    locale?: string | null,
): ToolGroup[] | null {
    if (calls.length < GROUP_THRESHOLD) return null;

    const resultsCopy = [...results];
    const pairs: ToolCallPair[] = calls.map(call => {
        const idx = resultsCopy.findIndex(r => r.toolName === call.toolName);
        let result: RendererStep | undefined;
        if (idx >= 0) result = resultsCopy.splice(idx, 1)[0];
        return { call, result };
    });

    const groups: ToolGroup[] = [];
    let current: { category: ToolCategory; pairs: ToolCallPair[] } | null = null;

    for (const pair of pairs) {
        const meta = getToolPhrase(pair.call.toolName || '', locale);
        if (current && current.category === meta.category) {
            current.pairs.push(pair);
        } else {
            if (current) groups.push(finalizeGroup(current, locale));
            current = { category: meta.category, pairs: [pair] };
        }
    }
    if (current) groups.push(finalizeGroup(current, locale));

    return groups;
}

function finalizeGroup(raw: { category: ToolCategory; pairs: ToolCallPair[] }, locale?: string | null): ToolGroup {
    const firstPair = raw.pairs[0] as ToolCallPair | undefined;
    const meta = getToolPhrase(firstPair?.call.toolName || '', locale);
    const count = raw.pairs.length;
    const label = buildGroupLabel(raw.category, count, raw.pairs, locale);
    return { category: raw.category, icon: meta.icon, summaryLabel: label, pairs: raw.pairs };
}

function countLabel(count: number, singular: string, pluralText = `${singular}s`): string {
    return count === 1 ? singular : pluralText;
}

function buildGroupLabel(category: ToolCategory, count: number, pairs: ToolCallPair[], locale?: string | null): string {
    if (count === 1) {
        const firstPair = pairs[0] as ToolCallPair | undefined;
        return getToolPhrase(firstPair?.call.toolName || '', locale).phrase;
    }
    if (normalizeLocale(locale) === 'zh-cn') {
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
    switch (category) {
        case 'read':        return `Read ${count} ${countLabel(count, 'file')}`;
        case 'write':       return `Modified ${count} ${countLabel(count, 'file')}`;
        case 'query':       return `Ran ${count} ${countLabel(count, 'query', 'queries')}`;
        case 'validate':    return `Ran ${count} ${countLabel(count, 'validation')}`;
        case 'execute':     return `Ran ${count} ${countLabel(count, 'command')}`;
        case 'orchestrate': return `Coordinated ${count} ${countLabel(count, 'subtask')}`;
        default:            return `Called ${count} ${countLabel(count, 'tool')}`;
    }
}

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
