/**
 * 从 Stellaris `common/component_templates/*.txt` 中静态提取索敌相关字段（纯函数）。
 *
 * 对应 docs/stellaris-targeting-weight-4.5.2.md §5.2 的武器组件模板字段表：
 * min_damage / max_damage / accuracy / tracking / hull_damage / shield_damage /
 * armor_damage / shield_penetration / armor_penetration / size_damage_factor /
 * use_ship_main_target / target_weights。
 *
 * 本模块刻意不 import vscode / fs / path，只做「文本 → 结构化字段」，
 * 文件枚举与读取一律留在 Extension Host（targetWeightPanel.ts）。
 */
import { tokenize, TokenType, type Token } from '../pdxTokenizer';

/** 索敌公式里真正会读到的武器字段（对应 targetingWeights.ts 的 TargetingWeaponInput）。 */
export interface ExtractedWeaponTargeting {
    /** 模板 id：优先取块内的 `key = "…"`，缺失时退回顶层键。 */
    componentId: string;
    /**
     * 顶层声明键。Stellaris 的规范形状是
     * `weapon_component_template = { key = "energy_lance_1" … }`：
     * 顶层键是类型键，真正的模板 id 在 `key` 字段里（见 components_consolidated.cwt
     * 的 `type[component_template] = { name_field = "key" }`）。
     */
    templateTypeKey: string;
    /** 模板 `type`，例如 `energy_lance`。 */
    componentType?: string;
    /** 模板块 key 所在的 1 基行号，用于回跳源文件。 */
    line: number;
    minDamage?: number;
    maxDamage?: number;
    accuracy?: number;
    tracking?: number;
    hullDamage?: number;
    shieldDamage?: number;
    armorDamage?: number;
    shieldPenetration?: number;
    armorPenetration?: number;
    sizeDamageFactor?: number;
    /** use_ship_main_target：缺省即 false（武器层分数自选目标）。 */
    useShipMainTarget?: boolean;
    /** target_weights 表：键为 ship_size id，值为加法项 wk。 */
    targetWeights: Record<string, number>;
    /** targetable_ship_sizes 表：候选过滤。 */
    targetableShipSizes: string[];
    /** 用 @[...] 脚本表达式书写、静态无法求值的字段。 */
    dynamicKeys: string[];
    /** 模板里完全没有出现的公式字段。 */
    missingKeys: string[];
}

/** 参与分析的数值字段；missingKeys 也按这个顺序汇报。 */
export const TARGETING_NUMERIC_FIELDS = [
    'min_damage',
    'max_damage',
    'accuracy',
    'tracking',
    'hull_damage',
    'shield_damage',
    'armor_damage',
    'shield_penetration',
    'armor_penetration',
    'size_damage_factor',
] as const;

export type TargetingNumericField = typeof TARGETING_NUMERIC_FIELDS[number];

/**
 * 模板缺字段时用于估算的缺省值。引擎侧的模板默认未在脚本层声明，
 * 面板必须显式告诉用户「这一项是估算值」而不是假装它来自模板。
 */
export const TARGETING_FIELD_FALLBACKS: Record<TargetingNumericField, number> = {
    min_damage: 0,
    max_damage: 0,
    accuracy: 0,
    tracking: 0,
    hull_damage: 1,
    shield_damage: 1,
    armor_damage: 1,
    shield_penetration: 0,
    armor_penetration: 0,
    size_damage_factor: 0,
};

/** 模板键（snake_case）→ 提取结果字段（camelCase）；missingKeys 仍按模板键汇报。 */
const FIELD_BY_TEMPLATE_KEY: Readonly<Record<TargetingNumericField, keyof ExtractedWeaponTargeting>> = {
    min_damage: 'minDamage',
    max_damage: 'maxDamage',
    accuracy: 'accuracy',
    tracking: 'tracking',
    hull_damage: 'hullDamage',
    shield_damage: 'shieldDamage',
    armor_damage: 'armorDamage',
    shield_penetration: 'shieldPenetration',
    armor_penetration: 'armorPenetration',
    size_damage_factor: 'sizeDamageFactor',
};

