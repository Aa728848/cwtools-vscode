import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';
import { getPrivateTopicStorageDir } from './workspacePaths';
import type { AgentRuntimeDomain } from './types';

/** Classification of a memory entry's provenance. */
export type MemoryKind = 'user_fact' | 'project_fact' | 'inferred' | 'ephemeral';

/** A single memory entry to be persisted */
export interface MemoryEntry {
    key: string;
    content: string;
    /** Capability domain for this fact. */
    domain?: AgentRuntimeDomain;
    priority: 'high' | 'normal' | 'low';
    source?: string;
    confidence?: number;
    createdAt?: number;
    updatedAt?: number;
    lastUsedAt?: number;
    usageCount?: number;
    expiresAt?: number;
    scope?: 'private' | 'project';
    /**
     * Provenance classification. When omitted by a new write, it is derived from
     * `source`. 'inferred' entries are model guesses: they are
     * never auto-promoted to long-term facts — promotion requires an explicit
     * rewrite with a different kind (no automatic promotion path exists).
     */
    kind?: MemoryKind;
    /**
     * Revision the fact was learned against (e.g. rules/config hash), supplied by
     * the caller. When the project or rules change, call `markMemoryStale` so the
     * entry is excluded from prompts until re-validated.
     */
    revision?: string;
    /** Host-managed workspace generation this project fact was verified against. */
    projectRevision?: string;
    /** Stale entries await re-validation and are excluded from prompts by default. */
    stale?: boolean;
    /** When and why project evidence invalidated this entry. */
    staleAt?: number;
    staleReason?: string;
    /** Monotonic per-key revision used for optimistic concurrency control. */
    storeRevision?: number;
    /** Archived entries remain recoverable on disk but are excluded from recall. */
    archivedAt?: number;
}

export interface MemoryRecallTrace {
    topicId: string;
    domain: AgentRuntimeDomain;
    timestamp: number;
    candidateCount: number;
    selected: Array<{ key: string; score: number; storeRevision: number }>;
    excluded: { expired: number; stale: number; archived: number; domain: number };
}

/** Optional retrieval context for top-k memory selection (plan §8). */
export interface MemoryRetrievalContext {
    /** Current task text; keywords overlapping entry key/content raise relevance. */
    taskText?: string;
    /** Active game/profile id (e.g. 'stellaris'); matching entries rank higher. */
    gameId?: string;
    /** Path hints (e.g. files in scope); entries mentioning them rank higher. */
    pathScope?: string[];
    /** Include stale entries, annotated with `stale=true`, instead of excluding them. */
    includeStale?: boolean;
    /** Capability-domain namespace. Legacy entries are visible only to Paradox. */
    domain?: AgentRuntimeDomain;
}

/** Validate one untrusted entry parsed from memory.json. Returns null when unusable. */
function sanitizeMemoryEntry(raw: unknown): MemoryEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.key !== 'string' || record.key.length === 0) return null;
    if (typeof record.content !== 'string') return null;
    const num = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const kind = record.kind;
    const domain = record.domain;
    if (domain !== 'general' && domain !== 'paradox' && domain !== 'hybrid') return null;
    if (kind !== 'user_fact' && kind !== 'project_fact' && kind !== 'inferred' && kind !== 'ephemeral') return null;
    return {
        key: record.key,
        content: record.content,
        domain,
        priority: record.priority === 'high' || record.priority === 'low' ? record.priority : 'normal',
        source: typeof record.source === 'string' ? record.source : undefined,
        confidence: num(record.confidence),
        createdAt: num(record.createdAt),
        updatedAt: num(record.updatedAt),
        lastUsedAt: num(record.lastUsedAt),
        usageCount: num(record.usageCount),
        expiresAt: num(record.expiresAt),
        scope: record.scope === 'project' ? 'project' : record.scope === 'private' ? 'private' : undefined,
        kind,
        revision: typeof record.revision === 'string' ? record.revision : undefined,
        projectRevision: typeof record.projectRevision === 'string' ? record.projectRevision : undefined,
        stale: record.stale === true ? true : undefined,
        staleAt: num(record.staleAt),
        staleReason: typeof record.staleReason === 'string' ? record.staleReason : undefined,
        storeRevision: num(record.storeRevision),
        archivedAt: num(record.archivedAt),
    };
}

/**
 * Parses topic-scoped .cwtools-memory.md files to extract workspace-specific rules.
 * Also supports appending new memory entries and pruning old ones.
 * The structured topic file is the sole source of truth. The Markdown file beside
 * it is only a generated human-readable projection.
 *
 * Prompt building is read-only and retrieves the top-k most relevant entries under
 * a strict character budget (plan §8). Usage statistics change only via
 * `markMemoryUsed`/`markMemoryUsedInText` and are persisted asynchronously
 * (debounced); call `flushUsageWrites` to force persistence.
 */
