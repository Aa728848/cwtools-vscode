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
    buildInlineScriptRegistry,
    collectLocalisationReferences,
    evaluateInlineExpression,
    expandInlineScriptFields,
    extractShipSizeDetails,
    mergeCsvStatMaps,
    mergeScriptedVariables,
    mergeShipSizeDetails,
    mergeShipSizeIds,
    mergeWeaponTargetingEntries,
    normalizeInlineScriptKey,
    parseInlineScriptTemplate,
    parsePdxBool,
    parsePdxNumber,
    parseScriptedVariables,
    parseWeaponComponentsCsv,
    readTopLevelBlocks,
    resolveLocalisationReferences,
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

// ── inline_script 展开 ──

/** Kuat 模组式写法：战斗数值全部走 inline_script 参数，顶层只剩穿透与标签。 */
const INLINE_SCRIPT_FILE = [
    'key = $KEY$',
    'icon = $ICON$',
    'size = $SIZE$',
    'type = $WEAPON_TYPE$',
    'power = @[ 3 * $MULT$ * -1 ]',
    'damage = {',
    '    min = @[ standard_tuberlazer_damage_1 * $MULT$ ]',
    '    max = @[ standard_tuberlazer_damage_1 * $MULT$ ]',
    '}',
    'accuracy = $ACCURACY$',
    'tracking = $TRACKING$',
    'inline_script = {',
    '    script = kuat_weapon_event/$INLINE$',
    '    MULT = $MULT$',
    '    RANGE = $RANGE$',
    '}',
    'military_power_multiplier = 0.1',
].join('\n');

const INLINE_COMPONENT_FILE = [
    'weapon_component_template = {',
    '    inline_script = {',
    '        script = kuat_utllities_component/kuat_component_weapon_artellarys',
    '        KEY = "ED_LARGE_HEAVY_TURBO_3_G"',
    '        SIZE = large',
    '        WEAPON_TYPE = instant',
    '        MULT = 6',
    '        RANGE = 300',
    '        ACCURACY = 0.75',
    '        TRACKING = 0.50',
    '    }',
    '    target_type = target_enemies',
    '    shield_penetration = 1',
    '    armor_penetration = 1',
    '}',
    '',
    'weapon_component_template = {',
    '    inline_script = {',
    '        script = missing/script',
    '        KEY = "GHOST"',
    '    }',
    '}',
    '',
    'utility_component_template = {',
    '    inline_script = {',
    '        script = kuat_utllities_component/kuat_component_shield',
    '        KEY = "KUAT_SHIELD_1"',
    '        SHIELD = 500',
    '    }',
    '}',
].join('\n');

const INLINE_VARS = new Map<string, number>([['standard_tuberlazer_damage_1', 40]]);

function inlineRegistry() {
    return buildInlineScriptRegistry([
        { source: 'vanilla' as const, file: 'kuat_utllities_component/kuat_component_weapon_artellarys', template: parseInlineScriptTemplate(INLINE_SCRIPT_FILE) },
        { source: 'vanilla' as const, file: 'kuat_utllities_component/kuat_component_shield', template: parseInlineScriptTemplate('key = $KEY$\nshield_hit_points = $SHIELD$') },
    ]);
}

describe('inline_script template parsing', () => {
    it('binds top-level fields and damage min/max, skipping nested inline_script blocks', () => {
        const template = parseInlineScriptTemplate(INLINE_SCRIPT_FILE);
        expect(template.bindings.get('key')).to.equal('$KEY$');
        expect(template.bindings.get('type')).to.equal('$WEAPON_TYPE$');
        expect(template.bindings.get('accuracy')).to.equal('$ACCURACY$');
        expect(template.bindings.get('min_damage')).to.equal('@[ standard_tuberlazer_damage_1 * $MULT$ ]');
        expect(template.bindings.get('max_damage')).to.equal('@[ standard_tuberlazer_damage_1 * $MULT$ ]');
        // 嵌套 inline_script 里的 MULT/RANGE 不是顶层字段绑定，而是作为嵌套调用记录。
        expect(template.bindings.has('range')).to.equal(false);
        expect(template.bindings.has('mult')).to.equal(false);
        expect(template.nested.length).to.equal(1);
        expect(template.nested[0]!.script).to.equal('kuat_weapon_event/$INLINE$');
        expect(template.nested[0]!.params.get('mult')).to.equal('$MULT$');
    });

    it('captures single-line nested inline calls', () => {
        const template = parseInlineScriptTemplate('accuracy = $ACC$\ninline_script = { script = a/b_$X$ k = $Y$ }');
        expect(template.nested.length).to.equal(1);
        expect(template.nested[0]!.script).to.equal('a/b_$X$');
        expect(template.nested[0]!.params.get('k')).to.equal('$Y$');
        expect(template.bindings.get('accuracy')).to.equal('$ACC$');
    });

    it('normalizes script keys across separators, extensions and case', () => {
        expect(normalizeInlineScriptKey('Kuat\\\\weapon_art.TXT')).to.equal('kuat/weapon_art');
        expect(normalizeInlineScriptKey('kuat/weapon_art')).to.equal('kuat/weapon_art');
        expect(normalizeInlineScriptKey('/kuat/weapon_art/')).to.equal('kuat/weapon_art');
    });
});

