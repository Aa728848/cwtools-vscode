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
    category: 'session' | 'goal' | 'configuration' | 'skill';
}

/**
 * An installed Agent skill offered as `/skill:<name>`. The Host builds these
 * from `listSkills` when it delivers the command catalog, so a skill saved in the
 * current session shows up without reloading the Webview.
 */
export interface SkillSlashCatalogEntry {
    /** Skill name as reported by `listSkills`; `loadSkill` matches it case-insensitively. */
    name: string;
    /** Frontmatter description (or first body line). Untrusted SKILL.md text. */
    description: string;
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
    | 'skill'
    | 'status'
    | 'model'
    | 'reasoning'
    | 'permissions'
    | 'modePlan'
    | 'modeExecute'
    | 'modeExplore'
    | 'modeReview'
    | 'modeAuto';

export interface SlashCommandDefinition extends Omit<SlashCommandDescriptor, 'description' | 'argumentHint'> {
    id: SlashCommandId;
    description: { en: string; zh: string };
    argumentHint?: { en: string; zh: string };
    acceptsColonArgument?: boolean;
    visible?: boolean;
}

/** Shared by `/skill` and every generated `/skill:<name>` entry. */
const SKILL_ARGUMENT_HINT: { en: string; zh: string } = {
    en: '<skill-name> [arguments]',
    zh: '<技能名> [参数]',
};

/**
 * A skill is only advertised as `/skill:<name>` when its name survives the round
 * trip through the colon form, i.e. it carries no whitespace or separator that
 * would make the parser read part of the name back as skill arguments.
 */
const SKILL_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;

const DEFINITIONS: readonly SlashCommandDefinition[] = [    {
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
        id: 'skill', command: '/skill', argumentMode: 'required', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'skill', acceptsColonArgument: true,
        argumentHint: SKILL_ARGUMENT_HINT,
        description: { en: 'Load an installed Agent skill into this turn and work under its SKILL.md', zh: '将已安装的 Agent 技能载入本轮对话并按其 SKILL.md 执行' },
    },
    {
        id: 'status', command: '/status', argumentMode: 'none', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration',
        description: { en: 'Show the current model, scheduling state, and permissions', zh: '显示当前模型、调度状态与权限配置' },
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
    {
        id: 'modeAuto', command: '/mode', argumentMode: 'optional', completion: 'execute', duringRun: 'immediate', risk: 'safe', category: 'configuration', acceptsColonArgument: true,
        argumentHint: { en: '[auto|plan|execute|explore|review]', zh: '[auto|plan|execute|explore|review]' },
        description: { en: 'Set this session task mode (default auto: the Agent decides per request)', zh: '设置当前会话的任务模式（默认 auto：由 Agent 按请求自行判断）' },
    },
    {
        id: 'modePlan', command: '/plan', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'safe', category: 'configuration',
        description: { en: 'Force Plan mode: investigate and produce a plan for approval', zh: '强制进入计划模式：调研并产出待批准的计划' },
    },
    {
        id: 'modeExecute', command: '/execute', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'safe', category: 'configuration',
        description: { en: 'Force Execute mode: apply changes directly', zh: '强制进入执行模式：直接应用改动' },
    },
    {
        id: 'modeExplore', command: '/explore', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'safe', category: 'configuration',
        description: { en: 'Force Explore mode: read-only investigation', zh: '强制进入探索模式：只读调研' },
    },
    {
        id: 'modeReview', command: '/review', argumentMode: 'none', completion: 'execute', duringRun: 'queue', risk: 'safe', category: 'configuration',
        description: { en: 'Force Review mode: read-only audit and diagnosis', zh: '强制进入审查模式：只读审计与诊断' },
    },
] as const;

export interface ResolvedSlashCommand {
    definition: SlashCommandDefinition;
    raw: string;
    /**
     * Text supplied after the command token. For `/skill` this is only the
     * skill arguments: the name itself is reported through `skillName` so a
     * colon-form invocation like `/skill:<name> [arguments]` keeps the same
     * shape as the space form `/skill <name> [arguments]`.
     */
    argument: string;
    /** Skill name requested by `/skill`; undefined for every other command. */
    skillName?: string;
}

function localized(value: { en: string; zh: string }, locale?: string): string {
    return (locale || '').toLowerCase().startsWith('zh') ? value.zh : value.en;
}

/**
 * Split the `/skill` payload into the skill name and its arguments. Every other
 * command keeps the generic "everything after the command token" semantics.
 */
function splitSkillInvocation(
    definition: SlashCommandDefinition,
    argument: string,
): { argument: string; skillName?: string } {
    if (definition.id !== 'skill' || !argument) return { argument };
    const separator = argument.search(/\s/);
    if (separator < 0) return { argument: '', skillName: argument };
    return { skillName: argument.slice(0, separator), argument: argument.slice(separator).trim() };
}

/**
 * Expand the installed skills into `/skill:<name>` catalog rows. They are
 * appended to the static table rather than parsed from it, so the Webview
 * completion picks them up with no Webview-side command synthesis.
 */
function buildSkillSlashDescriptors(
    skills: readonly SkillSlashCatalogEntry[],
    locale?: string,
): SlashCommandDescriptor[] {
    const descriptors: SlashCommandDescriptor[] = [];
    const seen = new Set<string>();
    for (const skill of skills) {
        const name = skill.name.trim();
        if (!name || !SKILL_COMMAND_NAME.test(name)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const descriptionText = (skill.description ?? '').trim();
        const summary = descriptionText.replace(/\s+/g, ' ').slice(0, 160);
        const label = localized(
            { en: `Load Agent skill "${name}"`, zh: `载入 Agent 技能“${name}”` },
            locale,
        );
        const separator = localized({ en: ': ', zh: '：' }, locale);
        descriptors.push({
            command: `/skill:${name}`,
            description: summary ? `${label}${separator}${summary}` : label,
            argumentHint: localized(SKILL_ARGUMENT_HINT, locale),
            argumentMode: 'required',
            completion: 'execute',
            duringRun: 'immediate',
            risk: 'safe',
            category: 'skill',
        });
    }
    return descriptors;
}

export function getSlashCommandDescriptors(
    locale?: string,
    skills: readonly SkillSlashCatalogEntry[] = [],
): SlashCommandDescriptor[] {
    const staticCommands = DEFINITIONS
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
    return [...staticCommands, ...buildSkillSlashDescriptors(skills, locale)];
}

export function resolveSlashCommand(raw: string): ResolvedSlashCommand | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const body = (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).trim();
    const lowerBody = body.toLowerCase();
    const ordered = [...DEFINITIONS].sort((a, b) => b.command.length - a.command.length);

    const normalizedRaw = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    for (const definition of ordered) {
        const name = definition.command.slice(1).toLowerCase();
        if (lowerBody === name) {
            return { definition, raw: normalizedRaw, ...splitSkillInvocation(definition, '') };
        }
        if (definition.argumentMode !== 'none' && lowerBody.startsWith(`${name} `)) {
            return { definition, raw: normalizedRaw, ...splitSkillInvocation(definition, body.slice(name.length).trim()) };
        }
        if (definition.acceptsColonArgument && lowerBody.startsWith(`${name}:`)) {
            return { definition, raw: normalizedRaw, ...splitSkillInvocation(definition, body.slice(name.length + 1).trim()) };
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
