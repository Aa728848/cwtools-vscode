/**
 * Command Code Account & Quota Service
 *
 * Fetches and caches read-only account details, credits, window limits, and subscription
 * from https://api.commandcode.ai with safe type narrowing and fail-open semantics.
 */

import { isRecord } from '../../../shared/protocolValidation';

export interface CommandCodeWindowLimit {
    used: number;
    cap: number;
    exceeded?: boolean;
    resetAt?: number; // epoch milliseconds
}

export interface CommandCodeCredits {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
    planId?: string;
}

export interface CommandCodeUsageSummary {
    totalCount?: number;
    totalCost?: number;
    successRate?: number;
    completedCount?: number;
    failedCount?: number;
    totalTokensIn?: number;
    totalTokensOut?: number;
    totalCredits?: number;
    periodBasis?: string;
}

export interface CommandCodeSubscription {
    planId?: string;
    status?: string;
    currentPeriodEnd?: number | string;
}

export interface CommandCodeUser {
    id?: string;
    name?: string;
    userName?: string;
}

export interface CommandCodeAccountStatus {
    available: boolean;
    hasKey: boolean;
    user?: CommandCodeUser;
    orgId?: string;
    credits?: CommandCodeCredits;
    windowLimits?: {
        fiveHour?: CommandCodeWindowLimit;
        weekly?: CommandCodeWindowLimit;
    };
    usageSummary?: CommandCodeUsageSummary;
    subscription?: CommandCodeSubscription;
    planId?: string;
    error?: string;
}

export const COMMANDCODE_API_BASE = 'https://api.commandcode.ai';
export const COMMANDCODE_VERSION = '1.54.0';
export const COMMANDCODE_STATUS_CACHE_MS = 60_000;
export const COMMANDCODE_REQUEST_TIMEOUT_MS = 10_000;

function finiteNumber(value: unknown): number | undefined {
    const num = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(num) ? num : undefined;
}

export function parseCommandCodeWindowLimit(data: unknown): CommandCodeWindowLimit | undefined {
    if (!isRecord(data)) return undefined;
    const used = finiteNumber(data.used);
    const cap = finiteNumber(data.cap);
    if (used === undefined || cap === undefined) return undefined;
    return {
        used,
        cap,
        exceeded: typeof data.exceeded === 'boolean' ? data.exceeded : undefined,
        resetAt: finiteNumber(data.resetAt),
    };
}

export function parseCommandCodeWhoami(data: unknown): { user?: CommandCodeUser; orgId?: string } | undefined {
    if (!isRecord(data)) return undefined;
    let user: CommandCodeUser | undefined;
    if (isRecord(data.user)) {
        user = {
            id: typeof data.user.id === 'string' ? data.user.id : undefined,
            name: typeof data.user.name === 'string' ? data.user.name : undefined,
            userName: typeof data.user.userName === 'string' ? data.user.userName : undefined,
        };
    }
    let orgId: string | undefined;
    if (isRecord(data.org) && typeof data.org.id === 'string') {
        orgId = data.org.id;
    }
    return { user, orgId };
}

export function parseCommandCodeUsageSummary(data: unknown): CommandCodeUsageSummary | undefined {
    if (!isRecord(data)) return undefined;
    return {
        totalCount: finiteNumber(data.totalCount),
        totalCost: finiteNumber(data.totalCost),
        successRate: finiteNumber(data.successRate),
        completedCount: finiteNumber(data.completedCount),
        failedCount: finiteNumber(data.failedCount),
        totalTokensIn: finiteNumber(data.totalTokensIn),
        totalTokensOut: finiteNumber(data.totalTokensOut),
        totalCredits: finiteNumber(data.totalCredits),
        periodBasis: typeof data.periodBasis === 'string' ? data.periodBasis : undefined,
    };
}

export function parseCommandCodeCredits(data: unknown): {
    credits?: CommandCodeCredits;
    windowLimits?: {
        fiveHour?: CommandCodeWindowLimit;
        weekly?: CommandCodeWindowLimit;
    };
} | undefined {
    if (!isRecord(data)) return undefined;
    let credits: CommandCodeCredits | undefined;
    if (isRecord(data.credits)) {
        credits = {
            monthlyCredits: finiteNumber(data.credits.monthlyCredits),
            purchasedCredits: finiteNumber(data.credits.purchasedCredits),
            freeCredits: finiteNumber(data.credits.freeCredits),
            planId: typeof data.credits.planId === 'string' ? data.credits.planId : undefined,
        };
    }
    let windowLimits: { fiveHour?: CommandCodeWindowLimit; weekly?: CommandCodeWindowLimit } | undefined;
    if (isRecord(data.windowLimits)) {
        const fiveHour = parseCommandCodeWindowLimit(data.windowLimits.fiveHour);
        const weekly = parseCommandCodeWindowLimit(data.windowLimits.weekly);
        if (fiveHour !== undefined || weekly !== undefined) {
            windowLimits = {
                ...(fiveHour !== undefined ? { fiveHour } : {}),
                ...(weekly !== undefined ? { weekly } : {}),
            };
        }
    }
    return { credits, windowLimits };
}

