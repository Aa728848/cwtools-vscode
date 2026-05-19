import type { ChatMessage, AgentStep, TokenUsage } from '../types';
import type { AgentRunnerOptions } from '../agentRunner';
import { contentToString } from '../types';
import { getProvider } from '../providers';
import { getModelPricing } from '../pricing';
import { AGENT } from '../messages';
import type { AIService } from '../aiService';
import type { PromptBuilder } from '../promptBuilder';
import { estimateTokenCount, CHARS_PER_TOKEN } from '../agentRunner';

// Compact when conversation exceeds this fraction of provider context
export const COMPACTION_THRESHOLD_RATIO = 0.95;
// Default context limit if unknown
export const DEFAULT_CONTEXT_LIMIT = 128000;
// How many recent messages to keep un-compressed during compaction
export const COMPACTION_KEEP_LAST_N = 8;
// Mid-loop compaction: check every N iterations within reasoningLoop
export const MID_LOOP_COMPACTION_INTERVAL = 3;
// Mid-loop compaction triggers at this fraction of context limit
export const MID_LOOP_COMPACTION_RATIO = 0.78;

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

export async function maybeCompactHistory(
    history: ChatMessage[],
    emitStep: (step: AgentStep) => void,
    deps: CompactionDependencies,
    options?: AgentRunnerOptions,
    tokenAccumulator?: TokenUsage,
    thresholdRatio: number = COMPACTION_THRESHOLD_RATIO
): Promise<ChatMessage[]> {
    // Estimate total token usage using CJK-aware estimation.
    const estimatedTokens = history.reduce((sum, m) => {
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

    const providerDef = getProvider(options?.providerId ?? 'openai');
    const modelLimit = (providerDef.models as any[]).find(m => (m.id || m) === options?.model)?.contextWindow ?? DEFAULT_CONTEXT_LIMIT;
    const compactionThreshold = Math.floor(modelLimit * thresholdRatio);

    if (estimatedTokens <= compactionThreshold) {
        return history;
    }

    emitStep({
        type: 'compaction',
        content: AGENT.COMPACTION_START(estimatedTokens, compactionThreshold),
        timestamp: Date.now(),
    });

    try {
        const keepN = Math.min(COMPACTION_KEEP_LAST_N, Math.max(1, history.length - 1));
        const splitIndex = history.length - keepN;
        const olderMessages = history.slice(0, splitIndex);
        const recentMessages = history.slice(splitIndex);

        let existingSummaryText = '';
        if (olderMessages[0]?.role === 'system' && String(olderMessages[0].content).includes('Conversation Summary (compacted)')) {
            existingSummaryText = String(olderMessages[0].content).replace(/^## Conversation Summary \(compacted\)\n/, '');
            olderMessages.shift();
        }

        const pinnedContext: string[] = [];
        for (const m of olderMessages) {
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('<write_file>')) {
                pinnedContext.push(`[Pinned Write] ${m.content.substring(0, 500)}...`);
            }
        }
        const pinnedSection = pinnedContext.length > 0 ? `\n## Pinned Files\n${pinnedContext.join('\n')}` : '';

        const messageContext = olderMessages.map(m => {
            const role = m.role.toUpperCase();
            if (m.role === 'tool') {
                const summary = m.tool_calls?.map(tc => `${tc.function.name}: ${JSON.stringify(tc.function.arguments).substring(0, 100)}`).join(' | ');
                const content = contentToString(m.content);
                return `<${role}>: ${summary || content.substring(0, 500)}`;
            }
            if (m.role === 'assistant') {
                const content = contentToString(m.content);
                const summary = [
                    content.includes('<write_file>') ? '[wrote file]' : '',
                    content.includes('<run_command>') ? '[ran command]' : '',
                    content.includes('<search_web>') ? '[searched web]' : '',
                ].filter(Boolean).join(' ');
                return `<${role}>: ${summary || content.substring(0, 500)}`;
            }
            const maxLen = m.role === 'user' ? 500 : 2000;
            const content = contentToString(m.content).substring(0, maxLen);
            return `<${role}>: ${content}`;
        }).join('\n');

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
            providerId: options?.providerId,
            model: options?.model,
        });

        if (tokenAccumulator && compactionResponse.usage) {
            const pricing = getModelPricing(compactionResponse.model ?? options?.model ?? '');
            tokenAccumulator.input += compactionResponse.usage.prompt_tokens;
            tokenAccumulator.output += compactionResponse.usage.completion_tokens;
            tokenAccumulator.total += compactionResponse.usage.total_tokens;
            tokenAccumulator.estimatedCostCny +=
                (compactionResponse.usage.prompt_tokens / 1_000_000) * pricing[0] +
                (compactionResponse.usage.completion_tokens / 1_000_000) * pricing[1];
        }

        const summary = compactionResponse.choices?.[0]?.message?.content ?? '';

        if (summary.length > 0) {
            const compactionType = existingSummaryText ? AGENT.COMPACTION_INCREMENTAL : AGENT.COMPACTION_INITIAL;
            emitStep({
                type: 'compaction',
                content: AGENT.COMPACTION_DONE(compactionType, olderMessages.length, summary.length, pinnedContext.length),
                timestamp: Date.now(),
            });

            const supportsPrefixCache = (options?.providerId ?? '').startsWith('deepseek') || (options?.providerId ?? '').startsWith('openai');

            if (supportsPrefixCache) {
                // ── DeepSeek prefix-cache optimization path ──
                // Rules:
                //   1. system message stays unchanged (frozen prefix)
                //   2. summary injected as user+assistant pair (append-only)
                //   3. recent messages preserved with byte-stable order
                const systemMsg = history[0]?.role === 'system' ? history[0] : undefined;
                return [
                    ...(systemMsg ? [systemMsg] : []),
                    { role: 'user', content: '[Context Recovery] Please review the conversation summary below and continue.' },
                    { role: 'assistant', content: `## Conversation Summary (compacted)\n${summary}${pinnedSection}` },
                    ...recentMessages,
                ];
            }

            // ── Default path (other providers) ──
            return [
                {
                    role: 'system',
                    content: `## Conversation Summary (compacted)\n${summary}${pinnedSection}`,
                },
                ...recentMessages,
            ];
        }
    } catch (e) {
        emitStep({
            type: 'error',
            content: AGENT.COMPACTION_FAILED(e instanceof Error ? e.message : String(e)),
            timestamp: Date.now(),
        });
    }

    const fallbackCount = Math.min(6, history.length);
    return history.slice(history.length - fallbackCount);
}
