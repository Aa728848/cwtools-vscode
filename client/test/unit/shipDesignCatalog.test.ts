import { expect } from 'chai';
import type { ShipIconDataSource } from '../../extension/shipIcon/shipIconDefinitions';
import { loadShipDesignCatalog, lookupShipDesignComponent } from '../../extension/shipDesign/definitions';
import {
    buildShipDesignRequiredSlots,
    buildShipDesignView,
    fillShipDesignEmptySlots,
    fillShipDesignSlots,
    shipDesignComponentTiers,
    shipDesignPlaceableSlotIds,
    replaceShipDesignRequiredComponent,
    shipDesignRequiredCandidates,
    shipDesignRequiredCompatibility,
    shipDesignComponentCandidates,
    shipDesignDropCompatibility,
} from '../../extension/shipDesign/slots';
import { parseShipDesignDocument } from '../../extension/shipDesign/designDocument';

class MemorySource implements ShipIconDataSource {
    private readonly files = new Map<string, string>();
    private readonly directories = new Set<string>();

    constructor(entries: Record<string, string>, directories: readonly string[] = []) {
        for (const [path, content] of Object.entries(entries)) this.files.set(path.toLowerCase(), content);
        for (const directory of directories) this.directories.add(directory.toLowerCase());
    }

    async readText(relativePath: string): Promise<string | undefined> {
        return this.files.get(relativePath.toLowerCase());
    }

    async listFiles(relativeDirectory: string): Promise<string[]> {
        const directory = relativeDirectory.toLowerCase().replace(/\/$/, '');
        const prefix = directory + '/';
        const children = new Set<string>();
        const collect = (path: string): void => {
            if (!path.startsWith(prefix)) return;
            const rest = path.slice(prefix.length);
            const first = rest.split('/')[0];
            if (first) children.add(prefix + first);
        };
        for (const path of this.files.keys()) collect(path);
        for (const path of this.directories) collect(path);
        return [...children].sort();
    }
}

