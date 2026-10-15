import { expect } from 'chai';
import {
    TARGETING_FIELD_FALLBACKS,
    countTargetingFields,
    defaultWeaponInput,
    extractShipSizeIds,
    extractTargetingFields,
    findComponentTemplateIdAtLine,
    formatComponentDisplayLabel,
    formatWeaponTargetingLabel,
    isGenericTemplateTypeKey,
    isTargetingRelevant,
    mergeComputeWeaponInput,
    applyCsvWeaponStats,
    extractShipSizeDetails,
    mergeCsvStatMaps,
    mergeScriptedVariables,
    mergeShipSizeDetails,
    mergeShipSizeIds,
    mergeWeaponTargetingEntries,
    parsePdxBool,
    parsePdxNumber,
    parseScriptedVariables,
    parseWeaponComponentsCsv,
    readTopLevelBlocks,
    toDisplayLocalisationValue,
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
            csvKeys: [],
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

    it('falls back to the top-level key only for non-type-key templates', () => {
        const legacy = byId(extractTargetingFields('laser_gun_1 = { min_damage = 10 max_damage = 12 }\n'), 'laser_gun_1');
        expect(legacy.componentId).to.equal('laser_gun_1');
        expect(formatWeaponTargetingLabel({
            ...legacy,
            file: 'C:/stellaris/common/component_templates/00_weapons.txt',
            source: 'vanilla',
        })).to.equal('laser_gun_1 [vanilla]');
    });
});
/**
 * 面板实测反馈第 4 点：类型键块缺内层 \`key\` 时曾回退成裸 \`weapon_component_template\`
 * 条目，出现在武器下拉最上方；引擎按 name_field 取名，这类块（以及注释样例块）根本不是模板。
 */
describe('Component template id fallback', () => {
    it('drops a type-key block that has no inner key field', () => {
        const text = [
            'weapon_component_template = {',
            '    type = instant',
            '    min_damage = 600',
            '    max_damage = 1500',
            '    accuracy = 0.85',
            '}',
        ].join('\n');
        expect(extractTargetingFields(text)).to.deep.equal([]);
    });

    it('drops every key-less type-key shape, including starbase', () => {
        expect(isGenericTemplateTypeKey('weapon_component_template')).to.equal(true);
        expect(isGenericTemplateTypeKey('utility_component_template')).to.equal(true);
        expect(isGenericTemplateTypeKey('starbase')).to.equal(true);
        expect(isGenericTemplateTypeKey('energy_lance_1')).to.equal(false);
        expect(extractTargetingFields('starbase = { min_damage = 10 tracking = 1 }\n')).to.deep.equal([]);
        expect(extractTargetingFields('utility_component_template = { tracking = 1 }\n')).to.deep.equal([]);
    });

    it('ignores commented sample blocks that never become bare entries', () => {
        const sample = [
            '# weapon_component_template = {',
            '#   key = "EXAMPLE"',
            '#   min_damage = 1',
            '#}',
            '#corvette = { min_damage = 2 }',
            '',
        ].join('\n');
        expect(extractTargetingFields(sample)).to.deep.equal([]);
    });

    it('keeps the canonical type-key template and the legacy id-named one side by side', () => {
        const text = [
            'weapon_component_template = { key = "energy_lance_1" min_damage = 600 max_damage = 1500 }',
            'weapon_component_template = { type = instant tracking = 1 }',
            'laser_gun_1 = { min_damage = 10 max_damage = 12 }',
        ].join('\n');
        expect(extractTargetingFields(text).map(entry => entry.componentId))
            .to.deep.equal(['energy_lance_1', 'laser_gun_1']);
    });
});

describe('Cursor line to component template id', () => {
    const FILE = [
        'weapon_component_template = {',        // 1
        '    key = "SMALL_RED_LASER"',           // 2
        '    min_damage = 10',                   // 3
        '}',                                     // 4
        'laser_gun_1 = {',                       // 5
        '    max_damage = 12',                   // 6
        '}',                                     // 7
        'weapon_component_template = {',         // 8
        '    tracking = 1',                      // 9
        '}',                                     // 10
    ].join('\n');

    it('finds the inner key of the block containing the cursor', () => {
        expect(findComponentTemplateIdAtLine(FILE, 1)).to.equal('SMALL_RED_LASER');
        expect(findComponentTemplateIdAtLine(FILE, 3)).to.equal('SMALL_RED_LASER');
        expect(findComponentTemplateIdAtLine(FILE, 4)).to.equal('SMALL_RED_LASER');
    });

    it('uses the top-level key for the legacy id-named shape', () => {
        expect(findComponentTemplateIdAtLine(FILE, 6)).to.equal('laser_gun_1');
    });

    it('returns undefined for a key-less type-key block and for lines outside any block', () => {
        expect(findComponentTemplateIdAtLine(FILE, 9)).to.equal(undefined);
        expect(findComponentTemplateIdAtLine(FILE, 0)).to.equal(undefined);
        expect(findComponentTemplateIdAtLine(FILE, Number.NaN)).to.equal(undefined);
    });
});

