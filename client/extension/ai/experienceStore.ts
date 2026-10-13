/**
 * Workspace-level experience store (经验沉淀与召回).
 *
 * Completed agent runs are distilled into a small set of reusable lessons
 * (validated approaches and known pitfalls) persisted per workspace, so a later
 * similar task recalls what worked instead of starting from scratch. The
 * private JSON store under the extension storage root is authoritative;
 * `<workspace>/.cwtools/experience.md` is a regenerated human-readable
 * projection and is fully rewritten on every structural store update.
 *
 * All text written by the (untrusted) distilling model is narrowed field by
 * field, length-capped, and secret-redacted before persistence. Prompt-time
 * recall is a bounded top-k keyword/confidence/freshness/usage ranking under a
 * strict character budget, mirroring the MemoryParser retrieval contract.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { ErrorReporter } from './errorReporter';
import { redactSensitiveText, tokenizeTaskKeywords } from './memoryParser';
import { getAiStorageRoot, getPrivateAiStorageRoot } from './workspacePaths';
import { contentToString, type ChatMessage } from './types';
import type { HistoryPersistenceMode } from './runner/historyPolicy';

const SOURCE = 'ExperienceStore';

export type ExperienceDomain = 'general' | 'paradox' | 'both';
export type ExperienceConfidence = 'low' | 'medium' | 'high';

export interface ExperienceEntry {
    id: string;
    title: string;
    lesson: string;
    approach?: string;
    pitfalls?: string[];
    fileAnchors?: string[];
    domain?: ExperienceDomain;
    createdAt: number;
    usageCount: number;
    lastUsedAt?: number;
    sourceRunId?: string;
    confidence: ExperienceConfidence;
}

/** A distilled lesson before store normalization (already type-narrowed). */
export interface ExperienceDraft {
    title: string;
    lesson: string;
    approach?: string;
    pitfalls?: string[];
    fileAnchors?: string[];
    domain?: ExperienceDomain;
    confidence?: ExperienceConfidence;
}

export interface ExperienceSearchOptions {
    /** Current task text; keyword overlap with title/lesson/anchors raises relevance. */
    taskText?: string;
    /** Active runtime domain; 'both' or omitted searches every domain. */
    domain?: ExperienceDomain;
    limit?: number;
    maxChars?: number;
    /** Bump usageCount/lastUsedAt for returned entries (default true). */
    markUsed?: boolean;
}

const STORE_FILE_NAME = 'experience.json';
const STORE_VERSION = 1;
const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_CHARS = 1500;
const FRESHNESS_DECAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TITLE_CHARS = 160;
const MAX_LESSON_CHARS = 1200;
const MAX_APPROACH_CHARS = 1200;
const MAX_PITFALLS = 6;
const MAX_PITFALL_CHARS = 240;
const MAX_ANCHORS = 8;
const MAX_ANCHOR_CHARS = 240;
/** title+lesson token Jaccard at or above which a new draft updates an existing entry. */
const MERGE_SIMILARITY_THRESHOLD = 0.6;
/** Runs below this tool-call count are pure Q&A and never distilled. */
export const MIN_TOOL_CALLS_FOR_EXPERIENCE = 5;
const MAX_DISTILLED_ENTRIES_PER_RUN = 3;

/**
 * Tools that mutate the workspace or drive other agents. A completed run with
 * no written files and no action-tool call is a read-only Q&A/research turn;
 * its findings belong to project memory/knowledge, not to reusable experience.
 */
const ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
    'write_file',
    'edit_file',
    'replace_lines',
    'typed_pdx_write',
    'write_localisation',
    'write_design_blueprint',
    'candidate_transaction',
    'instantiate_archetype',
    'run_command',
    'manage_process',
    'dispatch_agents',
    'team_task_create',
    'team_task_update',
    'convert_image_to_dds',
    'convert_audio',
    'deploy_mod_asset',
    'save_skill',
    'git_ops',
    'rename_symbol',
    'remove_ignored_diagnostic',
]);

