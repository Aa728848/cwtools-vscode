import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, atomicWriteText, readJsonWithBackup } from './durableStorage';

export interface AppendLogStore {
    append(filePath: string, text: string): Promise<void>;
    read(filePath: string): string | undefined;
    replace(filePath: string, text: string): Promise<void>;
}

export interface AtomicDocumentStore {
    read<T>(filePath: string, validate: (value: unknown) => value is T): T | undefined;
    write<T>(filePath: string, value: T): Promise<void>;
}

export interface BlobStore {
    read(filePath: string): Promise<Uint8Array | undefined>;
    write(filePath: string, value: Uint8Array): Promise<void>;
}

export class FileAppendLogStore implements AppendLogStore {
    async append(filePath: string, text: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
    }

    read(filePath: string): string | undefined {
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    }

    replace(filePath: string, text: string): Promise<void> {
        return atomicWriteText(filePath, text);
    }
}

export class FileAtomicDocumentStore implements AtomicDocumentStore {
    read<T>(filePath: string, validate: (value: unknown) => value is T): T | undefined {
        return readJsonWithBackup(filePath, validate)?.value;
    }

    write<T>(filePath: string, value: T): Promise<void> {
        return atomicWriteJson(filePath, value);
    }
}

export class FileBlobStore implements BlobStore {
    async read(filePath: string): Promise<Uint8Array | undefined> {
        try {
            return await fs.promises.readFile(filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async write(filePath: string, value: Uint8Array): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, value, { mode: 0o600 });
    }
}

export const fileAppendLogStore = new FileAppendLogStore();
export const fileAtomicDocumentStore = new FileAtomicDocumentStore();

