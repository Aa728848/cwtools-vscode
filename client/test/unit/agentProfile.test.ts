import { expect } from 'chai';
import {
    DEFAULT_AGENT_PROFILE,
    isAgentProfileSelection,
    parseModelAgentProfileDecision,
    profileForUserDomain,
    profileForLegacyMode,
    resolveAgentProfile,
    resolveAgentProfileFromModelDecision,
    shouldUseSemanticAgentRouting,
} from '../../extension/ai/agentProfile';

describe('agent profile', () => {
    it('validates all three runtime dimensions at the boundary', () => {
        expect(isAgentProfileSelection(DEFAULT_AGENT_PROFILE)).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute', strategy: 'multi' })).to.equal(true);
        expect(isAgentProfileSelection({
            domain: 'general',
            intent: 'execute',
            strategy: 'multi',
            profileName: 'workspace-reviewer',
        })).to.equal(true);
        expect(isAgentProfileSelection({
            domain: 'general',
            intent: 'execute',
            strategy: 'multi',
            profileName: '../unsafe',
        })).to.equal(false);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'build', strategy: 'multi' })).to.equal(false);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute' })).to.equal(false);
    });

    it('exposes only domain selection while keeping intent and strategy automatic', () => {
        expect(profileForUserDomain('paradox')).to.deep.equal({
            domain: 'paradox', intent: 'auto', strategy: 'auto',
        });
        expect(profileForUserDomain('general')).to.deep.equal({
            domain: 'general', intent: 'auto', strategy: 'auto',
        });
        expect(profileForUserDomain('auto')).to.deep.equal({
            domain: 'paradox', intent: 'auto', strategy: 'auto',
        });
    });

    it('parses strict model routing decisions from plain or fenced JSON', () => {
        expect(parseModelAgentProfileDecision(
            '```json\n{"domain":"paradox","intent":"execute","strategy":"multi","reason":" broad task "}\n```',
        )).to.deep.equal({ intent: 'execute', strategy: 'multi', requiresUserDecision: false, reason: 'broad task' });
        expect(parseModelAgentProfileDecision(
            `{"domain":"general","intent":"explore","strategy":"single","reason":"${'x'.repeat(300)}"}`,
        )?.reason).to.have.length(240);
        expect(parseModelAgentProfileDecision(
            '{"domain":"general","intent":"build","strategy":"single"}',
        )).to.equal(undefined);
        expect(parseModelAgentProfileDecision(
            '{"domain":"unknown","intent":"execute","strategy":"single"}',
        )).to.deep.equal({ intent: 'execute', strategy: 'single', requiresUserDecision: false, reason: '' });
        expect(parseModelAgentProfileDecision(
            '{"intent":"execute","strategy":"single","requiresUserDecision":"yes"}',
        )).to.equal(undefined);
    });

    it('uses model intent while the selected domain remains user-owned', () => {
        expect(resolveAgentProfileFromModelDecision('large change', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'multi', requiresUserDecision: false, reason: 'independent workstreams',
        })).to.include({ domain: 'paradox', intent: 'execute', strategy: 'single', mode: 'build' });
        expect(resolveAgentProfileFromModelDecision('use multiple agents for this mod change', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'multi', requiresUserDecision: false, reason: 'independent workstreams',
        })).to.include({ domain: 'paradox', intent: 'execute', strategy: 'multi', mode: 'script' });
    });

    it('allows the model to plan a complex requested mutation before execution', () => {
        const routed = resolveAgentProfileFromModelDecision('重构整个运行器并调整恢复协议', DEFAULT_AGENT_PROFILE, {
            intent: 'plan', strategy: 'multi', requiresUserDecision: false, reason: 'coupled architecture change',
        });
        expect(routed).to.include({ domain: 'paradox', intent: 'plan', strategy: 'single', mode: 'plan' });
        expect(routed.admission).to.include({
            authorization: 'plan_write_only',
            initialPhase: 'plan',
        });
    });

    it('preserves a pinned domain and never uses multi-Agent for non-execution intents', () => {
        expect(resolveAgentProfileFromModelDecision('review only', {
            domain: 'general', intent: 'auto', strategy: 'auto',
        }, {
            intent: 'review', strategy: 'multi', requiresUserDecision: false, reason: '',
        })).to.include({ domain: 'general', intent: 'review', strategy: 'single', mode: 'review' });
        expect(resolveAgentProfileFromModelDecision('legacy plan', {
            domain: 'paradox', intent: 'plan', strategy: 'multi',
        }, {
            intent: 'execute', strategy: 'multi', requiresUserDecision: false, reason: '',
        })).to.include({ domain: 'paradox', intent: 'plan', strategy: 'single', mode: 'plan' });
        expect(resolveAgentProfile('Use multiple agents to review this repository without changes'))
            .to.include({ intent: 'review', strategy: 'single', mode: 'review' });
    });

    it('honors explicit dimensions while resolving Auto dimensions', () => {
        const resolved = resolveAgentProfile('Review this event chain', {
            domain: 'general', intent: 'auto', strategy: 'single', profileName: 'workspace-reviewer',
        });
        expect(resolved).to.include({ domain: 'general', intent: 'review', strategy: 'single', mode: 'review' });
        expect(resolved.schedulingState.profileName).to.equal('workspace-reviewer');
    });

    it('resolves Auto independently for every turn', () => {
        expect(resolveAgentProfile('Explain this Python API').mode).to.equal('explore');
        expect(resolveAgentProfile('Implement a new scripted effect').mode).to.equal('build');
        expect(resolveAgentProfile('Review the TypeScript cancellation logic').mode).to.equal('review');
    });

    it('treats common Chinese replacement requests as writes', () => {
        const resolved = resolveAgentProfile(
            '帮我把 executor_build.23 改成 executor_build.X，又是一个新的事件号',
            undefined,
            { activeFile: 'events/kuat_executor_events.txt' },
        );
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', strategy: 'single', mode: 'build' });
    });

    it('keeps the previous domain for terse follow-up requests', () => {
        const resolved = resolveAgentProfile('把 23 替换为 X', undefined, { previousDomain: 'paradox' });
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', mode: 'build' });
    });

    it('inherits execute intent when a terse answer resolves a modification clarification', () => {
        const resolved = resolveAgentProfile('只改一处', undefined, {
            previousDomain: 'paradox',
            previousUserRequests: ['把选中的 GFX_colony_type_capital 改成 GFX_colony_type_bureaucratic'],
        });
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', strategy: 'single', mode: 'build' });

        const routed = resolveAgentProfileFromModelDecision('只改一处', DEFAULT_AGENT_PROFILE, {
            intent: 'explore', strategy: 'single', requiresUserDecision: false, reason: 'short follow-up',
        }, {
            previousDomain: 'paradox',
            previousUserRequests: ['把选中的 GFX_colony_type_capital 改成 GFX_colony_type_bureaucratic'],
        });
        expect(routed).to.include({ intent: 'execute', strategy: 'single', mode: 'build' });
    });

    it('keeps explicit cancellation read-only even if the model requests execution', () => {
        const routed = resolveAgentProfileFromModelDecision('算了，先不改', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'multi', requiresUserDecision: false, reason: 'incorrect mutation classification',
        }, {
            previousDomain: 'paradox',
            previousUserRequests: ['修改这个事件'],
        });
        expect(routed).to.include({ intent: 'explore', strategy: 'single', mode: 'explore' });
    });

    it('keeps the default Paradox domain despite general coding evidence', () => {
        const resolved = resolveAgentProfile('修复 TypeScript webview 的状态更新', undefined, {
            previousDomain: 'paradox',
        });
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', mode: 'build' });
    });

    it('honors explicit no-write constraints before write keywords', () => {
        expect(resolveAgentProfile('不要修改代码，只分析这个事件为什么没有触发', undefined, {
            previousDomain: 'paradox',
        })).to.include({ domain: 'paradox', intent: 'explore', mode: 'explore' });
        expect(resolveAgentProfile('只检查这个事件有没有问题，不要改动', undefined, {
            previousDomain: 'paradox',
        })).to.include({ domain: 'paradox', intent: 'review', mode: 'review' });
        expect(resolveAgentProfile('只给一个实现方案，不要修改代码', profileForUserDomain('general'), {
            previousDomain: 'general',
        })).to.include({ domain: 'general', intent: 'plan', mode: 'plan' });
    });

    it('defers broad execution requests to runtime dispatch admission', () => {
        const resolved = resolveAgentProfile('修复所有本地化错误');
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', strategy: 'single', mode: 'build' });
        expect(resolved.reason).to.contain('runtime dispatch evaluation requested');
    });

    it('uses one Paradox admission for narrow and broad writes unless delegation is explicit', () => {
        expect(resolveAgentProfile('修复这个 CWT 诊断报错').mode).to.equal('build');
        expect(resolveAgentProfile('Add one scripted_modifier to this Stellaris mod').mode).to.equal('build');
        expect(resolveAgentProfile('Fix all localisation errors in this Stellaris mod').mode).to.equal('build');
    });

    it('separates general coding from Paradox coordination', () => {
        expect(resolveAgentProfile('Create a Python converter for this CSV file', profileForUserDomain('general')).mode).to.equal('utility');
        expect(resolveAgentProfile('Use multiple agents to refactor this TypeScript API', profileForUserDomain('general')).mode).to.equal('orchestrator');
        expect(resolveAgentProfile('Use multiple agents to repair this Stellaris event chain').mode).to.equal('script');
    });

    it('does not let request semantics override the selected Paradox domain', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript webview state handling', undefined, {
            activeFile: 'events/example.txt',
        });
        expect(resolved.domain).to.equal('paradox');
        expect(resolved.mode).to.equal('build');
    });

    it('uses Paradox for repository implementation work until the user selects General', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript routing for the Paradox Agent webview');
        expect(resolved.domain).to.equal('paradox');
        expect(resolved.mode).to.equal('build');
    });

    it('keeps Paradox selected during semantic routing', () => {
        const routed = resolveAgentProfileFromModelDecision('continue investigating this', DEFAULT_AGENT_PROFILE, {
            intent: 'explore',
            strategy: 'single',
            requiresUserDecision: false,
            reason: 'ambiguous follow-up',
            confidence: 0.55,
        }, {
            previousDomain: 'paradox',
        });
        expect(routed).to.include({ domain: 'paradox', intent: 'explore', mode: 'explore' });
    });

    it('keeps a manually selected General domain despite the model decision', () => {
        const routed = resolveAgentProfileFromModelDecision('Fix the TypeScript webview state', profileForUserDomain('general'), {
            intent: 'execute',
            strategy: 'single',
            requiresUserDecision: false,
            reason: 'incorrect domain classification',
            confidence: 0.55,
        }, {
            previousDomain: 'paradox',
        });
        expect(routed).to.include({ domain: 'general', intent: 'execute', mode: 'utility' });
    });

    it('keeps semantic read-only intent even when the wording also contains a write keyword', () => {
        const routed = resolveAgentProfileFromModelDecision('分析为什么这个修复方案会失败', DEFAULT_AGENT_PROFILE, {
            intent: 'explore', strategy: 'single', requiresUserDecision: false, reason: 'the user requested analysis',
        });
        expect(routed).to.include({ intent: 'explore', strategy: 'single', mode: 'explore' });
        expect(routed.admission.authorization).to.equal('read_only');
    });

    it('blocks execution while a material choice still belongs to the user', () => {
        const routed = resolveAgentProfileFromModelDecision('实现导入功能，格式你看着选', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'multi', requiresUserDecision: true, reason: 'the file format changes public behavior',
        });
        expect(routed).to.include({
            intent: 'plan', strategy: 'single', mode: 'plan', requiresUserDecision: true, routingSource: 'model',
        });
        expect(routed.admission.authorization).to.equal('plan_write_only');
    });

    it('uses semantic routing whenever task intent is automatic', () => {
        expect(shouldUseSemanticAgentRouting(DEFAULT_AGENT_PROFILE)).to.equal(true);
        expect(shouldUseSemanticAgentRouting(profileForUserDomain('general'))).to.equal(true);
        expect(shouldUseSemanticAgentRouting(profileForLegacyMode('plan'))).to.equal(false);
    });

    it('keeps implementation-only legacy roles out of the user-facing profile', () => {
        expect(profileForLegacyMode('loc_writer')).to.deep.equal({ domain: 'paradox', intent: 'execute', strategy: 'single' });
        expect(profileForLegacyMode('script_reviewer')).to.deep.equal({ domain: 'paradox', intent: 'review', strategy: 'single' });
        expect(profileForLegacyMode('orchestrator')).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'multi' });
    });
});
