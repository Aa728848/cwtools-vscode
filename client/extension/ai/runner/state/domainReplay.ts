import type { DomainSnapshot } from './domainModel';
import { DomainOpRegistry, type PersistedDomainOp } from './domainOp';

export interface ReplayResult {
    snapshot: DomainSnapshot;
    applied: number;
    rejected?: { sequence: number; reason: string };
}

export function replayDomainOps(
    base: DomainSnapshot,
    operations: readonly PersistedDomainOp[],
    registry: DomainOpRegistry,
): ReplayResult {
    const snapshot: DomainSnapshot = JSON.parse(JSON.stringify(base)) as DomainSnapshot;
    let expected = base.sequence + 1;
    let applied = 0;
    for (const operation of operations) {
        if (operation.sequence !== expected) {
            return { snapshot, applied, rejected: { sequence: operation.sequence, reason: `Expected sequence ${expected}.` } };
        }
        const definition = registry.resolve(operation.type);
        if (!definition || definition.version !== operation.version || definition.domain !== operation.domain) {
            return { snapshot, applied, rejected: { sequence: operation.sequence, reason: `Unknown or incompatible operation ${operation.type}.` } };
        }
        if (!definition.validatePayload(operation.payload)) {
            return { snapshot, applied, rejected: { sequence: operation.sequence, reason: `Invalid payload for ${operation.type}.` } };
        }
        const current = snapshot.models[operation.domain];
        try {
            snapshot.models[operation.domain] = definition.apply(current, operation.payload);
        } catch (error) {
            return {
                snapshot,
                applied,
                rejected: {
                    sequence: operation.sequence,
                    reason: error instanceof Error ? error.message : String(error),
                },
            };
        }
        snapshot.sequence = operation.sequence;
        expected += 1;
        applied += 1;
    }
    return { snapshot, applied };
}
