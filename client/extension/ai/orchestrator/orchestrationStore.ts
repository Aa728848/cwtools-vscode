/**
 * Durable orchestration store.
 *
 * Persists TaskGraph state, per-node SubAgentResults, and the blackboard
 * snapshot after each dispatch wave so `merge_results` can merge past waves
 * and `dispatch_agents` can resume a graph across tool calls (and sessions).
 * Best-effort: storage unavailability never fails a dispatch.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    TaskGraph,
    TaskNode,
    SubAgentResult,
    TaskEntityContract,
    AcceptanceCheck,
    QualityGateResult,
    SerializedBlackboard,
} from './types';
import type { UserExecutionPolicy } from './userExecutionPolicy';
import type { AgentRuntimeDomain, TokenUsage, FeatureManifest, ReasoningEffort } from '../types';
import type { AgentHandoff } from '../runner/agentHandoff';
import { atomicWriteJson, readJsonWithBackup } from '../runner/durableStorage';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';

/** Per-node raw output cap; handoffs stay complete because the quality gate consumes them. */
const MAX_STORED_OUTPUT_CHARS = 64 * 1024;
const MAX_STORED_CLARIFICATION_CHARS = 4 * 1024;
const MAX_CLARIFICATION_OPTIONS = 4;
const MAX_CLARIFICATION_OPTION_CHARS = 200;
const MAX_ORCHESTRATIONS_PER_TOPIC = 32;

export interface StoredTaskNode {
    id: string;
    profileName: TaskNode['profileName'];
    prompt: string;
    contextFiles?: string[];
    plannedFiles?: string[];
    plannedEntities?: string[];
    produces?: TaskEntityContract[];
    consumes?: TaskEntityContract[];
    acceptanceChecks?: AcceptanceCheck[];
    dependencies: string[];
    priority: TaskNode['priority'];
    status: TaskNode['status'];
    result?: string;
    error?: string;
    maxIterations?: number;
    modelOverride?: string;
    providerOverride?: string;
    reasoningEffort?: ReasoningEffort;
    retryCount: number;
    maxRetries: number;
    startedAt?: number;
    completedAt?: number;
    tokenUsage?: TokenUsage;
    agentId?: string;
    lastTaskId?: string;
    resumeContextRef?: string;
    pendingClarification?: string;
}

export interface StoredGraph {
    id: string;
    userPrompt: string;
    createdAt: number;
    featureManifest?: FeatureManifest;
    userExecutionPolicy?: UserExecutionPolicy;
    nodes: StoredTaskNode[];
}

export interface StoredSubAgentResult {
    nodeId: string;
    success: boolean;
    output: string;
    error?: string;
    tokenUsage: TokenUsage;
    writtenFiles: string[];
    stepCount: number;
    runId?: string;
    needsClarification?: boolean;
    clarification?: string;
    clarificationOptions?: string[];
    validationPending?: boolean;
    preservedAfterFailure?: boolean;
    handoff?: AgentHandoff;
}

