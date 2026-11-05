import { expect } from 'chai';
import {
    collectDefinitionFields,
    descriptionChangeWindow,
    diffKind,
    extractBlockParameters,
    type DocRule,
    type FolderFieldStats,
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

    it('does not count inline_script parameters after a multi-line quoted TRIGGER as definition fields', () => {
        const script = [
            'building_test = {',
            '\tinline_script = {',
            '\t\tscript = output/bonus_pop_growth',
            '\t\tTRIGGER = "owner? = {',
            '\t\t\thas_cloning_tradition = no # not a comment',
            '\t\t}"',
            '\t\tAMOUNT = 1.5',
            '\t}',
            '\tcategory = test',
            '}',
            'building_next = {',
            '\tupkeep = 1',
            '}',
        ].join('\n');
        const stats: FolderFieldStats = { folder: 'buildings', definitionCount: 0, fields: new Map(), defNames: new Set() };
        collectDefinitionFields(script, 'buildings/test.txt', stats);

        expect(stats.definitionCount).to.equal(2);
        expect([...stats.fields.keys()].sort()).to.deep.equal(['category', 'inline_script', 'upkeep']);
    });
});

describe('Stellaris rules sync parameter drift', () => {
    const block = [
        'transfer_pop_amount = {',
        '\tsource = <source pop group>',
        '\ttarget = <target pop group>',
        '\tamount = <amount> OR percentage = <percentage>',
        '\trandom = <number> (optional) If set, the amount will be randomized.',
        '\tkeep_automodding = yes (optional)',
        '}',
        'Supported Scopes: all',
    ];

    it('collects block keys at the outer level and ignores grammar words', () => {
        expect(extractBlockParameters(block, 0, block.length)).to.deep.equal([
            'amount',
            'keep_automodding',
            'percentage',
            'random',
            'source',
            'target',
        ]);
    });

    it('unions sibling groups chained on one documented signature', () => {
        const lines = [
            'is_point_of_interest - Checks if the planet has a point of interest for a country.',
            'is_point_of_interest = { owner = <target> } or { id = <id> event_chain = <event_chain> owner = <target> }',
            'Supported Scopes: planet country ship',
        ];
        expect(extractBlockParameters(lines, 1, 2)).to.deep.equal(['event_chain', 'id', 'owner']);
    });

    it('ignores nested blocks and trailing scalar signatures', () => {
        const lines = ['ethos = { ethic = <key> } / random (optional)', 'set_scoped_species_flag = flag'];
        expect(extractBlockParameters(lines, 0, lines.length)).to.deep.equal(['ethic']);
    });

    it('reports a parameter-only change as parameter drift instead of a name change', () => {
        const key = 'effect:transfer_pop_amount';
        const before: DocRule = { ...docRule('transfer_pop_amount', 'effect', 'Move pops'), parameters: ['growth_category', 'source'] };
        const after: DocRule = { ...docRule('transfer_pop_amount', 'effect', 'Move pops'), parameters: ['growth_category', 'keep_automodding', 'source'] };
        const diff = diffKind('effect', new Map([[key, after]]), new Map([[key, before]]), new Map());

        expect(diff.changed).to.have.length(0);
        expect(diff.parameterDrift).to.have.length(1);
        const change = diff.parameterDrift![0]!.changes!.find(entry => entry.field === 'parameters');
        expect(change).to.exist;
        expect(change!.after).to.contain('keep_automodding');
    });

    it('stays silent when a curated baseline documents the same parameter set', () => {
        const key = 'effect:transfer_pop_amount';
        const same: DocRule = { ...docRule('transfer_pop_amount', 'effect', 'Move pops'), parameters: ['source', 'target'] };
        const diff = diffKind('effect', new Map([[key, same]]), new Map([[key, { ...same }]]), new Map());

        expect(diff.parameterDrift).to.have.length(0);
    });
});
