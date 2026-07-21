import * as crypto from 'crypto';
import type { ChatMessage } from '../types';

export type ModelRequestMessageArchive =
    | { format: 'full'; messages: ChatMessage[] }
    | {
        format: 'delta';
        baseRequestRef: string;
        commonPrefixLength: number;
        appendedMessages: ChatMessage[];
      };

export interface ModelRequestArchiveState {
    requestRef?: string;
    messageHashes: string[];
}

function hashMessage(message: ChatMessage): string {
    return crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 20);
}

/**
 * Archive append-heavy transcripts as a prefix length + suffix. If compaction
 * rewrites most of the transcript, emit a fresh full base to keep chains short.
 */
export function buildModelRequestMessageArchive(
    messages: readonly ChatMessage[],
    previous: ModelRequestArchiveState | undefined,
): { archive: ModelRequestMessageArchive; messageHashes: string[] } {
    const messageHashes = messages.map(hashMessage);
    if (!previous?.requestRef || previous.messageHashes.length === 0) {
        return { archive: { format: 'full', messages: [...messages] }, messageHashes };
    }

    const maxPrefix = Math.min(previous.messageHashes.length, messageHashes.length);
    let commonPrefixLength = 0;
    while (
        commonPrefixLength < maxPrefix
        && previous.messageHashes[commonPrefixLength] === messageHashes[commonPrefixLength]
    ) {
        commonPrefixLength++;
    }

    // A very small shared prefix after compaction is cheaper and safer as a
    // new base than a long chain whose delta replaces nearly everything.
    const minimumUsefulPrefix = Math.max(2, Math.ceil(messages.length / 3));
    if (commonPrefixLength < minimumUsefulPrefix) {
        return { archive: { format: 'full', messages: [...messages] }, messageHashes };
    }

    return {
        archive: {
            format: 'delta',
            baseRequestRef: previous.requestRef,
            commonPrefixLength,
            appendedMessages: messages.slice(commonPrefixLength),
        },
        messageHashes,
    };
}

/** Pure reconstruction helper used by inspectors/tests after resolving baseRequestRef. */
export function applyModelRequestMessageArchive(
    archive: ModelRequestMessageArchive,
    baseMessages: readonly ChatMessage[] = [],
): ChatMessage[] {
    if (archive.format === 'full') return [...archive.messages];
    if (archive.commonPrefixLength > baseMessages.length) {
        throw new Error('Model request delta references a prefix longer than its base transcript.');
    }
    return [
        ...baseMessages.slice(0, archive.commonPrefixLength),
        ...archive.appendedMessages,
    ];
}
