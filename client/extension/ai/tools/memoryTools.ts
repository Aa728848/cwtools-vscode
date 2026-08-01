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
import { defaultDomainForMode } from '../agentProfile';
import type { BlackboardEntry, BlackboardEntryType } from '../orchestrator/types';

const MAX_BLACKBOARD_PAYLOAD_BYTES = 2 * 1024 * 1024;
const BLACKBOARD_ENTRY_TYPES = new Set<BlackboardEntryType>([
    'file_snapshot', 'scope_info', 'diag_result', 'entity_registry',
    'entity_relation', 'acceptance_evidence', 'write_intent', 'free_text',
]);

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties MemoryToolHandler reads from the executor. */
export interface MemoryToolContext {
    readonly workspaceRoot: string;
    readonly blackboard: import('../orchestrator/blackboard').Blackboard;
    readonly parentRunnerOptions?: any;
}

export function blackboardDomainPrefix(context?: import('../types').AgentToolContext): string {
    const mode = context?.runnerOptions?.mode ?? 'build';
    const domain = context?.runnerOptions?.domain ?? defaultDomainForMode(mode);
    const topicId = encodeURIComponent(context?.runnerOptions?.topicId ?? 'session');
    return `domain:${domain}:topic:${topicId}:`;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class MemoryToolHandler {
    constructor(private ctx: MemoryToolContext) {}

    private getBlackboardDirectory(context?: import('../types').AgentToolContext): string {
        const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId ?? 'session';
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
            this.ctx.blackboard.legacySet(scopedKey, `file://${filePath}`);
            return { success: true, message: `Successfully saved large payload (${value.length} chars) to high-capacity storage. Reference stored in blackboard. You MUST now output your final text response to complete your sub-task.` };
        } else {
            this.ctx.blackboard.legacySet(scopedKey, value);
            return { success: true, message: `Stored value in memory under key '${key}'.` };
        }
    }

    /** get_memory tool execution */
    async getMemory(args: import('../types').GetMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key } = args;
        if (!key) {
            return { found: false };
        } else {
            const domain = context?.runnerOptions?.domain
                ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
            const mem = this.ctx.blackboard.legacyGet(`${blackboardDomainPrefix(context)}${key}`);
            const resolved = mem.found || domain !== 'paradox' ? mem : this.ctx.blackboard.legacyGet(key);
            if (resolved && typeof resolved.value === 'string' && resolved.value.startsWith('file://')) {
                const payload = this.readStoredPayload(resolved.value, context);
                if (payload.error || payload.content === undefined) return { found: false, error: payload.error };
                const truncated = payload.content.length > 3000
                    ? payload.content.substring(0, 3000) + `\n...[truncated, full ${payload.fullLength} chars]`
                    : payload.content;
                return { found: true, value: truncated, _sourceFile: payload.filePath, _fullLength: payload.fullLength };
            } else {
                return resolved;
            }
        }
    }

    /** search_memory tool execution */
    searchMemory(args: { query: string }, context?: import('../types').AgentToolContext): unknown {
        const { query } = args;
        if (!query) {
            return { success: false, message: 'Missing query argument' };
        } else {
            const prefix = blackboardDomainPrefix(context);
            const matches = this.ctx.blackboard.queryByPrefix(prefix)
                .filter(entry => entry.key.toLowerCase().includes(query.toLowerCase())
                    || entry.value.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 50)
                .map(entry => ({
                    key: entry.key.slice(prefix.length),
                    preview: entry.value.length > 150 ? `${entry.value.slice(0, 150)}...` : entry.value,
                }));
            return { found: matches.length > 0, count: matches.length, matches };
        }
    }

    /** save_memory tool execution */
    async saveMemory(args: import('../types').SaveMemoryArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key, content, priority } = args;
        if (!key || !content) {
            return { success: false, message: 'Missing key or content' };
        } else {
            const { MemoryParser } = await import('../memoryParser');
            const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId;
            const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
            const domain = context?.runnerOptions?.domain
                ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
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
        const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId;
        const domain = context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
        const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
        return parser.forgetMemory(args.key, domain, args.mode ?? 'archive', topicId, args.expectedRevision);
    }

    async getRecallTrace(context?: import('../types').AgentToolContext): Promise<unknown> {
        const { MemoryParser } = await import('../memoryParser');
        const topicId = context?.runnerOptions?.topicId ?? this.ctx.parentRunnerOptions?.topicId;
        const domain = context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
        const parser = new MemoryParser(this.ctx.workspaceRoot, topicId);
        const trace = parser.getRecallTrace(topicId, domain);
        return trace
            ? { found: true, trace, note: 'Trace metadata is diagnostic only and does not override current instructions or verified evidence.' }
            : { found: false, message: 'No persistent-memory retrieval trace is available for this topic yet.' };
    }

    /** query_blackboard tool execution */
    async queryBlackboard(args: { key?: string; prefix?: string; type?: string }, context?: import('../types').AgentToolContext): Promise<unknown> {
        const { key: qbKey, prefix, type: qbType } = args;
        const domainPrefix = blackboardDomainPrefix(context);
        const domain = context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
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

        if (qbKey) {
            const entry = this.ctx.blackboard.read(`${domainPrefix}${qbKey}`)
                ?? (domain === 'paradox' ? this.ctx.blackboard.read(qbKey) : undefined);
            return entry ? { found: true, entry: await resolveFileRef(entry) } : { found: false };
        } else if (prefix) {
            const entries = this.ctx.blackboard.queryByPrefix(`${domainPrefix}${prefix}`);
            if (domain === 'paradox') {
                entries.push(...this.ctx.blackboard.queryByPrefix(prefix)
                    .filter(entry => !entry.key.startsWith('domain:')));
            }
            const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else if (qbType) {
            if (!BLACKBOARD_ENTRY_TYPES.has(qbType as BlackboardEntryType)) {
                return { success: false, message: `Unsupported blackboard entry type: ${qbType}` };
            }
            const entries = this.ctx.blackboard.queryByPrefix(domainPrefix)
                .filter(entry => entry.type === qbType);
            if (domain === 'paradox') {
                entries.push(...this.ctx.blackboard.queryByType(qbType as BlackboardEntryType)
                    .filter(entry => !entry.key.startsWith('domain:')));
            }
            const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
            return { found: resolved.length > 0, count: entries.length, entries: resolved };
        } else {
            return { success: false, message: aiText('Please provide a key, prefix, or type argument.', '请提供 key、prefix 或 type 参数') };
        }
    }
}
