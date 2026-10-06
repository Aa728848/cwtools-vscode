import { isRecord } from './protocolValidation';

export interface AntigravityQuotaBucket {
    name: string;
    remainingPercent: number;
    resetsAt?: string;
}

/** One pooled account as the card shows it; never carries credentials. */
export interface AntigravityPoolAccountView {
    id: string;
    alias: string;
    isPrimary: boolean;
    /** A parked credential: re-signing in restores the row. */
    authStatus?: 'invalid_credential' | 'rate_limited';
    authFailedReason?: string;
    cooldownUntil?: number;
    cooldownReason?: string;
    expiresAt?: number;
}

/** Which account the next request uses, and in what order. */
export interface AntigravityPoolView {
    strategy: 'sequential' | 'round-robin' | 'sticky';
    accounts: AntigravityPoolAccountView[];
}

/** Host-sanitized account details; OAuth credentials never cross the Webview boundary. */
export interface AntigravityAccountStatus {
    signedIn: boolean;
    hasCredentials: boolean;
    email?: string;
    projectId?: string;
    models: string[];
    quota: AntigravityQuotaBucket[];
    error?: string;
    /** Multi-account view; absent until the pool has been read. */
    pool?: AntigravityPoolView;
}

function isPoolAccountView(value: unknown): value is AntigravityPoolAccountView {
    return isRecord(value)
        && typeof value.id === 'string' && typeof value.alias === 'string'
        && typeof value.isPrimary === 'boolean'
        && (value.authStatus === undefined || value.authStatus === 'invalid_credential' || value.authStatus === 'rate_limited')
        && [value.authFailedReason, value.cooldownReason].every(field => field === undefined || typeof field === 'string')
        && [value.cooldownUntil, value.expiresAt].every(field => field === undefined || (typeof field === 'number' && Number.isFinite(field)));
}

function isPoolView(value: unknown): value is AntigravityPoolView {
    return isRecord(value)
        && (value.strategy === 'sequential' || value.strategy === 'round-robin' || value.strategy === 'sticky')
        && Array.isArray(value.accounts) && value.accounts.every(isPoolAccountView);
}

export function isAntigravityAccountStatus(value: unknown): value is AntigravityAccountStatus {
    return isRecord(value) && typeof value.signedIn === 'boolean' && typeof value.hasCredentials === 'boolean'
        && [value.email, value.projectId, value.error].every(field => field === undefined || typeof field === 'string')
        && Array.isArray(value.models) && value.models.every(model => typeof model === 'string')
        && Array.isArray(value.quota) && value.quota.every(bucket => isRecord(bucket)
            && typeof bucket.name === 'string' && typeof bucket.remainingPercent === 'number'
            && Number.isFinite(bucket.remainingPercent) && bucket.remainingPercent >= 0 && bucket.remainingPercent <= 100
            && (bucket.resetsAt === undefined || (typeof bucket.resetsAt === 'string' && Number.isFinite(Date.parse(bucket.resetsAt)))))
        && (value.pool === undefined || isPoolView(value.pool));
}
