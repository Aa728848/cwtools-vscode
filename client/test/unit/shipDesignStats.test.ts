import { expect } from 'chai';
import type { ShipDesignData } from '../../shared/shipDesignProtocol';
import type { DefinitionNumber } from '../../extension/shipDesign/definitionNodes';
import type {
    ShipDesignCatalog,
    ShipDesignComponentDefinition,
    ShipDesignSectionDefinition,
} from '../../extension/shipDesign/definitions';
import { parseShipDesignDocument } from '../../extension/shipDesign/designDocument';
import { computeShipDesignStats } from '../../extension/shipDesign/stats';

function number(value: number): DefinitionNumber {
    return { raw: String(value), value };
}

function component(
    key: string,
    fields: Partial<ShipDesignComponentDefinition>,
): ShipDesignComponentDefinition {
    return {
        key, kind: 'utility', size: 'small', prerequisites: [], hidden: false, shouldAiUse: true,
        aiTags: [], aiTagWeight: 0, aiWeight: { base: 0, dynamic: false }, classRestrictions: [],
        sizeRestrictions: [], blockedBy: [], dynamicPotential: false, modifier: {}, shipModifier: {},
        ...fields,
    };
}

function fixtureCatalog(): ShipDesignCatalog {
    const section: ShipDesignSectionDefinition = {
        key: 'MID_GUN', shipSizes: ['corvette'], fitsOnSlots: ['mid'], entity: '', shouldDrawComponents: true,
        compatibleWithAllShipSizes: false, prerequisites: [], aiTags: [], aiWeight: { base: 0, dynamic: false },
        componentSlots: ['GUN_A', 'GUN_B'].map(name => ({ name, template: 'small_turret', side: false })),
        utilitySlots: { small: 1, medium: 0, large: 0, aux: 0 },
        resources: { cost: { alloys: number(5) }, upkeep: { energy: number(0.5) } },
        modifier: { SHIP_HULL_ADD: number(10), ship_evasion_add: number(0.02) },
        shipModifier: { ship_hull_add: number(2), ship_armor_add: number(15), ship_speed_add: number(3) },
    };
    return {
        base: {
            shipSizes: new Map(), sectionsByShipSize: new Map(), entityToPdxMesh: new Map(),
            pdxMeshToFile: new Map(), spriteFrameByIcon: new Map(), spriteSheetFrames: new Map(),
            spriteIconSheet: new Map(), graphicalCultures: [], warnings: [],
        },
        sections: new Map([['mid_gun', section]]),
        slotTemplates: new Map([['small_turret', {
            key: 'small_turret', size: 'small', componentTypes: ['weapon'], fixed: false, entities: {},
        }]]),
        components: new Map([
            ['laser', component('LASER', {
                kind: 'weapon', buildTime: number(2), power: number(-3), sensorRange: number(2),
                modifier: { ship_armor_add: number(2), ship_hull_mult: number(5) },
                damage: { min: number(4), max: number(12), accuracy: number(0.5) },
                resources: { cost: { Alloys: number(1) }, upkeep: { energy: number(0.25) } },
            })],
            ['shield', component('SHIELD', {
                power: number(-4), sensorRange: number(3),
                modifier: { ship_shield_add: number(20) }, shipModifier: { ship_shield_add: number(5) },
                damage: { min: number(100), max: number(100), accuracy: number(1) },
            })],
            ['core', component('CORE', {
                power: number(20), sensorRange: number(5), buildTime: number(5),
                shipModifier: { ship_speed_add: number(4) },
                resources: { cost: { exotic_gases: number(1), alloys: number(3) }, upkeep: { energy: number(2) } },
            })],
        ]),
        componentSets: new Map(),
        shipSizeDetails: new Map([['corvette', {
            key: 'corvette', sectionSlots: [], graphicalCultures: [], requiredComponentSets: [],
            shipRoles: [], prerequisites: [], maxHitpoints: number(120), maxSpeed: number(160),
            baseBuildtime: number(60), modifier: { ship_hull_add: number(5), ship_evasion_add: number(0) },
            shipModifier: { ship_hull_add: number(7) },
            resources: { cost: { alloys: number(10) }, upkeep: { energy: number(1) } },
        }]]),
        technologies: new Map(), technologyPrerequisites: new Map(), roles: [], variables: new Map(), warnings: [],
    };
}

function fixtureDesign(secondWeapon = 'LASER'): ShipDesignData {
    const [design] = parseShipDesignDocument([
        'ship_design = { name = TEST ship_size = CORVETTE',
        ' section = { template = Mid_Gun slot = mid',
        '  component = { slot = gun_a template = LASER }',
        '  component = { slot = GUN_A template = SHIELD }',
        '  component = { slot = GUN_B template = ' + secondWeapon + ' }',
        '  component = { slot = SMALL_UTILITY_1 template = SHIELD }',
        '  component = { slot = UNKNOWN_SLOT template = LASER }',
        ' }',
        ' required_component = core',
        '}',
    ].join('\n')).designs;
    if (!design) throw new Error('Fixture design missing');
    return design;
}

function known(value: number, sources: string[]) {
    return { status: 'known', value, sources, unresolved: [] };
}

function partial(value: number, sources: string[], unresolved: string[]) {
    return { status: 'partial', value, sources, unresolved };
}

function unknown(sources: string[] = [], unresolved: string[] = []) {
    return { status: 'unknown', sources, unresolved };
}

