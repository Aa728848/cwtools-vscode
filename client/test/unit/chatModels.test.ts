import { expect } from 'chai';
import {
    artifactPreviewPayload,
    artifactFileStatusTone,
    filterArtifacts,
    formatArtifactFileDelta,
    formatArtifactFileStats,
    formatArtifactFileStatusLabel,
    restoreArtifactsFromMessages,
    sortArtifactsByNewest,
    type ArtifactRecord,
} from '../../webview/chat/artifacts';
import { renderArtifactEmpty, renderArtifactFileCardHtml, renderArtifactRowHtml } from '../../webview/chat/artifactDrawer';
import {
    buildTopicSummaryModel,
    formatTopicMoment,
    groupTopicsByDate,
    shortenText,
    type TopicPanelItem,
} from '../../webview/chat/topics';
import { buildSubagentCardHtml, buildSubagentMetaHtml, hasVisibleLiveContent, latestLiveToolName, pushBoundedWebviewLiveStep, reactivateSubagentStreamState } from '../../webview/chat/liveSteps';
import { buildSettingsOverviewModel, resolveSettingsModelContextTokens } from '../../webview/chat/settingsOverview';
import { buildCodexQuotaHtml } from '../../webview/chat/codexQuota';
import { getChatI18n } from '../../webview/chat/i18n';
import { renderMarkdown } from '../../webview/chat/markdown';
import { mentionResultToActiveContext, stripConsumedMentionText, type ActiveContext } from '../../webview/chat/contextMentions';
import {
    buildUserMessagePresentation,
    LONG_USER_MESSAGE_CHARACTER_THRESHOLD,
    LONG_USER_MESSAGE_LINE_THRESHOLD,
} from '../../webview/chat/userMessagePresentation';
import { buildSlashCommands, filterSlashCommands, getSlashCommandFilter, renderSlashCommandItems } from '../../webview/chat/slashCommands';
import { getSlashCommandDescriptors, resolveSlashCommand, suggestSlashCommands } from '../../extension/ai/slashCommands';
import { buildWorkflowSummary, getWorkflowSlashCommand, normalizeWorkflowLabels, type WorkflowView } from '../../webview/chat/workflows';
import { buildExploreModeSystemPrompt, buildPlanModeSystemPrompt } from '../../extension/ai/prompt/sections/modePrompts';

describe('long user message presentation', () => {
    it('keeps ordinary messages inline', () => {
        expect(buildUserMessagePresentation('short\nmessage')).to.deep.equal({
            isLong: false,
            lineCount: 2,
            characterCount: 13,
            preview: 'short\nmessage',
        });
    });

    it('bounds long-running live Webview steps and merges adjacent stream deltas', () => {
        const steps: Array<Record<string, unknown>> = [];
        pushBoundedWebviewLiveStep(steps, { type: 'thinking_content', content: 'a', agentId: 'child' }, 4);
        expect(pushBoundedWebviewLiveStep(steps, { type: 'thinking_content', content: 'b', agentId: 'child' }, 4)).to.equal(true);
        expect(steps[0]!.content).to.equal('ab');
        for (let i = 0; i < 10; i++) {
            pushBoundedWebviewLiveStep(steps, { type: 'tool_call', toolName: 'read_file', invocationId: `call-${i}` }, 4);
        }
        expect(steps).to.have.length(4);
        expect(steps.map(step => step.invocationId)).to.deep.equal(['call-6', 'call-7', 'call-8', 'call-9']);
    });

    it('reactivates a completed subagent when a new subtask run starts', () => {
        const state = {
            liveSteps: [],
            startedAt: 10,
            lastStepAt: 20,
            completedAt: 30,
            isComplete: true,
            subtaskStatus: 'completed',
        };
        expect(reactivateSubagentStreamState(state, 'tool_call', 100)).to.equal(false);
        expect(state.isComplete).to.equal(true);
        expect(reactivateSubagentStreamState(state, 'subtask_start', 100)).to.equal(true);
        expect(state).to.deep.include({
            startedAt: 100,
            lastStepAt: 100,
            completedAt: null,
            isComplete: false,
            subtaskStatus: null,
        });
    });

    it('collapses long single-paragraph input and bounds its preview', () => {
        const presentation = buildUserMessagePresentation('a'.repeat(LONG_USER_MESSAGE_CHARACTER_THRESHOLD));
        expect(presentation.isLong).to.equal(true);
        expect(presentation.lineCount).to.equal(1);
        expect(presentation.preview.endsWith('…')).to.equal(true);
        expect(presentation.preview.length).to.be.lessThan(LONG_USER_MESSAGE_CHARACTER_THRESHOLD);
    });

    it('collapses pasted multi-line input and normalizes CRLF for line counting', () => {
        const text = Array.from({ length: LONG_USER_MESSAGE_LINE_THRESHOLD }, (_, index) => `line ${index + 1}`).join('\r\n');
        const presentation = buildUserMessagePresentation(text);
        expect(presentation.isLong).to.equal(true);
        expect(presentation.lineCount).to.equal(LONG_USER_MESSAGE_LINE_THRESHOLD);
        expect(presentation.preview).to.equal('line 1\nline 2\nline 3\nline 4\nline 5\n…');
    });
});