// ─── Paths ──────────────────────────────────────────────────────────────────

function shortHash(content: string, length = 10): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, length);
}

/** Stable per-workspace key: readable basename plus a hash of the resolved path. */
function workspaceStoreKey(workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot);
    const normalized = (process.platform === 'win32' ? resolved.toLowerCase() : resolved).replace(/\\/g, '/');
    const base = path.basename(resolved).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || 'workspace';
    return `${base}-${shortHash(normalized)}`;
}

/** Authoritative private JSON store, namespaced per workspace under the private storage root. */
export function getExperienceStoreFilePath(workspaceRoot: string): string {
    if (!workspaceRoot) return '';
    const root = getPrivateAiStorageRoot(workspaceRoot);
    return root ? path.join(root, 'experience', workspaceStoreKey(workspaceRoot), STORE_FILE_NAME) : '';
}

/** Human-readable projection inside the workspace (regenerated, store wins). */
export function getExperienceProjectionPath(workspaceRoot: string): string {
    if (!workspaceRoot) return '';
    const aiRoot = getAiStorageRoot(workspaceRoot);
    return aiRoot ? path.join(aiRoot, 'experience.md') : '';
}

// ─── Sanitization ───────────────────────────────────────────────────────────

function clampText(value: string, maxChars: number): string {
    const redacted = redactSensitiveText(value.trim());
    return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
}

function clampStringList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const item = clampText(raw, maxChars);
        if (!item || seen.has(item.toLowerCase())) continue;
        seen.add(item.toLowerCase());
        items.push(item);
        if (items.length >= maxItems) break;
    }
    return items.length > 0 ? items : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asConfidence(value: unknown): ExperienceConfidence {
    return value === 'low' || value === 'high' ? value : 'medium';
}

function asDomain(value: unknown): ExperienceDomain | undefined {
    return value === 'general' || value === 'paradox' || value === 'both' ? value : undefined;
}

/** Validate one untrusted entry parsed from experience.json. Returns null when unusable. */
function sanitizeStoredEntry(raw: unknown): ExperienceEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) return null;
    if (typeof record.title !== 'string' || !record.title) return null;
    if (typeof record.lesson !== 'string' || !record.lesson) return null;
    return {
        id: record.id,
        title: record.title,
        lesson: record.lesson,
        approach: typeof record.approach === 'string' && record.approach ? record.approach : undefined,
        pitfalls: clampStringList(record.pitfalls, MAX_PITFALLS, MAX_PITFALL_CHARS),
        fileAnchors: clampStringList(record.fileAnchors, MAX_ANCHORS, MAX_ANCHOR_CHARS),
        domain: asDomain(record.domain),
        createdAt: asFiniteNumber(record.createdAt) ?? 0,
        usageCount: Math.max(0, asFiniteNumber(record.usageCount) ?? 0),
        lastUsedAt: asFiniteNumber(record.lastUsedAt),
        sourceRunId: typeof record.sourceRunId === 'string' && record.sourceRunId ? record.sourceRunId : undefined,
        confidence: asConfidence(record.confidence),
    };
}

// ─── Persistence ────────────────────────────────────────────────────────────

function readEntries(storePath: string): ExperienceEntry[] {
    try {
        if (!storePath || !fs.existsSync(storePath)) return [];
        const value: unknown = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        if (!value || typeof value !== 'object'
            || (value as { version?: unknown }).version !== STORE_VERSION) return [];
        const rawEntries = (value as { entries?: unknown }).entries;
        if (!Array.isArray(rawEntries)) return [];
        const entries: ExperienceEntry[] = [];
        for (const raw of rawEntries) {
            const entry = sanitizeStoredEntry(raw);
            if (entry) entries.push(entry);
        }
        return entries;
    } catch (error) {
        ErrorReporter.debug(SOURCE, `Error reading ${STORE_FILE_NAME}`, error);
        return [];
    }
}

