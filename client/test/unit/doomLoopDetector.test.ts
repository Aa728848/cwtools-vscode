import { expect } from 'chai';
import { DoomLoopState, normalizeToolResultHash } from '../../extension/ai/runner/doomLoopDetector';

describe('Doom-loop detection', () => {
    it('distinguishes same-length read results with different content', () => {
        const first = normalizeToolResultHash('read_file', { file: 'a.txt', content: 'alpha' });
        const second = normalizeToolResultHash('read_file', { file: 'a.txt', content: 'bravo' });

        expect(first).to.not.equal(second);
    });

    it('clears only signatures for mutated files across slash styles', () => {
        const state = new DoomLoopState();
        state.pairFrequency.set('{"targetPaths":["C:/workspace/a.txt"]}', 4);
        state.pairFrequency.set('{"targetPaths":["C:/workspace/b.txt"]}', 4);

        state.clearForFiles(['C:\\workspace\\a.txt']);

        expect([...state.pairFrequency.keys()]).to.deep.equal([
            '{"targetPaths":["C:/workspace/b.txt"]}',
        ]);
    });
});
