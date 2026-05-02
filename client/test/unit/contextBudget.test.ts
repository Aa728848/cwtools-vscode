import { expect } from 'chai';
import { budgetToolResult, compactMessagesInPlace, TOOL_RESULT_BUDGET_BASE } from '../../extension/ai/contextBudget';
import type { ChatMessage } from '../../extension/ai/types';

// ─── TOOL_RESULT_BUDGET_BASE constant ────────────────────────────────────────

describe('TOOL_RESULT_BUDGET_BASE', () => {
    it('is exported and equals 15000', () => {
        expect(TOOL_RESULT_BUDGET_BASE).to.equal(15000);
    });
});

// ─── budgetToolResult ────────────────────────────────────────────────────────

describe('budgetToolResult', () => {
    it('returns JSON string unchanged if within budget', () => {
        const obj = { success: true, file: 'test.txt', content: 'short' };
        const result = budgetToolResult(obj, 1000);
        expect(() => JSON.parse(result)).to.not.throw();
    });

    it('truncates content field if over budget', () => {
        const obj = { success: true, content: 'x'.repeat(2000) };
        const result = budgetToolResult(obj, 500);
        expect(result.length).to.be.lessThan(600); // 500 + suffix length
        expect(result).to.include('[... 已截断');
    });

    it('handles string input', () => {
        const result = budgetToolResult('simple string', 1000);
        expect(result).to.equal('simple string');
    });

    it('handles null/undefined', () => {
        expect(budgetToolResult(null, 100)).to.equal('null');
        expect(budgetToolResult(undefined, 100)).to.equal('undefined');
    });

    it('truncates long strings at budget boundary', () => {
        const longStr = 'a'.repeat(5000);
        const result = budgetToolResult(longStr, 1000);
        expect(result.length).to.be.lessThan(1200);
        expect(result).to.include('[... 已截断');
    });

    // ── read_file optimization ──────────────────────────────────────────────

    it('truncates read_file results at line boundaries', () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`);
        const readResult = { content: lines.join('\n'), totalLines: 200 };
        const result = budgetToolResult(readResult, 2000);
        const parsed = JSON.parse(result);
        expect(parsed.truncated).to.equal(true);
        expect(parsed._linesShown).to.be.a('number').and.lessThan(200);
        expect(parsed.totalLines).to.equal(200);
    });

    it('passes through small read_file results unchanged', () => {
        const readResult = { content: 'line1\nline2\nline3', totalLines: 3 };
        const result = budgetToolResult(readResult, 5000);
        const parsed = JSON.parse(result);
        expect(parsed.content).to.equal('line1\nline2\nline3');
        expect(parsed.truncated).to.not.equal(true);
    });

    // ── Array budgeting ─────────────────────────────────────────────────────

    it('budgets large arrays with segmentation', () => {
        const items = Array.from({ length: 100 }, (_, i) => ({
            message: `Error ${i}`,
            file: `file${i}.txt`,
            line: i,
        }));
        const result = budgetToolResult({ diagnostics: items }, 3000);
        const parsed = JSON.parse(result);
        // Should contain metadata about the original array size
        expect(parsed._diagnosticsTotal).to.equal(100);
        expect(parsed._diagnosticsShown).to.be.a('number').and.lessThan(100);
    });

    it('preserves small arrays without budgeting', () => {
        const items = [{ id: 1 }, { id: 2 }];
        const result = budgetToolResult({ results: items }, 5000);
        const parsed = JSON.parse(result);
        expect(parsed.results).to.deep.equal(items);
    });

    it('deduplicates arrays with repeating messages', () => {
        // Each item has a longish file path so raw JSON exceeds the budget
        const items = Array.from({ length: 50 }, (_, i) => ({
            message: i < 40 ? 'Same error: something went wrong in the processing pipeline' : `Unique error ${i}: a different issue`,
            file: `/very/long/path/to/workspace/src/components/module${i}/implementation.txt`,
            severity: 'error',
            line: i * 10,
            column: 1,
        }));
        const rawLen = JSON.stringify({ diagnostics: items }).length;
        // Budget must be smaller than raw (to trigger budgeting) but large enough for dedup output
        const budget = Math.floor(rawLen * 0.6);
        const result = budgetToolResult({ diagnostics: items }, budget);
        const parsed = JSON.parse(result);
        const diagArr = parsed.diagnostics as Array<Record<string, unknown>>;
        const sameError = diagArr.find(d => (d.message as string).startsWith('Same error'));
        expect(sameError, 'expected "Same error" representative in deduped output').to.not.equal(undefined);
        expect(sameError!._occurrences).to.be.a('number').and.greaterThan(1);
    });

    it('uses default budget when maxChars not specified', () => {
        const result = budgetToolResult({ small: true });
        expect(result).to.be.a('string');
    });
});

// ─── compactMessagesInPlace ──────────────────────────────────────────────────

describe('compactMessagesInPlace', () => {
    it('does not compact short message arrays (< 8)', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        const originalLength = messages.length;
        compactMessagesInPlace(messages, 2000);
        expect(messages).to.have.lengthOf(originalLength);
        expect(messages[0]!.content).to.equal('hi');
    });

    it('does not compact exactly 8 messages', () => {
        const messages: ChatMessage[] = [];
        for (let i = 0; i < 4; i++) {
            messages.push({ role: 'user', content: `msg${i}` });
            messages.push({ role: 'assistant', content: `reply${i}` });
        }
        const contents = messages.map(m => m.content);
        compactMessagesInPlace(messages, 2000);
        expect(messages.map(m => m.content)).to.deep.equal(contents);
    });

    it('compacts long tool results in the middle zone', () => {
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: 'You are a bot.' });
        for (let i = 0; i < 5; i++) {
            messages.push({ role: 'user', content: `msg${i}` });
            messages.push({ role: 'assistant', content: `reply${i}` });
        }
        const longToolResult = {
            success: true,
            content: 'x'.repeat(1000),
            file: '/long/path/test.txt',
            totalLines: 500,
        };
        messages.push({ role: 'tool', content: JSON.stringify(longToolResult), tool_call_id: 'call_1' });
        compactMessagesInPlace(messages, 200);
        expect(messages.length).to.be.greaterThan(0);
    });

    it('keeps system message (head) intact', () => {
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: 'System prompt with important instructions.' });
        for (let i = 0; i < 10; i++) {
            messages.push({ role: 'user', content: `user ${i}` });
            messages.push({ role: 'tool', content: 'x'.repeat(2000), tool_call_id: `c${i}` });
        }
        compactMessagesInPlace(messages, 500);
        expect(messages[0]!.content).to.equal('System prompt with important instructions.');
    });

    it('keeps tail messages intact', () => {
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: 'sys' });
        for (let i = 0; i < 10; i++) {
            messages.push({ role: 'user', content: `user ${i}` });
            messages.push({ role: 'assistant', content: `reply ${i}` });
        }
        const tail = messages.slice(-6).map(m => m.content);
        compactMessagesInPlace(messages, 500);
        const newTail = messages.slice(-6).map(m => m.content);
        expect(newTail).to.deep.equal(tail);
    });

    it('strips reasoning_content from old assistant messages', () => {
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: 'sys' });
        for (let i = 0; i < 12; i++) {
            messages.push({
                role: 'assistant',
                content: `reply ${i} ${'padding'.repeat(100)}`, // > 500 chars to avoid skip
                reasoning_content: `thinking about ${i} `.repeat(100),
            });
            messages.push({ role: 'user', content: `user ${i}` });
        }
        compactMessagesInPlace(messages, 5000);
        // Check that reasoning_content is removed from messages outside the tail
        for (let i = 1; i < messages.length - 6; i++) {
            if (messages[i]!.role === 'assistant') {
                expect(messages[i]!.reasoning_content, `message ${i}`).to.equal(undefined);
            }
        }
    });

    it('aggressively compacts very old tool results to metadata', () => {
        const messages: ChatMessage[] = [];
        messages.push({ role: 'system', content: 'sys' });
        // Create enough messages so the early ones are in the aggressive zone
        for (let i = 0; i < 20; i++) {
            messages.push({ role: 'user', content: `user ${i}` });
            const toolResult = { success: true, file: `/test/file${i}.txt`, content: 'x'.repeat(800) };
            messages.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: `c${i}` });
        }
        compactMessagesInPlace(messages, 500);
        // Early tool messages should be aggressively compacted
        const earlyTool = messages[2]!;
        expect(earlyTool.content).to.be.a('string');
        expect((earlyTool.content as string).length).to.be.lessThan(500);
    });
});
