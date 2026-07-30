import { StepRetryPolicy, type StepRetryDecision } from './stepRetryPolicy';

export interface ModelRequestAttempt<TRequest> {
    request: TRequest;
    attempt: number;
    signal?: AbortSignal;
}

export interface ModelRequestServiceOptions<TRequest> {
    retryPolicy?: StepRetryPolicy;
    delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    shrink?: (request: TRequest, decision: StepRetryDecision) => TRequest | Promise<TRequest>;
    onRetry?: (decision: StepRetryDecision, attempt: number) => void | Promise<void>;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('Model retry cancelled.'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}

/** Owns bounded retry mechanics for one logical model step. */
export class ModelRequestService {
    async execute<TRequest, TResult>(
        initialRequest: TRequest,
        invoke: (attempt: ModelRequestAttempt<TRequest>) => Promise<TResult>,
        options: ModelRequestServiceOptions<TRequest> = {},
        signal?: AbortSignal,
    ): Promise<TResult> {
        const retryPolicy = options.retryPolicy ?? new StepRetryPolicy();
        let request = initialRequest;
        let attempt = 1;
        while (true) {
            signal?.throwIfAborted();
            try {
                return await invoke({ request, attempt, signal });
            } catch (error) {
                signal?.throwIfAborted();
                const decision = retryPolicy.decide(error, attempt);
                if (!decision.retry) throw error;
                await options.onRetry?.(decision, attempt);
                if (decision.shrinkInput && options.shrink) {
                    request = await options.shrink(request, decision);
                }
                await (options.delay ?? abortableDelay)(decision.delayMs, signal);
                attempt += 1;
            }
        }
    }
}
