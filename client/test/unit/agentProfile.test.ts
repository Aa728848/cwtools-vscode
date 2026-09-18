import { expect } from 'chai';
import {
    DEFAULT_AGENT_PROFILE,
    isAgentProfileSelection,
    profileForUserDomain,
    resolveAgentProfile,
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

    it('keeps capability domain user-owned while the Agent decides the mode', () => {
        expect(profileForUserDomain('paradox')).to.deep.equal({ domain: 'paradox', intent: 'auto', strategy: 'auto' });
        expect(profileForUserDomain('general')).to.deep.equal({ domain: 'general', intent: 'auto', strategy: 'auto' });
        expect(profileForUserDomain('hybrid')).to.deep.equal({ domain: 'hybrid', intent: 'auto', strategy: 'auto' });

        // The domain stays user-owned: a general request resolves to the general
        // domain and its utility execution label without any routing model.
        const general = resolveAgentProfile('change the webview', profileForUserDomain('general'));
        expect(general.schedulingState.domainProfile).to.equal('general');
        expect(executionModeForSchedulingState(general.schedulingState)).to.equal('utility');
    });

    it('pins an explicit user mode instead of consulting a router', () => {
        // A user-pinned intent short-circuits automatic resolution: it is the
        // session-level override that routing must respect.
        const pinnedPlan = resolveAgentProfile('implement the importer', {
            domain: 'paradox', intent: 'plan', strategy: 'auto',
        });
        expect(pinnedPlan.schedulingState).to.include({
            authorization: 'plan_write_only', phase: 'plan', dispatch: 'single',
        });
        expect(executionModeForSchedulingState(pinnedPlan.schedulingState)).to.equal('plan');

        const pinnedExplore = resolveAgentProfile('implement the importer', {
            domain: 'general', intent: 'explore', strategy: 'auto',
        });
        expect(pinnedExplore.schedulingState.authorization).to.equal('read_only');
        expect(executionModeForSchedulingState(pinnedExplore.schedulingState)).to.equal('explore');
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
        const plan = resolveAgentProfile('refactor the runner', {
            domain: 'paradox', intent: 'plan', strategy: 'auto',
        }, { previousUserRequests: ['refactor the runner'] });
        expect(plan.schedulingState).to.include({
            domainProfile: 'paradox', authorization: 'plan_write_only', phase: 'plan', dispatch: 'single',
        });
        expect(executionModeForSchedulingState(plan.schedulingState)).to.equal('plan');

        const execute = resolveAgentProfile('方案没问题，就这么做', {
            domain: 'paradox', intent: 'execute', strategy: 'single',
        });
        expect(execute.schedulingState).to.include({ authorization: 'workspace_write', phase: 'execute' });
        expect(executionModeForSchedulingState(execute.schedulingState)).to.equal('build');
    });

    it('keeps an explicit no-write request read-only', () => {
        const noWrite = resolveAgentProfile('算了，先不改', {
            domain: 'paradox', intent: 'explore', strategy: 'auto',
        });
        expect(noWrite.schedulingState.authorization).to.equal('read_only');
        expect(noWrite.schedulingState.phase).to.equal('inspect');
        expect(executionModeForSchedulingState(noWrite.schedulingState)).to.equal('explore');
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
        expect(agentProfileCatalog.get('hybrid-agent')?.domain).to.equal('hybrid');
    });
});
