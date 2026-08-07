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

export type TimelineGroupId = 'model' | 'tools' | 'processes' | 'files' | 'permissions' | 'validation' | 'context' | 'activity' | 'scheduling' | 'subagents' | 'other';

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
    'process_started': 'processes',
    'process_output_delta': 'processes',
    'process_completed': 'processes',
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
    'policy_resolved': 'permissions',
    'approval_rule_created': 'permissions',
    'denial_feedback_emitted': 'permissions',
    'reviewer_decision': 'permissions',
    'reviewer_cache_invalidated': 'permissions',
    'sandbox_denied': 'subagents',
    'subagent_policy_derived': 'subagents',
    'mcp_tool_registered': 'tools',
    'worktree_created': 'files',
    'worktree_diff_collected': 'files',
    'worktree_cleaned': 'files',
    'evidence_gate_decision': 'validation',
    'admission_decided': 'scheduling',
    'phase_changed': 'scheduling',
    'capabilities_changed': 'scheduling',
    'prompt_queued': 'scheduling',
    'prompt_steered': 'scheduling',
    'dispatch_evaluated': 'scheduling',
    'agent_suspended': 'scheduling',
    'agent_requeued': 'scheduling',
    'provider_capacity_changed': 'scheduling',
    'route_outcome_evaluated': 'scheduling',
    'domain_op_applied': 'activity',
    'domain_replay_completed': 'activity',
    'goal_transitioned': 'activity',
    'goal_budget_exhausted': 'activity',
    'goal_continuation_queued': 'activity',
    'task_created': 'activity',
    'task_status_changed': 'activity',
    'task_notification_delivered': 'activity',
    'tool_disclosure_changed': 'tools',
    'tool_call_deduplicated': 'tools',
    'tool_repeat_escalated': 'tools',
    'context_limit_observed': 'context',
    'compaction_retry': 'context',
    'undo_started': 'activity',
    'undo_completed': 'activity',
    'side_question_started': 'activity',
    'side_question_completed': 'activity',
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
        processes: [],
        files: [],
        permissions: [],
        validation: [],
        context: [],
        activity: [],
        scheduling: [],
        subagents: [],
        other: [],
    };

    const canonicalItemKeys = new Set(events
        .filter(event => event.type === 'item_started' || event.type === 'item_updated' || event.type === 'item_completed')
        .map(event => `${event.payload?.type ?? 'toolCall'}:${event.payload?.itemId ?? event.invocationId ?? ''}`));

    for (const evt of events) {
        const processKey = `${'process'}:${evt.payload?.processId ?? evt.invocationId ?? ''}`;
        const permissionKey = `${'permission'}:${evt.invocationId ?? evt.payload?.itemId ?? ''}`;
        if (evt.type.startsWith('process_') && canonicalItemKeys.has(processKey)) continue;
        if (evt.type.startsWith('permission_') && canonicalItemKeys.has(permissionKey)) continue;
        const itemGroup: Partial<Record<string, TimelineGroupId>> = {
            process: 'processes', permission: 'permissions', fileChange: 'files', commandExecution: 'processes', toolCall: 'tools',
        };
        const groupId = evt.type.startsWith('item_')
            ? (itemGroup[evt.payload?.type] ?? 'tools')
            : (EVENT_GROUP_MAP[evt.type] ?? 'other');
        groups[groupId].push(evt);
    }

    const g = i18n?.runs?.groups;
    const labels: Record<TimelineGroupId, { label: string; icon: string }> = {
        model:       { label: g?.model       ?? 'Model Calls',      icon: svgIcon('sparkles') },
        tools:       { label: g?.tools       ?? 'Tool Invocations', icon: svgIcon('gear') },
        processes:   { label: g?.processes ?? 'Command Processes', icon: svgIcon('zap') },
        files:       { label: g?.files       ?? 'File Changes',     icon: svgIcon('file') },
        permissions: { label: g?.permissions ?? 'Permissions',      icon: svgIcon('shield') },
        validation:  { label: g?.validation  ?? 'Validation',       icon: svgIcon('check') },
        context:     { label: g?.context     ?? 'Context & Memory', icon: svgIcon('package') },
        activity:    { label: g?.activity    ?? 'Activity',         icon: svgIcon('clipboard') },
        scheduling:  { label: g?.scheduling  ?? 'Scheduling',       icon: svgIcon('gitBranch') },
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
 * Renders timeline HTML for embedding in the Agent Manager webview.
 */
export function renderTimelineHTML(groups: TimelineGroup[], collapsible = false, collapsedGroups?: ReadonlySet<string>): string {
    let html = '<div class="run-timeline">';
    for (const group of groups) {
        const collapseAttr = collapsible ? ' tabindex="0" role="button"' : '';
        const collapsed = collapsible && (collapsedGroups ? collapsedGroups.has(group.id) : true);
        html += `<div class="timeline-group${collapsed ? ' collapsed' : ''}" data-group="${group.id}">`;
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
