import { expect } from 'chai';
import {
    SHIP_ICON_CATEGORY_IDS,
    categorizeShipSizes,
    categoryForShipClass,
    normalizeMeshOverrides,
    overrideEntriesFor,
    parseMeshOverrideEntries,
} from '../../extension/shipIcon/shipIconSelection';

const CLASS_TO_CATEGORY: ReadonlyArray<readonly [string, string]> = [
    ['shipclass_military', 'military'],
    ['shipclass_military_station', 'militaryStation'],
    ['shipclass_military_special', 'militarySpecial'],
    ['shipclass_starbase', 'starbase'],
    ['shipclass_constructor', 'constructor'],
    ['shipclass_colonizer', 'colonizer'],
    ['shipclass_science_ship', 'scienceShip'],
    ['shipclass_transport', 'transport'],
    ['shipclass_research_station', 'station'],
    ['shipclass_observation_station', 'station'],
];

const EXPECTED_LABELS: Readonly<Record<string, readonly string[]>> = {
    military: ['Military ships', '军舰'],
    militaryStation: ['Military stations', '军用空间站'],
    militarySpecial: ['Special military ships', '特殊军舰'],
    starbase: ['Starbases', '星港与基地'],
    constructor: ['Construction ships', '工程船'],
    colonizer: ['Colony ships', '殖民船'],
    scienceShip: ['Science ships', '科研船'],
    transport: ['Transport ships', '运输船'],
    station: ['Stations', '站点'],
    other: ['Other', '其他'],
};

// ── categorizeShipSizes ──────────────────────────────────────────────────────

describe('categorizeShipSizes', () => {
    it('maps every known ship class to its own category', () => {
        for (const [shipClass, expected] of CLASS_TO_CATEGORY) {
            const categories = categorizeShipSizes([{ shipSize: 'size_a', shipClass }]);
            expect(categories.map((category) => category.id), shipClass).to.deep.equal([expected]);
            expect(categories[0]?.shipSizes, shipClass).to.deep.equal(['size_a']);
        }
    });

    it('matches the class case-insensitively and ignores surrounding blanks', () => {
        expect(categoryForShipClass('  ShipClass_Military  ')).to.equal('military');
        expect(categoriesOf([{ shipSize: 'size_a', shipClass: 'SHIPCLASS_SCIENCE_SHIP' }])).to.deep.equal(['scienceShip']);
    });

    it('uses the documented labels', () => {
        const categories = categorizeShipSizes(
            Object.keys(EXPECTED_LABELS).map((id) => ({ shipSize: id, shipClass: classFor(id) })),
        );
        for (const category of categories) {
            const expected = EXPECTED_LABELS[category.id];
            expect(expected, category.id).to.not.equal(undefined);
            expect(category.labelEn).to.equal(expected?.[0]);
            expect(category.labelZh).to.equal(expected?.[1]);
        }
        expect(categories.map((category) => category.id)).to.deep.equal([...SHIP_ICON_CATEGORY_IDS]);
    });

    it('always emits the fixed order, whatever the input order is', () => {
        const shuffled = [
            { shipSize: 'size_other' },
            { shipSize: 'size_transport', shipClass: 'shipclass_transport' },
            { shipSize: 'size_military', shipClass: 'shipclass_military' },
            { shipSize: 'size_station', shipClass: 'shipclass_research_station' },
            { shipSize: 'size_starbase', shipClass: 'shipclass_starbase' },
            { shipSize: 'size_constructor', shipClass: 'shipclass_constructor' },
        ];
        expect(categoriesOf(shuffled)).to.deep.equal([
            'military', 'starbase', 'constructor', 'transport', 'station', 'other',
        ]);
    });

    it('drops empty categories', () => {
        const categories = categorizeShipSizes([{ shipSize: 'size_a', shipClass: 'shipclass_military' }]);
        expect(categories).to.have.length(1);
        expect(categories[0]?.id).to.equal('military');
        expect(categorizeShipSizes([])).to.deep.equal([]);
    });

    it('puts a missing or unknown class into other, which stays last', () => {
        expect(categoryForShipClass(undefined)).to.equal('other');
        expect(categoryForShipClass('')).to.equal('other');
        expect(categoryForShipClass(42)).to.equal('other');
        expect(categoryForShipClass('shipclass_entropy_conduit')).to.equal('other');
        expect(categoriesOf([
            { shipSize: 'size_unknown', shipClass: 'shipclass_not_a_class' },
            { shipSize: 'size_bare' },
            { shipSize: 'size_military', shipClass: 'shipclass_military' },
        ])).to.deep.equal(['military', 'other']);
    });

    it('keeps the given order inside a category and removes duplicates', () => {
        const categories = categorizeShipSizes([
            { shipSize: 'corvette', shipClass: 'shipclass_military' },
            { shipSize: 'destroyer', shipClass: 'shipclass_military' },
            { shipSize: 'corvette', shipClass: 'shipclass_military' },
        ]);
        expect(categories[0]?.shipSizes).to.deep.equal(['corvette', 'destroyer']);
    });

    it('skips entries without a usable name', () => {
        const categories = categorizeShipSizes([
            { shipSize: '   ', shipClass: 'shipclass_military' },
            { shipSize: '', shipClass: 'shipclass_starbase' },
        ]);
        expect(categories).to.deep.equal([]);
    });
});