describe('settings model context resolution', () => {
    const contexts = {
        'gpt-5.6-sol': 1050000,
        'codex-chatgpt:gpt-5.6-sol': 272000,
    };

    it('prefers provider-scoped Codex metadata over the public API value', () => {
        expect(resolveSettingsModelContextTokens('gpt-5.6-sol', 'codex-chatgpt', contexts, 272000))
            .to.equal(272000);
        expect(resolveSettingsModelContextTokens('gpt-5.6-sol', 'openai', contexts, 1050000))
            .to.equal(1050000);
    });

    it('supports provider-scoped prefix matching and provider fallback', () => {
        expect(resolveSettingsModelContextTokens('gpt-5.6-sol-preview', 'codex-chatgpt', contexts, 272000))
            .to.equal(272000);
        expect(resolveSettingsModelContextTokens('unknown-model', 'codex-chatgpt', contexts, 272000))
            .to.equal(272000);
    });
});

describe('Codex quota presentation', () => {
    it('renders sanitized usage windows as accessible progress bars', () => {
        const html = buildCodexQuotaHtml([{
            limitName: 'Codex <main>',
            primary: {
                usedPercent: 72.4,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
            },
        }], {
            used: 'used',
            remaining: 'remaining',
            resets: 'Resets',
            window: 'Window',
            weekly: 'Weekly limit',
            unknownReset: 'unknown',
            unavailable: 'unavailable',
        }, 'en');

        expect(html).to.include('role="progressbar"');
        expect(html).to.include('aria-valuenow="72"');
        expect(html).to.include('style="width:72%"');
        expect(html).to.include('codex-quota-fill-warning');
        expect(html).to.include('Codex &lt;main&gt; · 5h');
        expect(html).to.include('28% remaining');
        expect(html).to.not.include('Codex <main>');
    });

    it('names the seven-day Codex window as the weekly limit', () => {
        const html = buildCodexQuotaHtml([{
            limitName: 'Codex',
            secondary: { usedPercent: 6, windowDurationMins: 7 * 24 * 60 },
        }], {
            used: '已用',
            remaining: '剩余',
            resets: '重置',
            window: '窗口',
            weekly: '周额度',
            unknownReset: '重置时间未知',
            unavailable: '额度不可用',
        }, 'zh-CN');

        expect(html).to.include('>周额度<');
        expect(html).to.not.include('Codex · 周额度');
        expect(html).to.not.include('Codex · 7d');
    });
});