describe('ship design stats', () => {
    it('sums known static fields across size, section, selected slots, and required components', () => {
        const design = fixtureDesign();
        const stats = computeShipDesignStats(fixtureCatalog(), design);
        expect(stats.designId).to.equal(design.id);
        expect(stats.values).to.deep.equal({
            buildTime: known(69, ['component:CORE', 'component:LASER', 'size:corvette']),
            hull: known(144, ['section:MID_GUN', 'size:corvette']),
            armor: known(19, ['component:LASER', 'section:MID_GUN']),
            shields: known(25, ['component:SHIELD']),
            evasion: known(0.02, ['section:MID_GUN', 'size:corvette']),
            speed: known(167, ['component:CORE', 'section:MID_GUN', 'size:corvette']),
            power: known(10, ['component:CORE', 'component:LASER', 'component:SHIELD']),
            sensorRange: known(5, ['component:CORE', 'component:LASER', 'component:SHIELD']),
            damagePerDay: known(8, ['component:LASER']),
        });
        expect(stats.resources).to.deep.equal({
            'cost.alloys': known(20, ['component:CORE', 'component:LASER', 'section:MID_GUN', 'size:corvette']),
            'cost.exotic_gases': known(1, ['component:CORE']),
            'upkeep.energy': known(4, ['component:CORE', 'component:LASER', 'section:MID_GUN', 'size:corvette']),
        });
    });

    it('keeps resolved subtotals and raw unresolved fields, including missing weapon accuracy', () => {
        const catalog = fixtureCatalog();
        catalog.components.set('broken_weapon', component('BROKEN_WEAPON', {
            kind: 'weapon', power: { raw: '@power' }, sensorRange: { raw: '@sensor' },
            modifier: { ship_hull_add: { raw: '@hull' } },
            damage: { min: { raw: '@min' }, max: number(10) },
            resources: { cost: { alloys: { raw: '@cost' } }, upkeep: { minerals: { raw: '@upkeep' } } },
        }));
        const { values, resources } = computeShipDesignStats(catalog, fixtureDesign('BROKEN_WEAPON'));
        expect(values.power).to.deep.equal(partial(13,
            ['component:BROKEN_WEAPON', 'component:CORE', 'component:LASER', 'component:SHIELD'], ['@power']));
        expect(values.hull).to.deep.equal(partial(144, ['component:BROKEN_WEAPON', 'section:MID_GUN', 'size:corvette'], ['@hull']));
        expect(values.sensorRange).to.deep.equal(partial(5,
            ['component:BROKEN_WEAPON', 'component:CORE', 'component:LASER', 'component:SHIELD'], ['@sensor']));
        expect(values.damagePerDay).to.deep.equal(partial(4,
            ['component:BROKEN_WEAPON', 'component:LASER'], ['@min', 'damage_per_day.accuracy (missing)']));
        expect(resources['cost.alloys']).to.deep.equal(partial(19,
            ['component:BROKEN_WEAPON', 'component:CORE', 'component:LASER', 'section:MID_GUN', 'size:corvette'], ['@cost']));
        expect(resources['upkeep.minerals']).to.deep.equal(unknown(['component:BROKEN_WEAPON'], ['@upkeep']));
    });

    it('distinguishes explicit zero, unresolved-only, and absent values', () => {
        const catalog = fixtureCatalog();
        catalog.components.set('unknown_weapon', component('UNKNOWN_WEAPON', {
            kind: 'weapon', damage: { min: number(0), max: number(0), accuracy: { raw: '@accuracy' } },
        }));
        const design = { ...fixtureDesign(), sections: [], requiredComponents: ['UNKNOWN_WEAPON'] };
        const { values } = computeShipDesignStats(catalog, design);
        expect(values.evasion).to.deep.equal(known(0, ['size:corvette']));
        expect(values.power).to.deep.equal(unknown());
        expect(values.damagePerDay).to.deep.equal(unknown(['component:UNKNOWN_WEAPON'], ['@accuracy']));
        const absent = computeShipDesignStats(catalog, { ...design, shipSize: undefined, requiredComponents: [] });
        expect(Object.keys(absent.values)).to.have.length(9);
        expect(Object.values(absent.values)).to.deep.equal(Array.from({ length: 9 }, () => unknown()));
        expect(absent.resources).to.deep.equal({});
    });

    it('orders output consistently when definition, section, and required component order varies', () => {
        const catalog = fixtureCatalog();
        const design = fixtureDesign();
        const [section] = design.sections;
        const mid = catalog.sections.get('mid_gun');
        const core = catalog.components.get('core');
        if (!section || !mid || !core?.resources) throw new Error('Fixture catalog or section missing');
        catalog.sections.set('alt', { ...mid, key: 'ALT' });
        const sections = [...design.sections, { ...section, id: 'alt', template: 'ALT', components: [] }];
        const requiredComponents = [...design.requiredComponents, 'SHIELD'];
        const stats = computeShipDesignStats(catalog, { ...design, sections, requiredComponents });
        const reordered = {
            ...catalog,
            sections: new Map([...catalog.sections].reverse()),
            components: new Map([...catalog.components].reverse()),
        };
        reordered.components.set('core', {
            ...core,
            resources: { ...core.resources, cost: Object.fromEntries(Object.entries(core.resources.cost).reverse()) },
        });
        expect(JSON.stringify(computeShipDesignStats(reordered, {
            ...design, sections: sections.reverse(), requiredComponents: requiredComponents.reverse(),
        }))).to.equal(JSON.stringify(stats));
        expect(Object.keys(stats.resources)).to.deep.equal(['cost.alloys', 'cost.exotic_gases', 'upkeep.energy']);
    });
});
