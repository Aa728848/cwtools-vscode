import { isRecord } from './protocolValidation';

export interface AntigravityQuotaBucket {
    name: string;
    remainingPercent: number;
    resetsAt?: string;
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
}

export function isAntigravityAccountStatus(value: unknown): value is AntigravityAccountStatus {
    return isRecord(value) && typeof value.signedIn === 'boolean' && typeof value.hasCredentials === 'boolean'
        && [value.email, value.projectId, value.error].every(field => field === undefined || typeof field === 'string')
        && Array.isArray(value.models) && value.models.every(model => typeof model === 'string')
        && Array.isArray(value.quota) && value.quota.every(bucket => isRecord(bucket)
            && typeof bucket.name === 'string' && typeof bucket.remainingPercent === 'number'
            && Number.isFinite(bucket.remainingPercent) && bucket.remainingPercent >= 0 && bucket.remainingPercent <= 100
            && (bucket.resetsAt === undefined || (typeof bucket.resetsAt === 'string' && Number.isFinite(Date.parse(bucket.resetsAt)))));
}
