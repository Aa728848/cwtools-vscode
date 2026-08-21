import type { ChatMessage, AgentStep, TokenUsage } from '../types';
import type { AgentRunnerOptions } from '../agentRunner';
import { contentToString } from '../types';
import { getModelContextTokens, getProvider } from '../providers';
import { isDeepSeekModelOrProvider } from '../providers/models/capabilities';
import { getCacheDiscountFactor, getCurrentModelPricing } from '../pricing';
import { AGENT } from '../messages';
import type { AIService } from '../aiService';
import type { PromptBuilder } from '../promptBuilder';
import { OutputRepetitionDetector } from './outputRepetitionDetector';
import { runtimeFaultInjector } from './faultInjection';
import { estimateTokenCount, estimateChatMessagesTokens, CHARS_PER_TOKEN } from './tokenEstimation';
import { cloneChatMessage, normalizeTranscriptForPersistence, splitTranscriptForCompaction } from './contextTranscript';
import type { CompactionTranscriptSplit } from './contextTranscript';
import * as crypto from 'crypto';
import { appendCacheRequestUsage, isCacheCapableUsage } from '../cacheCapability';

// Leave room for the system prompt, tool schemas, the current turn, and output.
// Both Codex and Claude Code compact before the model's hard context boundary.
// High watermark: automatic compaction triggers at this fraction of the window.
export const COMPACTION_THRESHOLD_RATIO = 0.80;
// Low watermark: compaction shrinks the retained tail until the projected
// post-compaction request fits under this fraction, so the high watermark is
// not immediately re-armed by the next turn.
export const COMPACTION_TARGET_RATIO = 0.60;
// Default context limit if unknown
export const DEFAULT_CONTEXT_LIMIT = 128000;
// Upper bound on recent messages kept un-compressed during compaction; the
// low-watermark target may shrink the retained tail below this count.
export const COMPACTION_KEEP_LAST_N = 8;
// Mid-loop compaction: check every N iterations within reasoningLoop
export const MID_LOOP_COMPACTION_INTERVAL = 3;
// Mid-loop compaction triggers at this fraction of context limit
export const MID_LOOP_COMPACTION_RATIO = 0.78;
// Minimum spacing between two paid automatic compactions; near-threshold
// histories would otherwise recompact on every turn with barely-changed content.
export const AUTO_COMPACTION_MIN_INTERVAL_MS = 60_000;
const MIN_HISTORY_TOKENS_FOR_AUTO_COMPACTION = 2_048;
// Reserve for the generated summary when projecting post-compaction tokens.
const COMPACTION_SUMMARY_RESERVE_TOKENS = 2_048;
// Above this fraction of the window the minimum-interval throttle never skips
// an automatic compaction, so near-full contexts still compact on time.
const AUTO_COMPACTION_THROTTLE_BYPASS_RATIO = 0.92;
// Bounded cache of recent compaction results keyed by transcript fingerprint.
const COMPACTION_SUMMARY_CACHE_CAPACITY = 4;

const COMPACTION_SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:

---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export interface CompactionDependencies {
    aiService: AIService;
    promptBuilder: PromptBuilder;
}

export interface AutoCompactionThrottle {
    /** Timestamp (ms) of the last completed paid automatic compaction; 0 = never. */
    lastAutoCompactionAt: number;
    /** Minimum spacing between two paid automatic compactions. */
    minIntervalMs: number;
}

export interface CompactionBudgetOptions {
    /** Tokens outside conversation history: system/context messages and tool schemas. */
    reservedTokens?: number;
    /** Force a compact pass even when the normal threshold has not been reached. */
    force?: boolean;
    /** Cancels the paid summarization request when the owning turn is aborted. */
    abortSignal?: AbortSignal;
    /** Shared throttle state for automatic compaction; ignored when force is set. */
    autoThrottle?: AutoCompactionThrottle;
    /**
     * Unified request-size estimate from the Context Maintenance Coordinator.
     * When present, replaces the local content-only estimate for the threshold
     * decision so all paid entries share one accounting convention.
     */
    precomputedRequestTokens?: number;
    /** Real-usage calibration hook (P0 design 3); invoked once per completed summarizer call. */
    onUsageSample?: (sample: { estimated: number; actual: number; providerId: string; model: string }) => void;
}

