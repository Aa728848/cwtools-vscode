/**
 * Eddy CWTool Code — 冲突检测器
 *
 * 在多 Agent 并行执行时，检测文件写入冲突和语义冲突。
 * 通过 Blackboard 的 write_intent 条目实现意图声明。
 */

import { Blackboard } from './blackboard';

/** 冲突检测结果 */
export interface ConflictResult {
    /** 是否存在冲突 */
    hasConflict: boolean;
    /** 冲突类型 */
    conflictType?: 'file_write' | 'entity_id';
    /** 冲突对方 Agent ID */
    conflictAgentId?: string;
    /** 冲突详情 */
    details?: string;
}

/**
 * 冲突检测器。
 *
 * 工作原理：
 * 1. Agent 在写入文件前通过 declareIntent 声明写入意图
 * 2. 其他 Agent 在写入前调用 checkWriteConflict 检查是否有冲突
 * 3. Agent 完成后调用 clearIntent 清除意图声明
 *
 * 这是在 PartitionedWriteQueue 之上的语义层冲突检测 —
 * 写队列保证了物理层面的串行化，冲突检测器防止逻辑层面的重复工作。
 */
export class ConflictDetector {
    /** 写入意图在 Blackboard 中的 key 前缀 */
    private static readonly INTENT_PREFIX = '__intent:';
    /** 实体注册在 Blackboard 中的 key 前缀 */
    private static readonly ENTITY_PREFIX = '__entity:';

    /**
     * 检查 Agent 的写入意图是否与其他运行中 Agent 冲突。
     *
     * @param agentId 当前 Agent ID
     * @param filePath 目标文件路径
     * @param blackboard 共享黑板
     */
    checkWriteConflict(
        agentId: string,
        filePath: string,
        blackboard: Blackboard,
    ): ConflictResult {
        const intentKey = ConflictDetector.INTENT_PREFIX + filePath;
        const existing = blackboard.read(intentKey);

        if (existing && existing.authorAgentId !== agentId) {
            return {
                hasConflict: true,
                conflictType: 'file_write',
                conflictAgentId: existing.authorAgentId,
                details: `文件 ${filePath} 已被 Agent ${existing.authorAgentId} 声明写入意图`,
            };
        }

        return { hasConflict: false };
    }

    /**
     * 检查实体 ID 是否已被其他 Agent 创建。
     *
     * @param agentId 当前 Agent ID
     * @param entityId 实体 ID (如 event namespace.1)
     * @param blackboard 共享黑板
     */
    checkEntityConflict(
        agentId: string,
        entityId: string,
        blackboard: Blackboard,
    ): ConflictResult {
        const entityKey = ConflictDetector.ENTITY_PREFIX + entityId;
        const existing = blackboard.read(entityKey);

        if (existing && existing.authorAgentId !== agentId) {
            return {
                hasConflict: true,
                conflictType: 'entity_id',
                conflictAgentId: existing.authorAgentId,
                details: `实体 ${entityId} 已被 Agent ${existing.authorAgentId} 注册`,
            };
        }

        return { hasConflict: false };
    }

    /**
     * Agent 写入前声明意图。
     *
     * @param agentId Agent ID
     * @param filePaths 即将写入的文件路径列表
     * @param blackboard 共享黑板
     */
    declareIntent(
        agentId: string,
        filePaths: string[],
        blackboard: Blackboard,
    ): void {
        for (const fp of filePaths) {
            const intentKey = ConflictDetector.INTENT_PREFIX + fp;
            blackboard.write(intentKey, fp, 'write_intent', agentId);
        }
    }

    /**
     * Agent 创建实体后注册到黑板。
     *
     * @param agentId Agent ID
     * @param entityIds 已创建的实体 ID 列表
     * @param blackboard 共享黑板
     */
    registerEntities(
        agentId: string,
        entityIds: string[],
        blackboard: Blackboard,
    ): void {
        for (const eid of entityIds) {
            const entityKey = ConflictDetector.ENTITY_PREFIX + eid;
            blackboard.write(entityKey, eid, 'entity_registry', agentId);
        }
    }

    /**
     * Agent 完成后清除写入意图声明。
     *
     * @param agentId Agent ID
     * @param blackboard 共享黑板
     */
    clearIntent(agentId: string, blackboard: Blackboard): void {
        const intents = blackboard.queryByPrefix(ConflictDetector.INTENT_PREFIX);
        for (const entry of intents) {
            if (entry.authorAgentId === agentId) {
                blackboard.delete(entry.key);
            }
        }
    }

    /**
     * 获取所有当前活跃的写入意图（用于调试和 UI 展示）。
     */
    getActiveIntents(blackboard: Blackboard): Array<{ agentId: string; filePath: string }> {
        const intents = blackboard.queryByPrefix(ConflictDetector.INTENT_PREFIX);
        return intents.map(e => ({
            agentId: e.authorAgentId,
            filePath: e.value,
        }));
    }
}
