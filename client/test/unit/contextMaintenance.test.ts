import { expect } from 'chai';
import type { ChatMessage } from '../../extension/ai/types';
import {
    estimateContextRequestTokens,
    runContextMaintenance,
    shouldCompactEarlyForCost,
    type MaintenanceDeps,
} from '../../extension/ai/runner/contextMaintenance';

/**
 * Context Maintenance Coordinator (P0 design 2).
 * Pins the reason-aware ladder: estimate -> free prune -> re-estimate -> decide.
 */

/** Big tool-result payload that compactMessagesInPlace will squeeze (>500 chars, aggressive zone). */
function bigToolContent(size = 4000): string {
    return JSON.stringify({ success: true, filePath: 'common/test.txt', content: 'x'.repeat(size) });
}

/**
 * History shape: 1 head user message + `pairs` assistant/tool-call rounds with
 * large tool results, + a small live tail. Length ≈ 2 + pairs*3 + tail.
 */
function buildHistory(pairs: number, toolSize = 4000): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'user', content: 'do the task' }];
    for (let i = 0; i < pairs; i++) {
        messages.push({
            role: 'assistant',
            content: `editing step ${i}`,
            tool_calls: [{
                id: `call_${i}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) },
            }],
        });
        messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: bigToolContent(toolSize) });
        messages.push({ role: 'assistant', content: `result noted ${i}` });
    }
    // Live tail (protected from pruning)
    for (let i = 0; i < 6; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `tail ${i}` });
    }
    return messages;
}

function deps(overrides: Partial<MaintenanceDeps>): MaintenanceDeps {
    return {
        toolResultBudget: 2000,
        extraTokens: 0,
        summarizeThreshold: 100_000,
        ...overrides,
    };
}

describe('cost-aware context maintenance', () => {
    const gate = {
        contextLimitTokens: 10_000,
        inputPriceCnyPerMillion: 10,
        recentHitRatio: 0.1,
        warmHitRatio: 0.7,
        minUsageRatio: 0.6,
        maxUncachedCostCny: 0.05,
    };

    it('fires only for sufficiently large, cold, costly requests', () => {
        expect(shouldCompactEarlyForCost(7_000, gate)).to.equal(true);
        expect(shouldCompactEarlyForCost(5_000, gate)).to.equal(false);
        expect(shouldCompactEarlyForCost(7_000, { ...gate, recentHitRatio: 0.8 })).to.equal(false);
        expect(shouldCompactEarlyForCost(7_000, { ...gate, inputPriceCnyPerMillion: 0 })).to.equal(false);
    });

    it('escalates admission below the normal context watermark after free prune', () => {
        const history = buildHistory(2, 600);
        const result = runContextMaintenance(history, 'admission', deps({
            summarizeThreshold: 1_000_000,
            costGate: gate,
            extraTokens: 7_000,
        }));
        expect(result.action).to.equal('summarize');
        expect(result.costGateFired).to.equal(true);
    });
});

describe('runner/contextMaintenance（P0 设计 2：统一剪枝阶梯）', () => {
    describe('admission', () => {
        it('低于阈值时返回 untouched 且历史完全不被修改', () => {
            const history = buildHistory(1, 600);
            const snapshot = JSON.stringify(history);
            const result = runContextMaintenance(history, 'admission', deps({ summarizeThreshold: 1_000_000 }));
            expect(result.action).to.equal('untouched');
            expect(result.messages).to.equal(history); // same reference
            expect(JSON.stringify(history)).to.equal(snapshot); // byte-identical
            expect(result.beforeTokens).to.equal(result.afterTokens);
        });

        it('超阈值但剪枝后回落 → pruned-below-threshold，历史被就地剪枝', () => {
            const history = buildHistory(20);
            const before = estimateContextRequestTokens(history);
            // 阈值设在 before 之下、剪枝后之上/之下由 fixture 保证：大量老 tool result 会被压到几百字符
            const threshold = before - 100;
            const result = runContextMaintenance(history, 'admission', deps({ summarizeThreshold: threshold }));
            expect(result.beforeTokens).to.be.greaterThan(threshold);
            expect(result.afterTokens).to.be.lessThan(result.beforeTokens);
            if (result.afterTokens <= threshold) {
                expect(result.action).to.equal('pruned-below-threshold');
            } else {
                expect(result.action).to.equal('summarize');
            }
        });

        it('剪枝后仍超阈值 → summarize', () => {
            const history = buildHistory(2, 600);
            // extraTokens 制造一个剪枝无法消除的超额
            const before = estimateContextRequestTokens(history, 50_000);
            const result = runContextMaintenance(history, 'admission', deps({
                extraTokens: 50_000,
                summarizeThreshold: before - 10_000,
            }));
            expect(result.action).to.equal('summarize');
        });
    });

    describe('manual / overflow（权威信号，强制摘要）', () => {
        it('manual：即使远低于阈值也必须 summarize', () => {
            const history = buildHistory(1, 600);
            const result = runContextMaintenance(history, 'manual', deps({ summarizeThreshold: 1_000_000 }));
            expect(result.action).to.equal('summarize');
        });

        it('overflow：本地估算低于阈值也必须 summarize', () => {
            const history = buildHistory(1, 600);
            const result = runContextMaintenance(history, 'overflow', deps({ summarizeThreshold: 1_000_000 }));
            expect(result.action).to.equal('summarize');
        });

        it('manual：剪枝确实缩小了 summarizer 输入', () => {
            const history = buildHistory(20);
            const before = estimateContextRequestTokens(history);
            const result = runContextMaintenance(history, 'manual', deps({}));
            expect(result.action).to.equal('summarize');
            expect(result.afterTokens).to.be.lessThan(before);
        });
    });

    describe('mid_loop（保留 anti-thrash 0.90 门槛）', () => {
        it('剪枝后低于阈值 → pruned-below-threshold', () => {
            const history = buildHistory(20);
            const beforeTokens = estimateContextRequestTokens(history);
            const threshold = beforeTokens - 100;
            const result = runContextMaintenance(history, 'mid_loop', deps({ summarizeThreshold: threshold }));
            expect(result.afterTokens).to.be.lessThan(result.beforeTokens);
            expect(result.afterTokens).to.be.at.most(threshold);
            expect(result.action).to.equal('pruned-below-threshold');
        });

        it('剪枝无效（减少 <10%）且仍超阈值 → summarize', () => {
            // 几乎没有可剪内容（消息少且小），超额来自 extraTokens
            const history = buildHistory(2, 600);
            const before = estimateContextRequestTokens(history, 5000);
            const result = runContextMaintenance(history, 'mid_loop', deps({
                extraTokens: 5000,
                summarizeThreshold: before - 1000,
                ineffectivenessGate: true,
            }));
            expect(result.action).to.equal('summarize');
        });

        it('剪枝有效（减少 ≥10%）即使仍超阈值也不升级付费', () => {
            const history = buildHistory(30);
            // 阈值极低：剪枝后仍超；但剪枝减少远超 10%
            const result = runContextMaintenance(history, 'mid_loop', deps({
                summarizeThreshold: 10,
                ineffectivenessGate: true,
            }));
            expect(result.afterTokens).to.be.at.most(result.beforeTokens * 0.9);
            expect(result.action).to.equal('pruned-below-threshold');
        });

        it('无 ineffectivenessGate 时只按阈值判断', () => {
            const history = buildHistory(30);
            const result = runContextMaintenance(history, 'mid_loop', deps({ summarizeThreshold: 10 }));
            expect(result.afterTokens).to.be.at.most(result.beforeTokens * 0.9);
            expect(result.action).to.equal('summarize');
        });
    });

    describe('emergency', () => {
        it('剪枝后仍超阈值 → summarize；否则 pruned-below-threshold', () => {
            const history = buildHistory(20);
            const over = runContextMaintenance(history, 'emergency', deps({ summarizeThreshold: 10 }));
            expect(over.action).to.equal('summarize');

            const history2 = buildHistory(20);
            const before2 = estimateContextRequestTokens(history2);
            const under = runContextMaintenance(history2, 'emergency', deps({ summarizeThreshold: before2 - 100 }));
            if (under.afterTokens <= before2 - 100) {
                expect(under.action).to.equal('pruned-below-threshold');
            }
        });
    });

    describe('不变量', () => {
        it('剪枝不删除消息（tool-call/result 配对所有权不变）', () => {
            const history = buildHistory(20);
            const lengthBefore = history.length;
            runContextMaintenance(history, 'manual', deps({}));
            expect(history.length).to.equal(lengthBefore);
            // 每个 assistant tool_calls 仍有对应的 tool result 消息
            const toolCallIds = history.flatMap(m => (m.tool_calls ?? []).map(tc => tc.id));
            const toolResultIds = new Set(history.filter(m => m.role === 'tool').map(m => m.tool_call_id));
            for (const id of toolCallIds) {
                expect(toolResultIds.has(id), `missing tool result for ${id}`).to.equal(true);
            }
        });

        it('始终返回同一数组引用（就地契约）', () => {
            const history = buildHistory(5);
            const result = runContextMaintenance(history, 'emergency', deps({ summarizeThreshold: 10 }));
            expect(result.messages).to.equal(history);
        });
    });
});
