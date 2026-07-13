import type { ChatMessage, AgentStep, TokenUsage } from '../types';
import type { AgentRunnerOptions } from '../agentRunner';
import { contentToString } from '../types';
import { getModelContextTokens, getProvider } from '../providers';
import { getModelPricing } from '../pricing';
import { AGENT } from '../messages';
import type { AIService } from '../aiService';
import type { PromptBuilder } from '../promptBuilder';
import { OutputRepetitionDetector } from './outputRepetitionDetector';
import { estimateTokenCount, CHARS_PER_TOKEN } from '../agentRunner';
import { normalizeTranscriptForPersistence, splitTranscriptForCompaction } from './contextTranscript';

// Leave room for the system prompt, tool schemas, the current turn, and output.
// Both Codex and Claude Code compact before the model's hard context boundary.
export const COMPACTION_THRESHOLD_RATIO = 0.80;
// Default context limit if unknown
export const DEFAULT_CONTEXT_LIMIT = 128000;
// How many recent messages to keep un-compressed during compaction
export const COMPACTION_KEEP_LAST_N = 8;
// Mid-loop compaction: check every N iterations within reasoningLoop
export const MID_LOOP_COMPACTION_INTERVAL = 3;
// Mid-loop compaction triggers at this fraction of context limit
export const MID_LOOP_COMPACTION_RATIO = 0.78;
const MIN_HISTORY_TOKENS_FOR_AUTO_COMPACTION = 2_048;

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

export interface CompactionBudgetOptions {
    /** Tokens outside conversation history: system/context messages and tool schemas. */
    reservedTokens?: number;
    /** Force a compact pass even when the normal threshold has not been reached. */
    force?: boolean;
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

export async function maybeCompactHistory(
    history: ChatMessage[],
    emitStep: (step: AgentStep) => void,
    deps: CompactionDependencies,
    options?: AgentRunnerOptions,
    tokenAccumulator?: TokenUsage,
    thresholdRatio: number = COMPACTION_THRESHOLD_RATIO,
    budgetOptions: CompactionBudgetOptions = {},
): Promise<ChatMessage[]> {
    const canonicalHistory = normalizeTranscriptForPersistence(history);
    // Estimate total token usage using CJK-aware estimation.
    const estimatedTokens = canonicalHistory.reduce((sum, m) => {
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
    if (estimatedTokens === 0 || (!budgetOptions.force && estimatedTokens < MIN_HISTORY_TOKENS_FOR_AUTO_COMPACTION)) {
        return canonicalHistory;
    }

    const config = deps.aiService.getConfig();
    const providerId = options?.providerId ?? config.provider ?? 'openai';
    const model = options?.model ?? config.model;
    const configuredLimit = options?.maxContextTokens ?? config.maxContextTokens;
    const modelLimit = resolveCompactionContextLimit(providerId, model, configuredLimit);
    const compactionThreshold = Math.floor(modelLimit * thresholdRatio);
    const estimatedRequestTokens = estimatedTokens + Math.max(0, budgetOptions.reservedTokens ?? 0);

    if (!budgetOptions.force && estimatedRequestTokens <= compactionThreshold) {
        return canonicalHistory;
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
        const keepN = Math.min(COMPACTION_KEEP_LAST_N, Math.max(1, canonicalHistory.length - 1));
        const split = splitTranscriptForCompaction(canonicalHistory, keepN);
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

        const compactionInstruction = [
            compactionSystemPrompt,
            COMPACTION_SUMMARY_TEMPLATE,
            pinnedSection,
            messageContext,
        ].filter(Boolean).join('\n\n');

        const compactionMessages: ChatMessage[] = [
            { role: 'system', content: deps.promptBuilder.buildCompactionPrompt() },
            { role: 'user', content: compactionInstruction },
        ];

        const compactionResponse = await deps.aiService.chatCompletion(compactionMessages, {
            temperature: 0.1,
            maxTokens: 2048,
            providerId,
            model,
        });

        if (tokenAccumulator && compactionResponse.usage) {
            const pricing = getModelPricing(compactionResponse.model ?? model ?? '', providerId);
            tokenAccumulator.input += compactionResponse.usage.prompt_tokens;
            tokenAccumulator.output += compactionResponse.usage.completion_tokens;
            tokenAccumulator.total += compactionResponse.usage.total_tokens;
            tokenAccumulator.estimatedCostCny +=
                (compactionResponse.usage.prompt_tokens / 1_000_000) * pricing[0] +
                (compactionResponse.usage.completion_tokens / 1_000_000) * pricing[1];
        }

        const summary = contentToString(compactionResponse.choices?.[0]?.message?.content);
        const summaryRepetition = new OutputRepetitionDetector().append(summary);
        if (summaryRepetition) {
            throw new Error(`Compaction summary entered a repeated-output cycle (${summaryRepetition.cycleChars} chars).`);
        }
        if (compactionResponse.choices?.[0]?.finish_reason === 'length') {
            throw new Error('Compaction summary reached the model output limit before completion.');
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

            return normalizeTranscriptForPersistence([
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
