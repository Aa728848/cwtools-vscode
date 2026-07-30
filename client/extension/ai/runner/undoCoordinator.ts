export interface UndoCut {
    topicId: string;
    threadId: string;
    turnId: string;
    sequence: number;
    compactionBoundarySequence?: number;
}

export interface UndoCheck {
    allowed: boolean;
    reason?: string;
}

export interface ConversationUndoParticipant {
    id: string;
    precheck(cut: UndoCut): UndoCheck | Promise<UndoCheck>;
    reconcileAfterUndo(cut: UndoCut): Promise<void>;
}

export interface UndoResult {
    applied: boolean;
    needsAttention: string[];
    reason?: string;
}

export class ConversationUndoCoordinator {
    private readonly participants = new Map<string, ConversationUndoParticipant>();
    private active = false;

    register(participant: ConversationUndoParticipant): () => void {
        if (this.participants.has(participant.id)) throw new Error(`Undo participant "${participant.id}" is already registered.`);
        this.participants.set(participant.id, participant);
        return () => this.participants.delete(participant.id);
    }

    async undo(cut: UndoCut, commitContextCut: () => Promise<void>): Promise<UndoResult> {
        if (this.active) return { applied: false, needsAttention: [], reason: 'Undo is already active.' };
        if (cut.compactionBoundarySequence !== undefined && cut.sequence < cut.compactionBoundarySequence) {
            return { applied: false, needsAttention: [], reason: 'Undo cannot cross a compaction boundary.' };
        }
        this.active = true;
        try {
            const ordered = [...this.participants.values()].sort((left, right) => left.id.localeCompare(right.id));
            for (const participant of ordered) {
                const check = await participant.precheck(cut);
                if (!check.allowed) return { applied: false, needsAttention: [], reason: check.reason ?? `${participant.id} rejected undo.` };
            }
            await commitContextCut();
            const needsAttention: string[] = [];
            for (const participant of ordered) {
                try {
                    await participant.reconcileAfterUndo(cut);
                } catch {
                    needsAttention.push(participant.id);
                }
            }
            return { applied: true, needsAttention };
        } finally {
            this.active = false;
        }
    }

    get isActive(): boolean {
        return this.active;
    }
}

export const conversationUndoCoordinator = new ConversationUndoCoordinator();
