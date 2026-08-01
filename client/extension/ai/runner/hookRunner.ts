import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { ErrorReporter } from '../errorReporter';
import { getAiStorageRoot } from '../workspacePaths';
import { runtimeFaultInjector } from './faultInjection';

export type AgentHookEvent = 'userPromptSubmit' | 'preToolUse' | 'postToolUse' | 'stop';

export interface HookDefinition {
    command: string;
    tools?: string[];
}

export interface AgentHookResult {
    allowed: boolean;
    reason?: string;
    readonlyContext: string[];
    requestContinuation: boolean;
}

type HookConfiguration = Partial<Record<AgentHookEvent, HookDefinition[]>>;
const HOOK_FILE_MAX_BYTES = 64 * 1024;
const HOOK_TIMEOUT_MIN_MS = 100;
const HOOK_TIMEOUT_MAX_MS = 10_000;

const BUILTIN_SAFE_COMMANDS = new Set([
    'workbench.action.files.saveAll',
    'editor.action.formatDocument',
    'workbench.actions.view.problems',
]);

function isAllowedCommand(command: string): boolean {
    return command.startsWith('cwtools.') || BUILTIN_SAFE_COMMANDS.has(command);
}

async function executeHookWithTimeout(command: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            vs.commands.executeCommand(command, payload),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Hook timed out after ${timeoutMs}ms`)), timeoutMs);
                if (typeof timer.unref === 'function') timer.unref();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function loadConfiguration(): HookConfiguration | undefined {
    const root = getAiStorageRoot();
    if (!root) return undefined;
    const file = path.join(root, 'hooks.json');
    try {
        if (!fs.existsSync(file)) return undefined;
        if (fs.statSync(file).size > HOOK_FILE_MAX_BYTES) {
            ErrorReporter.warn('AgentHooks', 'Ignored .cwtools/hooks.json because it exceeds 64 KiB.');
            return undefined;
        }
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            ErrorReporter.warn('AgentHooks', 'Ignored .cwtools/hooks.json because its root is not an object.');
            return undefined;
        }
        const validEvents = new Set<AgentHookEvent>(['userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']);
        const validated: HookConfiguration = {};
        for (const [event, definitions] of Object.entries(raw as Record<string, unknown>)) {
            if (!validEvents.has(event as AgentHookEvent) || !Array.isArray(definitions)) continue;
            const hooks: HookDefinition[] = [];
            for (const candidate of definitions.slice(0, 10)) {
                if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
                const record = candidate as Record<string, unknown>;
                if (typeof record.command !== 'string' || record.command.length === 0 || record.command.length > 200) continue;
                const tools = Array.isArray(record.tools)
                    ? record.tools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0 && tool.length <= 100).slice(0, 50)
                    : undefined;
                hooks.push({ command: record.command, ...(tools?.length ? { tools } : {}) });
            }
            validated[event as AgentHookEvent] = hooks;
        }
        return validated;
    } catch (error) {
        ErrorReporter.warn('AgentHooks', 'Failed to read .cwtools/hooks.json', error);
        return undefined;
    }
}

/** Runs only explicitly enabled VS Code command hooks in trusted workspaces. */
export async function runAgentHooks(event: AgentHookEvent, payload: Record<string, unknown>): Promise<AgentHookResult> {
    const aggregate: AgentHookResult = { allowed: true, readonlyContext: [], requestContinuation: false };
    if (vs.workspace.isTrusted === false) return aggregate;
    if (typeof (vs.workspace as any).getConfiguration !== 'function') return aggregate;
    const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai.hooks');
    if (!config.get<boolean>('enabled', false)) return aggregate;
    const failureMode = config.get<'ignore' | 'block'>('failureMode', 'ignore');
    const timeoutMs = Math.max(HOOK_TIMEOUT_MIN_MS, Math.min(HOOK_TIMEOUT_MAX_MS, config.get<number>('timeoutMs', 2_000)));
    await runtimeFaultInjector.hit('before_hook');
    const hooks = loadConfiguration()?.[event] ?? [];
    for (const hook of hooks.slice(0, 10)) {
        if (!hook || !isAllowedCommand(hook.command)) {
            ErrorReporter.warn('AgentHooks', `Ignored non-allowlisted Agent hook command: ${hook?.command ?? '(missing)'}`);
            continue;
        }
        if (hook.tools?.length && typeof payload.toolName === 'string' && !hook.tools.includes(payload.toolName)) continue;
        try {
            const value: unknown = await executeHookWithTimeout(hook.command, { event, ...payload }, timeoutMs);
            if (!value || typeof value !== 'object') continue;
            const response = value as Record<string, unknown>;
            if (response.allowed === false) {
                aggregate.allowed = false;
                if (!aggregate.reason && typeof response.reason === 'string') aggregate.reason = response.reason.slice(0, 1_000);
            }
            if (typeof response.readonlyContext === 'string' && aggregate.readonlyContext.length < 10) {
                aggregate.readonlyContext.push(response.readonlyContext.slice(0, 4_000));
            }
            if (response.requestContinuation === true) aggregate.requestContinuation = true;
        } catch (error) {
            ErrorReporter.warn('AgentHooks', `Agent hook '${hook.command}' failed`, error);
            if (failureMode === 'block') {
                aggregate.allowed = false;
                aggregate.reason ??= `Agent hook '${hook.command}' failed under block-on-failure policy.`;
            }
        }
    }
    return aggregate;
}