describe('chat artifact model helpers', () => {
    const artifacts: ArtifactRecord[] = [
        { id: 'a', kind: 'plan', title: 'Plan', createdAt: 1 },
        { id: 'b', kind: 'diff', title: 'Diff', createdAt: 3 },
        { id: 'c', kind: 'diagnostics', title: 'Diagnostics', createdAt: 2 },
    ];

    it('filters artifacts by drawer tab', () => {
        expect(filterArtifacts(artifacts, 'plan').map(a => a.id)).to.deep.equal(['a']);
        expect(filterArtifacts(artifacts, 'diff').map(a => a.id)).to.deep.equal(['b']);
        expect(filterArtifacts(artifacts, 'validation').map(a => a.id)).to.deep.equal(['c']);
    });

    it('sorts artifacts newest first', () => {
        expect(sortArtifactsByNewest(artifacts).map(a => a.id)).to.deep.equal(['b', 'c', 'a']);
    });

    it('builds fallback artifact preview payload', () => {
        expect(artifactPreviewPayload({ id: 'x', kind: 'plan', title: 'T', summary: 'S', createdAt: 1 }))
            .to.deep.include({ title: 'T', summary: 'S', status: 'done' });
    });

    it('formats diff file stats', () => {
        expect(formatArtifactFileStats({ file: 'common/a.txt', status: 'modified', additions: 2, deletions: 1 }))
            .to.equal('modified | +2 -1');
        expect(formatArtifactFileDelta({ file: 'common/a.txt', additions: 2, deletions: 1 }))
            .to.equal('+2 -1');
        expect(formatArtifactFileStatusLabel('created')).to.equal('NEW');
        expect(formatArtifactFileStatusLabel('modified')).to.equal('MOD');
        expect(formatArtifactFileStatusLabel('deleted')).to.equal('DEL');
        expect(artifactFileStatusTone('deleted')).to.equal('deleted');
    });

    it('renders diff file cards with Codex-style status and line counts', () => {
        const card = renderArtifactFileCardHtml({ file: 'common/foo.txt', status: 'created', additions: 34, deletions: 2 });

        expect(card).to.include('artifact-file-status-created');
        expect(card).to.include('NEW');
        expect(card).to.include('artifact-file-additions">+34');
        expect(card).to.include('artifact-file-deletions">-2');
        expect(card).to.include('foo.txt');
    });

    it('restores artifact records from history steps', () => {
        const restored = restoreArtifactsFromMessages([
            {
                timestamp: 10,
                steps: [
                    { type: 'plan_card', content: 'plan.md', timestamp: 11 },
                    { toolName: 'get_diagnostics', toolResult: { ok: true }, timestamp: 12 },
                ],
            },
        ]);
        expect(restored.map(a => a.kind)).to.deep.equal(['diagnostics', 'plan']);
    });

    it('renders artifact drawer HTML with localized states', () => {
        const i18n = getChatI18n('en');
        const row = renderArtifactRowHtml({ id: 'diff', kind: 'diff', title: '<Diff>', status: 'done', createdAt: 1 }, i18n);

        expect(renderArtifactEmpty('None', 'Later')).to.include('artifact-empty-title');
        expect(row).to.include('&lt;Diff&gt;');
        expect(row).to.include('done');
    });
});

describe('chat topic model helpers', () => {
    const now = Date.UTC(2026, 4, 17, 12, 0, 0);
    const topics: TopicPanelItem[] = [
        { id: 'today', title: 'Today topic', updatedAt: now - 1000 },
        { id: 'old', title: 'Older topic', updatedAt: now - 9 * 86400000 },
    ];

    it('groups topics by age bucket', () => {
        const groups = groupTopicsByDate(topics, now);
        expect(groups[0]!.label).to.equal('Today');
        expect(groups[0]!.items[0]!.id).to.equal('today');
        expect(groups.at(-1)!.items[0]!.id).to.equal('old');
    });

    it('shortens long labels', () => {
        expect(shortenText('abcdef', 4)).to.equal('abc...');
    });

    it('formats moments through an injected time formatter', () => {
        expect(formatTopicMoment(now, () => '12:00', new Date(now))).to.equal('Today 12:00');
    });

    it('builds a summary model for topic panel headers', () => {
        const summary = buildTopicSummaryModel('list', topics, { total: 2, visible: 2, archived: 0, currentTopicId: 'today' });
        expect(summary.currentLabel).to.include('Today topic');
        expect(summary.visibleCount).to.equal(2);
    });
});

describe('chat workflow model helpers', () => {
    const workflow: WorkflowView = {
        id: 'diagnostic-fix',
        title: 'Diagnostic Fix',
        description: 'Fix diagnostics',
        mode: 'build',
        phases: [{ id: 'collect', title: 'Collect' }],
        verification: [{ id: 'zero', description: 'No errors', required: true }],
    };

    it('summarizes workflow metadata', () => {
        expect(buildWorkflowSummary(workflow)).to.include('Diagnostic Fix');
        expect(buildWorkflowSummary(workflow)).to.include('1 phase');
    });

    it('builds workflow slash commands', () => {
        expect(getWorkflowSlashCommand('diagnostic-fix')).to.equal('/workflow:diagnostic-fix');
    });

    it('builds localized workflow summaries', () => {
        const labels = normalizeWorkflowLabels({
            noWorkflowSelected: '未选择工作流',
            phaseUnit: '阶段',
            phasesUnit: '阶段',
            requiredCheckUnit: '必需检查',
            requiredChecksUnit: '必需检查',
        });

        expect(buildWorkflowSummary(undefined, labels)).to.equal('未选择工作流');
        expect(buildWorkflowSummary(workflow, labels)).to.include('1 阶段');
        expect(buildWorkflowSummary(workflow, labels)).to.include('1 必需检查');
    });
});

