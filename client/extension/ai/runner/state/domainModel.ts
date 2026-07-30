import type { DomainName } from './stateKey';

export interface DomainModel<TState> {
    readonly domain: DomainName;
    readonly version: number;
    readonly initialState: () => TState;
    readonly validateState: (value: unknown) => value is TState;
}

export interface DomainSnapshot {
    version: 1;
    agentId: string;
    sequence: number;
    models: Partial<Record<DomainName, unknown>>;
    checksum?: string;
}