describe('Top level block scanning', () => {
    it('reads only top-level id = { blocks and skips comments and nesting', () => {
        const text = [
            '# corvette = { min_damage = 1 }',
            'corvette = {',
            '    nested = { key = "NOT_A_SIZE" }',
            '}',
            '"destroyer" = { max_hitpoints = 100 }',
            'ignored_scalar = 3',
        ].join('\n');
        const blocks = readTopLevelBlocks(text);
        expect(blocks.map(block => block.id)).to.deep.equal(['corvette', 'destroyer']);
        expect(blocks[0]!.key).to.equal(undefined);
        expect(blocks[0]!.line).to.equal(2);
        expect(blocks[0]!.endLine).to.equal(4);
    });
});

describe('Ship size collection', () => {
    const SHIP_SIZE_FILE = [
        '# 舰船尺寸定义：顶层键就是 ship_size id',
        '# corvette = { commented_out = yes }',
        'corvette = {',
        '    max_hitpoints = 240',
        '    size_multiplier = 1',
        '}',
        '',
        'cruiser = { max_hitpoints = 600 }',
        '   # 缩进的注释行同样不算块',
        'battleship = { max_hitpoints = 2400 }',
        'corvette = { max_hitpoints = 260 }',
    ].join('\n');

    it('collects top-level ids in document order and dedupes within the file', () => {
        expect(extractShipSizeIds(SHIP_SIZE_FILE)).to.deep.equal(['corvette', 'cruiser', 'battleship']);
    });

    it('returns an empty list for a file without any top-level block', () => {
        expect(extractShipSizeIds('# only comments here\n')).to.deep.equal([]);
    });

    it('merges roots deterministically and dedupes across files', () => {
        const merged = mergeShipSizeIds([
            { source: 'vanilla', file: 'C:/g/common/ship_sizes/00_ship_sizes.txt', ids: ['cruiser', 'corvette'] },
            { source: 'vanilla', file: 'C:/g/common/ship_sizes/01_colossi.txt', ids: [' colossus ', 'cruiser'] },
            { source: 'workspace', file: 'C:/mod/common/ship_sizes/my_size.txt', ids: ['my_size'] },
        ]);
        expect(merged).to.deep.equal(['colossus', 'corvette', 'cruiser', 'my_size']);
        expect(mergeShipSizeIds([])).to.deep.equal([]);
    });
});

describe('Localised display label fallback', () => {
    it('shows name (id) when the component key has a localised value', () => {
        expect(formatComponentDisplayLabel('SMALL_RED_LASER', 'Small Red Laser'))
            .to.equal('Small Red Laser (SMALL_RED_LASER)');
    });

    it('falls back to the bare id without a localised value', () => {
        expect(formatComponentDisplayLabel('MOD_ONLY_WEAPON')).to.equal('MOD_ONLY_WEAPON');
        expect(formatComponentDisplayLabel('MOD_ONLY_WEAPON', undefined)).to.equal('MOD_ONLY_WEAPON');
        expect(formatComponentDisplayLabel('MOD_ONLY_WEAPON', '')).to.equal('MOD_ONLY_WEAPON');
        expect(formatComponentDisplayLabel('MOD_ONLY_WEAPON', '   ')).to.equal('MOD_ONLY_WEAPON');
    });

    it('does not repeat the id when the localised value equals it', () => {
        expect(formatComponentDisplayLabel('AUTO_SAVE', 'AUTO_SAVE')).to.equal('AUTO_SAVE');
    });

    it('strips Paradox rich text so the label stays one readable line', () => {
        expect(toDisplayLocalisationValue('$£ship_size_1$£Red Laser')).to.equal('Red Laser');
        expect(toDisplayLocalisationValue('§Y$Cruiser§!')).to.equal('Cruiser');
        expect(toDisplayLocalisationValue('[Starbase]  Outpost')).to.equal('Outpost');
        expect(toDisplayLocalisationValue('  Spaced   Value ')).to.equal('Spaced Value');
        expect(toDisplayLocalisationValue('$£icon$£')).to.equal(undefined);
        expect(toDisplayLocalisationValue(undefined)).to.equal(undefined);
    });
});

