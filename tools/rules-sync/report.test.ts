import { expect } from 'chai';
import {
    descriptionChangeWindow,
    diffKind,
    type DocRule,
    type RuleKind,
} from './report';

const BEFORE = "Checks if a planet's happiness is past a given threshold. Can be used in a scoped system, then it returns the sum of every planets' happiness past the given threshold.";
const AFTER = BEFORE + ' In system scope an optional limit (colony scope) filters which colonies contribute.';

function docRule(name: string, kind: RuleKind, description: string): DocRule {
    return { name, kind, scopes: [], targetScopes: [], description, source: 'test.log', sourceLine: 1 };
}

describe('Stellaris rules sync report', () => {
    it('keeps short description changes intact', () => {
        const change = descriptionChangeWindow('old text', 'new text');
        expect(change).to.deep.equal({ before: 'old text', after: 'new text' });
    });

    it('windows long descriptions around the first difference instead of an identical prefix', () => {
        const change = descriptionChangeWindow(BEFORE, AFTER);
        expect(change.before).to.not.equal(change.after);
        expect(change.before.length).to.be.at.most(162);
        expect(change.after.length).to.be.at.most(162);
        expect(change.after).to.contain('optional limit');
        expect(change.before).to.not.contain('optional limit');
    });

    it('reports a visible before/after for a description changed past the 160 char prefix', () => {
        const key = 'trigger:planet_happiness_above_threshold';
        const game = new Map([[key, docRule('planet_happiness_above_threshold', 'trigger', AFTER)]]);
        const baseline = new Map([[key, docRule('planet_happiness_above_threshold', 'trigger', BEFORE)]]);
        const diff = diffKind('trigger', game, baseline, new Map());

        expect(diff.changed).to.have.length(1);
        const change = diff.changed[0]!.changes!.find(entry => entry.field === 'description');
        expect(change).to.exist;
        expect(change!.before).to.not.equal(change!.after);
        expect(change!.after).to.contain('optional limit');
    });

    it('does not report a description change when only surrounding whitespace differs', () => {
        const key = 'trigger:some_trigger';
        const game = new Map([[key, docRule('some_trigger', 'trigger', `  ${BEFORE}  `)]]);
        const baseline = new Map([[key, docRule('some_trigger', 'trigger', BEFORE)]]);
        const diff = diffKind('trigger', game, baseline, new Map());

        expect(diff.changed).to.have.length(0);
    });
});
