/**
 * CWTools — Agent Scheduling & Workflow Protocol
 *
 * Canonical scheduling state and workflow DTOs shared across Extension Host and Webviews.
 */

export type AgentRuntimeDomain = 'paradox' | 'general' | 'hybrid';
export type AgentAuthorization = 'read_only' | 'plan_write_only' | 'workspace_write';
export type AgentRunPhase = 'inspect' | 'plan' | 'execute' | 'verify' | 'finalize';
export type AgentDispatchMode = 'single' | 'parallel' | 'specialist';

export interface AgentSchedulingState {
    profileName: string;
    domainProfile: AgentRuntimeDomain;
    authorization: AgentAuthorization;
    phase: AgentRunPhase;
    dispatch: AgentDispatchMode;
    overlays: string[];
    routeConfidence: number;
    routeEvidence: string[];
    awaitingUserDecision?: boolean;
    routingSource?: 'model' | 'deterministic' | 'workflow' | 'user';
    phaseReason: string;
    dispatchReason?: string;
    revision: number;
}

export type ManagerSchedulingStateView = AgentSchedulingState;

export interface WorkflowPhaseView {
    id: string;
    title: string;
    description?: string;
}

export interface WorkflowVerificationView {
    id: string;
    description: string;
    required?: boolean;
    verificationTool?: string;
}

export interface WorkflowView {
    id: string;
    title: string;
    description: string;
    scheduling: { domain: string; intent: string; strategy: string; profileName?: string };
    locale?: string;
    phases: WorkflowPhaseView[];
    verification: WorkflowVerificationView[];
}

export interface WorkflowUiLabels {
    selectorPlaceholder: string;
    noWorkflowSelected: string;
    phaseUnit: string;
    phasesUnit: string;
    requiredCheckUnit: string;
    requiredChecksUnit: string;
}