export class MemoryParser {
    /** Strict cap on the total size of memory entries injected into a prompt. */
    static readonly MAX_MEMORY_CHARS = 12000;
    /** Max number of entries injected per prompt (top-k retrieval, plan §8). */
    static readonly TOP_K_MEMORY_ENTRIES = 10;
    /** Small metadata-only queue exposed to a later relevant run for re-validation. */
    static readonly TOP_K_STALE_PROJECT_FACTS = 5;
    /** Debounce window for usage-stat persistence. Writable for tests. */
    static usagePersistDebounceMs = 2000;
    static readonly MEMORY_FILE_NAME = '.cwtools-memory.md';
    static readonly STRUCTURED_MEMORY_FILE_NAME = 'memory.json';
    /** Structured file format accepted and written by this build. */
    static readonly STRUCTURED_MEMORY_VERSION = 5;
    /** Half-life scale for freshness/last-used decay in retrieval scoring. */
    private static readonly FRESHNESS_DECAY_MS = 30 * 24 * 60 * 60 * 1000;
    private static readonly KNOWN_WORKSPACE_LIMIT = 16;
    private static readonly KNOWN_TOPIC_LIMIT = 128;
    /** Active topic ids only; bounded so invalidation never scans the workspace. */
    private static knownTopics = new Map<string, Set<string>>();
    private static workspaceProjectRevisions = new Map<string, {
        revision: string;
        reason: string;
        updatedAt: number;
    }>();
    private static projectRevisionCounter = 0;
    private static topicWriteQueues = new Map<string, Promise<void>>();
    private static recallTraces = new Map<string, MemoryRecallTrace>();
    private static readonly RECALL_TRACE_LIMIT = 128;

    /**
     * Process-wide pending usage increments, keyed by workspace+topic so multiple
     * MemoryParser instances coalesce into one debounced write. Static on purpose:
     * prompt building and tool handling create short-lived parser instances.
     */
    private static pendingUsage = new Map<string, {
        workspaceRoot: string;
        topicId?: string;
        counts: Map<string, { count: number; lastUsedAt: number }>;
        timer?: NodeJS.Timeout;
    }>();

    constructor(private workspaceRoot: string, private topicId?: string) {
        MemoryParser.ensureWorkspaceSessionRevision(workspaceRoot);
        if (topicId) MemoryParser.rememberTopic(workspaceRoot, topicId);
    }

