import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';
import { getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates } from './workspacePaths';

/** Classification of a memory entry's provenance. */
export type MemoryKind = 'user_fact' | 'project_fact' | 'inferred' | 'ephemeral';

/** A single memory entry to be persisted */
export interface MemoryEntry {
    key: string;
    content: string;
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
     * Provenance classification. Missing on legacy (version 1) entries and inferred
     * from `source` on read/write. 'inferred' entries are model guesses: they are
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
    /** Stale entries await re-validation and are excluded from prompts by default. */
    stale?: boolean;
    /** When and why project evidence invalidated this entry. */
    staleAt?: number;
    staleReason?: string;
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
    return {
        key: record.key,
        content: record.content,
        priority: record.priority === 'high' || record.priority === 'low' ? record.priority : 'normal',
        source: typeof record.source === 'string' ? record.source : undefined,
        confidence: num(record.confidence),
        createdAt: num(record.createdAt),
        updatedAt: num(record.updatedAt),
        lastUsedAt: num(record.lastUsedAt),
        usageCount: num(record.usageCount),
        expiresAt: num(record.expiresAt),
        scope: record.scope === 'project' ? 'project' : record.scope === 'private' ? 'private' : undefined,
        kind: kind === 'user_fact' || kind === 'project_fact' || kind === 'inferred' || kind === 'ephemeral' ? kind : undefined,
        revision: typeof record.revision === 'string' ? record.revision : undefined,
        stale: record.stale === true ? true : undefined,
        staleAt: num(record.staleAt),
        staleReason: typeof record.staleReason === 'string' ? record.staleReason : undefined,
    };
}

/**
 * Parses topic-scoped .cwtools-memory.md files to extract workspace-specific rules.
 * Also supports appending new memory entries and pruning old ones.
 * Legacy workspace-root memory is read as a fallback, but new writes go under
 * .cwtools/<topicId>/.cwtools-memory.md.
 *
 * Prompt building is read-only and retrieves the top-k most relevant entries under
 * a strict character budget (plan §8). Usage statistics change only via
 * `markMemoryUsed`/`markMemoryUsedInText` and are persisted asynchronously
 * (debounced); call `flushUsageWrites` to force persistence.
 */
