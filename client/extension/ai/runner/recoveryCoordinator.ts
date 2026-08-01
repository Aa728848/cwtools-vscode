import { isAbortError } from './cancellation';

export type RecoveryErrorKind =
    | 'cancelled'
    | 'context_overflow'
    | 'rate_limit'
    | 'transport'
    | 'sandbox_unavailable'
    | 'permission_denied'
    | 'tool_validation'
    | 'provider'
    | 'unknown';

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
    else if (/terminated|socket hang up|ECONNRESET|ETIMEDOUT|unexpected EOF|network|fetch failed/i.test(message)) kind = 'transport';
    else if (/SandboxUnavailableError|sandbox unavailable/i.test(message)) kind = 'sandbox_unavailable';
    else if (/permission denied|approval denied|not approved/i.test(message)) kind = 'permission_denied';
    else if (/tool (?:argument|validation)|invalid tool|schema validation/i.test(message)) kind = 'tool_validation';
    else if (statusCode !== undefined) kind = 'provider';
    return new AgentRecoveryError(kind, message, error, statusCode);
}

/** Per-run bounded claims for recovery mechanisms, independent from tool iterations. */
export class RecoveryCoordinator {
    private readonly attempts = new Map<RecoveryErrorKind, number>();

    classify(error: unknown, options?: { estimatedTokens?: number; contextLimit?: number }): AgentRecoveryError {
        return classifyRecoveryError(error, options);
    }

    claim(kind: RecoveryErrorKind, maximum: number): number | undefined {
        const next = (this.attempts.get(kind) ?? 0) + 1;
        if (next > maximum) return undefined;
        this.attempts.set(kind, next);
        return next;
    }

    count(kind: RecoveryErrorKind): number {
        return this.attempts.get(kind) ?? 0;
    }
}
