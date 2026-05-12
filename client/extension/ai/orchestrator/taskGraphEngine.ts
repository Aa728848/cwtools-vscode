/**
 * Eddy CWTool Code — DAG 任务图引擎
 *
 * 管理 TaskGraph 的拓扑排序、就绪节点计算、状态转换和循环依赖检测。
 * 这是多 Agent 协作系统的调度核心。
 */

import type { TaskGraph, TaskNode, TaskNodeStatus, TaskPriority } from './types';

/**
 * DAG 任务图引擎。
 *
 * 提供以下能力：
 * 1. 拓扑排序 — 将 DAG 分层，同层节点无依赖可并行
 * 2. 就绪节点查询 — 获取所有依赖已完成的待执行节点
 * 3. 状态转换 — 标记完成/失败，并级联取消下游节点
 * 4. 循环依赖检测 — 在执行前验证图的合法性
 */
export class TaskGraphEngine {

    /**
     * 拓扑排序 — 将任务图分层。
     * 返回二维数组：外层是层级（0 = 无依赖的根节点），内层是该层可并行的节点。
     *
     * @throws Error 如果检测到循环依赖
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

        // 不断提取入度为 0 的节点，直到全部节点被分配
        let remaining = new Set(graph.nodes.keys());
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
                // 不应该发生（已通过 detectCycles 检查），但作为安全网
                throw new Error('拓扑排序失败: 剩余节点均有未满足的依赖');
            }

            for (const node of layer) {
                completed.add(node.id);
                remaining.delete(node.id);
            }

            // 按优先级排序：critical > normal > low
            layer.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
            layers.push(layer);
        }

        return layers;
    }

    /**
     * 获取当前所有可执行的节点（依赖已满足且状态为 pending）。
     * 这是调度器每轮循环调用的核心方法。
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
        // 按优先级排序
        ready.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
        return ready;
    }

    /**
     * 标记节点为完成状态。
     * @returns 新变为就绪的下游节点列表
     */
    markComplete(graph: TaskGraph, nodeId: string, result: string): TaskNode[] {
        const node = graph.nodes.get(nodeId);
        if (!node) return [];

        node.status = 'done';
        node.result = result;
        node.completedAt = Date.now();

        // 检查是否有新的下游节点变为就绪
        return this.getReadyNodes(graph);
    }

    /**
     * 标记节点为失败状态，并级联取消所有下游依赖。
     * @returns 被取消的节点 ID 列表
     */
    markFailed(graph: TaskGraph, nodeId: string, error: string): string[] {
        const node = graph.nodes.get(nodeId);
        if (!node) return [];

        node.status = 'failed';
        node.error = error;
        node.completedAt = Date.now();

        // 级联取消所有直接和间接依赖该节点的下游节点
        const cancelled: string[] = [];
        const toCancel = new Set<string>();

        // BFS 查找所有下游
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
     * 标记节点为运行中状态。
     */
    markRunning(graph: TaskGraph, nodeId: string): void {
        const node = graph.nodes.get(nodeId);
        if (node) {
            node.status = 'running';
            node.startedAt = Date.now();
        }
    }

    /**
     * 检测循环依赖。
     * @returns 循环路径数组（如果有），或 null（无循环）
     */
    detectCycles(graph: TaskGraph): string[][] | null {
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const cycles: string[][] = [];

        const dfs = (nodeId: string, path: string[]): boolean => {
            if (inStack.has(nodeId)) {
                // 找到循环 — 提取循环部分
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
     * 检查图是否全部完成（所有节点都是 done/failed/cancelled）。
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
     * 获取图的执行进度摘要。
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
     * 创建一个空的任务图。
     */
    static createGraph(userPrompt: string): TaskGraph {
        return {
            id: `tg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            nodes: new Map(),
            metadata: {
                userPrompt,
                createdAt: Date.now(),
            },
        };
    }

    /**
     * 向任务图添加一个节点。
     */
    static addNode(
        graph: TaskGraph,
        id: string,
        agentType: TaskNode['agentType'],
        prompt: string,
        options?: {
            contextFiles?: string[];
            dependencies?: string[];
            priority?: TaskPriority;
            maxIterations?: number;
            maxRetries?: number;
            modelOverride?: string;
            providerOverride?: string;
        },
    ): TaskNode {
        const node: TaskNode = {
            id,
            agentType,
            prompt,
            contextFiles: options?.contextFiles,
            dependencies: options?.dependencies ?? [],
            priority: options?.priority ?? 'normal',
            status: 'pending',
            maxIterations: options?.maxIterations,
            retryCount: 0,
            maxRetries: options?.maxRetries ?? 2,
            modelOverride: options?.modelOverride,
            providerOverride: options?.providerOverride,
        };
        graph.nodes.set(id, node);
        return node;
    }
}

/** 优先级权重 */
function priorityWeight(priority: TaskPriority): number {
    switch (priority) {
        case 'critical': return 3;
        case 'normal': return 2;
        case 'low': return 1;
    }
}
