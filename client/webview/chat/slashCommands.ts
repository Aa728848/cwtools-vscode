import { escapeHtml } from './formatters';
import { getWorkflowSlashCommand, type WorkflowView } from './workflows';

export interface SlashCommandView {
    cmd: string;
    desc: string;
}

const BASE_SLASH_COMMANDS = [
    '/init',
    '/clear',
    '/fork',
    '/archive',
    '/workflow:list',
    '/workflow:save',
    '/workflow:off',
    '/mode:build',
    '/mode:plan',
    '/mode:explore',
    '/mode:utility',
    '/mode:review',
    '/mode:orchestrator',
];

export function buildSlashCommands(
    descriptions: Record<string, string>,
    workflows: WorkflowView[]
): SlashCommandView[] {
    const base = BASE_SLASH_COMMANDS.map(cmd => ({ cmd, desc: descriptions[cmd] ?? cmd }));
    const workflowCommands = workflows.map(workflow => ({
        cmd: getWorkflowSlashCommand(workflow.id),
        desc: workflow.description || workflow.title,
    }));
    return [...base, ...workflowCommands];
}

export function filterSlashCommands(commands: SlashCommandView[], filter: string): SlashCommandView[] {
    const query = filter.toLowerCase();
    return commands.filter(command => command.cmd.toLowerCase().includes(query));
}

export function renderSlashCommandItems(commands: SlashCommandView[]): string {
    return commands.map(command =>
        `<div class="slash-popup-item" data-cmd="${escapeHtml(command.cmd)}"><span class="slash-popup-cmd">${escapeHtml(command.cmd)}</span><span class="slash-popup-desc">${escapeHtml(command.desc)}</span></div>`
    ).join('');
}
