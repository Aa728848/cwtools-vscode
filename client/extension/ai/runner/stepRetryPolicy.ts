export type RetryReason =
    | 'rate_limit'
    | 'server_error'
    | 'timeout'
    | 'context_overflow'
    | 'empty_response'
    | 'output_truncated'
    | 'non_retryable';

export interface StepRetryDecision {
    retry: boolean;
    reason: RetryReason;
    delayMs: number;
    shrinkInput: boolean;
}

function errorText(error: unknown): string {
    if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
    return String(error ?? '').toLowerCase();
}

function statusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as Record<string, unknown>;
    const value = record.status ?? record.statusCode ?? record.code;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export class StepRetryPolicy {
    constructor(
        private readonly maxAttempts = 3,
        private readonly baseDelayMs = 250,
        private readonly maxDelayMs = 4_000,
    ) {}

    decide(error: unknown, attempt: number): StepRetryDecision {
        const text = errorText(error);
        const status = statusCode(error);
        const reason: RetryReason =
            status === 413 || /context (?:length|window)|too many tokens|context overflow/.test(text)
                ? 'context_overflow'
                : status === 429 || /rate.?limit|too many requests/.test(text)
                    ? 'rate_limit'
                    : (status !== undefined && status >= 500) || /server error|service unavailable|bad gateway/.test(text)
                        ? 'server_error'
                        : /timeout|timed out|etimedout|econnreset/.test(text)
                            ? 'timeout'
                            : /empty response/.test(text)
                                ? 'empty_response'
                                : /output.+(?:truncated|length limit)/.test(text)
                                    ? 'output_truncated'
                                    : 'non_retryable';
        const retry = attempt < this.maxAttempts && reason !== 'non_retryable';
        return {
            retry,
            reason,
            delayMs: retry
                ? Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
                : 0,
            shrinkInput: reason === 'context_overflow' || reason === 'empty_response' || reason === 'output_truncated',
        };
    }
}
