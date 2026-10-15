import { expect } from 'chai';
import {
    TARGETING_FIELD_FALLBACKS,
    countTargetingFields,
    extractTargetingFields,
    formatWeaponTargetingLabel,
    isTargetingRelevant,
    mergeWeaponTargetingEntries,
    parsePdxBool,
    parsePdxNumber,
    type ExtractedWeaponTargeting,
    type WeaponTargetingSourceGroup,
} from '../../extension/ai/targetWeightExtract';

/** 一段贴近原版形状的武器模板：注释、引号、嵌套 prerequisites、target_weights 都在。 */
const WEAPON_FILE = `
# vanilla 武器模板节选
shield_bulkhead_1 = {
    key = "shield_bulkhead_1"
    type = shield_bulkhead
    armor = 5
    shield = 100
}

energy_lance_1 = {
    key = "energy_lance_1"
    type = energy_lance
    size = large
    min_damage = 600
    max_damage = 1500
    accuracy = 0.85
    tracking = 0
    shield_damage = 0.5
    armor_damage = 2.0
    hull_damage = 1.5
    shield_penetration = 0.5
    armor_penetration = 0.5
    size_damage_factor = 0
    use_ship_main_target = no
    target_focus = spread
    prerequisites = {
        tech = engineering_tech_3
        level = 2
    }
    targetable_ship_sizes = {
        corvette
        cruiser
    }
    target_weights = {
        corvette = 10
        battleship = 2.5
    }
}
`;

function byId(entries: ExtractedWeaponTargeting[], id: string): ExtractedWeaponTargeting {
    const found = entries.find(entry => entry.componentId === id);
    expect(found, `expected template ${id}`).to.not.equal(undefined);
    return found!;
}

