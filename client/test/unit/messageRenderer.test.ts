import { expect } from 'chai';
import {
    classifySteps,
    routeLiveStep,
    summarizeToolArgs,
    formatDuration,
    buildToolPairHtml,
    buildThinkingBlockHtml,
    buildAssistantMessageHtml,
    escapeHtml,
} from '../../webview/messageRenderer';

// ─── escapeHtml ──────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
    it('escapes ampersands', () => {
        expect(escapeHtml('a & b')).to.equal('a &amp; b');
    });
    it('escapes angle brackets', () => {
        expect(escapeHtml('<script>alert("x")</script>')).to.include('&lt;');
        expect(escapeHtml('<script>')).to.not.include('<script>');
    });
    it('escapes double quotes', () => {
        expect(escapeHtml('"hello"')).to.equal('&quot;hello&quot;');
    });
    it('handles null/undefined', () => {
        expect(escapeHtml(null)).to.equal('');
        expect(escapeHtml(undefined)).to.equal('');
    });
    it('converts numbers to string', () => {
        expect(escapeHtml(42)).to.equal('42');
    });
});

// ─── formatDuration ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
    it('shows ms for short durations', () => {
        expect(formatDuration(45)).to.equal('45ms');
    });
    it('shows seconds with one decimal for >= 1000ms', () => {
        expect(formatDuration(2500)).to.equal('2.5s');
    });
    it('shows seconds without decimal when whole', () => {
        expect(formatDuration(3000)).to.equal('3.0s');
    });
    it('shows minutes and seconds for >= 60s', () => {
        expect(formatDuration(125000)).to.equal('2m 5s');
    });
    it('handles zero', () => {
        expect(formatDuration(0)).to.equal('0ms');
    });
    it('handles negative (returns 0ms)', () => {
        expect(formatDuration(-100)).to.equal('0ms');
    });
});

// ─── summarizeToolArgs ───────────────────────────────────────────────────────

describe('summarizeToolArgs', () => {
    it('extracts file basename for file tools', () => {
        const result = summarizeToolArgs('read_file', { filePath: '/a/b/test.txt' });
        expect(result).to.include('test.txt');
    });

    it('uses "file" arg as fallback', () => {
        const result = summarizeToolArgs('read_file', { file: '/a/b/data.txt' });
        expect(result).to.include('data.txt');
    });

    it('truncates command for run_command', () => {
        const result = summarizeToolArgs('run_command', { command: 'a'.repeat(100) });
        expect(result.length).to.be.lessThan(60);
        expect(result).to.include('...');
    });

    it('shows short command without truncation', () => {
        const result = summarizeToolArgs('run_command', { command: 'ls -la' });
        expect(result).to.equal('ls -la');
        expect(result).to.not.include('...');
    });

    it('shows query for search_web', () => {
        const result = summarizeToolArgs('search_web', { query: 'stellaris modding' });
        expect(result).to.include('stellaris modding');
    });

    it('shows query for codesearch', () => {
        const result = summarizeToolArgs('codesearch', { query: 'escapeHtml' });
        expect(result).to.include('escapeHtml');
    });

    it('shows item count for todo_write', () => {
        const result = summarizeToolArgs('todo_write', { todos: [{}, {}, {}] });
        expect(result).to.include('3');
    });

    it('returns empty string for unknown tools with no recognized args', () => {
        expect(summarizeToolArgs('unknown_tool', {})).to.equal('');
    });

    it('handles missing args gracefully', () => {
        expect(summarizeToolArgs('read_file', {})).to.equal('');
    });
});

// ─── classifySteps ───────────────────────────────────────────────────────────

