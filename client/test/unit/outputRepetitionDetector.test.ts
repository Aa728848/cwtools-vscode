import { expect } from 'chai';
import { OutputRepetitionDetector } from '../../extension/ai/runner/outputRepetitionDetector';

describe('OutputRepetitionDetector', () => {
    it('detects a paragraph-scale cycle after four repetitions', () => {
        const detector = new OutputRepetitionDetector();
        const cycle = 'Search has_starbase in vanilla events, inspect the trigger scope, compare df_random_event.44, record the system-scope finding, and update the blueprint with one verified implementation step before continuing. ';
        let match;
        for (const chunk of (cycle.repeat(4)).match(/.{1,37}/g) ?? []) {
            match = detector.append(chunk) ?? match;
        }
        expect(match).to.not.equal(undefined);
        expect(match?.repetitions).to.equal(4);
        expect(match?.cycleChars).to.be.greaterThan(160);
    });

    it('does not flag ordinary prose with repeated identifiers', () => {
        const detector = new OutputRepetitionDetector();
        const text = [
            'Inspect has_starbase in the scripted trigger definitions.',
            'Then compare has_starbase with the vanilla event usage.',
            'Record the scope rules and update the design blueprint.',
            'Finally verify the plan against diagnostics and the project profile.',
        ].join(' ');
        expect(detector.append(text.repeat(2))).to.equal(undefined);
    });

    it('normalizes streaming whitespace before matching', () => {
        const detector = new OutputRepetitionDetector();
        const cycle = 'First inspect the relevant event and trigger. Then verify the scope against the project rules, make one concrete tool call, record its result, and update the plan instead of describing the same intended action again. ';
        let match;
        for (let i = 0; i < 4; i++) {
            match = detector.append(i % 2 === 0 ? `${cycle}\n` : `  ${cycle}  `) ?? match;
        }
        expect(match).to.not.equal(undefined);
    });
});
