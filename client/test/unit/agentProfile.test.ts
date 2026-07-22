import { expect } from 'chai';
import {
    DEFAULT_AGENT_PROFILE,
    isAgentProfileSelection,
    parseModelAgentProfileDecision,
    profileForUserDomain,
    profileForLegacyMode,
    resolveAgentProfile,
    resolveAgentProfileFromModelDecision,
} from '../../extension/ai/agentProfile';

describe('agent profile', () => {
    it('validates all three runtime dimensions at the boundary', () => {
        expect(isAgentProfileSelection(DEFAULT_AGENT_PROFILE)).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute', strategy: 'multi' })).to.equal(true);
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
    });

    it('parses strict model routing decisions from plain or fenced JSON', () => {
        expect(parseModelAgentProfileDecision(
            '```json\n{"domain":"paradox","intent":"execute","strategy":"multi","reason":" broad task "}\n```',
        )).to.deep.equal({ domain: 'paradox', intent: 'execute', strategy: 'multi', reason: 'broad task' });
        expect(parseModelAgentProfileDecision(
            `{"domain":"general","intent":"explore","strategy":"single","reason":"${'x'.repeat(300)}"}`,
        )?.reason).to.have.length(240);
        expect(parseModelAgentProfileDecision(
            '{"domain":"general","intent":"build","strategy":"single"}',
        )).to.equal(undefined);
        expect(parseModelAgentProfileDecision(
            '{"domain":"unknown","intent":"execute","strategy":"single"}',
        )).to.equal(undefined);
    });

    it('lets the model choose automatic intent and single/multi-Agent strategy', () => {
        expect(resolveAgentProfileFromModelDecision('large change', DEFAULT_AGENT_PROFILE, {
            domain: 'general', intent: 'execute', strategy: 'multi', reason: 'independent workstreams',
        })).to.include({ domain: 'general', intent: 'execute', strategy: 'multi', mode: 'orchestrator' });
        expect(resolveAgentProfileFromModelDecision('large mod change', DEFAULT_AGENT_PROFILE, {
            domain: 'paradox', intent: 'execute', strategy: 'multi', reason: 'independent workstreams',
        })).to.include({ domain: 'paradox', intent: 'execute', strategy: 'multi', mode: 'script' });
    });

    it('allows the model to plan a complex requested mutation before execution', () => {
        const routed = resolveAgentProfileFromModelDecision('重构整个运行器并调整恢复协议', DEFAULT_AGENT_PROFILE, {
            domain: 'general', intent: 'plan', strategy: 'multi', reason: 'coupled architecture change',
        });
        expect(routed).to.include({ domain: 'general', intent: 'plan', strategy: 'single', mode: 'plan' });
    });

    it('preserves a pinned domain and never uses multi-Agent for non-execution intents', () => {
        expect(resolveAgentProfileFromModelDecision('review only', {
            domain: 'general', intent: 'auto', strategy: 'auto',
        }, {
            domain: 'paradox', intent: 'review', strategy: 'multi', reason: '',
        })).to.include({ domain: 'general', intent: 'review', strategy: 'single', mode: 'review' });
        expect(resolveAgentProfileFromModelDecision('legacy plan', {
            domain: 'paradox', intent: 'plan', strategy: 'multi',
        }, {
            domain: 'paradox', intent: 'execute', strategy: 'multi', reason: '',
        })).to.include({ domain: 'paradox', intent: 'plan', strategy: 'single', mode: 'plan' });
        expect(resolveAgentProfile('Use multiple agents to review this repository without changes'))
            .to.include({ intent: 'review', strategy: 'single', mode: 'review' });
    });

    it('honors explicit dimensions while resolving Auto dimensions', () => {
        const resolved = resolveAgentProfile('Review this event chain', {
            domain: 'general', intent: 'auto', strategy: 'single',
        });
        expect(resolved).to.include({ domain: 'general', intent: 'review', strategy: 'single', mode: 'review' });
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
            domain: 'paradox', intent: 'explore', strategy: 'single', reason: 'short follow-up',
        }, {
            previousDomain: 'paradox',
            previousUserRequests: ['把选中的 GFX_colony_type_capital 改成 GFX_colony_type_bureaucratic'],
        });
        expect(routed).to.include({ intent: 'execute', strategy: 'single', mode: 'build' });
    });

    it('keeps explicit cancellation read-only even if the model requests execution', () => {
        const routed = resolveAgentProfileFromModelDecision('算了，先不改', DEFAULT_AGENT_PROFILE, {
            domain: 'paradox', intent: 'execute', strategy: 'multi', reason: 'incorrect mutation classification',
        }, {
            previousDomain: 'paradox',
            previousUserRequests: ['修改这个事件'],
        });
        expect(routed).to.include({ intent: 'explore', strategy: 'single', mode: 'explore' });
    });

    it('lets explicit general coding evidence override Paradox conversation continuity', () => {
        const resolved = resolveAgentProfile('修复 TypeScript webview 的状态更新', undefined, {
            previousDomain: 'paradox',
        });
        expect(resolved).to.include({ domain: 'general', intent: 'execute', mode: 'utility' });
    });

    it('honors explicit no-write constraints before write keywords', () => {
        expect(resolveAgentProfile('不要修改代码，只分析这个事件为什么没有触发', undefined, {
            previousDomain: 'paradox',
        })).to.include({ domain: 'paradox', intent: 'explore', mode: 'explore' });
        expect(resolveAgentProfile('只检查这个事件有没有问题，不要改动', undefined, {
            previousDomain: 'paradox',
        })).to.include({ domain: 'paradox', intent: 'review', mode: 'review' });
        expect(resolveAgentProfile('只给一个实现方案，不要修改代码', undefined, {
            previousDomain: 'general',
        })).to.include({ domain: 'general', intent: 'plan', mode: 'plan' });
    });

    it('uses Multi-Agent for broad Chinese execution requests', () => {
        const resolved = resolveAgentProfile('修复所有本地化错误');
        expect(resolved).to.include({ domain: 'paradox', intent: 'execute', strategy: 'multi', mode: 'script' });
    });

    it('uses one Paradox agent for narrow writes and Paradox Multi-Agent for broad writes', () => {
        expect(resolveAgentProfile('修复这个 CWT 诊断报错').mode).to.equal('build');
        expect(resolveAgentProfile('Add one scripted_modifier to this Stellaris mod').mode).to.equal('build');
        expect(resolveAgentProfile('Fix all localisation errors in this Stellaris mod').mode).to.equal('script');
    });

    it('separates general coding from Paradox coordination', () => {
        expect(resolveAgentProfile('Create a Python converter for this CSV file').mode).to.equal('utility');
        expect(resolveAgentProfile('Use multiple agents to refactor this TypeScript API').mode).to.equal('orchestrator');
        expect(resolveAgentProfile('Use multiple agents to repair this Stellaris event chain').mode).to.equal('script');
    });

    it('lets explicit general-code semantics override an unrelated active Paradox file', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript webview state handling', undefined, {
            activeFile: 'events/example.txt',
        });
        expect(resolved.domain).to.equal('general');
        expect(resolved.mode).to.equal('utility');
    });

    it('treats Paradox Agent implementation work as repository coding', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript routing for the Paradox Agent webview');
        expect(resolved.domain).to.equal('general');
        expect(resolved.mode).to.equal('utility');
    });

    it('keeps implementation-only legacy roles out of the user-facing profile', () => {
        expect(profileForLegacyMode('loc_writer')).to.deep.equal({ domain: 'paradox', intent: 'execute', strategy: 'single' });
        expect(profileForLegacyMode('script_reviewer')).to.deep.equal({ domain: 'auto', intent: 'review', strategy: 'single' });
        expect(profileForLegacyMode('orchestrator')).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'multi' });
    });
});
