export type PromptState = 'pending' | 'running' | 'steered' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type InteractionKind = 'approval' | 'question' | 'user_tool' | 'plan_review';
export type InteractionState = 'pending' | 'resolved' | 'cancelled';

export interface RuntimePrompt {
    id: string;
    topicId: string;
    threadId: string;
    turnId?: string;
    text: string;
    state: PromptState;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

export interface RuntimeInteraction {
    id: string;
    topicId: string;
    threadId: string;
    turnId?: string;
    runId?: string;
    kind: InteractionKind;
    title: string;
    detail?: string;
    state: InteractionState;
    createdAt: number;
    resolvedAt?: number;
    resolution?: unknown;
}

export interface PromptHandle {
    prompt: RuntimePrompt;
    launched: Promise<RuntimePrompt>;
    completion: Promise<RuntimePrompt>;
}

interface PromptDeferred {
    prompt: RuntimePrompt;
    resolveLaunched: (prompt: RuntimePrompt) => void;
    resolveCompletion: (prompt: RuntimePrompt) => void;
}

function clonePrompt(prompt: RuntimePrompt): RuntimePrompt {
    return { ...prompt };
}

function cloneInteraction(interaction: RuntimeInteraction): RuntimeInteraction {
    return { ...interaction };
}

/** First-class prompt lifecycle, separate from execution queue mechanics. */
export class PromptQueueService {
    private readonly prompts = new Map<string, PromptDeferred>();
    private sequence = 0;

    enqueue(input: Omit<RuntimePrompt, 'id' | 'state' | 'createdAt' | 'updatedAt'>): PromptHandle {
        const now = Date.now();
        const prompt: RuntimePrompt = {
            ...input,
            id: `prompt_${now}_${this.sequence++}`,
            state: 'pending',
            createdAt: now,
            updatedAt: now,
        };
        let resolveLaunched!: (value: RuntimePrompt) => void;
        let resolveCompletion!: (value: RuntimePrompt) => void;
        const launched = new Promise<RuntimePrompt>(resolve => { resolveLaunched = resolve; });
        const completion = new Promise<RuntimePrompt>(resolve => { resolveCompletion = resolve; });
        this.prompts.set(prompt.id, { prompt, resolveLaunched, resolveCompletion });
        return { prompt: clonePrompt(prompt), launched, completion };
    }

    transition(id: string, state: PromptState, error?: string): RuntimePrompt | undefined {
        const entry = this.prompts.get(id);
        if (!entry) return undefined;
        if (['completed', 'failed', 'cancelled', 'blocked'].includes(entry.prompt.state)) {
            return clonePrompt(entry.prompt);
        }
        entry.prompt = { ...entry.prompt, state, error, updatedAt: Date.now() };
        const snapshot = clonePrompt(entry.prompt);
        if (state === 'running' || state === 'steered') entry.resolveLaunched(snapshot);
        if (['completed', 'failed', 'cancelled', 'blocked'].includes(state)) {
            entry.resolveLaunched(snapshot);
            entry.resolveCompletion(snapshot);
        }
        return snapshot;
    }

    get(id: string): RuntimePrompt | undefined {
        const entry = this.prompts.get(id);
        return entry ? clonePrompt(entry.prompt) : undefined;
    }

    list(threadId?: string): RuntimePrompt[] {
        return [...this.prompts.values()]
            .map(entry => clonePrompt(entry.prompt))
            .filter(prompt => !threadId || prompt.threadId === threadId)
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-200);
    }

    restore(prompts: readonly RuntimePrompt[]): void {
        for (const prompt of prompts) {
            if (this.prompts.has(prompt.id)) continue;
            const interrupted = prompt.state === 'pending' || prompt.state === 'running' || prompt.state === 'steered';
            const restored: RuntimePrompt = interrupted
                ? {
                    ...clonePrompt(prompt),
                    state: 'blocked',
                    updatedAt: Date.now(),
                    error: 'Interrupted by extension restart; resubmit the prompt to continue.',
                }
                : clonePrompt(prompt);
            let resolveLaunched!: (value: RuntimePrompt) => void;
            let resolveCompletion!: (value: RuntimePrompt) => void;
            const launched = new Promise<RuntimePrompt>(resolve => { resolveLaunched = resolve; });
            const completion = new Promise<RuntimePrompt>(resolve => { resolveCompletion = resolve; });
            void launched;
            void completion;
            this.prompts.set(restored.id, { prompt: restored, resolveLaunched, resolveCompletion });
            if (restored.state !== 'pending') resolveLaunched(clonePrompt(restored));
            if (['completed', 'failed', 'cancelled', 'blocked'].includes(restored.state)) {
                resolveCompletion(clonePrompt(restored));
            }
        }
    }
}

/** Unified cold interaction store. Entries are created only when user input is actually required. */
export class InteractionService {
    private readonly interactions = new Map<string, RuntimeInteraction>();

    request(input: Omit<RuntimeInteraction, 'state' | 'createdAt' | 'resolvedAt' | 'resolution'>): RuntimeInteraction {
        const existing = this.interactions.get(input.id);
        if (existing) return cloneInteraction(existing);
        const interaction: RuntimeInteraction = {
            ...input,
            state: 'pending',
            createdAt: Date.now(),
        };
        this.interactions.set(interaction.id, interaction);
        this.trim();
        return cloneInteraction(interaction);
    }

    resolve(id: string, resolution: unknown): RuntimeInteraction | undefined {
        const current = this.interactions.get(id);
        if (!current || current.state !== 'pending') return current ? cloneInteraction(current) : undefined;
        const next: RuntimeInteraction = {
            ...current,
            state: 'resolved',
            resolution,
            resolvedAt: Date.now(),
        };
        this.interactions.set(id, next);
        return cloneInteraction(next);
    }

    cancel(id: string, resolution?: unknown): RuntimeInteraction | undefined {
        const current = this.interactions.get(id);
        if (!current || current.state !== 'pending') return current ? cloneInteraction(current) : undefined;
        const next: RuntimeInteraction = {
            ...current,
            state: 'cancelled',
            resolution,
            resolvedAt: Date.now(),
        };
        this.interactions.set(id, next);
        return cloneInteraction(next);
    }

    list(input: { threadId?: string; state?: InteractionState } = {}): RuntimeInteraction[] {
        return [...this.interactions.values()]
            .filter(item => !input.threadId || item.threadId === input.threadId)
            .filter(item => !input.state || item.state === input.state)
            .map(cloneInteraction)
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    restore(interactions: readonly RuntimeInteraction[]): void {
        for (const interaction of interactions) {
            if (!this.interactions.has(interaction.id)) {
                const restored: RuntimeInteraction = interaction.state === 'pending'
                    ? {
                        ...cloneInteraction(interaction),
                        state: 'cancelled',
                        resolvedAt: Date.now(),
                        resolution: { reason: 'extension_restart' },
                    }
                    : cloneInteraction(interaction);
                this.interactions.set(interaction.id, restored);
            }
        }
        this.trim();
    }

    private trim(): void {
        if (this.interactions.size <= 300) return;
        for (const item of this.list().filter(value => value.state !== 'pending').slice(0, this.interactions.size - 300)) {
            this.interactions.delete(item.id);
        }
    }
}