const NUMERIC_KEY_SET: ReadonlySet<string> = new Set(Object.keys(FIELD_BY_TEMPLATE_KEY));

/** 规范形状里承载模板 id 的字段（type[component_template].name_field）。 */
const COMPONENT_ID_KEY = 'key';

/** 列表型块：值为 ship_size → number，或裸 ship_size 列表。 */
const TARGET_WEIGHTS_KEY = 'target_weights';
const TARGETABLE_SIZES_KEY = 'targetable_ship_sizes';
const USE_SHIP_MAIN_TARGET_KEY = 'use_ship_main_target';
const COMPONENT_TYPE_KEY = 'type';

function isAtom(token: Token | undefined): boolean {
    return token?.type === TokenType.Identifier
        || token?.type === TokenType.String
        || token?.type === TokenType.Number;
}

/** `50%` 归一化为 0.5；`@[...]` 表达式返回 undefined（静态不可求值）。 */
export function parsePdxNumber(raw: string): number | undefined {
    const value = raw.trim();
    if (!value || value.startsWith('@')) return undefined;
    const isPercent = value.endsWith('%');
    const numeric = Number.parseFloat(isPercent ? value.slice(0, -1) : value);
    if (!Number.isFinite(numeric)) return undefined;
    return isPercent ? numeric / 100 : numeric;
}

export function parsePdxBool(raw: string): boolean | undefined {
    const value = raw.trim().toLowerCase();
    if (value === 'yes' || value === 'true') return true;
    if (value === 'no' || value === 'false') return false;
    return undefined;
}

function setNumeric(
    fields: ExtractedWeaponTargeting,
    key: TargetingNumericField,
    raw: string,
): void {
    const parsed = parsePdxNumber(raw);
    if (parsed === undefined) {
        // @[...] 表达式：引擎在运行时求值，面板无法静态复算。
        if (raw.trim().startsWith('@')) fields.dynamicKeys.push(key);
        return;
    }
    (fields as unknown as Record<string, number>)[FIELD_BY_TEMPLATE_KEY[key]] = parsed;
}

/** 该数值字段是否已经从模板里静态取到值。 */
function hasNumericField(fields: ExtractedWeaponTargeting, field: TargetingNumericField): boolean {
    return (fields as unknown as Record<string, unknown>)[FIELD_BY_TEMPLATE_KEY[field]] !== undefined;
}

/** 就地跳过 tokens[i] 之后的整个 `{ ... }` 子树，返回右花括号之后的下标。 */
function skipBlock(tokens: Token[], openIndex: number): number {
    let depth = 0;
    let index = openIndex;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.LBrace) depth++;
        else if (token.type === TokenType.RBrace) {
            depth--;
            if (depth === 0) return index + 1;
        } else if (token.type === TokenType.EOF) {
            return index;
        }
        index++;
    }
    return index;
}

/**
 * 读取 `target_weights = { … }` / `targetable_ship_sizes = { … }` 的直接子项。
 * 两者都是扁平的 ship_size → 值 表，不再往里嵌套。
 */