describe('Compute weapon input without a template', () => {
    it('falls back to the estimated defaults when no template is selected', () => {
        const merged = mergeComputeWeaponInput(undefined, undefined);
        expect(merged.minDamage).to.equal(TARGETING_FIELD_FALLBACKS.min_damage);
        expect(merged.hullDamage).to.equal(TARGETING_FIELD_FALLBACKS.hull_damage);
        expect(merged.targetWeights).to.deep.equal({});
        expect(merged).to.deep.equal(defaultWeaponInput());
    });

    it('lets manual edits override the template and drops unusable numbers', () => {
        const template = {
            ...defaultWeaponInput(),
            minDamage: 600,
            maxDamage: 1500,
            accuracy: 0.85,
            targetWeights: { corvette: 10 },
        };
        const merged = mergeComputeWeaponInput(template, {
            accuracy: 0.5,
            minDamage: Number.NaN,
            tracking: 'not a number',
            targetWeights: { battleship: 2.5, broken: Number.POSITIVE_INFINITY, '  frigate ': 1 },
        });
        expect(merged.minDamage).to.equal(600);
        expect(merged.maxDamage).to.equal(1500);
        expect(merged.accuracy).to.equal(0.5);
        expect(merged.tracking).to.equal(TARGETING_FIELD_FALLBACKS.tracking);
        expect(merged.targetWeights).to.deep.equal({ frigate: 1, battleship: 2.5 });
    });

    it('keeps the template target_weights when the webview sends none', () => {
        const template = { ...defaultWeaponInput(), targetWeights: { corvette: 10 } };
        expect(mergeComputeWeaponInput(template, { accuracy: 0.4 }).targetWeights).to.deep.equal({ corvette: 10 });
        expect(mergeComputeWeaponInput(template, { targetWeights: 'corrupted' }).targetWeights).to.deep.equal({ corvette: 10 });
    });
});

describe('weapon_components.csv parsing', () => {
    // vanilla 表头：key;cost;power;min_damage;max_damage;hull_damage;shield_damage;shield_penetration;armor_damage;armor_penetration;min_windup;max_windup;cooldown;range;accuracy;tracking;size_damage_factor;military_power_multiplier;end
    const CSV = [
        '# comment row;;;;;;;;',
        'key;cost;power;min_damage;max_damage;hull_damage;shield_damage;shield_penetration;armor_damage;armor_penetration;min_windup;max_windup;cooldown;range;accuracy;tracking;size_damage_factor;military_power_multiplier;end',
        'ENERGY_LANCE_1;250.00;-200.00;600.00;1500.00;1.50;0.50;0.00;2.00;0.00;12.00;47.00;70.00;150.00;0.85;0.00;0.00;1.00;',
        'SMALL_RED_LASER;10.00;-5.00;6.00;16.00;1.25;0.50;0.00;1.50;0.00;5.00;20.00;30.00;40.00;0.90;0.50;0.00;1.00;',
    ].join('\n');

    it('maps columns by the header row and skips comments', () => {
        const rows = parseWeaponComponentsCsv(CSV);
        const lance = rows.get('ENERGY_LANCE_1')!;
        expect(lance.min_damage).to.equal(600);
        expect(lance.max_damage).to.equal(1500);
        expect(lance.hull_damage).to.equal(1.5);
        expect(lance.shield_damage).to.equal(0.5);
        expect(lance.armor_damage).to.equal(2);
        expect(lance.accuracy).to.equal(0.85);
        expect(lance.tracking).to.equal(0);
        expect(rows.get('SMALL_RED_LASER')!.tracking).to.equal(0.5);
        expect(rows.size).to.equal(2);
    });

    it('tolerates partial headers and header-less files', () => {
        const rows = parseWeaponComponentsCsv('key;min_damage;max_damage;end\nW;1;2;');
        expect(rows.get('W')).to.deep.equal({ min_damage: 1, max_damage: 2 });
        expect(parseWeaponComponentsCsv('# only comments\n;;;').size).to.equal(0);
    });

    it('fills gaps from csv, keeps explicit txt fields, re-keys missing, matches uppercase', () => {
        const entry = extractTargetingFields([
            'weapon_component_template = {',
            '    key = "test_gun"',
            '    accuracy = 0.95',
            '    tracking = 0.4',
            '}',
        ].join('\n'))[0]!;
        expect(entry.missingKeys).to.include('min_damage');
        const csv = parseWeaponComponentsCsv('key;min_damage;max_damage;accuracy;end\nTEST_GUN;100;200;0.10;');
        applyCsvWeaponStats(entry, csv);
        expect(entry.minDamage).to.equal(100);
        expect(entry.maxDamage).to.equal(200);
        expect(entry.accuracy).to.equal(0.95); // txt 显式值优先
        expect(entry.csvKeys).to.have.members(['min_damage', 'max_damage']);
        expect(entry.missingKeys).to.not.include('min_damage');
        expect(entry.missingKeys).to.include('shield_damage');
    });

    it('workspace csv overrides vanilla regardless of argument order', () => {
        const vanilla = { source: 'vanilla' as const, file: 'v.csv', stats: new Map([['GUN', { min_damage: 1 }]]) };
        const workspace = { source: 'workspace' as const, file: 'w.csv', stats: new Map([['GUN', { min_damage: 9 }]]) };
        expect(mergeCsvStatMaps([vanilla, workspace]).get('GUN')!.min_damage).to.equal(9);
        expect(mergeCsvStatMaps([workspace, vanilla]).get('GUN')!.min_damage).to.equal(9);
    });
});

