/**
 * Eddy CWTool Code — 多 Agent 协作系统类型定义
 *
 * 定义了任务图、黑板条目、Agent 实例和协调器所需的全部类型。
 * 模型选择继承用户在设置面板中配置的供应商/模型，支持按角色覆盖。
 */

import type { AgentMode, TokenUsage, AgentStep } from '../types';

// ─── Blackboard 条目类型 ─────────────────────────────────────────────────────

/** 黑板条目的数据类型标签 */
export type BlackboardEntryType =
    | 'file_snapshot'      // 文件快照（路径、内容摘要）
    | 'scope_info'         // 作用域信息（来自 query_scope）
    | 'diag_result'        // 诊断结果（来自 get_diagnostics）
    | 'entity_registry'    // 实体注册表（已创建的 ID → 创建者 Agent）
    | 'write_intent'       // 写入意图声明（Agent 声明即将写入的文件）
    | 'free_text';         // 自由文本（通用 KV 存储）

/** 黑板中的一个条目 */
export interface BlackboardEntry {
    /** 条目的唯一键 */
    key: string;
    /** 条目的值（序列化为字符串） */
    value: string;
    /** 条目的数据类型标签 */
    type: BlackboardEntryType;
    /** 乐观锁版本号 — 每次写入递增 */
    version: number;
    /** 写入该条目的 Agent ID */
    authorAgentId: string;
    /** 写入时间戳 (Date.now()) */
    timestamp: number;
}

/** 黑板写入结果 */
export interface BlackboardWriteResult {
    success: boolean;
    /** 写入后的新版本号 */
    newVersion?: number;
    /** 失败原因（版本冲突等） */
    conflict?: string;
}

/** 序列化后的黑板快照（用于检查点） */
export interface SerializedBlackboard {
    entries: Array<[string, BlackboardEntry]>;
    timestamp: number;
}

// ─── 任务图类型 ───────────────────────────────────────────────────────────────

/** 任务节点状态 */
export type TaskNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务优先级 */
export type TaskPriority = 'critical' | 'normal' | 'low';

/** DAG 中的一个任务节点 */
export interface TaskNode {
    /** 节点唯一 ID (如 "explore_1", "build_events") */
    id: string;
    /** 执行该任务的 Agent 模式 */
    agentType: AgentMode;
    /** 子任务描述（作为 Agent 的用户消息） */
    prompt: string;
    /** 前置依赖任务 ID 列表 — 全部完成后本节点才可执行 */
    dependencies: string[];
    /** 任务优先级 */
    priority: TaskPriority;
    /** 当前状态 */
    status: TaskNodeStatus;
    /** 执行结果（Agent 最终输出） */
    result?: string;
    /** 失败时的错误信息 */
    error?: string;

    // ── 资源控制 ──
    /** 覆盖模型选择（留空则继承用户配置的供应商/模型） */
    modelOverride?: string;
    /** 覆盖供应商选择（留空则继承用户配置） */
    providerOverride?: string;
    /** 最大推理循环迭代次数 */
    maxIterations?: number;
    /** 重试计数 */
    retryCount: number;
    /** 最大重试次数 */
    maxRetries: number;

    // ── 运行时元数据 ──
    /** 开始执行时间 */
    startedAt?: number;
    /** 完成时间 */
    completedAt?: number;
    /** 该节点消耗的 Token */
    tokenUsage?: TokenUsage;
}

/** 任务图（DAG） */
export interface TaskGraph {
    /** 图的唯一 ID */
    id: string;
    /** 节点集合 */
    nodes: Map<string, TaskNode>;
    /** 元数据 */
    metadata: {
        /** 原始用户请求 */
        userPrompt: string;
        /** 创建时间 */
        createdAt: number;
    };
}

// ─── Agent 实例类型 ───────────────────────────────────────────────────────────

/** Agent 实例运行时状态 */
export type AgentInstanceStatus = 'idle' | 'running' | 'done' | 'failed';

/** 一个运行中的 Agent 实例描述 */
export interface AgentInstance {
    /** 实例唯一 ID (如 "agent_explore_1_abc123") */
    id: string;
    /** Agent 模式 */
    type: AgentMode;
    /** 对应的任务节点 ID */
    taskNodeId: string;
    /** 实例状态 */
    status: AgentInstanceStatus;
    /** Token 消耗 */
    tokenUsage: TokenUsage;
    /** 步骤日志 */
    steps: AgentStep[];
}

/** 子 Agent 执行结果 */
export interface SubAgentResult {
    /** 对应的任务节点 ID */
    nodeId: string;
    /** 是否成功 */
    success: boolean;
    /** Agent 最终输出文本 */
    output: string;
    /** 失败时的错误 */
    error?: string;
    /** Token 消耗 */
    tokenUsage: TokenUsage;
    /** 该 Agent 写入的文件列表 */
    writtenFiles: string[];
    /** 执行步骤数 */
    stepCount: number;
}

// ─── Agent 注册表类型 ─────────────────────────────────────────────────────────

/** Agent 角色的工具预算等级 */
export type ToolBudget =
    | 'full'         // 全部工具
    | 'read_only'    // 只读工具
    | 'plan'         // 规划工具（只读 + todo + blueprint）
    | 'loc'          // 本地化工具（读写 + 搜索）
    | 'media_only';  // 媒体工具（mmx + convert + deploy）

/** Agent 角色配置描述 */
export interface AgentProfile {
    /** 映射到的 AgentMode */
    mode: AgentMode;
    /**
     * 建议使用的模型 — 仅作为默认值。
     * 如果为 undefined，则继承用户在设置面板配置的模型。
     * 用户可在 TaskNode.modelOverride 中显式覆盖。
     */
    suggestedModel?: string;
    /**
     * 建议使用的供应商 — 仅作为默认值。
     * 如果为 undefined，则继承用户在设置面板配置的供应商。
     */
    suggestedProvider?: string;
    /** 最大推理循环迭代次数 */
    maxIterations: number;
    /** 工具预算等级 */
    toolBudget: ToolBudget;
    /** 角色描述（用于 Orchestrator 的任务分解提示词） */
    description: string;
}

// ─── Orchestrator 类型 ────────────────────────────────────────────────────────

/** Orchestrator 执行结果 */
export interface OrchestratorResult {
    /** 是否全部成功 */
    success: boolean;
    /** 汇总输出 */
    summary: string;
    /** 各子 Agent 的结果 */
    agentResults: Map<string, SubAgentResult>;
    /** 总 Token 消耗 */
    totalTokenUsage: TokenUsage;
    /** 失败的节点 ID 列表 */
    failedNodes: string[];
    /** 被取消的节点 ID 列表 */
    cancelledNodes: string[];
}

/** Orchestrator 配置选项 */
export interface OrchestratorOptions {
    /** 最大并发 Agent 数（默认 4） */
    maxConcurrency?: number;
    /** 全局 Token 预算上限（超限后降级为串行） */
    globalTokenBudget?: number;
    /** 用户配置的供应商 ID（继承自设置面板） */
    providerId?: string;
    /** 用户配置的模型（继承自设置面板） */
    model?: string;
    /** 中止信号 */
    abortSignal?: AbortSignal;
    /** 话题 ID（用于检查点和工作目录） */
    topicId?: string;
    /** 步骤回调 */
    onStep?: (step: AgentStep) => void;
    /** 文件写入前的快照回调，用于向上传递给撤回系统 */
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    /** Todo 列表更新回调 */
    onTodoUpdate?: (todos: import('../types').TodoItem[]) => void;
}