export function resolveCompactionContextLimit(
    providerId: string,
    model: string | undefined,
    configuredLimit: number | undefined,
): number {
    if (configuredLimit && configuredLimit > 0) return configuredLimit;
    const provider = getProvider(providerId);
    const resolvedModel = model || provider.defaultModel;
    const modelLimit = getModelContextTokens(resolvedModel, providerId);
    return modelLimit > 0 ? modelLimit : (provider.maxContextTokens || DEFAULT_CONTEXT_LIMIT);
}

export interface CompactionRatios {
    /** High watermark for automatic/paid compaction as a fraction of the window. */
    thresholdRatio: number;
    /** Low watermark the compacted tail must fit under. */
    targetRatio: number;
    /** Mid-loop/emergency maintenance threshold fraction. */
    midLoopRatio: number;
}

/**
 * Per-provider/model compaction watermarks. DeepSeek's large windows can run
 * closer to the boundary before paid compaction, which keeps summarizer calls
 * (billed) off the hot path. Every other provider/model keeps the exact
 * pre-model-aware defaults. `midLoopRatio` feeds both the periodic mid-loop
 * trigger default (via resolveMidLoopBlockRatio) and the emergency ladder.
 */
export function resolveCompactionRatios(providerId?: string, model?: string): CompactionRatios {
    if (isDeepSeekModelOrProvider(providerId, model)) {
        return { thresholdRatio: 0.85, targetRatio: 0.65, midLoopRatio: 0.80 };
    }
    return {
        thresholdRatio: COMPACTION_THRESHOLD_RATIO,
        targetRatio: COMPACTION_TARGET_RATIO,
        midLoopRatio: MID_LOOP_COMPACTION_RATIO,
    };
}

/**
 * Clamped default for the periodic mid-loop trigger. The user-configured
 * `compactionBlockRatio` still wins; this default makes the per-model
 * `midLoopRatio` watermark actually drive the periodic trigger instead of
 * being masked by a global floor.
 */
export function resolveMidLoopBlockRatio(providerId?: string, model?: string): number {
    return Math.max(0.55, Math.min(0.98, resolveCompactionRatios(providerId, model).midLoopRatio));
}

/** Structured semantic reads keep a larger preview before archiving. */
const STRUCTURED_READ_ARCHIVE_TOOLS: ReadonlySet<string> = new Set([
    'query_cwt_schema',
    'query_rules',
    'query_types',
    'query_override_modes',
    'search_rule_capabilities',
    'explore_pdx_project',
]);

/**
 * Character limit before a tool result is archived off-model. DeepSeek models
 * tolerate double the default payload because their window is far larger and
 * their prefix cache makes large in-context results cheaper on later turns.
 */
export function resolveToolResultArchiveLimit(toolName: string, providerId?: string, model?: string): number {
    const base = STRUCTURED_READ_ARCHIVE_TOOLS.has(toolName) ? 60_000 : 16_000;
    return isDeepSeekModelOrProvider(providerId, model) ? base * 2 : base;
}

function renderMessageForCompaction(message: ChatMessage): string {
    const role = message.role.toUpperCase();
    if (message.role === 'tool') {
        const summary = message.tool_calls
            ?.map(tc => `${tc.function.name}: ${JSON.stringify(tc.function.arguments).substring(0, 100)}`)
            .join(' | ');
        const content = contentToString(message.content);
        return `<${role}>: ${summary || content.substring(0, 500)}`;
    }
    if (message.role === 'assistant') {
        const content = contentToString(message.content);
        const summary = [
            content.includes('<write_file>') ? '[wrote file]' : '',
            content.includes('<run_command>') ? '[ran command]' : '',
            (content.includes('<web_search>') || content.includes('<search_web>')) ? '[searched web]' : '',
        ].filter(Boolean).join(' ');
        return `<${role}>: ${summary || content.substring(0, 500)}`;
    }
    const maxLen = message.role === 'user' ? 500 : 2000;
    return `<${role}>: ${contentToString(message.content).substring(0, maxLen)}`;
}

