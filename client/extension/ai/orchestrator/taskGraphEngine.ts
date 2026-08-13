/** 
* Eddy CWTool Code — DAG task graph engine 
* 
* Manage TaskGraph's topological sorting, ready node calculations, state transitions, and circular dependency detection. 
* This is the scheduling core of the multi-Agent collaboration system. 
*/

import type {
    AcceptanceCheck,
    FeatureManifest,
    TaskEntityContract,
    TaskGraph,
    TaskNode,
    TaskPriority,
} from './types';
import { isReasoningEffort } from '../types';

/** 
* DAG task graph engine. 
* 
* Provides the following capabilities: 
* 1. Topological sorting - layer DAG, and nodes on the same layer can be parallelized without dependencies 
* 2. Ready node query - obtain all pending nodes whose dependencies have been completed 
* 3. State transition - mark completion/failure, and cascade cancellation of downstream nodes 
* 4. Circular dependency detection - verify the legality of the graph before execution 
*/
export class TaskGraphEngine {

    /** 
* Topological sorting - layering the task graph. 
* Returns a two-dimensional array: the outer layer is the level (0 = root node with no dependencies), and the inner layer is the parallelized nodes of this layer. 
* 
* @throws Error if circular dependency is detected 
*/
    topologicalSort(graph: TaskGraph): TaskNode[][] {
        const cycles = this.detectCycles(graph);
        if (cycles) {
            throw new Error(
                `任务图存在循环依赖: ${cycles.map(c => c.join(' → ')).join('; ')}`
            );
        }

        const layers: TaskNode[][] = [];
        const completed = new Set<string>();

        //Continuously extract nodes with in-degree 0 until all nodes are allocated
        const remaining = new Set(graph.nodes.keys());
        while (remaining.size > 0) {
            const layer: TaskNode[] = [];
            for (const nodeId of remaining) {
                const node = graph.nodes.get(nodeId)!;
                const allDepsCompleted = node.dependencies.every(
                    dep => completed.has(dep)
                );
                if (allDepsCompleted) {
                    layer.push(node);
                }
            }

            if (layer.length === 0) {
                // Shouldn't happen (passed detectCycles check), but serves as a safety net
                throw new Error('拓扑排序失败: 剩余节点均有未满足的依赖');
            }

            for (const node of layer) {
                completed.add(node.id);
                remaining.delete(node.id);
            }

            // Sort by priority: critical > normal > low
            layer.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
            layers.push(layer);
        }

        return layers;
    }

    /** 
* Get all currently executable nodes (dependencies are satisfied and the status is pending). 
* This is the core method called by the scheduler in each round of loop. 
*/
    getReadyNodes(graph: TaskGraph): TaskNode[] {
        const ready: TaskNode[] = [];
        for (const node of graph.nodes.values()) {
            if (node.status !== 'pending') continue;
            const allDepsDone = node.dependencies.every(depId => {
                const dep = graph.nodes.get(depId);
                return dep?.status === 'done';
            });
            if (allDepsDone) ready.push(node);
        }
        // Sort by priority
        ready.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
        return ready;
    }

    /** 
* Mark the node as complete. 
* @returns List of newly ready downstream nodes 
*/
    markComplete(graph: TaskGraph, nodeId: string, result: string): TaskNode[] {
        const node = graph.nodes.get(nodeId);
        if (!node) return [];

        node.status = 'done';
        node.result = result;
        node.completedAt = Date.now();

        // Check if a new downstream node has become ready
        return this.getReadyNodes(graph);
    }

    /** 
* Mark the node as failed and cascade cancel all downstream dependencies. 
* @returns list of canceled node IDs 
*/
    markFailed(graph: TaskGraph, nodeId: string, error: string): string[] {
        const node = graph.nodes.get(nodeId);
        if (!node) return [];

        node.status = 'failed';
        node.error = error;
        node.completedAt = Date.now();

        // Cascade cancel all downstream nodes that directly and indirectly depend on this node
        const cancelled: string[] = [];
        const toCancel = new Set<string>();

        // BFS finds all downstream
        const queue = [nodeId];
        while (queue.length > 0) {
            const currentId = queue.shift()!;
            for (const [otherId, otherNode] of graph.nodes) {
                if (otherNode.dependencies.includes(currentId) && !toCancel.has(otherId)) {
                    toCancel.add(otherId);
                    queue.push(otherId);
                }
            }
        }

        for (const cancelId of toCancel) {
            const cancelNode = graph.nodes.get(cancelId);
            if (cancelNode && cancelNode.status === 'pending') {
                cancelNode.status = 'cancelled';
                cancelNode.error = `前置任务 ${nodeId} 失败，已取消`;
                cancelled.push(cancelId);
            }
        }

        return cancelled;
    }

