import type { DomainOp, PersistedDomainOp } from './domainOp';
import { runtimeFaultInjector } from '../faultInjection';
import { fileAppendLogStore, type AppendLogStore } from '../storageAccess';

function isPersistedDomainOp(value: unknown): value is PersistedDomainOp {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<PersistedDomainOp>;
    return typeof candidate.type === 'string'
        && typeof candidate.version === 'number'
        && typeof candidate.domain === 'string'
        && typeof candidate.sequence === 'number'
        && Number.isSafeInteger(candidate.sequence)
        && candidate.sequence > 0
        && typeof candidate.operationId === 'string'
        && typeof candidate.timestamp === 'number';
}

export interface DomainJournalRead {
    operations: PersistedDomainOp[];
    truncated: boolean;
    recovery?: Promise<void>;
}

/** JSONL journal with serialized writes and fail-closed tail recovery. */
export class DomainJournal {
    private writeQueue = Promise.resolve();

    constructor(
        readonly filePath: string,
        private readonly storage: AppendLogStore = fileAppendLogStore,
    ) {}

    append(operation: DomainOp, sequence: number, operationId: string, timestamp = Date.now()): Promise<PersistedDomainOp> {
        const persisted: PersistedDomainOp = { ...operation, sequence, operationId, timestamp };
        this.writeQueue = this.writeQueue.then(async () => {
            await runtimeFaultInjector.hit('before_journal_append');
            await this.storage.append(this.filePath, `${JSON.stringify(persisted)}\n`);
            await runtimeFaultInjector.hit('after_journal_append');
        });
        return this.writeQueue.then(() => persisted);
    }

    read(afterSequence = 0): DomainJournalRead {
        const content = this.storage.read(this.filePath);
        if (content === undefined) return { operations: [], truncated: false };
        const lines = content.split(/\r?\n/);
        const operations: PersistedDomainOp[] = [];
        let expected: number | undefined;
        let stableLines = 0;
        let truncated = false;
        for (const line of lines) {
            if (!line.trim()) {
                stableLines += 1;
                continue;
            }
            try {
                const parsed: unknown = JSON.parse(line);
                if (!isPersistedDomainOp(parsed)) {
                    truncated = true;
                    break;
                }
                if (expected === undefined) {
                    if (parsed.sequence > afterSequence + 1) {
                        truncated = true;
                        break;
                    }
                    expected = parsed.sequence;
                }
                if (parsed.sequence !== expected) {
                    truncated = true;
                    break;
                }
                if (parsed.sequence > afterSequence) operations.push(parsed);
                expected += 1;
                stableLines += 1;
            } catch {
                truncated = true;
                break;
            }
        }
        let recovery: Promise<void> | undefined;
        if (truncated) {
            const stableText = lines.slice(0, stableLines).filter(Boolean).map(line => `${line}\n`).join('');
            recovery = this.storage.replace(this.filePath, stableText);
        }
        return { operations, truncated, recovery };
    }

    /** Drop operations already covered by an atomically persisted snapshot. */
    compactThrough(sequence: number): Promise<void> {
        this.writeQueue = this.writeQueue.then(async () => {
            const content = this.storage.read(this.filePath) ?? '';
            const retained: string[] = [];
            for (const line of content.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    const parsed: unknown = JSON.parse(line);
                    if (isPersistedDomainOp(parsed) && parsed.sequence > sequence) {
                        retained.push(JSON.stringify(parsed));
                    }
                } catch {
                    break;
                }
            }
            await this.storage.replace(
                this.filePath,
                retained.length > 0 ? `${retained.join('\n')}\n` : '',
            );
        });
        return this.writeQueue;
    }
}