describe('Targeting field extraction from component_templates', () => {
    it('reads every section 5.2 targeting field of a weapon template', () => {
        const lance = byId(extractTargetingFields(WEAPON_FILE), 'energy_lance_1');
        expect(lance.componentType).to.equal('energy_lance');
        expect(lance.minDamage).to.equal(600);
        expect(lance.maxDamage).to.equal(1500);
        expect(lance.accuracy).to.equal(0.85);
        expect(lance.tracking).to.equal(0);
        expect(lance.shieldDamage).to.equal(0.5);
        expect(lance.armorDamage).to.equal(2);
        expect(lance.hullDamage).to.equal(1.5);
        expect(lance.shieldPenetration).to.equal(0.5);
        expect(lance.armorPenetration).to.equal(0.5);
        expect(lance.sizeDamageFactor).to.equal(0);
        expect(lance.useShipMainTarget).to.equal(false);
        expect(lance.targetWeights).to.deep.equal({ corvette: 10, battleship: 2.5 });
        expect(lance.targetableShipSizes).to.deep.equal(['corvette', 'cruiser']);
        expect(lance.dynamicKeys).to.deep.equal([]);
        expect(lance.missingKeys).to.deep.equal([]);
    });

    it('keeps reading after a nested block such as prerequisites', () => {
        const lance = byId(extractTargetingFields(WEAPON_FILE), 'energy_lance_1');
        // prerequisites 里的 level = 2 不该被误认成模板字段，target_weights 仍在其后。
        expect(lance.targetWeights.corvette).to.equal(10);
        expect(lance.line).to.be.greaterThan(1);
    });

    it('drops component templates without any targeting field', () => {
        const entries = extractTargetingFields(WEAPON_FILE);
        expect(entries.map(entry => entry.componentId)).to.deep.equal(['energy_lance_1']);
        const shield = extractTargetingFields('shield_bulkhead_1 = {\n key = "x"\n armor = 5\n}\n');
        expect(shield).to.deep.equal([]);
    });

    it('reports missing fields so the panel can label estimated values', () => {
        const minimal = byId(extractTargetingFields('laser_gun_1 = {\n min_damage = 10\n max_damage = 12\n accuracy = 0.5\n}\n'), 'laser_gun_1');
        expect(minimal.missingKeys).to.include.members(['tracking', 'hull_damage', 'shield_damage', 'armor_damage']);
        expect(minimal.missingKeys).to.not.include('min_damage');
        expect(TARGETING_FIELD_FALLBACKS.hull_damage).to.equal(1);
        expect(TARGETING_FIELD_FALLBACKS.shield_penetration).to.equal(0);
    });

    it('records script expressions instead of silently dropping them', () => {
        const dynamic = byId(
            extractTargetingFields('railgun_1 = {\n min_damage = 10\n max_damage = @[add_ship_size_laser_damage]\n accuracy = 0.7\n}\n'),
            'railgun_1',
        );
        expect(dynamic.maxDamage).to.equal(undefined);
        expect(dynamic.dynamicKeys).to.include('max_damage');
        expect(dynamic.missingKeys).to.include('max_damage');
    });

    it('normalises percentages and ignores inline comments', () => {
        const percent = byId(
            extractTargetingFields('mass_driver_1 = {\n accuracy = 50%   # 半命中\n tracking = 0.9\n}\n'),
            'mass_driver_1',
        );
        expect(percent.accuracy).to.equal(0.5);
        expect(percent.tracking).to.equal(0.9);
    });

    it('reads use_ship_main_target and target_weights written in a mod override', () => {
        const mod = byId(
            extractTargetingFields('"energy_lance_1" = {\n type = energy_lance\n min_damage = 700\n use_ship_main_target = yes\n target_weights = { corvette = 3 }\n}\n'),
            'energy_lance_1',
        );
        expect(mod.useShipMainTarget).to.equal(true);
        expect(mod.targetWeights.corvette).to.equal(3);
        expect(mod.targetableShipSizes).to.deep.equal([]);
    });

    it('merges roots so workspace templates override vanilla and output stays sorted', () => {
        const vanilla: WeaponTargetingSourceGroup = {
            source: 'vanilla',
            file: 'C:/stellaris/common/component_templates/00_weapons.txt',
            entries: [
                byId(extractTargetingFields(WEAPON_FILE), 'energy_lance_1'),
                byId(extractTargetingFields('a_laser = { min_damage = 5 max_damage = 5 }\n'), 'a_laser'),
            ],
        };
        const workspace: WeaponTargetingSourceGroup = {
            source: 'workspace',
            file: 'C:/mod/common/component_templates/zz_mod.txt',
            entries: [
                byId(extractTargetingFields('energy_lance_1 = { min_damage = 900 max_damage = 1600 }\n'), 'energy_lance_1'),
            ],
        };
        const merged = mergeWeaponTargetingEntries([vanilla, workspace]);
        expect(merged.map(entry => entry.componentId)).to.deep.equal(['a_laser', 'energy_lance_1']);
        const overridden = merged.find(entry => entry.componentId === 'energy_lance_1')!;
        expect(overridden.source).to.equal('workspace');
        expect(overridden.minDamage).to.equal(900);
        expect(formatWeaponTargetingLabel(overridden)).to.equal('energy_lance_1 [workspace]');
        expect(formatWeaponTargetingLabel(merged[0]!)).to.equal('a_laser [vanilla]');
    });

    it('parses numbers and booleans defensively', () => {
        expect(parsePdxNumber('0.85')).to.equal(0.85);
        expect(parsePdxNumber('50%')).to.equal(0.5);
        expect(parsePdxNumber('@[foo]')).to.equal(undefined);
        expect(parsePdxNumber('nope')).to.equal(undefined);
        expect(parsePdxBool('yes')).to.equal(true);
        expect(parsePdxBool('no')).to.equal(false);
        expect(parsePdxBool('maybe')).to.equal(undefined);
    });

    it('counts and gates targeting relevance for the dropdown', () => {
        const lance = byId(extractTargetingFields(WEAPON_FILE), 'energy_lance_1');
        expect(countTargetingFields(lance)).to.be.greaterThan(5);
        expect(isTargetingRelevant(lance)).to.equal(true);
        expect(isTargetingRelevant({
            componentId: 'utility_1',
            templateTypeKey: 'utility_component_template',
            line: 1,
            targetWeights: {},
            targetableShipSizes: [],
            dynamicKeys: [],
            missingKeys: [],
        })).to.equal(false);
    });


    it('uses the inner key field as the template id for the canonical type-key shape', () => {
        // 原版与绝大多数 mod 的写法：顶层键是类型键，真正的模板 id 在 key 字段里。
        const canonical = [
            'weapon_component_template = {',
            '    key = "energy_lance_1"',
            '    type = energy_lance',
            '    min_damage = 600',
            '    max_damage = 1500',
            '    accuracy = 0.85',
            '}',
            'weapon_component_template = {',
            '    key = "railgun_1"',
            '    type = railgun',
            '    min_damage = 80',
            '    max_damage = 120',
            '}',
        ].join('\n');
        const entries = extractTargetingFields(canonical);
        expect(entries.map(entry => entry.componentId)).to.deep.equal(['energy_lance_1', 'railgun_1']);
        expect(entries.every(entry => entry.templateTypeKey === 'weapon_component_template')).to.equal(true);
        expect(byId(entries, 'energy_lance_1').line).to.equal(1);
        expect(byId(entries, 'railgun_1').line).to.equal(8);
    });

    it('keeps both type-key templates when merging instead of collapsing them', () => {
        const source = [
            'weapon_component_template = { key = "energy_lance_1" min_damage = 600 max_damage = 1500 }',
            'weapon_component_template = { key = "railgun_1" min_damage = 80 max_damage = 120 }',
        ].join('\n');
        const entries = mergeWeaponTargetingEntries([{
            source: 'vanilla',
            file: 'C:/stellaris/common/component_templates/00_weapons.txt',
            entries: extractTargetingFields(source),
        }]);
        expect(entries.map(entry => entry.componentId)).to.deep.equal(['energy_lance_1', 'railgun_1']);
    });

    it('falls back to the top-level key when the template has no key field', () => {
        const legacy = byId(extractTargetingFields('laser_gun_1 = { min_damage = 10 max_damage = 12 }\n'), 'laser_gun_1');
        expect(legacy.componentId).to.equal('laser_gun_1');
        expect(formatWeaponTargetingLabel({
            ...legacy,
            file: 'C:/stellaris/common/component_templates/00_weapons.txt',
            source: 'vanilla',
        })).to.equal('laser_gun_1 [vanilla]');
    });
});
