/**
 * Memory Tool Handler — AI-agent state and memory operations.
 *
 * Handles: topic-scoped scratch memory storage, large payload fallback file writing,
 * and workspace memory parser operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { normalizeSchedulingState } from '../runner/scheduling';

const MAX_MEMORY_PAYLOAD_BYTES = 2 * 1024 * 1024;

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties MemoryToolHandler reads from the executor. */
export interface MemoryToolContext {
    readonly workspaceRoot: string;
}

export function blackboardDomainPrefix(context?: import('../types').AgentToolContext): string {
    const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
    const topicId = encodeURIComponent(context?.runnerOptions?.topicId ?? 'session');
    return `domain:${domain}:topic:${topicId}:`;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class MemoryToolHandler {
    private readonly scratchMemory = new Map<string, string>();

    constructor(private ctx: MemoryToolContext) {}

    private getScratchMemoryDirectory(context?: import('../types').AgentToolContext): string {
        const topicId = context?.runnerOptions?.topicId ?? 'session';
        return path.resolve(getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot), 'memory');
    }

    /** set_memory tool execution */
    async setMemory(args: import('../types').SetMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, value } = args;
        const domainPrefix = blackboardDomainPrefix(context);
        const scopedKey = `${domainPrefix}${key}`;
        if (!key || typeof value !== 'string') {
            return { success: false, message: 'Invalid arguments' };
        } else if (Buffer.byteLength(value, 'utf8') > MAX_MEMORY_PAYLOAD_BYTES) {
            return { success: false, message: 'Memory payload exceeds the 2 MiB size limit.' };
        } else if (value.length > 500) {
            const memoryDir = this.getScratchMemoryDirectory(context);
            fs.mkdirSync(memoryDir, { recursive: true });
            const safeKey = scopedKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-180);
            const filePath = path.join(memoryDir, `${safeKey}.txt`);
            fs.writeFileSync(filePath, value, 'utf-8');
            this.scratchMemory.set(scopedKey, `file://${filePath}`);
            return { success: true, message: `Successfully saved large payload (${value.length} chars) to topic storage (${filePath}).` };
        } else {
            this.scratchMemory.set(scopedKey, value);
            return { success: true, message: `Stored value in memory under key '${key}'.` };
        }
    }

    /** save_memory tool execution */
    async saveMemory(args: import('../types').SaveMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, content, priority } = args;
        if (!key || !content) {
            return { success: false, message: 'Missing key or content' };
        } else {
            const { MemoryParser } = await import('../memoryParser');
            const topicId = context?.runnerOptions?.topicId;
            const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
            const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
            const result = await parser.appendMemory({
                key,
                content,
                domain,
                priority: priority || 'normal',
                confidence: args.confidence,
                expiresAt: args.expiresInDays && args.expiresInDays > 0
                    ? Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
                    : undefined,
                source: `run:${context?.runnerOptions?.runRecord?.runId ?? 'unknown'}`,
                scope: 'private',
            }, topicId, {
                authoritativeProjectRevision: context?.authoritativeProjectRevision,
                expectedRevision: args.expectedRevision,
            });
            // Plan §8: re-saving an existing key means the model actively worked
            // with that memory — count it as an actual use (debounced persistence).
            if (result.success && result.existed) {
                parser.markMemoryUsed(topicId, [key], domain);
            }
            return result;
        }
    }

    async forgetMemory(args: import('../types').ForgetMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        if (!args.key) return { success: false, message: 'Missing key' };
        const { MemoryParser } = await import('../memoryParser');
        const topicId = context?.runnerOptions?.topicId;
        const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
        const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
        return parser.forgetMemory(args.key, domain, args.mode ?? 'archive', topicId, args.expectedRevision);
    }

    async getRecallTrace(context?: import('../types').AgentToolContext): Promise<unknown> {
        const { MemoryParser } = await import('../memoryParser');
        const topicId = context?.runnerOptions?.topicId;
        const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
        const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
        const trace = parser.getRecallTrace(topicId, domain);
        return trace
            ? { found: true, trace, note: 'Trace metadata is diagnostic only and does not override current instructions or verified evidence.' }
            : { found: false, message: 'No persistent-memory retrieval trace is available for this topic yet.' };
    }
}
