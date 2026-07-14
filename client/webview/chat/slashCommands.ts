import { escapeHtml } from './formatters';
import { getWorkflowSlashCommand, type WorkflowView } from './workflows';

export interface SlashCommandView {
    command: string;
    description: string;
    argumentHint?: string;
    argumentMode: 'none' | 'optional' | 'required';
    completion: 'execute' | 'insert';
    duringRun: 'immediate' | 'queue' | 'deny';
    risk: 'safe' | 'stateful' | 'destructive';
    category: 'session' | 'goal' | 'mode' | 'workflow' | 'configuration';
}

export function buildSlashCommands(
    hostCommands: SlashCommandView[],
    workflows: WorkflowView[],
): SlashCommandView[] {
    const workflowCommands = workflows.map(workflow => ({
        command: getWorkflowSlashCommand(workflow.id),
        description: workflow.description || workflow.title,
        argumentMode: 'none' as const,
        completion: 'execute' as const,
        duringRun: 'immediate' as const,
        risk: 'safe' as const,
        category: 'workflow' as const,
    }));
    const unique = new Map<string, SlashCommandView>();
    for (const command of [...hostCommands, ...workflowCommands]) {
        unique.set(command.command.toLowerCase(), command);
    }
    return [...unique.values()];
}

/** Return the command-token filter, or null once the user has started entering arguments. */
export function getSlashCommandFilter(input: string): string | null {
    const trimmedStart = input.trimStart();
    if (!trimmedStart.startsWith('/')) return null;
    const firstLine = trimmedStart.split(/\r?\n/, 1)[0] ?? '';
    if (/\s/.test(firstLine)) return null;
    return firstLine;
}

export function filterSlashCommands(commands: SlashCommandView[], filter: string): SlashCommandView[] {
    const query = filter.toLowerCase();
    return commands
        .map((command, originalIndex) => {
            const candidate = command.command.toLowerCase();
            const score = candidate === query
                ? 0
                : candidate.startsWith(query)
                    ? 10 + candidate.length - query.length
                    : candidate.includes(query)
                        ? 100 + candidate.indexOf(query)
                        : Number.POSITIVE_INFINITY;
            return { command, originalIndex, score };
        })
        .filter(item => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || a.originalIndex - b.originalIndex)
        .map(item => item.command);
}

export function renderSlashCommandItems(commands: SlashCommandView[], selectedIndex = 0): string {
    return commands.map((command, index) => {
        const meta = command.argumentHint || (command.duringRun === 'queue' ? 'queue' : '');
        const selected = index === selectedIndex;
        return `<button type="button" id="slash-option-${index}" class="slash-popup-item${selected ? ' selected' : ''}" role="option" aria-selected="${selected ? 'true' : 'false'}" data-index="${index}" data-command="${escapeHtml(command.command)}"><span class="slash-popup-cmd">${escapeHtml(command.command)}</span><span class="slash-popup-desc">${escapeHtml(command.description)}</span>${meta ? `<span class="slash-popup-meta">${escapeHtml(meta)}</span>` : ''}</button>`;
    }).join('');
}
