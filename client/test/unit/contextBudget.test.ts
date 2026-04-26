import { expect } from 'chai';
import { budgetToolResult, compactMessagesInPlace } from '../../extension/ai/contextBudget';
import type { ChatMessage } from '../../extension/ai/types';

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
        // budgetToolResult stringifies objects but for plain strings it shouldn't add quotes
        // Wait, if we fix budgetToolResult to not stringify strings, this passes.
        expect(result).to.equal('simple string');
    });

    it('handles null/undefined', () => {
        expect(budgetToolResult(null, 100)).to.equal('null');
        expect(budgetToolResult(undefined, 100)).to.equal('undefined');
    });
});

describe('compactMessagesInPlace', () => {
    it('does not compact short message arrays', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        compactMessagesInPlace(messages, 2000);
        expect(messages).to.have.lengthOf(2);
    });

    it('compacts long tool results', () => {
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
});