describe('chat i18n and command helpers', () => {
    it('returns localized chat text', () => {
        expect(getChatI18n('en').buttons.send).to.equal('Send');
        expect(getSlashCommandDescriptors('zh-cn').find(command => command.command === '/workflow:off')?.description).to.equal('关闭当前 AI 工作流');
    });

    it('builds slash commands with localized workflow descriptions', () => {
        const workflow: WorkflowView = {
            id: 'diagnostic-fix',
            title: '诊断修复',
            description: '自动修复诊断',
            mode: 'build',
            phases: [],
            verification: [],
        };
        const commands = buildSlashCommands(getSlashCommandDescriptors('zh-cn'), [workflow]);

        expect(commands.find(command => command.command === '/workflow:off')!.description).to.equal('关闭当前 AI 工作流');
        expect(commands.find(command => command.command === '/compact')!.description).to.equal('压缩 Agent 活动上下文，同时保留话题记录');
        expect(commands.find(command => command.command === '/workflow:diagnostic-fix')!.description).to.equal('自动修复诊断');
        expect(filterSlashCommands(commands, '/workflow')).to.have.length.greaterThan(1);
        expect(renderSlashCommandItems(commands)).to.include('/workflow:diagnostic-fix');
        expect(renderSlashCommandItems(commands)).to.include('role="option"');
    });

    it('ranks exact and prefix slash matches and stops completion at arguments', () => {
        const commands = buildSlashCommands(getSlashCommandDescriptors('en'), []);
        expect(filterSlashCommands(commands, '/co')[0]?.command).to.equal('/compact');
        expect(filterSlashCommands(commands, '/goal')[0]?.command).to.equal('/goal');
        expect(getSlashCommandFilter('/goal')).to.equal('/goal');
        expect(getSlashCommandFilter('/goal write tests')).to.equal(null);
        expect(getSlashCommandFilter('explain /goal')).to.equal(null);
    });

    it('parses canonical, colon-argument, and dynamic workflow commands', () => {
        expect(resolveSlashCommand('/goal write tests')?.definition.id).to.equal('goal');
        expect(resolveSlashCommand('/goal:1200:write tests')?.argument).to.equal('1200:write tests');
        expect(resolveSlashCommand('/goal:complete')?.definition.id).to.equal('goalComplete');
        expect(resolveSlashCommand('/workflow:diagnostic-fix')?.definition.id).to.equal('workflowSelect');
        expect(resolveSlashCommand('/workflow:diagnostic-fix')?.argument).to.equal('diagnostic-fix');
        expect(resolveSlashCommand('/does-not-exist')).to.equal(undefined);
        expect(suggestSlashCommands('/compcat')[0]?.command).to.equal('/compact');
    });

    it('publishes explicit completion and running policies from the Host catalog', () => {
        const commands = getSlashCommandDescriptors('en');
        expect(commands.find(command => command.command === '/goal')).to.include({
            argumentMode: 'required',
            completion: 'insert',
            duringRun: 'queue',
        });
        expect(commands.find(command => command.command === '/clear')?.duringRun).to.equal('deny');
        expect(commands.find(command => command.command === '/permissions')?.category).to.equal('configuration');
    });

});

