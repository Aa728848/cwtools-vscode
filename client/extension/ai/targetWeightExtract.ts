/**
 * 从 Stellaris `common/component_templates/*.txt` 中静态提取索敌相关字段（纯函数）。
 *
 * 对应 docs/stellaris-targeting-weight-4.5.2.md §5.2 的武器组件模板字段表：
 * min_damage / max_damage / accuracy / tracking / hull_damage / shield_damage /
 * armor_damage / shield_penetration / armor_penetration / size_damage_factor /
 * use_ship_main_target / target_weights。
 *
 * 同模块也承担面板需要的另外三项纯计算：顶层块 id 收集（common/ship_sizes）、
 * 光标行 → 所属组件模板 id、以及本地化名回退与富文本清洗。
 * 本模块刻意不 import vscode / fs / path，只做「文本 → 结构化字段」，
 * 文件枚举与读取一律留在 Extension Host（targetWeightPanel.ts）。
 */
import { tokenize, TokenType, type Token } from '../pdxTokenizer';

/** 索敌公式里真正会读到的武器字段（对应 targetingWeights.ts 的 TargetingWeaponInput）。 */
export interface ExtractedWeaponTargeting {
    /**
     * 模板 id：优先取块内的 `key = "…"`；顶层键不是类型键时（`energy_lance_1 = { … }`
     * 老写法）退回顶层键。顶层键是类型键却没有内层 `key` 的块不进入列表，见
     * `extractTargetingFields`。
     */
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
    /**
     * 由 weapon_components.csv 补进来的字段（vanilla 的武器数值在 CSV 而非 txt，
     * 见 components_consolidated.cwt 的「vanilla uses an .csv file」注释）。
     * 面板据此显示「CSV」徽标而不是「估算」。
     */
    csvKeys: string[];
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

function unquote(raw: string): string {
    return raw.trim().replace(/^["']|["']$/g, '');
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
        csvKeys: [],
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
                    fields.componentId = unquote(rhs.value);
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
    // 顶层键不是类型键时（`energy_lance_1 = { … }` 老写法），顶层键本身就是模板 id；
    // 类型键缺 `key` 的块已在 extractTargetingFields 里先行丢弃。
    if (!fields.componentId) fields.componentId = fields.templateTypeKey;
    for (const key of TARGETING_NUMERIC_FIELDS) {
        if (!hasNumericField(fields, key)) {
            fields.missingKeys.push(key);
        }
    }
    return fields;
}

/**
 * 顶层键是否只是类型键（weapon_component_template / utility_component_template / starbase …）。
 */
export function isGenericTemplateTypeKey(templateTypeKey: string): boolean {
    return /_component_template$/.test(templateTypeKey) || templateTypeKey === 'starbase';
}

/**
 * 解析一个 component_templates 文件，返回其中所有与索敌相关的模板。
 *
 * 只把「顶层 `X = { ... }`」当成模板，两种写法都覆盖：
 * - 规范写法 `weapon_component_template = { key = "energy_lance_1" … }`（顶层键是类型键）；
 * - 直接以 id 命名的写法 `energy_lance_1 = { … }`。
 * 深一层嵌套块（prerequisites / ai_weight / inline_script 之类）会被整棵跳过。
 *
 * 顶层是类型键却没有内层 `key` 的块一律丢弃：引擎按 `name_field = "key"` 取名，
 * 这种块取不到 id（文档里的注释样例块也长这样），把它们塞进下拉只会得到一条
 * 名为 `weapon_component_template` 的裸条目。
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
            const keylessTypeKey = !parsed.fields.componentId && isGenericTemplateTypeKey(token.value);
            if (!keylessTypeKey) {
                const fields = finalize(parsed.fields);
                if (isTargetingRelevant(fields)) {
                    results.push(fields);
                }
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

// ── 顶层块扫描 ─────────────────────────────────────────────────────────────────
//
// common/ship_sizes/*.txt 没有 name_field：顶层键就是 id（`corvette = { … }`），
// 所以 ship_size 候选与「光标落在哪个组件模板里」共用同一套顶层块扫描。

/** 一个顶层 `id = { … }` 块。 */
export interface TopLevelBlock {
    /** 顶层键（引号已剥离）。 */
    id: string;
    /** `id = {` 所在的 1 基行号。 */
    line: number;
    /** 块闭合 `}` 所在的 1 基行号。 */
    endLine: number;
    /** 直接子项里的 `key = "…"`；没有则 undefined。 */
    key?: string;
}

function readTopLevelBlock(
    tokens: Token[],
    openIndex: number,
    id: string,
    line: number,
): { block: TopLevelBlock; next: number } {
    let key: string | undefined;
    let index = openIndex + 1;
    const finish = (next: number): { block: TopLevelBlock; next: number } => ({
        block: { id, line, endLine: tokens[next - 1]?.line ?? line, key },
        next,
    });
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.RBrace) return finish(index + 1);
        if (token.type === TokenType.EOF) return finish(index);
        if (token.type === TokenType.LBrace) {
            index = skipBlock(tokens, index);
            continue;
        }
        const equals = tokens[index + 1];
        const rhs = tokens[index + 2];
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs) {
            if (token.value === COMPONENT_ID_KEY && rhs.type !== TokenType.LBrace) {
                if (key === undefined) key = unquote(rhs.value);
            } else if (rhs.type === TokenType.LBrace) {
                index = skipBlock(tokens, index + 2);
                continue;
            }
            index += 3;
            continue;
        }
        index++;
    }
    return finish(index);
}

