import type { AgentArtifact, AgentMode, AgentStep } from './types';

/**
 * Minimal shared session state holder for chat surfaces.
 * Keeps conversation runtime state independent from any specific webview host.
 */
export class AgentSessionCoordinator {
    private _currentMode: AgentMode = 'build';
    private _previousMode: AgentMode = 'build';
    private _currentWorkflowId: string | null = null;
    private _liveSteps: AgentStep[] = [];
    private _isGenerating = false;
    private _artifacts = new Map<string, AgentArtifact>();

    get currentMode(): AgentMode { return this._currentMode; }
    set currentMode(mode: AgentMode) { this._currentMode = mode; }

    get previousMode(): AgentMode { return this._previousMode; }
    set previousMode(mode: AgentMode) { this._previousMode = mode; }

    get currentWorkflowId(): string | null { return this._currentWorkflowId; }
    set currentWorkflowId(workflowId: string | null) { this._currentWorkflowId = workflowId; }

    get liveSteps(): AgentStep[] { return this._liveSteps; }
    set liveSteps(steps: AgentStep[]) { this._liveSteps = steps; }

    get isGenerating(): boolean { return this._isGenerating; }
    set isGenerating(value: boolean) { this._isGenerating = value; }

    get artifacts(): Map<string, AgentArtifact> { return this._artifacts; }
    set artifacts(next: Map<string, AgentArtifact>) { this._artifacts = next; }
}
