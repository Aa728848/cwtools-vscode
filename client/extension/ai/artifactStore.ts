import type { AgentArtifact, AgentArtifactKind } from './types';

type UpsertArtifactInput = Omit<AgentArtifact, 'createdAt'> & { createdAt?: number };

/**
 * Session-scoped artifact state holder with stable list ordering.
 */
export class ArtifactStore {
    private readonly artifacts = new Map<string, AgentArtifact>();

    constructor(
        private readonly getTopicId: () => string = () => 'session'
    ) { }

    get size(): number {
        return this.artifacts.size;
    }

    get(id: string): AgentArtifact | undefined {
        return this.artifacts.get(id);
    }

    clear(): AgentArtifact[] {
        this.artifacts.clear();
        return [];
    }

    upsert(artifact: UpsertArtifactInput): AgentArtifact[] {
        const now = Date.now();
        const previous = this.artifacts.get(artifact.id);
        this.artifacts.set(artifact.id, {
            ...previous,
            ...artifact,
            createdAt: previous?.createdAt ?? artifact.createdAt ?? now,
            updatedAt: now,
        });
        return this.list();
    }

    list(): AgentArtifact[] {
        return [...this.artifacts.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    buildId(kind: AgentArtifactKind, key: string): string {
        const topicId = this.getTopicId() || 'session';
        const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return `${topicId}:${kind}:${safeKey}`;
    }
}