/**
 * 扫描一个文件里的全部顶层块（注释与嵌套块由 tokenizer 处理掉）。
 */
export function readTopLevelBlocks(text: string): TopLevelBlock[] {
    const tokens = tokenize(text);
    const blocks: TopLevelBlock[] = [];
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
            const parsed = readTopLevelBlock(tokens, index + 2, token.value, token.line);
            blocks.push(parsed.block);
            index = parsed.next;
            continue;
        }
        if (isAtom(token) && equals?.type === TokenType.Equals && rhs) {
            index += 3;
            continue;
        }
        index++;
    }
    return blocks;
}

/**
 * 一个 `common/ship_sizes/*.txt` 文件里的 ship_size id（按出现顺序、文件内去重）。
 *
 * 注释行与嵌套块里的 `xxx = { … }` 不会被算进来：只取顶层键。
 */
export function extractShipSizeIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const block of readTopLevelBlocks(text)) {
        const id = block.id.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

export interface ShipSizeSourceGroup {
    source: 'workspace' | 'vanilla';
    file: string;
    ids: string[];
}

/**
 * 合并多根 ship_sizes 扫描结果：跨文件去重后按 id 排序，保证 datalist 顺序确定。
 */
export function mergeShipSizeIds(groups: ShipSizeSourceGroup[]): string[] {
    const ids = new Set<string>();
    for (const group of groups) {
        for (const id of group.ids) {
            const trimmed = id.trim();
            if (trimmed) ids.add(trimmed);
        }
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * 光标行 → 所属顶层块的组件模板 id（编辑器右键菜单快速入口用）。
 *
 * 与 `extractTargetingFields` 用同一套 id 规则：内层 `key` 优先；顶层键不是类型键时
 * 直接当 id；顶层键是类型键却没有内层 `key`（注释样例块）返回 undefined。
 * 行号是 1 基的（与 vscode 的 0 基 selection.line 差 1，调用方负责换算）。
 */
export function findComponentTemplateIdAtLine(text: string, line: number): string | undefined {
    if (!Number.isFinite(line) || line < 1) return undefined;
    for (const block of readTopLevelBlocks(text)) {
        if (line < block.line || line > block.endLine) continue;
        if (block.key) return block.key;
        return isGenericTemplateTypeKey(block.id) ? undefined : block.id;
    }
    return undefined;
}

// ── 本地化显示名 ───────────────────────────────────────────────────────────────

/**
 * 去掉 Paradox 富文本标记（图标、颜色、视觉标记），保留可读文字。
 *
 * `$£icon£$` 只包一半或整段缺失时会留下孤立标记，所以最后再统一清一次残字符，
 * 保证下拉/标签永远是一行纯文本。
 */
function stripLocalisationMarkup(value: string): string {
    return value
        // `$£icon£$` 与 `£icon£` 两种图标写法，成对吃掉。
        .replace(/\$?£[^£]*£\$?/g, '')
        // `§Y` `§!` `§$` 等视觉标记：`§` 后跟任意一个字符。
        .replace(/§./g, '')
        // `[Starbase]` 之类的方括号前缀。
        .replace(/\[[^\]]*\]/g, '')
        // `$强调$` 保留文字。
        .replace(/\$([^$]*)\$/g, '$1')
        // 残留的孤立标记。
        .replace(/[$£§]/g, '');
}


// ── 计算载荷 ───────────────────────────────────────────────────────────────────

/** parseTargetingChainInput 要求的武器数值键；顺序与 WeaponInput 的构造顺序一致。 */
export const WEAPON_INPUT_NUMERIC_KEYS = [
    'minDamage',
    'maxDamage',
    'accuracy',
    'tracking',
    'shieldDamage',
    'armorDamage',
    'hullDamage',
    'shieldPenetration',
    'armorPenetration',
    'sizeDamageFactor',
] as const;

/** 无模板时的缺省武器输入（全部按缺省值估算，由面板标注）。 */
export function defaultWeaponInput(): Record<string, number | Record<string, number>> {
    return {
        minDamage: TARGETING_FIELD_FALLBACKS.min_damage,
        maxDamage: TARGETING_FIELD_FALLBACKS.max_damage,
        accuracy: TARGETING_FIELD_FALLBACKS.accuracy,
        tracking: TARGETING_FIELD_FALLBACKS.tracking,
        shieldDamage: TARGETING_FIELD_FALLBACKS.shield_damage,
        armorDamage: TARGETING_FIELD_FALLBACKS.armor_damage,
        hullDamage: TARGETING_FIELD_FALLBACKS.hull_damage,
        shieldPenetration: TARGETING_FIELD_FALLBACKS.shield_penetration,
        armorPenetration: TARGETING_FIELD_FALLBACKS.armor_penetration,
        sizeDamageFactor: TARGETING_FIELD_FALLBACKS.size_damage_factor,
        targetWeights: {},
    };
}

/** webview 的 target_weights 文本可能被改坏；只保留有限数值，其余丢弃。 */
function sanitiseTargetWeights(raw: unknown, fallback: Record<string, number>): Record<string, number> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...fallback };
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const trimmed = key.trim();
        if (!trimmed) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        out[trimmed] = value;
    }
    return out;
}

