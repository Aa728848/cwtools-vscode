/**
 * CWTools AI Module - centralized user-visible messages.
 *
 * The extension host cannot import Webview i18n modules, so this file keeps a
 * small host-side catalog for AI runner, orchestration, and VS Code messages.
 * Call `setAiMessageLocale(vscode.env.language)` during activation.
 */

export type AiMessageLocale = 'en' | 'zh-cn';

let currentLocale: AiMessageLocale = 'en';

export function normalizeAiMessageLocale(locale?: string | null): AiMessageLocale {
    return (locale || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

export function setAiMessageLocale(locale?: string | null): void {
    currentLocale = normalizeAiMessageLocale(locale);
}

export function getAiMessageLocale(): AiMessageLocale {
    return currentLocale;
}

export function aiText(en: string, zh: string): string {
    return currentLocale === 'zh-cn' ? zh : en;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
    return count === 1 ? singular : pluralText;
}

function outputKind(kind: string): string {
    if (currentLocale === 'zh-cn') {
        if (kind === 'response') return '正文';
        if (kind === 'reasoning') return '思考内容';
        return kind;
    }
    if (kind === '正文') return 'response';
    if (kind === '思考内容') return 'reasoning';
    return kind || 'output';
}

const AGENT_TEXT = {
    en: {
        MODE_BUILD: 'Analyzing request...',
        MODE_PLAN: 'Analyzing (Plan mode - read-only)...',
        MODE_EXPLORE: 'Exploring codebase (Explore mode)...',
        MODE_UTILITY: 'Processing utility engineering task...',
        MODE_REVIEW: 'Reviewing code...',
        MODE_ORCHESTRATOR: 'Coordinating multi-agent work...',
        MODE_SCRIPT: 'Running Paradox Multi-Agent pipeline...',
        MODE_FALLBACK: 'Analyzing...',
        CANCELLED: 'Generation cancelled',
        ERROR_PREFIX: 'Error',
        VISION_UNSUPPORTED: (providerName: string) =>
            `WARNING: The current provider (${providerName}) does not support image input. Image attachments were ignored.`,
        VISION_MINIMAX_HINT:
            '\nTip: MiniMax Token Plan uses an Anthropic-compatible endpoint that does not support images. Switch to "MiniMax (pay as you go)" to send images.',
        VISION_GENERIC_HINT: '\nCheck whether the selected model supports vision input.',
        COMPACTION_START: (tokens: number, threshold: number) =>
            `Compacting context... (${tokens} tokens -> target <${threshold})`,
        COMPACTION_DONE: (type: string, msgCount: number, summaryLen: number, pinnedCount: number) =>
            `Context compacted (${type}): ${msgCount} ${plural(msgCount, 'message')} -> summary (${summaryLen} chars, ${pinnedCount} pinned entities)`,
        COMPACTION_REUSED: (msgCount: number) =>
            `Transcript unchanged since the last compaction; reusing the previous summary (${msgCount} ${plural(msgCount, 'message')}).`,
        COMPACTION_INCREMENTAL: 'incremental merge',
        COMPACTION_INITIAL: 'initial compaction',
        COMPACTION_FAILED: (detail: string) => `Context compaction failed: ${detail}`,
        COMPACTION_MID_LOOP: (tokens: number, threshold: number) =>
            `Compacting context inside the loop... (${tokens} tokens, threshold ${threshold})`,
        COMPACTION_EMERGENCY: (tokens: number, limit: number) =>
            `Emergency context compaction (${tokens} tokens > ${limit} limit)`,
        COMPACTION_PHASE_DONE: (beforeTokens: number, afterTokens: number) =>
            `Context compaction complete (${beforeTokens} -> ${afterTokens} tokens)`,
        COMPACTION_PRUNED: (beforeTokens: number, afterTokens: number) =>
            `Context pruned in place; no summarization needed (${beforeTokens} -> ${afterTokens} tokens)`,
        COMPACTION_THRASHING:
            'Context remained over budget after repeated compaction. The run stopped to avoid a compaction/retry loop. Narrow the task or start a new topic.',
        OUTPUT_REPETITION_RETRY: (kind: string, cycleChars: number) =>
            `Detected a repeated ${outputKind(kind)} loop (cycle around ${cycleChars} characters). This output was stopped and one controlled retry will run.`,
        OUTPUT_REPETITION_STOP: (kind: string) =>
            `The model repeated its ${outputKind(kind)} again, so generation stopped to avoid wasting context and quota.`,
        FILE_LOCKING: (filePath: string) =>
            `\n> Parsing edit strategy... locked target file: \`${filePath}\`\n`,
        TOOL_RESULT_PREFIX: 'Tool result',
    },
    'zh-cn': {
        MODE_BUILD: '分析需求中...',
        MODE_PLAN: '分析中（Plan 模式 - 只读）...',
        MODE_EXPLORE: '探索代码库中（Explore 模式）...',
        MODE_UTILITY: '处理泛用工程任务中（Utility 模式）...',
        MODE_REVIEW: '代码审查中（Review 模式）...',
        MODE_ORCHESTRATOR: '多 Agent 协调中（Orchestrator 模式）...',
        MODE_SCRIPT: 'Paradox 多 Agent 流水线运行中...',
        MODE_FALLBACK: '分析中...',
        CANCELLED: '已取消生成',
        ERROR_PREFIX: '错误',
        VISION_UNSUPPORTED: (providerName: string) =>
            `⚠️ 当前提供商 (${providerName}) 不支持图片输入，图片附件已被忽略。`,
        VISION_MINIMAX_HINT:
            '\n提示: MiniMax Token Plan 的 Anthropic 兼容接口明确不支持图片 (官方文档)。\n若需发送图片，请切换到 "MiniMax (按量计费)" 提供商。',
        VISION_GENERIC_HINT: '\n请检查您所选模型是否支持视觉功能。',
        COMPACTION_START: (tokens: number, threshold: number) =>
            `上下文压缩中... (${tokens} tokens -> 目标 <${threshold})`,
        COMPACTION_DONE: (type: string, msgCount: number, summaryLen: number, pinnedCount: number) =>
            `上下文已压缩 (${type}): ${msgCount} 条消息 -> 摘要 (${summaryLen} chars, ${pinnedCount} pinned entities)`,
        COMPACTION_REUSED: (msgCount: number) =>
            `上下文自上次压缩后未变化，直接复用上次摘要 (${msgCount} 条消息)。`,
        COMPACTION_INCREMENTAL: '增量合并',
        COMPACTION_INITIAL: '初始压缩',
        COMPACTION_FAILED: (detail: string) => `上下文压缩失败: ${detail}`,
        COMPACTION_MID_LOOP: (tokens: number, threshold: number) =>
            `循环内上下文压缩中... (${tokens} tokens, 阈值 ${threshold})`,
        COMPACTION_EMERGENCY: (tokens: number, limit: number) =>
            `紧急上下文压缩 (${tokens} tokens > ${limit} 上限)`,
        COMPACTION_PHASE_DONE: (beforeTokens: number, afterTokens: number) =>
            `上下文压缩完成 (${beforeTokens} -> ${afterTokens} tokens)`,
        COMPACTION_PRUNED: (beforeTokens: number, afterTokens: number) =>
            `上下文已就地裁剪，无需调用摘要 (${beforeTokens} -> ${afterTokens} tokens)`,
        COMPACTION_THRASHING:
            '上下文连续压缩后仍无法释放足够空间，已停止运行以避免压缩/重试死循环。请缩小任务范围或新建话题。',
        OUTPUT_REPETITION_RETRY: (kind: string, cycleChars: number) =>
            `检测到模型${kind}进入重复循环（循环片段约 ${cycleChars} 字符），已中止本次输出并进行一次受控重试。`,
        OUTPUT_REPETITION_STOP: (kind: string) =>
            `模型${kind}再次进入重复循环，已停止生成以避免继续消耗上下文与额度。`,
        FILE_LOCKING: (filePath: string) =>
            `\n> 正在解析修改策略... 锁定目标文件: \`${filePath}\`\n`,
        TOOL_RESULT_PREFIX: '工具结果',
    },
} as const;

export const AGENT = {
    get MODE_BUILD() { return AGENT_TEXT[currentLocale].MODE_BUILD; },
    get MODE_PLAN() { return AGENT_TEXT[currentLocale].MODE_PLAN; },
    get MODE_EXPLORE() { return AGENT_TEXT[currentLocale].MODE_EXPLORE; },
    get MODE_UTILITY() { return AGENT_TEXT[currentLocale].MODE_UTILITY; },
    get MODE_REVIEW() { return AGENT_TEXT[currentLocale].MODE_REVIEW; },
    get MODE_ORCHESTRATOR() { return AGENT_TEXT[currentLocale].MODE_ORCHESTRATOR; },
    get MODE_SCRIPT() { return AGENT_TEXT[currentLocale].MODE_SCRIPT; },
    get MODE_FALLBACK() { return AGENT_TEXT[currentLocale].MODE_FALLBACK; },
    get CANCELLED() { return AGENT_TEXT[currentLocale].CANCELLED; },
    get ERROR_PREFIX() { return AGENT_TEXT[currentLocale].ERROR_PREFIX; },
    VISION_UNSUPPORTED: (providerName: string) => AGENT_TEXT[currentLocale].VISION_UNSUPPORTED(providerName),
    get VISION_MINIMAX_HINT() { return AGENT_TEXT[currentLocale].VISION_MINIMAX_HINT; },
    get VISION_GENERIC_HINT() { return AGENT_TEXT[currentLocale].VISION_GENERIC_HINT; },
    COMPACTION_START: (tokens: number, threshold: number) => AGENT_TEXT[currentLocale].COMPACTION_START(tokens, threshold),
    COMPACTION_DONE: (type: string, msgCount: number, summaryLen: number, pinnedCount: number) =>
        AGENT_TEXT[currentLocale].COMPACTION_DONE(type, msgCount, summaryLen, pinnedCount),
    COMPACTION_REUSED: (msgCount: number) => AGENT_TEXT[currentLocale].COMPACTION_REUSED(msgCount),
    get COMPACTION_INCREMENTAL() { return AGENT_TEXT[currentLocale].COMPACTION_INCREMENTAL; },
    get COMPACTION_INITIAL() { return AGENT_TEXT[currentLocale].COMPACTION_INITIAL; },
    COMPACTION_FAILED: (detail: string) => AGENT_TEXT[currentLocale].COMPACTION_FAILED(detail),
    COMPACTION_MID_LOOP: (tokens: number, threshold: number) => AGENT_TEXT[currentLocale].COMPACTION_MID_LOOP(tokens, threshold),
    COMPACTION_EMERGENCY: (tokens: number, limit: number) => AGENT_TEXT[currentLocale].COMPACTION_EMERGENCY(tokens, limit),
    COMPACTION_PHASE_DONE: (beforeTokens: number, afterTokens: number) =>
        AGENT_TEXT[currentLocale].COMPACTION_PHASE_DONE(beforeTokens, afterTokens),
    COMPACTION_PRUNED: (beforeTokens: number, afterTokens: number) =>
        AGENT_TEXT[currentLocale].COMPACTION_PRUNED(beforeTokens, afterTokens),
    get COMPACTION_THRASHING() { return AGENT_TEXT[currentLocale].COMPACTION_THRASHING; },
    OUTPUT_REPETITION_RETRY: (kind: string, cycleChars: number) =>
        AGENT_TEXT[currentLocale].OUTPUT_REPETITION_RETRY(kind, cycleChars),
    OUTPUT_REPETITION_STOP: (kind: string) => AGENT_TEXT[currentLocale].OUTPUT_REPETITION_STOP(kind),
    FILE_LOCKING: (filePath: string) => AGENT_TEXT[currentLocale].FILE_LOCKING(filePath),
    get TOOL_RESULT_PREFIX() { return AGENT_TEXT[currentLocale].TOOL_RESULT_PREFIX; },
};

const ORCHESTRATOR_TEXT = {
    en: {
        START: (nodeCount: number) => `Coordinator started: ${nodeCount} ${plural(nodeCount, 'subtask')}`,
        CYCLE_ERROR: (cycles: string) => `Task graph has cyclic dependencies: ${cycles}`,
        CONFLICT_ERROR: (conflicts: string) =>
            `Task graph has concurrent write conflicts: ${conflicts}. Adjust dependencies so those tasks run serially.`,
        LOC_SWEEP_START: '$(globe) Running localisation gap sweep (Loc Sweep Phase)...',
        LOC_SWEEP_DONE: (count: number) => `$(check) Localisation sweep complete; updated ${count} ${plural(count, 'file')}.`,
        LOC_SWEEP_ERROR: (err: string) => `$(warning) Localisation sweep hit an error and was skipped: ${err}`,
        QG_START: (fileCount: number) => `Quality gate: ${fileCount} ${plural(fileCount, 'file')} to review`,
        QG_PASS: '$(check) Quality gate passed.',
        QG_FAIL: (issues: number) => `$(x) Quality gate failed with ${issues} ${plural(issues, 'issue')}.`,
        AUTOFIX_START: '$(gear) Scheduling auto-fix...',
        AUTOFIX_DONE: '$(check) Auto-fix complete.',
        AUTOFIX_FAIL: '$(x) Auto-fix failed.',
        SUB_TIMEOUT: (id: string, ms: string) =>
            `Subtask ${id} had no new output for a long time and was stopped automatically (${ms}).`,
        SUB_IDLE: (id: string, ms: string) =>
            `$(warning) Subtask ${id} has had no new output for ${ms}; still waiting for the model or tool result.`,
    },
    'zh-cn': {
        START: (nodeCount: number) => `协调器启动: ${nodeCount} 个子任务`,
        CYCLE_ERROR: (cycles: string) => `任务图存在循环依赖: ${cycles}`,
        CONFLICT_ERROR: (conflicts: string) => `任务图存在并发写入冲突: ${conflicts}。请调整依赖关系使其串行。`,
        LOC_SWEEP_START: '$(globe) 正在执行本地化遗漏清扫 (Loc Sweep Phase)...',
        LOC_SWEEP_DONE: (count: number) => `$(check) 本地化清扫完成，补全了 ${count} 个文件。`,
        LOC_SWEEP_ERROR: (err: string) => `$(warning) 本地化清扫遇到异常，已跳过: ${err}`,
        QG_START: (fileCount: number) => `质量门: ${fileCount} 个文件待审查`,
        QG_PASS: '$(check) 质量门审查通过！',
        QG_FAIL: (issues: number) => `$(x) 质量门审查未通过，发现 ${issues} 个问题。`,
        AUTOFIX_START: '$(gear) 正在调度自动修复...',
        AUTOFIX_DONE: '$(check) 自动修复完成。',
        AUTOFIX_FAIL: '$(x) 自动修复失败。',
        SUB_TIMEOUT: (id: string, ms: string) => `子任务 ${id} 长时间无新输出，已自动中止以避免假死 (${ms})`,
        SUB_IDLE: (id: string, ms: string) => `$(warning) 子任务 ${id} 已 ${ms} 没有新输出，仍在等待模型或工具返回。`,
    },
} as const;

export const ORCHESTRATOR_MSG = {
    START: (nodeCount: number) => ORCHESTRATOR_TEXT[currentLocale].START(nodeCount),
    CYCLE_ERROR: (cycles: string) => ORCHESTRATOR_TEXT[currentLocale].CYCLE_ERROR(cycles),
    CONFLICT_ERROR: (conflicts: string) => ORCHESTRATOR_TEXT[currentLocale].CONFLICT_ERROR(conflicts),
    get LOC_SWEEP_START() { return ORCHESTRATOR_TEXT[currentLocale].LOC_SWEEP_START; },
    LOC_SWEEP_DONE: (count: number) => ORCHESTRATOR_TEXT[currentLocale].LOC_SWEEP_DONE(count),
    LOC_SWEEP_ERROR: (err: string) => ORCHESTRATOR_TEXT[currentLocale].LOC_SWEEP_ERROR(err),
    QG_START: (fileCount: number) => ORCHESTRATOR_TEXT[currentLocale].QG_START(fileCount),
    get QG_PASS() { return ORCHESTRATOR_TEXT[currentLocale].QG_PASS; },
    QG_FAIL: (issues: number) => ORCHESTRATOR_TEXT[currentLocale].QG_FAIL(issues),
    get AUTOFIX_START() { return ORCHESTRATOR_TEXT[currentLocale].AUTOFIX_START; },
    get AUTOFIX_DONE() { return ORCHESTRATOR_TEXT[currentLocale].AUTOFIX_DONE; },
    get AUTOFIX_FAIL() { return ORCHESTRATOR_TEXT[currentLocale].AUTOFIX_FAIL; },
    SUB_TIMEOUT: (id: string, ms: string) => ORCHESTRATOR_TEXT[currentLocale].SUB_TIMEOUT(id, ms),
    SUB_IDLE: (id: string, ms: string) => ORCHESTRATOR_TEXT[currentLocale].SUB_IDLE(id, ms),
};

const BUDGET_TEXT = {
    en: {
        // Truncation markers must state that the tool completed in full; without
        // that statement models misread a shortened display as partial application
        // and stop mid-task instead of continuing. budgetToolResult reserves
        // TRUNCATION_SUFFIX_RESERVE characters for these suffixes, so keep each
        // under that limit.
        TRUNCATED: (originalLen: number) => `[... truncated - original length: ${originalLen} characters. Display-only truncation: the tool completed and its result was fully applied. Continue your work; re-read or query precisely when you need the exact details.]`,
        TRUNCATED_LINES: (keptLines: number) =>
            `Truncated to ${keptLines} lines because the result exceeded the budget. The read itself completed and the file is unchanged. Use startLine and endLine for a precise read.`,
        TRUNCATED_GENERIC: (originalLen: number) =>
            `[... truncated - original length: ${originalLen} characters. Display-only truncation: the operation completed in full. Continue your work; query specific items separately if needed.]`,
        BUDGET_EXCEEDED: '[... budget exceeded; truncated]',
        COMPACTED_READ_FILE: (totalLines: string) =>
            `[Compacted read_file tool result] Successfully read the file, ${totalLines} lines total.`,
        COMPACTED_PREFIX: 'compacted',
        COMPACTED_ASSISTANT: '\n[... compacted]',
        ARRAY_BUDGET_NOTE: (total: number, shown: number) =>
            `Showing ${shown} of ${total} items after deduping/splitting to save context. The operation completed in full; use a filtered query per file to get the complete list.`,
        ARRAY_GENERIC_NOTE: (total: number, shown: number) =>
            `Showing ${shown} of ${total} items. The operation completed in full; use a targeted query to find a specific item.`,
        GAP: (count: number) => `... omitted ${count} ${plural(count, 'item')} ...`,
        GAP_TAIL: '... continues to end ...',
    },
    'zh-cn': {
        // 截断标记必须说明工具已完整执行；否则模型会把“展示被缩短”误读为
        // “结果被部分应用”而在任务中途自行中止。budgetToolResult 为这些后缀
        // 预留了 TRUNCATION_SUFFIX_RESERVE 字符，保持每个后缀在该上限内。
        TRUNCATED: (originalLen: number) => `[... 已截断 - 原始长度：${originalLen} 字符。仅展示截断——工具已完整执行且结果全部生效。请继续工作；需要精确细节时再定向读取或查询。]`,
        TRUNCATED_LINES: (keptLines: number) =>
            `由于长度超出预算已截断至 ${keptLines} 行。读取本身已完成，文件未被修改。进行精确读取请使用 startLine 和 endLine 参数。`,
        TRUNCATED_GENERIC: (originalLen: number) =>
            `[... 已截断 - 原始长度：${originalLen} 字符。仅展示截断——操作已完整执行。请继续工作；如需具体项请单独查询。]`,
        BUDGET_EXCEEDED: '[... 超限已截断]',
        COMPACTED_READ_FILE: (totalLines: string) =>
            `[已压缩的 read_file 工具结果] 成功读取文件，共 ${totalLines} 行。`,
        COMPACTED_PREFIX: '已压缩',
        COMPACTED_ASSISTANT: '\n[... 已压缩]',
        ARRAY_BUDGET_NOTE: (total: number, shown: number) =>
            `显示了 ${total} 项中的 ${shown} 项（为节省上下文已去重/分段）。操作已完整执行；需要完整列表请按文件使用带 filter 的查询。`,
        ARRAY_GENERIC_NOTE: (total: number, shown: number) =>
            `显示了 ${total} 项中的 ${shown} 项。操作已完整执行；请使用针对性的查询以查找特定项。`,
        GAP: (count: number) => `... 省略了 ${count} 项 ...`,
        GAP_TAIL: '... 延续至结尾 ...',
    },
} as const;

export const BUDGET = {
    TRUNCATED: (originalLen: number) => BUDGET_TEXT[currentLocale].TRUNCATED(originalLen),
    TRUNCATED_LINES: (keptLines: number) => BUDGET_TEXT[currentLocale].TRUNCATED_LINES(keptLines),
    TRUNCATED_GENERIC: (originalLen: number) => BUDGET_TEXT[currentLocale].TRUNCATED_GENERIC(originalLen),
    get BUDGET_EXCEEDED() { return BUDGET_TEXT[currentLocale].BUDGET_EXCEEDED; },
    COMPACTED_READ_FILE: (totalLines: string) => BUDGET_TEXT[currentLocale].COMPACTED_READ_FILE(totalLines),
    get COMPACTED_PREFIX() { return BUDGET_TEXT[currentLocale].COMPACTED_PREFIX; },
    get COMPACTED_ASSISTANT() { return BUDGET_TEXT[currentLocale].COMPACTED_ASSISTANT; },
    ARRAY_BUDGET_NOTE: (total: number, shown: number) => BUDGET_TEXT[currentLocale].ARRAY_BUDGET_NOTE(total, shown),
    ARRAY_GENERIC_NOTE: (total: number, shown: number) => BUDGET_TEXT[currentLocale].ARRAY_GENERIC_NOTE(total, shown),
    GAP: (count: number) => BUDGET_TEXT[currentLocale].GAP(count),
    get GAP_TAIL() { return BUDGET_TEXT[currentLocale].GAP_TAIL; },
};

const UI_TEXT = {
    en: {
        NO_ACTIVE_EDITOR: 'No active editor',
        NO_WORKSPACE: 'No workspace is open',
        NO_WORKSPACE_INIT: 'Eddy CWTool Code /init: no workspace is open',
        SELECT_CODE_FIRST: 'Select code first.',
        INSERT_CANCELLED: 'Insert cancelled',
        CONTEXT_COMPACTED: 'The current Agent context has been compacted; the full transcript is still kept in the topic.',
        CONTEXT_COMPACT_EMPTY: 'This topic is too small to compact.',
        SUGGEST_REVIEW: 'Analyze the current file and list possible syntax and logic issues',
        SUGGEST_REVIEW_LABEL: 'Code review',
    },
    'zh-cn': {
        NO_ACTIVE_EDITOR: '没有打开的编辑器',
        NO_WORKSPACE: '没有打开的工作区',
        NO_WORKSPACE_INIT: 'Eddy CWTool Code /init: 当前没有打开的工作区',
        SELECT_CODE_FIRST: '请先选中要发送的代码。',
        INSERT_CANCELLED: '已取消插入',
        CONTEXT_COMPACTED: '当前 Agent 活动上下文已压缩；完整聊天记录仍保留在话题中。',
        CONTEXT_COMPACT_EMPTY: '当前话题内容太少，无需压缩。',
        SUGGEST_REVIEW: '分析当前文件并列出潜在的语法和逻辑问题',
        SUGGEST_REVIEW_LABEL: '代码审查',
    },
} as const;

export const UI = {
    get NO_ACTIVE_EDITOR() { return UI_TEXT[currentLocale].NO_ACTIVE_EDITOR; },
    get NO_WORKSPACE() { return UI_TEXT[currentLocale].NO_WORKSPACE; },
    get NO_WORKSPACE_INIT() { return UI_TEXT[currentLocale].NO_WORKSPACE_INIT; },
    get SELECT_CODE_FIRST() { return UI_TEXT[currentLocale].SELECT_CODE_FIRST; },
    get INSERT_CANCELLED() { return UI_TEXT[currentLocale].INSERT_CANCELLED; },
    get CONTEXT_COMPACTED() { return UI_TEXT[currentLocale].CONTEXT_COMPACTED; },
    get CONTEXT_COMPACT_EMPTY() { return UI_TEXT[currentLocale].CONTEXT_COMPACT_EMPTY; },
    get SUGGEST_REVIEW() { return UI_TEXT[currentLocale].SUGGEST_REVIEW; },
    get SUGGEST_REVIEW_LABEL() { return UI_TEXT[currentLocale].SUGGEST_REVIEW_LABEL; },
};

export const SOURCE = {
    AGENT_RUNNER: 'AgentRunner',
    PROMPT_BUILDER: 'PromptBuilder',
    MEMORY_PARSER: 'MemoryParser',
    MCP_CLIENT: 'MCP',
    INLINE_PROVIDER: 'InlineProvider',
    CHAT_PANEL: 'ChatPanel',
    AI_SERVICE: 'AIService',
    UPDATE_CHECKER: 'UpdateChecker',
    ORCHESTRATOR: 'Orchestrator',
} as const;

const EVIDENCE_GATE_TEXT = {
    en: {
        BLOCKED_HEADER: (count: number, target: string) =>
            `Semantic evidence gate blocked the write to ${target}: ${count} confirmed conflicting ${plural(count, 'claim')} ${count === 1 ? 'requires' : 'require'} correction.`,
        UNAVAILABLE:
            'The semantic evidence service is unavailable (LSP not connected or timed out). The write will proceed with advisory evidence and be rechecked when validation is available.',
        OVERRIDE_REQUEST: (target: string, summary: string) =>
            `The semantic evidence gate found confirmed conflicts in a PDX write to ${target}:\n${summary}\nApprove only if you intentionally accept those conflicts.`,
        OVERRIDE_DENIED:
            'Write blocked by the semantic evidence gate. You denied the manual override.',
        RETRY_HINT:
            'Correct the conflicting script or verify it with the suggested read-only queries, then retry. The gate re-verifies every attempt.',
        RESULT_TAG: (decisionId: string, verdict: string, mode: string) =>
            `Evidence gate: ${verdict} (${mode}, decision ${decisionId})`,
        CLAIM_LINE: (kind: string, status: string, claim: string) => `- [${kind}/${status}] ${claim}`,
    },
    'zh-cn': {
        BLOCKED_HEADER: (count: number, target: string) =>
            `语义证据门禁阻止了对 ${target} 的写入：${count} 条声明已确认存在冲突，需要修正。`,
        UNAVAILABLE:
            '语义证据服务不可用（LSP 未连接或超时）。写入将携带告警继续，并在验证服务恢复后重新检查。',
        OVERRIDE_REQUEST: (target: string, summary: string) =>
            `语义证据门禁在对 ${target} 的 PDX 写入中发现了已确认冲突：\n${summary}\n仅在您明确接受这些冲突时才应批准。`,
        OVERRIDE_DENIED: '写入已被语义证据门禁阻止，您拒绝了人工覆盖。',
        RETRY_HINT:
            '请修正冲突脚本，或使用建议的只读查询复核后重试。门禁每次都会重新验证。',
        RESULT_TAG: (decisionId: string, verdict: string, mode: string) =>
            `证据门禁：${verdict}（${mode}，决策 ${decisionId}）`,
        CLAIM_LINE: (kind: string, status: string, claim: string) => `- [${kind}/${status}] ${claim}`,
    },
} as const;

export const EVIDENCE_GATE_MSG = {
    BLOCKED_HEADER: (count: number, target: string) => EVIDENCE_GATE_TEXT[currentLocale].BLOCKED_HEADER(count, target),
    get UNAVAILABLE() { return EVIDENCE_GATE_TEXT[currentLocale].UNAVAILABLE; },
    OVERRIDE_REQUEST: (target: string, summary: string) => EVIDENCE_GATE_TEXT[currentLocale].OVERRIDE_REQUEST(target, summary),
    get OVERRIDE_DENIED() { return EVIDENCE_GATE_TEXT[currentLocale].OVERRIDE_DENIED; },
    get RETRY_HINT() { return EVIDENCE_GATE_TEXT[currentLocale].RETRY_HINT; },
    RESULT_TAG: (decisionId: string, verdict: string, mode: string) => EVIDENCE_GATE_TEXT[currentLocale].RESULT_TAG(decisionId, verdict, mode),
    CLAIM_LINE: (kind: string, status: string, claim: string) => EVIDENCE_GATE_TEXT[currentLocale].CLAIM_LINE(kind, status, claim),
};