function categoriesOf(entries: ReadonlyArray<{ shipSize: string; shipClass?: string }>): string[] {
    return categorizeShipSizes(entries).map((category) => category.id);
}

/** The class of one expected category, for the label table. */
function classFor(id: string): string | undefined {
    if (id === 'other') return undefined;
    const hit = CLASS_TO_CATEGORY.find(([, category]) => category === id);
    return hit?.[0];
}

// ── normalizeMeshOverrides ───────────────────────────────────────────────────

describe('normalizeMeshOverrides', () => {
    it('accepts a single string as a one-element list', () => {
        expect(normalizeMeshOverrides({ corvette: 'humanoid_01_corvette_entity' }))
            .to.deep.equal({ corvette: ['humanoid_01_corvette_entity'] });
    });

    it('accepts an array and keeps its order', () => {
        expect(normalizeMeshOverrides({ corvette: ['b.mesh', 'a'] }))
            .to.deep.equal({ corvette: ['b.mesh', 'a'] });
    });

    it('drops non-string, blank and duplicate items from a mixed array', () => {
        const normalized = normalizeMeshOverrides({
            corvette: ['a.mesh', '', '   ', 7, null, undefined, { x: 1 }, 'a.mesh', 'b'],
        });
        expect(normalized).to.deep.equal({ corvette: ['a.mesh', 'b'] });
    });

    it('treats a string value as a separated list', () => {
        expect(normalizeMeshOverrides({ corvette: 'a.mesh, b; c' }))
            .to.deep.equal({ corvette: ['a.mesh', 'b', 'c'] });
    });

    it('rejects anything that is not a plain object', () => {
        for (const value of [null, undefined, 'corvette', 42, [], true]) {
            expect(normalizeMeshOverrides(value), String(value)).to.deep.equal({});
        }
    });

    it('leaves out a size whose list ends up empty', () => {
        expect(normalizeMeshOverrides({ corvette: [], destroyer: '', battleship: '   ', cruiser: 42 }))
            .to.deep.equal({});
    });

    it('drops entries walking up a directory, in either slash direction', () => {
        expect(normalizeMeshOverrides({
            corvette: ['../outside.mesh', 'gfx/../outside.mesh', 'gfx\\..\\outside.mesh', 'gfx/models/ok.mesh'],
        })).to.deep.equal({ corvette: ['gfx/models/ok.mesh'] });
    });

    it('keeps an upper-case .MESH spelling untouched', () => {
        expect(normalizeMeshOverrides({ corvette: 'gfx/models/HULL.MESH' }))
            .to.deep.equal({ corvette: ['gfx/models/HULL.MESH'] });
    });

    it('turns backslashes into forward slashes', () => {
        expect(normalizeMeshOverrides({ corvette: 'gfx\\models\\hull.mesh' }))
            .to.deep.equal({ corvette: ['gfx/models/hull.mesh'] });
    });

    it('trims keys and drops blank ones', () => {
        expect(normalizeMeshOverrides({ '  corvette  ': 'hull', '   ': 'hull' }))
            .to.deep.equal({ corvette: ['hull'] });
    });

    it('de-duplicates case-insensitively but keeps the first spelling', () => {
        expect(normalizeMeshOverrides({ corvette: ['Hull.MESH', 'hull.mesh', 'hull.MESH'] }))
            .to.deep.equal({ corvette: ['Hull.MESH'] });
    });

    it('bounds one size to 64 entries', () => {
        const many = Array.from({ length: 200 }, (_, index) => `part_${index}.mesh`);
        const normalized = normalizeMeshOverrides({ corvette: many });
        expect(normalized['corvette']).to.have.length(64);
    });
});