/** Keep the original goal and the newest evidence while bounding the compactor request itself. */
function buildBoundedMessageContext(messages: ChatMessage[], maxTokens: number): string {
    const rendered = messages.map(renderMessageForCompaction);
    const all = rendered.join('\n');
    if (estimateTokenCount(all) <= maxTokens) return all;

    const selected = new Set<number>();
    let usedTokens = 0;
    const add = (index: number): boolean => {
        if (index < 0 || index >= rendered.length || selected.has(index)) return true;
        const cost = estimateTokenCount(rendered[index]!) + 2;
        if (usedTokens + cost > maxTokens) return false;
        selected.add(index);
        usedTokens += cost;
        return true;
    };

    for (let i = 0; i < Math.min(4, rendered.length); i++) add(i);
    for (let i = rendered.length - 1; i >= 4; i--) {
        if (!add(i)) break;
    }

    const indices = [...selected].sort((a, b) => a - b);
    const output: string[] = [];
    let previous = -1;
    for (const index of indices) {
        if (previous >= 0 && index > previous + 1) {
            output.push(`<OMITTED>: ${index - previous - 1} older messages excluded from the compactor input budget`);
        }
        output.push(rendered[index]!);
        previous = index;
    }
    return output.join('\n');
}

function buildSafeFallbackTail(history: ChatMessage[], count: number): ChatMessage[] {
    const canonical = normalizeTranscriptForPersistence(history);
    if (canonical.length <= count) return canonical;
    const split = splitTranscriptForCompaction(canonical, count);
    return normalizeTranscriptForPersistence([
        ...split.persistentSystemMessages,
        ...split.recentMessages,
    ]);
}

/** Estimate total token usage using CJK-aware estimation. */
function estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => {
        if (typeof m.content === 'string') return sum + estimateTokenCount(m.content);
        if (Array.isArray(m.content)) {
            return sum + (m.content as import('../types').ContentPart[]).reduce((s, part) => {
                if (part.type === 'text') return s + estimateTokenCount(part.text);
                if (part.type === 'image_url') {
                    const urlLen = part.image_url.url.length;
                    return s + Math.ceil(urlLen / 3 / CHARS_PER_TOKEN);
                }
                return s;
            }, 0);
        }
        return sum;
    }, 0);
}

const compactionSummaryCache = new Map<string, ChatMessage[]>();

/** Clear the summary-reuse cache (used by tests; production code never needs to). */
export function clearCompactionSummaryCache(): void {
    compactionSummaryCache.clear();
}

/** Fingerprint the canonical transcript so an unchanged history reuses its summary. */
function fingerprintTranscript(messages: ChatMessage[]): string {
    const hash = crypto.createHash('sha256');
    for (const message of messages) {
        hash.update(JSON.stringify(message));
        hash.update('\u0000');
    }
    return hash.digest('hex');
}

