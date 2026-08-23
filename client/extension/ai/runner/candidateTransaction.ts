import { createHash, randomUUID } from 'crypto';

export type CandidateTransactionState = 'active' | 'validated' | 'committed' | 'discarded';
export type DiskValue = string | Uint8Array;
export type ValidationResult = boolean | { ok: boolean; hash?: string; error?: string };

export interface CandidateHostCallbacks {
    readDisk: (filePath: string) => DiskValue | Promise<DiskValue>;
    writeDisk: (filePath: string, content: string) => void | Promise<void>;
    deleteDisk?: (filePath: string) => void | Promise<void>;
    validateDisk?: (files: readonly CandidateFile[]) => ValidationResult | Promise<ValidationResult>;
    afterRollback?: (files: readonly CandidateFile[], rollback: RollbackResult) => ValidationResult | Promise<ValidationResult>;
}

export interface CandidateFile {
    readonly path: string;
    readonly content: string;
    readonly contentHash: string;
    readonly bytes: number;
    readonly baseHash?: string;
}

export interface CandidateTransactionLimits {
    maxFiles?: number;
    maxBytes?: number;
}

export interface RollbackResult {
    attempted: boolean;
    succeeded: boolean;
    paths: string[];
    errors: Array<{ path: string; error: string }>;
}

