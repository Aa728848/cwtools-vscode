import { expect } from 'chai';
import { buildCodexTurnModel } from '../../webview/chat/codexActivity';
import { renderAssistantTurnCodex } from '../../webview/chat/codexConversation';
import { renderCodexTurnItems } from '../../webview/chat/codexToolRows';
import { getChatI18n } from '../../webview/chat/i18n';

function build(steps: any[], content = '', locale: 'en' | 'zh-cn' = 'en') {
    const i18n = getChatI18n(locale);
    return buildCodexTurnModel(content, steps, { locale, labels: i18n.codex });
}

describe('Codex activity view model', () => {
    it('pairs run_command call and result with command details', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile', cwd: '/workspace' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true, exitCode: 0, stdout: 'ok' }, timestamp: 2500 },
        ]);

        const item = model.items[0];
        expect(item?.type).to.equal('group');
        if (item?.type !== 'group') throw new Error('expected group');
        const event = item.group.events[0];
        expect(event?.kind).to.equal('command');
        expect(event?.status).to.equal('success');
        expect(event?.durationMs).to.equal(1500);
        expect(event?.detailModel?.command?.command).to.equal('npm run compile');
        expect(event?.detailModel?.command?.exitCode).to.equal(0);
    });

    it('groups consecutive command activities', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', toolResult: { success: true }, timestamp: 1100 },
            { type: 'tool_call', toolName: 'run_command', toolArgs: { command: 'npm run lint' }, timestamp: 1200 },
            { type: 'tool_result', toolName: 'run_command', toolResult: { success: true }, timestamp: 1300 },
        ]);

        expect(model.items[0]?.type).to.equal('group');
        if (model.items[0]?.type !== 'group') throw new Error('expected group');
        expect(model.items[0].group.kind).to.equal('tool');
        expect(model.items[0].group.label).to.equal('Tool calls (2)');
        expect(model.items[0].group.events).to.have.lengthOf(2);
    });

    it('groups three consecutive read tools', () => {
        const model = build([
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'a.txt' }, timestamp: 1000 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'b.txt' }, timestamp: 1100 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'c.txt' }, timestamp: 1200 },
        ]);

        expect(model.items[0]?.type).to.equal('group');
        if (model.items[0]?.type !== 'group') throw new Error('expected group');
        expect(model.items[0].group.kind).to.equal('tool');
        expect(model.items[0].group.label).to.equal('Tool calls (3)');
    });

    it('keeps streamed text in transcript and removes duplicate final text', () => {
        const model = build([
            { type: 'text_delta', content: 'Done', timestamp: 1000 },
            { type: 'text_delta', content: ' now', timestamp: 1001 },
        ], 'Done now');

        expect(model.items[0]?.type).to.equal('text');
        expect(model.streamedText).to.equal('Done now');
        expect(model.finalText).to.equal('');
    });

    it('renders streamed thinking as a status-only activity row', () => {
        const model = build([
            { type: 'thinking_content', content: 'The', timestamp: 1000 },
            { type: 'thinking_content', content: ' user said', timestamp: 1001 },
            { type: 'thinking_content', content: ' hello.', timestamp: 1002 },
            { type: 'text_delta', content: '你好！', timestamp: 1100 },
        ]);

        expect(model.items).to.have.lengthOf(2);
        const thinking = model.items[0];
        expect(thinking?.type).to.equal('activity');
        if (thinking?.type !== 'activity') throw new Error('expected activity');
        expect(thinking.event.kind).to.equal('thinking');
        expect(thinking.event.detail).to.equal(undefined);
        expect(thinking.event.detailModel?.preview).to.equal('The user said hello.');
    });

    it('renders user-facing narrative thinking as process text between activity rows', () => {
        const model = build([
            { type: 'thinking', content: 'I will inspect the chat UI first.', timestamp: 1000 },
            { type: 'tool_call', toolName: 'run_command', toolArgs: { command: 'npm run compile' }, timestamp: 1100 },
        ]);

        expect(model.items[0]?.type).to.equal('text');
        if (model.items[0]?.type !== 'text') throw new Error('expected text');
        expect(model.items[0].text.source).to.equal('message');
        expect(model.items[0].text.content).to.equal('I will inspect the chat UI first.');
    });

    it('filters internal repair notes out of process text', () => {
        const model = build([
            { type: 'thinking', content: '[Tool Arg Repair] Nested schema reconstructed', timestamp: 1000 },
            { type: 'tool_call', toolName: 'query_references', invocationId: '1', toolArgs: { query: 'foo' }, timestamp: 1100 },
        ]);

        expect(model.items[0]?.type).to.equal('activity');
        if (model.items[0]?.type !== 'activity') throw new Error('expected thinking activity');
        expect(model.items[0].event.kind).to.equal('thinking');
        expect(model.items.some(item => item.type === 'text' && item.text.content.includes('Tool Arg Repair'))).to.equal(false);
    });

    it('hides prefix cache stats from the transcript', () => {
        const model = build([
            {
                type: 'cache_stats',
                cacheStats: {
                    cachedTokens: 28672,
                    totalTokens: 32366,
                    hitRate: 0.8858678860532657,
                    savedCostCny: 0.0853020672,
                    cacheCreationTokens: 3694,
                },
                timestamp: 1000,
            },
        ]);

        expect(model.items).to.have.lengthOf(0);
    });

    it('renders pending write confirmation as a waiting activity', () => {
        const model = build([
            {
                type: 'write_confirmation_request',
                toolName: 'write_file',
                invocationId: 'write:1',
                toolArgs: { filePath: 'client/webview/chatPanel.css' },
                timestamp: 1000,
            },
        ]);

        const item = model.items[0];
        expect(item?.type).to.equal('group');
        if (item?.type !== 'group') throw new Error('expected group');
        expect(item.group.kind).to.equal('tool');
        expect(item.group.status).to.equal('waiting');
        expect(item.group.events[0]?.label).to.equal('Waiting for write confirmation');
        expect(item.group.events[0]?.subject).to.equal('chatPanel.css');
    });

    it('renders tool activity as a collapsed grouped card', () => {
        const i18n = getChatI18n('en');
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true, stdout: 'ok' }, timestamp: 1500 },
        ]);
        const html = renderCodexTurnItems(model.items, { labels: i18n.codex });

        expect(html).to.include('codex-activity-group');
        expect(html).to.include('codex-activity-group-collapsed');
        expect(html).to.include('data-codex-activity-group-toggle');
        expect(html).to.include('aria-expanded="false"');
        expect(html).to.include('codex-activity-group-items');
        expect(html).to.include('codex-activity-row');
        expect(html).not.to.include('<details');
        expect(html).not.to.include('<summary');
        expect(html).not.to.include('codex-activity-details');
        expect(html).not.to.include('codex-command-details');
    });

    it('renders assistant turns with a collapsible status control', () => {
        const i18n = getChatI18n('en');
        const html = renderAssistantTurnCodex('Done', [
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true }, timestamp: 1500 },
        ], {
            i18n,
            renderMarkdown: content => content,
        });

        expect(html).to.include('data-codex-turn-toggle');
        expect(html).to.include('aria-expanded="true"');
        expect(html).to.include('codex-assistant-body');
        expect(html).to.include('codex-final-answer');
    });

    it('uses Chinese labels for summary and tool groups', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', toolResult: { success: true }, timestamp: 1500 },
            { type: 'tool_call', toolName: 'run_command', toolArgs: { command: 'npm run lint' }, timestamp: 2000 },
            { type: 'tool_result', toolName: 'run_command', toolResult: { success: true }, timestamp: 2500 },
        ], '', 'zh-cn');

        expect(model.summary.label).to.include('已处理');
        expect(model.items[0]?.type).to.equal('group');
        if (model.items[0]?.type !== 'group') throw new Error('expected group');
        expect(model.items[0].group.label).to.equal('工具调用（2）');
    });
});
