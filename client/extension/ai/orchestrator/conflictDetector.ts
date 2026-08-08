/** 
* Eddy CWTool Code — Clash Detector 
* 
* Detect file writing conflicts and semantic conflicts when multiple Agents are executed in parallel. 
* Implement intent declaration via Blackboard's write_intent entry. 
*/

import { Blackboard } from './blackboard';
import { BLACKBOARD_KEY_PREFIXES } from './blackboardSchema';
import { aiText } from '../messages';
import type { RunEventSink } from '../runner/runContext';

/** Conflict detection results */
export interface ConflictResult {
    /** Whether there is a conflict */
    hasConflict: boolean;
    /** Conflict type */
    conflictType?: 'file_write' | 'entity_id';
    /** Conflict partner Agent ID */
    conflictAgentId?: string;
    /** Conflict details */
    details?: string;
}

/** 
* Conflict detector. 
* 
* Working principle: 
* 1. Agent declares the writing intention through declareIntent before writing the file 
* 2. Other Agents call checkWriteConflict to check whether there is a conflict before writing. 
* 3. After the Agent is completed, call clearIntent to clear the intent statement. 
* 
* This is semantic layer conflict detection on top of PartitionedWriteQueue — 
* The write queue ensures serialization at the physical level, and the conflict detector prevents duplication of work at the logical level. 
*/
export class ConflictDetector {
    /** Key prefix for writing intent in Blackboard */
    private static readonly INTENT_PREFIX = BLACKBOARD_KEY_PREFIXES.intent;
    /** The key prefix of the entity registered in Blackboard */
    private static readonly ENTITY_PREFIX = BLACKBOARD_KEY_PREFIXES.entity;
    private eventSink?: RunEventSink;

    constructor(eventSink?: RunEventSink) {
        this.eventSink = eventSink;
    }

    setEventSink(eventSink?: RunEventSink): void {
        this.eventSink = eventSink;
    }

    /** 
* Check whether the Agent's write intent conflicts with other running Agents. 
* 
* @param agentId current Agent ID 
* @param filePath target file path 
* @param blackboard shared blackboard 
*/
    checkWriteConflict(
        agentId: string,
        filePath: string,
        blackboard: Blackboard,
    ): ConflictResult {
        const intentKey = ConflictDetector.INTENT_PREFIX + filePath;
        const existing = blackboard.read(intentKey);

        if (existing && existing.authorAgentId !== agentId) {
            const details = aiText(
                `File ${filePath} already has a write intent declared by Agent ${existing.authorAgentId}.`,
                `文件 ${filePath} 已被 Agent ${existing.authorAgentId} 声明写入意图`,
            );
            this.eventSink?.appendSoon('conflict_detected', {
                conflictType: 'file_write',
                agentId,
                conflictAgentId: existing.authorAgentId,
                target: filePath,
                details,
            }, { agentId });
            return {
                hasConflict: true,
                conflictType: 'file_write',
                conflictAgentId: existing.authorAgentId,
                details,
            };
        }

        return { hasConflict: false };
    }

    /** 
* Check whether the entity ID has been created by other Agents. 
* 
* @param agentId current Agent ID 
* @param entityId entity ID (such as event namespace.1) 
* @param blackboard shared blackboard 
*/
    checkEntityConflict(
        agentId: string,
        entityId: string,
        blackboard: Blackboard,
    ): ConflictResult {
        const entityKey = ConflictDetector.ENTITY_PREFIX + entityId;
        const existing = blackboard.read(entityKey);

        if (existing && existing.authorAgentId !== agentId) {
            const details = aiText(
                `Entity ${entityId} has already been registered by Agent ${existing.authorAgentId}.`,
                `实体 ${entityId} 已被 Agent ${existing.authorAgentId} 注册`,
            );
            this.eventSink?.appendSoon('conflict_detected', {
                conflictType: 'entity_id',
                agentId,
                conflictAgentId: existing.authorAgentId,
                target: entityId,
                details,
            }, { agentId });
            return {
                hasConflict: true,
                conflictType: 'entity_id',
                conflictAgentId: existing.authorAgentId,
                details,
            };
        }

        return { hasConflict: false };
    }

    /** 
* Agent declares intent before writing. 
* 
* @param agentId Agent ID 
* @param filePaths list of file paths to be written 
* @param blackboard shared blackboard 
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
* Agent registers to the blackboard after creating the entity. 
* 
* @param agentId Agent ID 
* @param entityIds List of created entity IDs 
* @param blackboard shared blackboard 
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
* Clear the write intent statement after the Agent completes. 
* 
* @param agentId Agent ID 
* @param blackboard shared blackboard 
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
* Get all currently active write intents (for debugging and UI display). 
*/
    getActiveIntents(blackboard: Blackboard): Array<{ agentId: string; filePath: string }> {
        const intents = blackboard.queryByPrefix(ConflictDetector.INTENT_PREFIX);
        return intents.map(e => ({
            agentId: e.authorAgentId,
            filePath: e.value,
        }));
    }
}
