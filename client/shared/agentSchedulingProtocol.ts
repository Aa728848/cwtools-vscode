/**
 * CWTools — Agent Scheduling Protocol
 *
 * Canonical scheduling state shared across Extension Host and Webviews.
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
    routingSource?: 'model' | 'deterministic' | 'user';
    phaseReason: string;
    dispatchReason?: string;
    revision: number;
}

export type ManagerSchedulingStateView = AgentSchedulingState;
