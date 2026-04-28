/**
 * CWTools AI Module — Centralized UI Messages
 *
 * All user-visible strings are collected here for:
 * 1. Consistency — no typos or drifting phrasing across files
 * 2. Future i18n — swap this module for locale-specific versions
 * 3. Grep-ability — easy to find all UI text in one place
 *
 * Naming convention:  AREA_ACTION or AREA_DESCRIPTION
 */

// ─── Agent Runner Messages ──────────────────────────────────────────────────

export const AGENT = {
    /** Mode labels shown while the agent is thinking */
    MODE_BUILD: '分析需求中...',
    MODE_PLAN: '分析中（Plan 模式 — 只读）...',
    MODE_EXPLORE: '探索代码库中（Explore 模式）...',
    MODE_GENERAL: '处理请求中（General 模式）...',
    MODE_REVIEW: '代码审查中（Review 模式）...',
    MODE_FALLBACK: '分析中...',

    CANCELLED: '已取消生成',
    ERROR_PREFIX: '错误',

    /** Vision not supported */
    VISION_UNSUPPORTED: (providerName: string) =>
        `⚠️ 当前提供商 (${providerName}) 不支持图片输入，图片附件已被忽略。`,
    VISION_MINIMAX_HINT:
        '\n提示: MiniMax Token Plan 的 Anthropic 兼容接口明确不支持图片 (官方文档)。\n若需发送图片，请切换到 "MiniMax (按量计费)" 提供商。',
    VISION_GENERIC_HINT: '\n请检查您所选模型是否支持视觉功能。',

    /** Compaction */
    COMPACTION_START: (tokens: number, threshold: number) =>
        `上下文压缩中... (${tokens} tokens → 目标 <${threshold})`,
    COMPACTION_DONE: (type: string, msgCount: number, summaryLen: number, pinnedCount: number) =>
        `上下文已压缩 (${type}): ${msgCount} 条消息 → 摘要 (${summaryLen} chars, ${pinnedCount} pinned entities)`,
    COMPACTION_INCREMENTAL: '增量合并',
    COMPACTION_INITIAL: '初始压缩',
    COMPACTION_FAILED: (detail: string) => `上下文压缩失败: ${detail}`,
    COMPACTION_MID_LOOP: (tokens: number, threshold: number) =>
        `循环内上下文压缩中... (${tokens} tokens, 阈值 ${threshold})`,
    COMPACTION_EMERGENCY: (tokens: number, limit: number) =>
        `紧急上下文压缩 (${tokens} tokens > ${limit} 上限)`,

    /** File write announcements */
    FILE_LOCKING: (filePath: string) =>
        `\n> ⏳ 正在解析修改策略... 锁定目标文件: \`${filePath}\`\n`,

    TOOL_RESULT_PREFIX: '工具结果',
};

// ─── Context Budget Messages ────────────────────────────────────────────────

export const BUDGET = {
    TRUNCATED: (originalLen: number) =>
        `[... 已截断 — 原始长度：${originalLen} 字符。]`,
    TRUNCATED_LINES: (keptLines: number) =>
        `由于长度超出预算已截断至 ${keptLines} 行。进行精确读取请使用 startLine 和 endLine 参数。`,
    TRUNCATED_GENERIC: (originalLen: number) =>
        `[... 已截断 — 原始长度：${originalLen} 字符。如需具体项请单独查询。]`,
    BUDGET_EXCEEDED: '[... 超限已截断]',
    COMPACTED_READ_FILE: (totalLines: string) =>
        `[已压缩的 read_file 工具结果] 成功读取文件，共 ${totalLines} 行。`,
    COMPACTED_PREFIX: '已压缩',
    COMPACTED_ASSISTANT: '\n[... 已压缩]',
    ARRAY_BUDGET_NOTE: (total: number, shown: number) =>
        `显示了 ${total} 项中的 ${shown} 项（为节省上下文已去重/分段）。请使用带 filter 的查询以查找特定文件。`,
    ARRAY_GENERIC_NOTE: (total: number, shown: number) =>
        `显示了 ${total} 项中的 ${shown} 项。请使用针对性的查询以查找特定项。`,
    GAP: (count: number) => `... 省略了 ${count} 项 ...`,
    GAP_TAIL: '... 延续至结尾 ...',
};

// ─── Chat Panel / UI Messages ───────────────────────────────────────────────

export const UI = {
    NO_ACTIVE_EDITOR: '没有打开的编辑器',
    NO_WORKSPACE: '没有打开的工作区',
    NO_WORKSPACE_INIT: 'Eddy CWTool Code /init: 当前没有打开的工作区',
    SELECT_CODE_FIRST: '请先选中要解释的代码',
    INSERT_CANCELLED: '已取消插入',
    SUGGEST_REVIEW: '分析当前文件并列出潜在的语法和逻辑问题',
    SUGGEST_REVIEW_LABEL: '代码审查',
};

// ─── Error Reporter Source Labels ───────────────────────────────────────────

export const SOURCE = {
    AGENT_RUNNER: 'AgentRunner',
    PROMPT_BUILDER: 'PromptBuilder',
    MEMORY_PARSER: 'MemoryParser',
    MCP_CLIENT: 'MCP',
    INLINE_PROVIDER: 'InlineProvider',
    CHAT_PANEL: 'ChatPanel',
    AI_SERVICE: 'AIService',
    UPDATE_CHECKER: 'UpdateChecker',
} as const;