describe('scripted variables and ship size details', () => {
    const vars = mergeScriptedVariables([
        { source: 'vanilla' as const, vars: parseScriptedVariables([
            '# comment',
            '@corvette_size_multiplier = 5',
            '@corvette_hp = 200',
            '@corvette_evasion = 60',
            '@shared_var = 1',
        ].join('\n')) },
        { source: 'workspace' as const, vars: parseScriptedVariables('@shared_var = 99') },
    ]);

    it('parses @name = number lines and merges with workspace override', () => {
        expect(vars.get('corvette_size_multiplier')).to.equal(5);
        expect(vars.get('shared_var')).to.equal(99); // 工作区覆盖
    });

    it('extracts size_multiplier / max_hitpoints / nested ship_evasion_add with @var resolution', () => {
        const details = extractShipSizeDetails([
            'corvette = {',
            '    max_speed = 250',
            '    max_hitpoints = @corvette_hp',
            '    size_multiplier = @corvette_size_multiplier',
            '    modifier = {',
            '        ship_evasion_add = @corvette_evasion',
            '        trigger = {',
            '            nested = { deep = yes }',
            '        }',
            '    }',
            '}',
            'custom_size = {',
            '    size_multiplier = 12',
            '    max_hitpoints = 5000',
            '    modifier = { ship_evasion_add = 2.5 }',
            '}',
            'broken_size = {',
            '    size_multiplier = @missing_var',
            '}',
        ].join('\n'), vars);
        const corvette = details.find(d => d.id === 'corvette')!;
        expect(corvette.sizeMultiplier).to.equal(5);
        expect(corvette.maxHitpoints).to.equal(200);
        expect(corvette.evasionPercent).to.equal(60);
        const custom = details.find(d => d.id === 'custom_size')!;
        expect(custom.sizeMultiplier).to.equal(12);
        expect(custom.evasionPercent).to.equal(2.5);
        expect(details.find(d => d.id === 'broken_size')!.sizeMultiplier).to.equal(undefined);
    });

    it('merges ship size details with workspace override and sorted output', () => {
        const merged = mergeShipSizeDetails([
            { source: 'vanilla' as const, file: 'v.txt', entries: [{ id: 'corvette', line: 1, sizeMultiplier: 5 }] },
            { source: 'workspace' as const, file: 'w.txt', entries: [{ id: 'corvette', line: 9, sizeMultiplier: 7 }, { id: 'aaa_custom', line: 3 }] },
        ]);
        expect(merged.find(d => d.id === 'corvette')!.sizeMultiplier).to.equal(7);
        expect(merged.map(d => d.id)).to.deep.equal(['aaa_custom', 'corvette']);
    });
});
