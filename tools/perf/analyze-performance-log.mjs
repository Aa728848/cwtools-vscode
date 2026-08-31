#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAX_INPUT_CHARS = 16 * 1024 * 1024;
export const MAX_LINE_CHARS = 64 * 1024;
const MAX_METRIC_VALUE = 1_000_000_000_000;
const FIELD_PATTERN = /\[([A-Za-z][A-Za-z0-9_]*)=([^\]\r\n]{0,128})\]/g;
const HEADER_PATTERN = /^\s*\[[^\]\r\n]{1,32}\]\s+\[([^\]\r\n]{1,64})\]\s+(.+)$/;

function boundedNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= MAX_METRIC_VALUE ? number : undefined;
}

function durationMs(value) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(value);
    if (!match) return undefined;
    const number = boundedNumber(match[1]);
    if (number === undefined) return undefined;
    return match[2]?.toLowerCase() === 's' ? number * 1000 : number;
}

function memoryMb(value) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s*$/i.exec(value);
    if (!match) return undefined;
    const number = boundedNumber(match[1]);
    if (number === undefined) return undefined;
    switch (match[2].toUpperCase()) {
        case 'B': return number / (1024 * 1024);
        case 'KB': return number / 1024;
        case 'GB': return number * 1024;
        default: return number;
    }
}

function round(number) {
    return Math.round((number + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function distribution(values) {
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        samples: values.length,
        totalMs: round(total),
        averageMs: values.length === 0 ? null : round(total / values.length),
        maxMs: values.length === 0 ? null : round(Math.max(...values)),
    };
}

function numericSamples(values) {
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        samples: values.length,
        average: values.length === 0 ? null : round(total / values.length),
        max: values.length === 0 ? null : Math.max(...values),
        last: values.length === 0 ? null : values[values.length - 1],
    };
}

function extractFields(line) {
    const fields = [];
    FIELD_PATTERN.lastIndex = 0;
    for (let match = FIELD_PATTERN.exec(line); match; match = FIELD_PATTERN.exec(line)) {
        fields.push([match[1], match[2]]);
    }
    return fields;
}

function finiteJsonNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC_VALUE
        ? value
        : undefined;
}

function safeMethod(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value)
        ? value
        : undefined;
}