export function parseCommandCodeSubscription(data: unknown): CommandCodeSubscription | undefined {
    if (!isRecord(data)) return undefined;
    const item = isRecord(data.data)
        ? data.data
        : (Array.isArray(data.data) && isRecord(data.data[0]) ? data.data[0] : undefined);
    if (!item) return undefined;
    return {
        planId: typeof item.planId === 'string' ? item.planId : undefined,
        status: typeof item.status === 'string' ? item.status : undefined,
        currentPeriodEnd: finiteNumber(item.currentPeriodEnd) ?? (typeof item.currentPeriodEnd === 'string' ? item.currentPeriodEnd : undefined),
    };
}

export class CommandCodeAccountService {
    private cachedStatus?: { apiKey: string; value: CommandCodeAccountStatus; at: number };
    private inFlight?: Promise<CommandCodeAccountStatus>;

    constructor(
        private readonly fetchFn: typeof fetch = fetch,
        private readonly baseUrl = COMMANDCODE_API_BASE,
    ) {}

    async getAccountStatus(apiKey: string, force = false): Promise<CommandCodeAccountStatus> {
        if (!apiKey || !apiKey.trim()) {
            return {
                available: false,
                hasKey: false,
            };
        }

        const trimmedKey = apiKey.trim();
        if (!force && this.cachedStatus && this.cachedStatus.apiKey === trimmedKey && Date.now() - this.cachedStatus.at < COMMANDCODE_STATUS_CACHE_MS) {
            return this.cachedStatus.value;
        }

        if (this.inFlight) {
            return this.inFlight;
        }

        this.inFlight = this.fetchStatus(trimmedKey).finally(() => {
            this.inFlight = undefined;
        });

        return this.inFlight;
    }

    private async fetchEndpoint(
        endpoint: string,
        apiKey: string,
    ): Promise<{ ok: boolean; status: number; data?: unknown }> {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            const res = await this.fetchFn(url, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'x-command-code-version': COMMANDCODE_VERSION,
                    'x-cli-environment': 'production',
                },
                signal: AbortSignal.timeout(COMMANDCODE_REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) {
                return { ok: false, status: res.status };
            }
            const data = await res.json().catch(() => undefined);
            return { ok: true, status: res.status, data };
        } catch {
            return { ok: false, status: 0 };
        }
    }

    private async fetchStatus(apiKey: string): Promise<CommandCodeAccountStatus> {
        const [whoamiRes, summaryRes, creditsRes] = await Promise.all([
            this.fetchEndpoint('/alpha/whoami', apiKey),
            this.fetchEndpoint('/alpha/usage/summary', apiKey),
            this.fetchEndpoint('/alpha/billing/credits', apiKey),
        ]);

        const whoami = whoamiRes.ok ? parseCommandCodeWhoami(whoamiRes.data) : undefined;
        const subEndpoint = whoami?.orgId
            ? `/alpha/billing/subscriptions?orgId=${encodeURIComponent(whoami.orgId)}`
            : '/alpha/billing/subscriptions';
        const subRes = await this.fetchEndpoint(subEndpoint, apiKey);

        const anySuccess = whoamiRes.ok || summaryRes.ok || creditsRes.ok || subRes.ok;
        const isUnauthorized = [whoamiRes, summaryRes, creditsRes, subRes].some(r => r.status === 401);

        if (!anySuccess) {
            const failedStatus: CommandCodeAccountStatus = {
                available: false,
                hasKey: true,
                error: isUnauthorized ? 'Unauthorized (401)' : 'Quota details unavailable',
            };
            this.cachedStatus = { apiKey, value: failedStatus, at: Date.now() };
            return failedStatus;
        }

        const summary = summaryRes.ok ? parseCommandCodeUsageSummary(summaryRes.data) : undefined;
        const creditsData = creditsRes.ok ? parseCommandCodeCredits(creditsRes.data) : undefined;
        const subscription = subRes.ok ? parseCommandCodeSubscription(subRes.data) : undefined;
        const planId = subscription?.planId || creditsData?.credits?.planId;

        const value: CommandCodeAccountStatus = {
            available: true,
            hasKey: true,
            user: whoami?.user,
            orgId: whoami?.orgId,
            credits: creditsData?.credits,
            windowLimits: creditsData?.windowLimits,
            usageSummary: summary,
            subscription,
            planId,
        };

        this.cachedStatus = { apiKey, value, at: Date.now() };
        return value;
    }
}

let defaultAccountService: CommandCodeAccountService | undefined;

export function getCommandCodeAccountStatus(
    apiKey: string,
    force = false,
    fetchFn?: typeof fetch,
    baseUrl?: string,
): Promise<CommandCodeAccountStatus> {
    if (fetchFn || baseUrl) {
        return new CommandCodeAccountService(fetchFn, baseUrl).getAccountStatus(apiKey, force);
    }
    if (!defaultAccountService) {
        defaultAccountService = new CommandCodeAccountService();
    }
    return defaultAccountService.getAccountStatus(apiKey, force);
}
