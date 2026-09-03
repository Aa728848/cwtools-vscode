/**
 * CWTools — Agent Artifact Protocol
 *
 * Canonical artifact models shared across Extension Host, Webviews, and Agent Manager.
 */

export type ArtifactKind =
    | 'plan'
    | 'blueprint'
    | 'walkthrough'
    | 'diff'
    | 'diagnostics'
    | 'validation'
    | 'media'
    | 'blackboard';

export type AgentArtifactKind = ArtifactKind;

export type ArtifactStatus = 'pending' | 'running' | 'done' | 'failed';
export type ArtifactFilter = 'all' | 'plan' | 'validation' | 'diff';

export interface ArtifactRecord {
    id: string;
    kind: ArtifactKind;
    title: string;
    summary?: string;
    filePath?: string;
    relPath?: string;
    action?: 'openFile' | 'openDiff' | 'preview';
    status?: ArtifactStatus;
    createdAt: number;
    updatedAt?: number;
    data?: unknown;
}

export type AgentArtifact = ArtifactRecord;

export type DiffFileStatus = 'created' | 'modified' | 'deleted';

export interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

export interface DiffSummaryFile {
    file: string;
    status: DiffFileStatus;
    diffPreview: string;
    additions?: number;
    deletions?: number;
    diffLines?: DiffLine[];
}

export interface DiffArtifactFile extends DiffSummaryFile {
    previousContent?: string | null;
    currentContent?: string | null;
    tooLarge?: boolean;
    currentTooLarge?: boolean;
}

export interface DiffArtifactData {
    files: DiffArtifactFile[];
    additions: number;
    deletions: number;
}