    private static workspaceKey(workspaceRoot: string): string {
        const resolved = path.resolve(workspaceRoot);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    private topicKey(topicId = this.topicId): string {
        return `${MemoryParser.workspaceKey(this.workspaceRoot)}::${topicId || 'default'}`;
    }

    private async withTopicWriteLock<T>(topicId: string | undefined, action: () => Promise<T> | T): Promise<T> {
        const key = this.topicKey(topicId);
        const previous = MemoryParser.topicWriteQueues.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        MemoryParser.topicWriteQueues.set(key, tail);
        await previous;
        try {
            return await action();
        } finally {
            release();
            if (MemoryParser.topicWriteQueues.get(key) === tail) MemoryParser.topicWriteQueues.delete(key);
        }
    }

    private recordRecallTrace(trace: MemoryRecallTrace): void {
        const key = this.topicKey(trace.topicId) + `::${trace.domain}`;
        MemoryParser.recallTraces.delete(key);
        MemoryParser.recallTraces.set(key, trace);
        while (MemoryParser.recallTraces.size > MemoryParser.RECALL_TRACE_LIMIT) {
            const oldest = MemoryParser.recallTraces.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            MemoryParser.recallTraces.delete(oldest);
        }
    }

    public getRecallTrace(topicId = this.topicId, domain: AgentRuntimeDomain = 'paradox'): MemoryRecallTrace | undefined {
        return MemoryParser.recallTraces.get(this.topicKey(topicId) + `::${domain}`);
    }

    private static rememberTopic(workspaceRoot: string, topicId: string): void {
        const normalizedTopic = topicId.trim();
        if (!normalizedTopic) return;
        const key = MemoryParser.workspaceKey(workspaceRoot);
        let topics = MemoryParser.knownTopics.get(key);
        if (!topics) {
            if (MemoryParser.knownTopics.size >= MemoryParser.KNOWN_WORKSPACE_LIMIT) {
                const oldest = MemoryParser.knownTopics.keys().next().value;
                if (oldest !== undefined) MemoryParser.knownTopics.delete(oldest);
            }
            topics = new Set<string>();
            MemoryParser.knownTopics.set(key, topics);
        }
        if (topics.has(normalizedTopic)) return;
        topics.add(normalizedTopic);
        if (topics.size > MemoryParser.KNOWN_TOPIC_LIMIT) {
            const oldest = topics.values().next().value;
            if (oldest !== undefined) topics.delete(oldest);
        }
    }

    private static setWorkspaceProjectRevision(workspaceRoot: string, reason: string): string {
        const key = MemoryParser.workspaceKey(workspaceRoot);
        const updatedAt = Date.now();
        const revision = `${updatedAt.toString(36)}-${process.pid.toString(36)}-${(++MemoryParser.projectRevisionCounter).toString(36)}`;
        MemoryParser.workspaceProjectRevisions.set(key, { revision, reason, updatedAt });
        while (MemoryParser.workspaceProjectRevisions.size > MemoryParser.KNOWN_WORKSPACE_LIMIT) {
            const oldest = MemoryParser.workspaceProjectRevisions.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            MemoryParser.workspaceProjectRevisions.delete(oldest);
        }
        return revision;
    }

    private static ensureWorkspaceSessionRevision(workspaceRoot: string): void {
        const key = MemoryParser.workspaceKey(workspaceRoot);
        if (MemoryParser.workspaceProjectRevisions.has(key)) return;
        // A new extension process may have missed changes made while it was
        // offline. A process-local session revision keeps prompt reads free of
        // filesystem writes while conservatively invalidating older project facts.
        MemoryParser.setWorkspaceProjectRevision(workspaceRoot, 'extension_session_started');
    }

    public static getWorkspaceProjectRevision(workspaceRoot: string): string {
        MemoryParser.ensureWorkspaceSessionRevision(workspaceRoot);
        return MemoryParser.workspaceProjectRevisions.get(MemoryParser.workspaceKey(workspaceRoot))?.revision ?? 'unavailable';
    }

    public static advanceWorkspaceProjectRevision(
        workspaceRoot: string,
        reason = 'project_or_rules_changed',
    ): string {
        return MemoryParser.setWorkspaceProjectRevision(workspaceRoot, reason);
    }

    /** Mark project-derived facts stale for every topic used in this process. */
    public static markWorkspaceProjectFactsStale(
        workspaceRoot: string,
        reason = 'project_or_rules_changed',
    ): number {
        MemoryParser.advanceWorkspaceProjectRevision(workspaceRoot, reason);
        const topics = MemoryParser.knownTopics.get(MemoryParser.workspaceKey(workspaceRoot));
        if (!topics) return 0;
        let marked = 0;
        for (const topicId of topics) {
            const parser = new MemoryParser(workspaceRoot, topicId);
            marked += parser.markMemoryStale(topicId, entry =>
                entry.kind === 'project_fact', reason);
        }
        return marked;
    }

    /** Get the full path to the topic-scoped memory file used for new writes. */
    public get memoryFilePath(): string {
        return this.getMemoryFilePath();
    }

    public getMemoryFilePath(topicId = this.topicId): string {
        const topicDir = getPrivateTopicStorageDir(topicId || 'default', this.workspaceRoot);
        return topicDir ? path.join(topicDir, MemoryParser.MEMORY_FILE_NAME) : '';
    }

    public getStructuredMemoryFilePath(topicId = this.topicId): string {
        return path.join(path.dirname(this.getMemoryFilePath(topicId)), MemoryParser.STRUCTURED_MEMORY_FILE_NAME);
    }

    private readStructuredEntries(topicId = this.topicId): MemoryEntry[] {
        const filePath = this.getStructuredMemoryFilePath(topicId);
        try {
            if (!fs.existsSync(filePath)) return [];
            const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!value || typeof value !== 'object'
                || (value as { version?: unknown }).version !== MemoryParser.STRUCTURED_MEMORY_VERSION) return [];
            const rawEntries = (value as { entries?: unknown }).entries;
            if (!Array.isArray(rawEntries)) return [];
            const entries: MemoryEntry[] = [];
            for (const raw of rawEntries) {
                const entry = sanitizeMemoryEntry(raw);
                if (entry) entries.push(entry);
            }
            return entries;
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, `Error reading ${MemoryParser.STRUCTURED_MEMORY_FILE_NAME}`, e);
            return [];
        }
    }

    private writeStructuredEntries(entries: MemoryEntry[], topicId = this.topicId, options?: { skipMarkdown?: boolean }): void {
        const jsonPath = this.getStructuredMemoryFilePath(topicId);
        const markdownPath = this.getMemoryFilePath(topicId);
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        // Atomic single-file rewrite (write temp + rename).
        const tmpPath = `${jsonPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify({ version: MemoryParser.STRUCTURED_MEMORY_VERSION, entries }, null, 2), 'utf8');
        fs.renameSync(tmpPath, jsonPath);
        // Stats-only flushes leave the generated Markdown untouched; it is
        // regenerated on the next structural write (append/prune/stale).
        if (options?.skipMarkdown) return;
        const markdown = [
            '# CWTools AI Memory',
            '',
            '> Private structured memory generated by the Agent. Project-shareable rules belong in AGENTS.md or an explicit workflow.',
            '',
            ...entries.map(entry => {
                const date = new Date(entry.updatedAt ?? entry.createdAt ?? Date.now()).toISOString().slice(0, 10);
                const priority = entry.priority !== 'normal' ? ` [${entry.priority}]` : '';
                const metadata = JSON.stringify({
                    domain: entry.domain,
                    source: entry.source,
                    confidence: entry.confidence,
                    kind: entry.kind,
                    revision: entry.revision,
                    projectRevision: entry.projectRevision,
                    stale: entry.stale,
                    staleAt: entry.staleAt,
                    staleReason: entry.staleReason,
                    storeRevision: entry.storeRevision,
                    archivedAt: entry.archivedAt,
                    usageCount: entry.usageCount,
                    expiresAt: entry.expiresAt,
                    scope: entry.scope,
                });
                return `## [${date}] ${entry.key}${priority}\n<!-- cwtools-memory: ${metadata} -->\n${entry.content}\n`;
            }),
        ].join('\n');
        fs.writeFileSync(markdownPath, markdown, 'utf8');
    }

    private redactSecrets(content: string): string {
        return content
            .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
            .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi, 'Bearer [REDACTED_TOKEN]')
            .replace(/(["']?(?:api[_-]?key|token|password)["']?\s*[:=]\s*["'])[^"'\s]{8,}/gi, '$1[REDACTED]');
    }

    /**
     * Kind inference for new writes without an explicit kind.
     * Agent-sourced memories ('agent:save_memory', 'run:*') are model inferences;
     * explicit 'user:*' sources are user facts; any other explicit source is a
     * project fact; a missing source is conservatively treated as 'inferred'.
     */
    private static inferKind(source?: string): MemoryKind {
        if (!source || source === 'agent:save_memory' || source.startsWith('run:')) return 'inferred';
        return source.startsWith('user:') ? 'user_fact' : 'project_fact';
    }

    private static tokenizeTaskText(text: string): string[] {
        const seen = new Set<string>();
        for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
            if (raw.length >= 3) seen.add(raw);
            if (seen.size >= 32) break;
        }
        return [...seen];
    }

    /**
     * Retrieval score (plan §8): task relevance (keyword/path overlap), priority,
     * confidence, freshness (updatedAt decay) and actual recent use (lastUsedAt
     * decay). Deterministic; ties break on updatedAt then key.
     */
    private scoreMemoryEntry(entry: MemoryEntry, keywords: string[], gameId: string | undefined, pathHints: string[], now: number): number {
        const priorityScore = { high: 3, normal: 2, low: 1 } as const;
        let score = priorityScore[entry.priority] + (entry.confidence ?? 0.8) * 2;
        if (keywords.length > 0 || gameId || pathHints.length > 0) {
            const haystack = `${entry.key}\n${entry.content}`.toLowerCase();
            if (keywords.length > 0) {
                let hits = 0;
                for (const keyword of keywords) {
                    if (haystack.includes(keyword)) hits++;
                }
                score += (hits / keywords.length) * 4;
            }
            if (gameId && haystack.includes(gameId)) score += 1;
            if (pathHints.some(hint => haystack.includes(hint))) score += 1;
        }
        const ageMs = Math.max(0, now - (entry.updatedAt ?? entry.createdAt ?? now));
        score += 2 * Math.exp(-ageMs / MemoryParser.FRESHNESS_DECAY_MS);
        if (entry.lastUsedAt !== undefined) {
            score += Math.exp(-Math.max(0, now - entry.lastUsedAt) / MemoryParser.FRESHNESS_DECAY_MS);
        }
        return score;
    }

    private formatEntryBlock(entry: MemoryEntry): string {
        const staleMarker = entry.stale === true ? '; stale=true' : '';
        return `## ${entry.key} [priority=${entry.priority}; confidence=${entry.confidence ?? 0.8}; source=${entry.source ?? 'agent'}; kind=${entry.kind}${staleMarker}]\n${entry.content}`;
    }

    private synchronizeProjectFactRevision(entries: MemoryEntry[]): boolean {
        const currentRevision = MemoryParser.getWorkspaceProjectRevision(this.workspaceRoot);
        const revisionRecord = MemoryParser.workspaceProjectRevisions.get(MemoryParser.workspaceKey(this.workspaceRoot));
        let changed = false;
        for (const entry of entries) {
            if (entry.kind !== 'project_fact') continue;
            if (entry.projectRevision === currentRevision) continue;
            if (entry.stale !== true) changed = true;
            entry.stale = true;
            entry.staleAt ??= revisionRecord?.updatedAt ?? Date.now();
            entry.staleReason ??= revisionRecord?.reason ?? 'project_revision_changed';
        }
        return changed;
    }

    private buildStaleProjectFactPrompt(
        entries: MemoryEntry[],
        context: MemoryRetrievalContext | undefined,
        now: number,
    ): string {
        if (context?.includeStale === true || !context?.taskText?.trim()) return '';
        const keywords = MemoryParser.tokenizeTaskText(context.taskText);
        const gameId = context.gameId?.toLowerCase();
        const pathHints = (context.pathScope ?? []).map(hint => hint.toLowerCase()).filter(Boolean);
        const candidates = entries
            .filter(entry => entry.stale === true
                && (!entry.expiresAt || entry.expiresAt > now)
                && entry.kind === 'project_fact')
            .filter(entry => {
                const haystack = `${entry.key}\n${entry.content}\n${entry.source ?? ''}`.toLowerCase();
                const entryTerms = MemoryParser.tokenizeTaskText(haystack);
                const keywordMatch = keywords.some(keyword => entryTerms.some(term =>
                    term === keyword
                    || (term.length >= 3 && keyword.length >= 3
                        && (term.includes(keyword) || keyword.includes(term)))));
                const source = entry.source?.toLowerCase();
                const pathMatch = pathHints.some(hint => haystack.includes(hint) || (!!source && hint.includes(source)));
                return keywordMatch || pathMatch;
            })
            .map(entry => ({ entry, score: this.scoreMemoryEntry(entry, keywords, gameId, pathHints, now) }))
            .sort((a, b) =>
                b.score - a.score
                || (b.entry.staleAt ?? b.entry.updatedAt ?? 0) - (a.entry.staleAt ?? a.entry.updatedAt ?? 0)
                || a.entry.key.localeCompare(b.entry.key))
            .slice(0, MemoryParser.TOP_K_STALE_PROJECT_FACTS);
        if (candidates.length === 0) return '';

        const sanitizeMetadata = (value: string | undefined, fallback: string): string =>
            (value?.replace(/[\r\n\t]+/g, ' ').trim() || fallback).slice(0, 240);
        const lines = candidates.map(({ entry }) => {
            const key = sanitizeMetadata(entry.key, 'unnamed');
            const source = sanitizeMetadata(entry.source, 'project evidence');
            const revision = entry.revision ? `; previous-revision=${sanitizeMetadata(entry.revision, 'unknown')}` : '';
            const reason = entry.staleReason ? `; reason=${sanitizeMetadata(entry.staleReason, 'changed')}` : '';
            return `- key=${JSON.stringify(key)}; source=${JSON.stringify(source)}${revision}${reason}`;
        });
        return `<stale-project-memory>\n# PROJECT FACTS AWAITING RE-VALIDATION\nThese prior project-memory keys were invalidated by project or rules changes. Their old values are intentionally omitted and must not be trusted. If a key is relevant to the current task, re-read its current authoritative source or equivalent CWT/LSP evidence, then call save_memory with the same key and corrected content. Re-saving preserves its project-fact provenance and removes it from this queue.\n${lines.join('\n')}\n</stale-project-memory>\n`;
    }

    /**
     * Reads memory and builds the prompt block. Read-only: never updates usage
     * statistics and never rewrites memory files. With structured entries present,
     * injects only the top-k entries (see TOP_K_MEMORY_ENTRIES) selected by
     * relevance to the optional retrieval context, under a strict total budget of
     * MAX_MEMORY_CHARS; the surrounding safety header has its own quota on top.
     */
    public getMemoryPrompt(topicId = this.topicId, context?: MemoryRetrievalContext): string {
        try {
            if (!this.workspaceRoot) return '';
            if (topicId) MemoryParser.rememberTopic(this.workspaceRoot, topicId);

            const structured = this.readStructuredEntries(topicId);
            if (structured.length > 0) {
                const requestedDomain = context?.domain ?? 'paradox';
                const scoped = structured.filter(entry => entry.domain === requestedDomain);
                if (scoped.length === 0) {
                    this.recordRecallTrace({
                        topicId: topicId || 'default', domain: requestedDomain, timestamp: Date.now(),
                        candidateCount: 0, selected: [],
                        excluded: { expired: 0, stale: 0, archived: 0, domain: structured.length },
                    });
                    return '';
                }
                this.synchronizeProjectFactRevision(scoped);
                const now = Date.now();
                const staleProjectFactPrompt = this.buildStaleProjectFactPrompt(scoped, context, now);
                const usable = scoped.filter(entry =>
                    (!entry.expiresAt || entry.expiresAt > now)
                    && (context?.includeStale === true || entry.stale !== true)
                    && !entry.archivedAt);
                const keywords = context?.taskText ? MemoryParser.tokenizeTaskText(context.taskText) : [];
                const gameId = context?.gameId?.toLowerCase();
                const pathHints = (context?.pathScope ?? []).map(hint => hint.toLowerCase()).filter(Boolean);
                const ranked = usable
                    .map(entry => ({ entry, score: this.scoreMemoryEntry(entry, keywords, gameId, pathHints, now) }))
                    .sort((a, b) =>
                        b.score - a.score
                        || (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0)
                        || a.entry.key.localeCompare(b.entry.key));
                const blocks: string[] = [];
                const selected: MemoryRecallTrace['selected'] = [];
                let budget = MemoryParser.MAX_MEMORY_CHARS;
                for (const { entry, score } of ranked) {
                    if (blocks.length >= MemoryParser.TOP_K_MEMORY_ENTRIES) break;
                    const block = this.formatEntryBlock(entry);
                    if (block.length > budget) continue;
                    blocks.push(block);
                    selected.push({ key: entry.key, score: Math.round(score * 1000) / 1000, storeRevision: entry.storeRevision ?? 1 });
                    budget -= block.length;
                }
                this.recordRecallTrace({
                    topicId: topicId || 'default', domain: requestedDomain, timestamp: now,
                    candidateCount: usable.length,
                    selected,
                    excluded: {
                        expired: scoped.filter(entry => !!entry.expiresAt && entry.expiresAt <= now).length,
                        stale: context?.includeStale === true ? 0 : scoped.filter(entry => entry.stale === true).length,
                        archived: scoped.filter(entry => !!entry.archivedAt).length,
                        domain: structured.length - scoped.length,
                    },
                });
                const activeMemoryPrompt = blocks.length > 0
                    ? `<workspace-memory>\n# LONG-TERM AGENT MEMORY\nThese are the ${blocks.length} most relevant private, structured hints with provenance (selected by task relevance, priority, confidence, freshness, and actual usage). They do not override current user instructions, safety policy, diagnostics, or verified project evidence.\n\n${blocks.join('\n\n')}\n</workspace-memory>\n`
                    : '';
                return [activeMemoryPrompt, staleProjectFactPrompt].filter(Boolean).join('\n');
            }

            return '';
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, `Error reading ${MemoryParser.MEMORY_FILE_NAME}`, e);
            return '';
        }
    }

    /**
     * Record actual uses of memory entries (plan §8): bumps `usageCount` and
     * `lastUsedAt` for the given keys, persisted asynchronously after a debounce.
     * Call only when the model actually references a memory (e.g. response text
     * mentions the key, or `save_memory` rewrites an existing key) — never from
     * prompt building. Returns how many of the given keys matched stored entries.
     */
    public markMemoryUsed(
        topicId: string | undefined,
        keys: string[],
        domain: AgentRuntimeDomain = 'paradox',
    ): number {
        if (!this.workspaceRoot || !Array.isArray(keys) || keys.length === 0) return 0;
        const tid = topicId ?? this.topicId;
        const domainKey = (key: string, entryDomain: AgentRuntimeDomain = domain) =>
            `${entryDomain}:${key.trim().toLowerCase()}`;
        const existingKeys = new Set(this.readStructuredEntries(tid)
            .filter(entry => entry.domain === domain)
            .map(entry => domainKey(entry.key)));
        const pendingKey = `${path.resolve(this.workspaceRoot)}::${tid || 'default'}`;
        let pending = MemoryParser.pendingUsage.get(pendingKey);
        if (!pending) {
            pending = { workspaceRoot: this.workspaceRoot, topicId: tid, counts: new Map() };
            MemoryParser.pendingUsage.set(pendingKey, pending);
        }
        const now = Date.now();
        let matched = 0;
        for (const key of keys) {
            if (typeof key !== 'string') continue;
            const normalizedKey = domainKey(key);
            if (!normalizedKey || !existingKeys.has(normalizedKey)) continue;
            const stat = pending.counts.get(normalizedKey) ?? { count: 0, lastUsedAt: 0 };
            stat.count += 1;
            stat.lastUsedAt = now;
            pending.counts.set(normalizedKey, stat);
            matched++;
        }
        if (matched > 0) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.timer = setTimeout(() => MemoryParser.flushUsageKey(pendingKey), MemoryParser.usagePersistDebounceMs);
            if (typeof pending.timer.unref === 'function') pending.timer.unref();
        } else if (pending.counts.size === 0) {
            MemoryParser.pendingUsage.delete(pendingKey);
        }
        return matched;
    }

    /**
     * Record usage for every stored memory key that appears verbatim in `text`
     * (e.g. an assistant response). Returns how many distinct keys matched.
     */
    public markMemoryUsedInText(
        topicId: string | undefined,
        text: string,
        domain: AgentRuntimeDomain = 'paradox',
    ): number {
        if (!this.workspaceRoot || !text) return 0;
        const tid = topicId ?? this.topicId;
        const keys = this.readStructuredEntries(tid)
            .filter(entry => entry.domain === domain && text.includes(entry.key))
            .map(entry => entry.key);
        return this.markMemoryUsed(tid, keys, domain);
    }

    /** Persist all pending debounced usage stats immediately (tests, deactivation). */
    public static flushUsageWrites(): void {
        for (const pendingKey of [...MemoryParser.pendingUsage.keys()]) {
            MemoryParser.flushUsageKey(pendingKey);
        }
    }

    private static flushUsageKey(pendingKey: string): void {
        const pending = MemoryParser.pendingUsage.get(pendingKey);
        if (!pending) return;
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
        MemoryParser.pendingUsage.delete(pendingKey);
        if (pending.counts.size === 0) return;
        try {
            const parser = new MemoryParser(pending.workspaceRoot, pending.topicId);
            const jsonPath = parser.getStructuredMemoryFilePath();
            // Usage stats only ever update existing records; never create storage.
            if (!fs.existsSync(jsonPath)) return;
            const entries = parser.readStructuredEntries();
            let changed = false;
            for (const entry of entries) {
                const stat = pending.counts.get(`${entry.domain}:${entry.key.toLowerCase()}`);
                if (!stat) continue;
                entry.usageCount = (entry.usageCount ?? 0) + stat.count;
                entry.lastUsedAt = stat.lastUsedAt;
                changed = true;
            }
            // Rewrite only when a record actually changed; JSON only (atomic).
            if (changed) {
                parser.writeStructuredEntries(entries, pending.topicId, { skipMarkdown: true });
            }
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Failed to persist memory usage stats', e);
        }
    }

    /**
     * Mark entries as stale, e.g. after project rules or CWT config changed: stale
     * entries stay on disk but are excluded from prompts until re-validated
     * (re-saving the key via appendMemory clears the flag). Pass a predicate to
     * downgrade a subset, or omit it to downgrade all entries of the topic.
     * Project/rule change watchers call this for active topics. Returns how many
     * entries were newly marked.
     */
    public markMemoryStale(
        topicId = this.topicId,
        predicate?: (entry: MemoryEntry) => boolean,
        reason = 'project_or_rules_changed',
    ): number {
        try {
            const entries = this.readStructuredEntries(topicId);
            let marked = 0;
            for (const entry of entries) {
                if (entry.stale === true) continue;
                if (predicate && !predicate(entry)) continue;
                entry.stale = true;
                entry.staleAt = Date.now();
                entry.staleReason = reason;
                marked++;
            }
            if (marked > 0) {
                this.writeStructuredEntries(entries, topicId);
            }
            return marked;
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error marking memory stale', e);
            return 0;
        }
    }

    /**
     * Append a new memory entry to the .cwtools-memory.md file.
     * Auto-creates the file if it doesn't exist.
     * Auto-prunes if the file exceeds the character limit. The limit is strict:
     * priority only affects which entries are kept first, it never exempts an
     * entry (not even a high-priority one) from the total budget.
     */
    public async appendMemory(
        entry: MemoryEntry,
        topicId = this.topicId,
        options?: { authoritativeProjectRevision?: string; expectedRevision?: number },
    ): Promise<{ success: boolean; message: string; existed?: boolean; revalidatedProjectFact?: boolean; storeRevision?: number }> {
        return this.withTopicWriteLock(topicId, () => this.appendMemoryUnlocked(entry, topicId, options));
    }

    private async appendMemoryUnlocked(
        entry: MemoryEntry,
        topicId = this.topicId,
        options?: { authoritativeProjectRevision?: string; expectedRevision?: number },
    ): Promise<{ success: boolean; message: string; existed?: boolean; revalidatedProjectFact?: boolean; storeRevision?: number }> {
        try {
            if (!this.workspaceRoot) {
                return { success: false, message: 'No workspace root' };
            }

            const now = Date.now();
            const entries = this.readStructuredEntries(topicId);
            this.synchronizeProjectFactRevision(entries);
            const normalizedKey = entry.key.trim().slice(0, 160);
            const requestedDomain = entry.domain ?? 'paradox';
            const existing = entries.find(candidate =>
                candidate.key.toLowerCase() === normalizedKey.toLowerCase()
                && candidate.domain === requestedDomain);
            const currentStoreRevision = existing ? (existing.storeRevision ?? 1) : 0;
            if (options?.expectedRevision !== undefined && options.expectedRevision !== currentStoreRevision) {
                return {
                    success: false,
                    existed: !!existing,
                    storeRevision: currentStoreRevision,
                    message: `Memory revision conflict for "${entry.key}": expected ${options.expectedRevision}, actual ${currentStoreRevision}. Re-read the memory before retrying.`,
                };
            }
            const requestedSource = entry.source ?? 'agent:save_memory';
            const existingKind = existing?.kind;
            const genericAgentRewrite = requestedSource === 'agent:save_memory' || requestedSource.startsWith('run:');
            const revalidatedProjectFact = existing?.stale === true
                && existingKind === 'project_fact'
                && entry.kind === undefined
                && genericAgentRewrite;
            const currentProjectRevision = MemoryParser.getWorkspaceProjectRevision(this.workspaceRoot);
            if (revalidatedProjectFact && options?.authoritativeProjectRevision !== currentProjectRevision) {
                return {
                    success: false,
                    existed: true,
                    revalidatedProjectFact: false,
                    message: `Project memory "${entry.key}" remains stale. Read a current authoritative project/CWT/LSP source in this run before saving the key again.`,
                };
            }
            const source = revalidatedProjectFact ? existing.source : requestedSource;
            // A single entry must fit the total budget on its own (with room for
            // the key and per-entry overhead), otherwise it could never be kept.
            const truncationMarker = '…[truncated]';
            const maxContentLength = MemoryParser.MAX_MEMORY_CHARS - normalizedKey.length - 200 - truncationMarker.length;
            let content = this.redactSecrets(entry.content.trim());
            if (content.length > maxContentLength) {
                content = content.slice(0, Math.max(0, maxContentLength)) + truncationMarker;
            }
            const normalizedKind = revalidatedProjectFact ? 'project_fact' : entry.kind ?? MemoryParser.inferKind(source);
            const normalized: MemoryEntry = {
                ...entry,
                key: normalizedKey,
                content,
                domain: requestedDomain,
                source,
                // Re-saving a key revalidates it: stale/revision come from the new
                // entry only, never carried over from the superseded one.
                kind: normalizedKind,
                revision: entry.revision,
                projectRevision: normalizedKind === 'project_fact' ? currentProjectRevision : undefined,
                stale: undefined,
                staleAt: undefined,
                staleReason: undefined,
                storeRevision: currentStoreRevision + 1,
                archivedAt: undefined,
                confidence: Math.max(0, Math.min(1, entry.confidence ?? 0.8)),
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                lastUsedAt: existing?.lastUsedAt ?? entry.lastUsedAt,
                usageCount: existing?.usageCount ?? 0,
                scope: entry.scope ?? 'private',
            };
            const consolidated = entries.filter(candidate =>
                candidate.key.toLowerCase() !== normalized.key.toLowerCase()
                || candidate.domain !== requestedDomain);
            consolidated.push(normalized);
            const priorityScore = { high: 3, normal: 2, low: 1 } as const;
            consolidated.sort((a, b) =>
                priorityScore[b.priority] - priorityScore[a.priority]
                || (b.confidence ?? 0.8) - (a.confidence ?? 0.8)
                || (b.lastUsedAt ?? b.updatedAt ?? 0) - (a.lastUsedAt ?? a.updatedAt ?? 0));
            const kept: MemoryEntry[] = [];
            let size = 0;
            for (const candidate of consolidated) {
                const candidateSize = candidate.key.length + candidate.content.length + 200;
                if (size + candidateSize > MemoryParser.MAX_MEMORY_CHARS) continue;
                kept.push(candidate);
                size += candidateSize;
            }
            if (!kept.some(candidate => candidate.key === normalized.key)) {
                return { success: false, message: `Memory store is full of higher-priority entries; "${entry.key}" was not saved.`, existed: !!existing };
            }
            kept.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
            this.writeStructuredEntries(kept, topicId);

            return {
                success: true,
                message: revalidatedProjectFact
                    ? `Project memory revalidated and updated: "${entry.key}"`
                    : `Memory saved: "${entry.key}"`,
                existed: !!existing,
                revalidatedProjectFact,
                storeRevision: normalized.storeRevision,
            };
        } catch (e: any) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error appending memory', e);
            return { success: false, message: `Failed to save memory: ${e?.message ?? e}` };
        }
    }

    public async forgetMemory(
        key: string,
        domain: AgentRuntimeDomain = 'paradox',
        mode: 'archive' | 'delete' = 'archive',
        topicId = this.topicId,
        expectedRevision?: number,
    ): Promise<{ success: boolean; message: string; storeRevision?: number }> {
        return this.withTopicWriteLock(topicId, async () => {
            const entries = this.readStructuredEntries(topicId);
            const index = entries.findIndex(entry => entry.key.toLowerCase() === key.trim().toLowerCase()
                && entry.domain === domain);
            if (index < 0) return { success: false, message: `Memory not found: "${key}"`, storeRevision: 0 };
            const entry = entries[index]!;
            const currentRevision = entry.storeRevision ?? 1;
            if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
                return {
                    success: false,
                    storeRevision: currentRevision,
                    message: `Memory revision conflict for "${key}": expected ${expectedRevision}, actual ${currentRevision}.`,
                };
            }
            if (mode === 'delete') {
                entries.splice(index, 1);
                this.writeStructuredEntries(entries, topicId);
                return { success: true, message: `Memory permanently deleted: "${key}"` };
            }
            entry.archivedAt = Date.now();
            entry.updatedAt = entry.archivedAt;
            entry.storeRevision = currentRevision + 1;
            this.writeStructuredEntries(entries, topicId);
            return { success: true, message: `Memory archived: "${key}"`, storeRevision: entry.storeRevision };
        });
    }

    /**
     * Prune the memory file by removing the oldest low-priority entries
     * until the file is under the character limit.
     */
    public pruneMemory(topicId = this.topicId): void {
        try {
            const structured = this.readStructuredEntries(topicId);
            if (structured.length > 0) {
                const now = Date.now();
                const active = structured.filter(entry => !entry.expiresAt || entry.expiresAt > now);
                this.writeStructuredEntries(active, topicId);
            }
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error pruning memory', e);
        }
    }
}