/** Analyze bounded, untrusted log text without I/O or mutation. */
export function analyzePerformanceLog(text) {
    const source = typeof text === 'string' ? text : '';
    const truncatedInput = source.length > MAX_INPUT_CHARS;
    const bounded = truncatedInput ? source.slice(0, MAX_INPUT_CHARS) : source;
    const rawLines = bounded.split(/\r?\n/);

    const holdDurations = [];
    const prepareDurations = [];
    const pendingCounts = [];
    const memoryPeaks = { heapMb: null, allocatedMb: null, cycleAllocatedMb: null, workingSetMb: null, privateMb: null };
    const refreshMax = { global: null, localisation: null };
    const refreshEvents = { prepared: 0, committed: 0 };
    const methods = new Map();
    let requestTraceRecords = 0;
    let malformedRequestTraceRecords = 0;
    let skippedOversizedLines = 0;
    let lifecycleBlock = null;

    const finishLifecycleBlock = () => {
        if (!lifecycleBlock) return;
        if (lifecycleBlock.stage === 'prepare-after' && lifecycleBlock.outcome === 'prepared') {
            refreshEvents.prepared += 1;
            if (lifecycleBlock.elapsedMs !== undefined) prepareDurations.push(lifecycleBlock.elapsedMs);
        } else if (lifecycleBlock.stage === 'commit-after' && lifecycleBlock.outcome === 'committed') {
            refreshEvents.committed += 1;
        }
        lifecycleBlock = null;
    };

    for (const rawLine of rawLines) {
        if (rawLine.length > MAX_LINE_CHARS) {
            skippedOversizedLines += 1;
            continue;
        }
        const line = rawLine;
        const header = HEADER_PATTERN.exec(line);
        if (header) {
            finishLifecycleBlock();
            const category = header[1].trim();
            const title = header[2].trim();
            if (category === '生命周期' && title === 'AnalyzeLifecycle') lifecycleBlock = {};
        }

        const traceMarker = '[RequestTrace]';
        const markerIndex = line.indexOf(traceMarker);
        if (markerIndex >= 0) {
            const payload = line.slice(markerIndex + traceMarker.length).trim();
            try {
                const parsed = JSON.parse(payload);
                const method = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? safeMethod(parsed.method)
                    : undefined;
                if (!method) throw new Error('invalid RequestTrace method');
                requestTraceRecords += 1;
                let stats = methods.get(method);
                if (!stats) {
                    stats = { count: 0, totalDurations: [], lockWaitDurations: [], methodDurations: [], pendingCounts: [], outcomes: new Map() };
                    methods.set(method, stats);
                }
                stats.count += 1;
                const totalMs = finiteJsonNumber(parsed.totalMs);
                const lockWaitMs = finiteJsonNumber(parsed.lockWaitMs);
                const methodMs = finiteJsonNumber(parsed.methodMs);
                const pendingCount = finiteJsonNumber(parsed.pendingCount);
                if (totalMs !== undefined) stats.totalDurations.push(totalMs);
                if (lockWaitMs !== undefined) stats.lockWaitDurations.push(lockWaitMs);
                if (methodMs !== undefined) stats.methodDurations.push(methodMs);
                if (pendingCount !== undefined) stats.pendingCounts.push(pendingCount);
                if (typeof parsed.outcome === 'string' && parsed.outcome.length <= 128 && !/[\r\n\0]/.test(parsed.outcome)) {
                    stats.outcomes.set(parsed.outcome, (stats.outcomes.get(parsed.outcome) ?? 0) + 1);
                }
            } catch {
                malformedRequestTraceRecords += 1;
            }
        }

        for (const [key, value] of extractFields(line)) {
            if (key === 'hold') {
                const measured = durationMs(value);
                if (measured !== undefined) holdDurations.push(measured);
            } else if (key === 'stage' && lifecycleBlock) {
                lifecycleBlock.stage = value.trim();
            } else if (key === 'outcome' && lifecycleBlock) {
                lifecycleBlock.outcome = value.trim();
            } else if (key === 'elapsedMs' && lifecycleBlock) {
                const measured = durationMs(value);
                if (measured !== undefined) lifecycleBlock.elapsedMs = measured;
            } else if (key === 'pending') {
                const measured = boundedNumber(value);
                if (measured !== undefined && Number.isInteger(measured)) pendingCounts.push(measured);
            } else if (key === 'refresh' || key === 'refreshLoc') {
                const measured = boundedNumber(value);
                if (measured !== undefined && Number.isInteger(measured)) {
                    const target = key === 'refresh' ? 'global' : 'localisation';
                    refreshMax[target] = refreshMax[target] === null ? measured : Math.max(refreshMax[target], measured);
                }
            } else {
                const memoryKey = {
                    heap: 'heapMb',
                    alloc: 'allocatedMb',
                    cycleAllocMB: 'cycleAllocatedMb',
                    working: 'workingSetMb',
                    private: 'privateMb',
                }[key];
                if (memoryKey) {
                    const measured = key === 'cycleAllocMB' ? boundedNumber(value) : memoryMb(value);
                    if (measured !== undefined) {
                        memoryPeaks[memoryKey] = memoryPeaks[memoryKey] === null
                            ? round(measured)
                            : round(Math.max(memoryPeaks[memoryKey], measured));
                    }
                }
            }
        }
    }
    finishLifecycleBlock();

    const methodStatistics = {};
    for (const method of [...methods.keys()].sort()) {
        const stats = methods.get(method);
        methodStatistics[method] = {
            count: stats.count,
            total: distribution(stats.totalDurations),
            lockWait: distribution(stats.lockWaitDurations),
            method: distribution(stats.methodDurations),
            maxPendingCount: stats.pendingCounts.length === 0 ? null : Math.max(...stats.pendingCounts),
            outcomes: Object.fromEntries([...stats.outcomes.entries()].sort(([left], [right]) => left.localeCompare(right))),
        };
    }

    return {
        input: {
            linesProcessed: rawLines.length - skippedOversizedLines,
            skippedOversizedLines,
            truncated: truncatedInput,
        },
        refreshCounts: {
            global: refreshMax.global,
            localisation: refreshMax.localisation,
            prepareEvents: refreshEvents.prepared,
            commitEvents: refreshEvents.committed,
        },
        writeLockHolds: distribution(holdDurations),
        prepareDurations: distribution(prepareDurations),
        pendingCounts: numericSamples(pendingCounts),
        requestTraces: {
            records: requestTraceRecords,
            malformedRecords: malformedRequestTraceRecords,
            methods: methodStatistics,
        },
        memoryPeaks,
    };
}

