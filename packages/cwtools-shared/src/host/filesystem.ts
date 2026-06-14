export interface ReadTextFileResult {
  content: string;
  hasBom: boolean;
  exists: boolean;
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface FilesystemHost {
  readTextFile(path: string): Promise<ReadTextFileResult>;
  writeTextFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirectoryEntry[]>;
  glob(pattern: string, options?: { limit?: number }): Promise<string[]>;
}