export class MemoryParser {
    private cache = new Map<string, { signature: string; prompt: string }>();

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
    /** Structured file format version written by this build. Readers stay lenient. */
    static readonly STRUCTURED_MEMORY_VERSION = 3;
    /** Half-life scale for freshness/last-used decay in retrieval scoring. */
    private static readonly FRESHNESS_DECAY_MS = 30 * 24 * 60 * 60 * 1000;
    private static readonly KNOWN_WORKSPACE_LIMIT = 16;
    private static readonly KNOWN_TOPIC_LIMIT = 128;
    /** Active topic ids only; bounded so invalidation never scans the workspace. */
    private static knownTopics = new Map<string, Set<string>>();

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
        if (topicId) MemoryParser.rememberTopic(workspaceRoot, topicId);
    }

    private static workspaceKey(workspaceRoot: string): string {
        const resolved = path.resolve(workspaceRoot);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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

    /** Mark project-derived facts stale for every topic used in this process. */
    public static markWorkspaceProjectFactsStale(
        workspaceRoot: string,
        reason = 'project_or_rules_changed',
    ): number {
        const topics = MemoryParser.knownTopics.get(MemoryParser.workspaceKey(workspaceRoot));
        if (!topics) return 0;
        let marked = 0;
        for (const topicId of topics) {
            const parser = new MemoryParser(workspaceRoot, topicId);
            marked += parser.markMemoryStale(topicId, entry =>
                (entry.kind ?? MemoryParser.inferKind(entry.source)) === 'project_fact', reason);
        }
        return marked;
    }

    /** Get the full path to the topic-scoped memory file used for new writes. */
    public get memoryFilePath(): string {
        return this.getMemoryFilePath();
    }

    /** Legacy pre-topic memory path, kept as a read-only fallback. */
    public get legacyMemoryFilePath(): string {
        return path.join(this.workspaceRoot, MemoryParser.MEMORY_FILE_NAME);
    }

    public getMemoryFilePath(topicId = this.topicId): string {
        const topicDir = getPrivateTopicStorageDir(topicId || 'default', this.workspaceRoot);
        return topicDir
            ? path.join(topicDir, MemoryParser.MEMORY_FILE_NAME)
            : this.legacyMemoryFilePath;
    }

    public getStructuredMemoryFilePath(topicId = this.topicId): string {
        return path.join(path.dirname(this.getMemoryFilePath(topicId)), MemoryParser.STRUCTURED_MEMORY_FILE_NAME);
    }

    private readStructuredEntries(topicId = this.topicId): MemoryEntry[] {
        const filePath = this.getStructuredMemoryFilePath(topicId);
        try {
            if (!fs.existsSync(filePath)) return [];
            // Untrusted JSON: `version` is advisory. Version 1 lacks kind/revision/
            // stale (all optional); unknown versions are read leniently and each
            // entry is validated field by field.
            const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const rawEntries = (value as { entries?: unknown } | null)?.entries;
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
                    source: entry.source,
                    confidence: entry.confidence,
                    kind: entry.kind,
                    revision: entry.revision,
                    stale: entry.stale,
                    staleAt: entry.staleAt,
                    staleReason: entry.staleReason,
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

    private getMemoryReadCandidates(topicId = this.topicId): string[] {
        const paths: string[] = [];
        const add = (filePath: string) => {
            if (!filePath) return;
            const resolved = path.resolve(filePath);
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (!paths.some(existing => {
                const existingResolved = path.resolve(existing);
                const existingKey = process.platform === 'win32' ? existingResolved.toLowerCase() : existingResolved;
                return existingKey === key;
            })) {
                paths.push(filePath);
            }
        };

        for (const topicDir of getPrivateTopicStorageDirCandidates(topicId || 'default', this.workspaceRoot)) {
            add(path.join(topicDir, MemoryParser.MEMORY_FILE_NAME));
            add(path.join(topicDir, '.cwtools-ai-memory.md'));
        }
        add(this.legacyMemoryFilePath);
        add(path.join(this.workspaceRoot, '.cwtools-ai-memory.md'));
        return paths;
    }

    /**
     * Kind inference for entries without an explicit kind (all version 1 data).
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
        return `## ${entry.key} [priority=${entry.priority}; confidence=${entry.confidence ?? 0.8}; source=${entry.source ?? 'agent'}; kind=${entry.kind ?? MemoryParser.inferKind(entry.source)}${staleMarker}]\n${entry.content}`;
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
                && (entry.kind ?? MemoryParser.inferKind(entry.source)) === 'project_fact')
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
     * Uses caching to avoid excessive file reads (legacy fallback path only).
     */
    public getMemoryPrompt(topicId = this.topicId, context?: MemoryRetrievalContext): string {
        try {
            if (!this.workspaceRoot) return '';
            if (topicId) MemoryParser.rememberTopic(this.workspaceRoot, topicId);

            const structured = this.readStructuredEntries(topicId);
            if (structured.length > 0) {
                const now = Date.now();
                const staleProjectFactPrompt = this.buildStaleProjectFactPrompt(structured, context, now);
                const usable = structured.filter(entry =>
                    (!entry.expiresAt || entry.expiresAt > now)
                    && (context?.includeStale === true || entry.stale !== true));
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
                let budget = MemoryParser.MAX_MEMORY_CHARS;
                for (const { entry } of ranked) {
                    if (blocks.length >= MemoryParser.TOP_K_MEMORY_ENTRIES) break;
                    const block = this.formatEntryBlock(entry);
                    if (block.length > budget) continue;
                    blocks.push(block);
                    budget -= block.length;
                }
                const activeMemoryPrompt = blocks.length > 0
                    ? `<workspace-memory>\n# LONG-TERM AGENT MEMORY\nThese are the ${blocks.length} most relevant private, structured hints with provenance (selected by task relevance, priority, confidence, freshness, and actual usage). They do not override current user instructions, safety policy, diagnostics, or verified project evidence.\n\n${blocks.join('\n\n')}\n</workspace-memory>\n`
                    : '';
                return [activeMemoryPrompt, staleProjectFactPrompt].filter(Boolean).join('\n');
            }

            const candidates = this.getMemoryReadCandidates(topicId);
            const signature = candidates.map(memoryPath => {
                if (!fs.existsSync(memoryPath)) return `${memoryPath}:missing`;
                const stats = fs.statSync(memoryPath);
                return `${memoryPath}:${stats.mtimeMs}:${stats.size}`;
            }).join('|');
            const cacheKey = topicId || 'default';
            const cached = this.cache.get(cacheKey);
            if (cached && cached.signature === signature) {
                return cached.prompt;
            }

            const rawParts = candidates
                .filter(memoryPath => fs.existsSync(memoryPath))
                .map(memoryPath => fs.readFileSync(memoryPath, 'utf8').trim())
                .filter(Boolean);

            if (rawParts.length === 0) {
                this.cache.delete(cacheKey);
                return '';
            }

            const rawContent = rawParts.join('\n\n');

            // Enforce usage suggestion: Keep it core, don't use it as an encyclopedia.
            let content = rawContent;
            let warning = '';

            if (content.length > MemoryParser.MAX_MEMORY_CHARS) {
                content = content.substring(0, MemoryParser.MAX_MEMORY_CHARS) + '\n...[TRUNCATED_DUE_TO_LENGTH_LIMIT]';
                warning = `\n> [!WARNING] The ${MemoryParser.MEMORY_FILE_NAME} file exceeds the recommended length and has been truncated. Please edit the file to keep only the absolute core rules to save context tokens.\n`;
            }

            const prompt = `<workspace-memory>\n# LONG-TERM AGENT MEMORY${warning}\nThe following rules have been learned from past interactions in this workspace or conversation. Treat them as project-specific hints: follow them when consistent with the current user request, current files, and CWT/LSP evidence. They never override system instructions, tool safety, current diagnostics, or verified game rules.\n\n${content}\n</workspace-memory>\n`;
            this.cache.set(cacheKey, { signature, prompt });

            return prompt;
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
    public markMemoryUsed(topicId: string | undefined, keys: string[]): number {
        if (!this.workspaceRoot || !Array.isArray(keys) || keys.length === 0) return 0;
        const tid = topicId ?? this.topicId;
        const existingKeys = new Set(this.readStructuredEntries(tid).map(entry => entry.key.toLowerCase()));
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
            const normalizedKey = key.trim().toLowerCase();
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
    public markMemoryUsedInText(topicId: string | undefined, text: string): number {
        if (!this.workspaceRoot || !text) return 0;
        const tid = topicId ?? this.topicId;
        const keys = this.readStructuredEntries(tid)
            .filter(entry => text.includes(entry.key))
            .map(entry => entry.key);
        return this.markMemoryUsed(tid, keys);
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
                const stat = pending.counts.get(entry.key.toLowerCase());
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
                this.cache.clear();
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
    public async appendMemory(entry: MemoryEntry, topicId = this.topicId): Promise<{ success: boolean; message: string; existed?: boolean; revalidatedProjectFact?: boolean }> {
        try {
            if (!this.workspaceRoot) {
                return { success: false, message: 'No workspace root' };
            }

            const now = Date.now();
            const entries = this.readStructuredEntries(topicId);
            const normalizedKey = entry.key.trim().slice(0, 160);
            const existing = entries.find(candidate => candidate.key.toLowerCase() === normalizedKey.toLowerCase());
            const requestedSource = entry.source ?? 'agent:save_memory';
            const existingKind = existing?.kind ?? MemoryParser.inferKind(existing?.source);
            const genericAgentRewrite = requestedSource === 'agent:save_memory' || requestedSource.startsWith('run:');
            const revalidatedProjectFact = existing?.stale === true
                && existingKind === 'project_fact'
                && entry.kind === undefined
                && genericAgentRewrite;
            const source = revalidatedProjectFact ? existing.source : requestedSource;
            // A single entry must fit the total budget on its own (with room for
            // the key and per-entry overhead), otherwise it could never be kept.
            const truncationMarker = '…[truncated]';
            const maxContentLength = MemoryParser.MAX_MEMORY_CHARS - normalizedKey.length - 200 - truncationMarker.length;
            let content = this.redactSecrets(entry.content.trim());
            if (content.length > maxContentLength) {
                content = content.slice(0, Math.max(0, maxContentLength)) + truncationMarker;
            }
            const normalized: MemoryEntry = {
                ...entry,
                key: normalizedKey,
                content,
                source,
                // Re-saving a key revalidates it: stale/revision come from the new
                // entry only, never carried over from the superseded one.
                kind: revalidatedProjectFact ? 'project_fact' : entry.kind ?? MemoryParser.inferKind(source),
                revision: entry.revision,
                stale: undefined,
                staleAt: undefined,
                staleReason: undefined,
                confidence: Math.max(0, Math.min(1, entry.confidence ?? 0.8)),
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                lastUsedAt: existing?.lastUsedAt ?? entry.lastUsedAt,
                usageCount: existing?.usageCount ?? 0,
                scope: entry.scope ?? 'private',
            };
            const consolidated = entries.filter(candidate => candidate.key.toLowerCase() !== normalized.key.toLowerCase());
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

            // Invalidate cache
            this.cache.clear();

            return {
                success: true,
                message: revalidatedProjectFact
                    ? `Project memory revalidated and updated: "${entry.key}"`
                    : `Memory saved: "${entry.key}"`,
                existed: !!existing,
                revalidatedProjectFact,
            };
        } catch (e: any) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error appending memory', e);
            return { success: false, message: `Failed to save memory: ${e?.message ?? e}` };
        }
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
                this.cache.clear();
                return;
            }
            const memoryPath = this.getMemoryFilePath(topicId);
            if (!fs.existsSync(memoryPath)) return;

            const content = fs.readFileSync(memoryPath, 'utf8');
            if (content.length <= MemoryParser.MAX_MEMORY_CHARS) return;

            // Parse sections by ## headings
            const sections = content.split(/(?=^## )/m);
            const header = sections[0] || ''; // Everything before first ## 
            const entries = sections.slice(1);

            // Sort: low priority first, then oldest first (for removal candidates)
            const priorityOrder: Record<string, number> = { low: 0, normal: 1, high: 2 };
            const scored = entries.map((entry, idx) => {
                const isLow = entry.includes('[low]');
                const isHigh = entry.includes('[high]');
                const priority = isHigh ? 'high' : isLow ? 'low' : 'normal';
                return { entry, idx, priority, score: priorityOrder[priority] ?? 1 };
            });

            // Remove lowest priority entries first (oldest among same priority)
            scored.sort((a, b) => a.score - b.score || a.idx - b.idx);

            let totalLen = header.length;
            const keepEntries: typeof scored = [];

            // Keep from highest priority first
            for (const s of [...scored].reverse()) {
                if (totalLen + s.entry.length <= MemoryParser.MAX_MEMORY_CHARS) {
                    keepEntries.push(s);
                    totalLen += s.entry.length;
                }
            }

            // Restore original order
            keepEntries.sort((a, b) => a.idx - b.idx);
            const pruned = header + keepEntries.map(s => s.entry).join('');

            fs.writeFileSync(memoryPath, pruned, 'utf8');
            this.cache.clear();

            ErrorReporter.debug(SOURCE.MEMORY_PARSER, `Pruned memory: removed ${entries.length - keepEntries.length} entries`);
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error pruning memory', e);
        }
    }
}