export function comparePerformanceLogs(currentSummary, baselineSummary) {
    const diffNumber = (curr, base) => {
        if (curr === null || curr === undefined || base === null || base === undefined) return null;
        return round(curr - base);
    };

    return {
        refreshCounts: {
            global: {
                current: currentSummary.refreshCounts.global,
                baseline: baselineSummary.refreshCounts.global,
                delta: diffNumber(currentSummary.refreshCounts.global, baselineSummary.refreshCounts.global),
            },
            localisation: {
                current: currentSummary.refreshCounts.localisation,
                baseline: baselineSummary.refreshCounts.localisation,
                delta: diffNumber(currentSummary.refreshCounts.localisation, baselineSummary.refreshCounts.localisation),
            },
        },
        writeLockHolds: {
            maxMs: {
                current: currentSummary.writeLockHolds.maxMs,
                baseline: baselineSummary.writeLockHolds.maxMs,
                delta: diffNumber(currentSummary.writeLockHolds.maxMs, baselineSummary.writeLockHolds.maxMs),
            },
            averageMs: {
                current: currentSummary.writeLockHolds.averageMs,
                baseline: baselineSummary.writeLockHolds.averageMs,
                delta: diffNumber(currentSummary.writeLockHolds.averageMs, baselineSummary.writeLockHolds.averageMs),
            },
        },
        pendingCounts: {
            max: {
                current: currentSummary.pendingCounts.max,
                baseline: baselineSummary.pendingCounts.max,
                delta: diffNumber(currentSummary.pendingCounts.max, baselineSummary.pendingCounts.max),
            },
        },
        memoryPeaks: {
            heapMb: {
                current: currentSummary.memoryPeaks.heapMb,
                baseline: baselineSummary.memoryPeaks.heapMb,
                delta: diffNumber(currentSummary.memoryPeaks.heapMb, baselineSummary.memoryPeaks.heapMb),
            },
            privateMb: {
                current: currentSummary.memoryPeaks.privateMb,
                baseline: baselineSummary.memoryPeaks.privateMb,
                delta: diffNumber(currentSummary.memoryPeaks.privateMb, baselineSummary.memoryPeaks.privateMb),
            },
        },
    };
}

async function readAndAnalyzeFile(filePath) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`input is not a regular file: ${filePath}`);
    if (fileStat.size > MAX_INPUT_CHARS * 4) throw new Error(`input exceeds analyzer size limit: ${filePath}`);
    const text = await readFile(filePath, 'utf8');
    return analyzePerformanceLog(text);
}

async function main(argv) {
    let currentPath = null;
    let baselinePath = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--baseline' || arg === '-b') {
            if (i + 1 >= argv.length) {
                throw new Error('missing file argument for --baseline');
            }
            baselinePath = argv[++i];
        } else if (!currentPath) {
            currentPath = arg;
        } else if (!baselinePath) {
            baselinePath = arg;
        } else {
            throw new Error('usage: node tools/perf/analyze-performance-log.mjs <log-file> [--baseline <baseline-file>]');
        }
    }

    if (!currentPath) {
        throw new Error('usage: node tools/perf/analyze-performance-log.mjs <log-file> [--baseline <baseline-file>]');
    }

    const currentSummary = await readAndAnalyzeFile(currentPath);

    if (baselinePath) {
        const baselineSummary = await readAndAnalyzeFile(baselinePath);
        const comparison = comparePerformanceLogs(currentSummary, baselineSummary);
        process.stdout.write(JSON.stringify({ current: currentSummary, baseline: baselineSummary, comparison }, null, 2) + '\n');
    } else {
        process.stdout.write(JSON.stringify(currentSummary, null, 2) + '\n');
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
    main(process.argv.slice(2)).catch(error => {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
        process.exitCode = 1;
    });
}
