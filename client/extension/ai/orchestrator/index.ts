/**
 * Eddy CWTool Code — 多 Agent 协作系统模块导出
 *
 * 集中导出 orchestrator 包的所有公共 API。
 */

// 类型
export type {
    BlackboardEntry,
    BlackboardEntryType,
    BlackboardWriteResult,
    SerializedBlackboard,
    TaskNode,
    TaskNodeStatus,
    TaskPriority,
    TaskGraph,
    AgentInstance,
    AgentInstanceStatus,
    SubAgentResult,
    AgentProfile,
    ToolBudget,
    OrchestratorResult,
    OrchestratorOptions,
    QualityGateResult,
} from './types';

// 黑板系统
export { Blackboard } from './blackboard';
export type { BlackboardDisposable } from './blackboard';

// Agent 注册表
export { AGENT_REGISTRY, getAgentProfile, getAvailableRoles, getRoleDescriptions, applyUserModelOverrides } from './agentRegistry';

// DAG 任务图引擎
export { TaskGraphEngine } from './taskGraphEngine';

// 冲突检测器
export { ConflictDetector } from './conflictDetector';
export type { ConflictResult } from './conflictDetector';

// 质量门
export { QualityGate } from './qualityGate';
export type { QualityGateConfig } from './qualityGate';

// 并行执行器
export { ParallelExecutor } from './parallelExecutor';
export type { SubAgentExecutor } from './parallelExecutor';

// 协调器
export { Orchestrator } from './orchestrator';