/** Atomic single-file rewrite (write temp + rename), mirroring MemoryParser. */
function writeEntries(storePath: string, entries: ExperienceEntry[]): void {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: STORE_VERSION, entries }, null, 2), 'utf8');
    fs.renameSync(tmpPath, storePath);
}

function renderProjection(entries: ExperienceEntry[]): string {
    const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
    const blocks = sorted.map(entry => {
        const date = new Date(entry.createdAt || Date.now()).toISOString().slice(0, 10);
        const metadata = JSON.stringify({
            id: entry.id,
            confidence: entry.confidence,
            domain: entry.domain ?? 'both',
            usageCount: entry.usageCount,
            sourceRunId: entry.sourceRunId,
        });
        const lines = [`## [${date}] ${entry.title}`, `<!-- cwtools-experience: ${metadata} -->`, entry.lesson];
        if (entry.approach) lines.push('', `Approach: ${entry.approach}`);
        if (entry.pitfalls?.length) lines.push('', 'Pitfalls:', ...entry.pitfalls.map(pitfall => `- ${pitfall}`));
        if (entry.fileAnchors?.length) lines.push('', `Files: ${entry.fileAnchors.join(', ')}`);
        return lines.join('\n');
    });
    return [
        '# CWTools Workspace Experience',
        '',
        '> Auto-generated projection of the private experience store. The store is',
        '> authoritative and this file is fully rewritten on every store update;',
        '> manual edits here are overwritten. Distilled from successfully completed',
        '> agent runs; recall prefers validated approaches for similar tasks.',
        '',
        ...blocks.map(block => `${block}\n`),
    ].join('\n');
}

function refreshProjection(workspaceRoot: string, entries: ExperienceEntry[]): void {
    try {
        const projectionPath = getExperienceProjectionPath(workspaceRoot);
        if (!projectionPath) return;
        fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
        fs.writeFileSync(projectionPath, renderProjection(entries), 'utf8');
    } catch (error) {
        ErrorReporter.debug(SOURCE, 'Failed to refresh experience.md projection', error);
    }
}

// ─── Scoring & merge ────────────────────────────────────────────────────────

const CONFIDENCE_SCORE: Record<ExperienceConfidence, number> = { high: 2, medium: 1.2, low: 0.5 };

function scoreExperienceEntry(entry: ExperienceEntry, keywords: string[], now: number): number {
    let score = CONFIDENCE_SCORE[entry.confidence];
    if (keywords.length > 0) {
        const hits = keywordHitCount(entry, keywords);
        if (hits === 0) return Number.NEGATIVE_INFINITY;
        score += (hits / keywords.length) * 4;
    }
    const ageMs = Math.max(0, now - entry.createdAt);
    score += 2 * Math.exp(-ageMs / FRESHNESS_DECAY_MS);
    score += Math.min(entry.usageCount, 5) * 0.3;
    if (entry.lastUsedAt !== undefined) {
        score += Math.exp(-Math.max(0, now - entry.lastUsedAt) / FRESHNESS_DECAY_MS);
    }
    return score;
}

function keywordHitCount(entry: ExperienceEntry, keywords: string[]): number {
    const haystack = `${entry.title}\n${entry.lesson}\n${entry.approach ?? ''}\n${(entry.fileAnchors ?? []).join('\n')}`.toLowerCase();
    let hits = 0;
    for (const keyword of keywords) {
        if (haystack.includes(keyword)) hits++;
    }
    return hits;
}

function entryTokens(entry: { title: string; lesson: string }): Set<string> {
    return new Set(tokenizeTaskKeywords(`${entry.title}\n${entry.lesson}`));
}

/** Jaccard similarity over the title+lesson keyword sets. */
export function experienceSimilarity(a: { title: string; lesson: string }, b: { title: string; lesson: string }): number {
    const aTokens = entryTokens(a);
    const bTokens = entryTokens(b);
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    let intersection = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) intersection++;
    }
    return intersection / (aTokens.size + bTokens.size - intersection);
}

