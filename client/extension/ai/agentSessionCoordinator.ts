import type { AgentArtifact, AgentSchedulingState, AgentStep } from './types';
import { schedulingStateFromAdmission } from './runner/scheduling';

function initialSchedulingState(): AgentSchedulingState {
    return schedulingStateFromAdmission({
        domainProfile: 'paradox',
        authorization: 'workspace_write',
        initialPhase: 'execute',
        explicitDelegation: false,
        confidence: 1,
        evidence: ['new session'],
    }, 'new session');
}

function cloneSchedulingState(state: AgentSchedulingState): AgentSchedulingState {
    return {
        ...state,
        overlays: state.overlays ? [...state.overlays] : undefined,
        routeEvidence: [...state.routeEvidence],
    };
}

/**
 * Minimal shared session state holder for chat surfaces.
 * Keeps conversation runtime state independent from any specific webview host.
 */
export class AgentSessionCoordinator {
    private _schedulingState: AgentSchedulingState = initialSchedulingState();
    private _previousSchedulingState: AgentSchedulingState = initialSchedulingState();
    private _currentWorkflowId: string | null = null;
    private _liveSteps: AgentStep[] = [];
    private _isGenerating = false;
    private _artifacts = new Map<string, AgentArtifact>();

    get schedulingState(): AgentSchedulingState { return cloneSchedulingState(this._schedulingState); }
    set schedulingState(state: AgentSchedulingState) { this._schedulingState = cloneSchedulingState(state); }

    get previousSchedulingState(): AgentSchedulingState { return cloneSchedulingState(this._previousSchedulingState); }
    set previousSchedulingState(state: AgentSchedulingState) { this._previousSchedulingState = cloneSchedulingState(state); }

    get currentWorkflowId(): string | null { return this._currentWorkflowId; }
    set currentWorkflowId(workflowId: string | null) { this._currentWorkflowId = workflowId; }

    /**
     * Let a workflow temporarily own the execution profile. Switching directly
     * between workflows keeps the original pre-workflow return state.
     */
    activateWorkflow(workflowId: string, schedulingState: AgentSchedulingState): void {
        if (!this._currentWorkflowId) {
            this._previousSchedulingState = cloneSchedulingState(this._schedulingState);
        }
        this._currentWorkflowId = workflowId;
        this._schedulingState = cloneSchedulingState(schedulingState);
    }

    /** Restore the state captured when the active workflow was first entered. */
    deactivateWorkflow(): boolean {
        if (!this._currentWorkflowId) return false;
        this._currentWorkflowId = null;
        this._schedulingState = cloneSchedulingState(this._previousSchedulingState);
        return true;
    }

    get liveSteps(): AgentStep[] { return this._liveSteps; }
    set liveSteps(steps: AgentStep[]) { this._liveSteps = steps; }

    get isGenerating(): boolean { return this._isGenerating; }
    set isGenerating(value: boolean) { this._isGenerating = value; }

    get artifacts(): Map<string, AgentArtifact> { return this._artifacts; }
    set artifacts(next: Map<string, AgentArtifact>) { this._artifacts = next; }
}
