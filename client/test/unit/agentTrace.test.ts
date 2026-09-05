import { expect } from 'chai';
import {
    buildAgentTraceModel,
    buildTraceSpans,
    renderAgentTreeHTML,
    renderTraceRailHTML,
    stableTrajectoryEndTime,
    type AgentTraceEvent,
    type AgentTraceLabels,
} from '../../webview/chat/agentTrace';

const labels: AgentTraceLabels = {
    mainAgent: 'Main agent',
    subagent: 'Subagent',
    conversation: 'Conversation',
    trajectory: 'Trajectory',
    modelCalls: 'Model',
    toolCalls: 'Tools',
    events: 'Events',
    noConversation: 'None',
    noTrajectory: 'None',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    pending: 'Pending',
    backToMain: 'Back',
    inspectHint: 'Inspect',
};

function event(
    sequence: number,
    type: string,
    timestamp: number,
    options: Partial<AgentTraceEvent> = {},
): AgentTraceEvent {
    return {
        eventId: options.eventId ?? 'evt_' + sequence,
        runId: options.runId ?? 'run_root',
        sequence,
        type,
        timestamp,
        payload: options.payload ?? {},
        status: options.status,
        invocationId: options.invocationId,
        agentId: options.agentId,
    };
}

describe('agent trace view model', () => {
    it('builds a deterministic main-agent and child-agent tree', () => {
        const events = [
            event(1, 'run_created', 1_000, { agentId: 'main' }),
            event(2, 'model_call_start', 1_100, { agentId: 'main', invocationId: 'model_main' }),
            event(3, 'subagent_start', 1_200, { agentId: 'child-a', payload: { profileName: 'explore', task: 'Inspect UI', parentAgentId: 'main' } }),
            event(4, 'model_call_start', 1_300, { agentId: 'child-a', invocationId: 'model_child' }),
            event(5, 'tool_call_end', 1_400, { agentId: 'child-a', invocationId: 'tool_child' }),
            event(6, 'subagent_end', 1_500, { agentId: 'child-a', payload: { success: true } }),
            event(7, 'subagent_start', 1_600, { agentId: 'child-b', payload: { profileName: 'reviewer', task: 'Review UI', parentAgentId: 'child-a' } }),
            event(8, 'subagent_end', 1_700, { agentId: 'child-b', payload: { success: true, parentAgentId: 'child-a' } }),
        ];

        const model = buildAgentTraceModel(events, { agentId: 'main', status: 'running', startedAt: 1_000 });
        expect(model.rootAgentId).to.equal('main');
        expect(model.nodes.map(node => node.agentId)).to.deep.equal(['main', 'child-a', 'child-b']);
        expect(model.nodes[2]).to.include({ parentAgentId: 'child-a', role: 'reviewer', task: 'Review UI', status: 'done' });
        expect(model.nodes[1]).to.include({
            parentAgentId: 'main',
            role: 'explore',
            task: 'Inspect UI',
            status: 'done',
            modelCallCount: 1,
            toolCallCount: 1,
        });
        expect(model.eventsByAgent.get('child-a')).to.have.length(4);

        const html = renderAgentTreeHTML(model, 'child-a', labels, { rootTitle: 'Optimize agent trajectory' });
        expect(html).to.include('role="tree"');
        expect(html).to.include('Optimize agent trajectory');
        expect(html).to.include('data-agent-path="child-a"');
        expect(html).to.include('data-agent-path="child-b"');
        expect(html).to.include('aria-level="3"');
        expect(html).to.include('is-selected');
        expect(html).to.include('Inspect UI');
        expect(html).to.include('<small>explore</small><em>Completed</em>');
        expect(html).to.include('<span>1 M · 1 T');
        expect(html).to.not.include('agent-tree-enter');
        expect(html).to.not.include('agent-tree-stats');
    });

    it('pairs model and tool calls into duration spans', () => {
        const events = [
            event(1, 'model_call_start', 1_000, { invocationId: 'model_1', payload: { model: 'deepseek-chat' } }),
            event(2, 'tool_call_start', 1_200, { invocationId: 'tool_1', payload: { toolName: 'read' } }),
            event(3, 'tool_call_end', 1_500, { invocationId: 'tool_1', status: 'done' }),
            event(4, 'model_call_end', 2_000, { invocationId: 'model_1', status: 'done' }),
        ];

        const spans = buildTraceSpans(events, 3_000);
        expect(spans).to.have.length(2);
        expect(spans[0]).to.include({ kind: 'model', label: 'deepseek-chat', durationMs: 1_000, status: 'done' });
        expect(spans[1]).to.include({ kind: 'tool', label: 'read', durationMs: 300, status: 'done' });
    });

    it('does not duplicate a tool invocation that records both created and started events', () => {
        const spans = buildTraceSpans([
            event(1, 'tool_call_created', 1_000, { invocationId: 'tool_1', payload: { toolName: 'read' } }),
            event(2, 'tool_call_start', 1_100, { invocationId: 'tool_1', payload: { toolName: 'read' } }),
            event(3, 'tool_call_end', 1_300, { invocationId: 'tool_1', status: 'done' }),
        ], 2_000);
        expect(spans).to.have.length(1);
        expect(spans[0]).to.include({ kind: 'tool', durationMs: 300, status: 'done' });
    });

    it('can render the compact overview without the duplicate event list', () => {
        const html = renderTraceRailHTML([
            event(1, 'model_call_start', 1_000, { invocationId: 'model_1' }),
            event(2, 'model_call_end', 2_000, { invocationId: 'model_1', status: 'done' }),
        ], undefined, labels, 2_000, { includeList: false });
        expect(html).to.include('agent-trace-lanes');
        expect(html).to.not.include('agent-trace-list');
    });

    it('keeps all invocation records inspectable and exposes a failed file operation', () => {
        const spans = buildTraceSpans([
            event(1, 'tool_call_created', 1_000, { agentId: 'coder', invocationId: 'read_1', payload: { toolName: 'read_file', arguments: { path: 'common/test.txt' } } }),
            event(2, 'tool_call_start', 1_100, { agentId: 'coder', invocationId: 'read_1' }),
            event(3, 'tool_call_end', 1_400, { agentId: 'coder', invocationId: 'read_1', payload: { success: false } }),
        ], 2_000);
        expect(spans).to.have.length(1);
        expect(spans[0]).to.include({ agentId: 'coder', summary: 'common/test.txt', status: 'failed', durationMs: 400 });
        expect(spans[0]?.eventIds).to.deep.equal(['evt_1', 'evt_2', 'evt_3']);
    });

    it('does not pair concurrent processes or different agents with the wrong completion', () => {
        const spans = buildTraceSpans([
            event(1, 'process_started', 1_000, { agentId: 'coder', payload: { processId: 'a' } }),
            event(2, 'process_started', 1_100, { agentId: 'coder', payload: { processId: 'b' } }),
            event(3, 'process_completed', 1_300, { agentId: 'coder', payload: { processId: 'b' } }),
            event(4, 'process_completed', 1_500, { agentId: 'coder', payload: { processId: 'a' } }),
            event(5, 'model_call_start', 2_000, { agentId: 'a', invocationId: 'shared' }),
            event(6, 'model_call_start', 2_100, { agentId: 'b', invocationId: 'shared' }),
            event(7, 'model_call_end', 2_400, { agentId: 'b', invocationId: 'shared' }),
            event(8, 'model_call_end', 2_600, { agentId: 'a', invocationId: 'shared' }),
        ]);
        expect(spans.map(span => span.durationMs)).to.deep.equal([500, 200, 600, 300]);
        expect(spans.map(span => span.eventIds)).to.deep.equal([['evt_1', 'evt_4'], ['evt_2', 'evt_3'], ['evt_5', 'evt_8'], ['evt_6', 'evt_7']]);
    });

    it('keeps run duration stable across UI-only interactions', () => {
        const events = [
            event(1, 'run_created', 1_000),
            event(2, 'model_call_start', 2_000),
            event(3, 'model_call_end', 4_500),
        ];
        expect(stableTrajectoryEndTime({ startedAt: 1_000 }, events)).to.equal(4_500);
        expect(stableTrajectoryEndTime({ startedAt: 1_000 }, events)).to.equal(4_500);
        expect(stableTrajectoryEndTime({ startedAt: 1_000, completedAt: 5_000 }, events)).to.equal(5_000);
    });

    it('keeps unfinished calls live until the supplied clock', () => {
        const spans = buildTraceSpans([
            event(1, 'model_call_start', 4_000, { invocationId: 'model_live' }),
        ], 5_250);
        expect(spans[0]).to.include({ durationMs: 1_250, status: 'running' });
    });
});