describe('chat view contract helpers', () => {
    it('ignores blank live content when deciding whether a step can start a visible block', () => {
        expect(hasVisibleLiveContent({ content: '  \n ' })).to.equal(false);
        expect(hasVisibleLiveContent({ content: 'reasoning' })).to.equal(true);
    });

    it('builds settings overview copy without touching DOM', () => {
        const i18n = getChatI18n('zh-cn');
        const model = buildSettingsOverviewModel({
            providers: [{ id: 'openai', name: 'OpenAI', defaultEndpoint: 'https://api.example', hasKey: true }],
            providerId: 'openai',
            model: 'gpt-test',
            contextTokens: 128000,
            inlineEnabled: true,
            inlineProviderName: 'OpenAI',
            mcpCount: 2,
            writeMode: 'auto',
            reasoningEffort: 'high',
        }, i18n);

        expect(model.title).to.include('OpenAI');
        expect(model.subtitle).to.include('128k tokens');
        expect(model.chipsHtml).to.include('写入自动');
    });

    it('builds live subagent status HTML', () => {
        const state = {
            liveSteps: [{ type: 'tool_call', toolName: 'read_file' }],
            startedAt: 1000,
            lastStepAt: 1100,
            completedAt: 2500,
            isComplete: true,
        };
        const html = buildSubagentMetaHtml(state, { toolCallCount: 1, readCount: 1, writeCount: 0 }, latestLiveToolName(state.liveSteps), 3000, getChatI18n('zh-cn'));

        expect(buildSubagentCardHtml('agent-a', 'view-a', getChatI18n('zh-cn'))).to.include('子任务');
        expect(html).to.include('read_file');
        expect(html).to.include('读取');
    });
});

describe('chat markdown and mention helpers', () => {
    it('teaches architecture modes to emit bounded safe Mermaid diagrams when useful', () => {
        const explore = buildExploreModeSystemPrompt('', 'Stellaris');
        const plan = buildPlanModeSystemPrompt('', 'Stellaris');

        for (const prompt of [explore, plan]) {
            expect(prompt).to.include('## Architecture Visualization');
            expect(prompt).to.include('```mermaid');
            expect(prompt).to.include('Use Mermaid markdown strings for labels that may need wrapping');
            expect(prompt).to.include('Do not emit Mermaid init/config directives');
        }
    });

    it('renders markdown headings, lists, tables, and code blocks from an extracted module', () => {
        const html = renderMarkdown([
            '# Title',
            '',
            '- first',
            '- **second**',
            '',
            '| A | B |',
            '|---|---|',
            '| 1 | `two` |',
            '',
            '```txt',
            'a < b',
            '```',
        ].join('\n'));

        expect(html).to.include('<h1>Title</h1>');
        expect(html).to.include('<ul>');
        expect(html).to.include('<strong>second</strong>');
        expect(html).to.include('<div class="md-table-wrap"><table>');
        expect(html).to.include('&lt; b');
    });

    it('does not interpret retired question syntax and still renders media links', () => {
        const html = renderMarkdown([
            ':::question Pick <one>',
            '[Option: Safe] Use this',
            '[Option: Risky] Avoid this',
            ':::',
            '',
            '[clip](demo.mp4)',
        ].join('\n'), { waitingForChoice: 'wait' });

        expect(html).to.not.include('question-card');
        expect(html).to.include(':::question Pick &lt;one&gt;');
        expect(html).to.not.include('data-suggest="Safe"');
        expect(html).to.include('<video src="demo.mp4"');
    });

    it('renders Mermaid fences as safe asynchronous diagram placeholders', () => {
        const html = renderMarkdown([
            '```mermaid',
            'flowchart LR',
            '  A["User <edit>"] --> B["CWTools model"]',
            '```',
        ].join('\n'));

        expect(html).to.include('class="md-mermaid"');
        expect(html).to.include('data-mermaid-state="pending"');
        expect(html).to.include('flowchart LR');
        expect(html).to.include('User &lt;edit&gt;');
        expect(html).not.to.include('class="md-codeblock"');
    });

    it('converts mention results and strips consumed mention-only lines', () => {
        const ctx = mentionResultToActiveContext({
            type: 'file',
            label: 'events.txt',
            desc: 'events/events.txt',
            uri: '/mod/events/events.txt',
            cacheStatus: 'disk',
        });
        const blackboard: ActiveContext = {
            id: 'b',
            type: 'blackboard',
            label: 'blackboard:task',
            key: 'task',
        };

        expect(ctx.type).to.equal('file');
        expect(ctx.cacheStatus).to.equal('disk');
        expect(stripConsumedMentionText('@events.txt\nDo work\n@blackboard:task', [ctx, blackboard])).to.equal('Do work');
    });
});
