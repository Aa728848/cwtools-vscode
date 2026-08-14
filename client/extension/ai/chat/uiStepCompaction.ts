/**
 * CWTools AI Module — UI Step Compaction
 *
 * Pure helpers that trim agent steps before sending them to the WebView
 * (live replay, generation-complete payload, topic history restore).
 * Extracted from chatPanel.ts so the behavior is unit-testable.
 *
 * Stream deltas (`text_delta` / `thinking_content`) are the only carriers of
 * the model's reasoning and process text. They must NOT be dropped here —
 * otherwise every rebuild path (panel re-show, history restore, "view process"
 * after completion) loses the reasoning. Instead, consecutive deltas of the
 * same type are merged into a single bounded step.
 */

import { budgetToolResult } from '../contextBudget';

export const UI_HISTORY_STEP_LIMIT = 220;
export const UI_STEP_CONTENT_LIMIT = 4000;
export const UI_STREAM_CONTENT_LIMIT = 20000;
export const UI_TOOL_ARG_BUDGET = 6000;
export const UI_TOOL_RESULT_BUDGET = 6000;

function isStreamDeltaType(type: unknown): boolean {
    return type === 'text_delta' || type === 'thinking_content';
}

export function clipUiText(value: unknown, maxChars = UI_STEP_CONTENT_LIMIT): string {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} chars truncated)`;
}

export function compactObjectForUi(value: unknown, maxChars: number, keepKeys: string[] = []): unknown {
    if (value == null) return value;
    if (typeof value === 'string') return clipUiText(value, maxChars);
    let raw = '';
    try {
        raw = JSON.stringify(value);
    } catch {
        return clipUiText(String(value), maxChars);
    }
    if (raw.length <= maxChars) return value;
    const kept: Record<string, unknown> = { _truncated: true, preview: budgetToolResult(value, maxChars) };
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        for (const key of keepKeys) {
            if (source[key] === undefined) continue;
            const retainedValue = source[key];
            const retainedBudget = Math.min(1200, maxChars);
            if (typeof retainedValue === 'string') {
                kept[key] = clipUiText(retainedValue, retainedBudget);
                continue;
            }
            let retainedRaw = '';
            try { retainedRaw = JSON.stringify(retainedValue); } catch { /* budget fallback below */ }
            kept[key] = retainedRaw.length <= retainedBudget
                ? retainedValue
                : budgetToolResult(retainedValue, retainedBudget);
        }
    }
    return kept;
}

export function compactToolResultForUi(value: unknown): unknown {
    return compactObjectForUi(value, UI_TOOL_RESULT_BUDGET, [
        'success', 'error', 'message', 'file', 'filePath', 'path', 'files',
        'resultRef', 'preview', 'summary', 'diff', 'changes',
    ]);
}

export function compactToolArgsForUi(value: unknown): unknown {
    return compactObjectForUi(value, UI_TOOL_ARG_BUDGET, [
        'file', 'filePath', 'path', 'TargetFile', 'CommandLine', 'Cwd',
        'query', 'key', 'typeName', 'pattern',
    ]);
}

export function compactStepForUi(step: any): any | undefined {
    if (!step || typeof step !== 'object') return step;
    const type = String(step.type || '');
    if (type === 'orchestrator_progress' && /waiting|等待模型返回/i.test(String(step.content || ''))) return undefined;

    const copy: any = { ...step };
    // Stream deltas carry the full reasoning/process text once aggregated —
    // give them a larger content budget than one-off status steps.
    const contentLimit = isStreamDeltaType(type) ? UI_STREAM_CONTENT_LIMIT : UI_STEP_CONTENT_LIMIT;
    if (typeof copy.content === 'string') copy.content = clipUiText(copy.content, contentLimit);
    if (copy.toolArgs !== undefined) copy.toolArgs = compactToolArgsForUi(copy.toolArgs);
    if (copy.toolResult !== undefined) copy.toolResult = compactToolResultForUi(copy.toolResult);
    if (copy.transactionCard?.summary) {
        copy.transactionCard = { ...copy.transactionCard, summary: clipUiText(copy.transactionCard.summary, 1200) };
    }
    return copy;
}

/** Append stream content to an aggregated step, bounded by UI_STREAM_CONTENT_LIMIT. */
function appendStreamContent(target: any, content: unknown): void {
    const prev = typeof target.content === 'string' ? target.content : '';
    const merged = prev + String(content ?? '');
    target.content = merged.length > UI_STREAM_CONTENT_LIMIT
        ? clipUiText(merged, UI_STREAM_CONTENT_LIMIT)
        : merged;
}

/**
 * Merge consecutive same-type stream deltas into a single step so the
 * reasoning/process text survives compaction without flooding the step list
 * with one entry per token chunk.
 */
export function aggregateStreamStepsForUi(steps: any[]): any[] {
    const aggregated: any[] = [];
    for (const step of steps) {
        if (!step || typeof step !== 'object' || !isStreamDeltaType(step.type)) {
            aggregated.push(step);
            continue;
        }
        const last = aggregated[aggregated.length - 1];
        if (last && last.type === step.type) {
            appendStreamContent(last, step.content);
        } else {
            aggregated.push({ ...step });
        }
    }
    return aggregated;
}

export function compactStepsForUi(steps: any[] | undefined, limit = UI_HISTORY_STEP_LIMIT): any[] {
    if (!Array.isArray(steps) || steps.length === 0) return [];
    const cards: any[] = [];
    const regular: any[] = [];
    const latestSubAgentStep = new Map<string, any>();
    for (const step of aggregateStreamStepsForUi(steps)) {
        const compact = compactStepForUi(step);
        if (!compact) continue;
        if (['plan_card', 'walkthrough_card', 'blueprint_card'].includes(String(compact.type || ''))) {
            cards.push(compact);
        } else {
            regular.push(compact);
            if (typeof compact.agentId === 'string' && compact.agentId) {
                latestSubAgentStep.set(compact.agentId, compact);
            }
        }
    }
    const tail = regular.length > limit ? regular.slice(regular.length - limit) : regular;
    const tailedSubAgents = new Set(tail.map(step => step?.agentId).filter(Boolean));
    const subAgentMarkers = [...latestSubAgentStep.entries()]
        .filter(([agentId]) => !tailedSubAgents.has(agentId))
        .map(([, step]) => step);
    return [...cards, ...subAgentMarkers, ...tail].sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
}

export function compactMessagesForWebview(messages: any[] | undefined): any[] {
    if (!Array.isArray(messages)) return [];
    return messages.map(message => {
        if (!message || typeof message !== 'object' || !Array.isArray(message.steps)) return message;
        return { ...message, steps: compactStepsForUi(message.steps) };
    });
}

/**
 * Append a compacted step to the bounded live-step replay list. Consecutive
 * stream deltas merge into the previous entry so a long reasoning stream does
 * not evict tool-call steps from the replay window.
 */
export function pushLiveStepForReplay(liveSteps: any[], step: any, maxSteps: number): void {
    const last = liveSteps[liveSteps.length - 1];
    if (last && isStreamDeltaType(step?.type) && last.type === step.type) {
        appendStreamContent(last, step.content);
        return;
    }
    liveSteps.push(step);
    if (liveSteps.length > maxSteps) {
        liveSteps.splice(0, liveSteps.length - maxSteps);
    }
}

/**
 * Prepare one live step for transport and keep the visibility-replay buffer in
 * sync with that exact compact payload. Returning undefined suppresses noisy
 * progress events before they can congest the Extension Host/Webview bridge.
 */
export function prepareLiveStepForUi(liveSteps: any[], step: any, maxSteps: number): any | undefined {
    const compact = compactStepForUi(step);
    if (!compact) return undefined;
    pushLiveStepForReplay(liveSteps, compact, maxSteps);
    return compact;
}
