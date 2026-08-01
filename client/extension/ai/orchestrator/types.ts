/** 
* Eddy CWTool Code — Multi-Agent collaboration system type definition 
* 
* Defines all types required for task graphs, blackboard entries, Agent instances and coordinators. 
* Model selection inherits the supplier/model configured by the user in the settings panel and supports override by role. 
*/

import type {
    AcceptanceCheck,
    AgentMode,
    AgentStep,
    FeatureManifest,
    TaskEntityContract,
    TokenUsage,
    ReasoningEffort,
} from '../types';
import type { UserExecutionPolicy } from './userExecutionPolicy';
export type {
    AcceptanceCheck,
    AcceptanceCheckType,
    FeatureEdge,
    FeatureManifest,
    TaskEntityContract,
    TaskEntityKind,
    TaskEntityOperation,
} from '../types';

// ─── Blackboard entry type ──────────────────────────────────────────────────

/** Data type tag of blackboard entry */
export type BlackboardEntryType =
    | 'file_snapshot'      //File snapshot (path, content summary)
    | 'scope_info'         // Scope information (from query_scope)
    | 'diag_result'        // Diagnostic results (from get_diagnostics)
    | 'entity_registry'    // Entity Registry (Created ID → Creator Agent)
    | 'entity_relation'    // Producer/consumer relation between task entities
    | 'acceptance_evidence'// Stable acceptance result/evidence
    | 'write_intent'       // Write intent statement (Agent declares the file to be written)
    | 'free_text';         // Free text (generic KV storage)

/** An entry in the blackboard */
export interface BlackboardEntry {
    /** The unique key of the entry */
    key: string;
    /** Value of entry (serialized to string) */
    value: string;
    /** The data type label of the entry */
    type: BlackboardEntryType;
    /** Optimistic lock version number - incremented for each write */
    version: number;
    /** Write the Agent ID of this entry */
    authorAgentId: string;
    /** Write timestamp (Date.now()) */
    timestamp: number;
}

/** Blackboard writing result */
export interface BlackboardWriteResult {
    success: boolean;
    /** New version number after writing */
    newVersion?: number;
    /** Reason for failure (version conflict, etc.) */
    conflict?: string;
}

/** Serialized blackboard snapshot (for checkpoint) */
export interface SerializedBlackboard {
    entries: Array<[string, BlackboardEntry]>;
    timestamp: number;
}

// ─── Task graph type ───────────────────────────────────────────────────────────

/** Task node status */
export type TaskNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** Task priority */
export type TaskPriority = 'critical' | 'normal' | 'low';

/** A task node in DAG */
export interface TaskNode {
    /** Unique node ID (such as "explore_1", "build_events") */
    id: string;
    /** Agent mode to perform this task */
    agentType: AgentMode;
    /** Subtask description (user message as Agent) */
    prompt: string;
    /** File path or Blackboard Key list of injected context */
    contextFiles?: string[];
    /** Agent declares a list of files to be modified (for anti-conflict) */
    plannedFiles?: string[];
    /** Agent declares the list of entities to be modified (for anti-collision) */
    plannedEntities?: string[];
    /** Entity operations created by this task. */
    produces?: TaskEntityContract[];
    /** Entity operations this task expects to use. Producer dependencies are inferred from these. */
    consumes?: TaskEntityContract[];
    /** Node-local checks that must hold after integration. */
    acceptanceChecks?: AcceptanceCheck[];
    /** Pre-dependent task ID list - this node can only be executed after all are completed */
    dependencies: string[];
    /** Task priority */
    priority: TaskPriority;
    /** Current status */
    status: TaskNodeStatus;
    /** Execution result (Agent final output) */
    result?: string;
    /** Error message on failure */
    error?: string;

    // ── Resource control ──
    /** Override model selection (leave blank to inherit the user-configured supplier/model) */
    modelOverride?: string;
    /** Override supplier selection (leave blank to inherit user configuration) */
    providerOverride?: string;
    /** Explicit absolute maximum number of inference loop iterations. */
    maxIterations?: number;
    /** Retry count */
    retryCount: number;
    /** Maximum number of retries */
    maxRetries: number;

    // ── Runtime metadata ──
    /** Start execution time */
    startedAt?: number;
    /** Completion time */
    completedAt?: number;
    /** Token consumed by this node */
    tokenUsage?: TokenUsage;
    /** Stable Agent identity reused across retry/resume tasks. */
    agentId?: string;
    /** Latest Task-plane execution id for lineage. */
    lastTaskId?: string;
}

/** Task graph (DAG) */
export interface TaskGraph {
    /** Unique ID of the image */
    id: string;
    /** Node collection */
    nodes: Map<string, TaskNode>;
    /** Metadata */
    metadata: {
        /** Original user request */
        userPrompt: string;
        /** Creation time */
        createdAt: number;
        /** Optional machine-checkable feature contract for write-heavy script tasks. */
        featureManifest?: FeatureManifest;
        /** Host-derived user ownership and diagnostic preferences for this graph. */
        userExecutionPolicy?: UserExecutionPolicy;
    };
}

// ───Agent instance type ───────────────────────────────────────────────────────

/** Agent instance running status */
export type AgentInstanceStatus = 'idle' | 'running' | 'done' | 'failed';

/** Description of a running Agent instance */
export interface AgentInstance {
    /** Instance unique ID (such as "agent_explore_1_abc123") */
    id: string;
    /** Agent mode */
    type: AgentMode;
    /** Corresponding task node ID */
    taskNodeId: string;
    /** Instance status */
    status: AgentInstanceStatus;
    /** Token consumption */
    tokenUsage: TokenUsage;
    /** Step log */
    steps: AgentStep[];
}

