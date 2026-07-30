export interface ContextWatermarks {
    effectiveLimit: number;
    triggerTokens: number;
    blockTokens: number;
    reservedTokens: number;
}

export class ContextLimitTracker {
    private readonly observedLimits = new Map<string, number>();

    get(provider: string, model: string, configuredLimit: number, reservedTokens = 4_096): ContextWatermarks {
        const key = this.key(provider, model);
        const effectiveLimit = Math.min(configuredLimit, this.observedLimits.get(key) ?? configuredLimit);
        const usable = Math.max(1, effectiveLimit - Math.max(0, reservedTokens));
        return {
            effectiveLimit,
            triggerTokens: Math.floor(usable * 0.75),
            blockTokens: Math.floor(usable * 0.90),
            reservedTokens: Math.max(0, reservedTokens),
        };
    }

    observeOverflow(provider: string, model: string, estimatedRequestTokens: number): number {
        const safeLimit = Math.max(1_024, Math.floor(estimatedRequestTokens * 0.90));
        const key = this.key(provider, model);
        const previous = this.observedLimits.get(key);
        const next = previous === undefined ? safeLimit : Math.min(previous, safeLimit);
        this.observedLimits.set(key, next);
        return next;
    }

    clear(): void {
        this.observedLimits.clear();
    }

    private key(provider: string, model: string): string {
        return `${provider.trim().toLowerCase()}\0${model.trim().toLowerCase()}`;
    }
}

export const contextLimitTracker = new ContextLimitTracker();
