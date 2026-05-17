/** 
* Eddy CWTool Code — Multi-Agent collaboration system module export 
* 
* Centrally export all public APIs of the orchestrator package. 
*/

// type
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

// blackboard system
export { Blackboard } from './blackboard';
export type { BlackboardDisposable } from './blackboard';

//Agent registry
export { AGENT_REGISTRY, getAgentProfile, getAvailableRoles, getRoleDescriptions, applyUserModelOverrides } from './agentRegistry';

// DAG task graph engine
export { TaskGraphEngine } from './taskGraphEngine';

// conflict detector
export { ConflictDetector } from './conflictDetector';
export type { ConflictResult } from './conflictDetector';

// quality gate
export { QualityGate } from './qualityGate';
export type { QualityGateConfig } from './qualityGate';

// Parallel executor
export { ParallelExecutor } from './parallelExecutor';
export type { SubAgentExecutor } from './parallelExecutor';

// coordinator
export { Orchestrator } from './orchestrator';