function domainMatches(entry: ExperienceEntry, domain: ExperienceDomain | undefined): boolean {
    if (!domain || domain === 'both') return true;
    return entry.domain === undefined || entry.domain === 'both' || entry.domain === domain;
}

function unionStringLists(existing: string[] | undefined, incoming: string[] | undefined, maxItems: number): string[] | undefined {
    const combined = [...(existing ?? []), ...(incoming ?? [])];
    return combined.length > 0 ? clampStringList(combined, maxItems, MAX_PITFALL_CHARS) : undefined;
}

function normalizeDraft(draft: ExperienceDraft, existing: ExperienceEntry | undefined, sourceRunId: string | undefined, now: number): ExperienceEntry {
    const pitfalls = clampStringList(draft.pitfalls, MAX_PITFALLS, MAX_PITFALL_CHARS);
    const fileAnchors = clampStringList(draft.fileAnchors, MAX_ANCHORS, MAX_ANCHOR_CHARS);
    return {
        id: existing?.id ?? `exp_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
        title: clampText(draft.title, MAX_TITLE_CHARS),
        lesson: clampText(draft.lesson, MAX_LESSON_CHARS),
        approach: draft.approach ? clampText(draft.approach, MAX_APPROACH_CHARS) : existing?.approach,
        // Merging unions the accumulated arrays; freshest text fields win.
        pitfalls: existing ? unionStringLists(existing.pitfalls, pitfalls, MAX_PITFALLS) : pitfalls,
        fileAnchors: existing ? unionStringLists(existing.fileAnchors, fileAnchors, MAX_ANCHORS) : fileAnchors,
        domain: asDomain(draft.domain) ?? existing?.domain,
        createdAt: existing?.createdAt ?? now,
        usageCount: existing?.usageCount ?? 0,
        lastUsedAt: existing?.lastUsedAt,
        sourceRunId: sourceRunId ?? existing?.sourceRunId,
        confidence: asConfidence(draft.confidence ?? existing?.confidence),
    };
}

/** Lowest score is evicted first: frequent and fresh experience survives. */
function evictionScore(entry: ExperienceEntry, now: number): number {
    const ageMs = Math.max(0, now - entry.createdAt);
    return entry.usageCount * 2
        + CONFIDENCE_SCORE[entry.confidence]
        + 2 * Math.exp(-ageMs / (2 * FRESHNESS_DECAY_MS));
}

// ─── Public API: append & search ────────────────────────────────────────────

/**
 * Append distilled drafts to the workspace store. Drafts whose title+lesson
 * keywords closely match an existing entry merge into it (arrays union, usage
 * stats carried over) instead of duplicating. Beyond MAX_ENTRIES the
 * least-used, stalest entries are evicted. Rewrites the experience.md
 * projection. Returns the stored (new or merged) entries.
 */
export function appendExperiences(
    workspaceRoot: string,
    drafts: ExperienceDraft[],
    options?: { sourceRunId?: string },
): { appended: number; merged: number; stored: ExperienceEntry[] } {
    const empty = { appended: 0, merged: 0, stored: [] as ExperienceEntry[] };
    try {
        const storePath = getExperienceStoreFilePath(workspaceRoot);
        if (!storePath || drafts.length === 0) return empty;
        const now = Date.now();
        const entries = readEntries(storePath);
        const stored: ExperienceEntry[] = [];
        let appended = 0;
        let merged = 0;
        for (const draft of drafts.slice(0, MAX_DISTILLED_ENTRIES_PER_RUN)) {
            if (typeof draft?.title !== 'string' || !draft.title.trim()
                || typeof draft.lesson !== 'string' || !draft.lesson.trim()) continue;
            let best: ExperienceEntry | undefined;
            let bestScore = MERGE_SIMILARITY_THRESHOLD;
            for (const candidate of entries) {
                const similarity = experienceSimilarity(draft, candidate);
                if (similarity >= bestScore) {
                    best = candidate;
                    bestScore = similarity;
                }
            }
            const normalized = normalizeDraft(draft, best, options?.sourceRunId, now);
            if (best) {
                const index = entries.indexOf(best);
                if (index >= 0) entries.splice(index, 1, normalized);
                merged++;
            } else {
                entries.push(normalized);
                appended++;
            }
            stored.push(normalized);
        }
        if (stored.length === 0) return empty;
        if (entries.length > MAX_ENTRIES) {
            entries.sort((a, b) =>
                evictionScore(b, now) - evictionScore(a, now)
                || b.createdAt - a.createdAt
                || a.id.localeCompare(b.id));
            entries.length = MAX_ENTRIES;
        }
        entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        writeEntries(storePath, entries);
        refreshProjection(workspaceRoot, entries);
        return { appended, merged, stored };
    } catch (error) {
        ErrorReporter.debug(SOURCE, 'Error appending experiences', error);
        return empty;
    }
}

/**
 * Recall the most relevant experience for the current task as a prompt block.
 * Ranking: keyword overlap with the task text, confidence, freshness, and past
 * usage; when the task text yields keywords, an entry must share at least one
 * (recall is similarity-gated — unrelated lessons are never injected). The
 * total block stays under maxChars. Returned entries count as used
 * (usageCount/lastUsedAt rewrite, projection untouched). Empty string when the
 * store is missing, empty, or nothing survives the domain/relevance filter.
 */
export function searchExperiences(
    workspaceRoot: string,
    options: ExperienceSearchOptions = {},
): { text: string; entries: ExperienceEntry[] } {
    const empty = { text: '', entries: [] as ExperienceEntry[] };
    try {
        const storePath = getExperienceStoreFilePath(workspaceRoot);
        if (!storePath) return empty;
        const all = readEntries(storePath);
        if (all.length === 0) return empty;
        const now = Date.now();
        const keywords = options.taskText ? tokenizeTaskKeywords(options.taskText) : [];
        const ranked = all
            .filter(entry => domainMatches(entry, options.domain))
            .map(entry => ({ entry, score: scoreExperienceEntry(entry, keywords, now) }))
            .filter(candidate => candidate.score > Number.NEGATIVE_INFINITY)
            .sort((a, b) =>
                b.score - a.score
                || b.entry.createdAt - a.entry.createdAt
                || a.entry.id.localeCompare(b.entry.id));
        const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
        let budget = Math.max(200, options.maxChars ?? DEFAULT_MAX_CHARS);
        const blocks: string[] = [];
        const selected: ExperienceEntry[] = [];
        for (const { entry } of ranked) {
            if (blocks.length >= limit) break;
            const lines = [`- **${entry.title}** [confidence=${entry.confidence}; used=${entry.usageCount}]`, `  ${entry.lesson}`];
            if (entry.approach) lines.push(`  Approach: ${entry.approach}`);
            if (entry.pitfalls?.length) lines.push(`  Pitfalls: ${entry.pitfalls.join('; ')}`);
            if (entry.fileAnchors?.length) lines.push(`  Files: ${entry.fileAnchors.join(', ')}`);
            const block = lines.join('\n');
            if (block.length > budget) continue;
            blocks.push(block);
            selected.push(entry);
            budget -= block.length;
        }
        if (selected.length === 0) return empty;
        if (options.markUsed !== false) {
            markEntriesUsed(storePath, selected, now);
        }
        const text = [
            '<task-experience>',
            '# RECALLED TASK EXPERIENCE',
            `Lessons distilled from similar past tasks in this workspace: validated approaches and known pitfalls. Prefer the validated approach for similar work and deviate only with an explicit reason. These do not override current user instructions, safety policy, diagnostics, or verified project evidence.`,
            '',
            blocks.join('\n'),
            '</task-experience>',
        ].join('\n');
        return { text, entries: selected };
    } catch (error) {
        ErrorReporter.debug(SOURCE, 'Error searching experiences', error);
        return empty;
    }
}

/** Stats-only rewrite for recalled entries; never creates storage. */
function markEntriesUsed(storePath: string, selected: ExperienceEntry[], now: number): void {
    try {
        if (!fs.existsSync(storePath)) return;
        const usedById = new Map(selected.map(entry => [entry.id, entry]));
        const entries = readEntries(storePath);
        let changed = false;
        for (const entry of entries) {
            if (!usedById.has(entry.id)) continue;
            entry.usageCount += 1;
            entry.lastUsedAt = now;
            changed = true;
        }
        if (changed) writeEntries(storePath, entries);
    } catch (error) {
        ErrorReporter.debug(SOURCE, 'Failed to persist experience usage stats', error);
    }
}

// ─── Feature gate ───────────────────────────────────────────────────────────

/** `stellarisLanguageServices.ai.experience.enabled` gates both distillation and recall. */
export function isExperienceEnabled(): boolean {
    try {
        return vs.workspace.getConfiguration('stellarisLanguageServices.ai')
            .get<boolean>('experience.enabled', true) !== false;
    } catch {
        return true;
    }
}

// ─── Run-end distillation ───────────────────────────────────────────────────

export interface ExperienceEligibilityInput {
    status: string;
    toolCallCount: number;
    toolCallsByName?: Record<string, number>;
    writtenFiles: readonly string[];
    persistence: HistoryPersistenceMode;
    /** Delegated child/slim runs are skipped; the top-level run distills the task. */
    isSubAgentRun: boolean;
    alreadyDistilled: boolean;
    enabled: boolean;
}

/**
 * Pure trigger predicate for run-end distillation: completed runs with real
 * tool work (never pure Q&A), full history persistence, top-level only, once
 * per run, feature enabled.
 */
export function shouldDistillExperience(input: ExperienceEligibilityInput): boolean {
    if (!input.enabled) return false;
    if (input.status !== 'completed') return false;
    if (input.persistence !== 'full') return false;
    if (input.isSubAgentRun || input.alreadyDistilled) return false;
    if (!Number.isFinite(input.toolCallCount) || input.toolCallCount < MIN_TOOL_CALLS_FOR_EXPERIENCE) return false;
    if (input.writtenFiles.length > 0) return true;
    const toolCallsByName = input.toolCallsByName ?? {};
    return Object.keys(toolCallsByName).some(name => ACTION_TOOL_NAMES.has(name) && (toolCallsByName[name] ?? 0) > 0);
}

export interface ExperienceDistillationInput {
    /** Original user goal of the run. */
    goal: string;
    /** Final assistant answer (truncated inside the prompt builder). */
    finalAnswer?: string;
    toolCallsByName?: Record<string, number>;
    failedToolCount?: number;
    writtenFiles?: readonly string[];
}

const DISTILLATION_PROMPT_LIMITS = { goal: 2000, finalAnswer: 1500, writtenFiles: 12, toolLines: 16 };

/** Build the (bounded) distillation request; provider-agnostic two-message shape. */
export function buildExperienceDistillationMessages(input: ExperienceDistillationInput): ChatMessage[] {
    const toolLines = Object.entries(input.toolCallsByName ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, DISTILLATION_PROMPT_LIMITS.toolLines)
        .map(([name, count]) => `- ${name}: ${count}`);
    const failed = Math.max(0, input.failedToolCount ?? 0);
    const writtenFiles = (input.writtenFiles ?? []).slice(0, DISTILLATION_PROMPT_LIMITS.writtenFiles);
    const userContent = [
        'A coding-agent run just completed successfully in this workspace. Extract at most 3 reusable lessons that would help a future agent complete a similar task faster or avoid the same mistakes. Skip one-off facts that only matter for this exact request.',
        '',
        '## User goal',
        input.goal.slice(0, DISTILLATION_PROMPT_LIMITS.goal) || '(unavailable)',
        '',
        '## Final answer',
        (input.finalAnswer ?? '').slice(0, DISTILLATION_PROMPT_LIMITS.finalAnswer) || '(none)',
        '',
        '## Tool usage',
        toolLines.length > 0 ? toolLines.join('\n') : '(none)',
        failed > 0 ? `- failed tool calls: ${failed}` : '',
        '',
        '## Files written',
        writtenFiles.length > 0 ? writtenFiles.map(file => `- ${file}`).join('\n') : '(none)',
        '',
        'Rules:',
        '- Reply with a strict JSON array of at most 3 objects and nothing else; reply [] when nothing is generalizable.',
        '- Object shape: {"title": string (≤80 chars), "lesson": string (what to do or avoid next time), "approach"?: string (validated steps), "pitfalls"?: string[], "fileAnchors"?: string[] (workspace-relative paths worth revisiting), "confidence"?: "low"|"medium"|"high"}.',
        '- Write title/lesson/approach/pitfalls in the same language as the user goal.',
        '- Never include secrets, credentials, absolute paths, or ephemeral identifiers.',
    ].filter(line => line !== '').join('\n');
    return [
        { role: 'system', content: 'You distill reusable workspace experience from completed coding-agent runs. Output strict JSON only.' },
        { role: 'user', content: userContent },
    ];
}

/** Extract the first JSON array from untrusted model output (fences or prose tolerated). */
function extractJsonArrayText(raw: string): string | undefined {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const candidates = [fenced?.[1], raw];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const start = candidate.indexOf('[');
        const end = candidate.lastIndexOf(']');
        if (start >= 0 && end > start) return candidate.slice(start, end + 1);
    }
    return undefined;
}

/**
 * Narrow untrusted LLM output into at most MAX_DISTILLED_ENTRIES_PER_RUN
 * drafts. Unparseable output and invalid items are dropped silently.
 */
export function parseExperienceDistillation(raw: string): ExperienceDraft[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const arrayText = extractJsonArrayText(raw);
    if (!arrayText) return [];
    let value: unknown;
    try {
        value = JSON.parse(arrayText);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) return [];
    const drafts: ExperienceDraft[] = [];
    for (const item of value) {
        if (drafts.length >= MAX_DISTILLED_ENTRIES_PER_RUN) break;
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.title !== 'string' || !record.title.trim()) continue;
        if (typeof record.lesson !== 'string' || !record.lesson.trim()) continue;
        drafts.push({
            title: record.title,
            lesson: record.lesson,
            approach: typeof record.approach === 'string' && record.approach.trim() ? record.approach : undefined,
            pitfalls: clampStringList(record.pitfalls, MAX_PITFALLS, MAX_PITFALL_CHARS),
            fileAnchors: clampStringList(record.fileAnchors, MAX_ANCHORS, MAX_ANCHOR_CHARS),
            domain: asDomain(record.domain),
            confidence: asConfidence(record.confidence),
        });
    }
    return drafts;
}

/** Injectable paid-model channel; tests substitute a fake requester. */
export type ExperienceRequester = (messages: ChatMessage[]) => Promise<string>;

/**
 * Distill one completed run into the workspace store. Parse failures store
 * nothing (silent); request errors propagate to the caller, which treats the
 * whole flow as best-effort.
 */
export async function distillRunExperience(
    workspaceRoot: string,
    input: ExperienceDistillationInput & { sourceRunId?: string },
    request: ExperienceRequester,
): Promise<{ stored: number; titles: string[] }> {
    const messages = buildExperienceDistillationMessages(input);
    const raw = await request(messages);
    const drafts = parseExperienceDistillation(raw);
    if (drafts.length === 0) return { stored: 0, titles: [] };
    const result = appendExperiences(workspaceRoot, drafts, { sourceRunId: input.sourceRunId });
    return { stored: result.stored.length, titles: result.stored.map(entry => entry.title) };
}

/** Convenience for callers holding a full ChatMessage response shape. */
export function experienceRequesterFromChatCompletion(
    chatCompletion: (messages: ChatMessage[]) => Promise<{ choices?: Array<{ message?: { content?: ChatMessage['content'] } }> }>,
): ExperienceRequester {
    return async (messages) => contentToString((await chatCompletion(messages))?.choices?.[0]?.message?.content);
}
