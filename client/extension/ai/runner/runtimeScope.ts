export type RuntimeScopeKind = 'app' | 'session' | 'agent';

export interface RuntimeScopeSnapshot {
    id: string;
    kind: RuntimeScopeKind;
    state: 'active' | 'draining' | 'disposed';
    services: string[];
    children: RuntimeScopeSnapshot[];
}

type DisposableValue = { dispose(): void | Promise<void> };

function isDisposable(value: unknown): value is DisposableValue {
    return !!value && typeof value === 'object'
        && typeof (value as Partial<DisposableValue>).dispose === 'function';
}

/** Hierarchical owner for runtime services and their deterministic disposal. */
export class RuntimeScope {
    private readonly values = new Map<string, unknown>();
    private readonly factories = new Map<string, Promise<unknown>>();
    private readonly children = new Map<string, RuntimeScope>();
    private stateValue: RuntimeScopeSnapshot['state'] = 'active';

    constructor(
        readonly kind: RuntimeScopeKind,
        readonly id: string,
        readonly parent?: RuntimeScope,
    ) {}

    child(kind: Exclude<RuntimeScopeKind, 'app'>, id: string): RuntimeScope {
        this.assertActive();
        const key = `${kind}:${id}`;
        let child = this.children.get(key);
        if (!child) {
            child = new RuntimeScope(kind, id, this);
            this.children.set(key, child);
        }
        return child;
    }

    set<T>(key: string, value: T): T {
        this.assertActive();
        if (this.values.has(key)) throw new Error(`Runtime service "${key}" is already registered in ${this.kind}:${this.id}.`);
        this.values.set(key, value);
        return value;
    }

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async getOrCreate<T>(key: string, factory: () => T | Promise<T>): Promise<T> {
        this.assertActive();
        const existing = this.values.get(key);
        if (existing !== undefined) return existing as T;
        let pending = this.factories.get(key);
        if (!pending) {
            pending = Promise.resolve().then(factory).then(value => {
                this.assertActive();
                this.values.set(key, value);
                this.factories.delete(key);
                return value;
            }, error => {
                this.factories.delete(key);
                throw error;
            });
            this.factories.set(key, pending);
        }
        return pending as Promise<T>;
    }

    snapshot(): RuntimeScopeSnapshot {
        return {
            id: this.id,
            kind: this.kind,
            state: this.stateValue,
            services: [...new Set([...this.values.keys(), ...this.factories.keys()])].sort(),
            children: [...this.children.values()].map(child => child.snapshot())
                .sort((a, b) => a.id.localeCompare(b.id)),
        };
    }

    async dispose(): Promise<void> {
        if (this.stateValue === 'disposed') return;
        this.stateValue = 'draining';
        await Promise.allSettled([...this.factories.values()]);
        for (const child of [...this.children.values()].reverse()) await child.dispose();
        for (const value of [...this.values.values()].reverse()) {
            if (isDisposable(value)) await value.dispose();
        }
        this.children.clear();
        this.values.clear();
        this.stateValue = 'disposed';
    }

    private assertActive(): void {
        if (this.stateValue !== 'active') {
            throw new Error(`Runtime scope ${this.kind}:${this.id} is ${this.stateValue}.`);
        }
    }
}

