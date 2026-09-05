import { randomUUID } from 'crypto';
import { isRecord } from '../../../shared/protocolValidation';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ReasoningEffort, ToolCall } from '../types';
import { aiText } from '../messages';
import { antigravityOutputTokens, antigravityRuntimeModel } from './models';
import { AntigravityApiError, postAntigravity } from './api';
import type { AntigravityOAuthService } from './oauthService';

export interface AntigravityCallbacks {
    onTextDelta?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolCallDelta?: (name: string, args: string, metadata?: { id?: string; index?: number }) => void;
}

export function buildAntigravityRequest(
    request: ChatCompletionRequest, geminiPayload: Record<string, unknown>,
    projectId: string, effort: ReasoningEffort,
): Record<string, unknown> {
    const model = antigravityRuntimeModel(request.model, effort);
    const maxOutputTokens = Math.min(request.max_tokens ?? antigravityOutputTokens(model), antigravityOutputTokens(model));
    const off = effort === 'none';
    let thinkingConfig: Record<string, unknown> | undefined;
    if (model.startsWith('gemini-2.5-')) {
        thinkingConfig = {
            thinkingBudget: off && !model.includes('pro') ? 0 : effort === 'high' || effort === 'max' || effort === 'xhigh' ? 32_768 : effort === 'medium' ? 16_384 : 4096,
            includeThoughts: !off,
        };
    } else if (model.endsWith('-tiered') || model === 'gemini-3-flash') {
        // Gemini 3.7/3.8 tiered runtimes reject MINIMAL, including routing calls with thinking disabled.
        const minimumLevel = model.endsWith('-tiered') ? 'LOW' : 'MINIMAL';
        thinkingConfig = {
            thinkingLevel: off || effort === 'minimal' ? minimumLevel : effort === 'high' || effort === 'xhigh' || effort === 'max' ? 'HIGH' : effort === 'medium' ? 'MEDIUM' : 'LOW',
            includeThoughts: !off,
        };
    } else if (model.startsWith('gemini-')) {
        thinkingConfig = { includeThoughts: !off };
    }
    if (thinkingConfig && typeof thinkingConfig.thinkingBudget === 'number') {
        thinkingConfig.thinkingBudget = Math.min(thinkingConfig.thinkingBudget, Math.max(0, maxOutputTokens - 1));
    }
    const instruction = isRecord(geminiPayload.systemInstruction) ? geminiPayload.systemInstruction : {};
    return {
        project: projectId, model, requestType: 'agent', userAgent: 'antigravity', requestId: `req_${randomUUID()}`,
        request: {
            ...geminiPayload,
            systemInstruction: { ...instruction, role: 'user', parts: instruction.parts ?? [{ text: 'You are a coding assistant.' }] },
            ...(request.tools?.length ? { toolConfig: { functionCallingConfig: {
                mode: request.tool_choice === 'none' ? 'NONE' : typeof request.tool_choice === 'object' ? 'ANY' : 'AUTO',
                ...(typeof request.tool_choice === 'object' ? { allowedFunctionNames: [request.tool_choice.function.name] } : {}),
            } } } : {}),
            generationConfig: {
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                maxOutputTokens,
                ...(thinkingConfig ? { thinkingConfig } : {}),
            },
        },
    };
}

function tokenCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Parse wrapped Gemini SSE while retaining signed parts for the next tool-result turn. */
export async function consumeAntigravityResponse(
    response: Response, model: string, signal: AbortSignal, callbacks: AntigravityCallbacks = {},
): Promise<ChatCompletionResponse> {
    const replayParts: Array<Record<string, unknown>> = [];
    const tools: ToolCall[] = [];
    const text: string[] = [];
    const thinking: string[] = [];
    let usage: Record<string, unknown> = {};
    let finish = '';
    let doneMarker = false;
    const invalid = () => new Error(aiText('Antigravity returned an invalid or incomplete response.', 'Antigravity 返回了无效或不完整的响应。'));
    const processChunk = (chunk: unknown) => {
        if (!isRecord(chunk)) throw invalid();
        const data = isRecord(chunk.response) ? chunk.response : chunk;
        if (data.error || chunk.error) throw new Error(aiText('Antigravity reported a stream error.', 'Antigravity 返回流式错误。'));
        if (isRecord(data.usageMetadata)) usage = { ...usage, ...data.usageMetadata };
        const candidate: unknown = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
        if (!isRecord(candidate)) {
            if (isRecord(data.promptFeedback) && data.promptFeedback.blockReason) throw new Error(aiText('Antigravity blocked the prompt.', 'Antigravity 拒绝了此提示词。'));
            return;
        }
        if (typeof candidate.finishReason === 'string') finish = candidate.finishReason;
        const parts: unknown[] = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
        for (const raw of parts) {
            if (!isRecord(raw)) throw invalid();
            const part = { ...raw };
            const fn = part.functionCall;
            if (fn !== undefined) {
                if (!isRecord(fn) || typeof fn.name !== 'string' || !fn.name.trim()) throw invalid();
                let args: unknown = fn.args ?? {};
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw invalid(); } }
                if (!isRecord(args)) throw invalid();
                const id = typeof fn.id === 'string' && fn.id ? fn.id : `ag_${randomUUID().replace(/-/g, '')}`;
                const signature = part.thoughtSignature ?? part.thought_signature ?? fn.thoughtSignature;
                const call: ToolCall = {
                    id, type: 'function', function: { name: fn.name, arguments: JSON.stringify(args) },
                    ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
                };
                part.functionCall = { ...fn, args, ...(!model.startsWith('gemini-') ? { id } : {}) };
                tools.push(call);
                callbacks.onToolCallDelta?.(fn.name, call.function.arguments, { id, index: tools.length - 1 });
            }
            if (typeof part.text === 'string') {
                if (part.thought === true) { thinking.push(part.text); callbacks.onThinking?.(part.text); }
                else { text.push(part.text); callbacks.onTextDelta?.(part.text); }
            }
            replayParts.push(part);
        }
    };

    signal.throwIfAborted();
    if (/application\/json/i.test(response.headers.get('content-type') ?? '')) {
        const data: unknown = await response.json();
        if (Array.isArray(data)) data.forEach(processChunk); else processChunk(data);
    } else {
        if (!response.body) throw invalid();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedBytes = 0;
        const processRecord = (record: string) => {
            const data = record.split(/\r?\n/).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n').trim();
            if (!data) return;
            if (data === '[DONE]') { doneMarker = true; return; }
            let value: unknown;
            try { value = JSON.parse(data); } catch { throw invalid(); }
            processChunk(value);
        };
        let completed = false;
        try {
            while (!doneMarker) {
                signal.throwIfAborted();
                let rejectRead: (error: unknown) => void = () => {};
                const timeout = setTimeout(() => rejectRead(new Error(aiText('Antigravity stream timed out.', 'Antigravity 响应流超时。'))), 300_000);
                const onAbort = () => rejectRead(signal.reason);
                try {
                    const read = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
                        rejectRead = reject;
                        signal.addEventListener('abort', onAbort, { once: true });
                    })]);
                    if (read.done) { completed = true; break; }
                    receivedBytes += read.value.byteLength;
                    if (receivedBytes > 32 * 1024 * 1024) throw invalid();
                    buffer += decoder.decode(read.value, { stream: true });
                    const records = buffer.split(/\r?\n\r?\n/);
                    buffer = records.pop() ?? '';
                    for (const record of records) processRecord(record);
                } finally {
                    clearTimeout(timeout);
                    signal.removeEventListener('abort', onAbort);
                }
            }
            buffer += decoder.decode();
            if (buffer.trim()) processRecord(buffer);
        } finally {
            if (!completed) await reader.cancel();
            reader.releaseLock();
        }
    }
    signal.throwIfAborted();
    const blocked = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finish);
    if (!tools.length && !text.join('').trim()) {
        if (blocked) throw new Error(aiText('Antigravity blocked the response.', 'Antigravity 拒绝了此回复。'));
        throw invalid();
    }
    if (!finish && !doneMarker) throw invalid();
    const message: ChatMessage = {
        role: 'assistant', content: text.join('') || null,
        ...(thinking.length ? { reasoning_content: thinking.join('') } : {}),
        ...(tools.length ? { tool_calls: tools } : {}),
        antigravity_content: { model, parts: replayParts },
    };
    const prompt = tokenCount(usage.promptTokenCount);
    const output = tokenCount(usage.candidatesTokenCount) + tokenCount(usage.thoughtsTokenCount);
    return {
        id: `antigravity-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: blocked ? 'content_filter' : tools.length ? 'tool_calls' : finish === 'MAX_TOKENS' ? 'length' : 'stop' }],
        usage: {
            prompt_tokens: prompt, completion_tokens: output,
            total_tokens: tokenCount(usage.totalTokenCount) || prompt + output,
            cached_tokens: tokenCount(usage.cachedContentTokenCount),
            cached_content_token_count: tokenCount(usage.cachedContentTokenCount),
        },
    };
}

export async function callAntigravity(
    oauth: Pick<AntigravityOAuthService, 'getRequestContext'>,
    request: ChatCompletionRequest, payload: Record<string, unknown>, effort: ReasoningEffort,
    signal: AbortSignal, callbacks: AntigravityCallbacks, fetchFn: typeof fetch = fetch,
): Promise<ChatCompletionResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { token, projectId } = await oauth.getRequestContext(signal, attempt > 0);
            const response = await postAntigravity(fetchFn, token, 'streamGenerateContent',
                buildAntigravityRequest(request, payload, projectId, effort), signal, request.model.startsWith('claude-'));
            return await consumeAntigravityResponse(response, request.model, signal, callbacks);
        } catch (error) {
            signal.throwIfAborted();
            if (attempt === 0 && error instanceof AntigravityApiError && error.status === 401) continue;
            throw error;
        }
    }
    throw new Error('Antigravity authentication failed.');
}
