/**
 * CWTools AI Module — Context Budget Utilities
 *
 * Extracted from agentRunner.ts to reduce god-object complexity.
 * Handles intelligent budgeting of tool results to fit within context windows,
 * and in-place compaction of conversation histories.
 */

import type { ChatMessage, ContentPart } from './types';
import { contentToString } from './types';
import { BUDGET } from './messages';

// P1-7: contentToString moved to types.ts — single shared definition

/** Default budget per tool result (characters). */
export const TOOL_RESULT_BUDGET_BASE = 15000;

/**
 * Intelligently budget a tool result to fit within maxChars.
 * Uses strategies that preserve information density:
 *
 * 1. **Read-file optimization**: Truncate at line boundaries
 * 2. **Array dedup**: Group by key field, deduplicate, report counts
 * 3. **Segmentation**: Keep representative items from start/middle/end
 * 4. **Structured truncation**: Truncate strings while preserving structure
 */
export function budgetToolResult(result: unknown, maxChars: number = TOOL_RESULT_BUDGET_BASE): string {
    if (result === undefined) return 'undefined';
    if (result === null) return 'null';
    if (typeof result === 'string') {
        if (result.length <= maxChars) return result;
        return result.substring(0, maxChars) + `\n\n${BUDGET.TRUNCATED(result.length)}`;
    }

    const raw = JSON.stringify(result, null, 2) || '';
    if (raw.length <= maxChars) return raw;

    // Optimization: Smart line-boundary truncation for read_file text content.
    if (typeof result === 'object' && result !== null && 'content' in result && 'totalLines' in result) {
        const readResult = result as { content: string; totalLines: number; truncated?: boolean; _hint?: string };
        const lines = readResult.content.split('\n');
        const contentBudget = maxChars - 200;
        let charCount = 0;
        let kept = 0;
        for (const line of lines) {
            if (charCount + line.length + 1 > contentBudget) break;
            charCount += line.length + 1;
            kept++;
        }
        if (kept < lines.length) {
            return JSON.stringify({
                content: lines.slice(0, kept).join('\n'),
                totalLines: readResult.totalLines,
                truncated: true,
                _linesShown: kept,
                _hint: BUDGET.TRUNCATED_LINES(kept),
            }, null, 2);
        }
    }

    // Strategy 1: Detect and handle diagnostic-like arrays
    const arrayTarget = extractBudgetableArray(result);
    if (arrayTarget) {
        const { array, wrapper, key: arrayKey } = arrayTarget;
        const budgeted = budgetArray(array, maxChars, wrapper, arrayKey);
        if (budgeted) return budgeted;
    }

    // Strategy 2: If result is a direct array
    if (Array.isArray(result)) {
        const budgeted = budgetArray(result, maxChars, null, null);
        if (budgeted) return budgeted;
    }

    // Strategy 3: Generic truncation with structure hint
    return raw.substring(0, maxChars) +
        `\n\n${BUDGET.TRUNCATED_GENERIC(raw.length)}`;
}

/**
 * Extract a budgetable array from a tool result object.
 * Detects common patterns like { diagnostics: [...] }, { instances: [...] },
 * { results: [...] }, { files: [...] }, { references: [...] }.
 */
function extractBudgetableArray(
    result: unknown
): { array: unknown[]; wrapper: Record<string, unknown>; key: string } | null {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
    const obj = result as Record<string, unknown>;
    const candidateKeys = ['diagnostics', 'instances', 'results', 'files', 'references', 'entries', 'items', 'rules', 'matches', 'suggestions', 'findings', 'errors', 'warnings'];
    for (const k of candidateKeys) {
        if (Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 5) {
            return { array: obj[k] as unknown[], wrapper: obj, key: k };
        }
    }
    return null;
}

/**
 * Budget an array using dedup + segmentation.
 * Returns a JSON string, or null if the array is too small to be worth budgeting.
 */
