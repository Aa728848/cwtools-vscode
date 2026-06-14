export interface WorkspaceIndexQuery {
  name?: string;
  kind?: string;
  category?: string;
  source?: 'script' | 'asset' | 'gui';
  origin?: 'workspace' | 'vanilla' | 'both';
  directory?: string;
  prefix?: boolean;
  exact?: boolean;
  includeReferences?: boolean;
  limit?: number;
}

export interface WorkspaceIndexEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  source: 'script' | 'asset' | 'gui';
  origin: 'workspace' | 'vanilla';
  category?: string;
  container?: string;
  updatedAt?: number;
  fileVersion?: number;
}

export interface LocalisationIndexQuery {
  key?: string;
  language?: string;
  prefix?: boolean;
  contains?: boolean;
  caseSensitive?: boolean;
  limit?: number;
}

export interface LocalisationIndexEntry {
  key: string;
  value: string;
  file: string;
  line: number;
  language: string;
}

export interface IndexQueryResult<TEntry> {
  status: 'ready' | 'indexing' | 'idle' | 'unavailable' | 'error';
  totalCount: number;
  entries: TEntry[];
  indexedSymbolNames?: number;
  indexUpdatedAt?: number;
  error?: string;
  _hint?: string;
}

export interface IndexHost {
  ensureReady?(): Promise<void>;
  invalidate?(filePath: string): Promise<void>;
  queryWorkspace(query: WorkspaceIndexQuery): Promise<IndexQueryResult<WorkspaceIndexEntry>>;
  queryLocalisation(query: LocalisationIndexQuery): Promise<IndexQueryResult<LocalisationIndexEntry>>;
}