export interface StoredOrchestration {
    version: 3;
    graphId: string;
    topicId?: string;
    runId?: string;
    domain: AgentRuntimeDomain;
    delegationDepth?: number;
    graph: StoredGraph;
    agentResults: Record<string, StoredSubAgentResult>;
    blackboard: SerializedBlackboard;
    summary: string;
    totalTokenUsage: TokenUsage;
    qualityGate?: QualityGateResult;
    complete: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface SaveOrchestrationInput {
    workspaceRoot?: string;
    topicId?: string;
    runId?: string;
    domain: AgentRuntimeDomain;
    delegationDepth?: number;
    graph: TaskGraph;
    agentResults: Map<string, SubAgentResult>;
    blackboard: SerializedBlackboard;
    summary: string;
    totalTokenUsage: TokenUsage;
    qualityGate?: QualityGateResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isTokenUsage(value: unknown): value is TokenUsage {
    return isRecord(value)
        && isFiniteNonNegative(value.total)
        && isFiniteNonNegative(value.input)
        && isFiniteNonNegative(value.output)
        && isFiniteNonNegative(value.estimatedCostCny);
}

const STORED_NODE_STATUSES = new Set<StoredTaskNode['status']>(['pending', 'running', 'done', 'failed', 'cancelled']);
const STORED_NODE_PRIORITIES = new Set<StoredTaskNode['priority']>(['critical', 'normal', 'low']);
function isStoredTaskNode(value: unknown): value is StoredTaskNode {
    if (!isRecord(value)) return false;
    return typeof value.id === 'string' && value.id.length > 0
        && typeof value.profileName === 'string' && value.profileName.length > 0
        && typeof value.prompt === 'string'
        && isStringArray(value.dependencies)
        && STORED_NODE_STATUSES.has(value.status as StoredTaskNode['status'])
        && STORED_NODE_PRIORITIES.has(value.priority as StoredTaskNode['priority'])
        && Number.isSafeInteger(value.retryCount) && (value.retryCount as number) >= 0
        && Number.isSafeInteger(value.maxRetries) && (value.maxRetries as number) >= 0
        && (value.contextFiles === undefined || isStringArray(value.contextFiles))
        && (value.plannedFiles === undefined || isStringArray(value.plannedFiles))
        && (value.plannedEntities === undefined || isStringArray(value.plannedEntities))
        && isOptionalString(value.result)
        && isOptionalString(value.error)
        && isOptionalString(value.agentId)
        && isOptionalString(value.lastTaskId)
        && isOptionalString(value.resumeContextRef)
        && isOptionalString(value.pendingClarification)
        && (value.tokenUsage === undefined || isTokenUsage(value.tokenUsage));
}

function isSerializedBlackboard(value: unknown): value is SerializedBlackboard {
    if (!isRecord(value) || !Array.isArray(value.entries) || !isFiniteNonNegative(value.timestamp)) return false;
    return value.entries.every(entry => Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === 'string' && isRecord(entry[1])
        && entry[1].key === entry[0] && typeof entry[1].value === 'string'
        && typeof entry[1].type === 'string' && Number.isSafeInteger(entry[1].version)
        && typeof entry[1].authorAgentId === 'string' && isFiniteNonNegative(entry[1].timestamp));
}

function isStoredSubAgentResult(value: unknown): value is StoredSubAgentResult {
    return isRecord(value)
        && typeof value.nodeId === 'string' && value.nodeId.length > 0
        && typeof value.success === 'boolean'
        && typeof value.output === 'string'
        && isTokenUsage(value.tokenUsage)
        && isStringArray(value.writtenFiles)
        && Number.isSafeInteger(value.stepCount) && (value.stepCount as number) >= 0
        && isOptionalString(value.error)
        && isOptionalString(value.runId)
        && isOptionalString(value.clarification);
}

function isStoredOrchestration(value: unknown): value is StoredOrchestration {
    if (!isRecord(value) || value.version !== 3) return false;
    if (typeof value.graphId !== 'string' || value.graphId.length === 0) return false;
    if (value.domain !== 'paradox' && value.domain !== 'general' && value.domain !== 'hybrid') return false;
    if (!isOptionalString(value.topicId) || !isOptionalString(value.runId)) return false;
    if (value.delegationDepth !== undefined
        && (!Number.isSafeInteger(value.delegationDepth) || (value.delegationDepth as number) < 0)) return false;
    if (!isRecord(value.graph) || value.graph.id !== value.graphId
        || typeof value.graph.userPrompt !== 'string'
        || !isFiniteNonNegative(value.graph.createdAt)
        || !Array.isArray(value.graph.nodes)
        || !value.graph.nodes.every(isStoredTaskNode)) return false;
    if (!isRecord(value.agentResults)
        || !Object.values(value.agentResults).every(isStoredSubAgentResult)
        || !isSerializedBlackboard(value.blackboard)
        || typeof value.summary !== 'string'
        || !isTokenUsage(value.totalTokenUsage)
        || typeof value.complete !== 'boolean'
        || !isFiniteNonNegative(value.createdAt)
        || !isFiniteNonNegative(value.updatedAt)) return false;
    return true;
}

export function serializeGraph(graph: TaskGraph): StoredGraph {
    const nodes: StoredTaskNode[] = [];
    for (const node of graph.nodes.values()) {
        nodes.push({
            id: node.id,
            profileName: node.profileName,
            prompt: node.prompt,
            contextFiles: node.contextFiles ? [...node.contextFiles] : undefined,
            plannedFiles: node.plannedFiles ? [...node.plannedFiles] : undefined,
            plannedEntities: node.plannedEntities ? [...node.plannedEntities] : undefined,
            produces: node.produces ? node.produces.map(c => ({ ...c })) : undefined,
            consumes: node.consumes ? node.consumes.map(c => ({ ...c })) : undefined,
            acceptanceChecks: node.acceptanceChecks ? node.acceptanceChecks.map(c => ({ ...c })) : undefined,
            dependencies: [...node.dependencies],
            priority: node.priority,
            status: node.status,
            result: node.result,
            error: node.error,
            maxIterations: node.maxIterations,
            modelOverride: node.modelOverride,
            providerOverride: node.providerOverride,
            reasoningEffort: node.reasoningEffort,
            retryCount: node.retryCount,
            maxRetries: node.maxRetries,
            startedAt: node.startedAt,
            completedAt: node.completedAt,
            tokenUsage: node.tokenUsage ? { ...node.tokenUsage } : undefined,
            agentId: node.agentId,
            lastTaskId: node.lastTaskId,
            resumeContextRef: node.resumeContextRef,
            pendingClarification: node.pendingClarification && node.pendingClarification.length > MAX_STORED_CLARIFICATION_CHARS
                ? node.pendingClarification.slice(0, MAX_STORED_CLARIFICATION_CHARS)
                : node.pendingClarification,
        });
    }
    return {
        id: graph.id,
        userPrompt: graph.metadata.userPrompt,
        createdAt: graph.metadata.createdAt,
        featureManifest: graph.metadata.featureManifest,
        userExecutionPolicy: graph.metadata.userExecutionPolicy,
        nodes,
    };
}

export function deserializeGraph(stored: StoredGraph): TaskGraph {
    const nodes = new Map<string, TaskNode>();
    for (const node of stored.nodes) {
        nodes.set(node.id, {
            id: node.id,
            profileName: node.profileName,
            prompt: node.prompt,
            contextFiles: node.contextFiles ? [...node.contextFiles] : undefined,
            plannedFiles: node.plannedFiles ? [...node.plannedFiles] : undefined,
            plannedEntities: node.plannedEntities ? [...node.plannedEntities] : undefined,
            produces: node.produces ? node.produces.map(c => ({ ...c })) : undefined,
            consumes: node.consumes ? node.consumes.map(c => ({ ...c })) : undefined,
            acceptanceChecks: node.acceptanceChecks ? node.acceptanceChecks.map(c => ({ ...c })) : undefined,
            dependencies: [...node.dependencies],
            priority: node.priority,
            status: node.status,
            result: node.result,
            error: node.error,
            maxIterations: node.maxIterations,
            modelOverride: node.modelOverride,
            providerOverride: node.providerOverride,
            reasoningEffort: node.reasoningEffort,
            retryCount: node.retryCount,
            maxRetries: node.maxRetries,
            startedAt: node.startedAt,
            completedAt: node.completedAt,
            tokenUsage: node.tokenUsage ? { ...node.tokenUsage } : undefined,
            agentId: node.agentId,
            lastTaskId: node.lastTaskId,
            resumeContextRef: node.resumeContextRef,
            pendingClarification: node.pendingClarification,
        });
    }
    return {
        id: stored.id,
        nodes,
        metadata: {
            userPrompt: stored.userPrompt,
            createdAt: stored.createdAt,
            featureManifest: stored.featureManifest,
            userExecutionPolicy: stored.userExecutionPolicy,
        },
    };
}

export function serializeAgentResults(agentResults: Map<string, SubAgentResult>): Record<string, StoredSubAgentResult> {
    const stored: Record<string, StoredSubAgentResult> = {};
    for (const [nodeId, result] of agentResults) {
        stored[nodeId] = {
            nodeId: result.nodeId,
            success: result.success,
            output: result.output.length > MAX_STORED_OUTPUT_CHARS
                ? result.output.slice(0, MAX_STORED_OUTPUT_CHARS)
                : result.output,
            error: result.error,
            tokenUsage: { ...result.tokenUsage },
            writtenFiles: [...result.writtenFiles],
            stepCount: result.stepCount,
            runId: result.runId,
            needsClarification: result.needsClarification,
            clarification: result.clarification && result.clarification.length > MAX_STORED_CLARIFICATION_CHARS
                ? result.clarification.slice(0, MAX_STORED_CLARIFICATION_CHARS)
                : result.clarification,
            clarificationOptions: result.clarificationOptions
                ? result.clarificationOptions
                    .map(option => option.trim())
                    .filter(option => option.length > 0)
                    .filter((option, index, all) => all.indexOf(option) === index)
                    .slice(0, MAX_CLARIFICATION_OPTIONS)
                    .map(option => option.length > MAX_CLARIFICATION_OPTION_CHARS
                        ? option.slice(0, MAX_CLARIFICATION_OPTION_CHARS)
                        : option)
                : undefined,
            validationPending: result.validationPending,
            preservedAfterFailure: result.preservedAfterFailure,
            handoff: result.handoff,
        };
    }
    return stored;
}

export function deserializeAgentResults(stored: Record<string, StoredSubAgentResult>): Map<string, SubAgentResult> {
    const results = new Map<string, SubAgentResult>();
    for (const entry of Object.values(stored)) {
        results.set(entry.nodeId, {
            nodeId: entry.nodeId,
            success: entry.success,
            output: entry.output,
            error: entry.error,
            tokenUsage: { ...entry.tokenUsage },
            writtenFiles: [...entry.writtenFiles],
            stepCount: entry.stepCount,
            runId: entry.runId,
            needsClarification: entry.needsClarification,
            clarification: entry.clarification,
            clarificationOptions: entry.clarificationOptions,
            validationPending: entry.validationPending,
            preservedAfterFailure: entry.preservedAfterFailure,
            handoff: entry.handoff,
        });
    }
    return results;
}

function safeGraphId(graphId: string): string {
    return graphId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function orchestrationDir(topicId: string | undefined, workspaceRoot = ''): string {
    return path.join(getPrivateTopicStorageDir(topicId, workspaceRoot), 'orchestrations');
}

function orchestrationPath(topicId: string | undefined, graphId: string, workspaceRoot = ''): string {
    return path.join(orchestrationDir(topicId, workspaceRoot), `${safeGraphId(graphId)}.json`);
}

function isGraphComplete(graph: TaskGraph): boolean {
    for (const node of graph.nodes.values()) {
        if (node.status === 'pending' || node.status === 'running') return false;
    }
    return true;
}

/** Best-effort: returns false when private storage is unavailable. */
export async function saveOrchestration(input: SaveOrchestrationInput): Promise<boolean> {
    try {
        if (!getPrivateTopicStorageDir(input.topicId, input.workspaceRoot)) return false;
        const record: StoredOrchestration = {
            version: 3,
            graphId: input.graph.id,
            topicId: input.topicId,
            runId: input.runId,
            domain: input.domain,
            delegationDepth: input.delegationDepth,
            graph: serializeGraph(input.graph),
            agentResults: serializeAgentResults(input.agentResults),
            blackboard: input.blackboard,
            summary: input.summary,
            totalTokenUsage: { ...input.totalTokenUsage },
            qualityGate: input.qualityGate,
            complete: isGraphComplete(input.graph),
            createdAt: input.graph.metadata.createdAt,
            updatedAt: Date.now(),
        };
        const target = orchestrationPath(input.topicId, input.graph.id, input.workspaceRoot);
        await atomicWriteJson(target, record);
        pruneOrchestrations(input.topicId, input.workspaceRoot);
        return true;
    } catch (error) {
        ErrorReporter.debug(
            SOURCE.ORCHESTRATOR,
            `saveOrchestration failed for ${input.graph.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}

export function loadOrchestration(
    graphId: string,
    options?: { topicId?: string; domain?: AgentRuntimeDomain; workspaceRoot?: string },
): StoredOrchestration | undefined {
    const topicId = options?.topicId;
    const dir = getPrivateTopicStorageDir(topicId, options?.workspaceRoot);
    if (!dir) return undefined;
    const candidate = path.join(dir, 'orchestrations', `${safeGraphId(graphId)}.json`);
    const loaded = readJsonWithBackup<StoredOrchestration>(candidate, isStoredOrchestration);
    if (!loaded) return undefined;
    const record = loaded.value;
    return options?.domain && record.domain !== options.domain ? undefined : record;
}

export function listOrchestrations(options: {
    topicId?: string;
    domain?: AgentRuntimeDomain;
    limit?: number;
    workspaceRoot?: string;
}): StoredOrchestration[] {
    const limit = options.limit ?? 10;
    const records: StoredOrchestration[] = [];
    const dir = getPrivateTopicStorageDir(options.topicId, options.workspaceRoot);
    if (!dir) return records;
    const dirPath = path.join(dir, 'orchestrations');
    let names: string[];
    try {
        names = fs.readdirSync(dirPath).filter(name => name.endsWith('.json'));
    } catch {
        return records;
    }
    for (const name of names) {
        const loaded = readJsonWithBackup<StoredOrchestration>(
            path.join(dirPath, name),
            isStoredOrchestration,
        );
        if (!loaded) continue;
        const record = loaded.value;
        if (options.domain && record.domain !== options.domain) continue;
        records.push(record);
    }
    const seen = new Set<string>();
    const unique = records
        .filter(record => {
            const key = `${record.topicId ?? ''}\u0000${record.graphId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.graphId < b.graphId ? -1 : 1));
    return unique.slice(0, limit);
}

function pruneOrchestrations(topicId: string | undefined, workspaceRoot = ''): void {
    try {
        const dirPath = orchestrationDir(topicId, workspaceRoot);
        const entries = fs.readdirSync(dirPath)
            .filter(name => name.endsWith('.json'))
            .map(name => {
                const filePath = path.join(dirPath, name);
                try {
                    return { name, mtime: fs.statSync(filePath).mtimeMs };
                } catch {
                    return undefined;
                }
            })
            .filter((entry): entry is { name: string; mtime: number } => !!entry)
            .sort((a, b) => b.mtime - a.mtime);
        for (const entry of entries.slice(MAX_ORCHESTRATIONS_PER_TOPIC)) {
            fs.rmSync(path.join(dirPath, entry.name), { force: true });
            fs.rmSync(`${path.join(dirPath, entry.name)}.bak`, { force: true });
        }
    } catch {
        // Pruning is best-effort.
    }
}
