import { expect } from 'chai';
import {
    TokenCalibrationTable,
    buildCalibrationKey,
    endpointFingerprint,
    readCalibrationSnapshot,
} from '../../extension/ai/runner/tokenCalibration';
import { runContextMaintenance } from '../../extension/ai/runner/contextMaintenance';
import type { ChatMessage } from '../../extension/ai/types';

/** P0 design 3: real-usage-calibrated token estimation. */

describe('runner/tokenCalibration（P0 设计 3：usage 校准）', () => {
    const KEY = buildCalibrationKey('deepseek', 'deepseek-chat', undefined, 'https://api.deepseek.com');

    describe('record / apply', () => {
        it('samples < 5 时 apply 原样返回（冷启动零行为变化）', () => {
            const table = new TokenCalibrationTable();
            for (let i = 0; i < 4; i++) table.record(KEY, 1000, 2000);
            expect(table.apply(KEY, 1000)).to.equal(1000);
        });

        it('满 5 个样本后按 EWMA 比率校准', () => {
            const table = new TokenCalibrationTable();
            for (let i = 0; i < 10; i++) table.record(KEY, 1000, 1500);
            // 比率收敛到 1.5 附近
            expect(table.apply(KEY, 1000)).to.be.closeTo(1500, 100);
        });

        it('比率 clamp 到 [0.5, 2.0]', () => {
            const table = new TokenCalibrationTable();
            for (let i = 0; i < 10; i++) table.record(KEY, 1000, 3900); // 3.9 → clamp 2.0
            expect(table.apply(KEY, 1000)).to.equal(2000);
        });

        it('超出 [0.25, 4] 的异常样本被拒绝', () => {
            const table = new TokenCalibrationTable();
            table.record(KEY, 1000, 100);  // 0.1 → 拒绝
            table.record(KEY, 1000, 5000); // 5.0 → 拒绝
            expect(table.sampleCount(KEY)).to.equal(0);
        });

        it('非正估算/实际值不产生样本', () => {
            const table = new TokenCalibrationTable();
            table.record(KEY, 0, 1000);
            table.record(KEY, 1000, 0);
            table.record(KEY, -5, 1000);
            expect(table.sampleCount(KEY)).to.equal(0);
        });

        it('不同 key 的样本互不共享', () => {
            const table = new TokenCalibrationTable();
            const other = buildCalibrationKey('openai', 'gpt-5', undefined, 'https://api.openai.com');
            for (let i = 0; i < 6; i++) table.record(KEY, 1000, 2000);
            expect(table.apply(other, 1000)).to.equal(1000);
            expect(table.sampleCount(other)).to.equal(0);
        });

        it('容量上限 50 键，超出按 LRU 淘汰', () => {
            const table = new TokenCalibrationTable();
            for (let i = 0; i < 60; i++) {
                table.record(`k${i}`, 1000, 1000);
            }
            expect(table.snapshot()['k0']).to.equal(undefined);
            expect(Object.keys(table.snapshot()).length).to.be.at.most(50);
        });
    });

    describe('key 构造', () => {
        it('NUL 分隔，provider/model/format/endpoint 各字段独立', () => {
            const key = buildCalibrationKey('deepseek', 'DeepSeek-Chat', 'openai', 'https://api.deepseek.com/');
            expect(key.split('\u0000')).to.have.length(4);
            expect(key).to.include('deepseek');
            expect(key).to.include('deepseek-chat'); // model 小写化
        });

        it('端点指纹随 baseURL 变化，且忽略尾斜杠与大小写', () => {
            const fp1 = endpointFingerprint('https://api.example.com/');
            const fp2 = endpointFingerprint('HTTPS://API.EXAMPLE.COM');
            expect(fp1).to.equal(fp2);
            expect(endpointFingerprint('https://other.example.com')).to.not.equal(fp1);
            expect(endpointFingerprint(undefined)).to.equal('');
        });

        it('key 不含路径或用户内容', () => {
            const key = buildCalibrationKey('custom', 'm', 'anthropic', 'https://relay.internal/v1');
            expect(key).to.not.include('https');
            expect(key).to.not.include('relay.internal');
        });
    });

    describe('持久化', () => {
        it('snapshot → readCalibrationSnapshot round-trip', () => {
            const table = new TokenCalibrationTable();
            for (let i = 0; i < 6; i++) table.record(KEY, 1000, 1500);
            const restored = readCalibrationSnapshot({ version: 1, entries: table.snapshot() });
            const table2 = new TokenCalibrationTable(restored);
            expect(table2.apply(KEY, 1000)).to.equal(table.apply(KEY, 1000));
        });

        it('坏数据整体回退冷启动：非对象/错版本/坏条目', () => {
            expect(readCalibrationSnapshot(null)).to.deep.equal({});
            expect(readCalibrationSnapshot('junk')).to.deep.equal({});
            expect(readCalibrationSnapshot({ version: 2, entries: {} })).to.deep.equal({});
            const mixed = readCalibrationSnapshot({
                version: 1,
                entries: {
                    good: { ratio: 1.5, samples: 10, updatedAt: 123 },
                    badRatio: { ratio: 99, samples: 10, updatedAt: 123 },
                    badType: { ratio: 'x', samples: 10, updatedAt: 123 },
                    notObject: 42,
                },
            });
            expect(Object.keys(mixed)).to.deep.equal(['good']);
        });

        it('恢复与直接构造都只保留 updatedAt 最新的 50 项', () => {
            const entries = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
                `k${index}`,
                { ratio: 1, samples: 5, updatedAt: index },
            ]));
            const restored = readCalibrationSnapshot({ version: 1, entries });
            expect(Object.keys(restored)).to.have.length(50);
            expect(restored.k0).to.equal(undefined);
            expect(restored.k59).to.not.equal(undefined);

            const table = new TokenCalibrationTable(entries);
            expect(Object.keys(table.snapshot())).to.have.length(50);
            expect(table.snapshot().k0).to.equal(undefined);
        });

        it('run-end flush 会持久化不足 20 个样本的低流量数据', async () => {
            const snapshots: unknown[] = [];
            const table = new TokenCalibrationTable(undefined, snapshot => { snapshots.push(snapshot); });
            table.record(KEY, 1000, 1500);
            expect(snapshots).to.have.length(0);
            await table.flush();
            expect(snapshots).to.have.length(1);
        });

        it('持久化失败会报告并保留 dirty 状态供下次 flush 重试', async () => {
            let attempts = 0;
            const errors: unknown[] = [];
            const table = new TokenCalibrationTable(
                undefined,
                () => {
                    attempts++;
                    if (attempts === 1) throw new Error('persist failed');
                },
                error => errors.push(error),
            );
            table.record(KEY, 1000, 1500);
            await table.flush();
            expect(attempts).to.equal(1);
            expect(errors).to.have.length(1);
            await table.flush();
            expect(attempts).to.equal(2);
        });

        it('持久化回调单飞串行，且每 20 样本防抖触发', async () => {
            const writes: number[] = [];
            const gates: Array<() => void> = [];
            const table = new TokenCalibrationTable(undefined, () => {
                writes.push(Date.now());
                return new Promise<void>(resolve => { gates.push(resolve); });
            });
            const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

            for (let i = 0; i < 20; i++) table.record(KEY, 1000, 1500);
            await tick();
            expect(writes.length).to.equal(1);
            gates.shift()?.(); // 放行第一笔，第二笔才能串行开始
            for (let i = 0; i < 20; i++) table.record(KEY, 1000, 1500);
            await tick();
            expect(writes.length).to.equal(2); // 串行入队，不丢
            gates.forEach(g => g());
            await tick();
        });
    });

    describe('与 ContextMaintenanceCoordinator 的集成', () => {
        function history(): ChatMessage[] {
            return [
                { role: 'user', content: 'task' },
                { role: 'assistant', content: 'working on it' },
                { role: 'user', content: 'continue' },
            ];
        }

        it('校准放大估算 → 触发 summarize；不校准 → untouched', () => {
            const rawEstimate = 1000; // 通过 calibrate 放大 100 倍
            const depsBase = {
                toolResultBudget: 2000,
                extraTokens: 0,
                summarizeThreshold: 50_000,
            };
            const uncalibrated = runContextMaintenance(history(), 'admission', {
                ...depsBase,
                calibrateEstimate: () => rawEstimate,
            });
            expect(uncalibrated.action).to.equal('untouched');

            const calibrated = runContextMaintenance(history(), 'admission', {
                ...depsBase,
                calibrateEstimate: () => rawEstimate * 100, // 校准后超阈值
            });
            expect(calibrated.action).to.equal('summarize');
        });

        it('before/after 均经校准（比率方向一致）', () => {
            const seen: number[] = [];
            runContextMaintenance(
                [
                    { role: 'user', content: 'task' },
                    ...Array.from({ length: 15 }, (_, i) => ({
                        role: 'assistant' as const,
                        content: `step ${i} ${'x'.repeat(800)}`,
                    })),
                ],
                'emergency',
                {
                    toolResultBudget: 2000,
                    extraTokens: 0,
                    summarizeThreshold: 10,
                    calibrateEstimate: (t) => { seen.push(t); return t * 2; },
                },
            );
            expect(seen.length).to.equal(2); // before + after 各一次
            expect(seen[1]!).to.be.at.most(seen[0]!); // 剪枝后原始估算不增
        });
    });
});
