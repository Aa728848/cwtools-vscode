import type { DomainName } from './stateKey';

export interface DomainOp<TPayload = unknown> {
    type: string;
    version: number;
    domain: DomainName;
    payload: TPayload;
}

export interface PersistedDomainOp<TPayload = unknown> extends DomainOp<TPayload> {
    sequence: number;
    operationId: string;
    timestamp: number;
}

export interface DomainOpDefinition<TState, TPayload> {
    type: string;
    version: number;
    domain: DomainName;
    validatePayload(value: unknown): value is TPayload;
    apply(state: Readonly<TState>, payload: Readonly<TPayload>): TState;
}

interface ErasedDomainOpDefinition {
    type: string;
    version: number;
    domain: DomainName;
    validatePayload(value: unknown): boolean;
    apply(state: unknown, payload: unknown): unknown;
}

export class DomainOpRegistry {
    private readonly definitions = new Map<string, ErasedDomainOpDefinition>();

    register<TState, TPayload>(definition: DomainOpDefinition<TState, TPayload>): void {
        if (this.definitions.has(definition.type)) {
            throw new Error(`Domain operation "${definition.type}" is already registered.`);
        }
        this.definitions.set(definition.type, {
            type: definition.type,
            version: definition.version,
            domain: definition.domain,
            validatePayload: definition.validatePayload,
            apply: (state, payload) => definition.apply(state as TState, payload as TPayload),
        });
    }

    resolve(type: string): ErasedDomainOpDefinition | undefined {
        return this.definitions.get(type);
    }
}