function readFlatBlock(
    tokens: Token[],
    openIndex: number,
    fields: ExtractedWeaponTargeting,
    parentKey: string,
): number {
    let index = openIndex + 1;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.RBrace || token.type === TokenType.EOF) return index + 1;
        if (token.type === TokenType.LBrace) {
            index = skipBlock(tokens, index);
            continue;
        }
        const equals = tokens[index + 1];
        const rhs = tokens[index + 2];
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs) {
            if (rhs.type === TokenType.LBrace) {
                index = skipBlock(tokens, index + 2);
                continue;
            }
            if (rhs.type === TokenType.Identifier || rhs.type === TokenType.String || rhs.type === TokenType.Number) {
                if (parentKey === TARGET_WEIGHTS_KEY) {
                    const value = parsePdxNumber(rhs.value);
                    if (value !== undefined) {
                        fields.targetWeights[token.value] = value;
                    } else {
                        fields.dynamicKeys.push(TARGET_WEIGHTS_KEY);
                    }
                } else {
                    fields.targetableShipSizes.push(token.value);
                }
                index += 3;
                continue;
            }
        }
        // `targetable_ship_sizes = { corvette cruiser }`：没有 `=` 的裸 id 就是列表项。
        if (isAtom(token) && parentKey === TARGETABLE_SIZES_KEY && equals?.type !== TokenType.Equals) {
            fields.targetableShipSizes.push(token.value);
            index++;
            continue;
        }
        index++;
    }
    return index;
}

/**
 * 读取一个模板块的直接子项，只关心 §5.2 的索敌字段；
 * 其它嵌套块（prerequisites / map_* 等）整棵跳过，不展开成节点树。
 */
function readComponentBlock(
    tokens: Token[],
    openIndex: number,
    templateTypeKey: string,
    line: number,
): { fields: ExtractedWeaponTargeting; next: number } {
    const fields: ExtractedWeaponTargeting = {
        componentId: '',
        templateTypeKey,
        line,
        targetWeights: {},
        targetableShipSizes: [],
        dynamicKeys: [],
        missingKeys: [],
    };
    let index = openIndex + 1;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.RBrace) return { fields, next: index + 1 };
        if (token.type === TokenType.EOF) return { fields, next: index };
        if (token.type === TokenType.LBrace) {
            index = skipBlock(tokens, index);
            continue;
        }
        const equals = tokens[index + 1];
        const rhs = tokens[index + 2];
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs) {
            const key = token.value;
            if (rhs.type === TokenType.LBrace) {
                if (key === TARGET_WEIGHTS_KEY || key === TARGETABLE_SIZES_KEY) {
                    index = readFlatBlock(tokens, index + 2, fields, key);
                    continue;
                }
                index = skipBlock(tokens, index + 2);
                continue;
            }
            if (rhs.type === TokenType.Identifier || rhs.type === TokenType.String || rhs.type === TokenType.Number) {
                if (key === COMPONENT_ID_KEY) {
                    fields.componentId = rhs.value.trim().replace(/^["']|["']$/g, '');
                } else if (key === COMPONENT_TYPE_KEY) {
                    fields.componentType = rhs.value;
                } else if (key === USE_SHIP_MAIN_TARGET_KEY) {
                    const flag = parsePdxBool(rhs.value);
                    if (flag === undefined) fields.dynamicKeys.push(key);
                    else fields.useShipMainTarget = flag;
                } else if (NUMERIC_KEY_SET.has(key)) {
                    setNumeric(fields, key as TargetingNumericField, rhs.value);
                }
                index += 3;
                continue;
            }
        }
        index++;
    }
    return { fields, next: index };
}

/** 模板里出现的索敌字段个数（用于过滤非武器模板）。 */
export function countTargetingFields(fields: ExtractedWeaponTargeting): number {
    let count = 0;
    for (const key of TARGETING_NUMERIC_FIELDS) {
        if (hasNumericField(fields, key)) count++;
    }
    if (fields.useShipMainTarget !== undefined) count++;
    if (Object.keys(fields.targetWeights).length > 0) count++;
    return count;
}

/**
 * 只有至少命中一个索敌字段的模板才会进入下拉列表——
 * `common/component_templates` 里还有护盾、装甲、星区组件等大量非武器模板。
 */
export function isTargetingRelevant(fields: ExtractedWeaponTargeting): boolean {
    return countTargetingFields(fields) > 0;
}