const FILES: Record<string, string> = {
    'common/scripted_variables/00.txt': '@hp = 50\n@global_build = 75',
    'common/ship_sizes/00.txt': [
        '@hp = 100',
        'corvette = {',
        ' entity = corvette_entity',
        ' class = shipclass_military',
        ' section_slots = { "mid" = { locator = "part1" } }',
        ' max_hitpoints = @hp',
        ' max_speed = 160',
        ' base_buildtime = @global_build',
        ' required_component_set = power_core',
        ' ship_roles = { gunship artillery }',
        ' resources = { category = ships upkeep = { energy = 1 } }',
        '}',
    ].join('\n'),
    'common/ship_sizes/01.txt': 'destroyer = { entity = destroyer_entity class = shipclass_military max_hitpoints = @hp }',
    'common/section_templates/00.txt': [
        '@section_cost = 40',
        'ship_section_template = {',
        ' key = MID_S3',
        ' ship_size = corvette',
        ' fits_on_slot = mid',
        ' entity = corvette_mid_entity',
        ' should_draw_components = yes',
        ' component_slot = { name = SMALL_GUN_01 template = small_turret locatorname = small_gun_01 }',
        ' small_utility_slots = 2',
        ' ai_tags = { gunship }',
        ' ai_weight = { weight = 10 }',
        ' resources = { category = ship_sections cost = { alloys = @section_cost } }',
        '}',
    ].join('\n'),
    'common/component_slot_templates/00.txt': [
        'small_turret = {',
        ' size = small',
        ' component = weapon',
        ' entities = { weapon_type_energy = small_laser_gun_entity }',
        '}',
        'large_turret = { size = large component = weapon }',
    ].join('\n'),
    'common/inline_scripts/ed/turbo.txt': [
        'key = "ED_HEAVY_TURBO_$TIER$_$TYPE$"',
        'icon = $ICON$',
        'size = $SIZE$',
        'component_set = $SET$',
        'power = @[ 3 * $MULT$ * -1 ]',
    ].join('\n'),
    'common/component_templates/00.txt': [
        'weapon_component_template = {',
        ' key = SMALL_RED_LASER',
        ' size = small',
        ' type = instant tags = { weapon_type_energy }',
        ' prerequisites = { tech_lasers_1 }',
        ' upgrades_to = SMALL_BLUE_LASER',
        ' ai_tags = { gunship }',
        ' ai_weight = { weight = 5 modifier = { factor = 2 has_technology = tech_lasers_2 } }',
        ' power = -2',
        ' resources = { category = ship_components cost = { alloys = 5 } upkeep = { energy = 0.1 } }',
        ' damage_per_day = { accuracy = 0.8 damage = { min = 4 max = 8 } }',
        '}',
        'weapon_component_template = {',
        ' key = SMALL_BLUE_LASER size = small type = instant tags = { weapon_type_energy }',
        ' prerequisites = { tech_lasers_2 } ai_tags = { gunship } ai_weight = { weight = 8 } power = -3',
        '}',
        'weapon_component_template = { key = LARGE_GUN size = large type = weapon_type_kinetic }',
        'weapon_component_template = {',
        ' inline_script = { script = ed/turbo TIER = 3 TYPE = B SIZE = large ICON = GFX_TURBO SET = ED_HEAVY_TURBO_3_B MULT = 2 }',
        ' size = large tags = { weapon_type_kinetic }',
        '}',
        'utility_component_template = {',
        ' key = SMALL_SHIELD_1 size = small component_set = shields',
        ' prerequisites = { tech_shields_1 } ai_tags = { gunship } ai_weight = { weight = 4 }',
        ' power = -5 modifier = { ship_shield_add = 100 }',
        '}',
        'utility_component_template = {',
        ' key = CORVETTE_REACTOR size = core component_set = power_core',
        ' power = 20 is_default_component = yes',
        '}',
    ].join('\n'),
    'common/component_templates/weapon_components.csv': 'key;cost;power;min_damage;max_damage;accuracy;end\nLARGE_GUN;60;-30;36;96;0.9;',
    'common/component_sets/00.txt': [
        'component_set = { key = power_core required_component_set = yes is_core_component_set = yes }',
        'component_set = { key = shields }',
    ].join('\n'),
    'common/technology/00.txt': [
        'tech_lasers_1 = { area = physics tier = 1 cost = 100 weight = 100 start_tech = yes }',
        'tech_lasers_2 = { area = physics tier = 2 cost = 200 weight = 100 prerequisites = { tech_lasers_1 } }',
        'tech_shields_1 = { area = physics tier = 1 cost = 100 weight = 100 start_tech = yes }',
    ].join('\n'),
    'gfx/models/ships/test.asset': [
        'entity = { name = humanoid_01_corvette_entity pdxmesh = root_mesh }',
        'entity = { name = humanoid_01_corvette_mid_entity pdxmesh = mid_mesh }',
        'entity = { name = small_laser_gun_entity pdxmesh = gun_mesh }',
    ].join('\n'),
    'gfx/models/ships/test.gfx': [
        'pdxmesh = { name = root_mesh file = "gfx/models/ships/root.mesh" }',
        'pdxmesh = { name = mid_mesh file = "gfx/models/ships/mid.mesh" }',
        'pdxmesh = { name = gun_mesh file = "gfx/models/ships/gun.mesh" }',
    ].join('\n'),
};

const DESIGN_SOURCE = [
    'ship_design = {',
    ' name = TEST_CORVETTE',
    ' ship_size = corvette',
    ' graphical_culture = humanoid_01',
    ' section = {',
    '  template = MID_S3',
    '  slot = mid',
    '  component = { slot = SMALL_GUN_01 template = SMALL_RED_LASER }',
    ' }',
    ' required_component = CORVETTE_REACTOR',
    '}',
].join('\n');

