export type DomainName =
    | 'scheduling'
    | 'goal'
    | 'task'
    | 'context'
    | 'prompt'
    | 'interaction'
    | 'transcript'
    | 'permission';

export interface StateKey<T> {
    readonly domain: DomainName;
    readonly id: string;
    readonly initial: () => T;
}

export function stateKey<T>(domain: DomainName, id: string, initial: () => T): StateKey<T> {
    if (!id.trim()) throw new Error('State key id must not be empty.');
    return Object.freeze({ domain, id, initial });
}

export function serializeStateKey(key: Pick<StateKey<unknown>, 'domain' | 'id'>): string {
    return `${key.domain}:${key.id}`;
}
