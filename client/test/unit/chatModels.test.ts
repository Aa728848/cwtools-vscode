import { expect } from 'chai';
import {
    artifactPreviewPayload,
    filterArtifacts,
    formatArtifactFileStats,
    restoreArtifactsFromMessages,
    sortArtifactsByNewest,
    type ArtifactRecord,
} from '../../webview/chat/artifacts';
import { renderArtifactEmpty, renderArtifactRowHtml } from '../../webview/chat/artifactDrawer';
import {
    buildTopicSummaryModel,
    formatTopicMoment,
    groupTopicsByDate,
    shortenText,
    type TopicPanelItem,
} from '../../webview/chat/topics';
import { buildSubagentCardHtml, buildSubagentMetaHtml, latestLiveToolName } from '../../webview/chat/liveSteps';
import { buildSettingsOverviewModel } from '../../webview/chat/settingsOverview';
import { getChatI18n } from '../../webview/chat/i18n';
import { applyModeUi } from '../../webview/chat/modes';
import { buildSlashCommands, filterSlashCommands, renderSlashCommandItems } from '../../webview/chat/slashCommands';
import { buildWorkflowSummary, getWorkflowSlashCommand, normalizeWorkflowLabels, type WorkflowView } from '../../webview/chat/workflows';

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
        expect(getChatI18n('zh-cn').slashDescriptions['/workflow:off']).to.equal('关闭当前 AI 工作流');
        expect(getChatI18n('en').buttons.send).to.equal('Send');
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
        const commands = buildSlashCommands(getChatI18n('zh-cn').slashDescriptions, [workflow]);

        expect(commands.find(command => command.cmd === '/workflow:off')!.desc).to.equal('关闭当前 AI 工作流');
        expect(commands.find(command => command.cmd === '/workflow:diagnostic-fix')!.desc).to.equal('自动修复诊断');
        expect(filterSlashCommands(commands, '/workflow')).to.have.length.greaterThan(1);
        expect(renderSlashCommandItems(commands)).to.include('/workflow:diagnostic-fix');
    });

    it('applies mode UI state without reimplementing it in chatPanel', () => {
        const classSet = new Set<string>();
        const body = {
            classList: {
                add: (...classes: string[]) => classes.forEach(cls => classSet.add(cls)),
                remove: (...classes: string[]) => classes.forEach(cls => classSet.delete(cls)),
                contains: (cls: string) => classSet.has(cls),
            },
        } as unknown as HTMLElement;
        const selector = { value: 'plan' } as HTMLSelectElement;
        const indicator = { textContent: '' } as HTMLElement;

        const normalized = applyModeUi('general', getChatI18n('en').modeLabels, body, selector, indicator);

        expect(normalized).to.equal('utility');
        expect(classSet.has('utility-mode')).to.equal(true);
        expect(selector.value).to.equal('utility');
        expect(indicator.textContent).to.include('Utility Mode');
    });
});

describe('chat view contract helpers', () => {
    it('builds settings overview copy without touching DOM', () => {
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
        });

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
        const html = buildSubagentMetaHtml(state, { toolCallCount: 1, readCount: 1, writeCount: 0 }, latestLiveToolName(state.liveSteps), 3000);

        expect(buildSubagentCardHtml('agent-a', 'view-a')).to.include('子任务');
        expect(html).to.include('read_file');
        expect(html).to.include('读取');
    });
});