export interface CommitResult {
    committed: boolean;
    state: CandidateTransactionState;
    transactionId?: string;
    files: string[];
    rollback: RollbackResult;
    error?: string;
}

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function sha256(value: DiskValue): string {
    return createHash('sha256')
        .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
        .digest('hex');
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class CandidateTransactionManager {
    private _state: CandidateTransactionState = 'discarded';
    private _id?: string;
    private readonly filesByPath = new Map<string, CandidateFile>();
    private readonly originalByPath = new Map<string, { content: string; existed: boolean }>();
    private validationOk = false;
    private validationHash?: string;
    private readonly maxFiles: number;
    private readonly maxBytes: number;
    private stagedBytes = 0;

    public constructor(limits: CandidateTransactionLimits = {}) {
        this.maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
        this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
        if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1
            || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
            throw new Error('Transaction limits must be positive safe integers');
        }
    }

    public get state(): CandidateTransactionState { return this._state; }
    public get id(): string | undefined { return this._id; }
    public get files(): readonly CandidateFile[] { return this.sortedFiles(); }
    public get bytes(): number { return this.stagedBytes; }

    public begin(): string {
        if (this._state === 'active' || this._state === 'validated') throw new Error('A transaction is already active');
        this.filesByPath.clear();
        this.originalByPath.clear();
        this.stagedBytes = 0;
        this.validationOk = false;
        this.validationHash = undefined;
        this._id = randomUUID();
        this._state = 'active';
        return this._id;
    }

    public stage(filePath: string, content: string, baseHash?: string): CandidateFile {
        this.requireState('active', 'stage');
        if (!filePath) throw new Error('File path is required');
        const bytes = Buffer.byteLength(content, 'utf8');
        const previous = this.filesByPath.get(filePath);
        const nextBytes = this.stagedBytes - (previous?.bytes ?? 0) + bytes;
        if (!previous && this.filesByPath.size >= this.maxFiles) throw new Error('Transaction file limit exceeded');
        if (nextBytes > this.maxBytes) throw new Error('Transaction byte limit exceeded');
        if (baseHash !== undefined && !/^[a-f0-9]{64}$/i.test(baseHash)) throw new Error('baseHash must be a SHA-256 hex digest');
        const stableBaseHash = previous?.baseHash ?? baseHash;
        const entry: CandidateFile = Object.freeze({ path: filePath, content, contentHash: sha256(content), bytes, baseHash: stableBaseHash });
        this.filesByPath.set(filePath, entry);
        this.stagedBytes = nextBytes;
        return entry;
    }

    public fingerprint(): string {
        return sha256(this.sortedFiles().map(file => file.path + '|' + file.contentHash).join('|'));
    }

    public validate(result: ValidationResult, hash?: string): void {
        this.requireState('active', 'validate');
        const ok = typeof result === 'boolean' ? result : result.ok;
        const resultHash = typeof result === 'boolean' ? hash : result.hash ?? hash;
        if (resultHash !== undefined && !/^[a-f0-9]{64}$/i.test(resultHash)) throw new Error('validation hash must be a SHA-256 hex digest');
        this.validationOk = ok;
        this.validationHash = resultHash;
        this._state = 'validated';
    }

    public discard(): void {
        if (this._state === 'committed' || this._state === 'discarded') return;
        this.filesByPath.clear();
        this.originalByPath.clear();
        this.stagedBytes = 0;
        this.validationOk = false;
        this.validationHash = undefined;
        this._state = 'discarded';
    }

    public async commit(host: CandidateHostCallbacks): Promise<CommitResult> {
        if (this._state !== 'validated') throw new Error('Transaction must be validated before commit');
        const files = this.sortedFiles();
        const paths = files.map(file => file.path);
        if (!this.validationOk) return this.fail('Validation failed before commit', paths);
        if (this.validationHash !== undefined && this.validationHash !== this.fingerprint()) {
            return this.fail('Validation hash does not match staged candidates', paths);
        }
        try {
            for (const file of files) {
                const currentValue = await host.readDisk(file.path);
                const current = typeof currentValue === 'string' ? currentValue : Buffer.from(currentValue).toString('utf8');
                if (file.baseHash !== undefined && sha256(current) !== file.baseHash) {
                    return this.fail('External disk drift detected: ' + file.path, paths);
                }
                this.originalByPath.set(file.path, { content: current, existed: current.length > 0 || file.baseHash !== undefined });
            }
            const written: CandidateFile[] = [];
            try {
                for (const file of files) {
                    // Mark before invoking the host: a write may partially mutate the
                    // file and then throw, and must still participate in rollback.
                    written.push(file);
                    await host.writeDisk(file.path, file.content);
                }
                if (host.validateDisk) {
                    const validation = await host.validateDisk(files);
                    const ok = typeof validation === 'boolean' ? validation : validation.ok;
                    if (!ok) {
                        let rollback = await this.rollback(host, written);
                        if (rollback.succeeded && host.afterRollback) {
                            const recovery = await host.afterRollback(files, rollback);
                            const recovered = typeof recovery === 'boolean' ? recovery : recovery.ok;
                            if (!recovered) rollback = { ...rollback, succeeded: false, errors: [...rollback.errors, { path: '<semantic>', error: typeof recovery === 'boolean' ? 'Semantic rollback did not become fresh.' : recovery.error ?? 'Semantic rollback did not become fresh.' }] };
                        }
                        this._state = rollback.succeeded ? 'discarded' : 'active';
                        return {
                            committed: false,
                            state: this._state,
                            transactionId: this._id,
                            files: paths,
                            rollback,
                            error: typeof validation === 'boolean'
                                ? 'Disk validation failed after commit'
                                : validation.error ?? 'Disk validation failed after commit',
                        };
                    }
                }
                this._state = 'committed';
                return {
                    committed: true,
                    state: this._state,
                    transactionId: this._id,
                    files: paths,
                    rollback: { attempted: false, succeeded: true, paths: [], errors: [] },
                };
            } catch (error) {
                let rollback = await this.rollback(host, written);
                if (rollback.succeeded && host.afterRollback) {
                    const recovery = await host.afterRollback(files, rollback);
                    const recovered = typeof recovery === 'boolean' ? recovery : recovery.ok;
                    if (!recovered) rollback = { ...rollback, succeeded: false, errors: [...rollback.errors, { path: '<semantic>', error: typeof recovery === 'boolean' ? 'Semantic rollback did not become fresh.' : recovery.error ?? 'Semantic rollback did not become fresh.' }] };
                }
                this._state = rollback.succeeded ? 'discarded' : 'active';
                return { committed: false, state: this._state, transactionId: this._id, files: paths, rollback, error: errorText(error) };
            }
        } catch (error) {
            return this.fail(errorText(error), paths);
        }
    }

    private async rollback(host: CandidateHostCallbacks, written: readonly CandidateFile[]): Promise<RollbackResult> {
        const errors: Array<{ path: string; error: string }> = [];
        for (const file of [...written].reverse()) {
            try {
                const original = this.originalByPath.get(file.path);
                if (original?.existed === false && host.deleteDisk) await host.deleteDisk(file.path);
                else await host.writeDisk(file.path, original?.content ?? '');
            } catch (error) {
                errors.push({ path: file.path, error: errorText(error) });
            }
        }
        return { attempted: written.length > 0, succeeded: errors.length === 0, paths: written.map(file => file.path), errors };
    }

    private fail(error: string, paths: string[]): CommitResult {
        this._state = 'discarded';
        return {
            committed: false,
            state: this._state,
            transactionId: this._id,
            files: paths,
            rollback: { attempted: false, succeeded: true, paths: [], errors: [] },
            error,
        };
    }

    private sortedFiles(): CandidateFile[] {
        return [...this.filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    private requireState(state: CandidateTransactionState, operation: string): void {
        if (this._state !== state) throw new Error('Cannot ' + operation + ' transaction in ' + this._state + ' state');
    }
}
