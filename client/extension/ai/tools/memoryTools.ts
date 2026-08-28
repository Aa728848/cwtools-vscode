/**
 * Memory and Blackboard Tool Handler — all AI-agent state and memory operations.
 *
 * Handles: local blackboard storage, large payload fallback file writing,
 * workspace memory parser operations, and structured topic blackboard queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { aiText } from '../messages';
import { normalizeSchedulingState } from '../runner/scheduling';
import type { BlackboardEntry, BlackboardEntryType } from '../orchestrator/types';

const MAX_BLACKBOARD_PAYLOAD_BYTES = 2 * 1024 * 1024;
function isBlackboardEntryType(value: string): value is BlackboardEntryType {
    return value === 'file_snapshot'
        || value === 'scope_info'
        || value === 'diag_result'
        || value === 'entity_registry'
        || value === 'entity_relation'
        || value === 'acceptance_evidence'
        || value === 'write_intent'
        || value === 'free_text';
}

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties MemoryToolHandler reads from the executor. */
export interface MemoryToolContext {
    readonly workspaceRoot: string;
    readonly blackboard: import('../orchestrator/blackboard').Blackboard;
}

export function blackboardDomainPrefix(context?: import('../types').AgentToolContext): string {
    const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
    const topicId = encodeURIComponent(context?.runnerOptions?.topicId ?? 'session');
    return `domain:${domain}:topic:${topicId}:`;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class MemoryToolHandler {
    constructor(private ctx: MemoryToolContext) {}

    private getBlackboardDirectory(context?: import('../types').AgentToolContext): string {
        const topicId = context?.runnerOptions?.topicId ?? 'session';
        return path.resolve(getPrivateTopicStorageDir(topicId, this.ctx.workspaceRoot), 'blackboard');
    }

    private readStoredPayload(
        value: string,
        context?: import('../types').AgentToolContext,
    ): { content?: string; filePath?: string; fullLength?: number; error?: string } {
        if (!value.startsWith('file://')) return { content: value, fullLength: value.length };
        const blackboardDir = this.getBlackboardDirectory(context);
        const requestedPath = path.resolve(value.slice(7));
        const relative = path.relative(blackboardDir, requestedPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { error: 'Stored memory file reference is outside the current topic blackboard.' };
        }
        try {
            const realDirectory = fs.realpathSync(blackboardDir);
            const realPath = fs.realpathSync(requestedPath);
            const realRelative = path.relative(realDirectory, realPath);
            if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
                return { error: 'Stored memory file reference resolves outside the current topic blackboard.' };
            }
            const stat = fs.statSync(realPath);
            if (!stat.isFile() || stat.size > MAX_BLACKBOARD_PAYLOAD_BYTES) {
                return { error: 'Stored memory payload is unavailable or exceeds the size limit.' };
            }
            const content = fs.readFileSync(realPath, 'utf-8');
            return { content, filePath: realPath, fullLength: content.length };
        } catch {
            return { error: 'Stored memory payload file was not found.' };
        }
    }

    /** set_memory tool execution */
    async setMemory(args: import('../types').SetMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, value } = args;
        const domainPrefix = blackboardDomainPrefix(context);
        const scopedKey = `${domainPrefix}${key}`;
        if (!key || typeof value !== 'string') {
            return { success: false, message: 'Invalid arguments' };
        } else if (Buffer.byteLength(value, 'utf8') > MAX_BLACKBOARD_PAYLOAD_BYTES) {
            return { success: false, message: 'Memory payload exceeds the 2 MiB size limit.' };
        } else if (value.length > 500) {
            const blackboardDir = this.getBlackboardDirectory(context);
            fs.mkdirSync(blackboardDir, { recursive: true });
            const safeKey = scopedKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-180);
            const filePath = path.join(blackboardDir, `${safeKey}.txt`);
            fs.writeFileSync(filePath, value, 'utf-8');
            this.ctx.blackboard.setFreeText(scopedKey, `file://${filePath}`);
            return { success: true, message: `Successfully saved large payload (${value.length} chars) to high-capacity storage. Reference stored in blackboard. You MUST now output your final text response to complete your sub-task.` };
        } else {
            this.ctx.blackboard.setFreeText(scopedKey, value);
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

    /** query_blackboard tool execution */
    async queryBlackboard(args: { key?: string; prefix?: string; query?: string; type?: string; structured?: boolean }, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key: qbKey, prefix, query, type: qbType, structured } = args;
        const domainPrefix = blackboardDomainPrefix(context);
        const domain = normalizeSchedulingState(context?.runnerOptions?.schedulingState).domainProfile;
        const exposeEntry = <T extends { key: string }>(entry: T): T & { key: string } => ({
            ...entry,
            key: entry.key.startsWith(domainPrefix) ? entry.key.slice(domainPrefix.length) : entry.key,
        });
        const resolveFileRef = async (entry: BlackboardEntry) => {
            if (entry && typeof entry.value === 'string' && entry.value.startsWith('file://')) {
                const payload = this.readStoredPayload(entry.value, context);
                if (payload.error || payload.content === undefined) {
                    return exposeEntry({ ...entry, value: `[unavailable memory payload: ${payload.error ?? 'unknown error'}]` });
                }
                const truncated = payload.content.length > 3000
                    ? payload.content.substring(0, 3000) + `\n...[truncated, full ${payload.fullLength} chars]`
                    : payload.content;
                return exposeEntry({ ...entry, value: truncated });
            }
            return exposeEntry(entry);
        };
        // structured=true parses JSON values so the model does not have to.
        const maybeStructured = async (entry: BlackboardEntry) => {
            const exposed = await resolveFileRef(entry);
            if (!structured) return exposed;
            try {
                return { ...exposed, parsed: JSON.parse(exposed.value) };
            } catch {
                return { ...exposed, parseError: true };
            }
        };

        if (qbKey) {
            const entry = this.ctx.blackboard.read(`${domainPrefix}${qbKey}`)
                ?? (domain === 'paradox' ? this.ctx.blackboard.read(qbKey) : undefined);
            return entry ? { found: true, entry: await maybeStructured(entry) } : { found: false };
        } else if (query?.trim()) {
            const needle = query.trim().toLowerCase();
            const entries = this.ctx.blackboard.queryByPrefix(domainPrefix);
            if (domain === 'paradox') {
                entries.push(...this.ctx.blackboard.queryByPrefix('')
                    .filter(entry => !entry.key.startsWith('domain:')));
            }
            const matches = entries.filter(entry =>
                entry.key.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle));
            const resolved = await Promise.all(matches.slice(0, 50).map(maybeStructured));
            return { found: resolved.length > 0, count: matches.length, entries: resolved };
        } else if (prefix) {
            const entries = this.ctx.blackboard.queryByPrefix(`${domainPrefix}${prefix}`);
            if (domain === 'paradox') {
                entries.push(...this.ctx.blackboard.queryByPrefix(prefix)
                    .filter(entry => !entry.key.startsWith('domain:')));
            }
            const resolved = await Promise.all(entries.slice(0, 50).map(maybeStructured));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else if (qbType) {
            if (!isBlackboardEntryType(qbType)) {
                return { success: false, message: `Unsupported blackboard entry type: ${qbType}` };
            }
            const entries = this.ctx.blackboard.queryByPrefix(domainPrefix)
                .filter(entry => entry.type === qbType);
            if (domain === 'paradox') {
                entries.push(...this.ctx.blackboard.queryByType(qbType)
                    .filter(entry => !entry.key.startsWith('domain:')));
            }
            const resolved = await Promise.all(entries.slice(0, 50).map(maybeStructured));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else {
            return { success: false, message: aiText('Please provide a key, prefix, query, or type argument.', '请提供 key、prefix、query 或 type 参数') };
        }
    }
}
