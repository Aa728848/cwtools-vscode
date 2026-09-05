import { escapeHtml } from './formatters';
import type { AgentRunEvent } from '../../shared/agentRunEvent';

export type AgentTraceEvent = AgentRunEvent;

export interface AgentTraceNode {
    agentId: string;
    parentAgentId?: string;
    role?: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'refused';
    task?: string;
    startedAt?: number;
    endedAt?: number;
    eventCount: number;
    modelCallCount: number;
    toolCallCount: number;
    tokenCount: number;
}

export interface AgentTraceModel {
    rootAgentId: string;
    nodes: AgentTraceNode[];
    eventsByAgent: Map<string, AgentTraceEvent[]>;
}

export interface TraceSpan {
    id: string;
    kind: 'model' | 'tool' | 'process' | 'permission' | 'file' | 'agent' | 'event';
    label: string;
    agentId?: string;
    summary: string;
    status: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    eventIds: string[];
}

export interface AgentTraceLabels {
    mainAgent: string;
    subagent: string;
    conversation: string;
    trajectory: string;
    modelCalls: string;
    toolCalls: string;
    events: string;
    noConversation: string;
    noTrajectory: string;
    running: string;
    completed: string;
    failed: string;
    pending: string;
    backToMain: string;
    inspectHint: string;
}

interface UnknownRecord { [key: string]: unknown }

function asRecord(value: unknown): UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventPayload(event: AgentTraceEvent): UnknownRecord {
    return asRecord(event.payload);
}

function eventOwner(event: AgentTraceEvent, rootAgentId: string): string {
    const payload = eventPayload(event);
    const step = asRecord(payload.step);
    return stringValue(event.agentId)
        ?? stringValue(payload.agentId)
        ?? stringValue(step.agentId)
        ?? rootAgentId;
}

function normalizeStatus(status: unknown): AgentTraceNode['status'] {
    if (status === 'done' || status === 'completed') return 'done';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'refused') return 'refused';
    if (status === 'running') return 'running';
    return 'pending';
}

function terminalStatus(status: AgentTraceNode['status']): boolean {
    return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'refused';
}

