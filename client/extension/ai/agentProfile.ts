import type {
    AgentDomain,
    AgentExecutionStrategy,
    AgentIntent,
    AgentMode,
    AgentProfileSelection,
    AgentRuntimeDomain,
    ResolvedAgentProfile,
} from './types';

export const DEFAULT_AGENT_PROFILE: Readonly<AgentProfileSelection> = Object.freeze({
    domain: 'auto',
    intent: 'auto',
    strategy: 'auto',
});

const DOMAINS = new Set<AgentDomain>(['auto', 'paradox', 'general']);
const INTENTS = new Set<AgentIntent>(['auto', 'execute', 'plan', 'explore', 'review']);
const STRATEGIES = new Set<AgentExecutionStrategy>(['auto', 'single', 'multi']);
const MODES = new Set<AgentMode>([
    'build', 'plan', 'explore', 'general', 'utility', 'review', 'gui_expert',
    'script_reviewer', 'loc_translator', 'loc_writer', 'orchestrator', 'script',
]);

const PDX_REQUEST_RE = /\b(pdx|pdxscript|paradox|stellaris|eu4|hoi4|ck3|vic3|imperator|cwt|cwtools|locali[sz]ation|sprite|sound asset|event chain|scripted[ _](?:effect|trigger)|modifier|static_modifier|scripted_modifier|scope chain|common[\\/]|events?[\\/]|\.cwt|\.gui|\.gfx|\.asset)\b|群星|悖论|本地化|事件链|作用域链|脚本触发器|脚本效果|修饰符/i;
const GENERAL_CODE_REQUEST_RE = /\b(typescript|javascript|python|rust|java|c#|f#|react|webview|extension host|api|unit test|integration test|typecheck|compiler|build config|package\.json|tsconfig|source code)\b|类型脚本|前端|后端|扩展宿主|单元测试|集成测试|编译|源码|代码库/i;
const WRITE_INTENT_RE = /\b(fix|repair|implement|add|create|generate|update|edit|modify|write|remove|wire|migrate|refactor|apply|build|change)\b|修复|实现|添加|创建|生成|更新|修改|写入|移除|删除|接入|补齐|迁移|调整|执行|构建|改一下|改好/i;
const PLAN_INTENT_RE = /\b(plan|design|blueprint|proposal|architecture)\b|计划|规划|方案|设计|蓝图/i;
const REVIEW_INTENT_RE = /\b(review|audit|triage|inspect|diagnose|diagnostic report)\b|审查|评审|巡检|诊断报告|找问题|看看.*问题/i;
const EXPLORE_INTENT_RE = /\b(explain|what is|how does|where is|find|search|locate|trace|analy[sz]e|investigate)\b|解释|查找|搜索|定位|追踪|梳理|看看|了解|分析/i;
const MULTI_AGENT_RE = /\b(multi(?:ple)?[-\s]?agents?|sub[-\s]?agents?|dispatch_agents|parallel agents?|in parallel)\b|多\s*agent|子\s*agent|并行.*agent|并行处理/i;
const BROAD_TASK_RE = /\b(all|entire|whole|across the (?:project|repository|workspace)|multi[-\s]?file|event chain|migration|large refactor)\b|全部|整个项目|整个仓库|全项目|多文件|事件链|批量|大型重构|全面修复/i;
const PDX_PATH_RE = /(?:^|[\\/])(?:common|events?|interface|localisation|localization|gfx|sound|music|map|history|decisions|missions|on_actions)(?:[\\/]|$)|\.(?:cwt|gui|gfx|asset|entity)$/i;

export interface AgentProfileResolveHints {
    activeFile?: string;
}

export function cloneAgentProfile(profile: AgentProfileSelection = DEFAULT_AGENT_PROFILE): AgentProfileSelection {
    return { domain: profile.domain, intent: profile.intent, strategy: profile.strategy };
}

export function sameAgentProfile(left: AgentProfileSelection, right: AgentProfileSelection): boolean {
    return left.domain === right.domain && left.intent === right.intent && left.strategy === right.strategy;
}

export function isAgentProfileSelection(value: unknown): value is AgentProfileSelection {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<AgentProfileSelection>;
    return DOMAINS.has(candidate.domain as AgentDomain)
        && INTENTS.has(candidate.intent as AgentIntent)
        && STRATEGIES.has(candidate.strategy as AgentExecutionStrategy);
}

export function isAgentMode(value: unknown): value is AgentMode {
    return typeof value === 'string' && MODES.has(value as AgentMode);
}

export function normalizeAgentProfile(value: unknown): AgentProfileSelection {
    return isAgentProfileSelection(value) ? cloneAgentProfile(value) : cloneAgentProfile();
}

export function profileForLegacyMode(mode: AgentMode): AgentProfileSelection {
    switch (mode) {
        case 'plan': return { domain: 'auto', intent: 'plan', strategy: 'single' };
        case 'explore': return { domain: 'auto', intent: 'explore', strategy: 'single' };
        case 'review':
        case 'script_reviewer': return { domain: 'auto', intent: 'review', strategy: 'single' };
        case 'utility':
        case 'general': return { domain: 'general', intent: 'execute', strategy: 'single' };
        case 'orchestrator': return { domain: 'general', intent: 'execute', strategy: 'multi' };
        case 'script': return { domain: 'paradox', intent: 'execute', strategy: 'multi' };
        case 'gui_expert':
        case 'loc_translator':
        case 'loc_writer':
        case 'build':
        default: return { domain: 'paradox', intent: 'execute', strategy: 'single' };
    }
}

/**
 * Compatibility fallback for callers and snapshots that predate explicit
 * runtime domains. Shared read-only modes historically meant Paradox unless a
 * resolved profile says otherwise; preserving that default avoids silently
 * removing CWT/LSP capabilities from old topics.
 */
export function defaultDomainForMode(mode: AgentMode): AgentRuntimeDomain {
    switch (mode) {
        case 'general':
        case 'utility':
        case 'orchestrator':
            return 'general';
        default:
            return 'paradox';
    }
}

function resolveMode(
    domain: ResolvedAgentProfile['domain'],
    intent: ResolvedAgentProfile['intent'],
    strategy: ResolvedAgentProfile['strategy'],
): AgentMode {
    if (strategy === 'multi') return domain === 'paradox' ? 'script' : 'orchestrator';
    if (intent === 'plan') return 'plan';
    if (intent === 'explore') return 'explore';
    if (intent === 'review') return 'review';
    return domain === 'paradox' ? 'build' : 'utility';
}

export function resolveAgentProfile(
    text: string,
    profile: AgentProfileSelection = cloneAgentProfile(),
    hints: AgentProfileResolveHints = {},
): ResolvedAgentProfile {
    const selection = normalizeAgentProfile(profile);
    const request = text.trim();
    const hasPdxText = PDX_REQUEST_RE.test(request);
    const hasGeneralCodeText = GENERAL_CODE_REQUEST_RE.test(request);
    const hasPdxFile = !!hints.activeFile && PDX_PATH_RE.test(hints.activeFile.replace(/\\/g, '/'));
    const domain: ResolvedAgentProfile['domain'] = selection.domain === 'auto'
        // Explicit repository-language/framework semantics describe the file being
        // changed and therefore outrank incidental mentions of Paradox/CWTools.
        ? (hasGeneralCodeText ? 'general' : hasPdxText ? 'paradox' : hasPdxFile ? 'paradox' : 'general')
        : selection.domain;

    const hasWriteIntent = WRITE_INTENT_RE.test(request);
    let intent: ResolvedAgentProfile['intent'];
    if (selection.intent !== 'auto') {
        intent = selection.intent;
    } else if (!hasWriteIntent && PLAN_INTENT_RE.test(request)) {
        intent = 'plan';
    } else if (!hasWriteIntent && REVIEW_INTENT_RE.test(request)) {
        intent = 'review';
    } else if (!hasWriteIntent && EXPLORE_INTENT_RE.test(request)) {
        intent = 'explore';
    } else {
        intent = hasWriteIntent ? 'execute' : 'explore';
    }

    let strategy: ResolvedAgentProfile['strategy'];
    if (selection.strategy !== 'auto') {
        strategy = selection.strategy;
    } else {
        const explicitMulti = MULTI_AGENT_RE.test(request);
        const broadExecution = intent === 'execute' && BROAD_TASK_RE.test(request);
        strategy = explicitMulti || broadExecution ? 'multi' : 'single';
    }

    const mode = resolveMode(domain, intent, strategy);
    const domainReason = selection.domain === 'auto'
        ? hasGeneralCodeText ? 'general code semantics' : hasPdxText ? 'request semantics' : hasPdxFile ? 'active Paradox file' : 'general workspace task'
        : 'user selection';
    const intentReason = selection.intent === 'auto' ? 'request intent' : 'user selection';
    const strategyReason = selection.strategy === 'auto' ? 'task scope' : 'user selection';

    return {
        selection,
        domain,
        intent,
        strategy,
        mode,
        reason: `domain: ${domainReason}; intent: ${intentReason}; strategy: ${strategyReason}`,
    };
}
