import { createLoopHookSlots, type LoopHookSlots } from './loopHooks';
import { compareStepRequests, type StepRequest } from './stepRequest';

export type LoopKernelStatus = 'idle' | 'running' | 'stopping' | 'disposed';

export interface LoopStepContext {
    request: StepRequest;
    signal: AbortSignal;
}

export interface LoopKernelOptions {
    execute: (context: LoopStepContext) => Promise<unknown>;
    hooks?: LoopHookSlots<LoopStepContext>;
    onError?: (error: unknown, context: LoopStepContext) => Promise<'continue' | 'stop'> | 'continue' | 'stop';
}

export type EnqueuePosition = 'priority' | 'front' | 'back';
export type LoopErrorHandler = (
    error: unknown,
    context: LoopStepContext,
) => Promise<'continue' | 'stop'> | 'continue' | 'stop';

/** 
 * Serializes every source of work through one deterministic priority queue.
 * A request id is accepted at most once until the kernel becomes quiescent.
 */
export class AgentLoopKernel {
    private readonly queue: StepRequest[] = [];
    private readonly accepted = new Set<string>();
    private controller = new AbortController();
    private readonly completions = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }>();
    private readonly errorHandlers = new Map<string, { order: number; handler: LoopErrorHandler }>();
    private drainPromise?: Promise<void>;
    private current?: LoopStepContext;
    private statusValue: LoopKernelStatus = 'idle';
    readonly hooks: LoopHookSlots<LoopStepContext>;

    constructor(private readonly options: LoopKernelOptions) {
        this.hooks = options.hooks ?? createLoopHookSlots<LoopStepContext>();
    }

    get status(): LoopKernelStatus {
        return this.statusValue;
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    enqueue(request: StepRequest, position: EnqueuePosition = 'priority'): boolean {
        if (this.statusValue === 'disposed' || this.statusValue === 'stopping' || this.accepted.has(request.id)) {
            return false;
        }
        this.accepted.add(request.id);
        if (position === 'front') this.queue.unshift(request);
        else this.queue.push(request);
        if (position === 'priority') this.queue.sort(compareStepRequests);
        return true;
    }

    /** Enqueue one request, start the drain, and resolve with that request's result. */
    run<T = unknown>(request: StepRequest, position: EnqueuePosition = 'priority'): Promise<T> {
        if (!this.enqueue(request, position)) {
            return Promise.reject(new Error(`Step request "${request.id}" was not accepted.`));
        }
        const completion = new Promise<T>((resolve, reject) => {
            this.completions.set(request.id, {
                resolve: value => resolve(value as T),
                reject,
            });
        });
        void this.runUntilIdle().catch(error => {
            const pending = this.completions.get(request.id);
            if (pending) {
                this.completions.delete(request.id);
                pending.reject(error);
            }
        });
        return completion;
    }

    runUntilIdle(): Promise<void> {
        if (this.statusValue === 'disposed') return Promise.reject(new Error('Loop kernel is disposed.'));
        if (this.drainPromise) return this.drainPromise;
        this.statusValue = 'running';
        this.drainPromise = this.drain().finally(() => {
            this.drainPromise = undefined;
            const shouldResume = this.statusValue !== 'disposed'
                && this.statusValue !== 'stopping'
                && this.queue.length > 0;
            if (this.statusValue !== 'disposed' && this.statusValue !== 'stopping') this.statusValue = 'idle';
            if (this.queue.length === 0) this.accepted.clear();
            if (shouldResume) queueMicrotask(() => { void this.runUntilIdle(); });
        });
        return this.drainPromise;
    }

    stop(reason?: unknown): void {
        if (this.statusValue === 'disposed') return;
        this.statusValue = 'stopping';
        this.queue.splice(0);
        const error = reason ?? new Error('Loop stopped.');
        this.controller.abort(error);
        for (const completion of this.completions.values()) completion.reject(error);
        this.completions.clear();
    }

    cancel(turnId: string, reason?: unknown): boolean {
        const error = reason ?? new Error(`Turn "${turnId}" cancelled.`);
        let cancelled = false;
        for (let index = this.queue.length - 1; index >= 0; index--) {
            const request = this.queue[index]!;
            if (request.id !== turnId && request.sourceId !== turnId) continue;
            this.queue.splice(index, 1);
            this.accepted.delete(request.id);
            const completion = this.completions.get(request.id);
            this.completions.delete(request.id);
            completion?.reject(error);
            cancelled = true;
        }
        if (this.current
            && (this.current.request.id === turnId || this.current.request.sourceId === turnId)) {
            this.controller.abort(error);
            cancelled = true;
        }
        return cancelled;
    }

    async settled(): Promise<void> {
        while (this.drainPromise || this.queue.length > 0) {
            if (this.drainPromise) await this.drainPromise;
            else {
                await Promise.resolve();
                if (!this.drainPromise && this.queue.length > 0) void this.runUntilIdle();
            }
        }
    }

    tryAcquireQuiescence(): boolean {
        return this.statusValue === 'idle' && this.queue.length === 0 && !this.current;
    }

    registerErrorHandler(id: string, handler: LoopErrorHandler, order = 0): () => void {
        if (this.errorHandlers.has(id)) throw new Error(`Loop error handler "${id}" is already registered.`);
        this.errorHandlers.set(id, { order, handler });
        return () => this.errorHandlers.delete(id);
    }

    get onWillBeginStep(): LoopHookSlots<LoopStepContext>['beforeStep'] {
        return this.hooks.beforeStep;
    }

    get onDidFinishStep(): LoopHookSlots<LoopStepContext>['afterStep'] {
        return this.hooks.afterStep;
    }

    dispose(): void {
        this.stop(new Error('Loop disposed.'));
        this.statusValue = 'disposed';
    }

    private async drain(): Promise<void> {
        while (this.queue.length > 0 && !this.controller.signal.aborted) {
            const request = this.queue.shift()!;
            const context: LoopStepContext = { request, signal: this.controller.signal };
            this.current = context;
            try {
                await this.hooks.beforeStep.run(context, context.signal);
                const value = await this.options.execute(context);
                await this.hooks.afterStep.run(context, context.signal);
                this.completions.get(request.id)?.resolve(value);
                this.completions.delete(request.id);
            } catch (error) {
                this.completions.get(request.id)?.reject(error);
                this.completions.delete(request.id);
                if (context.signal.aborted) break;
                let decision = await this.options.onError?.(error, context)
                    ?? (this.errorHandlers.size > 0 ? 'continue' : 'stop');
                for (const { handler } of [...this.errorHandlers.values()]
                    .sort((left, right) => left.order - right.order)) {
                    decision = await handler(error, context);
                    if (decision === 'stop') break;
                }
                if (decision === 'stop') {
                    this.stop(error);
                    break;
                }
            } finally {
                this.current = undefined;
            }
        }
        if (this.controller.signal.aborted && this.statusValue !== 'disposed') {
            this.controller = new AbortController();
        }
    }
}
