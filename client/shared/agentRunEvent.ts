/**
 * CWTools — Agent Run Event Protocol
 *
 * Canonical run event envelope shared across Extension Host, Webviews, and Agent Manager.
 */

export interface AgentRunEvent<TPayload = any> {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: number;
    type: string;
    status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | string;
    invocationId?: string;
    agentId?: string;
    payload: TPayload;
}
