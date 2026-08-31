import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzePerformanceLog, comparePerformanceLogs, MAX_INPUT_CHARS, MAX_LINE_CHARS } from './analyze-performance-log.mjs';

const fixtureUrl = new URL('./fixtures/performance-log.synthetic.log', import.meta.url);

test('summarizes deterministic performance metrics from the synthetic fixture', async () => {
    const text = await readFile(fixtureUrl, 'utf8');
    const summary = analyzePerformanceLog(text);

    assert.deepEqual(summary.refreshCounts, {
        global: 3,
        localisation: 2,
        prepareEvents: 1,
        commitEvents: 1,
    });
    assert.deepEqual(summary.writeLockHolds, {
        samples: 2,
        totalMs: 65,
        averageMs: 32.5,
        maxMs: 40,
    });
    assert.deepEqual(summary.prepareDurations, {
        samples: 1,
        totalMs: 1500,
        averageMs: 1500,
        maxMs: 1500,
    });
    assert.deepEqual(summary.pendingCounts, { samples: 2, average: 3.5, max: 7, last: 0 });
    assert.deepEqual(summary.memoryPeaks, {
        heapMb: 768,
        allocatedMb: 3072,
        cycleAllocatedMb: 128,
        workingSetMb: 1536,
        privateMb: 1280,
    });
    assert.equal(summary.requestTraces.records, 4);
    assert.equal(summary.requestTraces.malformedRecords, 1);
    assert.deepEqual(Object.keys(summary.requestTraces.methods), [
        'textDocument/completion',
        'textDocument/hover',
        'workspace/symbol',
    ]);
    assert.deepEqual(summary.requestTraces.methods['textDocument/hover'], {
        count: 2,
        total: { samples: 2, totalMs: 20, averageMs: 10, maxMs: 12.5 },
        lockWait: { samples: 2, totalMs: 3, averageMs: 1.5, maxMs: 2 },
        method: { samples: 2, totalMs: 8, averageMs: 4, maxMs: 5 },
        maxPendingCount: 6,
        outcomes: { cancelled: 1, success: 1 },
    });
    assert.deepEqual(summary.requestTraces.methods['workspace/symbol'].total, {
        samples: 0,
        totalMs: 0,
        averageMs: null,
        maxMs: null,
    });
});

test('counts only accepted full-refresh lifecycle blocks', () => {
    const text = [
        '[00:00:00] [refresh] PrepareLooksLikeLifecycle',
        '  fields [elapsedMs=7000]',
        '[00:00:01] [生命周期] AnalyzeLifecycle',
        '  fields [stage=prepare-after] [outcome=prepared]',
        '  fields [elapsedMs=142159]',
        '[00:00:02] [生命周期] AnalyzeLifecycle',
        '  fields [stage=prepare-after] [outcome=skipped]',
        '  fields [elapsedMs=900000]',
        '[00:00:03] [生命周期] AnalyzeLifecycle',
        '  fields [stage=incremental-after] [outcome=prepared]',
        '  fields [elapsedMs=800000]',
        '[00:00:04] [生命周期] AnalyzeLifecycle',
        '  fields [stage=commit-after] [outcome=committed]',
        '[00:00:05] [生命周期] AnalyzeLifecycle',
        '  fields [stage=commit-after] [outcome=skipped]',
    ].join('\n');

    const summary = analyzePerformanceLog(text);
    assert.equal(summary.refreshCounts.prepareEvents, 1);
    assert.equal(summary.refreshCounts.commitEvents, 1);
    assert.deepEqual(summary.prepareDurations, {
        samples: 1,
        totalMs: 142159,
        averageMs: 142159,
        maxMs: 142159,
    });
});

test('tolerates malformed records and ignores invalid measurements', () => {
    const text = [
        '[00:00:00] [RequestTrace] not-json',
        '[00:00:01] [RequestTrace] []',
        '[00:00:02] [RequestTrace] {"method":"safe","totalMs":-1,"lockWaitMs":null}',
        'fields [hold=-5ms] [pending=word] [heap=NaNMB] [refresh=-1]',
        'fields [hold=2s] [pending=4] [heap=1GB] [refresh=9]',
    ].join('\n');

    const first = analyzePerformanceLog(text);
    const second = analyzePerformanceLog(text);
    assert.deepEqual(first, second);
    assert.equal(first.requestTraces.records, 1);
    assert.equal(first.requestTraces.malformedRecords, 2);
    assert.deepEqual(first.writeLockHolds, { samples: 1, totalMs: 2000, averageMs: 2000, maxMs: 2000 });
    assert.deepEqual(first.pendingCounts, { samples: 1, average: 4, max: 4, last: 4 });
    assert.equal(first.memoryPeaks.heapMb, 1024);
    assert.equal(first.memoryPeaks.cycleAllocatedMb, null);
    assert.equal(first.refreshCounts.global, 9);
});

test('keeps cumulative refresh maxima and allocation peaks distinct', () => {
    const summary = analyzePerformanceLog([
        'fields [refresh=21] [refreshLoc=45] [alloc=300000MB] [cycleAllocMB=102232]',
        'fields [refresh=20] [refreshLoc=44] [alloc=400000MB] [cycleAllocMB=90000]',
    ].join('\n'));
    assert.equal(summary.refreshCounts.global, 21);
    assert.equal(summary.refreshCounts.localisation, 45);
    assert.equal(summary.memoryPeaks.allocatedMb, 400000);
    assert.equal(summary.memoryPeaks.cycleAllocatedMb, 102232);
});

test('bounds oversized lines and total input deterministically', () => {
    const oversizedLine = 'x'.repeat(MAX_LINE_CHARS + 1);
    const text = oversizedLine + '\n' + 'y'.repeat(MAX_INPUT_CHARS);
    const summary = analyzePerformanceLog(text);
    assert.equal(summary.input.truncated, true);
    assert.equal(summary.input.skippedOversizedLines, 2);
    assert.equal(summary.requestTraces.records, 0);
});

test('fixture name and content contain no machine-specific path', async () => {
    const fixturePath = fileURLToPath(fixtureUrl).replace(/\\/g, '/');
    const text = await readFile(fixtureUrl, 'utf8');
    assert.match(fixturePath, /tools\/perf\/fixtures\/performance-log\.synthetic\.log$/);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\/Users\/|\/home\//);
});

test('compares performance summaries correctly', () => {
    const baseline = {
        refreshCounts: { global: 21, localisation: 45 },
        writeLockHolds: { maxMs: 46377, averageMs: 500 },
        pendingCounts: { max: 5658 },
        memoryPeaks: { heapMb: 26895, privateMb: 29101 },
    };
    const current = {
        refreshCounts: { global: 3, localisation: 2 },
        writeLockHolds: { maxMs: 40, averageMs: 32.5 },
        pendingCounts: { max: 7 },
        memoryPeaks: { heapMb: 768, privateMb: 1280 },
    };
    const comp = comparePerformanceLogs(current, baseline);
    assert.deepEqual(comp.refreshCounts.global, { current: 3, baseline: 21, delta: -18 });
    assert.deepEqual(comp.writeLockHolds.maxMs, { current: 40, baseline: 46377, delta: -46337 });
    assert.deepEqual(comp.pendingCounts.max, { current: 7, baseline: 5658, delta: -5651 });
    assert.deepEqual(comp.memoryPeaks.heapMb, { current: 768, baseline: 26895, delta: -26127 });
});