/**
 * 组装一次分析的武器输入：模板静态值打底，webview 的手动编辑覆盖。
 *
 * 模板缺字段时用 \`TARGETING_FIELD_FALLBACKS\` 估算；没选模板（template 为 undefined）
 * 时整份输入都来自表单的手动值——因此「分析」永远可用，不存在
 * 「必须先选一个武器模板」的死路。webview 的载荷不可信，非有限数值一律被丢弃，
 * 保证 \`parseTargetingChainInput\` 收窄时不会抛错。
 */
export function mergeComputeWeaponInput(
    template: Record<string, unknown> | undefined,
    raw: unknown,
): Record<string, unknown> {
    const base = { ...defaultWeaponInput(), ...(template ?? {}) };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
    const overrides = raw as Record<string, unknown>;
    for (const key of WEAPON_INPUT_NUMERIC_KEYS) {
        const value = overrides[key];
        if (typeof value === 'number' && Number.isFinite(value)) base[key] = value;
    }
    base.targetWeights = sanitiseTargetWeights(
        overrides.targetWeights,
        (base.targetWeights as Record<string, number> | undefined) ?? {},
    );
    return base;
}

/**
 * 本地化值 → 适合放进下拉/标签的纯文本；空值或只剩标记时返回 undefined（调用方回退 id）。
 */
export function toDisplayLocalisationValue(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const collapsed = stripLocalisationMarkup(value).replace(/\s+/g, ' ').trim();
    return collapsed.length > 0 ? collapsed : undefined;
}

/**
 * 下拉里的一行：`<本地化名> (<id>)`。
 *
 * 组件名的 loc 键就是组件 key，没有本地化（或本地化与 id 相同）时回退到裸 id。
 */
export function formatComponentDisplayLabel(id: string, localizedName?: string): string {
    const name = toDisplayLocalisationValue(localizedName);
    if (!name || name === id) return id;
    return `${name} (${id})`;
}

