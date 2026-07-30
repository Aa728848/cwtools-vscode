export type FaultPoint =
    | 'before_model'
    | 'after_model'
    | 'before_tool'
    | 'after_tool'
    | 'before_journal_append'
    | 'after_journal_append'
    | 'before_checkpoint'
    | 'during_compaction'
    | 'before_task_notify'
    | 'before_hook';

export type FaultKind =
    | 'provider_429'
    | 'provider_500'
    | 'provider_timeout'
    | 'provider_empty_response'
    | 'provider_context_overflow'
    | 'tool_timeout'
    | 'tool_cancelled'
    | 'tool_result_lost'
    | 'compaction_failure'
    | 'journal_partial_write'
    | 'checkpoint_corrupt'
    | 'background_task_lost'
    | 'hook_failure';

export interface FaultRule {
    point: FaultPoint;
    occurrence: number;
    action: 'throw' | 'abort' | 'delay';
    kind?: FaultKind;
    delayMs?: number;
    message?: string;
}

export class FaultInjector {
    private readonly occurrences = new Map<FaultPoint, number>();
    private rules: FaultRule[];

    constructor(
        private enabledValue: boolean,
        rules: readonly FaultRule[] = [],
    ) {
        this.rules = [...rules];
    }

    get enabled(): boolean {
        return this.enabledValue;
    }

    setEnabled(enabled: boolean): void {
        this.enabledValue = enabled;
        if (!enabled) this.reset();
    }

    arm(rule: FaultRule): void {
        this.rules = [...this.rules.filter(candidate => candidate.point !== rule.point), { ...rule }];
        this.occurrences.delete(rule.point);
    }

    disarm(point?: FaultPoint): void {
        this.rules = point ? this.rules.filter(rule => rule.point !== point) : [];
        if (point) this.occurrences.delete(point);
        else this.reset();
    }

    reset(): void {
        this.occurrences.clear();
    }

    async hit(point: FaultPoint, signal?: AbortSignal): Promise<void> {
        if (!this.enabled) return;
        const occurrence = (this.occurrences.get(point) ?? 0) + 1;
        this.occurrences.set(point, occurrence);
        const rule = this.rules.find(candidate => candidate.point === point && candidate.occurrence === occurrence);
        if (!rule) return;
        if (rule.action === 'delay') {
            const delayMs = Math.max(0, Math.min(rule.delayMs ?? 0, 30_000));
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason ?? new Error('Fault delay aborted.'));
                }, { once: true });
            });
            return;
        }
        const error = new Error(rule.message ?? rule.kind ?? `Injected fault at ${point}.`);
        error.name = rule.action === 'abort' ? 'AbortError' : 'InjectedFault';
        if (rule.kind === 'provider_429') Object.assign(error, { status: 429 });
        if (rule.kind === 'provider_500') Object.assign(error, { status: 500 });
        if (rule.kind === 'provider_context_overflow') Object.assign(error, { status: 413 });
        if (rule.kind === 'provider_timeout' || rule.kind === 'tool_timeout') error.name = 'TimeoutError';
        if (rule.kind === 'tool_cancelled') error.name = 'AbortError';
        throw error;
    }
}

/** Process-local injector; disabled unless the developer setting is enabled and a rule is armed. */
export const runtimeFaultInjector = new FaultInjector(false);