// ── parseMeshOverrideEntries ─────────────────────────────────────────────────

describe('parseMeshOverrideEntries', () => {
    it('splits on commas and semicolons', () => {
        expect(parseMeshOverrideEntries('a,b')).to.deep.equal(['a', 'b']);
        expect(parseMeshOverrideEntries('a; b')).to.deep.equal(['a', 'b']);
        expect(parseMeshOverrideEntries('a, b; c')).to.deep.equal(['a', 'b', 'c']);
    });

    it('splits on full-width separators too', () => {
        expect(parseMeshOverrideEntries('a，b；c')).to.deep.equal(['a', 'b', 'c']);
    });

    it('trims every entry and keeps the written order', () => {
        expect(parseMeshOverrideEntries('  z.mesh ;  a  , m  ')).to.deep.equal(['z.mesh', 'a', 'm']);
    });

    it('returns an empty list for blank input, which means clear', () => {
        expect(parseMeshOverrideEntries('')).to.deep.equal([]);
        expect(parseMeshOverrideEntries('   ')).to.deep.equal([]);
        expect(parseMeshOverrideEntries(',,;')).to.deep.equal([]);
        expect(parseMeshOverrideEntries(undefined)).to.deep.equal([]);
        expect(parseMeshOverrideEntries(42)).to.deep.equal([]);
    });

    it('removes duplicates, case-insensitively', () => {
        expect(parseMeshOverrideEntries('hull.mesh, HULL.MESH, hull.mesh, other'))
            .to.deep.equal(['hull.mesh', 'other']);
    });

    it('converts backslash paths and drops walking-up entries', () => {
        expect(parseMeshOverrideEntries('gfx\\models\\hull.mesh, ../outside.mesh'))
            .to.deep.equal(['gfx/models/hull.mesh']);
    });
});

// ── overrideEntriesFor ──────────────────────────────────────────────────────

describe('overrideEntriesFor', () => {
    it('finds an exact key first, then the same key in another case', () => {
        expect(overrideEntriesFor({ corvette: ['a'] }, 'corvette')).to.deep.equal(['a']);
        expect(overrideEntriesFor({ Corvette: ['a'] }, 'corvette')).to.deep.equal(['a']);
    });

    it('returns undefined when the size has no usable override', () => {
        expect(overrideEntriesFor({}, 'corvette')).to.equal(undefined);
        expect(overrideEntriesFor({ corvette: [] }, 'corvette')).to.equal(undefined);
        expect(overrideEntriesFor({ destroyer: ['a'] }, 'corvette')).to.equal(undefined);
    });

    it('does not resolve an inherited object member', () => {
        expect(overrideEntriesFor({}, 'constructor')).to.equal(undefined);
    });
});
