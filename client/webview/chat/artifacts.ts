import { getDiffArtifactFilesForWebview, type DiffArtifactFileView } from '../artifactPanelModel';
import type {
    ArtifactKind,
    ArtifactStatus,
    ArtifactFilter,
    ArtifactRecord,
} from '../../shared/agentArtifact';

export type {
    ArtifactKind,
    ArtifactStatus,
    ArtifactFilter,
    ArtifactRecord,
};

export type DiffArtifactFileRecord = DiffArtifactFileView;

export function filterArtifacts(artifacts: ArtifactRecord[], filter: ArtifactFilter): ArtifactRecord[] {
    if (filter === 'all') return artifacts;
    if (filter === 'plan') return artifacts.filter(artifact => artifact.kind === 'plan' || artifact.kind === 'blueprint');
    if (filter === 'diff') return artifacts.filter(artifact => artifact.kind === 'diff');
    return artifacts.filter(artifact => artifact.kind === 'validation' || artifact.kind === 'diagnostics');
}

export function sortArtifactsByNewest(artifacts: ArtifactRecord[]): ArtifactRecord[] {
    return artifacts.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function artifactPreviewPayload(artifact: ArtifactRecord): unknown {
    return artifact.data ?? {
        title: artifact.title,
        summary: artifact.summary,
        relPath: artifact.relPath,
        status: artifact.status || 'done',
    };
}

export function fileBaseName(file: string): string {
    return file.split(/[\\/]/).pop() || file;
}

export function formatArtifactFileStats(file: DiffArtifactFileRecord): string {
    const parts: string[] = [];
    if (file.status) parts.push(file.status);
    const delta = formatArtifactFileDelta(file);
    if (delta) parts.push(delta);
    return parts.join(' | ');
}

export function formatArtifactFileDelta(file: DiffArtifactFileRecord): string {
    if (file.additions !== undefined || file.deletions !== undefined) {
        return `+${file.additions ?? 0} -${file.deletions ?? 0}`;
    }
    return file.diffPreview || '';
}

export function formatArtifactFileStatusLabel(status?: string): string {
    const normalized = (status || '').trim().toLowerCase();
    switch (normalized) {
        case 'created':
        case 'new':
        case 'added':
            return 'NEW';
        case 'modified':
        case 'changed':
        case 'mod':
            return 'MOD';
        case 'deleted':
        case 'removed':
        case 'delete':
            return 'DEL';
        default:
            return normalized ? normalized.slice(0, 3).toUpperCase() : 'CHG';
    }
}

export function artifactFileStatusTone(status?: string): 'created' | 'modified' | 'deleted' | 'unknown' {
    const normalized = (status || '').trim().toLowerCase();
    if (normalized === 'created' || normalized === 'new' || normalized === 'added') return 'created';
    if (normalized === 'deleted' || normalized === 'removed' || normalized === 'delete') return 'deleted';
    if (normalized === 'modified' || normalized === 'changed' || normalized === 'mod') return 'modified';
    return 'unknown';
}

export const getDiffArtifactFiles = getDiffArtifactFilesForWebview;

export function restoreArtifactsFromMessages(messages: any[], now = Date.now()): ArtifactRecord[] {
    const restored: ArtifactRecord[] = [];
    const pushUnique = (artifact: ArtifactRecord) => {
        if (!restored.some(a => a.id === artifact.id)) restored.push(artifact);
    };

    for (const message of messages) {
        if (!message?.steps) continue;
        for (const step of message.steps) {
            const stamp = step.timestamp || message.timestamp || now;
            if (step.type === 'plan_card') {
                pushUnique({
                    id: `restored:plan:${step.content}`,
                    kind: 'plan',
                    title: 'Implementation Plan',
                    summary: 'Restored from chat history.',
                    filePath: step.content,
                    relPath: step.content,
                    status: 'pending',
                    createdAt: stamp,
                });
            } else if (step.type === 'blueprint_card') {
                pushUnique({
                    id: `restored:blueprint:${step.content}`,
                    kind: 'blueprint',
                    title: 'Design Blueprint',
                    summary: 'Restored from chat history.',
                    filePath: step.content,
                    relPath: step.content,
                    status: 'pending',
                    createdAt: stamp,
                });
            } else if (step.type === 'walkthrough_card') {
                pushUnique({
                    id: `restored:walkthrough:${step.content}`,
                    kind: 'walkthrough',
                    title: 'Walkthrough Report',
                    summary: 'Full task walkthrough restored from chat history.',
                    filePath: step.content,
                    relPath: step.content,
                    status: 'done',
                    createdAt: stamp,
                });
            } else if (step.type === 'validation') {
                const content = String(step.content || '');
                pushUnique({
                    id: `restored:validation:${stamp}`,
                    kind: 'validation',
                    title: 'Validation Result',
                    summary: content || 'Validation step restored from history.',
                    status: /error|failed|failure/i.test(content) ? 'failed' : 'done',
                    createdAt: stamp,
                    data: step.toolResult,
                });
            } else if (step.toolName === 'get_diagnostics') {
                pushUnique({
                    id: `restored:diagnostics:${stamp}`,
                    kind: 'diagnostics',
                    title: 'Diagnostics Report',
                    summary: 'Restored get_diagnostics result.',
                    status: 'done',
                    createdAt: stamp,
                    data: step.toolResult,
                });
            }
        }
    }

    return sortArtifactsByNewest(restored);
}