export function buildAgentTraceModel(
    events: readonly AgentTraceEvent[],
    run?: { agentId?: string; runId?: string; status?: string; startedAt?: number; completedAt?: number },
): AgentTraceModel {
    const firstRun = events.find(event => event.type === 'run_created');
    const firstPayload = firstRun ? eventPayload(firstRun) : {};
    const rootAgentId = stringValue(run?.agentId)
        ?? stringValue(firstPayload.agentId)
        ?? 'root';
    const nodes = new Map<string, AgentTraceNode>();
    const eventsByAgent = new Map<string, AgentTraceEvent[]>();

    const ensure = (agentId: string, parentAgentId?: string): AgentTraceNode => {
        let node = nodes.get(agentId);
        if (!node) {
            node = {
                agentId,
                parentAgentId: agentId === rootAgentId ? undefined : parentAgentId ?? rootAgentId,
                status: agentId === rootAgentId ? normalizeStatus(run?.status ?? 'running') : 'pending',
                startedAt: agentId === rootAgentId ? run?.startedAt : undefined,
                endedAt: agentId === rootAgentId ? run?.completedAt : undefined,
                eventCount: 0,
                modelCallCount: 0,
                toolCallCount: 0,
                tokenCount: 0,
            };
            nodes.set(agentId, node);
        } else if (!node.parentAgentId && parentAgentId && agentId !== rootAgentId) {
            node.parentAgentId = parentAgentId;
        }
        return node;
    };

    ensure(rootAgentId);
    const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp);
    for (const event of orderedEvents) {
        const payload = eventPayload(event);
        const owner = eventOwner(event, rootAgentId);
        const parent = stringValue(payload.parentAgentId) ?? (owner === rootAgentId ? undefined : rootAgentId);
        const node = ensure(owner, parent);
        if (parent && owner !== rootAgentId && node.parentAgentId === rootAgentId) {
            node.parentAgentId = parent;
        }
        const bucket = eventsByAgent.get(owner) ?? [];
        bucket.push(event);
        eventsByAgent.set(owner, bucket);
        node.eventCount++;
        node.startedAt = Math.min(node.startedAt ?? event.timestamp, event.timestamp);
        node.endedAt = Math.max(node.endedAt ?? event.timestamp, event.timestamp);

        if (event.type === 'subagent_start') {
            node.status = 'running';
            node.role = stringValue(payload.profileName) ?? node.role;
            node.task = stringValue(payload.task) ?? stringValue(payload.prompt) ?? stringValue(payload.taskNodeId) ?? node.task;
        } else if (event.type === 'subagent_policy_derived') {
            node.role = stringValue(payload.profileName) ?? node.role;
        } else if (event.type === 'subagent_end') {
            node.status = payload.success === false ? 'failed' : 'done';
        } else if (event.type === 'subagent_refused') {
            node.status = 'refused';
        } else if (event.type === 'agent_suspended' || event.type === 'agent_requeued') {
            node.status = 'pending';
        } else if (event.type === 'model_call_start') {
            node.modelCallCount++;
            if (!terminalStatus(node.status)) node.status = 'running';
        } else if (event.type === 'tool_call_start' || event.type === 'tool_call_created') {
            if (!terminalStatus(node.status)) node.status = 'running';
        } else if (event.type === 'tool_call_end') {
            node.toolCallCount++;
        } else if (event.type === 'status_changed' && owner === rootAgentId) {
            node.status = normalizeStatus(payload.status ?? event.status);
        }

        if (event.type === 'model_call_end') {
            const usage = asRecord(payload.usage);
            node.tokenCount += numberValue(usage.total_tokens)
                ?? ((numberValue(usage.prompt_tokens) ?? 0) + (numberValue(usage.completion_tokens) ?? 0));
        }
    }

    const root = ensure(rootAgentId);
    root.status = normalizeStatus(run?.status ?? root.status);
    root.startedAt = run?.startedAt ?? root.startedAt;
    root.endedAt = run?.completedAt ?? root.endedAt;

    const sortedNodes = [...nodes.values()].sort((left, right) => {
        if (left.agentId === rootAgentId) return -1;
        if (right.agentId === rootAgentId) return 1;
        return (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.agentId.localeCompare(right.agentId);
    });
    return { rootAgentId, nodes: sortedNodes, eventsByAgent };
}

function spanKind(event: AgentTraceEvent): TraceSpan['kind'] {
    if (event.type.startsWith('model_call_')) return 'model';
    if (event.type.startsWith('tool_call_') || event.type.startsWith('tool_output_')) return 'tool';
    if (event.type.startsWith('process_')) return 'process';
    if (event.type.startsWith('permission_') || event.type.startsWith('write_confirmation_')) return 'permission';
    if (event.type === 'file_change' || event.type === 'artifact_created') return 'file';
    if (event.type.startsWith('subagent_')) return 'agent';
    return 'event';
}

function spanLabel(event: AgentTraceEvent): string {
    const payload = eventPayload(event);
    if (event.type.startsWith('model_call_')) return stringValue(payload.model) ?? 'Model';
    if (event.type.startsWith('tool_call_')) return stringValue(payload.toolName) ?? stringValue(payload.name) ?? 'Tool';
    if (event.type.startsWith('process_')) return stringValue(payload.command) ?? stringValue(payload.description) ?? 'Process';
    if (event.type.startsWith('permission_') || event.type.startsWith('write_confirmation_')) return stringValue(payload.tool) ?? 'Permission';
    if (event.type === 'file_change' || event.type === 'artifact_created') return stringValue(payload.filePath) ?? stringValue(payload.path) ?? 'File change';
    if (event.type.startsWith('subagent_')) return stringValue(payload.profileName) ?? stringValue(payload.taskNodeId) ?? 'Subagent';
    return event.type.replace(/_/g, ' ');
}

function endTypeFor(event: AgentTraceEvent): string | undefined {
    if (event.type === 'model_call_start') return 'model_call_end';
    if (event.type === 'tool_call_start' || event.type === 'tool_call_created') return 'tool_call_end';
    if (event.type === 'process_started') return 'process_completed';
    if (event.type === 'permission_requested') return 'permission_resolved';
    if (event.type === 'write_confirmation_requested') return 'write_confirmation_resolved';
    if (event.type === 'subagent_start') return 'subagent_end';
    return undefined;
}

