/**
 * Run Timeline — 渲染 Agent Manager 中的运行事件时间线视图 (Phase 1 - P1-2)
 *
 * 职责：
 * - 按时间顺序渲染 model/tool/permission/file/validation/compaction/subagent 事件
 * - 按事件分组：Model | Tools | Files | Permissions | Validation | Context | Sub-agents
 * - 支持 tool_call 与 tool_result 成对显示
 * - 子 agent lane 按 agentId 分组显示 running/done/failed/cancelled
 */

export interface TimelineEvent {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: number;
    type: string;
    status?: string;
    invocationId?: string;
    agentId?: string;
    payload: any;
}

export type TimelineGroupId = 'model' | 'tools' | 'files' | 'permissions' | 'validation' | 'context' | 'subagents' | 'other';

export interface TimelineGroup {
    id: TimelineGroupId;
    label: string;
    icon: string;
    events: TimelineEvent[];
}

const EVENT_GROUP_MAP: Record<string, TimelineGroupId> = {
    'model_call_start': 'model',
    'model_call_delta': 'model',
    'model_call_end': 'model',
    'tool_call_created': 'tools',
    'tool_call_start': 'tools',
    'tool_call_end': 'tools',
    'tool_output_delta': 'tools',
    'permission_requested': 'permissions',
    'permission_resolved': 'permissions',
    'write_confirmation_requested': 'permissions',
    'write_confirmation_resolved': 'permissions',
    'file_change': 'files',
    'artifact_created': 'files',
    'validation_start': 'validation',
    'validation_end': 'validation',
    'compaction_start': 'context',
    'compaction_end': 'context',
    'checkpoint_saved': 'context',
    'resume_state_saved': 'context',
    'subagent_start': 'subagents',
    'subagent_end': 'subagents',
};

import type { ChatI18nText } from './i18n';
import { svgIcon } from '../svgIcons';

/**
 * Groups flat events into categorized timeline groups.
 */
export function groupTimelineEvents(events: TimelineEvent[], i18n?: ChatI18nText): TimelineGroup[] {
    const groups: Record<TimelineGroupId, TimelineEvent[]> = {
        model: [],
        tools: [],
        files: [],
        permissions: [],
        validation: [],
        context: [],
        subagents: [],
        other: [],
    };

    for (const evt of events) {
        const groupId = EVENT_GROUP_MAP[evt.type] ?? 'other';
        groups[groupId].push(evt);
    }

    const g = i18n?.runs?.groups;
    const labels: Record<TimelineGroupId, { label: string; icon: string }> = {
        model:       { label: g?.model       ?? 'Model Calls',      icon: svgIcon('sparkles') },
        tools:       { label: g?.tools       ?? 'Tool Invocations', icon: svgIcon('gear') },
        files:       { label: g?.files       ?? 'File Changes',     icon: svgIcon('file') },
        permissions: { label: g?.permissions ?? 'Permissions',      icon: svgIcon('shield') },
        validation:  { label: g?.validation  ?? 'Validation',       icon: svgIcon('check') },
        context:     { label: g?.context     ?? 'Context & Memory', icon: svgIcon('package') },
        subagents:   { label: g?.subagents   ?? 'Sub-Agents',       icon: svgIcon('bot') },
        other:       { label: g?.other       ?? 'Other',            icon: svgIcon('clipboard') },
    };

    return (Object.keys(groups) as TimelineGroupId[])
        .filter(id => groups[id].length > 0)
        .map(id => ({
            id,
            label: labels[id].label,
            icon: labels[id].icon,
            events: groups[id].sort((a, b) => a.sequence - b.sequence),
        }));
}

/**
 * Pairs tool_call_start and tool_call_end events by invocationId.
 */
export function pairToolEvents(events: TimelineEvent[]): Array<{
    start?: TimelineEvent;
    end?: TimelineEvent;
    invocationId: string;
    toolName: string;
    duration?: number;
    status: string;
}> {
    const map = new Map<string, { start?: TimelineEvent; end?: TimelineEvent }>();

    for (const evt of events) {
        if (!evt.invocationId) continue;
        if (!map.has(evt.invocationId)) map.set(evt.invocationId, {});
        const pair = map.get(evt.invocationId)!;
        if (evt.type === 'tool_call_start' || evt.type === 'tool_call_created') pair.start = evt;
        if (evt.type === 'tool_call_end') pair.end = evt;
    }

    return [...map.entries()].map(([invocationId, pair]) => ({
        start: pair.start,
        end: pair.end,
        invocationId,
        toolName: pair.start?.payload?.toolName || pair.start?.payload?.name || 'unknown',
        duration: pair.start && pair.end ? pair.end.timestamp - pair.start.timestamp : undefined,
        status: pair.end?.payload?.success === false ? 'failed'
            : pair.end ? 'done'
            : 'running',
    }));
}

/**
 * Groups events by agentId for sub-agent lane display.
 */
export function groupByAgentLane(events: TimelineEvent[]): Map<string, {
    agentId: string;
    status: string;
    events: TimelineEvent[];
}> {
    const lanes = new Map<string, { agentId: string; status: string; events: TimelineEvent[] }>();
    for (const evt of events) {
        const aid = evt.agentId ?? 'main';
        if (!lanes.has(aid)) lanes.set(aid, { agentId: aid, status: 'running', events: [] });
        lanes.get(aid)!.events.push(evt);
        if (evt.type === 'subagent_end') {
            lanes.get(aid)!.status = evt.payload?.status || 'done';
        }
    }
    return lanes;
}

/**
 * Renders timeline HTML for embedding in the Agent Manager webview.
 */
export function renderTimelineHTML(groups: TimelineGroup[], collapsible = false): string {
    let html = '<div class="run-timeline">';
    for (const group of groups) {
        const collapseAttr = collapsible ? ' tabindex="0" role="button"' : '';
        html += `<div class="timeline-group" data-group="${group.id}">`;
        html += `<h3 class="timeline-group-header"${collapseAttr}>${group.icon} ${group.label} <span class="count">(${group.events.length})</span></h3>`;
        html += '<ul class="timeline-events">';
        for (const evt of group.events) {
            const time = new Date(evt.timestamp).toLocaleTimeString();
            const statusBadge = evt.status ? `<span class="badge badge-${evt.status}">${evt.status}</span>` : '';
            const invId = evt.invocationId ? `<code class="inv-id">${evt.invocationId.substring(0, 12)}</code>` : '';
            html += `<li class="timeline-event" data-event-id="${evt.eventId}" data-type="${evt.type}">`;
            html += `<span class="event-time">${time}</span> `;
            html += `<span class="event-type">${evt.type}</span> `;
            html += `${invId} ${statusBadge}`;
            html += `</li>`;
        }
        html += '</ul></div>';
    }
    html += '</div>';
    return html;
}