/** Sub-Agent execution results */
export interface SubAgentResult {
    /** Corresponding task node ID */
    nodeId: string;
    /** Whether it was successful */
    success: boolean;
    /** Agent final output text */
    output: string;
    /** Error on failure */
    error?: string;
    /** Token consumption */
    tokenUsage: TokenUsage;
    /** List of files written by this Agent */
    writtenFiles: string[];
    /** Number of execution steps */
    stepCount: number;
    /** Durable child run whose transcript can seed a resumed Agent task. */
    runId?: string;
    /** Whether the sub-Agent is stopped early because it needs clarification from the main Agent/user */
    needsClarification?: boolean;
    /** Clarification content that needs to be processed by the main Agent */
    clarification?: string;
    /** Validated, structured parent-facing handoff. */
    handoff?: import('../runner/agentHandoff').AgentHandoff;
}

// ───Agent registry type ─────────────────────────────────────────────────────

/** Agent role’s tool budget level */
export type ToolBudget =
    | 'full'         // All tools
    | 'read_only'    // read-only tool
    | 'plan'         // Planning tools (read-only + todo + blueprint)
    | 'loc'          // Localization tools (read and write + search)
    | 'media_only';  // Media tools (mmx + convert + deploy)

/** Agent role configuration description */
export interface AgentProfile {
    /** AgentMode mapped to */
    mode: AgentMode;
    /** 
* Recommended model—default only. 
* If it is undefined, the model configured by the user in the settings panel will be inherited. 
* Users can explicitly override in TaskNode.modelOverride. 
*/
    suggestedModel?: string;
    /** 
* Recommended vendor - default only. 
* If undefined, the provider configured by the user in the settings panel will be inherited. 
*/
    suggestedProvider?: string;
    /** Healthy-progress iteration window used by this role. */
    maxIterations: number;
    /** Tool budget level */
    toolBudget: ToolBudget;
    /** Role description (task decomposition prompt word for Orchestrator) */
    description: string;
}

// ─── Orchestrator type ────────────────────────────────────────────────────

/** Orchestrator execution results */
export interface OrchestratorResult {
    /** Whether all are successful */
    success: boolean;
    /** Summary output */
    summary: string;
    /** Results of each sub-Agent */
    agentResults: Map<string, SubAgentResult>;
    /** Total Token consumption */
    totalTokenUsage: TokenUsage;
    /** List of failed node IDs */
    failedNodes: string[];
    /** List of canceled node IDs */
    cancelledNodes: string[];
    /** Final quality-gate result, when a gate was required. */
    qualityGate?: QualityGateResult;
}

/** Orchestrator configuration options */
export interface OrchestratorOptions {
    /** Capability domain inherited by every child Agent in this graph. */
    domain?: import('../types').AgentRuntimeDomain;
    /** Maximum number of concurrent Agents (default 4) */
    maxConcurrency?: number;
    /** Global Token budget upper limit (downgraded to serial after exceeding the limit) */
    globalTokenBudget?: number;
    /** User-configured vendor ID (inherited from settings panel) */
    providerId?: string;
    /** User configured model (inherited from settings panel) */
    model?: string;
    /** User configured reasoning level (inherited from the parent Agent run) */
    reasoningEffort?: ReasoningEffort;
    /** Abort signal */
    abortSignal?: AbortSignal;
    /** Topic ID (used for checkpoints and working directories) */
    topicId?: string;
    /** Parent durable run id for child agent threads. */
    parentRunId?: string;
    /** Whether the parent run belongs to an active durable goal. */
    durableGoal?: boolean;
    /** Force every child into a read-only tool surface for Explore-mode evidence fan-out. */
    readOnlyFanout?: boolean;
    /** The original top-level user turn, preserved across child execution. */
    originalUserMessage?: string;
    /** Host-enforced user ownership and warning policy. */
    userExecutionPolicy?: UserExecutionPolicy;
    /** Explicit parent event sink for orchestration events. */
    runEventSink?: import('../runner/runContext').RunEventSink;
    /** Step callback */
    onStep?: (step: AgentStep) => void;
    /** Snapshot callback before file writing, used to pass upward to the recall system */
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    /** Todo list update callback */
    onTodoUpdate?: import('../types').TodoUpdateCallback;
    /** Permission approval callback, the sub-Agent uses this callback to request permission from the user to perform sensitive operations */
    onPermissionRequest?: (id: string, tool: string, description: string, command?: string, context?: any) => Promise<boolean>;
}

/** Quality gate test results */
export interface QualityGateResult {
    passed: boolean;
    /** Reviewer execution failed or timed out before producing a trustworthy verdict. */
    operationalFailure?: boolean;
    diagnosticErrors: number;
    /** Files whose diagnostics were unavailable, stale, or still pending. */
    validationPending?: number;
    /** Integrated PDX files with confirmed EvidenceGate conflicts. */
    evidenceConflicts?: number;
    logicIssues: number;
    semanticIssues: number;
    acceptanceFailures: string[];
    filesChecked: string[];
    reviewReport: string;
    fixSuggestions?: string[];
    semanticReport?: string;
}

/** Agent running troubleshooting tracking data */
export interface AgentRunTrace {
    runId: string;
    agentId: string;
    type: AgentMode;
    status: AgentInstanceStatus;
    totalTimeMs: number;
    tokenUsage: TokenUsage;
    writtenFiles: string[];
    toolCalls: { name: string; timestamp: number; durationMs: number; error?: string }[];
    error?: string;
    retryCount: number;
    compactionCount: number;
}