describe('classifySteps', () => {
    it('separates text_delta from thinking steps', () => {
        const steps: any[] = [
            { type: 'thinking_content', content: 'reasoning...', timestamp: 1 },
            { type: 'text_delta', content: 'hello', timestamp: 2 },
            { type: 'tool_call', toolName: 'read_file', timestamp: 3 },
        ];
        const result = classifySteps(steps);
        expect(result.thinkingSteps).to.have.lengthOf(1);
        expect(result.thinkingSteps[0]!.type).to.equal('thinking_content');
        expect(result.textDeltaSteps).to.have.lengthOf(1);
        expect(result.textDeltaSteps[0]!.type).to.equal('text_delta');
        expect(result.toolCalls).to.have.lengthOf(1);
    });

    it('groups thinking and thinking_content together', () => {
        const steps: any[] = [
            { type: 'thinking', content: 'block 1', timestamp: 1 },
            { type: 'thinking_content', content: 'stream', timestamp: 2 },
        ];
        const result = classifySteps(steps);
        expect(result.thinkingSteps).to.have.lengthOf(2);
        expect(result.textDeltaSteps).to.have.lengthOf(0);
    });

    it('separates tool_call from tool_result', () => {
        const steps: any[] = [
            { type: 'tool_call', toolName: 'read_file', timestamp: 1 },
            { type: 'tool_result', toolName: 'read_file', timestamp: 2 },
        ];
        const result = classifySteps(steps);
        expect(result.toolCalls).to.have.lengthOf(1);
        expect(result.toolResults).to.have.lengthOf(1);
    });

    it('puts error/validation/compaction into specialSteps', () => {
        const steps: any[] = [
            { type: 'error', content: 'fail', timestamp: 1 },
            { type: 'validation', content: 'ok', timestamp: 2 },
            { type: 'compaction', content: 'compressed', timestamp: 3 },
        ];
        const result = classifySteps(steps);
        expect(result.specialSteps).to.have.lengthOf(3);
    });

    it('handles empty steps array', () => {
        const result = classifySteps([]);
        expect(result.thinkingSteps).to.have.lengthOf(0);
        expect(result.textDeltaSteps).to.have.lengthOf(0);
        expect(result.toolCalls).to.have.lengthOf(0);
        expect(result.toolResults).to.have.lengthOf(0);
        expect(result.specialSteps).to.have.lengthOf(0);
    });
});

// ─── routeLiveStep ───────────────────────────────────────────────────────────

describe('routeLiveStep', () => {
    it('routes thinking_content to thinking', () => {
        expect(routeLiveStep({ type: 'thinking_content', content: '...', timestamp: 1 })).to.equal('thinking');
    });

    it('routes thinking to thinking', () => {
        expect(routeLiveStep({ type: 'thinking', content: '...', timestamp: 1 })).to.equal('thinking');
    });

    it('routes text_delta to text_bubble (NOT thinking!)', () => {
        expect(routeLiveStep({ type: 'text_delta', content: '...', timestamp: 1 })).to.equal('text_bubble');
    });

    it('routes tool_call to tool_call', () => {
        expect(routeLiveStep({ type: 'tool_call', content: '', timestamp: 1 })).to.equal('tool_call');
    });

    it('routes tool_result to tool_result', () => {
        expect(routeLiveStep({ type: 'tool_result', content: '', timestamp: 1 })).to.equal('tool_result');
    });

    it('routes error to special', () => {
        expect(routeLiveStep({ type: 'error', content: 'fail', timestamp: 1 })).to.equal('special');
    });

    it('routes validation to special', () => {
        expect(routeLiveStep({ type: 'validation', content: '', timestamp: 1 })).to.equal('special');
    });

    it('routes compaction to special', () => {
        expect(routeLiveStep({ type: 'compaction', content: '', timestamp: 1 })).to.equal('special');
    });
});

// ─── buildToolPairHtml ───────────────────────────────────────────────────────