function startEvent(event: AgentTraceEvent): boolean {
    return event.type === 'model_call_start'
        || event.type === 'tool_call_start'
        || event.type === 'tool_call_created'
        || event.type === 'process_started'
        || event.type === 'permission_requested'
        || event.type === 'write_confirmation_requested'
        || event.type === 'subagent_start';
}

function correlationKey(event: AgentTraceEvent): string {
    const payload = eventPayload(event);
    return event.invocationId
        ?? stringValue(payload.processId)
        ?? stringValue(payload.itemId)
        ?? stringValue(payload.taskNodeId)
        ?? event.eventId;
}

function earlierStartForSameInvocation(events: readonly AgentTraceEvent[], index: number, event: AgentTraceEvent): boolean {
    if (event.type !== 'tool_call_start') return false;
    const key = correlationKey(event);
    return events.slice(0, index).some(candidate =>
        candidate.type === 'tool_call_created' && candidate.agentId === event.agentId && correlationKey(candidate) === key);
}

export function buildTraceSpans(events: readonly AgentTraceEvent[], now = Date.now()): TraceSpan[] {
    const ordered = [...events].sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp);
    const consumed = new Set<string>();
    const spans: TraceSpan[] = [];
    for (let index = 0; index < ordered.length; index++) {
        const event = ordered[index]!;
        if (consumed.has(event.eventId) || earlierStartForSameInvocation(ordered, index, event)) continue;
        let endEvent: AgentTraceEvent | undefined;
        const endType = endTypeFor(event);
        if (startEvent(event) && endType) {
            const key = correlationKey(event);
            endEvent = ordered.slice(index + 1).find(candidate =>
                !consumed.has(candidate.eventId)
                && candidate.type === endType
                && candidate.agentId === event.agentId
                && (correlationKey(candidate) === key
                    || (key === event.eventId && correlationKey(candidate) === candidate.eventId)));
        }
        if (endEvent) consumed.add(endEvent.eventId);
        consumed.add(event.eventId);
        const members = event.type === 'tool_call_created' ? ordered.slice(index + 1).filter(candidate =>
            candidate.type === 'tool_call_start' && candidate.agentId === event.agentId
            && correlationKey(candidate) === correlationKey(event)
            && (!endEvent || candidate.sequence < endEvent.sequence)) : [];
        members.forEach(member => consumed.add(member.eventId));
        const endedAt = endEvent?.timestamp ?? (startEvent(event) ? now : event.timestamp);
        const outcome = eventPayload(endEvent ?? event);
        const label = spanLabel(event);
        const summaries = [eventSummary(event), endEvent ? eventSummary(endEvent) : '']
            .filter(summary => summary && summary !== label);
        const status = endEvent?.status
            ?? stringValue(outcome.status)
            ?? (outcome.success === false || stringValue(outcome.error) ? 'failed' : undefined)
            ?? event.status
            ?? (endEvent ? 'done' : startEvent(event) ? 'running' : 'done');
        spans.push({
            id: event.eventId,
            kind: spanKind(event),
            label,
            agentId: event.agentId,
            summary: [...new Set(summaries)].join(' · '),
            status,
            startedAt: event.timestamp,
            endedAt: Math.max(event.timestamp, endedAt),
            durationMs: Math.max(0, endedAt - event.timestamp),
            eventIds: [event.eventId, ...members.map(member => member.eventId), ...(endEvent ? [endEvent.eventId] : [])],
        });
    }
    return spans;
}


export function stableTrajectoryEndTime(
    run: { startedAt?: number; completedAt?: number },
    events: readonly AgentTraceEvent[],
): number {
    const startedAt = Number(run.startedAt || 0);
    const completedAt = Number(run.completedAt || 0);
    if (completedAt > 0) return Math.max(startedAt, completedAt);
    let latestEventAt = startedAt;
    for (const event of events) {
        if (Number.isFinite(event.timestamp)) latestEventAt = Math.max(latestEventAt, event.timestamp);
    }
    return latestEventAt;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return ms > 0 ? Math.round(ms) + 'ms' : '0ms';
    if (ms < 60_000) return (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1) + 's';
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return minutes + 'm ' + seconds + 's';
}

