import * as crypto from 'crypto';
import * as path from 'path';
import { getPrivateTopicStorageDir } from '../../workspacePaths';
import type { DomainModel, DomainSnapshot } from './domainModel';
import { DomainOpRegistry, type DomainOp, type PersistedDomainOp } from './domainOp';
import { DomainJournal } from './domainJournal';
import { replayDomainOps } from './domainReplay';
import type { DomainName } from './stateKey';
import { runtimeFaultInjector } from '../faultInjection';
import {
    fileAppendLogStore,
    fileAtomicDocumentStore,
    type AppendLogStore,
    type AtomicDocumentStore,
} from '../storageAccess';

function isDomainSnapshot(value: unknown): value is DomainSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<DomainSnapshot>;
    return snapshot.version === 1
        && typeof snapshot.agentId === 'string'
        && typeof snapshot.sequence === 'number'
        && !!snapshot.models
        && typeof snapshot.models === 'object';
}

export class DomainStateStore {
    private readonly models = new Map<DomainName, DomainModel<unknown>>();
    private snapshotValue?: DomainSnapshot;
    private operationSequence = 0;
    private applyQueue: Promise<void> = Promise.resolve();
    private readonly journalValue: DomainJournal;

    constructor(
        private readonly topicId: string,
        private readonly agentId: string,
        readonly registry = new DomainOpRegistry(),
        private readonly documents: AtomicDocumentStore = fileAtomicDocumentStore,
        private readonly logs: AppendLogStore = fileAppendLogStore,
    ) {
        this.journalValue = new DomainJournal(path.join(this.baseDir(), 'journal.jsonl'), this.logs);
    }

    registerModel<T>(model: DomainModel<T>): void {
        if (this.models.has(model.domain)) throw new Error(`Domain model "${model.domain}" is already registered.`);
        this.models.set(model.domain, model as DomainModel<unknown>);
    }

    async restore(): Promise<DomainSnapshot> {
        const loaded = this.documents.read<DomainSnapshot>(
            this.snapshotPath(),
            (value): value is DomainSnapshot => isDomainSnapshot(value)
                && value.agentId === this.agentId
                && (!value.checksum || value.checksum === this.checksum(value)),
        );
        const base: DomainSnapshot = loaded ?? {
            version: 1,
            agentId: this.agentId,
            sequence: 0,
            models: {},
        };
        for (const model of this.models.values()) {
            if (!model.validateState(base.models[model.domain])) {
                base.models[model.domain] = model.initialState();
            }
        }
        const read = this.journalValue.read(base.sequence);
        await read.recovery;
        const replay = replayDomainOps(base, read.operations, this.registry);
        this.snapshotValue = replay.snapshot;
        this.operationSequence = replay.snapshot.sequence;
        if (replay.rejected) {
            throw new Error(`Domain replay stopped at ${replay.rejected.sequence}: ${replay.rejected.reason}`);
        }
        return this.cloneSnapshot();
    }

    apply(operation: DomainOp): Promise<PersistedDomainOp> {
        const current = this.applyQueue.then(() => this.applyInternal(operation));
        this.applyQueue = current.then(() => undefined, () => undefined);
        return current;
    }

    private async applyInternal(operation: DomainOp): Promise<PersistedDomainOp> {
        if (!this.snapshotValue) await this.restore();
        const definition = this.registry.resolve(operation.type);
        if (!definition || definition.version !== operation.version || definition.domain !== operation.domain) {
            throw new Error(`Unknown or incompatible domain operation "${operation.type}".`);
        }
        if (!definition.validatePayload(operation.payload)) {
            throw new Error(`Invalid payload for domain operation "${operation.type}".`);
        }
        const sequence = this.operationSequence + 1;
        const operationId = crypto.randomUUID();
        const persisted = await this.journalValue.append(operation, sequence, operationId);
        const replay = replayDomainOps(this.snapshotValue!, [persisted], this.registry);
        if (replay.rejected) throw new Error(replay.rejected.reason);
        this.snapshotValue = replay.snapshot;
        this.operationSequence = sequence;
        return persisted;
    }

    checkpoint(): Promise<DomainSnapshot> {
        const current = this.applyQueue.then(() => this.checkpointInternal());
        this.applyQueue = current.then(() => undefined, () => undefined);
        return current;
    }

    private async checkpointInternal(): Promise<DomainSnapshot> {
        if (!this.snapshotValue) await this.restore();
        await runtimeFaultInjector.hit('before_checkpoint');
        const snapshot = this.cloneSnapshot();
        snapshot.checksum = this.checksum(snapshot);
        await this.documents.write(this.snapshotPath(), snapshot);
        await this.journalValue.compactThrough(snapshot.sequence);
        this.snapshotValue = snapshot;
        return this.cloneSnapshot();
    }

    async dispose(): Promise<void> {
        if (this.snapshotValue) await this.checkpoint();
    }

    getSnapshot(): DomainSnapshot {
        if (!this.snapshotValue) throw new Error('Domain state has not been restored.');
        return this.cloneSnapshot();
    }

    private cloneSnapshot(): DomainSnapshot {
        return JSON.parse(JSON.stringify(this.snapshotValue)) as DomainSnapshot;
    }

    private checksum(snapshot: DomainSnapshot): string {
        const withoutChecksum = { ...snapshot, checksum: undefined };
        return crypto.createHash('sha256').update(JSON.stringify(withoutChecksum), 'utf8').digest('hex');
    }

    private baseDir(): string {
        const safeAgentId = this.agentId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(getPrivateTopicStorageDir(this.topicId), 'agents', safeAgentId, 'domain');
    }

    private snapshotPath(): string {
        return path.join(this.baseDir(), 'snapshot.json');
    }

}
