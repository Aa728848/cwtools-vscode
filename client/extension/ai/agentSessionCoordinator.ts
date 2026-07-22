import type { AgentArtifact, AgentMode, AgentProfileSelection, AgentStep, ResolvedAgentProfile } from './types';
import { cloneAgentProfile } from './agentProfile';

/**
 * Minimal shared session state holder for chat surfaces.
 * Keeps conversation runtime state independent from any specific webview host.
 */
export class AgentSessionCoordinator {
    private _currentMode: AgentMode = 'build';
    private _previousMode: AgentMode = 'build';
    private _currentWorkflowId: string | null = null;
    private _agentProfile: AgentProfileSelection = cloneAgentProfile();
    private _previousAgentProfile: AgentProfileSelection = cloneAgentProfile();
    private _lastResolvedProfile?: ResolvedAgentProfile;
    private _liveSteps: AgentStep[] = [];
    private _isGenerating = false;
    private _artifacts = new Map<string, AgentArtifact>();

    get currentMode(): AgentMode { return this._currentMode; }
    set currentMode(mode: AgentMode) { this._currentMode = mode; }

    get previousMode(): AgentMode { return this._previousMode; }
    set previousMode(mode: AgentMode) { this._previousMode = mode; }

    get currentWorkflowId(): string | null { return this._currentWorkflowId; }
    set currentWorkflowId(workflowId: string | null) { this._currentWorkflowId = workflowId; }

    /**
     * Let a workflow temporarily own the execution profile. Switching directly
     * between workflows keeps the original pre-workflow return state.
     */
    activateWorkflow(workflowId: string, mode: AgentMode, profile: AgentProfileSelection): void {
        if (!this._currentWorkflowId) {
            this._previousMode = this._currentMode;
            this._previousAgentProfile = cloneAgentProfile(this._agentProfile);
        }
        this._currentWorkflowId = workflowId;
        this._currentMode = mode;
        this._agentProfile = cloneAgentProfile(profile);
        this._lastResolvedProfile = undefined;
    }

    /** Restore the state captured when the active workflow was first entered. */
    deactivateWorkflow(): boolean {
        if (!this._currentWorkflowId) return false;
        this._currentWorkflowId = null;
        this._currentMode = this._previousMode;
        this._agentProfile = cloneAgentProfile(this._previousAgentProfile);
        this._lastResolvedProfile = undefined;
        return true;
    }

    get agentProfile(): AgentProfileSelection { return cloneAgentProfile(this._agentProfile); }
    set agentProfile(profile: AgentProfileSelection) { this._agentProfile = cloneAgentProfile(profile); }

    get previousAgentProfile(): AgentProfileSelection { return cloneAgentProfile(this._previousAgentProfile); }
    set previousAgentProfile(profile: AgentProfileSelection) { this._previousAgentProfile = cloneAgentProfile(profile); }

    get lastResolvedProfile(): ResolvedAgentProfile | undefined { return this._lastResolvedProfile; }
    set lastResolvedProfile(profile: ResolvedAgentProfile | undefined) { this._lastResolvedProfile = profile; }

    get liveSteps(): AgentStep[] { return this._liveSteps; }
    set liveSteps(steps: AgentStep[]) { this._liveSteps = steps; }

    get isGenerating(): boolean { return this._isGenerating; }
    set isGenerating(value: boolean) { this._isGenerating = value; }

    get artifacts(): Map<string, AgentArtifact> { return this._artifacts; }
    set artifacts(next: Map<string, AgentArtifact>) { this._artifacts = next; }
}
