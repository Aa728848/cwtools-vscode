export type RecoveryStormCategory =
    | 'provider_transport'
    | 'context_overflow'
    | 'rate_limit'
    | 'reviewer_rejection'
    | 'no_progress'
    | 'stopped_operation';

export interface RecoveryStormDecision {
    tripped: boolean;
    category: RecoveryStormCategory;
    count: number;
    distinctNodes: number;
    reason?: string;
}

interface Bucket {
    count: number;
    nodes: Set<string>;
    details: string[];
}

const LIMITS: Record<RecoveryStormCategory, { count: number; distinctNodes: number }> = {
    provider_transport: { count: 3, distinctNodes: 2 },
    context_overflow: { count: 3, distinctNodes: 2 },
    rate_limit: { count: 4, distinctNodes: 2 },
    reviewer_rejection: { count: 3, distinctNodes: 1 },
    no_progress: { count: 3, distinctNodes: 2 },
    stopped_operation: { count: 2, distinctNodes: 2 },
};

export function classifyStormFailure(error: string | undefined, output = ''): RecoveryStormCategory | undefined {
    const text = `${error ?? ''}\n${output}`;
    if (/context(?:_| )length|context window|maximum context|too many tokens/i.test(text)) return 'context_overflow';
    if (/429|rate.?limit|too many requests/i.test(text)) return 'rate_limit';
    if (/socket hang up|ECONNRESET|ETIMEDOUT|unexpected EOF|network|fetch failed|provider unavailable/i.test(text)) return 'provider_transport';
    if (/already stopped|operation stopped|repeatedly refused|permission denied|approval denied/i.test(text)) return 'stopped_operation';
    if (!error && output.trim().length < 32) return 'no_progress';
    if (/no progress|made no changes|nothing (?:was )?done|empty response/i.test(text)) return 'no_progress';
    return undefined;
}

/** Parent-scoped circuit breaker. Exact file/anchor failures remain child-scoped. */
export class RecoveryStormBudget {
    private readonly buckets = new Map<RecoveryStormCategory, Bucket>();
    private terminal?: RecoveryStormDecision;

    reset(): void {
        this.buckets.clear();
        this.terminal = undefined;
    }

    record(category: RecoveryStormCategory, nodeId: string, detail = ''): RecoveryStormDecision {
        if (this.terminal) return this.terminal;
        const bucket = this.buckets.get(category) ?? { count: 0, nodes: new Set<string>(), details: [] };
        bucket.count++;
        bucket.nodes.add(nodeId);
        if (detail && bucket.details.length < 5) bucket.details.push(detail.slice(0, 300));
        this.buckets.set(category, bucket);
        const limit = LIMITS[category];
        const tripped = bucket.count >= limit.count && bucket.nodes.size >= limit.distinctNodes;
        const decision: RecoveryStormDecision = {
            tripped,
            category,
            count: bucket.count,
            distinctNodes: bucket.nodes.size,
            reason: tripped
                ? `Parent recovery storm stopped after ${bucket.count} ${category} event(s) across ${bucket.nodes.size} node(s). Safe read-only diagnostics may continue.`
                : undefined,
        };
        if (tripped) this.terminal = decision;
        return decision;
    }

    get decision(): RecoveryStormDecision | undefined {
        return this.terminal;
    }
}
