import { expect } from 'chai';
import { isCodexChatModelSlug, parseCodexCatalog } from '../../extension/ai/codex/modelCatalog';

describe('Codex catalog is a chat-model listing', () => {
    // Some plans' subscription listing carries ONLY the code-review slug. Offering
    // it as a chat model gives the user one option that can never answer.
    it('excludes review-only slugs', () => {
        expect(isCodexChatModelSlug('codex-auto-review')).to.equal(false);
        expect(isCodexChatModelSlug('gpt-6.1-sol')).to.equal(true);
    });

    it('drops the review slug from a parsed listing', () => {
        const entries = parseCodexCatalog({ models: [
            { slug: 'codex-auto-review', display_name: 'Auto review' },
            { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol' },
        ] });
        expect(entries.map(entry => entry.id)).to.deep.equal(['gpt-6.1-sol']);
    });

    // A listing that contains nothing usable reads as empty, which is the signal
    // the caller uses to fall back to the shipped table.
    it('reads a review-only listing as empty', () => {
        expect(parseCodexCatalog({ models: [{ slug: 'codex-auto-review' }] })).to.deep.equal([]);
    });
});
