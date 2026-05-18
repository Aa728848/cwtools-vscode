export interface DiffArtifactFileView {
    file: string;
    status?: string;
    diffPreview?: string;
    additions?: number;
    deletions?: number;
    diffLines?: DiffArtifactLineView[];
}

export interface DiffArtifactLineView {
    type: 'add' | 'remove' | 'context';
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

export interface ArtifactLike {
    data?: unknown;
}

export function getDiffArtifactFilesForWebview(artifact: ArtifactLike): DiffArtifactFileView[] {
    const data = artifact.data as { files?: unknown } | unknown[] | undefined;
    const rawFiles = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as { files?: unknown }).files)
            ? (data as { files: unknown[] }).files
            : [];

    return rawFiles
        .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object' && typeof (file as Record<string, unknown>).file === 'string')
        .map(file => ({
            file: String(file.file),
            status: typeof file.status === 'string' ? file.status : undefined,
            diffPreview: typeof file.diffPreview === 'string' ? file.diffPreview : undefined,
            additions: typeof file.additions === 'number' ? file.additions : undefined,
            deletions: typeof file.deletions === 'number' ? file.deletions : undefined,
            diffLines: normalizeDiffLines(file.diffLines),
        }));
}

function normalizeDiffLines(value: unknown): DiffArtifactLineView[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const lines = value
        .filter((line): line is Record<string, unknown> => !!line && typeof line === 'object')
        .filter(line => line.type === 'add' || line.type === 'remove' || line.type === 'context')
        .filter(line => typeof line.content === 'string')
        .map(line => ({
            type: line.type as DiffArtifactLineView['type'],
            content: String(line.content),
            ...(typeof line.oldLineNo === 'number' ? { oldLineNo: line.oldLineNo } : {}),
            ...(typeof line.newLineNo === 'number' ? { newLineNo: line.newLineNo } : {}),
        }));
    return lines.length > 0 ? lines : undefined;
}