// ── weapon_components.csv ────────────────────────────────────────────────────
//
// vanilla 的武器战斗数值不在 .txt 模板里，而在 common/component_templates/*.csv
//（rules 注释："vanilla uses an .csv file to create these"）。CSV 以分号分隔，
// `#` 开头为注释行，表头行是 `key;cost;power;min_damage;...;end`。

/** CSV 一行提供的武器数值（TARGETING_NUMERIC_FIELDS 的子集）。 */
export type CsvWeaponStats = Partial<Record<TargetingNumericField, number>>;

/**
 * 解析一个 weapon_components.csv：按表头行动态定位列序（列增减都不坏），
 * 跳过注释与空行；键保持原样大小写（合并侧负责大小写回退匹配）。
 */
export function parseWeaponComponentsCsv(text: string): Map<string, CsvWeaponStats> {
    const rows = new Map<string, CsvWeaponStats>();
    let columns: string[] | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cells = line.split(';').map(cell => cell.trim());
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
        const first = cells[0] ?? '';
        if (!first) continue;
        if (first === 'key') {
            columns = cells;
            continue;
        }
        if (!columns) continue;
        const stats: CsvWeaponStats = {};
        for (const field of TARGETING_NUMERIC_FIELDS) {
            const column = columns.indexOf(field);
            if (column < 0) continue;
            const raw = cells[column];
            if (!raw) continue;
            const value = Number.parseFloat(raw);
            if (Number.isFinite(value)) stats[field] = value;
        }
        rows.set(unquote(first), stats);
    }
    return rows;
}

/** CSV 来源分组；同名键工作区覆盖原版。 */
export interface CsvStatsSourceGroup {
    source: 'workspace' | 'vanilla';
    file: string;
    stats: Map<string, CsvWeaponStats>;
}

/** 合并多根 CSV：vanilla 先写、workspace 后写覆盖。 */
export function mergeCsvStatMaps(groups: CsvStatsSourceGroup[]): Map<string, CsvWeaponStats> {
    const merged = new Map<string, CsvWeaponStats>();
    for (const group of [...groups].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])) {
        for (const [key, stats] of group.stats) merged.set(key, stats);
    }
    return merged;
}

/**
 * 把 CSV 数值并入模板：.txt 里显式写的字段优先，CSV 只补缺口；
 * 补进来的字段记入 csvKeys（面板显示「CSV」徽标），并从 missingKeys 摘除。
 */
export function applyCsvWeaponStats(
    entry: ExtractedWeaponTargeting,
    csvRows: Map<string, CsvWeaponStats>,
): void {
    const stats = csvRows.get(entry.componentId) ?? csvRows.get(entry.componentId.toUpperCase());
    if (!stats) return;
    for (const field of TARGETING_NUMERIC_FIELDS) {
        if (hasNumericField(entry, field)) continue;
        const value = stats[field];
        if (value === undefined) continue;
        (entry as unknown as Record<string, number>)[FIELD_BY_TEMPLATE_KEY[field]] = value;
        if (!entry.csvKeys.includes(field)) entry.csvKeys.push(field);
    }
    const filled = new Set<string>(entry.csvKeys);
    entry.missingKeys = entry.missingKeys.filter(key => !filled.has(key));
}

// ── 脚本变量与 ship_size 详情 ─────────────────────────────────────────────────

/** 解析 common/scripted_variables/*.txt 的 `@name = number` 行（注释与块跳过）。 */
export function parseScriptedVariables(text: string): Map<string, number> {
    const vars = new Map<string, number>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^@([\w.-]+)\s*=\s*(-?[\d.]+)/.exec(line);
        if (!match) continue;
        const value = Number.parseFloat(match[2]!);
        if (Number.isFinite(value)) vars.set(match[1]!, value);
    }
    return vars;
}

/** 合并多根的脚本变量：vanilla 先写、workspace 后写覆盖。 */
export function mergeScriptedVariables(
    groups: Array<{ source: 'workspace' | 'vanilla'; vars: Map<string, number> }>,
): Map<string, number> {
    const merged = new Map<string, number>();
    for (const group of [...groups].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])) {
        for (const [key, value] of group.vars) merged.set(key, value);
    }
    return merged;
}