describe('inline expression evaluation', () => {
    it('evaluates numbers, percents, params, variables and arithmetic', () => {
        const params = new Map<string, string>([['mult', '6'], ['chained', '$mult$']]);
        const vars = new Map<string, number>([['base_damage', 40]]);
        expect(evaluateInlineExpression('6', params, vars)).to.equal(6);
        expect(evaluateInlineExpression('50%', params, vars)).to.equal(0.5);
        expect(evaluateInlineExpression('$MULT$', params, vars)).to.equal(6);
        expect(evaluateInlineExpression('$CHAINED$', params, vars)).to.equal(6);
        expect(evaluateInlineExpression('@[ base_damage * $MULT$ ]', params, vars)).to.equal(240);
        expect(evaluateInlineExpression('@[ 2 + 3 * 4 ]', params, vars)).to.equal(14);
        expect(evaluateInlineExpression('@[ (2 + 3) * 4 ]', params, vars)).to.equal(20);
        expect(evaluateInlineExpression('@[ -$MULT$ / 2 ]', params, vars)).to.equal(-3);
        expect(evaluateInlineExpression('@base_damage', params, vars)).to.equal(40);
    });

    it('returns undefined for unresolvable input instead of throwing', () => {
        const params = new Map<string, string>([['a', '$b$'], ['b', '$a$']]);
        const vars = new Map<string, number>();
        expect(evaluateInlineExpression('@[ 10 / 0 ]', params, vars)).to.equal(undefined);
        expect(evaluateInlineExpression('@[ unknown_var * 2 ]', params, vars)).to.equal(undefined);
        expect(evaluateInlineExpression('$MISSING$', params, vars)).to.equal(undefined);
        expect(evaluateInlineExpression('@[ 1 + ]', params, vars)).to.equal(undefined);
        // 参数成环：深度上限兜底，不抛不挂。
        expect(evaluateInlineExpression('$A$', params, vars)).to.equal(undefined);
    });
});

