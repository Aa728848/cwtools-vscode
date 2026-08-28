import { schedulingStateFromAdmission } from '../../extension/ai/runner/scheduling';
import type { AgentRuntimeDomain, AgentSchedulingState } from '../../extension/ai/types';

function schedulingState(
    domainProfile: AgentRuntimeDomain,
    authorization: AgentSchedulingState['authorization'],
    phase: AgentSchedulingState['phase'],
    dispatch: AgentSchedulingState['dispatch'] = 'single',
    profileName?: string,
): AgentSchedulingState {
    const state = schedulingStateFromAdmission({
        domainProfile,
        authorization,
        initialPhase: phase === 'finalize' ? 'verify' : phase,
        explicitDelegation: dispatch !== 'single',
        confidence: 1,
        evidence: ['test fixture'],
    }, 'test fixture');
    return { ...state, phase, dispatch, profileName: profileName ?? state.profileName };
}

export const GENERAL_WRITE = schedulingState('general', 'workspace_write', 'execute');
export const GENERAL_PARALLEL = schedulingState('general', 'workspace_write', 'execute', 'parallel');
export const GENERAL_EXPLORE = schedulingState('general', 'read_only', 'inspect');
export const PARADOX_WRITE = schedulingState('paradox', 'workspace_write', 'execute');
export const PARADOX_PARALLEL = schedulingState('paradox', 'workspace_write', 'execute', 'parallel');
export const PARADOX_PLAN = schedulingState('paradox', 'plan_write_only', 'plan');
export const PARADOX_EXPLORE = schedulingState('paradox', 'read_only', 'inspect');
export const LOCALIZATION_WRITE = schedulingState('paradox', 'workspace_write', 'execute', 'single', 'localization-writer');
