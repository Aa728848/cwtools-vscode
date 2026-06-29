/**
 * Memory and Blackboard Tool Handler — all AI-agent state and memory operations.
 *
 * Handles: local blackboard storage, large payload fallback file writing,
 * workspace memory parser operations, and structured topic blackboard queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTopicStorageDir } from '../workspacePaths';
import { aiText } from '../messages';

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties MemoryToolHandler reads from the executor. */
export interface MemoryToolContext {
    readonly workspaceRoot: string;
    readonly blackboard: import('../orchestrator/blackboard').Blackboard;
    readonly parentRunnerOptions?: any;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class MemoryToolHandler {
    constructor(private ctx: MemoryToolContext) {}

    /** set_memory tool execution */
    async setMemory(args: import('../types').SetMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, value } = args;
        if (!key || typeof value !== 'string') {
            return { success: false, message: 'Invalid arguments' };
        } else if (value.length > 500) {
            const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId ?? 'session';
            const blackboardDir = path.join(getTopicStorageDir(topicId, this.ctx.workspaceRoot), 'blackboard');
            fs.mkdirSync(blackboardDir, { recursive: true });
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filePath = path.join(blackboardDir, `${safeKey}.txt`);
            fs.writeFileSync(filePath, value, 'utf-8');
            this.ctx.blackboard.legacySet(key, `file://${filePath}`);
            return { success: true, message: `Successfully saved large payload (${value.length} chars) to high-capacity storage. Reference stored in blackboard. You MUST now output your final text response to complete your sub-task.` };
        } else {
            this.ctx.blackboard.legacySet(key, value);
            return { success: true, message: `Stored value in memory under key '${key}'.` };
        }
    }

    /** get_memory tool execution */
    async getMemory(args: import('../types').GetMemoryArgs): Promise<unknown> {
        const { key } = args;
        if (!key) {
            return { found: false };
        } else {
            const mem = this.ctx.blackboard.legacyGet(key);
            if (mem && typeof mem.value === 'string' && mem.value.startsWith('file://')) {
                const filePath = mem.value.slice(7);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const truncated = content.length > 3000 
                        ? content.substring(0, 3000) + `\n...[truncated, full ${content.length} chars at ${filePath}]`
                        : content;
                    return { found: true, value: truncated, _sourceFile: filePath, _fullLength: content.length };
                } catch {
                    return { found: false, error: `File not found: ${filePath}` };
                }
            } else {
                return mem;
            }
        }
    }

    /** search_memory tool execution */
    searchMemory(args: { query: string }): unknown {
        const { query } = args;
        if (!query) {
            return { success: false, message: 'Missing query argument' };
        } else {
            return this.ctx.blackboard.legacySearch(query);
        }
    }

    /** save_memory tool execution */
    async saveMemory(args: { key: string; content: string; priority?: 'high' | 'normal' | 'low' }, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, content, priority } = args;
        if (!key || !content) {
            return { success: false, message: 'Missing key or content' };
        } else {
            const { MemoryParser } = await import('../memoryParser');
            const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId;
            const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
            return await parser.appendMemory({ key, content, priority: priority || 'normal' });
        }
    }

    /** query_blackboard tool execution */
    async queryBlackboard(args: { key?: string; prefix?: string; type?: string }): Promise<unknown> {
        const { key: qbKey, prefix, type: qbType } = args;
        const resolveFileRef = async (entry: any) => {
            if (entry && typeof entry.value === 'string' && entry.value.startsWith('file://')) {
                const filePath = entry.value.slice(7);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const truncated = content.length > 3000 
                        ? content.substring(0, 3000) + `\n...[truncated, full ${content.length} chars at ${filePath}]`
                        : content;
                    return { ...entry, value: truncated, _sourceFile: filePath, _fullLength: content.length };
                } catch {
                    return entry;
                }
            }
            return entry;
        };

        if (qbKey) {
            const entry = this.ctx.blackboard.read(qbKey);
            return entry ? { found: true, entry: await resolveFileRef(entry) } : { found: false };
        } else if (prefix) {
            const entries = this.ctx.blackboard.queryByPrefix(prefix);
            const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else if (qbType) {
            const entries = this.ctx.blackboard.queryByType(qbType as any);
            const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else {
            return { success: false, message: aiText('Please provide a key, prefix, or type argument.', '请提供 key、prefix 或 type 参数') };
        }
    }
}