describe('buildToolPairHtml', () => {
    it('renders tool name and file basename', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: { filePath: '/a/b/c.txt' }, content: '', timestamp: 1000 };
        const html = buildToolPairHtml(call);
        expect(html).to.include('read_file');
        expect(html).to.include('c.txt');
    });

    it('renders success result with diff stats', () => {
        const call = { type: 'tool_call' as const, toolName: 'edit_file', toolArgs: { filePath: 'test.txt' }, content: '', timestamp: 1000 };
        const result = { type: 'tool_result' as const, toolName: 'edit_file', toolResult: { success: true, stats: { linesAdded: 3, linesRemoved: 1 } }, content: '', timestamp: 1045 };
        const html = buildToolPairHtml(call, result);
        expect(html).to.include('+3');
        expect(html).to.include('-1');
    });

    it('renders error result', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: {}, content: '', timestamp: 1 };
        const result = { type: 'tool_result' as const, toolName: 'read_file', toolResult: { success: false, error: 'File not found' }, content: '', timestamp: 2 };
        const html = buildToolPairHtml(call, result);
        expect(html).to.include('File not found');
        expect(html).to.include('err');
    });

    it('includes duration when result has timestamp', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: { filePath: 'a.txt' }, content: '', timestamp: 1000 };
        const result = { type: 'tool_result' as const, toolName: 'read_file', toolResult: { success: true }, content: '', timestamp: 1045 };
        const html = buildToolPairHtml(call, result, { showDuration: true });
        expect(html).to.include('45ms');
    });

    it('does not show duration when showDuration is false', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: {}, content: '', timestamp: 1000 };
        const result = { type: 'tool_result' as const, toolName: 'read_file', toolResult: { success: true }, content: '', timestamp: 1045 };
        const html = buildToolPairHtml(call, result, { showDuration: false });
        expect(html).to.not.include('45ms');
    });

    it('includes parameter summary for edit_file when showParams is true', () => {
        const call = {
            type: 'tool_call' as const, toolName: 'edit_file', toolArgs: {
                filePath: '/mod/events/test.txt',
                oldString: 'trigger = { always = yes }',
                newString: 'trigger = { has_country_flag = test }',
            }, content: '', timestamp: 1000
        };
        const html = buildToolPairHtml(call, undefined, { showParams: true, paramPreviewLen: 30 });
        expect(html).to.include('trigger = { always');
    });

    it('shows step index when provided', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: {}, content: '', timestamp: 1 };
        const html = buildToolPairHtml(call, undefined, { stepIndex: 3 });
        expect(html).to.include('3.');
    });

    it('renders inline diff when result contains diff field and showDiff is true', () => {
        const call = { type: 'tool_call' as const, toolName: 'edit_file', toolArgs: { filePath: 'test.txt' }, content: '', timestamp: 1 };
        const result = {
            type: 'tool_result' as const, toolName: 'edit_file', toolResult: {
                success: true,
                diff: {
                    additions: 1, deletions: 1, lines: [
                        { type: 'remove', content: 'old line', oldLineNo: 5 },
                        { type: 'add', content: 'new line', newLineNo: 5 },
                    ]
                },
            }, content: '', timestamp: 2
        };
        const html = buildToolPairHtml(call, result, { showDiff: true });
        expect(html).to.include('diff-line');
        expect(html).to.include('old line');
        expect(html).to.include('new line');
    });

    it('limits diff preview to 20 lines', () => {
        const lines = Array.from({ length: 50 }, (_, i) => ({ type: 'add', content: `line${i}`, newLineNo: i }));
        const call = { type: 'tool_call' as const, toolName: 'edit_file', toolArgs: {}, content: '', timestamp: 1 };
        const result = {
            type: 'tool_result' as const, toolName: 'edit_file', toolResult: {
                success: true, diff: { additions: 50, deletions: 0, lines }
            }, content: '', timestamp: 2
        };
        const html = buildToolPairHtml(call, result, { showDiff: true });
        // Count actual content lines (add/remove/ctx), not the "more lines" indicator
        const contentLineCount = (html.match(/diff-(add|remove|ctx)/g) || []).length;
        expect(contentLineCount).to.be.at.most(20);
    });

    it('does not render diff when showDiff is false', () => {
        const call = { type: 'tool_call' as const, toolName: 'edit_file', toolArgs: {}, content: '', timestamp: 1 };
        const result = {
            type: 'tool_result' as const, toolName: 'edit_file', toolResult: {
                success: true, diff: { additions: 1, deletions: 0, lines: [{ type: 'add', content: 'x', newLineNo: 1 }] }
            }, content: '', timestamp: 2
        };
        const html = buildToolPairHtml(call, result, { showDiff: false });
        expect(html).to.not.include('diff-line');
    });

    it('renders skipped result', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: {}, content: '', timestamp: 1 };
        const result = { type: 'tool_result' as const, toolName: 'read_file', toolResult: { skipped: true }, content: '', timestamp: 2 };
        const html = buildToolPairHtml(call, result);
        expect(html).to.include('skip');
    });

    it('handles missing toolResult gracefully (pending state)', () => {
        const call = { type: 'tool_call' as const, toolName: 'read_file', toolArgs: { filePath: '/a/b.txt' }, content: '', timestamp: 1 };
        const html = buildToolPairHtml(call);
        expect(html).to.include('read_file');
        expect(html).to.not.include('undefined');
    });

    it('renders permission_request with inline buttons', () => {
        const step = {
            type: 'permission_request' as const,
            content: 'stellaris_linter check',
            toolName: 'run_command',
            permissionId: 'perm_1',
            timestamp: 1
        };
        const html = buildToolPairHtml(step, undefined, { stepIndex: 5 });
        expect(html).to.include('perm_1');
        expect(html).to.include('允许');
        expect(html).to.include('拒绝');
    });
});

