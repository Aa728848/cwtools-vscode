import { expect } from 'chai';
import {
    escapeHtml,
    formatNum,
    formatTime,
    formatDuration,
    fileBaseName,
    extractStepFile,
    makeRunSummary,
} from '../../webview/chat/formatters';

describe('Chat Formatters', () => {
    // ── escapeHtml ─────────────────────────────────────────────────────

    it('escapeHtml escapes angle brackets', () => {
        expect(escapeHtml('<div>')).to.equal('&lt;div&gt;');
    });

    it('escapeHtml escapes ampersand and quotes', () => {
        expect(escapeHtml('a & "b"')).to.equal('a &amp; &quot;b&quot;');
    });

    it('escapeHtml handles null and undefined', () => {
        expect(escapeHtml(null)).to.equal('');
        expect(escapeHtml(undefined)).to.equal('');
    });

    it('escapeHtml handles numbers', () => {
        expect(escapeHtml(42)).to.equal('42');
    });

    // ── formatNum ──────────────────────────────────────────────────────

    it('formatNum returns raw number below 1000', () => {
        expect(formatNum(800)).to.equal('800');
    });

    it('formatNum uses k suffix for thousands', () => {
        expect(formatNum(1500)).to.equal('2k');
        expect(formatNum(10000)).to.equal('10k');
    });

    it('formatNum handles zero', () => {
        expect(formatNum(0)).to.equal('0');
    });

    // ── formatTime ─────────────────────────────────────────────────────

    it('formatTime returns empty for null', () => {
        expect(formatTime(null)).to.equal('');
    });

    it('formatTime formats timestamp as HH:MM', () => {
        // 2024-01-15 14:30:00 UTC
        const ts = new Date(2024, 0, 15, 14, 30, 0).getTime();
        expect(formatTime(ts)).to.equal('14:30');
    });

    it('formatTime pads single digits', () => {
        const ts = new Date(2024, 0, 15, 9, 5, 0).getTime();
        expect(formatTime(ts)).to.equal('09:05');
    });

    // ── formatDuration ─────────────────────────────────────────────────

    it('formatDuration returns 0ms for zero', () => {
        expect(formatDuration(0)).to.equal('0ms');
    });

    it('formatDuration returns ms for sub-second', () => {
        expect(formatDuration(500)).to.equal('500ms');
    });

    it('formatDuration returns seconds for sub-minute', () => {
        expect(formatDuration(2500)).to.equal('2.5s');
    });

    it('formatDuration returns minutes and seconds', () => {
        expect(formatDuration(90000)).to.equal('1m 30s');
    });

    it('formatDuration returns 0ms for negative', () => {
        expect(formatDuration(-100)).to.equal('0ms');
    });

    // ── fileBaseName ───────────────────────────────────────────────────

    it('fileBaseName extracts from forward slash path', () => {
        expect(fileBaseName('common/events/test.txt')).to.equal('test.txt');
    });

    it('fileBaseName extracts from backslash path', () => {
        expect(fileBaseName('C:\\Users\\A\\test.txt')).to.equal('test.txt');
    });

    it('fileBaseName returns input when no separator', () => {
        expect(fileBaseName('test.txt')).to.equal('test.txt');
    });

    // ── extractStepFile ────────────────────────────────────────────────

    it('extractStepFile extracts from toolArgs.file', () => {
        expect(extractStepFile({ toolArgs: { file: 'events/test.txt' } })).to.equal('test.txt');
    });

    it('extractStepFile extracts from toolArgs.filePath', () => {
        expect(extractStepFile({ toolArgs: { filePath: 'common/test.txt' } })).to.equal('test.txt');
    });

    it('extractStepFile returns empty for missing args', () => {
        expect(extractStepFile({})).to.equal('');
    });

    // ── makeRunSummary ─────────────────────────────────────────────────

    it('makeRunSummary handles empty steps', () => {
        const summary = makeRunSummary([]);
        expect(summary.totalSteps).to.equal(0);
        expect(summary.toolCallCount).to.equal(0);
        expect(summary.latestStatus).to.equal('已完成');
    });

    it('makeRunSummary counts tool calls correctly', () => {
        const steps = [
            { type: 'tool_call', toolName: 'read_file', toolArgs: { file: 'a.txt' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'read_file', toolResult: { success: true }, timestamp: 1100 },
            { type: 'tool_call', toolName: 'write_file', toolArgs: { file: 'b.txt' }, timestamp: 1200 },
            { type: 'tool_result', toolName: 'write_file', toolResult: { success: true }, timestamp: 1300 },
        ];
        const summary = makeRunSummary(steps);
        expect(summary.toolCallCount).to.equal(2);
        expect(summary.toolResultCount).to.equal(2);
        expect(summary.readCount).to.equal(1);
        expect(summary.writeCount).to.equal(1);
        expect(summary.changedFiles).to.include('b.txt');
    });

    it('makeRunSummary tracks errors', () => {
        const steps = [
            { type: 'tool_call', toolName: 'write_file', toolArgs: {}, timestamp: 1000 },
            { type: 'tool_result', toolName: 'write_file', toolResult: { success: false, error: 'fail' }, timestamp: 1100 },
            { type: 'error', content: 'Something went wrong', timestamp: 1200 },
        ];
        const summary = makeRunSummary(steps);
        expect(summary.failedToolCount).to.equal(1);
        expect(summary.errorCount).to.equal(1);
        expect(summary.alerts).to.have.length(2);
    });

    it('makeRunSummary computes duration from timestamps', () => {
        const steps = [
            { type: 'thinking', timestamp: 1000 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: {}, timestamp: 5000 },
        ];
        const summary = makeRunSummary(steps);
        expect(summary.durationMs).to.equal(4000);
    });

    it('makeRunSummary uses fallbackContent for latestStatus', () => {
        const summary = makeRunSummary([], 'Custom status');
        expect(summary.latestStatus).to.equal('Custom status');
    });

    it('makeRunSummary identifies top tools', () => {
        const steps = [
            { type: 'tool_call', toolName: 'read_file', toolArgs: {}, timestamp: 1000 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: {}, timestamp: 1001 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: {}, timestamp: 1002 },
            { type: 'tool_call', toolName: 'write_file', toolArgs: {}, timestamp: 1003 },
        ];
        const summary = makeRunSummary(steps);
        expect(summary.topTools[0]!.name).to.equal('read_file');
        expect(summary.topTools[0]!.count).to.equal(3);
    });

    it('makeRunSummary handles undefined steps', () => {
        const summary = makeRunSummary(undefined);
        expect(summary.totalSteps).to.equal(0);
    });
});
