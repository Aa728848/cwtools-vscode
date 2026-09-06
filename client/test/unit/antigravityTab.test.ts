import { expect } from 'chai';
import { buildAntigravityTabRequest, callAntigravityTab, parseAntigravityTabEdit } from '../../extension/ai/antigravity/tabCompletion';
import { consumeAntigravityResponse } from '../../extension/ai/antigravity/completion';

const context = { prefix: 'function add(a, b) {\n    return ', suffix: '\n}\n', languageId: 'javascript' };
const continuation = '": "function add(a, b) {\\n    return a + b\\n}\\n"\n\t\t}\n\t]\n}\n</replace_file_content>';

function response(text: string, finishReason = 'STOP'): Response {
    const event = { response: { candidates: [{ content: { parts: [{ text }] }, finishReason }] } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Antigravity native Tab protocol', () => {
    it('decodes native lead-in continuation into an insertion without echoed context', () => {
        const { leadIn, payload } = buildAntigravityTabRequest(context);
        expect(payload.requestType).to.equal('tab');
        expect(payload.model).to.equal('tab_flash_lite_preview');
        expect(payload.request.generationConfig.thinkingConfig).to.deep.equal({ includeThoughts: false, thinkingBudget: 0 });
        expect(parseAntigravityTabEdit(context, leadIn, continuation)).to.deep.equal({ start: 32, end: 32, text: 'a + b' });
    });

    it('preserves escaped quotes, backslashes, indentation and CRLF in the edit', () => {
        const input = { prefix: 'path = ', suffix: '\r\nnext = yes\r\n' };
        const { leadIn } = buildAntigravityTabRequest(input);
        const text = '"folder\\name"';
        const output = '": ' + JSON.stringify(input.prefix + text + input.suffix) + '}]}</replace_file_content>';
        expect(parseAntigravityTabEdit(input, leadIn, output)).to.deep.equal({ start: 7, end: 7, text });
    });

    it('allows an empty target only when completing an empty document', () => {
        const input = { prefix: '', suffix: '' };
        const output = '": "immediate = {\\n}\\n"}]}</replace_file_content>';
        expect(parseAntigravityTabEdit(input, buildAntigravityTabRequest(input).leadIn, output))
            .to.deep.equal({ start: 0, end: 0, text: 'immediate = {\n}\n' });
        const existing = { prefix: 'existing', suffix: '' };
        expect(parseAntigravityTabEdit(existing, buildAntigravityTabRequest(existing, true).leadIn,
            '": "", "ReplacementContent": "changed"}]}</replace_file_content>')).to.equal(undefined);
    });

    it('locates a jump from the target edit instead of interpreting model output as coordinates', () => {
        const input = { prefix: 'function double(amount', suffix: ') {\n    return value * 2;\n}', previousText: 'function double(value) {\n    return value * 2;\n}' };
        const { leadIn, payload } = buildAntigravityTabRequest(input, true);
        expect(payload.requestType).to.equal('tab_jump');
        expect(payload.model).to.equal('tab_jump_flash_lite_preview');
        const output = '": "    return value * 2;", "ReplacementContent": "    return amount * 2;"}]}</replace_file_content>';
        expect(parseAntigravityTabEdit(input, leadIn, output)).to.deep.equal({ start: 37, end: 42, text: 'amount' });
    });

    it('rejects incomplete, ambiguous, foreign-file and extra-call output', () => {
        const { leadIn } = buildAntigravityTabRequest(context);
        expect(parseAntigravityTabEdit(context, leadIn, continuation.slice(0, -10))).to.equal(undefined);
        expect(parseAntigravityTabEdit(context, leadIn, continuation + '<run_command>{}</run_command>')).to.equal(undefined);
        expect(parseAntigravityTabEdit(context, leadIn.replace('current.txt', 'other.txt'), continuation)).to.equal(undefined);
        const duplicate = { prefix: 'value\n', suffix: 'value' };
        expect(parseAntigravityTabEdit(duplicate, buildAntigravityTabRequest(duplicate, true).leadIn,
            '": "value", "ReplacementContent": "amount"}]}</replace_file_content>')).to.equal(undefined);
    });

    it('refreshes an expired credential once while retaining the native request and shared transport', async () => {
        const refreshes: boolean[] = [];
        const headers: string[] = [];
        const oauth = { getRequestContext: async (_signal: AbortSignal, refresh = false) => {
            refreshes.push(refresh); return { token: refresh ? 'fresh' : 'expired', projectId: 'test-project' };
        } };
        const fetchFn: typeof fetch = async (url, init) => {
            expect(String(url)).to.equal('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
            headers.push(new Headers(init?.headers).get('Authorization') || '');
            if (headers.length === 1) return new Response('{}', { status: 401 });
            return response(continuation);
        };
        expect(await callAntigravityTab(oauth, fetchFn, context, new AbortController().signal)).to.deep.equal({ start: 32, end: 32, text: 'a + b' });
        expect(refreshes).to.deep.equal([false, true]);
        expect(headers).to.deep.equal(['Bearer expired', 'Bearer fresh']);
    });

    it('rejects token-limited responses and cancels an open response body', async () => {
        const oauth = { getRequestContext: async () => ({ token: 'test', projectId: 'test-project' }) };
        expect(await callAntigravityTab(oauth, async () => response(continuation, 'MAX_TOKENS'), context, new AbortController().signal)).to.equal(undefined);
        const controller = new AbortController();
        let cancelled = false;
        const pending = callAntigravityTab(oauth, async () => {
            setTimeout(() => controller.abort(), 0);
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
        }, context, controller.signal);
        const error: unknown = await pending.catch(error => error);
        expect(error).to.be.instanceOf(Error);
        expect(cancelled).to.equal(true);
    });

    it('restores CRLF offsets after the model uses LF', async () => {
        const input = { prefix: '# resources\r\nenergy = ', suffix: '\r\n}\r\n' };
        const oauth = { getRequestContext: async () => ({ token: 'test', projectId: 'test-project' }) };
        const edit = await callAntigravityTab(oauth, async (_url, init) => {
            expect(String(init?.body)).not.to.include('\\r');
            return response('": "# resources\\nenergy = 500\\n    minerals = 100\\n}\\n"}]}</replace_file_content>');
        }, input, new AbortController().signal);
        expect(edit).to.deep.equal({ start: input.prefix.length, end: input.prefix.length, text: '500\r\n    minerals = 100' });
    });

    it('returns the finished editor candidate without waiting for an open HTTP stream', async () => {
        const controller = new AbortController();
        let cancelled = false;
        const timer = setTimeout(() => controller.abort(), 1000);
        const oauth = { getRequestContext: async () => ({ token: 'test', projectId: 'test-project' }) };
        try {
            const edit = await callAntigravityTab(oauth, async () => new Response(new ReadableStream({
                start(stream) {
                    const event = { response: { candidates: [{ content: { parts: [{ text: continuation }] }, finishReason: 'STOP' }] } };
                    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
                },
                cancel() { cancelled = true; },
            }), { headers: { 'Content-Type': 'text/event-stream' } }), context, controller.signal);
            expect(edit).to.deep.equal({ start: 32, end: 32, text: 'a + b' });
            expect(cancelled).to.equal(true);
        } finally { clearTimeout(timer); controller.abort(); }
    });

    it('retains post-finish usage trailers for ordinary chat responses', async () => {
        const events = [
            { response: { candidates: [{ content: { parts: [{ text: 'reply' }] }, finishReason: 'STOP' }] } },
            { response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } },
        ];
        const stream = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
        const result = await consumeAntigravityResponse(stream, 'gemini-3-flash', new AbortController().signal);
        expect(result.usage?.total_tokens).to.equal(12);
    });
});