function statusLabel(status: AgentTraceNode['status'], labels: AgentTraceLabels): string {
    if (status === 'running') return labels.running;
    if (status === 'done') return labels.completed;
    if (status === 'failed' || status === 'refused' || status === 'cancelled') return labels.failed;
    return labels.pending;
}

export function renderAgentTreeHTML(
    model: AgentTraceModel,
    selectedAgentId: string,
    labels: AgentTraceLabels,
    options: { rootTitle?: string } = {},
): string {
    const children = new Map<string, AgentTraceNode[]>();
    for (const node of model.nodes) {
        if (node.agentId === model.rootAgentId) continue;
        const parent = node.parentAgentId && model.nodes.some(candidate => candidate.agentId === node.parentAgentId)
            ? node.parentAgentId
            : model.rootAgentId;
        const list = children.get(parent) ?? [];
        list.push(node);
        children.set(parent, list);
    }
    const renderNode = (node: AgentTraceNode, depth: number): string => {
        const descendants = children.get(node.agentId) ?? [];
        const selected = node.agentId === selectedAgentId;
        const isRoot = node.agentId === model.rootAgentId;
        const title = isRoot ? (options.rootTitle || labels.mainAgent) : (node.task || node.role || node.agentId);
        const subtitle = isRoot ? labels.mainAgent : (node.role || labels.subagent);
        const duration = node.startedAt && node.endedAt ? formatDuration(node.endedAt - node.startedAt) : '';
        const metrics = node.modelCallCount + ' M · ' + node.toolCallCount + ' T' + (duration ? ' · ' + duration : '');
        return '<li class="agent-tree-branch" role="treeitem" aria-level="' + (depth + 1) + '" aria-selected="' + selected + '">' +
            '<button type="button" class="agent-tree-node agent-tree-' + escapeHtml(node.status) + (selected ? ' is-selected' : '') + '" data-agent-path="' + escapeHtml(node.agentId) + '">' +
            '<span class="agent-tree-state" aria-hidden="true"></span>' +
            '<span class="agent-tree-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(subtitle) + '</small><em>' + escapeHtml(statusLabel(node.status, labels)) + '</em><span>' + escapeHtml(metrics) + '</span></span></button>' +
            (descendants.length ? '<ul role="group">' + descendants.map(child => renderNode(child, depth + 1)).join('') + '</ul>' : '') +
            '</li>';
    };
    const root = model.nodes.find(node => node.agentId === model.rootAgentId) ?? model.nodes[0];
    return root ? '<ul class="agent-run-tree" role="tree">' + renderNode(root, 0) + '</ul>' : '';
}

function eventSummary(event: AgentTraceEvent): string {
    const payload = eventPayload(event);
    const step = asRecord(payload.step);
    const args = asRecord(payload.arguments ?? payload.input);
    return stringValue(step.content)
        ?? stringValue(payload.description)
        ?? stringValue(payload.error)
        ?? stringValue(payload.reason)
        ?? stringValue(payload.filePath)
        ?? stringValue(payload.path)
        ?? stringValue(args.filePath)
        ?? stringValue(args.path)
        ?? stringValue(args.file_path)
        ?? stringValue(payload.model)
        ?? stringValue(payload.toolName)
        ?? '';
}