export async function maybeCompactHistory(
    history: ChatMessage[],
    emitStep: (step: AgentStep) => void,
    deps: CompactionDependencies,
    options?: AgentRunnerOptions,
    tokenAccumulator?: TokenUsage,
    thresholdRatio: number = COMPACTION_THRESHOLD_RATIO,
    budgetOptions: CompactionBudgetOptions = {},
): Promise<ChatMessage[]> {
    await runtimeFaultInjector.hit('during_compaction', budgetOptions?.abortSignal);
    const canonicalHistory = normalizeTranscriptForPersistence(history);
    const estimatedTokens = estimateMessagesTokens(canonicalHistory);
    if (
        estimatedTokens === 0
        || (
            !budgetOptions.force
            && budgetOptions.precomputedRequestTokens === undefined
            && estimatedTokens < MIN_HISTORY_TOKENS_FOR_AUTO_COMPACTION
        )
    ) {
        return canonicalHistory;
    }

    const config = deps.aiService.getConfig();
    const providerId = options?.providerId ?? config.provider ?? 'openai';
    const model = options?.model ?? config.model;
    const configuredLimit = options?.maxContextTokens ?? config.maxContextTokens;
    const modelLimit = resolveCompactionContextLimit(providerId, model, configuredLimit);
    const compactionThreshold = Math.floor(modelLimit * thresholdRatio);
    const estimatedRequestTokens = budgetOptions.precomputedRequestTokens
        ?? (estimatedTokens + Math.max(0, budgetOptions.reservedTokens ?? 0));

    if (!budgetOptions.force && estimatedRequestTokens <= compactionThreshold) {
        return canonicalHistory;
    }

    // Minimum-interval guard for automatic compaction. Forced callers
    // (mid-loop, emergency, manual) are never throttled, and near-full
    // contexts bypass the guard so context safety is preserved.
    const throttle = budgetOptions.autoThrottle;
    if (
        !budgetOptions.force
        && throttle
        && throttle.lastAutoCompactionAt > 0
        && Date.now() - throttle.lastAutoCompactionAt < throttle.minIntervalMs
        && estimatedRequestTokens <= Math.floor(modelLimit * AUTO_COMPACTION_THROTTLE_BYPASS_RATIO)
    ) {
        return canonicalHistory;
    }

    // Reuse the previous compaction when the transcript has not changed since:
    // re-summarizing identical history buys nothing but costs a full LLM call.
    const cacheKey = `${providerId}:${model ?? ''}:${modelLimit}:${Math.max(0, budgetOptions.reservedTokens ?? 0)}:${fingerprintTranscript(canonicalHistory)}`;
    const cached = compactionSummaryCache.get(cacheKey);
    if (cached) {
        emitStep({
            type: 'compaction',
            content: AGENT.COMPACTION_REUSED(cached.length),
            timestamp: Date.now(),
            compactionInfo: {
                state: 'complete',
                kind: 'history',
                beforeTokens: estimatedRequestTokens,
                thresholdTokens: compactionThreshold,
            },
        });
        return cached.map(cloneChatMessage);
    }

    emitStep({
        type: 'compaction',
        content: AGENT.COMPACTION_START(estimatedRequestTokens, compactionThreshold),
        timestamp: Date.now(),
        compactionInfo: {
            state: 'start',
            kind: 'history',
            beforeTokens: estimatedRequestTokens,
            thresholdTokens: compactionThreshold,
        },
    });

    try {
        // Low-watermark target: shrink the retained tail until the projected
        // post-compaction request fits under the per-model target ratio, so the
        // high watermark is not re-armed immediately after compacting.
        const targetRequestTokens = Math.floor(modelLimit * resolveCompactionRatios(providerId, model).targetRatio);
        const projectRequestTokens = (candidate: CompactionTranscriptSplit): number =>
            Math.max(0, budgetOptions.reservedTokens ?? 0)
            + estimateMessagesTokens(candidate.persistentSystemMessages)
            + estimateMessagesTokens(candidate.recentMessages)
            + COMPACTION_SUMMARY_RESERVE_TOKENS;
        let keepN = Math.min(COMPACTION_KEEP_LAST_N, Math.max(1, canonicalHistory.length - 1));
        let split = splitTranscriptForCompaction(canonicalHistory, keepN);
        while (keepN > 1 && projectRequestTokens(split) > targetRequestTokens) {
            keepN -= 1;
            split = splitTranscriptForCompaction(canonicalHistory, keepN);
        }
        const persistentSystemMessages = split.persistentSystemMessages;
        let olderMessages = split.olderMessages;
        const recentMessages = split.recentMessages;

        let existingSummaryText = '';
        if (olderMessages[0]?.role === 'system' && String(olderMessages[0].content).includes('Conversation Summary (compacted)')) {
            existingSummaryText = String(olderMessages[0].content).replace(/^## Conversation Summary \(compacted\)\n/, '');
            olderMessages.shift();
        } else {
            // Extract the newest active summary, then replace it after compaction.
            // Keeping every cumulative summary causes quadratic context growth.
            let i = 0;
            const toRemoveIndices = new Set<number>();
            while (i < olderMessages.length) {
                const m = olderMessages[i];
                if (m && m.role === 'user' && String(m.content).includes('[Context Recovery]')) {
                    const nextM = olderMessages[i + 1];
                    if (nextM && nextM.role === 'assistant' && String(nextM.content).includes('## Conversation Summary (compacted)')) {
                        existingSummaryText = String(nextM.content).replace(/^## Conversation Summary \(compacted\)\n/, '');
                        toRemoveIndices.add(i);
                        toRemoveIndices.add(i + 1);
                        i += 2;
                        continue;
                    }
                }
                i++;
            }
            olderMessages = olderMessages.filter((_, idx) => !toRemoveIndices.has(idx));
        }

        const pinnedContext: string[] = [];
        for (const m of olderMessages) {
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('<write_file>')) {
                pinnedContext.push(`[Pinned Write] ${m.content.substring(0, 500)}...`);
            }
        }
        const pinnedSection = pinnedContext.length > 0 ? `\n## Pinned Files\n${pinnedContext.join('\n')}` : '';

        const compactorInputBudget = Math.max(4_096, Math.floor(modelLimit * 0.60));
        const messageContext = buildBoundedMessageContext(olderMessages, compactorInputBudget);

        const compactionSystemPrompt = existingSummaryText
            ? [
                `Update the anchored summary below using the conversation history above.`,
                `Preserve still-true details, remove stale details, and merge in the new facts.`,
                `<previous-summary>`,
                existingSummaryText,
                `</previous-summary>`,
              ].join('\n')
            : `Create a new anchored summary from the conversation history above.`;

        let activeMessageContext = messageContext;
        let compactionMessages: ChatMessage[] = [];
        let compactionResponse: Awaited<ReturnType<AIService['chatCompletion']>> | undefined;
        let summary = '';
        let lastCompactionError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const compactionInstruction = [
                compactionSystemPrompt,
                COMPACTION_SUMMARY_TEMPLATE,
                pinnedSection,
                activeMessageContext,
            ].filter(Boolean).join('\n\n');
            compactionMessages = [
                { role: 'system', content: deps.promptBuilder.buildCompactionPrompt() },
                { role: 'user', content: compactionInstruction },
            ];
            budgetOptions.abortSignal?.throwIfAborted();
            if (tokenAccumulator) {
                tokenAccumulator.apiCalls = (tokenAccumulator.apiCalls ?? 0) + 1;
                tokenAccumulator.compactionCalls = (tokenAccumulator.compactionCalls ?? 0) + 1;
            }
            try {
                const candidate = await deps.aiService.chatCompletion(compactionMessages, {
                    temperature: 0.1,
                    maxTokens: 2048,
                    providerId,
                    model,
                    abortSignal: budgetOptions.abortSignal,
                });
                const candidateSummary = contentToString(candidate.choices?.[0]?.message?.content).trim();
                const outputIncomplete = candidate.choices?.[0]?.finish_reason === 'length' || candidateSummary.length === 0;
                if (!outputIncomplete) {
                    compactionResponse = candidate;
                    summary = candidateSummary;
                    break;
                }
                lastCompactionError = new Error(candidateSummary.length === 0
                    ? 'Compaction returned an empty summary.'
                    : 'Compaction summary reached the model output limit before completion.');
            } catch (error) {
                lastCompactionError = error;
                const text = error instanceof Error ? error.message : String(error);
                const retryable = /429|rate.?limit|timeout|timed out|network|ECONN|5\d\d|context|too many tokens/i.test(text);
                if (!retryable || attempt >= 3) throw error;
            }
            if (attempt < 3) {
                const nextLength = Math.max(2_000, Math.floor(activeMessageContext.length * 0.65));
                activeMessageContext = activeMessageContext.slice(-nextLength);
                emitStep({
                    type: 'compaction',
                    content: `Compaction retry ${attempt + 1}/3 with a smaller input window.`,
                    timestamp: Date.now(),
                    compactionInfo: { state: 'start', kind: 'history' },
                });
                await new Promise<void>((resolve, reject) => {
                    const signal = budgetOptions.abortSignal;
                    const onAbort = () => {
                        clearTimeout(timer);
                        reject(signal?.reason ?? new Error('Compaction cancelled.'));
                    };
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    }, 250 * (2 ** (attempt - 1)));
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
            }
        }
        if (!compactionResponse) throw lastCompactionError ?? new Error('Compaction failed without a response.');
        // Real-usage calibration sample: only a provider-returned prompt_tokens
        // counts; the estimate side covers exactly the sent compactionMessages.
        if (compactionResponse.usage?.prompt_tokens !== undefined && compactionResponse.usage.prompt_tokens > 0) {
            const responseProviderId = (compactionResponse as { __providerId?: unknown }).__providerId;
            budgetOptions.onUsageSample?.({
                estimated: estimateChatMessagesTokens(compactionMessages),
                actual: compactionResponse.usage.prompt_tokens,
                // Response-side identity: a fallback never pollutes the primary key.
                providerId: typeof responseProviderId === 'string' ? responseProviderId : providerId,
                model: compactionResponse.model ?? model ?? 'unknown',
            });
        }
        if (tokenAccumulator) {
            const responseModel = compactionResponse.model ?? model ?? 'unknown';
            const promptTokens = compactionResponse.usage?.prompt_tokens ?? estimateMessagesTokens(compactionMessages);
            const completionTokens = compactionResponse.usage?.completion_tokens ?? estimateTokenCount(summary);
            const totalTokens = compactionResponse.usage?.total_tokens ?? promptTokens + completionTokens;
            const usage = compactionResponse.usage as (typeof compactionResponse.usage & {
                prompt_tokens_details?: { cached_tokens?: number };
                prompt_cache_hit_tokens?: number;
                cache_read_input_tokens?: number;
                cached_content_token_count?: number;
            }) | undefined;
            const cachedTokens = usage?.cached_tokens
                ?? usage?.prompt_tokens_details?.cached_tokens
                ?? usage?.prompt_cache_hit_tokens
                ?? usage?.cache_read_input_tokens
                ?? usage?.cached_content_token_count
                ?? 0;
            const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
            const pricing = getCurrentModelPricing(responseModel, providerId);
            const cacheDiscount = getCacheDiscountFactor(responseModel, providerId);
            tokenAccumulator.input += promptTokens;
            tokenAccumulator.output += completionTokens;
            tokenAccumulator.total += totalTokens;
            tokenAccumulator.estimatedCostCny +=
                (uncachedInputTokens / 1_000_000) * pricing[0] +
                (cachedTokens / 1_000_000) * pricing[0] * cacheDiscount +
                (completionTokens / 1_000_000) * pricing[1];
            tokenAccumulator.cachedTokens = (tokenAccumulator.cachedTokens ?? 0) + cachedTokens;
            tokenAccumulator.netInput = (tokenAccumulator.netInput ?? 0) + uncachedInputTokens;
            tokenAccumulator.netTotal = (tokenAccumulator.netTotal ?? 0) + uncachedInputTokens + completionTokens;
            tokenAccumulator.cacheSavedCostCny = (tokenAccumulator.cacheSavedCostCny ?? 0)
                + (cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
            const customFormat = deps.aiService.getConfig().provider === providerId
                ? deps.aiService.getConfig().customApiFormat
                : undefined;
            const cacheCapable = isCacheCapableUsage(providerId, cachedTokens, customFormat);
            appendCacheRequestUsage(tokenAccumulator, {
                provider: providerId,
                model: responseModel,
                inputTokens: promptTokens,
                cachedTokens,
                cacheCapable,
                agentMode: tokenAccumulator.agentMode,
                toolStage: tokenAccumulator.toolStage,
                promptFingerprint: fingerprintTranscript(compactionMessages).slice(0, 24),
                purpose: 'compaction',
                invalidationReason: cacheCapable && cachedTokens === 0 ? 'provider_miss' : undefined,
            });
        }

        const summaryRepetition = new OutputRepetitionDetector().append(summary);
        if (summaryRepetition) {
            throw new Error(`Compaction summary entered a repeated-output cycle (${summaryRepetition.cycleChars} chars).`);
        }
        if (summary.length > 0) {
            const compactionType = existingSummaryText ? AGENT.COMPACTION_INCREMENTAL : AGENT.COMPACTION_INITIAL;
            emitStep({
                type: 'compaction',
                content: AGENT.COMPACTION_DONE(compactionType, olderMessages.length, summary.length, pinnedContext.length),
                timestamp: Date.now(),
                compactionInfo: {
                    state: 'complete',
                    kind: 'history',
                    beforeTokens: estimatedRequestTokens,
                    thresholdTokens: compactionThreshold,
                },
            });

            const compacted = normalizeTranscriptForPersistence([
                ...persistentSystemMessages,
                {
                    role: 'user',
                    content: '[Context Recovery] Use the compacted conversation summary below as the active history and continue.',
                },
                {
                    role: 'assistant',
                    content: `## Conversation Summary (compacted)\n${summary}${pinnedSection}`,
                },
                ...recentMessages,
            ]);
            // Cache a private copy: callers mutate the returned array in place.
            compactionSummaryCache.set(cacheKey, compacted.map(cloneChatMessage));
            if (compactionSummaryCache.size > COMPACTION_SUMMARY_CACHE_CAPACITY) {
                const oldestKey = compactionSummaryCache.keys().next().value;
                if (oldestKey !== undefined) compactionSummaryCache.delete(oldestKey);
            }
            if (!budgetOptions.force && throttle) {
                throttle.lastAutoCompactionAt = Date.now();
            }
            return compacted;
        }
    } catch (e) {
        emitStep({
            type: 'compaction',
            content: AGENT.COMPACTION_FAILED(e instanceof Error ? e.message : String(e)),
            timestamp: Date.now(),
            compactionInfo: { state: 'failed', kind: 'history' },
        });
        emitStep({
            type: 'error',
            content: AGENT.COMPACTION_FAILED(e instanceof Error ? e.message : String(e)),
            timestamp: Date.now(),
        });
    }

    return buildSafeFallbackTail(canonicalHistory, 6);
}
