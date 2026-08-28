import { expect } from 'chai';
import {
    estimateTokenCount,
    estimateChatMessageTokens,
    estimateChatMessagesTokens,
    hasImageContent,
    BASE64_CHARS_PER_TOKEN_ESTIMATE,
} from '../../extension/ai/runner/tokenEstimation';

/**
 * Characterization tests for the token-estimation primitives extracted from
 * agentRunner.ts into runner/tokenEstimation.ts (P0 step 0, pure refactor).
 * These pin the exact pre-extraction behavior so later calibration work
 * (runner/tokenCalibration.ts) cannot silently change the baseline estimator.
 */
describe('runner/tokenEstimation 特征测试（P0 第 0 步纯重构）', () => {
    describe('estimateTokenCount', () => {
        it('空字符串估算为 0', () => {
            expect(estimateTokenCount('')).to.equal(0);
        });

        it('短纯 ASCII 文本走快速路径（4 字符 ≈ 1 token）', () => {
            expect(estimateTokenCount('hello world')).to.equal(3);
        });

        it('短中英文混合文本按 CJK 比率插值', () => {
            // 6 个 CJK + 5 个 ASCII：charsPerToken = 4*(5/11) + 1.5*(6/11) ≈ 2.636
            expect(estimateTokenCount('你好，世界！hello')).to.be.closeTo(5, 2);
        });

        it('恰好 999 字符仍走快速路径，1000 字符走精确路径', () => {
            const fast = estimateTokenCount('a'.repeat(999));
            const precise = estimateTokenCount('a'.repeat(1000));
            expect(fast).to.equal(Math.ceil(999 / 4));
            // 精确路径按长词规则：1000 字符无空白 => 每 4 字符 1 token（采样后外推）
            expect(precise).to.be.closeTo(250, 5);
        });

        it('长文本精确路径对重复单词文本稳定', () => {
            const longText = 'hello '.repeat(250); // 1500 字符
            expect(estimateTokenCount(longText)).to.be.closeTo(250, 50);
        });

        it('长 CJK 文本每个汉字约 1 token', () => {
            const cjkLong = '汉'.repeat(1200);
            expect(estimateTokenCount(cjkLong)).to.be.closeTo(1200, 60);
        });

        it('超过采样窗口的长文本按比例外推', () => {
            const veryLong = 'word '.repeat(4000); // 20000 字符，超过 8000 采样窗
            const estimated = estimateTokenCount(veryLong);
            expect(estimated).to.be.closeTo(4000, 400);
        });
    });

    describe('estimateChatMessageTokens', () => {
        it('普通文本消息 = 内容估算 + 4', () => {
            const tokens = estimateChatMessageTokens({ role: 'assistant', content: 'ok' });
            expect(tokens).to.equal(estimateTokenCount('ok') + 4);
        });

        it('tool_calls 计入估算', () => {
            const withCalls = estimateChatMessageTokens({
                role: 'assistant',
                content: 'ok',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: JSON.stringify({ path: 'x'.repeat(200) }) },
                }],
            });
            expect(withCalls).to.be.greaterThan(estimateTokenCount('ok') + 40);
        });

        it('reasoning_content 计入估算', () => {
            const plain = estimateChatMessageTokens({ role: 'assistant', content: 'ok' });
            const withReasoning = estimateChatMessageTokens({
                role: 'assistant',
                content: 'ok',
                reasoning_content: 'r'.repeat(500),
            });
            expect(withReasoning).to.be.greaterThan(plain + 100);
        });

        it('responses_output_items 优先于其他字段', () => {
            const plain = estimateChatMessageTokens({ role: 'assistant', content: 'ok' });
            const withState = estimateChatMessageTokens({
                role: 'assistant',
                content: 'ok',
                responses_output_items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(4000) }],
            });
            expect(withState).to.be.greaterThan(plain + 500);
        });
    });

    describe('estimateChatMessagesTokens', () => {
        it('空数组为 0', () => {
            expect(estimateChatMessagesTokens([])).to.equal(0);
        });

        it('等于逐条估算之和', () => {
            const messages = [
                { role: 'system' as const, content: 'sys' },
                { role: 'user' as const, content: 'hello world' },
                { role: 'assistant' as const, content: 'ok', reasoning_content: 'r'.repeat(100) },
            ];
            const expected = messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0);
            expect(estimateChatMessagesTokens(messages)).to.equal(expected);
        });
    });

    describe('hasImageContent', () => {
        it('只在请求包含 image_url 时返回 true', () => {
            expect(hasImageContent([{ role: 'user', content: 'text' }])).to.equal(false);
            expect(hasImageContent([{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
                ],
            }])).to.equal(true);
        });
    });

    describe('BASE64_CHARS_PER_TOKEN_ESTIMATE', () => {
        it('保持为 4', () => {
            expect(BASE64_CHARS_PER_TOKEN_ESTIMATE).to.equal(4);
        });
    });
});
