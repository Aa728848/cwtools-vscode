import { expect } from 'chai';
import {
    applyModelRequestMessageArchive,
    buildModelRequestMessageArchive,
    type ModelRequestArchiveState,
} from '../../extension/ai/runner/requestArtifacts';
import type { ChatMessage } from '../../extension/ai/types';

describe('incremental model request artifacts', () => {
    const initial: ChatMessage[] = [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'task' },
    ];

    it('stores the first request in full and later append-only turns as deltas', () => {
        const first = buildModelRequestMessageArchive(initial, undefined);
        expect(first.archive.format).to.equal('full');

        const state: ModelRequestArchiveState = {
            requestRef: 'model_requests/model_1.json',
            messageHashes: first.messageHashes,
        };
        const current: ChatMessage[] = [...initial, { role: 'assistant', content: 'done' }];
        const second = buildModelRequestMessageArchive(current, state);
        expect(second.archive).to.deep.include({
            format: 'delta',
            baseRequestRef: 'model_requests/model_1.json',
            commonPrefixLength: 2,
        });
        expect(applyModelRequestMessageArchive(second.archive, initial)).to.deep.equal(current);
    });

    it('starts a new full base when compaction rewrites most of the transcript', () => {
        const prior = buildModelRequestMessageArchive([
            { role: 'system', content: 'policy' },
            { role: 'user', content: 'old task' },
            { role: 'assistant', content: 'old result' },
            { role: 'user', content: 'more' },
        ], undefined);
        const next = buildModelRequestMessageArchive([
            { role: 'system', content: 'policy' },
            { role: 'user', content: 'compacted summary' },
            { role: 'assistant', content: 'new tail' },
            { role: 'user', content: 'continue' },
        ], { requestRef: 'old.json', messageHashes: prior.messageHashes });
        expect(next.archive.format).to.equal('full');
    });

    it('rejects a corrupt delta with an impossible prefix', () => {
        expect(() => applyModelRequestMessageArchive({
            format: 'delta',
            baseRequestRef: 'missing.json',
            commonPrefixLength: 2,
            appendedMessages: [],
        }, initial.slice(0, 1))).to.throw('prefix longer');
    });
});
