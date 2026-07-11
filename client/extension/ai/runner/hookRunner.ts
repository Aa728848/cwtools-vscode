import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { ErrorReporter } from '../errorReporter';
import { getAiStorageRoot } from '../workspacePaths';

export type AgentHookEvent = 'userPromptSubmit' | 'preToolUse' | 'postToolUse' | 'stop';

interface HookDefinition {
    command: string;
    tools?: string[];
}

type HookConfiguration = Partial<Record<AgentHookEvent, HookDefinition[]>>;

const BUILTIN_SAFE_COMMANDS = new Set([
    'workbench.action.files.saveAll',
    'editor.action.formatDocument',
    'workbench.actions.view.problems',
]);

function isAllowedCommand(command: string): boolean {
    return command.startsWith('cwtools.') || BUILTIN_SAFE_COMMANDS.has(command);
}

function loadConfiguration(): HookConfiguration | undefined {
    const root = getAiStorageRoot();
    if (!root) return undefined;
    const file = path.join(root, 'hooks.json');
    try {
        if (!fs.existsSync(file)) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8')) as HookConfiguration;
    } catch (error) {
        ErrorReporter.warn('AgentHooks', 'Failed to read .cwtools-ai/hooks.json', error);
        return undefined;
    }
}

/** Runs only explicitly enabled VS Code command hooks in trusted workspaces. */
export async function runAgentHooks(event: AgentHookEvent, payload: Record<string, unknown>): Promise<void> {
    if (vs.workspace.isTrusted === false) return;
    if (typeof (vs.workspace as any).getConfiguration !== 'function') return;
    if (!vs.workspace.getConfiguration('stellarisLanguageServices.ai.hooks').get<boolean>('enabled', false)) return;
    const hooks = loadConfiguration()?.[event] ?? [];
    for (const hook of hooks.slice(0, 10)) {
        if (!hook || !isAllowedCommand(hook.command)) {
            ErrorReporter.warn('AgentHooks', `Ignored non-allowlisted Agent hook command: ${hook?.command ?? '(missing)'}`);
            continue;
        }
        if (hook.tools?.length && typeof payload.toolName === 'string' && !hook.tools.includes(payload.toolName)) continue;
        try {
            await vs.commands.executeCommand(hook.command, { event, ...payload });
        } catch (error) {
            ErrorReporter.warn('AgentHooks', `Agent hook '${hook.command}' failed`, error);
        }
    }
}