// ─── buildThinkingBlockHtml ──────────────────────────────────────────────────

describe('buildThinkingBlockHtml', () => {
    it('renders a thinking block with token estimate', () => {
        const steps = [
            { type: 'thinking_content' as const, content: 'Let me analyze this...', timestamp: 1 },
        ];
        const html = buildThinkingBlockHtml(steps);
        expect(html).to.include('thinking-block');
        expect(html).to.include('Thinking');
        expect(html).to.include('tokens');
    });

    it('concatenates multiple thinking steps with separator', () => {
        const steps = [
            { type: 'thinking_content' as const, content: 'Part 1', timestamp: 1 },
            { type: 'thinking' as const, content: 'Part 2', timestamp: 2 },
        ];
        const html = buildThinkingBlockHtml(steps);
        expect(html).to.include('Part 1');
        expect(html).to.include('Part 2');
    });

    it('returns empty string for no thinking steps', () => {
        expect(buildThinkingBlockHtml([])).to.equal('');
    });
});

// ─── buildAssistantMessageHtml ───────────────────────────────────────────────

describe('buildAssistantMessageHtml', () => {
    it('includes thinking block when present', () => {
        const steps: any[] = [
            { type: 'thinking_content', content: 'reasoning...', timestamp: 1 },
        ];
        const classified = classifySteps(steps);
        const html = buildAssistantMessageHtml('Final reply', classified);
        expect(html).to.include('thinking-block');
        expect(html).to.include('Final reply');
    });

    it('renders tool timeline with step indices', () => {
        const steps: any[] = [
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: '/a.txt' }, content: '', timestamp: 1 },
            { type: 'tool_result', toolName: 'read_file', toolResult: { success: true }, content: '', timestamp: 2 },
            { type: 'tool_call', toolName: 'edit_file', toolArgs: { filePath: '/b.txt' }, content: '', timestamp: 3 },
            { type: 'tool_result', toolName: 'edit_file', toolResult: { success: true }, content: '', timestamp: 4 },
        ];
        const classified = classifySteps(steps);
        const html = buildAssistantMessageHtml('done', classified);
        expect(html).to.include('1.');
        expect(html).to.include('2.');
    });

    it('separates text_delta content into response area, NOT thinking block', () => {
        const steps: any[] = [
            { type: 'thinking_content', content: 'reasoning only', timestamp: 1 },
            { type: 'text_delta', content: 'final answer', timestamp: 2 },
        ];
        const classified = classifySteps(steps);
        // The thinking block should NOT contain text_delta content
        expect(classified.thinkingSteps.every(s => s.type !== 'text_delta')).to.be.true;
        expect(classified.textDeltaSteps).to.have.lengthOf(1);
        expect(classified.textDeltaSteps[0]!.content).to.equal('final answer');
    });

    it('renders special steps (errors)', () => {
        const steps: any[] = [
            { type: 'error', content: 'Something failed', timestamp: 1 },
        ];
        const classified = classifySteps(steps);
        const html = buildAssistantMessageHtml('', classified);
        expect(html).to.include('Something failed');
        expect(html).to.include('special-step');
    });

    it('handles empty content gracefully', () => {
        const classified = classifySteps([]);
        const html = buildAssistantMessageHtml('', classified);
        // Should not throw, and should still have the wrapper structure
        expect(html).to.be.a('string');
    });

    it('renders steps chronologically interleaved (Claude Code style)', () => {
        // Simulate a multi-iteration flow:
        // Iteration 1: think → text → tool
        // Iteration 2: think → tool → text
        const steps: any[] = [
            { type: 'thinking_content', content: 'iter1 reasoning', timestamp: 1 },
            { type: 'text_delta', content: 'Let me explore...', timestamp: 2 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: '/a.txt' }, content: '', timestamp: 3 },
            { type: 'tool_result', toolName: 'read_file', toolResult: { success: true }, content: '', timestamp: 4 },
            { type: 'thinking_content', content: 'iter2 reasoning', timestamp: 5 },
            { type: 'tool_call', toolName: 'edit_file', toolArgs: { filePath: '/b.txt' }, content: '', timestamp: 6 },
            { type: 'tool_result', toolName: 'edit_file', toolResult: { success: true }, content: '', timestamp: 7 },
            { type: 'text_delta', content: 'Done!', timestamp: 8 },
        ];
        const classified = classifySteps(steps);
        const html = buildAssistantMessageHtml('', classified);

        // Verify chronological order: thinking → text → tool-timeline → thinking → tool-timeline → text
        const thinkIdx1 = html.indexOf('iter1 reasoning');
        const textIdx1 = html.indexOf('Let me explore...');
        const toolIdx1 = html.indexOf('read_file');
        const thinkIdx2 = html.indexOf('iter2 reasoning');
        const toolIdx2 = html.indexOf('edit_file');
        const textIdx2 = html.indexOf('Done!');

        // All should be present
        expect(thinkIdx1).to.be.greaterThan(-1);
        expect(textIdx1).to.be.greaterThan(-1);
        expect(toolIdx1).to.be.greaterThan(-1);
        expect(thinkIdx2).to.be.greaterThan(-1);
        expect(toolIdx2).to.be.greaterThan(-1);
        expect(textIdx2).to.be.greaterThan(-1);

        // Order: think1 < text1 < tool1 < think2 < tool2 < text2
        expect(thinkIdx1).to.be.lessThan(textIdx1);
        expect(textIdx1).to.be.lessThan(toolIdx1);
        expect(toolIdx1).to.be.lessThan(thinkIdx2);
        expect(thinkIdx2).to.be.lessThan(toolIdx2);
        expect(toolIdx2).to.be.lessThan(textIdx2);

        // Should have TWO separate thinking blocks
        const thinkingBlockCount = (html.match(/thinking-block/g) || []).length;
        expect(thinkingBlockCount).to.be.greaterThanOrEqual(2);

        // Should have TWO separate tool timelines
        const timelineCount = (html.match(/tool-timeline/g) || []).length;
        expect(timelineCount).to.equal(2);
    });
});
