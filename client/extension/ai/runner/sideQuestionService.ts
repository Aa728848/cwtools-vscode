import * as crypto from 'crypto';
import type { ChatMessage } from '../types';

export interface SideQuestion {
    id: string;
    parentRunId: string;
    threadId: string;
    question: string;
    contextRevision: number;
    status: 'running' | 'complete' | 'cancelled' | 'stale';
    answer?: string;
    createdAt: number;
    updatedAt: number;
}

export class SideQuestionService {
    private readonly questions = new Map<string, SideQuestion>();
    private readonly activeByParent = new Map<string, string>();
    private readonly conversationByParent = new Map<string, ChatMessage[]>();

    start(parentRunId: string, threadId: string, question: string, contextRevision: number): SideQuestion {
        const activeId = this.activeByParent.get(parentRunId);
        if (activeId && this.questions.get(activeId)?.status === 'running') {
            throw new Error('A side question is already running for this Agent.');
        }
        const now = Date.now();
        const item: SideQuestion = {
            id: crypto.randomUUID(),
            parentRunId,
            threadId,
            question: question.trim(),
            contextRevision,
            status: 'running',
            createdAt: now,
            updatedAt: now,
        };
        this.questions.set(item.id, item);
        this.activeByParent.set(parentRunId, item.id);
        return { ...item };
    }

    complete(id: string, answer: string, _currentContextRevision: number): SideQuestion {
        const item = this.require(id);
        // The answer is intentionally bound to the captured revision. A newer
        // parent revision does not invalidate it or merge it into the main run.
        item.status = 'complete';
        item.answer = answer;
        item.updatedAt = Date.now();
        this.activeByParent.delete(item.parentRunId);
        if (item.status === 'complete') {
            const conversation = this.conversationByParent.get(item.parentRunId) ?? [];
            conversation.push(
                { role: 'user', content: item.question },
                { role: 'assistant', content: answer },
            );
            this.conversationByParent.set(item.parentRunId, conversation.slice(-20));
        }
        return { ...item };
    }

    anchor(id: string, contextRevision: number): SideQuestion {
        const item = this.require(id);
        item.contextRevision = contextRevision;
        item.updatedAt = Date.now();
        return { ...item };
    }

    cancel(id: string): SideQuestion {
        const item = this.require(id);
        item.status = 'cancelled';
        item.updatedAt = Date.now();
        this.activeByParent.delete(item.parentRunId);
        return { ...item };
    }

    getConversation(parentRunId: string): ChatMessage[] {
        return (this.conversationByParent.get(parentRunId) ?? []).map(message => ({ ...message }));
    }

    deleteParent(parentRunId: string): void {
        const activeId = this.activeByParent.get(parentRunId);
        if (activeId) this.questions.delete(activeId);
        this.activeByParent.delete(parentRunId);
        this.conversationByParent.delete(parentRunId);
    }

    asStepMessage(id: string): ChatMessage | undefined {
        const item = this.questions.get(id);
        if (!item || item.status !== 'complete' || !item.answer) return undefined;
        return {
            role: 'system',
            content: `[SIDE QUESTION RESULT]\nQuestion: ${item.question}\nAnswer: ${item.answer}`,
        };
    }

    private require(id: string): SideQuestion {
        const item = this.questions.get(id);
        if (!item) throw new Error(`Unknown side question ${id}.`);
        if (item.status !== 'running') throw new Error(`Side question ${id} is already ${item.status}.`);
        return item;
    }
}

export const sideQuestionService = new SideQuestionService();