export function renderAgentConversationHTML(events: readonly AgentTraceEvent[], labels: AgentTraceLabels): string {
    const messages = events.filter(event => {
        const payload = eventPayload(event);
        const step = asRecord(payload.step);
        return event.type === 'step_appended'
            || event.type === 'model_call_start'
            || event.type === 'model_call_end'
            || event.type === 'tool_call_start'
            || event.type === 'tool_call_end'
            || event.type === 'subagent_start'
            || event.type === 'subagent_end'
            || stringValue(step.content) !== undefined;
    });
    if (!messages.length) return '<div class="agent-conversation-empty">' + escapeHtml(labels.noConversation) + '</div>';
    return messages.map(event => {
        const payload = eventPayload(event);
        const step = asRecord(payload.step);
        const stepType = stringValue(step.type);
        const kind = stepType === 'thinking' || stepType === 'thinking_content'
            ? 'thinking'
            : event.type.startsWith('tool_call_') || stepType === 'tool_call' || stepType === 'tool_result'
                ? 'tool'
                : event.type.startsWith('model_call_') ? 'model' : 'notice';
        const title = spanLabel(event);
        const text = eventSummary(event);
        const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '<button type="button" class="agent-conversation-entry agent-conversation-' + kind + '" data-trace-event-id="' + escapeHtml(event.eventId) + '">' +
            '<span class="agent-conversation-rail" aria-hidden="true"></span>' +
            '<span class="agent-conversation-body"><span class="agent-conversation-head"><strong>' + escapeHtml(title) + '</strong><time>' + escapeHtml(time) + '</time></span>' +
            (text ? '<span class="agent-conversation-text">' + escapeHtml(text.slice(0, 900)) + '</span>' : '') +
            '</span></button>';
    }).join('');
}

export function renderTraceRailHTML(
    events: readonly AgentTraceEvent[],
    selectedEventId: string | undefined,
    labels: AgentTraceLabels,
    now = Date.now(),
    options: { includeList?: boolean } = {},
): string {
    const spans = buildTraceSpans(events, now);
    if (!spans.length) return '<div class="agent-trace-empty">' + escapeHtml(labels.noTrajectory) + '</div>';
    const min = Math.min(...spans.map(span => span.startedAt));
    const max = Math.max(...spans.map(span => span.endedAt), min + 1);
    const total = Math.max(1, max - min);
    const lanes: TraceSpan['kind'][] = ['model', 'tool', 'process', 'permission', 'file', 'agent', 'event'];
    const activeLanes = lanes.filter(kind => spans.some(span => span.kind === kind));
    const laneLabel = (kind: TraceSpan['kind']): string => {
        if (kind === 'model') return labels.modelCalls;
        if (kind === 'tool') return labels.toolCalls;
        if (kind === 'agent') return labels.subagent;
        return labels.events;
    };
    const scale = '<div class="agent-trace-scale"><span>0s</span><span>' + escapeHtml(formatDuration(total / 2)) + '</span><span>' + escapeHtml(formatDuration(total)) + '</span></div>';
    const laneHtml = '<div class="agent-trace-lanes">' + activeLanes.map(kind => {
        const laneSpans = spans.filter(span => span.kind === kind);
        return '<div class="agent-trace-lane"><span class="agent-trace-label">' + escapeHtml(laneLabel(kind)) + '</span><div class="agent-trace-track">' +
            laneSpans.map(span => {
                const left = Math.max(0, Math.min(99.5, ((span.startedAt - min) / total) * 100));
                const width = Math.max(0.8, Math.min(100 - left, (Math.max(1, span.durationMs) / total) * 100));
                const selected = span.eventIds.includes(selectedEventId ?? '');
                return '<button type="button" class="agent-trace-span agent-trace-' + span.kind + ' agent-trace-status-' + escapeHtml(span.status) + (selected ? ' is-selected' : '') + '" data-trace-event-id="' + escapeHtml(span.eventIds[0]!) + '" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%" title="' + escapeHtml(span.label + ' · ' + formatDuration(span.durationMs)) + '"></button>';
            }).join('') + '</div></div>';
    }).join('') + '</div>';
    const list = options.includeList === false ? '' : '<div class="agent-trace-list">' + spans.map(span => {
        const selected = span.eventIds.includes(selectedEventId ?? '');
        const time = new Date(span.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '<button type="button" class="agent-trace-row' + (selected ? ' is-selected' : '') + '" data-trace-event-id="' + escapeHtml(span.eventIds[0]!) + '"><span class="agent-trace-dot agent-trace-' + span.kind + '"></span><time>' + escapeHtml(time) + '</time><strong>' + escapeHtml(span.label) + '</strong><em>' + escapeHtml(formatDuration(span.durationMs)) + '</em><small>' + escapeHtml(span.status) + '</small></button>';
    }).join('') + '</div>';
    return scale + laneHtml + list;
}
