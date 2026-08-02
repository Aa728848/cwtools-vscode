import { expect } from 'chai';
import { buildCodexTurnModel } from '../../webview/chat/codexActivity';
import { renderAssistantTurnCodex } from '../../webview/chat/codexConversation';
import { renderCodexTurnItems } from '../../webview/chat/codexToolRows';
import { getChatI18n } from '../../webview/chat/i18n';

function build(steps: any[], content = '', locale: 'en' | 'zh-cn' = 'en') {
    const i18n = getChatI18n(locale);
    return buildCodexTurnModel(content, steps, { locale, labels: i18n.codex });
}

function buildLive(steps: any[], content = '', locale: 'en' | 'zh-cn' = 'en') {
    const i18n = getChatI18n(locale);
    return buildCodexTurnModel(content, steps, { locale, labels: i18n.codex, live: true });
}

function firstGroup(model: ReturnType<typeof build>, kind?: string) {
    const item = model.items.find(entry => entry.type === 'group' && (!kind || entry.group.kind === kind));
    expect(item?.type).to.equal('group');
    if (item?.type !== 'group') throw new Error('expected group');
    return item.group;
}

describe('Codex activity view model', () => {
    it('pairs run_command call and result with command details', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile', cwd: '/workspace' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true, exitCode: 0, stdout: 'ok' }, timestamp: 2500 },
        ]);

        expect(model.items[0]?.type).to.equal('text');
        const group = firstGroup(model, 'command');
        const event = group.events[0];
        expect(event?.kind).to.equal('command');
        expect(event?.status).to.equal('success');
        expect(event?.durationMs).to.equal(1500);
        expect(event?.subject).to.equal('');
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

        const group = firstGroup(model, 'command');
        expect(group.label).to.equal('Ran 2 commands');
        expect(group.events).to.have.lengthOf(2);
    });

    it('adds at most one synthetic process line when the model did not provide narration', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true }, timestamp: 1100 },
            { type: 'tool_call', toolName: 'read_file', invocationId: '2', toolArgs: { filePath: 'a.txt' }, timestamp: 1200 },
            { type: 'tool_result', toolName: 'read_file', invocationId: '2', toolResult: { success: true }, timestamp: 1300 },
        ]);

        expect(model.items.map(item => item.type)).to.deep.equal(['text', 'group']);
        expect(model.items[0]?.type === 'text' && model.items[0].text.source).to.equal('auto');
        expect(model.items[0]?.type === 'text' && model.items[0].text.content).to.include('running a command');
        expect(model.items.filter(item => item.type === 'text' && item.text.source === 'auto')).to.have.lengthOf(1);
    });

    it('collapses mixed consecutive activities into a single steps group', () => {
        const model = build([
            { type: 'thinking_content', content: 'Let me check the files.', timestamp: 1000 },
            { type: 'tool_call', toolName: 'read_file', invocationId: '1', toolArgs: { filePath: 'a.txt' }, timestamp: 1100 },
            { type: 'tool_result', toolName: 'read_file', invocationId: '1', toolResult: { success: true }, timestamp: 1200 },
            { type: 'tool_call', toolName: 'write_file', invocationId: '2', toolArgs: { filePath: 'b.txt' }, timestamp: 1300 },
            { type: 'tool_result', toolName: 'write_file', invocationId: '2', toolResult: { success: true }, timestamp: 1400 },
            { type: 'tool_call', toolName: 'run_command', invocationId: '3', toolArgs: { command: 'npm test' }, timestamp: 1500 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '3', toolResult: { success: true, exitCode: 0 }, timestamp: 2000 },
            { type: 'text_delta', content: 'All done.', timestamp: 2100 },
        ]);

        const groups = model.items.filter(item => item.type === 'group');
        expect(groups).to.have.lengthOf(1);
        const group = firstGroup(model, 'steps');
        expect(group.label).to.equal('Ran 4 steps');
        expect(group.events.map(event => event.groupKind)).to.deep.equal(['thinking', 'read', 'tool', 'command']);
        expect(group.status).to.equal('success');
        expect(model.items[model.items.length - 1]?.type).to.equal('text');
    });

    it('suppresses raw command output that would otherwise stream as transcript text', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'measure tech files' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true, stdout: 'Count : 293' }, timestamp: 1200 },
            { type: 'text_delta', content: 'Count : 293\nAverage :\nSum :\nMaximum :\nMinimum :\nProperty :', timestamp: 1300 },
        ]);

        expect(model.items.some(item => item.type === 'text' && item.text.content.includes('Count : 293'))).to.equal(false);
        expect(model.streamedText).to.equal('');
    });

    it('suppresses command stdout and stderr that arrive as thinking steps', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'python helper.py' }, timestamp: 1000 },
            { type: 'thinking', content: 'Traceback (most recent call last):\nUnicodeEncodeError: gbk codec failed', timestamp: 1100 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { exitCode: 1, stderr: 'Traceback (most recent call last):\nUnicodeEncodeError: gbk codec failed' }, timestamp: 1200 },
        ]);

        const visibleText = model.items
            .map(item => item.type === 'text' ? item.text.content : '')
            .join('\n');
        expect(visibleText).to.not.include('Traceback');
        expect(visibleText).to.not.include('UnicodeEncodeError');
        expect(firstGroup(model, 'command').status).to.equal('failed');
    });

    it('groups three consecutive read tools', () => {
        const model = build([
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'a.txt' }, timestamp: 1000 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'b.txt' }, timestamp: 1100 },
            { type: 'tool_call', toolName: 'read_file', toolArgs: { filePath: 'c.txt' }, timestamp: 1200 },
        ]);

        const group = firstGroup(model, 'read');
        expect(group.label).to.equal('Read 3 files');
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

    it('renders streamed reasoning_content as a collapsed thinking detail', () => {
        const model = build([
            { type: 'thinking_content', content: 'The', timestamp: 1000 },
            { type: 'thinking_content', content: ' user said', timestamp: 1001 },
            { type: 'thinking_content', content: ' hello.', timestamp: 1002 },
            { type: 'text_delta', content: '你好！', timestamp: 1100 },
        ]);

        const thinkingGroup = firstGroup(model, 'thinking');
        expect(thinkingGroup.label).to.equal('Thinking');
        expect(thinkingGroup.events[0]?.label).to.equal('Thinking');
        expect(thinkingGroup.events[0]?.status).to.equal('success');
        expect(thinkingGroup.events[0]?.detailModel?.preview).to.equal('The user said hello.');
        expect(model.items.some(item => item.type === 'text' && item.text.content.includes('user said'))).to.equal(false);
    });

    it('coalesces interleaved text and thinking deltas until the next activity boundary', () => {
        const model = build([
            { type: 'thinking_content', content: 'Checking ', timestamp: 1000 },
            { type: 'text_delta', content: 'Localisation ', timestamp: 1001 },
            { type: 'thinking_content', content: 'schema.', timestamp: 1002 },
            { type: 'text_delta', content: 'keys are valid.', timestamp: 1003 },
            { type: 'tool_call', toolName: 'read_file', invocationId: '1', toolArgs: { filePath: 'a.txt' }, timestamp: 1100 },
        ]);

        const thinkingGroup = firstGroup(model, 'thinking');
        expect(thinkingGroup.events).to.have.lengthOf(1);
        expect(thinkingGroup.events[0]?.detailModel?.preview).to.equal('Checking schema.');
        expect(model.streamedText).to.equal('Localisation keys are valid.');
        const streamedSegments = model.items.filter(item => item.type === 'text' && item.text.source === 'text_delta');
        expect(streamedSegments).to.have.lengthOf(1);
    });

    it('keeps only the active trailing thinking row running in live mode', () => {
        const stillThinking = buildLive([
            { type: 'thinking_content', content: 'Checking schema', timestamp: 1000 },
        ]);
        expect(firstGroup(stillThinking, 'thinking').events[0]?.status).to.equal('running');

        const movedOn = buildLive([
            { type: 'thinking_content', content: 'Checking schema', timestamp: 1000 },
            { type: 'tool_call', toolName: 'query_cwt_schema', invocationId: '1', toolArgs: { target: 'common/buildings' }, timestamp: 1100 },
        ]);
        const stepsGroup = firstGroup(movedOn, 'steps');
        const thinkingEvent = stepsGroup.events.find(event => event.groupKind === 'thinking');
        expect(thinkingEvent?.status).to.equal('success');
    });

    it('keeps a live activity group identity stable when it grows into mixed steps', () => {
        const initial = firstGroup(buildLive([
            { type: 'thinking_content', content: 'Checking schema', timestamp: 1000 },
        ]));
        const grown = firstGroup(buildLive([
            { type: 'thinking_content', content: 'Checking schema', timestamp: 1000 },
            { type: 'tool_call', toolName: 'query_cwt_schema', invocationId: '1', toolArgs: {}, timestamp: 1100 },
        ]));

        expect(initial.id.replace(/-\d+$/, '')).to.equal(grown.id.replace(/-\d+$/, ''));
        expect(initial.kind).to.equal('thinking');
        expect(grown.kind).to.equal('steps');
    });

    it('suppresses legacy tool truncation warnings from transcript text', () => {
        const warning = '[WARNING: The result of tool query_cwt_schema was automatically truncated to 1000 characters to prevent context window overflow (Original size was 48000 chars).]';
        const model = build([
            { type: 'tool_call', toolName: 'query_cwt_schema', invocationId: '1', toolArgs: { target: 'common/buildings' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'query_cwt_schema', invocationId: '1', toolResult: { ok: true }, timestamp: 1100 },
            { type: 'text_delta', content: warning, timestamp: 1200 },
        ]);

        const visibleText = model.items
            .map(item => item.type === 'text' ? item.text.content : '')
            .join('\n');
        expect(visibleText).to.not.include('automatically truncated to 1000');
    });

    it('suppresses internal tool-stage telemetry from visible process text', () => {
        const model = build([
            { type: 'thinking', content: 'Tool stage advanced: discovery -> validation (15 tools).', timestamp: 1000 },
            { type: 'tool_call', toolName: 'get_diagnostics', invocationId: '1', toolArgs: {}, timestamp: 1100 },
        ]);
        const visibleText = model.items
            .map(item => item.type === 'text' ? item.text.content : '')
            .join('\n');
        expect(visibleText).to.not.include('Tool stage advanced');
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

        const group = firstGroup(model, 'tool');
        expect(group.kind).to.equal('tool');
        expect(model.items.some(item => item.type === 'text' && item.text.content.includes('Tool Arg Repair'))).to.equal(false);
    });

    it('hides legacy authorized-execution recovery telemetry from the transcript', () => {
        const model = build([
            {
                type: 'thinking',
                content: 'Authorized execution continued automatically from write mode after a premature final response.',
                timestamp: 1000,
            },
        ]);

        expect(model.items.some(item => item.type === 'text'
            && item.text.content.includes('Authorized execution continued automatically'))).to.equal(false);
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

        const group = firstGroup(model, 'tool');
        expect(group.status).to.equal('waiting');
        expect(group.events[0]?.label).to.equal('Waiting for write confirmation');
        expect(group.events[0]?.subject).to.equal('chatPanel.css');
    });

    it('does not count permission requests as command activity rows', () => {
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'permission_request', toolName: 'run_command', invocationId: 'perm:1', toolArgs: { command: 'npm run compile' }, timestamp: 1050 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true }, timestamp: 1200 },
        ]);

        const group = firstGroup(model, 'command');
        expect(group.events).to.have.lengthOf(1);
        expect(group.events[0]?.label).to.equal('Ran command');
        expect(group.events.some(event => event.label === 'Waiting for permission')).to.equal(false);
    });

    it('renders tool activity and command output as collapsed details', () => {
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
        expect(html).to.include('codex-activity-row-collapsed');
        expect(html).to.include('data-codex-activity-row-toggle');
        expect(html).to.include('codex-activity-row-details');
        expect(html).to.include('stdout');
        expect(html).to.include('ok');
        expect(html).not.to.include('<span class="codex-activity-subject">npm run compile</span>');
        expect(html).not.to.include('<span class="codex-activity-detail">ok</span>');
    });

    it('keeps grouped status feedback on each tool row and out of the group summary', () => {
        const i18n = getChatI18n('en');
        const model = build([
            { type: 'tool_call', toolName: 'run_command', invocationId: '1', toolArgs: { command: 'npm run compile' }, timestamp: 1000 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '1', toolResult: { success: true, exitCode: 0 }, timestamp: 1200 },
            { type: 'tool_call', toolName: 'run_command', invocationId: '2', toolArgs: { command: 'npm run lint' }, timestamp: 1300 },
            { type: 'tool_result', toolName: 'run_command', invocationId: '2', toolResult: { success: false, exitCode: 1, error: 'lint failed' }, timestamp: 1500 },
        ]);
        const group = firstGroup(model, 'command');
        const html = renderCodexTurnItems(model.items, { labels: i18n.codex });
        const groupStart = html.indexOf('<div class="codex-activity-group');
        const childrenStart = html.indexOf('<div class="codex-activity-group-items">', groupStart);
        const groupSummary = html.slice(groupStart, childrenStart);

        expect(group.status).to.equal('failed');
        expect(groupSummary).not.to.include('codex-status-');
        expect(groupSummary).not.to.include('codex-activity-status');
        expect(html).to.include('codex-activity-command codex-status-success');
        expect(html).to.include('codex-activity-command codex-status-failed');
        expect(html.match(/class="codex-activity-status"/g)).to.have.lengthOf(2);
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
        expect(html).to.include('codex-auto-progress');
        expect(html).to.include('I am running a command to verify the current state');
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
        const group = firstGroup(model, 'command');
        expect(group.label).to.include('2');
    });

    it('styles streamed process text with msg-bubble like the final answer', () => {
        const i18n = getChatI18n('en');
        const model = build([
            { type: 'text_delta', content: '# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', timestamp: 1000 },
        ]);
        const html = renderCodexTurnItems(model.items, { labels: i18n.codex });

        expect(html).to.include('codex-process-text msg-bubble markdown-body');
    });
});
