import { expect } from 'chai';
import type { ShipIconCatalog } from '../../extension/shipIcon/shipIconDefinitions';
import type { TechNode } from '../../extension/techTreeParser';
import type {
    ShipDesignCatalog,
    ShipDesignComponentDefinition,
} from '../../extension/shipDesign/definitions';
import { parseShipDesignDocument } from '../../extension/shipDesign/designDocument';
import { generateShipDesignDraft } from '../../extension/shipDesign/generator';

function component(key: string, values: Partial<ShipDesignComponentDefinition> = {}): ShipDesignComponentDefinition {
    return {
        key,
        kind: 'weapon',
        size: 'small',
        prerequisites: [],
        hidden: false,
        shouldAiUse: true,
        aiTags: ['gunship'],
        aiTagWeight: 0,
        aiWeight: { base: 0, dynamic: false },
        classRestrictions: [],
        sizeRestrictions: [],
        blockedBy: [],
        dynamicPotential: false,
        modifier: {},
        shipModifier: {},
        ...values,
    };
}

function tech(id: string, tier: number, start: boolean): TechNode {
    return {
        id,
        area: 'physics',
        tier,
        category: '',
        cost: 0,
        weight: 100,
        icon: '',
        title: id,
        isRare: false,
        isDangerous: false,
        isStartTech: start,
        file: 'fixture',
        line: 1,
    };
}

function makeCatalog(): ShipDesignCatalog {
    const base: ShipIconCatalog = {
        shipSizes: new Map([['corvette', {
            name: 'corvette',
            entity: 'corvette_entity',
            shipClass: 'shipclass_military',
            sectionSlots: [{ slot: 'mid', locator: 'part1' }],
            graphicalCultures: [],
        }]]),
        sectionsByShipSize: new Map(),
        entityToPdxMesh: new Map(),
        pdxMeshToFile: new Map(),
        spriteFrameByIcon: new Map(),
        spriteSheetFrames: new Map(),
        spriteIconSheet: new Map(),
        graphicalCultures: [],
        warnings: [],
    };
    const components = [
        component('SMALL_RED_LASER', {
            weaponType: 'weapon_type_energy',
            prerequisites: ['tech_lasers_1'],
            upgradesTo: 'SMALL_BLUE_LASER',
            aiWeight: { base: 5, dynamic: true },
            power: { raw: '-2', value: -2 },
        }),
        component('SMALL_BLUE_LASER', {
            weaponType: 'weapon_type_energy',
            prerequisites: ['tech_lasers_2'],
            aiWeight: { base: 8, dynamic: false },
            power: { raw: '-3', value: -3 },
        }),
        component('SMALL_SHIELD_1', {
            kind: 'utility',
            componentSet: 'shields',
            prerequisites: ['tech_shields_1'],
            power: { raw: '-5', value: -5 },
        }),
        component('A_REACTOR_WEAK', {
            kind: 'utility',
            size: 'core',
            componentSet: 'power_core',
            aiTags: [],
            power: { raw: '1', value: 1 },
        }),
        component('Z_REACTOR_STRONG', {
            kind: 'utility',
            size: 'core',
            componentSet: 'power_core',
            aiTags: [],
            power: { raw: '20', value: 20 },
        }),
        component('EVENT_AURA', {
            kind: 'utility',
            size: 'core',
            componentSet: 'special_aura',
            aiTags: [],
        }),
    ];
    return {
        base,
        sections: new Map([['mid_s3', {
            key: 'MID_S3',
            shipSizes: ['corvette'],
            fitsOnSlots: ['mid'],
            entity: 'mid_entity',
            shouldDrawComponents: true,
            compatibleWithAllShipSizes: false,
            componentSlots: [{ name: 'SMALL_GUN_01', template: 'small_turret', locator: 'small_gun_01', side: false }],
            utilitySlots: { small: 2, medium: 0, large: 0, aux: 0 },
            aiTags: ['gunship'],
            aiWeight: { base: 10, dynamic: false },
            prerequisites: [],
            modifier: {},
            shipModifier: {},
        }]]),
        slotTemplates: new Map([['small_turret', {
            key: 'small_turret',
            size: 'small',
            componentTypes: ['weapon'],
            fixed: false,
            entities: {},
        }]]),
        components: new Map(components.map(item => [item.key.toLowerCase(), item])),
        componentSets: new Map(),
        shipSizeDetails: new Map([['corvette', {
            key: 'corvette',
            entity: 'corvette_entity',
            shipClass: 'shipclass_military',
            sectionSlots: [{ slot: 'mid', locator: 'part1' }],
            graphicalCultures: [],
            maxHitpoints: { raw: '100', value: 100 },
            maxSpeed: { raw: '160', value: 160 },
            baseBuildtime: { raw: '60', value: 60 },
            modifier: {},
            shipModifier: {},
            requiredComponentSets: ['power_core'],
            shipRoles: ['gunship'],
            prerequisites: [],
        }]]),
        technologies: new Map([
            ['tech_lasers_1', tech('tech_lasers_1', 1, true)],
            ['tech_lasers_2', tech('tech_lasers_2', 2, false)],
            ['tech_shields_1', tech('tech_shields_1', 1, true)],
        ]),
        technologyPrerequisites: new Map([['tech_lasers_2', ['tech_lasers_1']]]),
        roles: ['gunship'],
        variables: new Map(),
        warnings: [],
    };
}

