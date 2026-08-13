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
import { getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates } from '../workspacePaths';
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
    agentType: TaskNode['agentType'];
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
    handoff?: AgentHandoff;
}

export interface StoredOrchestration {
    version: 1;
    graphId: string;
    topicId?: string;
    runId?: string;
    domain: AgentRuntimeDomain;
    mode?: string;
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
    topicId?: string;
    runId?: string;
    domain: AgentRuntimeDomain;
    mode?: string;
    graph: TaskGraph;
    agentResults: Map<string, SubAgentResult>;
    blackboard: SerializedBlackboard;
    summary: string;
    totalTokenUsage: TokenUsage;
    qualityGate?: QualityGateResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStoredOrchestration(value: unknown): value is StoredOrchestration {
    if (!isRecord(value)) return false;
    if (value.version !== 1) return false;
    if (typeof value.graphId !== 'string' || typeof value.domain !== 'string') return false;
    if (!isRecord(value.graph) || !Array.isArray(value.graph.nodes)) return false;
    for (const node of value.graph.nodes) {
        if (!isRecord(node)) return false;
        if (typeof node.id !== 'string' || typeof node.prompt !== 'string') return false;
        if (!Array.isArray(node.dependencies) || typeof node.status !== 'string') return false;
    }
    if (!isRecord(value.agentResults) || !isRecord(value.blackboard)) return false;
    return typeof value.summary === 'string';
}

function serializeGraph(graph: TaskGraph): StoredGraph {
    const nodes: StoredTaskNode[] = [];
    for (const node of graph.nodes.values()) {
        nodes.push({
            id: node.id,
            agentType: node.agentType,
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
            agentType: node.agentType,
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
            handoff: entry.handoff,
        });
    }
    return results;
}

function safeGraphId(graphId: string): string {
    return graphId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function orchestrationDir(topicId: string | undefined): string {
    return path.join(getPrivateTopicStorageDir(topicId), 'orchestrations');
}

function orchestrationPath(topicId: string | undefined, graphId: string): string {
    return path.join(orchestrationDir(topicId), `${safeGraphId(graphId)}.json`);
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
        if (!getPrivateTopicStorageDir(input.topicId)) return false;
        const record: StoredOrchestration = {
            version: 1,
            graphId: input.graph.id,
            topicId: input.topicId,
            runId: input.runId,
            domain: input.domain,
            mode: input.mode,
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
        const target = orchestrationPath(input.topicId, input.graph.id);
        await atomicWriteJson(target, record);
        pruneOrchestrations(input.topicId);
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
    options?: { topicId?: string; domain?: AgentRuntimeDomain },
): StoredOrchestration | undefined {
    const topicId = options?.topicId;
    for (const dir of getPrivateTopicStorageDirCandidates(topicId)) {
        const candidate = path.join(dir, 'orchestrations', `${safeGraphId(graphId)}.json`);
        const loaded = readJsonWithBackup<StoredOrchestration>(candidate, isStoredOrchestration);
        if (!loaded) continue;
        const record = loaded.value;
        if (options?.domain && record.domain !== options.domain) continue;
        return record;
    }
    return undefined;
}

export function listOrchestrations(options: {
    topicId?: string;
    domain?: AgentRuntimeDomain;
    limit?: number;
}): StoredOrchestration[] {
    const limit = options.limit ?? 10;
    const records: StoredOrchestration[] = [];
    for (const dir of getPrivateTopicStorageDirCandidates(options.topicId)) {
        const dirPath = path.join(dir, 'orchestrations');
        let names: string[];
        try {
            names = fs.readdirSync(dirPath).filter(name => name.endsWith('.json'));
        } catch {
            continue;
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

function pruneOrchestrations(topicId: string | undefined): void {
    try {
        const dirPath = orchestrationDir(topicId);
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