describe('inline_script field expansion', () => {
    it('fills id, type and targeting fields from inline params and script bindings', () => {
        const entries = extractTargetingFields(INLINE_COMPONENT_FILE);
        // 三个块都带 inline 调用：全部挺过提取门槛，id 待展开回填。
        expect(entries.length).to.equal(3);
        expect(entries.every(entry => entry.componentId === '')).to.equal(true);

        for (const entry of entries) expandInlineScriptFields(entry, inlineRegistry(), INLINE_VARS);
        const weapon = entries.find(entry => entry.componentId === 'ED_LARGE_HEAVY_TURBO_3_G');
        expect(weapon, 'weapon resolved from inline KEY').to.not.equal(undefined);
        expect(weapon!.componentType).to.equal('instant');
        expect(weapon!.accuracy).to.equal(0.75);
        expect(weapon!.tracking).to.equal(0.5);
        expect(weapon!.minDamage).to.equal(240);
        expect(weapon!.maxDamage).to.equal(240);
        // 顶层显式值优先：inline 脚本若也绑 shield_penetration 不会覆盖 1。
        expect(weapon!.shieldPenetration).to.equal(1);
        expect(weapon!.armorPenetration).to.equal(1);
        expect(weapon!.missingKeys).to.not.include('accuracy');
        expect(weapon!.missingKeys).to.not.include('min_damage');
        expect(weapon!.missingKeys).to.include('hull_damage');

        // 面板过滤视角：id 缺失或展开后仍不含索敌字段的块不进下拉。
        const kept = entries.filter(entry => entry.componentId !== '' && isTargetingRelevant(entry));
        expect(kept.map(entry => entry.componentId)).to.deep.equal(['ED_LARGE_HEAVY_TURBO_3_G']);
    });

    it('expands one level of nested inline calls with param passthrough and composed names', () => {
        const component = [
            'weapon_component_template = {',
            '    inline_script = {',
            '        script = components/kuat_template_common_weapon',
            '        kuat_index = ETM',
            '        kuat_weapon_type = laser',
            '        kuat_weapon_name = ION',
            '        kuat_size = small',
            '        kuat_component_type = standard',
            '        kuat_mutation_weapon_fixup = no',
            '    }',
            '}',
        ].join('\n');
        const mainTemplate = [
            'key = kuat_$kuat_index$_$kuat_weapon_name$_$kuat_size$',
            'accuracy = @kuat_$kuat_index$_$kuat_weapon_type$_accuracy',
            'inline_script = {',
            '    script = components/kuat_mutation_weapon_damage_fixup_$kuat_mutation_weapon_fixup$',
            '    kuat_index = $kuat_index$',
            '    kuat_weapon_type = $kuat_weapon_type$',
            '    kuat_weapon_name = $kuat_weapon_name$',
            '    kuat_component_type = $kuat_component_type$',
            '    kuat_size = $kuat_size$',
            '}',
        ].join('\n');
        const fixupTemplate = [
            'damage = {',
            '    min = @[ kuat_$kuat_index$_$kuat_weapon_type$_damage_min * kuat_$kuat_size$_factor ]',
            '    max = @[ kuat_$kuat_index$_$kuat_weapon_type$_damage_max * kuat_$kuat_size$_factor ]',
            '}',
        ].join('\n');
        const registry = buildInlineScriptRegistry([
            { source: 'workspace' as const, file: 'components/kuat_template_common_weapon', template: parseInlineScriptTemplate(mainTemplate) },
            { source: 'workspace' as const, file: 'components/kuat_mutation_weapon_damage_fixup_no', template: parseInlineScriptTemplate(fixupTemplate) },
        ]);
        const vars = new Map<string, number>([
            ['kuat_ETM_laser_accuracy', 0.9],
            ['kuat_ETM_laser_damage_min', 10],
            ['kuat_ETM_laser_damage_max', 20],
            ['kuat_small_factor', 2],
        ]);
        const [entry] = extractTargetingFields(component);
        expandInlineScriptFields(entry!, registry, vars);
        expect(entry!.componentId).to.equal('kuat_ETM_ION_small');
        expect(entry!.accuracy).to.equal(0.9);
        expect(entry!.minDamage).to.equal(20);
        expect(entry!.maxDamage).to.equal(40);
        expect(entry!.missingKeys).to.not.include('min_damage');
    });

    it('marks unresolvable expressions as dynamic and keeps them missing', () => {
        const file = [
            'weapon_component_template = {',
            '    inline_script = { script = a/b  KEY = "X"  MULT = 2 }',
            '}',
        ].join('\n');
        const registry = buildInlineScriptRegistry([{
            source: 'workspace' as const,
            file: 'a/b',
            template: parseInlineScriptTemplate('key = $KEY$\ndamage = {\n    min = @[ unknown_var * $MULT$ ]\n    max = 10\n}\naccuracy = $ACC$'),
        }]);
        const [entry] = extractTargetingFields(file);
        expandInlineScriptFields(entry!, registry, new Map());
        expect(entry!.componentId).to.equal('X');
        expect(entry!.maxDamage).to.equal(10);
        expect(entry!.minDamage).to.equal(undefined);
        expect(entry!.dynamicKeys).to.include('min_damage');
        expect(entry!.dynamicKeys).to.include('accuracy');
        expect(entry!.missingKeys).to.include('min_damage');
    });
});

describe('localisation reference resolution', () => {
    it('collects unique $ref$ keys in order', () => {
        expect(collectLocalisationReferences('$a$ and $b$ again $a$')).to.deep.equal(['a', 'b']);
        expect(collectLocalisationReferences('plain text')).to.deep.equal([]);
    });

    it('resolves nested reference chains', () => {
        const table: Record<string, string | undefined> = {
            military_arkship_tier_1: '$military_arkship_name$ I',
            military_arkship_name: '$military_arkship_class$ $arkship_cap$',
            military_arkship_class: 'Military Arkship',
            arkship_cap: 'I',
        };
        const lookup = (key: string) => table[key];
        expect(resolveLocalisationReferences(table['military_arkship_tier_1']!, lookup))
            .to.equal('Military Arkship I I');
    });

    it('keeps unknown keys and survives reference cycles', () => {
        expect(resolveLocalisationReferences('$nope$ x', () => undefined)).to.equal('$nope$ x');
        const cyclic: Record<string, string> = { a: '$b$', b: '$a$' };
        const resolved = resolveLocalisationReferences('$a$', key => cyclic[key]);
        expect(resolved.includes('$')).to.equal(true); // 残留引用由 $ 护栏回退 id
    });

    it('guard: unresolved $ref$ falls back to id, markup junk still cleaned', () => {
        expect(toDisplayLocalisationValue('$military_arkship_name$ I')).to.equal(undefined);
        expect(toDisplayLocalisationValue('$£icon$£Red Laser')).to.equal('Red Laser');
        expect(toDisplayLocalisationValue('§Y$Cruiser§!')).to.equal('Cruiser');
        expect(formatComponentDisplayLabel('military_arkship_tier_1', '$military_arkship_name$ I'))
            .to.equal('military_arkship_tier_1');
        expect(formatComponentDisplayLabel('military_arkship_tier_1', 'Military Arkship I'))
            .to.equal('Military Arkship I (military_arkship_tier_1)');
    });
});