const DESIGN = [
    'ship_design = {',
    ' name = TEST',
    ' ship_size = corvette',
    ' section = { template = MID_S3 slot = mid }',
    ' required_component = A_REACTOR_WEAK',
    ' required_component = EVENT_AURA',
    '}',
].join('\n');

function weapon(result: ReturnType<typeof generateShipDesignDraft>): string | undefined {
    return result.sections[0]?.components.find(component => component.slot === 'SMALL_GUN_01')?.template;
}

describe('ship design draft generator', () => {
    it('honours all, starting, and custom technology scopes with upgrade chains', () => {
        const catalog = makeCatalog();
        const design = parseShipDesignDocument(DESIGN).designs[0];
        if (!design) throw new Error('fixture design missing');
        const all = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'all' }, enforcePower: false,
        });
        const starting = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'starting' }, enforcePower: false,
        });
        const custom = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'custom', technologies: ['tech_lasers_2', 'tech_shields_1'] }, enforcePower: false,
        });
        expect(weapon(all)).to.equal('SMALL_BLUE_LASER');
        expect(weapon(starting)).to.equal('SMALL_RED_LASER');
        expect(weapon(custom)).to.equal('SMALL_BLUE_LASER');
        expect(starting.warnings.join('\n')).to.contain('conditional ai_weight');
        expect(starting.requiredComponents).to.include('EVENT_AURA');
        expect(starting.requiredComponents).to.include('A_REACTOR_WEAK');
    });

    it('is deterministic and does not mutate the input design', () => {
        const catalog = makeCatalog();
        const design = parseShipDesignDocument(DESIGN).designs[0];
        if (!design) throw new Error('fixture design missing');
        const before = JSON.stringify(design);
        const options = { role: 'gunship', technology: { kind: 'all' } as const, enforcePower: false };
        const first = generateShipDesignDraft(catalog, design, options);
        const second = generateShipDesignDraft(catalog, design, options);
        expect(JSON.stringify(first)).to.equal(JSON.stringify(second));
        expect(JSON.stringify(design)).to.equal(before);
    });

    it('uses a bounded reactor repair while respecting the required component set', () => {
        const catalog = makeCatalog();
        const design = parseShipDesignDocument(DESIGN).designs[0];
        if (!design) throw new Error('fixture design missing');
        const result = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'all' }, enforcePower: true,
        });
        expect(result.requiredComponents).to.include('Z_REACTOR_STRONG');
        expect(result.requiredComponents).not.to.include('A_REACTOR_WEAK');
        expect(result.explanations.join('\n')).to.contain('Power repair');
        expect(result.requiredComponents).to.include('EVENT_AURA');
    });

    it('terminates on upgrade cycles and reports the fallback', () => {
        const catalog = makeCatalog();
        const a = component('CYCLE_A', { upgradesTo: 'CYCLE_B', aiWeight: { base: 10000, dynamic: false } });
        const b = component('CYCLE_B', { upgradesTo: 'CYCLE_A', aiWeight: { base: 10000, dynamic: false } });
        catalog.components.set('cycle_a', a);
        catalog.components.set('cycle_b', b);
        const design = parseShipDesignDocument(DESIGN).designs[0];
        if (!design) throw new Error('fixture design missing');
        const result = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'all' }, enforcePower: false,
        });
        expect(result.warnings.join('\n')).to.contain('Upgrade cycle');
        expect(weapon(result)).to.be.oneOf(['CYCLE_A', 'CYCLE_B']);
    });

    it('refuses growth-stage loadout generation', () => {
        const catalog = makeCatalog();
        const source = 'ship_design = { name = BIO ship_size = corvette growth_stages = { { ship_size = corvette } } }';
        const design = parseShipDesignDocument(source).designs[0];
        if (!design) throw new Error('fixture design missing');
        const result = generateShipDesignDraft(catalog, design, {
            role: 'gunship', technology: { kind: 'all' }, enforcePower: true,
        });
        expect(result.sections).to.have.length(0);
        expect(result.warnings.join(' ')).to.contain('read-only');
    });

    it('localizes explanations and warnings through the supplied text function', () => {
        const catalog = makeCatalog();
        const design = parseShipDesignDocument(DESIGN).designs[0];
        if (!design) throw new Error('fixture design missing');
        const zh = (_en: string, cn: string): string => cn;
        const result = generateShipDesignDraft(catalog, design, { role: 'gunship', technology: { kind: 'all' }, enforcePower: true }, zh);
        expect(result.explanations[0]).to.match(/^生成角色 gunship，范围：全部科技。$/);
        expect(result.explanations.join('\n')).not.to.match(/selected|Generating/);
    });
});