function finalize(fields: ExtractedWeaponTargeting): ExtractedWeaponTargeting {
    // 顶层键是类型键时（weapon_component_template = { key = "…" }），真正的模板 id 在 key 字段；
    // 老写法直接用顶层键做 id（energy_lance_1 = { … }）时原样保留。
    if (!fields.componentId) fields.componentId = fields.templateTypeKey;
    for (const key of TARGETING_NUMERIC_FIELDS) {
        if (!hasNumericField(fields, key)) {
            fields.missingKeys.push(key);
        }
    }
    return fields;
}

/**
 * 解析一个 component_templates 文件，返回其中所有与索敌相关的模板。
 *
 * 只把「顶层 `X = { ... }`」当成模板，两种写法都覆盖：
 * - 规范写法 `weapon_component_template = { key = "energy_lance_1" … }`（顶层键是类型键）；
 * - 直接以 id 命名的写法 `energy_lance_1 = { … }`。
 * 深一层嵌套块（prerequisites / ai_weight / inline_script 之类）会被整棵跳过。
 */
export function extractTargetingFields(text: string): ExtractedWeaponTargeting[] {
    const tokens = tokenize(text);
    const results: ExtractedWeaponTargeting[] = [];
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.EOF) break;
        if (token.type === TokenType.LBrace) {
            index = skipBlock(tokens, index);
            continue;
        }
        const equals = tokens[index + 1];
        const rhs = tokens[index + 2];
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs?.type === TokenType.LBrace) {
            const parsed = readComponentBlock(tokens, index + 2, token.value, token.line);
            const fields = finalize(parsed.fields);
            if (isTargetingRelevant(fields)) {
                results.push(fields);
            }
            index = parsed.next;
            continue;
        }
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs) {
            index += 3;
            continue;
        }
        index++;
    }
    return results;
}

export interface WeaponTargetingEntry extends ExtractedWeaponTargeting {
    /** 来源文件（绝对路径）。 */
    file: string;
    /** workspace 覆盖 vanilla：同名模板以工作区为准。 */
    source: 'workspace' | 'vanilla';
}

export interface WeaponTargetingSourceGroup {
    source: 'workspace' | 'vanilla';
    file: string;
    entries: ExtractedWeaponTargeting[];
}

const SOURCE_PRIORITY: Record<'workspace' | 'vanilla', number> = { workspace: 0, vanilla: 1 };

/**
 * 合并多根扫描结果：同名模板按 source 取优先级最高的一条（工作区覆盖原版），
 * 输出按 componentId 排序，保证渲染顺序确定。
 */
export function mergeWeaponTargetingEntries(groups: WeaponTargetingSourceGroup[]): WeaponTargetingEntry[] {
    const byId = new Map<string, WeaponTargetingEntry>();
    for (const group of groups) {
        for (const entry of group.entries) {
            const merged: WeaponTargetingEntry = { ...entry, file: group.file, source: group.source };
            const existing = byId.get(entry.componentId);
            if (existing && SOURCE_PRIORITY[existing.source] <= SOURCE_PRIORITY[group.source]) continue;
            byId.set(entry.componentId, merged);
        }
    }
    return [...byId.values()].sort((a, b) => a.componentId.localeCompare(b.componentId));
}

/** 下拉框里显示的一行：模板 id + 类型 + 来源根，便于同名模板辨认覆盖来源。 */
export function formatWeaponTargetingLabel(entry: WeaponTargetingEntry): string {
    const parts = [entry.componentId];
    if (entry.componentType) parts.push(`(${entry.componentType})`);
    if (isGenericTemplateTypeKey(entry.templateTypeKey)) parts.push(`{${entry.templateTypeKey}}`);
    parts.push(entry.source === 'workspace' ? '[workspace]' : '[vanilla]');
    return parts.join(' ');
}

/** 顶层键是否只是类型键（weapon_component_template / utility_component_template / starbase …）。 */
export function isGenericTemplateTypeKey(templateTypeKey: string): boolean {
    return /_component_template$/.test(templateTypeKey) || templateTypeKey === 'starbase';
}
