/**
 * Eddy CWTool Code — Agent Teams durable mailbox.
 *
 * One append-only log per team. Sends are addressed to a member name or the
 * reserved recipient 'lead'. Delivery semantics mirror the host turn model:
 * a running target is steered at its nearest step boundary, an idle target is
 * cold-resumed with its pending messages, and messages to an unavailable lead
 * are folded into the team settle summary. Messages are never removed after
 * delivery — the log doubles as the audit trail.
 */

import type { TeamMessage } from './types';
import {
    TEAM_LEAD,
    TEAM_MAX_MESSAGE_CHARS,
    TEAM_MAX_MESSAGES,
    TEAM_MAX_PENDING_PER_MEMBER,
} from './types';

export interface TeamMailboxSendResult {
    success: boolean;
    message?: TeamMessage;
    error?: string;
}

export class TeamMailbox {
    private readonly messages: TeamMessage[] = [];
    private sequence = 0;

    constructor(
        private readonly teamId: string,
        private readonly isKnownRecipient: (name: string) => boolean,
    ) {}

    get size(): number {
        return this.messages.length;
    }

    send(from: string, to: string, content: string): TeamMailboxSendResult {
        const target = to.trim();
        if (!this.isKnownRecipient(target)) {
            return { success: false, error: "Unknown team recipient '" + target + "'. Use team_members for the roster, or 'lead' for the coordinator." };
        }
        if (target === from) {
            return { success: false, error: 'Cannot send a team message to yourself.' };
        }
        const body = typeof content === 'string' ? content.trim() : '';
        if (!body) {
            return { success: false, error: 'team_send_message requires a non-empty message.' };
        }
        if (body.length > TEAM_MAX_MESSAGE_CHARS) {
            return { success: false, error: 'message exceeds ' + TEAM_MAX_MESSAGE_CHARS + ' characters.' };
        }
        if (this.messages.length >= TEAM_MAX_MESSAGES) {
            return { success: false, error: 'Team mailbox capacity reached (' + TEAM_MAX_MESSAGES + ' messages).' };
        }
        const pendingForTarget = this.messages.filter(entry => entry.to === target && entry.deliveredAt === undefined).length;
        if (pendingForTarget >= TEAM_MAX_PENDING_PER_MEMBER) {
            return { success: false, error: "Recipient '" + target + "' already has " + TEAM_MAX_PENDING_PER_MEMBER + " undelivered messages. Wait for the teammate to catch up." };
        }
        const message: TeamMessage = {
            id: 'msg-' + (++this.sequence),
            teamId: this.teamId,
            from,
            to: target,
            content: body,
            timestamp: Date.now(),
        };
        this.messages.push(message);
        return { success: true, message };
    }

    /** Undelivered messages for one recipient, oldest first. */
    pendingFor(recipient: string): TeamMessage[] {
        return this.messages
            .filter(entry => entry.to === recipient && entry.deliveredAt === undefined)
            .sort((left, right) => left.timestamp - right.timestamp);
    }

    countPendingFor(recipient: string): number {
        let count = 0;
        for (const entry of this.messages) {
            if (entry.to === recipient && entry.deliveredAt === undefined) count++;
        }
        return count;
    }

    /** True when at least one message is still undelivered. */
    hasPending(): boolean {
        return this.messages.some(entry => entry.deliveredAt === undefined);
    }

    markDelivered(ids: readonly string[], delivery: TeamMessage['delivery']): void {
        const idSet = new Set(ids);
        const now = Date.now();
        for (const entry of this.messages) {
            if (idSet.has(entry.id) && entry.deliveredAt === undefined) {
                entry.deliveredAt = now;
                entry.delivery = delivery;
            }
        }
    }

    snapshot(): TeamMessage[] {
        return this.messages.map(entry => ({ ...entry }));
    }

    /** Undelivered rows for the settle summary, capped and previewed. */
    undeliveredPreview(previewChars = 160): Array<{ from: string; to: string; preview: string }> {
        return this.messages
            .filter(entry => entry.deliveredAt === undefined)
            .slice(0, 16)
            .map(entry => ({
                from: entry.from,
                to: entry.to,
                preview: entry.content.length > previewChars ? entry.content.slice(0, previewChars) + '…' : entry.content,
            }));
    }
}

export { TEAM_LEAD };