function budgetArray(
    array: unknown[],
    maxChars: number,
    wrapper: Record<string, unknown> | null,
    arrayKey: string | null
): string | null {
    if (array.length <= 3) return null;

    // Step 1: Attempt deduplication by message/error field
    const groupKey = findGroupKey(array);
    if (groupKey && array.length > 10) {
        const grouped = new Map<string, { count: number; representative: unknown; files: Set<string> }>();
        for (const item of array) {
            const obj = item as Record<string, unknown>;
            const key = String(obj[groupKey] ?? '');
            const existing = grouped.get(key);
            if (existing) {
                existing.count++;
                const file = obj['file'] ?? obj['logicalPath'] ?? obj['filePath'];
                if (file) existing.files.add(String(file));
            } else {
                const file = obj['file'] ?? obj['logicalPath'] ?? obj['filePath'];
                grouped.set(key, {
                    count: 1,
                    representative: item,
                    files: file ? new Set([String(file)]) : new Set(),
                });
            }
        }

        if (grouped.size < array.length * 0.7) {
            const dedupedItems = [...grouped.entries()]
                .sort((a, b) => b[1].count - a[1].count)
                .map(([, v]) => ({
                    ...v.representative as Record<string, unknown>,
                    _occurrences: v.count,
                    _affectedFiles: v.files.size > 1 ? v.files.size : undefined,
                    _sampleFiles: v.files.size > 1 ? [...v.files].slice(0, 3) : undefined,
                }));

            let kept = Math.min(dedupedItems.length, 30);
            let resultObj = buildArrayResult(dedupedItems, kept, array.length, wrapper, arrayKey);
            while (resultObj.length > maxChars && kept > 5) {
                kept = Math.floor(kept * 0.6);
                resultObj = buildArrayResult(dedupedItems, kept, array.length, wrapper, arrayKey);
            }
            return resultObj;
        }
    }

    // Step 2: Segmentation — keep items from start, middle, end
    const totalCount = array.length;
    const segmentSize = Math.max(3, Math.floor(maxChars / 800));
    const headCount = Math.ceil(segmentSize * 0.5);
    const tailCount = Math.floor(segmentSize * 0.3);
    const midCount = Math.max(1, segmentSize - headCount - tailCount);

    const head = array.slice(0, headCount);
    const midStart = Math.floor(totalCount / 2) - Math.floor(midCount / 2);
    const mid = array.slice(midStart, midStart + midCount);
    const tail = array.slice(totalCount - tailCount);

    const segmented = [
        ...head,
        { _gap: BUDGET.GAP(totalCount - headCount - midCount - tailCount) },
        ...mid,
        { _gap: BUDGET.GAP_TAIL },
        ...tail,
    ];

    const result = buildArrayResult(segmented, segmented.length, totalCount, wrapper, arrayKey);
    if (result.length <= maxChars) return result;

    // Last resort: just head items with count
    let kept = headCount;
    let fallback = buildArrayResult(array.slice(0, kept), kept, totalCount, wrapper, arrayKey);
    while (fallback.length > maxChars && kept > 3) {
        kept = Math.floor(kept * 0.6);
        fallback = buildArrayResult(array.slice(0, kept), kept, totalCount, wrapper, arrayKey);
    }
    return fallback;
}

/** Find a suitable grouping key for deduplication of array items. */
function findGroupKey(array: unknown[]): string | null {
    if (array.length === 0) return null;
    const first = array[0];
    if (typeof first !== 'object' || first === null) return null;
    const obj = first as Record<string, unknown>;
    for (const candidate of ['message', 'error', 'id', 'name']) {
        if (typeof obj[candidate] === 'string') return candidate;
    }
    return null;
}

/** Build a budgeted array result JSON string with metadata. */
function buildArrayResult(
    items: unknown[],
    keptCount: number,
    totalCount: number,
    wrapper: Record<string, unknown> | null,
    arrayKey: string | null
): string {
    if (wrapper && arrayKey) {
        const budgetedWrapper = { ...wrapper };
        budgetedWrapper[arrayKey] = items.slice(0, keptCount);
        budgetedWrapper[`_${arrayKey}Shown`] = Math.min(keptCount, items.length);
        budgetedWrapper[`_${arrayKey}Total`] = totalCount;
        if (keptCount < totalCount) {
            budgetedWrapper[`_${arrayKey}Note`] = BUDGET.ARRAY_BUDGET_NOTE(totalCount, Math.min(keptCount, items.length));
        }
        return JSON.stringify(budgetedWrapper, null, 2);
    }
    const shown = items.slice(0, keptCount);
    if (keptCount >= totalCount) return JSON.stringify(shown, null, 2);
    return JSON.stringify({
        items: shown,
        _shown: Math.min(keptCount, items.length),
        _total: totalCount,
        _note: BUDGET.ARRAY_GENERIC_NOTE(totalCount, Math.min(keptCount, items.length)),
    }, null, 2);
}

