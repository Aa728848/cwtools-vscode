import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DurableReadResult<T> {
    value: T;
    sourcePath: string;
    recoveredFromBackup: boolean;
}

export function sha256Text(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const atomicWriteQueues = new Map<string, Promise<void>>();

/**
 * Replace a UTF-8 file through a same-directory temporary file. The previous
 * complete generation is retained as `<file>.bak`, allowing readers to recover
 * when the Extension Host or machine stops between filesystem operations.
 */
async function writeAtomicGeneration(filePath: string, contents: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tempPath = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    const backupPath = `${filePath}.bak`;
    let movedExisting = false;

    const handle = await fs.promises.open(tempPath, 'w', 0o600);
    try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }

    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.rm(backupPath, { force: true });
            await fs.promises.rename(filePath, backupPath);
            movedExisting = true;
        }
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        if (movedExisting && !fs.existsSync(filePath) && fs.existsSync(backupPath)) {
            await fs.promises.rename(backupPath, filePath).catch(() => {});
        }
        throw error;
    } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
}

export function atomicWriteText(filePath: string, contents: string): Promise<void> {
    const key = path.resolve(filePath);
    const previous = atomicWriteQueues.get(key) ?? Promise.resolve();
    const current = previous
        .catch(() => {})
        .then(() => writeAtomicGeneration(key, contents));
    atomicWriteQueues.set(key, current);
    return current.finally(() => {
        if (atomicWriteQueues.get(key) === current) atomicWriteQueues.delete(key);
    });
}

export async function atomicWriteJson(filePath: string, value: unknown, pretty = true): Promise<void> {
    const serialized = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    await atomicWriteText(filePath, serialized);
}

export function readTextWithBackup(filePath: string): DurableReadResult<string> | undefined {
    for (const candidate of [filePath, `${filePath}.bak`]) {
        try {
            const value = fs.readFileSync(candidate, 'utf8');
            return {
                value,
                sourcePath: candidate,
                recoveredFromBackup: candidate !== filePath,
            };
        } catch {
            // Try the previous complete generation.
        }
    }
    return undefined;
}

export function readJsonWithBackup<T>(
    filePath: string,
    validate?: (value: unknown) => value is T,
): DurableReadResult<T> | undefined {
    for (const candidate of [filePath, `${filePath}.bak`]) {
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
            if (validate && !validate(parsed)) continue;
            return {
                value: parsed as T,
                sourcePath: candidate,
                recoveredFromBackup: candidate !== filePath,
            };
        } catch {
            // Try the previous complete generation.
        }
    }
    return undefined;
}
