export type SlashCommandDuringRun = 'immediate' | 'queue' | 'deny';
export type SlashCommandCompletion = 'execute' | 'insert';
export type SlashCommandArgumentMode = 'none' | 'optional' | 'required';
export type SlashCommandRisk = 'safe' | 'stateful' | 'destructive';

export interface SlashCommandDescriptor {
    command: string;
    description: string;
    argumentHint?: string;
    argumentMode: SlashCommandArgumentMode;
    completion: SlashCommandCompletion;
    duringRun: SlashCommandDuringRun;
    risk: SlashCommandRisk;
    category: 'session' | 'goal' | 'workflow' | 'configuration';
}

export type SlashCommandId =
    | 'init'
    | 'clear'
    | 'compact'
    | 'sideQuestion'
    | 'goal'
    | 'goalComplete'
    | 'goalBlocked'
    | 'fork'
    | 'archive'
    | 'workflowList'
    | 'workflowSave'
    | 'workflowOff'
    | 'workflowSelect'
    | 'status'
    | 'model'
    | 'reasoning'
    | 'permissions';

export interface SlashCommandDefinition extends Omit<SlashCommandDescriptor, 'description' | 'argumentHint'> {
    id: SlashCommandId;
    description: { en: string; zh: string };
    argumentHint?: { en: string; zh: string };
    acceptsColonArgument?: boolean;
    visible?: boolean;
}

const DEFINITIONS: readonly SlashCommandDefinition[] = [
    {
        id: 'init', command: '/init', argumentMode: 'none', completion: 'execute', duringRun: 'deny', risk: 'destructive', category: 'session',
        description: { en: 'Initialize user-owned CWTOOLS.md instructions and build the project semantic knowledge pack', zh: '初始化用户维护的 CWTOOLS.md 指令并构建项目语义知识包' },
    },
    {
        id: 'clear', command: '/clear', argumentMode: 'none', completion: 'execute', duringRun: 'deny', risk: 'destructive', category: 'session',
        description: { en: 'Clear the current conversation and start a new topic', zh: '清空当前对话并开始新话题' },
    },
    {
        id: 'compact', command: '/compact', argumentMode: 'none', completion: 'execute', duringRun: 'deny', risk: 'stateful', category: 'session',
        description: { en: 'Compact active Agent context while keeping the topic transcript', zh: '压缩 Agent 活动上下文，同时保留话题记录' },
    },
    {
        id: 'sideQuestion', command: '/side', argumentMode: 'required', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'session',
        argumentHint: { en: '<question>', zh: '<问题>' },
        description: { en: 'Ask a tool-free question against the latest stable Agent snapshot without steering it', zh: '基于 Agent 最新稳定快照进行无工具旁路提问，不改变主任务' },
    },
    {
        id: 'goal', command: '/goal', argumentMode: 'required', completion: 'insert', duringRun: 'queue', risk: 'stateful', category: 'goal', acceptsColonArgument: true,
        argumentHint: { en: '<objective> or <token-budget>:<objective>', zh: '<目标> 或 <Token 预算>:<目标>' },
        description: { en: 'Set a durable goal for this topic', zh: '为当前话题设置持久目标' },
    },
    {
        id: 'goalComplete', command: '/goal:complete', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'stateful', category: 'goal',
        description: { en: 'Mark the durable goal complete', zh: '将持久目标标记为完成' },
    },
    {
        id: 'goalBlocked', command: '/goal:blocked', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'stateful', category: 'goal',
        description: { en: 'Mark the durable goal blocked', zh: '将持久目标标记为受阻' },
    },
    {
        id: 'fork', command: '/fork', argumentMode: 'none', completion: 'execute', duringRun: 'deny', risk: 'stateful', category: 'session',
        description: { en: 'Fork the conversation from the current point', zh: '从当前位置分叉对话' },
    },
    {
        id: 'archive', command: '/archive', argumentMode: 'none', completion: 'execute', duringRun: 'deny', risk: 'destructive', category: 'session',
        description: { en: 'Archive the current topic', zh: '归档当前话题' },
    },
    {
        id: 'workflowList', command: '/workflow:list', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'workflow',
        description: { en: 'Refresh the available AI workflows', zh: '刷新可用的 AI 工作流' },
    },
    {
        id: 'workflowSave', command: '/workflow:save', argumentMode: 'optional', completion: 'execute', duringRun: 'queue', risk: 'stateful', category: 'workflow', acceptsColonArgument: true,
        argumentHint: { en: '[workflow-id]', zh: '[工作流 ID]' },
        description: { en: 'Save this process as a reusable AI workflow', zh: '将当前过程保存为可复用 AI 工作流' },
    },
    {
        id: 'workflowOff', command: '/workflow:off', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'workflow',
        description: { en: 'Turn off the active AI workflow', zh: '关闭当前 AI 工作流' },
    },
    {
        id: 'workflowSelect', command: '/workflow', argumentMode: 'required', completion: 'insert', duringRun: 'immediate', risk: 'safe', category: 'workflow', acceptsColonArgument: true, visible: false,
        description: { en: 'Select an AI workflow', zh: '选择 AI 工作流' },
    },
    {
        id: 'status', command: '/status', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration',
        description: { en: 'Show the current model, scheduling state, workflow, and permissions', zh: '显示当前模型、调度状态、工作流与权限配置' },
    },
    {
        id: 'model', command: '/model', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration',
        description: { en: 'Choose the model for this session', zh: '选择当前会话使用的模型' },
    },
    {
        id: 'reasoning', command: '/reasoning', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration',
        description: { en: 'Choose the reasoning effort for this session', zh: '选择当前会话的推理强度' },
    },
    {
        id: 'permissions', command: '/permissions', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration',
        description: { en: 'Choose the permission profile for this session', zh: '选择当前会话的权限配置' },
    },
] as const;