    /** 
* Mark the node as running status. 
*/
    markRunning(graph: TaskGraph, nodeId: string): void {
        const node = graph.nodes.get(nodeId);
        if (node) {
            node.status = 'running';
            node.startedAt = Date.now();
        }
    }

    /** 
* Detect circular dependencies. 
* @returns array of loop paths (if any), or null (no loop) 
*/
    detectCycles(graph: TaskGraph): string[][] | null {
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const cycles: string[][] = [];

        const dfs = (nodeId: string, path: string[]): boolean => {
            if (inStack.has(nodeId)) {
                // Find the loop - extract the loop part
                const cycleStart = path.indexOf(nodeId);
                cycles.push([...path.slice(cycleStart), nodeId]);
                return true;
            }
            if (visited.has(nodeId)) return false;

            visited.add(nodeId);
            inStack.add(nodeId);
            path.push(nodeId);

            const node = graph.nodes.get(nodeId);
            if (node) {
                for (const depId of node.dependencies) {
                    if (graph.nodes.has(depId)) {
                        dfs(depId, path);
                    }
                }
            }

            path.pop();
            inStack.delete(nodeId);
            return false;
        };

        for (const nodeId of graph.nodes.keys()) {
            if (!visited.has(nodeId)) {
                dfs(nodeId, []);
            }
        }

        return cycles.length > 0 ? cycles : null;
    }

    /** 
* Check whether the graph is fully completed (all nodes are done/failed/cancelled). 
*/
    isComplete(graph: TaskGraph): boolean {
        for (const node of graph.nodes.values()) {
            if (node.status === 'pending' || node.status === 'running') {
                return false;
            }
        }
        return true;
    }

    /** 
* Get the execution progress summary of the graph. 
*/
    getProgressSummary(graph: TaskGraph): {
        total: number;
        pending: number;
        running: number;
        done: number;
        failed: number;
        cancelled: number;
    } {
        let pending = 0, running = 0, done = 0, failed = 0, cancelled = 0;
        for (const node of graph.nodes.values()) {
            switch (node.status) {
                case 'pending': pending++; break;
                case 'running': running++; break;
                case 'done': done++; break;
                case 'failed': failed++; break;
                case 'cancelled': cancelled++; break;
            }
        }
        return { total: graph.nodes.size, pending, running, done, failed, cancelled };
    }

    /**
     * Add producer dependencies implied by entity contracts. This turns the
     * task list into a data-flow DAG instead of relying only on model-authored
     * dependency IDs.
     */
    static linkEntityDependencies(graph: TaskGraph): void {
        const producers = new Map<string, string[]>();
        for (const node of graph.nodes.values()) {
            for (const contract of node.produces ?? []) {
                const key = TaskGraphEngine.entityContractKey(contract);
                const owners = producers.get(key) ?? [];
                owners.push(node.id);
                producers.set(key, owners);
            }
        }

        for (const node of graph.nodes.values()) {
            const dependencies = new Set(node.dependencies);
            for (const contract of node.consumes ?? []) {
                for (const producerId of producers.get(TaskGraphEngine.entityContractKey(contract)) ?? []) {
                    if (producerId !== node.id) dependencies.add(producerId);
                }
            }
            node.dependencies = [...dependencies];
        }
    }

    private static entityContractKey(contract: TaskEntityContract): string {
        return `${contract.kind}:${contract.id.trim().toLowerCase()}`;
    }

