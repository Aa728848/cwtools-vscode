import { expect } from 'chai';
import {
    DEFAULT_AGENT_PROFILE,
    isAgentProfileSelection,
    parseModelAgentProfileDecision,
    profileForUserDomain,
    resolveAgentProfile,
    resolveAgentProfileFromModelDecision,
    shouldUseSemanticAgentRouting,
} from '../../extension/ai/agentProfile';
import { agentProfileCatalog } from '../../extension/ai/runner/agentProfileCatalog';
import { executionModeForSchedulingState } from '../../extension/ai/runner/scheduling';

describe('agent routing', () => {
    const executionMode = (resolved: ReturnType<typeof resolveAgentProfile>) =>
        executionModeForSchedulingState(resolved.schedulingState);

    it('validates the canonical profile dimensions at the boundary', () => {
        expect(isAgentProfileSelection(DEFAULT_AGENT_PROFILE)).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute', strategy: 'multi' })).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'hybrid', intent: 'review', strategy: 'single' })).to.equal(true);
        expect(isAgentProfileSelection({
            domain: 'general', intent: 'execute', strategy: 'multi', profileName: 'workspace-reviewer',
        })).to.equal(true);
        expect(isAgentProfileSelection({
            domain: 'general', intent: 'execute', strategy: 'multi', profileName: '../unsafe',
        })).to.equal(false);
        expect(isAgentProfileSelection({ domain: 'auto', intent: 'execute', strategy: 'single' })).to.equal(false);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'build', strategy: 'single' })).to.equal(false);
    });

    it('keeps capability domain user-owned while intent and strategy remain automatic', () => {
        expect(profileForUserDomain('paradox')).to.deep.equal({ domain: 'paradox', intent: 'auto', strategy: 'auto' });
        expect(profileForUserDomain('general')).to.deep.equal({ domain: 'general', intent: 'auto', strategy: 'auto' });
        expect(profileForUserDomain('hybrid')).to.deep.equal({ domain: 'hybrid', intent: 'auto', strategy: 'auto' });

        const general = resolveAgentProfileFromModelDecision('change the webview', profileForUserDomain('general'), {
            intent: 'execute', strategy: 'single', requiresUserDecision: false, reason: 'implementation request',
        });
        expect(general.schedulingState.domainProfile).to.equal('general');
        expect(executionModeForSchedulingState(general.schedulingState)).to.equal('utility');
    });

    it('parses strict model routing decisions from plain or fenced JSON', () => {
        expect(parseModelAgentProfileDecision(
            '```json\n{"domain":"paradox","intent":"execute","strategy":"multi","reason":" broad task "}\n```',
        )).to.deep.equal({
            intent: 'execute', strategy: 'multi', requiresUserDecision: false,
            explicitExecutionRequest: false, explicitNoWriteRequest: false, explicitDelegationRequest: false,
            reason: 'broad task',
        });
        expect(parseModelAgentProfileDecision('{"intent":"build","strategy":"single"}')).to.equal(undefined);
        expect(parseModelAgentProfileDecision(
            '{"intent":"execute","strategy":"single","requiresUserDecision":"yes"}',
        )).to.equal(undefined);
    });

    it('derives execution labels only from canonical scheduling state', () => {
        const explore = resolveAgentProfile('Explain this API', profileForUserDomain('general'));
        const build = resolveAgentProfile('Implement a new scripted effect');
        const review = resolveAgentProfile('Review the cancellation logic', profileForUserDomain('general'));
        expect(executionMode(explore)).to.equal('explore');
        expect(executionMode(build)).to.equal('build');
        expect(executionMode(review)).to.equal('review');
        expect(build).not.to.have.property('mode');
        expect(build).not.to.have.property('domain');
        expect(build).not.to.have.property('admission');
    });

    it('uses scheduling authorization as the single write-admission state', () => {
        const plan = resolveAgentProfileFromModelDecision('refactor the runner', DEFAULT_AGENT_PROFILE, {
            intent: 'plan', strategy: 'multi', requiresUserDecision: false, reason: 'coupled change',
        });
        expect(plan.schedulingState).to.include({
            domainProfile: 'paradox', authorization: 'plan_write_only', phase: 'plan', dispatch: 'single',
        });
        expect(executionModeForSchedulingState(plan.schedulingState)).to.equal('plan');

        const execute = resolveAgentProfileFromModelDecision('方案没问题，就这么做', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'single', explicitExecutionRequest: true,
            requiresUserDecision: false, reason: 'approved plan',
        });
        expect(execute.schedulingState).to.include({ authorization: 'workspace_write', phase: 'execute' });
        expect(executionModeForSchedulingState(execute.schedulingState)).to.equal('build');
    });

    it('keeps unresolved user decisions out of execution', () => {
        const routed = resolveAgentProfileFromModelDecision('实现导入功能，格式你看着选', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'multi', explicitExecutionRequest: true,
            explicitDelegationRequest: true, requiresUserDecision: true,
            reason: 'the file format changes public behavior',
        });
        expect(routed.schedulingState).to.include({
            authorization: 'plan_write_only', phase: 'plan', dispatch: 'parallel', awaitingUserDecision: true,
        });
    });

    it('keeps explicit no-write decisions read-only', () => {
        const routed = resolveAgentProfileFromModelDecision('算了，先不改', DEFAULT_AGENT_PROFILE, {
            intent: 'execute', strategy: 'single', explicitNoWriteRequest: true,
            requiresUserDecision: false, reason: 'user cancelled changes',
        });
        expect(routed.schedulingState.authorization).to.equal('read_only');
        expect(routed.schedulingState.phase).to.equal('inspect');
        expect(executionModeForSchedulingState(routed.schedulingState)).to.equal('explore');
    });

    it('retains deterministic routing when semantic routing is unavailable', () => {
        const replacement = resolveAgentProfile(
            '帮我把 executor_build.23 改成 executor_build.X',
            undefined,
            { activeFile: 'events/samplemod_executor_events.txt' },
        );
        expect(replacement.schedulingState.domainProfile).to.equal('paradox');
        expect(executionMode(replacement)).to.equal('build');

        const inherited = resolveAgentProfile('只改一处', undefined, {
            previousUserRequests: ['把选中的名称改成新的名称'],
        });
        expect(executionMode(inherited)).to.equal('build');

        const broad = resolveAgentProfile('修复所有本地化错误');
        expect(executionMode(broad)).to.equal('plan');
        expect(broad.schedulingState.phaseReason).to.contain('runtime dispatch evaluation requested');
    });

    it('accepts explicit workflow profiles without storing a second state', () => {
        expect(shouldUseSemanticAgentRouting({ domain: 'paradox', intent: 'plan', strategy: 'single' })).to.equal(false);
        expect(agentProfileCatalog.get('hybrid-agent')?.domain).to.equal('hybrid');
    });
});