export interface ResolvedSlashCommand {
    definition: SlashCommandDefinition;
    raw: string;
    argument: string;
}

function localized(value: { en: string; zh: string }, locale?: string): string {
    return (locale || '').toLowerCase().startsWith('zh') ? value.zh : value.en;
}

export function getSlashCommandDescriptors(locale?: string): SlashCommandDescriptor[] {
    return DEFINITIONS
        .filter(definition => definition.visible !== false)
        .map(definition => ({
            command: definition.command,
            description: localized(definition.description, locale),
            argumentHint: definition.argumentHint ? localized(definition.argumentHint, locale) : undefined,
            argumentMode: definition.argumentMode,
            completion: definition.completion,
            duringRun: definition.duringRun,
            risk: definition.risk,
            category: definition.category,
        }));
}

export function resolveSlashCommand(raw: string): ResolvedSlashCommand | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const body = (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).trim();
    const lowerBody = body.toLowerCase();
    const ordered = [...DEFINITIONS].sort((a, b) => b.command.length - a.command.length);

    for (const definition of ordered) {
        const name = definition.command.slice(1).toLowerCase();
        if (lowerBody === name) {
            return { definition, raw: trimmed.startsWith('/') ? trimmed : `/${trimmed}`, argument: '' };
        }
        if (definition.argumentMode !== 'none' && lowerBody.startsWith(`${name} `)) {
            return {
                definition,
                raw: trimmed.startsWith('/') ? trimmed : `/${trimmed}`,
                argument: body.slice(name.length).trim(),
            };
        }
        if (definition.acceptsColonArgument && lowerBody.startsWith(`${name}:`)) {
            return {
                definition,
                raw: trimmed.startsWith('/') ? trimmed : `/${trimmed}`,
                argument: body.slice(name.length + 1).trim(),
            };
        }
    }
    return undefined;
}

function levenshtein(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0]!;
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = previous[j]!;
            previous[j] = Math.min(
                previous[j]! + 1,
                previous[j - 1]! + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }
    return previous[b.length]!;
}

export function suggestSlashCommands(raw: string, locale?: string, limit = 3): SlashCommandDescriptor[] {
    const query = `/${raw.trim().replace(/^\//, '').toLowerCase().split(/[\s:]/, 1)[0]}`;
    return getSlashCommandDescriptors(locale)
        .map(command => {
            const candidate = command.command.toLowerCase();
            const score = candidate.startsWith(query)
                ? candidate.length - query.length
                : candidate.includes(query)
                    ? 20 + candidate.indexOf(query)
                    : 40 + levenshtein(query, candidate);
            return { command, score };
        })
        .sort((a, b) => a.score - b.score || a.command.command.localeCompare(b.command.command))
        .slice(0, Math.max(0, limit))
        .map(item => item.command);
}
