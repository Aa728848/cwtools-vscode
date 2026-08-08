import { expect } from 'chai';
import { parseClarificationOptions } from '../../extension/ai/orchestrator/orchestrator';

describe('parseClarificationOptions', () => {
    it('extracts 2-4 options from an OPTIONS: block', () => {
        const options = parseClarificationOptions(
            'Need to pick an approach\nOPTIONS:\n- Refactor the event chain\n- Split into two events\n- Keep as-is',
        );
        expect(options).to.deep.equal(['Refactor the event chain', 'Split into two events', 'Keep as-is']);
    });

    it('accepts `* ` bullets and ignores preceding prose', () => {
        const options = parseClarificationOptions(
            'The dependencies are unclear.\nOPTIONS:\n* Use vanilla scope\n* Add a custom trigger',
        );
        expect(options).to.deep.equal(['Use vanilla scope', 'Add a custom trigger']);
    });

    it('returns undefined without an OPTIONS: block', () => {
        expect(parseClarificationOptions('BLOCKED_FOR_ORCHESTRATOR: missing input')).to.equal(undefined);
    });

    it('returns undefined with fewer than two options', () => {
        expect(parseClarificationOptions('OPTIONS:\n- only one')).to.equal(undefined);
    });

    it('caps at four options, deduplicates, and stops the block at non-bullet lines', () => {
        const options = parseClarificationOptions(
            'OPTIONS:\n- A\n- B\n- A\n- C\n- D\n- E\nsome trailing text\n- F',
        );
        expect(options).to.deep.equal(['A', 'B', 'C', 'D']);
    });

    it('trims long options to 200 characters', () => {
        const long = 'x'.repeat(300);
        const options = parseClarificationOptions(`OPTIONS:\n- ${long}\n- short`);
        expect(options![0]).to.have.length(200);
        expect(options![1]).to.equal('short');
    });
});