describe('ship design catalog and slots', () => {
    it('loads arbitrary slot roots and resolves culture/entity/model chains', async () => {
        const source = new MemorySource(FILES, ['gfx/models/ships/humanoid_01']);
        const catalog = await loadShipDesignCatalog(source);
        expect(catalog.sections.has('mid_s3')).to.equal(true);
        expect(catalog.slotTemplates.has('small_turret')).to.equal(true);
        expect(catalog.components.has('small_red_laser')).to.equal(true);
        expect(catalog.shipSizeDetails.get('corvette')?.maxHitpoints?.value).to.equal(100);
        expect(catalog.shipSizeDetails.get('corvette')?.baseBuildtime?.value).to.equal(75);
        expect(catalog.shipSizeDetails.get('destroyer')?.maxHitpoints?.value).to.equal(50);
        expect(catalog.components.get('large_gun')?.power?.value).to.equal(-30);
        expect(catalog.components.get('ed_heavy_turbo_3_b')?.key).to.equal('ED_HEAVY_TURBO_3_B');
        expect(catalog.components.get('ed_heavy_turbo_3_b')?.size).to.equal('large');
        expect(catalog.components.get('ed_heavy_turbo_3_b')?.icon).to.equal('GFX_TURBO');
        expect(catalog.components.get('ed_heavy_turbo_3_b')?.componentSet).to.equal('ED_HEAVY_TURBO_3_B');
        expect(catalog.components.get('ed_heavy_turbo_3_b')?.power?.value).to.equal(-6);
        expect(catalog.technologies.has('tech_lasers_2')).to.equal(true);

        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        expect(design).not.to.equal(undefined);
        if (!design) return;
        const view = buildShipDesignView(catalog, design);
        expect(view.sections[0]?.slots.map(slot => slot.name)).to.deep.equal([
            'SMALL_GUN_01', 'SMALL_UTILITY_1', 'SMALL_UTILITY_2',
        ]);
        const root = view.model.find(node => node.kind === 'root');
        const section = view.model.find(node => node.kind === 'section');
        const weapon = view.model.find(node => node.kind === 'component');
        expect(root?.entityName).to.equal('humanoid_01_corvette_entity');
        expect(root?.meshFile).to.equal('gfx/models/ships/root.mesh');
        expect(section?.parentId).to.equal('root');
        expect(section?.locatorName).to.equal('part1');
        expect(weapon?.parentId).to.equal(section?.id);
        expect(weapon?.locatorName).to.equal('small_gun_01');
        expect(weapon?.meshFile).to.equal('gfx/models/ships/gun.mesh');
    });

    it('fills only compatible empty slots and never overwrites equipment', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES, ['gfx/models/ships/humanoid_01']));
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        if (!design) throw new Error('fixture design missing');
        const shields = fillShipDesignEmptySlots(catalog, design, 'SMALL_SHIELD_1');
        expect(shields.filledSlotIds).to.have.length(2);
        expect(shields.operations.map(operation => operation.kind)).to.deep.equal(['set-component', 'set-component']);
        const lasers = fillShipDesignEmptySlots(catalog, design, 'SMALL_RED_LASER');
        expect(lasers.operations).to.have.length(0);
        expect(lasers.skipped.some(item => item.reasons.some(reason => reason.includes('Ship limit')))).to.equal(false);
    });

    it('fills all compatible slots on request and respects ship limits within one fill', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES, ['gfx/models/ships/humanoid_01']));
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        const shield = lookupShipDesignComponent(catalog, 'SMALL_SHIELD_1');
        if (!design || !shield) throw new Error('fixture missing');
        expect(fillShipDesignSlots(catalog, design, 'SMALL_BLUE_LASER', { replaceEquipped: false }).operations).to.have.length(0);
        const replaced = fillShipDesignSlots(catalog, design, 'SMALL_BLUE_LASER', { replaceEquipped: true });
        expect(replaced.operations).to.deep.equal([{ kind: 'set-component', sectionId: 'design:0/section:0', slot: 'SMALL_GUN_01', template: 'SMALL_BLUE_LASER' }]);
        expect(fillShipDesignSlots(catalog, design, 'SMALL_RED_LASER', { replaceEquipped: true }).operations).to.have.length(0);
        catalog.components.set('limited_shield', { ...shield, key: 'LIMITED_SHIELD', shipLimit: { raw: '1', value: 1 } });
        const limited = fillShipDesignSlots(catalog, design, 'LIMITED_SHIELD', { replaceEquipped: false });
        expect(limited.filledSlotIds).to.have.length(1);
        expect(limited.skipped.some(item => item.reasons.some(reason => reason.includes('Ship limit')))).to.equal(true);
    });

    it('lists placeable slots for a held component, excluding slots that already hold it', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES));
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        const blue = lookupShipDesignComponent(catalog, 'SMALL_BLUE_LASER');
        const red = lookupShipDesignComponent(catalog, 'SMALL_RED_LASER');
        const shield = lookupShipDesignComponent(catalog, 'SMALL_SHIELD_1');
        if (!design || !blue || !red || !shield) throw new Error('fixture missing');
        expect(shipDesignPlaceableSlotIds(catalog, design, blue)).to.deep.equal(['design:0/section:0/slot:0']);
        expect(shipDesignPlaceableSlotIds(catalog, design, red)).to.deep.equal([]);
        expect(shipDesignPlaceableSlotIds(catalog, design, shield)).to.have.length(2);
    });

    it('records the definition file of each component', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES));
        expect(lookupShipDesignComponent(catalog, 'SMALL_RED_LASER')?.sourceFile).to.equal('common/component_templates/00.txt');
    });

    it('derives component tiers from upgrade chains', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES));
        const tiers = shipDesignComponentTiers(catalog);
        expect(tiers.get('small_red_laser')).to.equal(1);
        expect(tiers.get('small_blue_laser')).to.equal(2);
        expect(tiers.get('small_shield_1')).to.equal(1);
    });

    it('returns incompatibility reasons when all candidates are requested', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES, ['gfx/models/ships/humanoid_01']));
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        if (!design) throw new Error('fixture design missing');
        const view = buildShipDesignView(catalog, design);
        const slot = view.sections[0]?.slots[0];
        if (!slot) throw new Error('fixture slot missing');
        const compatible = shipDesignComponentCandidates(catalog, design, slot);
        expect(compatible.some(candidate => candidate.component.key === 'LARGE_GUN')).to.equal(false);
        const all = shipDesignComponentCandidates(catalog, design, slot, true);
        const large = all.find(candidate => candidate.component.key === 'LARGE_GUN');
        expect(large?.compatibility.compatible).to.equal(false);
        expect(large?.compatibility.reasons.join(' ')).to.contain('does not fit');
    });

    it('builds required component slots from ship-size sets and validates set replacements', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES));
        const source = DESIGN_SOURCE.replace(' required_component = CORVETTE_REACTOR', ' required_component = CORVETTE_REACTOR\n required_component = SMALL_SHIELD_1\n required_component = UNKNOWN_PART');
        const design = parseShipDesignDocument(source).designs[0];
        const reactor = lookupShipDesignComponent(catalog, 'CORVETTE_REACTOR');
        const shield = lookupShipDesignComponent(catalog, 'SMALL_SHIELD_1');
        if (!design || !reactor || !shield) throw new Error('fixture missing');
        const slots = buildShipDesignRequiredSlots(catalog, design);
        expect(slots.map(slot => [slot.id, slot.componentSet, slot.selected, slot.editable])).to.deep.equal([
            ['required:set:power_core', 'power_core', 'CORVETTE_REACTOR', true],
            ['required:extra:0', 'shields', 'SMALL_SHIELD_1', true],
            ['required:extra:1', undefined, 'UNKNOWN_PART', false],
        ]);
        expect(buildShipDesignView(catalog, design).requiredSlots).to.deep.equal(slots);
        const core = slots[0];
        if (!core) throw new Error('core slot missing');
        expect(shipDesignRequiredCandidates(catalog, design, core).map(component => component.key)).to.deep.equal(['CORVETTE_REACTOR']);
        const mismatch = shipDesignRequiredCompatibility(catalog, design, core, shield);
        expect(mismatch.compatible).to.equal(false);
        expect(mismatch.reasons.join(' ')).to.contain('does not match');
        expect(replaceShipDesignRequiredComponent(design, core, 'NEW_REACTOR')).to.deep.equal(['NEW_REACTOR', 'SMALL_SHIELD_1', 'UNKNOWN_PART']);
        expect(replaceShipDesignRequiredComponent(design, { ...core, selected: undefined }, 'NEW_REACTOR'))
            .to.deep.equal(['CORVETTE_REACTOR', 'SMALL_SHIELD_1', 'UNKNOWN_PART', 'NEW_REACTOR']);
    });

    it('rejects fixed drop targets even when the component otherwise fits', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES));
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        const component = lookupShipDesignComponent(catalog, 'SMALL_RED_LASER');
        if (!design || !component) throw new Error('fixture design or component missing');
        const slot = buildShipDesignView(catalog, design).sections[0]?.slots[0];
        if (!slot) throw new Error('fixture slot missing');
        const result = shipDesignDropCompatibility(catalog, design, { ...slot, fixed: true }, component);
        expect(result.compatible).to.equal(false);
        expect(result.reasons).to.include('Component slot is fixed.');
    });

    it('treats a section-only hull as valid without inventing a root mesh', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES, ['gfx/models/ships/humanoid_01']));
        for (const info of catalog.base.shipSizes.values()) info.entity = undefined;
        for (const details of catalog.shipSizeDetails.values()) details.entity = undefined;
        const design = parseShipDesignDocument(DESIGN_SOURCE).designs[0];
        if (!design) throw new Error('fixture design missing');
        const view = buildShipDesignView(catalog, design);
        expect(view.model.find(node => node.kind === 'root')?.entityName).to.equal(undefined);
        expect(view.model.find(node => node.kind === 'section')?.locatorName).to.equal(undefined);
        expect(view.diagnostics.some(item => item.code === 'model-resolution')).to.equal(false);
    });

    it('marks conditional AI weights as dynamic while preserving their static base', async () => {
        const catalog = await loadShipDesignCatalog(new MemorySource(FILES, ['gfx/models/ships/humanoid_01']));
        const laser = catalog.components.get('small_red_laser');
        expect(laser?.aiWeight.base).to.equal(5);
        expect(laser?.aiWeight.dynamic).to.equal(true);
        expect(catalog.roles).to.include('gunship');
        expect(catalog.roles).to.include('artillery');
    });
});