/** ship_size 的索敌相关属性（@脚本变量已解析；解析不出的项缺省）。 */
export interface ShipSizeDetail {
    id: string;
    line: number;
    /** size_multiplier → 公式里的 σ。 */
    sizeMultiplier?: number;
    /** max_hitpoints → 船体上限预填。 */
    maxHitpoints?: number;
    /** modifier 子块的 ship_evasion_add（百分制：60 = 60%）→ ε = /100。 */
    evasionPercent?: number;
}

function resolveShipSizeNumber(raw: string, vars: Map<string, number>): number | undefined {
    const trimmed = raw.trim();
    if (trimmed.startsWith('@')) return vars.get(trimmed.slice(1));
    const value = Number.parseFloat(trimmed);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * 提取 ship_sizes 文件的顶层块详情：size_multiplier / max_hitpoints 是直接子项，
 * ship_evasion_add 在 modifier 子块内（更深层的嵌套块不读）。
 */
export function extractShipSizeDetails(text: string, vars: Map<string, number>): ShipSizeDetail[] {
    const tokens = tokenize(text);
    const details: ShipSizeDetail[] = [];
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.EOF) break;
        if (token.type === TokenType.LBrace) {
            index = skipBlock(tokens, index);
            continue;
        }
        const equals = tokens[index + 1];
        const open = tokens[index + 2];
        if (!(isAtom(token) && equals?.type === TokenType.Equals && open?.type === TokenType.LBrace)) {
            index++;
            continue;
        }
        const detail: ShipSizeDetail = { id: unquote(token.value), line: token.line };
        // 块内游走：depth 1 = 直接子项；modifier 块内容在 depth 2。
        let depth = 1;
        let modifierContentDepth = 0;
        let cursor = index + 3;
        while (cursor < tokens.length && depth > 0) {
            const current = tokens[cursor]!;
            if (current.type === TokenType.LBrace) {
                depth++;
                cursor++;
                continue;
            }
            if (current.type === TokenType.RBrace) {
                if (modifierContentDepth > 0 && depth === modifierContentDepth) modifierContentDepth = 0;
                depth--;
                cursor++;
                continue;
            }
            if (current.type === TokenType.EOF) break;
            const eq = tokens[cursor + 1];
            const rhs = tokens[cursor + 2];
            if (isAtom(current) && eq?.type === TokenType.Equals && rhs) {
                if (rhs.type === TokenType.LBrace) {
                    if (depth === 1 && current.value === 'modifier') modifierContentDepth = depth + 1;
                    cursor++;
                    continue;
                }
                if (rhs.type === TokenType.Identifier || rhs.type === TokenType.String || rhs.type === TokenType.Number) {
                    if (depth === 1 && current.value === 'size_multiplier') {
                        detail.sizeMultiplier = resolveShipSizeNumber(rhs.value, vars);
                    } else if (depth === 1 && current.value === 'max_hitpoints') {
                        detail.maxHitpoints = resolveShipSizeNumber(rhs.value, vars);
                    } else if (depth === 2 && modifierContentDepth === 2 && current.value === 'ship_evasion_add') {
                        detail.evasionPercent = resolveShipSizeNumber(rhs.value, vars);
                    }
                    cursor += 3;
                    continue;
                }
            }
            cursor++;
        }
        details.push(detail);
        index = cursor;
    }
    return details;
}

/** ship_size 详情的来源分组。 */
export interface ShipSizeDetailGroup {
    source: 'workspace' | 'vanilla';
    file: string;
    entries: ShipSizeDetail[];
}

/** 合并多根的 ship_size 详情：同 id 工作区覆盖原版，输出按 id 排序。 */
export function mergeShipSizeDetails(groups: ShipSizeDetailGroup[]): ShipSizeDetail[] {
    const byId = new Map<string, { detail: ShipSizeDetail; priority: number }>();
    for (const group of groups) {
        for (const detail of group.entries) {
            const existing = byId.get(detail.id);
            if (existing && existing.priority <= SOURCE_PRIORITY[group.source]) continue;
            byId.set(detail.id, { detail, priority: SOURCE_PRIORITY[group.source] });
        }
    }
    return [...byId.values()].map(entry => entry.detail).sort((a, b) => a.id.localeCompare(b.id));
}