/**
 * Compact messages array in-place during the reasoning loop.
 * Targets oversized tool result messages for lightweight, synchronous compression.
 *
 * Strategy:
 * 1. Keep the first message (system prompt) and last 6 messages intact.
 * 2. For messages in between, if they are tool results larger than
 *    toolResultBudget, replace their content with a truncated version.
 * 3. For very old tool results (beyond the last 12 messages),
 *    aggressively compress to just file/success/error metadata.
 */
export function compactMessagesInPlace(messages: ChatMessage[], toolResultBudget: number): void {
    if (messages.length <= 8) return;

    const keepHead = 1;
    const keepTail = 6;
    const aggressiveThreshold = messages.length - 12;

    for (let i = keepHead; i < messages.length - keepTail; i++) {
        const m = messages[i]!;
        const content = contentToString(m.content);
        if (content.length <= 500) continue;

        if (m.role === 'tool' || (m.role === 'user' && content.startsWith('[Tool Result'))) {
            if (i < aggressiveThreshold) {
                // Handle read_file metadata gracefully
                const contentMatch = content.match(/"content"\s*:/);
                const totalLinesMatch = content.match(/"totalLines"\s*:\s*(\d+)/);
                if (contentMatch && totalLinesMatch) {
                    messages[i] = { ...m, content: BUDGET.COMPACTED_READ_FILE(totalLinesMatch[1]!) };  
                    continue;
                }

                // Aggressive: extract only key metadata
                const successMatch = content.match(/"success"\s*:\s*(true|false)/);
                const fileMatch = content.match(/"(?:file|filePath|logicalPath)"\s*:\s*"([^"]+)"/);
                const errorMatch = content.match(/"(?:error|message)"\s*:\s*"([^"]{0,150})"/);
                const countMatch = content.match(/"(?:total\w*Count|totalCount|length)"\s*:\s*(\d+)/);
                const meta = [
                    fileMatch ? `file=${fileMatch[1]}` : null,
                    successMatch ? `ok=${successMatch[1]}` : null,
                    errorMatch && successMatch?.[1] === 'false' ? `err=${errorMatch[1]!.substring(0, 80)}` : null,  
                    countMatch ? `count=${countMatch[1]}` : null,
                ].filter(Boolean).join(', ');
                messages[i] = { ...m, content: `[${BUDGET.COMPACTED_PREFIX}] ${meta || content.substring(0, 200)}` };
            } else if (content.length > toolResultBudget) {
                // Moderate: apply budgeting
                try {
                    const parsed = JSON.parse(content);
                    messages[i] = { ...m, content: budgetToolResult(parsed, toolResultBudget) };
                } catch {
                    messages[i] = { ...m, content: content.substring(0, toolResultBudget) + `\n${BUDGET.BUDGET_EXCEEDED}` };
                }
            }
        } else if (m.role === 'assistant' && i < aggressiveThreshold) {
            // Aggressively compress old assistant reasoning
            const newM: ChatMessage = { ...m };
            if (content.length > 2000) {
                newM.content = content.substring(0, 1000) + BUDGET.COMPACTED_ASSISTANT;
            }
            // Delete reasoning_content to save token overhead from old thoughts.
            // CRITICAL: must use `delete` (not set to placeholder). DeepSeek API requires
            // reasoning_content to be either the ORIGINAL value or completely absent.
            if (newM.reasoning_content) {
                delete newM.reasoning_content;
            }
            messages[i] = newM;
        }
        // Strip reasoning_content from ALL compacted messages (not just aggressive zone).
        // Messages in the middle zone may have truncated content but preserved reasoning,
        // creating a mismatch. Consistent removal prevents stale reasoning from bloating context.
        if (m.role === 'assistant' && m.reasoning_content !== undefined) {
            const stripped: ChatMessage = { ...m };
            delete stripped.reasoning_content;
            messages[i] = stripped;
        }
    }
}