    /** 
* Create an empty task graph. 
*/
    static createGraph(userPrompt: string, featureManifest?: FeatureManifest): TaskGraph {
        return {
            id: `tg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            nodes: new Map(),
            metadata: {
                userPrompt,
                createdAt: Date.now(),
                featureManifest,
            },
        };
    }

    /** 
* Add a node to the task graph. 
*/
    static addNode(
        graph: TaskGraph,
        id: string,
        agentType: TaskNode['agentType'],
        prompt: string,
        options?: {
            contextFiles?: string[];
            plannedFiles?: string[];
            plannedEntities?: string[];
            produces?: TaskEntityContract[];
            consumes?: TaskEntityContract[];
            acceptanceChecks?: AcceptanceCheck[];
            dependencies?: string[];
            priority?: TaskPriority;
            maxIterations?: number;
            maxRetries?: number;
            modelOverride?: string;
            providerOverride?: string;
            reasoningEffort?: import('../types').ReasoningEffort;
        },
    ): TaskNode {
        const contractEntities = (options?.produces ?? []).map(contract => `${contract.kind}:${contract.id}`);
        const node: TaskNode = {
            id,
            agentType,
            prompt,
            contextFiles: options?.contextFiles,
            plannedFiles: options?.plannedFiles,
            plannedEntities: [...new Set([...(options?.plannedEntities ?? []), ...contractEntities])],
            produces: options?.produces,
            consumes: options?.consumes,
            acceptanceChecks: options?.acceptanceChecks,
            dependencies: options?.dependencies ?? [],
            priority: options?.priority ?? 'normal',
            status: 'pending',
            maxIterations: options?.maxIterations,
            retryCount: 0,
            maxRetries: options?.maxRetries ?? 2,
            modelOverride: options?.modelOverride,
            providerOverride: options?.providerOverride,
            reasoningEffort: options?.reasoningEffort,
        };
        graph.nodes.set(id, node);
        return node;
    }
}

/** Priority weight */
function priorityWeight(priority: TaskPriority): number {
    switch (priority) {
        case 'critical': return 3;
        case 'normal': return 2;
        case 'low': return 1;
    }
}

/**
 * Map the model-visible dispatch task fields onto the internal selection
 * vocabulary. The model-facing schema exposes `model`/`provider`; persisted
 * blueprints and host-side callers may still carry `modelOverride` /
 * `providerOverride`, so both spellings are accepted with the schema names
 * winning. Without this boundary mapping the schema values would be silently
 * ignored downstream.
 */
export function mapTaskModelSelection(task: {
    model?: unknown;
    modelOverride?: unknown;
    provider?: unknown;
    providerOverride?: unknown;
    reasoningEffort?: unknown;
}): { model?: unknown; provider?: unknown; reasoningEffort?: unknown } {
    return {
        model: task.model ?? task.modelOverride,
        provider: task.provider ?? task.providerOverride,
        reasoningEffort: task.reasoningEffort,
    };
}

/**
 * Validate the model-visible per-task model selection fields before they
 * reach TaskNode. Provider must name a configured built-in provider so a
 * typo cannot silently fall back to a different vendor mid-graph. On success
 * the normalized values are returned for direct node construction.
 */
export function validateNodeModelSelection(input: {
    model?: unknown;
    provider?: unknown;
    reasoningEffort?: unknown;
}, knownProviderIds: ReadonlySet<string>):
    | { ok: true; model?: string; provider?: string; reasoningEffort?: import('../types').ReasoningEffort }
    | { ok: false; error: string } {
    const result: { model?: string; provider?: string; reasoningEffort?: import('../types').ReasoningEffort } = {};
    if (input.model !== undefined) {
        if (typeof input.model !== 'string' || input.model.trim().length === 0 || input.model.trim().length > 120) {
            return { ok: false, error: 'Task model must be a non-empty model id of at most 120 characters.' };
        }
        result.model = input.model.trim();
    }
    if (input.provider !== undefined) {
        if (typeof input.provider !== 'string' || input.provider.trim().length === 0 || input.provider.trim().length > 64) {
            return { ok: false, error: 'Task provider must be a non-empty provider id of at most 64 characters.' };
        }
        const trimmed = input.provider.trim();
        if (!knownProviderIds.has(trimmed)) {
            return { ok: false, error: `Task provider '${trimmed}' is not a configured built-in provider.` };
        }
        result.provider = trimmed;
    }
    if (input.reasoningEffort !== undefined) {
        if (!isReasoningEffort(input.reasoningEffort)) {
            return { ok: false, error: 'Task reasoningEffort must be one of none, minimal, low, medium, high, xhigh, max.' };
        }
        result.reasoningEffort = input.reasoningEffort;
    }
    return { ok: true, ...result };
}
