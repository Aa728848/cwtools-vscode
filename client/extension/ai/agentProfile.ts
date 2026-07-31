import type {
    AgentDomain,
    AgentExecutionStrategy,
    AgentIntent,
    AgentMode,
    AgentProfileSelection,
    AgentRuntimeDomain,
    ResolvedAgentProfile,
} from './types';
import {
    admissionFromResolvedProfile,
    schedulingStateFromAdmission,
} from './runner/scheduling';

export const DEFAULT_AGENT_PROFILE: Readonly<AgentProfileSelection> = Object.freeze({
    domain: 'paradox',
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

const PDX_REQUEST_RE = /\b(pdx|pdxscript|paradox|stellaris|eu4|hoi4|ck3|vic3|imperator|modding|clausewitz|cwt|cwtools|locali[sz]ation|sprite|sound asset|event chain|event id|scripted[ _](?:effect|trigger)|modifier|static_modifier|scripted_modifier|scope chain|common[\\/]|events?[\\/]|\.cwt|\.gui|\.gfx|\.asset)\b|群星|悖论|模组|事件号|事件\s*ID|本地化|事件链|作用域链|脚本触发器|脚本效果|修饰符/i;
const GENERAL_CODE_REQUEST_RE = /\b(typescript|javascript|python|rust|java|c#|f#|react|webview|extension host|api|unit test|integration test|typecheck|compiler|build config|package\.json|tsconfig|source code|codebase|repository code)\b|类型脚本|前端|后端|扩展宿主|单元测试|集成测试|编译|源码|代码库|仓库代码|项目代码|程序代码/i;
const WRITE_INTENT_RE = /\b(fix|repair|implement|add|create|generate|update|edit|modify|write|remove|delete|replace|rename|wire|migrate|refactor|apply|build|change|convert)\b|修复|实现|添加|新增|创建|生成|更新|修改|写入|移除|删除|接入|补齐|迁移|调整|执行|构建|替换|重命名|改名|换成|改成|改为|调整为|设为|改一下|改好|补上|加上|删掉/i;
const PLAN_INTENT_RE = /\b(plan|design|blueprint|proposal|architecture|roadmap)\b|计划|规划|方案|设计|蓝图|路线图|实施步骤/i;
const REVIEW_INTENT_RE = /\b(review|audit|triage|inspect|diagnose|diagnostic report|check for (?:issues|problems|bugs))\b|审查|评审|巡检|诊断报告|检查|核查|排查|评估|找问题|找出问题|有没有问题|是否有问题|看看.*问题/i;
const EXPLORE_INTENT_RE = /\b(explain|what is|how does|where is|find|search|locate|trace|analy[sz]e|investigate|understand|describe)\b|解释|说明|查找|搜索|定位|追踪|梳理|看看|了解|理解|分析|告诉我|是什么|为什么|怎么|如何|在哪里/i;
const NO_WRITE_INTENT_RE = /\b(?:do not|don't|without|no need to)\s+(?:change|edit|modify|write|implement)|\b(?:read[ -]?only|analysis only|review only|plan only)\b|(?:不要|无需|不需要|请勿|禁止)(?:[^，。；\n]{0,12})?(?:修改|改动|更改|写入|执行|实现|动代码)|(?:只|仅)(?:做|进行|需要)?(?:分析|解释|说明|审查|评审|检查|核查|排查|规划|计划|给方案|查看)(?:即可|就好|就行|，|。|；|$)|(?:算了|不改了|取消修改|先不改)/i;
const DIRECT_WRITE_OVERRIDE_RE = /\b(?:but|then)\s+(?:please\s+)?(?:change|edit|modify|write|implement)|\b(?:directly|immediately)\s+(?:change|edit|modify|write|implement)|(?:但|不过|然后|接着|之后|并且)[^，。；\n]{0,8}(?:修改|改动|更改|写入|执行|实现|修复)|(?:直接|马上|立即)(?:修改|改动|更改|写入|执行|实现|修复)/i;
const MULTI_AGENT_RE = /\b(multi(?:ple)?[-\s]?agents?|sub[-\s]?agents?|dispatch_agents|parallel agents?|in parallel)\b|多\s*agent|子\s*agent|并行.*agent|并行处理/i;
const BROAD_TASK_RE = /\b(all|every|entire|whole|across the (?:project|repository|workspace)|multi[-\s]?file|event chain|migration|large refactor)\b|全部|所有|整个项目|整个仓库|全项目|跨文件|多文件|事件链|批量|整套|大型重构|全面修复/i;
const PDX_PATH_RE = /(?:^|[\\/])(?:common|events?|interface|localisation|localization|gfx|sound|music|map|history|decisions|missions|on_actions)(?:[\\/]|$)|\.(?:cwt|gui|gfx|asset|entity)$/i;

export interface AgentProfileResolveHints {
    activeFile?: string;
    previousDomain?: AgentRuntimeDomain;
    previousUserRequests?: readonly string[];
}

export interface ModelAgentProfileDecision {
    domain: AgentRuntimeDomain;
    intent: Exclude<AgentIntent, 'auto'>;
    strategy: Exclude<AgentExecutionStrategy, 'auto'>;
    reason: string;
    confidence?: number;
    evidence?: string[];
}

export function cloneAgentProfile(profile: AgentProfileSelection = DEFAULT_AGENT_PROFILE): AgentProfileSelection {
    return {
        // `auto` is retained in the wire type only for legacy topic imports.
        // Capability domains are user-owned and default to Paradox.
        domain: profile.domain === 'general' ? 'general' : 'paradox',
        intent: profile.intent,
        strategy: profile.strategy,
        ...(profile.profileName ? { profileName: profile.profileName } : {}),
    };
}

/** Build the only profile exposed by the normal composer: domain is selectable; routing stays automatic. */
export function profileForUserDomain(domain: AgentDomain): AgentProfileSelection {
    return { domain: domain === 'general' ? 'general' : 'paradox', intent: 'auto', strategy: 'auto' };
}

export function sameAgentProfile(left: AgentProfileSelection, right: AgentProfileSelection): boolean {
    return left.domain === right.domain
        && left.intent === right.intent
        && left.strategy === right.strategy
        && left.profileName === right.profileName;
}

export function isAgentProfileSelection(value: unknown): value is AgentProfileSelection {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<AgentProfileSelection>;
    return DOMAINS.has(candidate.domain as AgentDomain)
        && INTENTS.has(candidate.intent as AgentIntent)
        && STRATEGIES.has(candidate.strategy as AgentExecutionStrategy)
        && (candidate.profileName === undefined
            || (typeof candidate.profileName === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(candidate.profileName)));
}

function schedulingForSelection(
    admission: ResolvedAgentProfile['admission'],
    selection: AgentProfileSelection,
): ResolvedAgentProfile['schedulingState'] {
    const schedulingState = schedulingStateFromAdmission(admission);
    return selection.profileName ? { ...schedulingState, profileName: selection.profileName } : schedulingState;
}

export function isAgentMode(value: unknown): value is AgentMode {
    return typeof value === 'string' && MODES.has(value as AgentMode);
}

export function isAgentRuntimeDomain(value: unknown): value is AgentRuntimeDomain {
    return value === 'paradox' || value === 'general';
}

export function normalizeAgentProfile(value: unknown): AgentProfileSelection {
    return isAgentProfileSelection(value) ? cloneAgentProfile(value) : cloneAgentProfile();
}

export function profileForLegacyMode(mode: AgentMode): AgentProfileSelection {
    switch (mode) {
        case 'plan': return { domain: 'paradox', intent: 'plan', strategy: 'single' };
        case 'explore': return { domain: 'paradox', intent: 'explore', strategy: 'single' };
        case 'review':
        case 'script_reviewer': return { domain: 'paradox', intent: 'review', strategy: 'single' };
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

export function parseModelAgentProfileDecision(raw: string): ModelAgentProfileDecision | undefined {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
    const objectText = fenced ?? /\{[\s\S]*\}/.exec(raw)?.[0];
    if (!objectText) return undefined;
    try {
        const parsed: unknown = JSON.parse(objectText);
        if (!parsed || typeof parsed !== 'object') return undefined;
        const candidate = parsed as Partial<ModelAgentProfileDecision>;
        if (!isAgentRuntimeDomain(candidate.domain)
            || !['execute', 'plan', 'explore', 'review'].includes(candidate.intent ?? '')
            || (candidate.strategy !== 'single' && candidate.strategy !== 'multi')) {
            return undefined;
        }
        const confidence = typeof candidate.confidence === 'number'
            ? Math.max(0, Math.min(1, candidate.confidence))
            : undefined;
        const evidence = Array.isArray(candidate.evidence)
            ? candidate.evidence.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 240)).slice(0, 8)
            : undefined;
        return {
            domain: candidate.domain,
            intent: candidate.intent as ModelAgentProfileDecision['intent'],
            strategy: candidate.strategy,
            reason: typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 240) : '',
            ...(confidence !== undefined ? { confidence } : {}),
            ...(evidence !== undefined ? { evidence } : {}),
        };
    } catch {
        return undefined;
    }
}

export function resolveAgentProfileFromModelDecision(
    text: string,
    profile: AgentProfileSelection,
    decision: ModelAgentProfileDecision,
    hints: AgentProfileResolveHints = {},
): ResolvedAgentProfile {
    const selection = normalizeAgentProfile(profile);
    const fallback = resolveAgentProfile(text, selection, hints);
    const routeConfidence = decision.confidence ?? 0.65;
    const keepPreviousDomain = selection.domain === 'auto'
        && !!hints.previousDomain
        && decision.domain !== hints.previousDomain
        && routeConfidence < 0.8
        && fallback.domain === hints.previousDomain;
    // Apply hysteresis only when the deterministic route has no strong
    // evidence for switching domains. Explicit file/language semantics in the
    // fallback still switch immediately.
    const domain = selection.domain === 'auto'
        ? (keepPreviousDomain ? hints.previousDomain! : decision.domain)
        : selection.domain;
    const explicitNoWrite = NO_WRITE_INTENT_RE.test(text) && !DIRECT_WRITE_OVERRIDE_RE.test(text);
    const directWriteRequested = DIRECT_WRITE_OVERRIDE_RE.test(text);
    const terseModificationAnswer = text.trim().length <= 80
        && (hints.previousUserRequests?.length ?? 0) > 0
        && fallback.intent === 'execute'
        && !PLAN_INTENT_RE.test(text);
    const routedIntent = explicitNoWrite
        ? fallback.intent
        : directWriteRequested || terseModificationAnswer
            ? 'execute'
            : fallback.intent === 'execute' && (decision.intent === 'explore' || decision.intent === 'review')
                ? 'execute'
            : decision.intent;
    const intent = selection.intent === 'auto' ? routedIntent : selection.intent;
    const mutationAuthorizedPlan = intent === 'plan'
        && fallback.intent === 'execute'
        && !explicitNoWrite;
    // Existing multi-Agent modes are execution coordinators. Keep read-only and
    // plan turns on their dedicated safety modes even if a router returns multi.
    // Multi-Agent is a runtime optimization. Automatic model routing may
    // recommend it, but only an explicit user request commits at admission;
    // broad tasks can still dispatch after repository-backed decomposition.
    const selectedStrategy = selection.strategy === 'auto'
        ? (MULTI_AGENT_RE.test(text) ? 'multi' : 'single')
        : selection.strategy;
    const strategy = intent === 'execute' ? selectedStrategy : 'single';
    const base = {
        selection,
        domain,
        intent,
        strategy,
        mode: mutationAuthorizedPlan
            ? resolveMode(domain, 'execute', 'single')
            : resolveMode(domain, intent, strategy),
        reason: `model routing${decision.reason ? `: ${decision.reason}` : ''}; fallback=${fallback.mode}`
            + (keepPreviousDomain ? '; domain switch deferred by routing hysteresis' : ''),
    };
    const admission = admissionFromResolvedProfile(
        base,
        routeConfidence,
        decision.evidence ?? [decision.reason || 'model-assisted routing'],
        mutationAuthorizedPlan ? 'workspace_write' : undefined,
    );
    return { ...base, admission, schedulingState: schedulingForSelection(admission, selection) };
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
        ? (hasGeneralCodeText ? 'general' : hasPdxText ? 'paradox' : hasPdxFile ? 'paradox' : hints.previousDomain ?? 'general')
        : selection.domain;

    const explicitNoWrite = NO_WRITE_INTENT_RE.test(request) && !DIRECT_WRITE_OVERRIDE_RE.test(request);
    const explicitReadOnlyIntent = PLAN_INTENT_RE.test(request) || REVIEW_INTENT_RE.test(request) || EXPLORE_INTENT_RE.test(request);
    const inheritedWriteIntent = request.length <= 80
        && !explicitNoWrite
        && !explicitReadOnlyIntent
        && (hints.previousUserRequests ?? []).slice(-3).some(previous => {
            const previousNoWrite = NO_WRITE_INTENT_RE.test(previous) && !DIRECT_WRITE_OVERRIDE_RE.test(previous);
            return !previousNoWrite && WRITE_INTENT_RE.test(previous);
        });
    const hasWriteIntent = !explicitNoWrite && (WRITE_INTENT_RE.test(request) || inheritedWriteIntent);
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
        strategy = explicitMulti ? 'multi' : 'single';
    }
    if (intent !== 'execute') strategy = 'single';

    const mode = resolveMode(domain, intent, strategy);
    const domainReason = selection.domain === 'auto'
        ? hasGeneralCodeText ? 'general code semantics' : hasPdxText ? 'request semantics' : hasPdxFile ? 'active Paradox file' : hints.previousDomain ? 'conversation continuity' : 'general workspace task'
        : 'user selection';
    const intentReason = selection.intent === 'auto' ? 'request intent' : 'user selection';
    const strategyReason = selection.strategy === 'auto' ? 'task scope' : 'user selection';

    const base = {
        selection,
        domain,
        intent,
        strategy,
        mode,
        reason: `domain: ${domainReason}; intent: ${intentReason}; strategy: ${strategyReason}${BROAD_TASK_RE.test(request) ? '; runtime dispatch evaluation requested' : ''}`,
    };
    const confidence = selection.domain !== 'auto'
        ? 1
        : hasGeneralCodeText || hasPdxText
            ? 0.9
            : hasPdxFile
                ? 0.8
                : hints.previousDomain
                    ? 0.7
                    : 0.55;
    const evidence = [
        `domain: ${domainReason}`,
        `intent: ${intentReason}`,
        `strategy: ${strategyReason}`,
        ...(BROAD_TASK_RE.test(request) ? ['broad task requires runtime decomposition'] : []),
    ];
    const admission = admissionFromResolvedProfile(base, confidence, evidence);
    return { ...base, admission, schedulingState: schedulingForSelection(admission, selection) };
}
