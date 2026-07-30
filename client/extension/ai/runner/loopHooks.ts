export type LoopHookName =
    | 'beforePromptSubmit'
    | 'beforeStep'
    | 'afterStep'
    | 'beforeToolPolicy'
    | 'beforeToolExecute'
    | 'afterToolExecute'
    | 'beforeCompaction'
    | 'afterCompaction'
    | 'beforeTaskNotify'
    | 'afterTurn'
    | 'beforeFinalize';

export interface HookRegistration<T> {
    id: string;
    order: number;
    run: (value: T, signal?: AbortSignal) => void | Promise<void>;
}

/** Deterministic, mutation-safe hook collection. */
export class OrderedHookSlot<T> {
    private readonly registrations = new Map<string, HookRegistration<T>>();

    register(registration: HookRegistration<T>): () => void {
        if (this.registrations.has(registration.id)) {
            throw new Error(`Hook "${registration.id}" is already registered.`);
        }
        this.registrations.set(registration.id, registration);
        return () => this.registrations.delete(registration.id);
    }

    async run(value: T, signal?: AbortSignal): Promise<void> {
        const snapshot = [...this.registrations.values()]
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
        for (const registration of snapshot) {
            if (signal?.aborted) throw signal.reason ?? new Error('Hook execution cancelled.');
            await registration.run(value, signal);
        }
    }

    get size(): number {
        return this.registrations.size;
    }
}

export type LoopHookSlots<T = unknown> = Record<LoopHookName, OrderedHookSlot<T>>;

export function createLoopHookSlots<T = unknown>(): LoopHookSlots<T> {
    return {
        beforePromptSubmit: new OrderedHookSlot<T>(),
        beforeStep: new OrderedHookSlot<T>(),
        afterStep: new OrderedHookSlot<T>(),
        beforeToolPolicy: new OrderedHookSlot<T>(),
        beforeToolExecute: new OrderedHookSlot<T>(),
        afterToolExecute: new OrderedHookSlot<T>(),
        beforeCompaction: new OrderedHookSlot<T>(),
        afterCompaction: new OrderedHookSlot<T>(),
        beforeTaskNotify: new OrderedHookSlot<T>(),
        afterTurn: new OrderedHookSlot<T>(),
        beforeFinalize: new OrderedHookSlot<T>(),
    };
}
