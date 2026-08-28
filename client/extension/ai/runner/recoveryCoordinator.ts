import { isAbortError } from './cancellation';

export type RecoveryKind =
    | 'cancelled'
    | 'context_overflow'
    | 'rate_limit'
    | 'transport'
    | 'sandbox_unavailable'
    | 'permission_denied'
    | 'tool_validation'
    | 'output_repetition'
    | 'output_truncated'
    | 'compaction_ineffective'
    | 'incomplete_execution'
    | 'validation_failed'
    | 'provider_fallback'
    | 'provider'
    | 'unknown';

export type RecoveryErrorKind = Exclude<RecoveryKind,
    | 'output_repetition'
    | 'output_truncated'
    | 'compaction_ineffective'
    | 'incomplete_execution'
    | 'validation_failed'
    | 'provider_fallback'>;

export interface RecoveryClaim {
    kind: RecoveryKind;
    attempt: number;
    limit: number;
    totalAttempt: number;
    totalLimit: number;
}

const DEFAULT_LIMITS: Readonly<Record<RecoveryKind, number>> = {
    cancelled: 0,
    context_overflow: 2,
    rate_limit: 1,
    transport: 1,
    sandbox_unavailable: 0,
    permission_denied: 0,
    tool_validation: 1,
    output_repetition: 1,
    output_truncated: 1,
    compaction_ineffective: 2,
    incomplete_execution: 1,
    validation_failed: 2,
    provider_fallback: 1,
    provider: 1,
    unknown: 0,
};

export const DEFAULT_RECOVERY_BUDGET = 6;

export class AgentRecoveryError extends Error {
    constructor(
        public readonly kind: RecoveryErrorKind,
        message: string,
        public readonly cause: unknown,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'AgentRecoveryError';
    }
}

function statusCodeOf(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    return typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
}

export function classifyRecoveryError(
    error: unknown,
    options: { estimatedTokens?: number; contextLimit?: number } = {},
): AgentRecoveryError {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = statusCodeOf(error);
    const contextNearLimit = !!options.estimatedTokens && !!options.contextLimit
        && options.estimatedTokens >= options.contextLimit * 0.75;
    let kind: RecoveryErrorKind = 'unknown';
    if (isAbortError(error)) kind = 'cancelled';
    else if (/context(?:_| )length|context window|maximum context|too many tokens/i.test(message)
        || (statusCode === 413 && contextNearLimit)) kind = 'context_overflow';
    else if (statusCode === 429 || /rate.?limit|too many requests/i.test(message)) kind = 'rate_limit';
    else if (/terminated|timed? out|timeout|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|unexpected EOF|network|fetch failed/i.test(message)) kind = 'transport';
    else if (/SandboxUnavailableError|sandbox unavailable/i.test(message)) kind = 'sandbox_unavailable';
    else if (/permission denied|approval denied|not approved/i.test(message)) kind = 'permission_denied';
    else if (/tool (?:argument|validation)|invalid tool|schema validation/i.test(message)) kind = 'tool_validation';
    else if (statusCode !== undefined
        || /\b5\d{2}\b|server error|upstream error|service unavailable|bad gateway|overloaded|capacity|provider unavailable/i.test(message)) kind = 'provider';
    return new AgentRecoveryError(kind, message, error, statusCode);
}

/** One per-run budget for every automatic model recovery. */
export class RecoveryCoordinator {
    private readonly attempts = new Map<RecoveryKind, number>();
    private totalAttempts = 0;

    constructor(
        private readonly totalLimit = DEFAULT_RECOVERY_BUDGET,
        private readonly limits: Readonly<Partial<Record<RecoveryKind, number>>> = {},
    ) {}

    classify(error: unknown, options?: { estimatedTokens?: number; contextLimit?: number }): AgentRecoveryError {
        return classifyRecoveryError(error, options);
    }

    claim(kind: RecoveryKind): RecoveryClaim | undefined {
        const limit = this.limits[kind] ?? DEFAULT_LIMITS[kind];
        const next = (this.attempts.get(kind) ?? 0) + 1;
        if (next > limit || this.totalAttempts >= this.totalLimit) return undefined;
        this.attempts.set(kind, next);
        this.totalAttempts++;
        return {
            kind,
            attempt: next,
            limit,
            totalAttempt: this.totalAttempts,
            totalLimit: this.totalLimit,
        };
    }

    count(kind: RecoveryKind): number {
        return this.attempts.get(kind) ?? 0;
    }

    get total(): number {
        return this.totalAttempts;
    }
}
