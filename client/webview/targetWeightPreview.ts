/**
 * Target Weight Preview — Webview script for the Stellaris targeting-weight analyzer.
 *
 * 纯浏览器沙箱：不 import vscode / fs / path，不使用 require()，只通过 postMessage 与
 * Extension Host 通信。枚举文件、解析模板、调用 computeTargetingChain 全部在 Host 侧。
 *
 * 渲染只用纯 CSS 条形图（不使用 canvas），因此没有 GPU 资源或动画循环需要释放；
 * 所有事件监听集中在 disposables 中，页面卸载时统一注销。
 */

// 本文件不含 import/export 会被当作全局脚本，与其它 webview 顶层的 vscode/Locale
// 声明冲突；空导出把它固定为模块作用域。
export {};

const vscode = acquireVsCodeApi();

// ─── Types (mirror of targetingWeights.ts / targetWeightExtract.ts) ─────────────

type Locale = 'en' | 'zh-cn';

/** init 载荷里的 ship_size 选项（Host 从 ship_sizes 定义解析而来，标签已本地化）。 */
interface ShipSizeOption {
    id: string;
    label: string;
    sizeMultiplier?: number;
    evasion?: number;
    maxHitpoints?: number;
}

interface WeaponOption {
    id: string;
    displayLabel: string;
    templateTypeKey: string;
    type?: string;
    source: 'workspace' | 'vanilla';
    useShipMainTarget: boolean;
    targetWeightKeys: string[];
    missingKeys: string[];
    dynamicKeys: string[];
    /** 数值来自 weapon_components.csv 的模板键（显示「CSV」徽标，不是估算）。 */
    csvKeys?: string[];
}

interface WeaponInput {
    minDamage: number;
    maxDamage: number;
    accuracy: number;
    tracking: number;
    shieldDamage: number;
    armorDamage: number;
    hullDamage: number;
    shieldPenetration: number;
    armorPenetration: number;
    sizeDamageFactor: number;
    targetWeights: Record<string, number>;
}

interface WeaponDetail extends WeaponOption {
    input: WeaponInput;
    targetableShipSizes: string[];
}

type WeaponInputKey = keyof WeaponInput;
/** 武器表单里的数值字段（target_weights 走独立的文本框）。 */
type WeaponNumericInputKey = Exclude<WeaponInputKey, 'targetWeights'>;

interface ScanStats {
    files: number;
    templates: number;
}

interface ShipChainView {
    sizeCapped: number;
    W1: number;
    shipTracking: number;
    evasionDelta: number;
    evasionFactor: number;
    W2: number;
    distanceFactor: number;
    W3: number;
    targetWeight: number;
    W4: number;
    lowHealthFactor: number;
    unarmedFactor: number;
    starbaseFactor: number;
    W5: number;
    randomFactor: number;
    W6: number;
    weight: number;
}

interface WeaponLayerView {
    p: number;
    baseDamage: number;
    damageSplit: { Ds: number; Da: number; Dh: number };
    sumD: number;
    S0: number;
    killBonus: number;
    S1: number;
    unarmedPenalty: number;
    S2: number;
    wk: number;
    score: number;
    currentTargetMultiplier: number;
    recentTargetPenalizer: number;
    final: number;
}

interface ChainResultView {
    veto: boolean;
    usesShipMainTarget: boolean;
    shipChain: ShipChainView;
    weapon: WeaponLayerView;
    distanceWeightMin: number;
}

// ─── DOM refs ──────────────────────────────────────────────────────────────────

const presetSelect = document.getElementById('preset-select') as HTMLSelectElement | null;
const weaponSearch = document.getElementById('weapon-search') as HTMLInputElement | null;
const weaponDatalist = document.getElementById('weapon-options') as HTMLDataListElement | null;
const btnReveal = document.getElementById('btn-reveal') as HTMLButtonElement | null;
const btnCompute = document.getElementById('btn-compute') as HTMLButtonElement | null;
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const formBody = document.getElementById('form-body');
const attackerBody = document.getElementById('attacker-body');
const weaponBody = document.getElementById('weapon-body');
const weaponFacts = document.getElementById('weapon-facts');
const optionsBody = document.getElementById('options-body');
const shipChainEl = document.getElementById('ship-chain');
const weaponChainEl = document.getElementById('weapon-chain');
const notesEl = document.getElementById('notes');

const DEBOUNCE_MS = 250;

// ─── Localised copy ────────────────────────────────────────────────────────────

let locale: Locale = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh')
    ? 'zh-cn'
    : 'en';

function t(en: string, zh: string): string {
    return locale === 'zh-cn' ? zh : en;
}

// ─── Listener bookkeeping (all disposed on pagehide) ───────────────────────────

const disposables: Array<() => void> = [];
let debounceTimer: number | undefined;

function on(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    disposables.push(() => target.removeEventListener(type, handler));
}

function disposeAll(): void {
    while (disposables.length) {
        const dispose = disposables.pop();
        if (dispose) dispose();
    }
    if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
}

// ─── State ─────────────────────────────────────────────────────────────────────

interface NumericFieldSpec {
    key: string;
    labelEn: string;
    labelZh: string;
    step: number;
}

interface CheckboxFieldSpec {
    key: string;
    labelEn: string;
    labelZh: string;
}

const TARGET_NUMERIC_FIELDS: NumericFieldSpec[] = [
    { key: 'sizeMultiplier', labelEn: 'Size multiplier σ', labelZh: '尺寸倍率 σ', step: 0.1 },
    { key: 'evasion', labelEn: 'Evasion ε', labelZh: '闪避 ε', step: 0.01 },
    { key: 'distance', labelEn: 'Distance d', labelZh: '距离 d', step: 1 },
    { key: 'hull', labelEn: 'Hull V', labelZh: '船体 V', step: 1 },
    { key: 'maxHull', labelEn: 'Max hull', labelZh: '船体上限', step: 1 },
    { key: 'shield', labelEn: 'Shield', labelZh: '护盾', step: 1 },
    { key: 'armor', labelEn: 'Armor', labelZh: '装甲', step: 1 },
];

const TARGET_CHECKBOX_FIELDS: CheckboxFieldSpec[] = [
    { key: 'armed', labelEn: 'Armed (DPD > 0)', labelZh: '可还手（DPD > 0）' },
    { key: 'isStarbase', labelEn: 'Starbase / megastructure', labelZh: '恒星基地 / 巨构' },
];

const ATTACKER_NUMERIC_FIELDS: NumericFieldSpec[] = [
    { key: 'tracking', labelEn: 'Ship tracking', labelZh: '舰船追踪', step: 0.01 },
    { key: 'sizeMultiplier', labelEn: 'Ship size σatt', labelZh: '舰船尺寸 σatt', step: 0.1 },
];

const OPTION_NUMERIC_FIELDS: NumericFieldSpec[] = [
    { key: 'rho', labelEn: 'Combat-start roll ρ', labelZh: '开战随机量 ρ', step: 0.01 },
    { key: 'targetWeightMultModifier', labelEn: 'ship_target_weight_mult', labelZh: 'ship_target_weight_mult 修正值', step: 0.05 },
    { key: 'randomRoll', labelEn: 'Random factor roll r', labelZh: '随机扰动 r', step: 0.05 },
];

const OPTION_CHECKBOX_FIELDS: CheckboxFieldSpec[] = [
    { key: 'useRandom', labelEn: 'Apply random factor (engine default: on)', labelZh: '施加随机扰动（引擎默认开启）' },
    { key: 'fleetHasHittable', labelEn: 'Fleet still has a hittable ship', labelZh: '目标舰队仍有可命中的船' },
    { key: 'targetFocus', labelEn: 'target_focus = spread', labelZh: 'target_focus = spread（不作主目标粘性）' },
    { key: 'isCurrentMainTarget', labelEn: 'Is the current main target', labelZh: '是当前主目标' },
    { key: 'isRecentNonLatest', labelEn: 'In recent-target memory', labelZh: '在最近目标记忆中' },
];

/** 武器数值字段：camelCase 键 + 模板里的 snake_case 键（估算标注按模板键汇报）。 */
const WEAPON_NUMERIC_FIELDS: Array<{ key: WeaponNumericInputKey; templateKey: string; labelEn: string; labelZh: string; step: number }> = [
    { key: 'minDamage', templateKey: 'min_damage', labelEn: 'min_damage', labelZh: 'min_damage', step: 1 },
    { key: 'maxDamage', templateKey: 'max_damage', labelEn: 'max_damage', labelZh: 'max_damage', step: 1 },
    { key: 'accuracy', templateKey: 'accuracy', labelEn: 'accuracy', labelZh: 'accuracy', step: 0.01 },
    { key: 'tracking', templateKey: 'tracking', labelEn: 'tracking', labelZh: 'tracking', step: 0.01 },
    { key: 'shieldDamage', templateKey: 'shield_damage', labelEn: 'shield_damage', labelZh: 'shield_damage', step: 0.05 },
    { key: 'armorDamage', templateKey: 'armor_damage', labelEn: 'armor_damage', labelZh: 'armor_damage', step: 0.05 },
    { key: 'hullDamage', templateKey: 'hull_damage', labelEn: 'hull_damage', labelZh: 'hull_damage', step: 0.05 },
    { key: 'shieldPenetration', templateKey: 'shield_penetration', labelEn: 'shield_penetration', labelZh: 'shield_penetration', step: 0.05 },
    { key: 'armorPenetration', templateKey: 'armor_penetration', labelEn: 'armor_penetration', labelZh: 'armor_penetration', step: 0.05 },
    { key: 'sizeDamageFactor', templateKey: 'size_damage_factor', labelEn: 'size_damage_factor', labelZh: 'size_damage_factor', step: 0.05 },
];

interface TargetFormState {
    sizeMultiplier: number;
    evasion: number;
    distance: number;
    hull: number;
    maxHull: number;
    shield: number;
    armor: number;
    shipSizeId: string;
    armed: boolean;
    isStarbase: boolean;
}

const targetState: TargetFormState = {
    sizeMultiplier: 5,
    evasion: 0.6,
    distance: 72,
    hull: 240,
    maxHull: 300,
    shield: 225,
    armor: 225,
    shipSizeId: 'corvette',
    armed: true,
    isStarbase: false,
};
const attackerState: Record<string, number> = { tracking: 0, sizeMultiplier: 3 };
const optionState: Record<string, number | boolean> = {
    rho: 0,
    targetWeightMultModifier: 0,
    randomRoll: 0,
    useRandom: false,
    fleetHasHittable: true,
    targetFocus: false,
    isCurrentMainTarget: false,
    isRecentNonLatest: false,
};

/** Host 下发的缺省估算值；无模板时武器表单从这里起步。 */
let weaponDefaults: WeaponInput = {
    minDamage: 0,
    maxDamage: 0,
    accuracy: 0,
    tracking: 0,
    shieldDamage: 1,
    armorDamage: 1,
    hullDamage: 1,
    shieldPenetration: 0,
    armorPenetration: 0,
    sizeDamageFactor: 0,
    targetWeights: {},
};

let weaponInput: WeaponInput = { ...weaponDefaults, targetWeights: {} };
let weaponUseShipMainTarget = false;
/** 需要标「估算」的模板键（模板缺字段或写了 @[…] 脚本表达式）。 */
let estimatedTemplateKeys = new Set<string>();
/** 数值来自 weapon_components.csv 的模板键。 */
let csvTemplateKeys = new Set<string>();
let targetableShipSizesText = '';

let shipSizeOptions: ShipSizeOption[] = [];
let weaponOptions: WeaponOption[] = [];
let currentWeapon: WeaponDetail | undefined;
let scannedShipSizes: string[] = [];
let lastResult: ChainResultView | undefined;

// ─── Small DOM helpers ─────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function inputValueOf(event: Event): number {
    const input = event.target as HTMLInputElement | null;
    const parsed = Number.parseFloat(input?.value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function appendNumberField(
    container: HTMLElement,
    spec: NumericFieldSpec,
    read: () => number,
    write: (value: number) => void,
    decorate?: (row: HTMLElement) => void,
): void {
    const label = el('label', 'field');
    const input = el('input');
    input.type = 'number';
    input.step = String(spec.step);
    input.value = String(read());
    input.dataset.key = spec.key;
    label.appendChild(el('span', 'field-label', t(spec.labelEn, spec.labelZh)));
    label.appendChild(input);
    container.appendChild(label);
    if (decorate) decorate(label);
    on(input, 'input', event => {
        write(inputValueOf(event));
        scheduleCompute();
    });
}

function appendCheckbox(
    container: HTMLElement,
    spec: CheckboxFieldSpec,
    read: () => boolean,
    write: (value: boolean) => void,
): void {
    const label = el('label', 'checkbox');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = read();
    label.appendChild(input);
    label.appendChild(el('span', undefined, t(spec.labelEn, spec.labelZh)));
    container.appendChild(label);
    on(input, 'change', event => {
        write((event.target as HTMLInputElement).checked);
        scheduleCompute();
    });
}

function appendTextField(
    container: HTMLElement,
    labelEn: string,
    labelZh: string,
    value: string,
    placeholder: string,
    write: (value: string) => void,
): HTMLInputElement {
    const label = el('label', 'field field-wide');
    label.appendChild(el('span', 'field-label', t(labelEn, labelZh)));
    const input = el('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    container.appendChild(label);
    on(input, 'input', () => {
        write(input.value);
        scheduleCompute();
    });
    return input;
}

/** 解析 target_weights 文本：\`corvette=10 battleship=2.5\`，容错跳过坏条目。 */
function parseTargetWeights(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const token of text.split(/[\s,]+/)) {
        if (!token) continue;
        const equals = token.indexOf('=');
        if (equals <= 0) continue;
        const key = token.slice(0, equals).trim();
        const value = Number.parseFloat(token.slice(equals + 1));
        if (!key || !Number.isFinite(value)) continue;
        out[key] = value;
    }
    return out;
}

function formatTargetWeights(weights: Record<string, number>): string {
    return Object.keys(weights)
        .sort((a, b) => a.localeCompare(b))
        .map(key => key + '=' + String(weights[key]))
        .join('  ');
}

// ─── Forms ─────────────────────────────────────────────────────────────────────

function buildTargetForms(): void {
    if (!formBody || !attackerBody || !optionsBody) return;
    formBody.textContent = '';
    attackerBody.textContent = '';
    optionsBody.textContent = '';

    for (const spec of TARGET_NUMERIC_FIELDS) {
        appendNumberField(
            formBody,
            spec,
            () => Number(targetState[spec.key as keyof TargetFormState]),
            value => { (targetState as unknown as Record<string, number>)[spec.key] = value; },
        );
    }

    const sizeLabel = el('label', 'field');
    sizeLabel.appendChild(el('span', 'field-label', t('Target ship_size id', '目标 ship_size id')));
    const sizeInput = el('input');
    sizeInput.type = 'text';
    sizeInput.value = targetState.shipSizeId;
    sizeInput.id = 'ship-size-id';
    sizeInput.setAttribute('list', 'ship-size-options');
    sizeInput.autocomplete = 'off';
    sizeInput.spellcheck = false;
    const datalist = el('datalist');
    datalist.id = 'ship-size-options';
    sizeLabel.appendChild(sizeInput);
    sizeLabel.appendChild(datalist);
    formBody.appendChild(sizeLabel);
    on(sizeInput, 'input', () => {
        targetState.shipSizeId = sizeInput.value.trim();
        scheduleCompute();
    });

    for (const spec of TARGET_CHECKBOX_FIELDS) {
        appendCheckbox(
            formBody,
            spec,
            () => Boolean(targetState[spec.key as keyof TargetFormState]),
            value => { (targetState as unknown as Record<string, boolean>)[spec.key] = value; },
        );
    }

    for (const spec of ATTACKER_NUMERIC_FIELDS) {
        appendNumberField(attackerBody, spec, () => attackerState[spec.key] ?? 0, value => {
            attackerState[spec.key] = value;
        });
    }

    for (const spec of OPTION_NUMERIC_FIELDS) {
        appendNumberField(optionsBody, spec, () => Number(optionState[spec.key] ?? 0), value => {
            optionState[spec.key] = value;
        });
    }
    for (const spec of OPTION_CHECKBOX_FIELDS) {
        appendCheckbox(optionsBody, spec, () => optionState[spec.key] === true, value => {
            optionState[spec.key] = value;
        });
    }
}

/**
 * 武器参数表单：模板只负责自动填充，每个字段都能手动改。
 * 模板没给的字段用 Host 的缺省值起步，并标「估算」；用户一改就变成手动值。
 */
function buildWeaponForm(): void {
    if (!weaponBody) return;
    weaponBody.textContent = '';

    for (const spec of WEAPON_NUMERIC_FIELDS) {
        appendNumberField(
            weaponBody,
            { key: spec.key, labelEn: spec.labelEn, labelZh: spec.labelZh, step: spec.step },
            () => weaponInput[spec.key],
            value => {
                weaponInput[spec.key] = value;
                // 用户改过的值不再是估算值。
                estimatedTemplateKeys.delete(spec.templateKey);
                refreshEstimatedMarkers();
            },
            row => {
                if (estimatedTemplateKeys.has(spec.templateKey)) {
                    row.classList.add('estimated');
                    row.appendChild(el('span', 'field-tag', t('estimated', '估算')));
                } else if (csvTemplateKeys.has(spec.templateKey)) {
                    row.appendChild(el('span', 'field-tag csv', t('from CSV', '来自 CSV')));
                }
            },
        );
    }

    appendCheckbox(
        weaponBody,
        { key: 'useShipMainTarget', labelEn: 'use_ship_main_target', labelZh: 'use_ship_main_target' },
        () => weaponUseShipMainTarget,
        value => {
            weaponUseShipMainTarget = value;
            renderWeaponFacts();
        },
    );

    const weightsInput = appendTextField(
        weaponBody,
        'target_weights (ship_size = wk)',
        'target_weights（ship_size = wk）',
        formatTargetWeights(weaponInput.targetWeights),
        t('corvette=10  battleship=2.5', 'corvette=10  battleship=2.5'),
        value => {
            weaponInput.targetWeights = parseTargetWeights(value);
        },
    );
    weightsInput.id = 'target-weights-input';

    appendTextField(
        weaponBody,
        'targetable_ship_sizes',
        'targetable_ship_sizes',
        targetableShipSizesText,
        t('corvette cruiser', 'corvette cruiser'),
        value => {
            targetableShipSizesText = value;
        },
    );
}

/** 估算角标随编辑实时更新，不需要重建整个表单。 */
function refreshEstimatedMarkers(): void {
    if (!weaponBody) return;
    const rows = weaponBody.querySelectorAll<HTMLElement>('label.field');
    WEAPON_NUMERIC_FIELDS.forEach((spec, index) => {
        const row = rows[index];
        if (!row) return;
        const estimated = estimatedTemplateKeys.has(spec.templateKey);
        const fromCsv = !estimated && csvTemplateKeys.has(spec.templateKey);
        row.classList.toggle('estimated', estimated);
        let tag = row.querySelector('.field-tag');
        const label = estimated ? t('estimated', '估算') : fromCsv ? t('from CSV', '来自 CSV') : '';
        if (label) {
            if (!tag) {
                tag = el('span', 'field-tag', label);
                row.appendChild(tag);
            }
            tag.textContent = label;
            tag.classList.toggle('csv', fromCsv);
        } else if (tag) {
            tag.remove();
        }
    });
}

function applyShipSizeOption(id: string): void {
    if (id === '') return; // 「自定义 / 手动」：保留当前表单值
    const option = shipSizeOptions.find(entry => entry.id === id);
    if (!option) return;
    // 只预填定义里解析出的项；距离/盾/甲等战斗状态不动。
    if (typeof option.sizeMultiplier === 'number') targetState.sizeMultiplier = option.sizeMultiplier;
    if (typeof option.evasion === 'number') targetState.evasion = Math.round(option.evasion * 1000) / 1000;
    if (typeof option.maxHitpoints === 'number') targetState.maxHull = option.maxHitpoints;
    targetState.shipSizeId = option.id;
    buildTargetForms();
    refreshShipSizeOptions();
    scheduleCompute();
}

// ─── Ship size + weapon catalogue ──────────────────────────────────────────────

function refreshShipSizeOptions(): void {
    const datalist = document.getElementById('ship-size-options');
    const input = document.getElementById('ship-size-id');
    if (!(datalist instanceof HTMLDataListElement) || !(input instanceof HTMLInputElement)) return;
    datalist.textContent = '';
    // 当前武器的 target_weights 键排最前，其余是扫描到的全量 ship_size。
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const key of currentWeapon?.targetWeightKeys ?? []) {
        if (key && !seen.has(key)) {
            seen.add(key);
            ordered.push(key);
        }
    }
    for (const key of scannedShipSizes) {
        if (key && !seen.has(key)) {
            seen.add(key);
            ordered.push(key);
        }
    }
    for (const key of ordered) {
        const option = el('option');
        option.value = key;
        datalist.appendChild(option);
    }
    const weaponKeys = currentWeapon?.targetWeightKeys ?? [];
    if (weaponKeys.length > 0 && !weaponKeys.includes(input.value)) {
        input.value = weaponKeys[0]!;
        targetState.shipSizeId = weaponKeys[0]!;
    }
}

function renderWeaponFacts(): void {
    if (!weaponFacts) return;
    weaponFacts.textContent = '';
    const weapon = currentWeapon;
    weaponFacts.appendChild(el(
        'div',
        'facts-title',
        weapon ? t('Weapon template', '武器模板') : t('Manual weapon parameters', '手动武器参数'),
    ));

    const grid = el('div', 'facts-grid');
    const rows: Array<[string, string, string?]> = [];
    if (weapon) {
        rows.push([t('Template id', '模板 id'), weapon.id]);
        rows.push([t('Declared as', '顶层声明'), weapon.templateTypeKey]);
        if (weapon.type) rows.push([t('Component type', '组件 type'), weapon.type]);
        rows.push([
            t('Source', '来源'),
            weapon.source === 'workspace' ? t('workspace', '工作区') : t('vanilla', '原版'),
        ]);
        if (weapon.targetableShipSizes.length > 0) {
            rows.push(['targetable_ship_sizes', weapon.targetableShipSizes.join(', ')]);
        }
    } else {
        rows.push([
            t('Template', '模板'),
            t('none selected — the values below are used as typed', '未选择模板 — 直接使用下面填入的数值'),
        ]);
    }

    for (const [label, value, modifier] of rows) {
        const row = el('div', 'fact');
        row.appendChild(el('span', 'fact-label', label));
        row.appendChild(el('span', 'fact-value', value));
        if (modifier) row.appendChild(el('span', 'fact-note', modifier));
        grid.appendChild(row);
    }
    weaponFacts.appendChild(grid);

    if (weapon && weapon.missingKeys.length > 0) {
        weaponFacts.appendChild(el(
            'div',
            'fact-warning',
            t(
                'Missing template fields, estimated with the default value: ' + weapon.missingKeys.join(', '),
                '模板缺失以下字段，已按缺省值估算：' + weapon.missingKeys.join('、'),
            ),
        ));
    }
    if (weapon && weapon.dynamicKeys.length > 0) {
        weaponFacts.appendChild(el(
            'div',
            'fact-warning',
            t(
                'Script expressions, not statically evaluable: ' + weapon.dynamicKeys.join(', '),
                '以下字段使用脚本表达式，无法静态求值：' + weapon.dynamicKeys.join('、'),
            ),
        ));
    }
}

function renderWeaponDatalist(): void {
    if (!weaponDatalist) return;
    weaponDatalist.textContent = '';
    for (const option of weaponOptions) {
        const node = el('option');
        // 值为显示名（本地化名 (id)），label 补来源；输入框内容再反查回 id。
        node.value = option.displayLabel || option.id;
        node.label = option.source === 'workspace'
            ? t('workspace', '工作区')
            : t('vanilla', '原版');
        weaponDatalist.appendChild(node);
    }
}

function weaponIdForLabel(label: string): string | undefined {
    const trimmed = label.trim();
    if (!trimmed) return undefined;
    return weaponOptions.find(option => (option.displayLabel || option.id) === trimmed)?.id;
}

/** 输入不再匹配任何模板 → 切到手动模式（字段仍可编辑，分析照常可用）。 */
function useManualWeapon(): void {
    if (!currentWeapon) return;
    currentWeapon = undefined;
    estimatedTemplateKeys = new Set<string>();
    renderWeaponFacts();
    refreshShipSizeOptions();
    if (btnReveal) btnReveal.disabled = true;
    scheduleCompute();
}

function handleWeaponSearchInput(): void {
    if (!weaponSearch) return;
    const id = weaponIdForLabel(weaponSearch.value);
    if (!id) {
        useManualWeapon();
        return;
    }
    if (currentWeapon?.id === id) return;
    vscode.postMessage({ command: 'selectWeapon', id });
}

// ─── Result rendering ──────────────────────────────────────────────────────────

interface ChainRow {
    label: string;
    detail: string;
    value: number;
    highlight?: boolean;
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.001 || abs >= 100000)) return value.toExponential(3);
    return value.toFixed(4).replace(/0+$/, '').replace(/.$/, '');
}

function renderChain(
    container: HTMLElement | null,
    title: string,
    rows: ChainRow[],
    banner?: HTMLElement,
): void {
    if (!container) return;
    container.textContent = '';
    container.appendChild(el('h2', 'section-title', title));

    const table = el('div', 'chain-table');
    // 条长只吃有限数值：缺失字段让 formatNumber 显示「—」，条宽归零而不是 NaN%。
    const magnitude = (value: number): number => (Number.isFinite(value) ? Math.abs(value) : 0);
    const maxAbs = rows.reduce((acc, row) => Math.max(acc, magnitude(row.value)), 0) || 1;
    for (const row of rows) {
        const entry = el('div', row.highlight ? 'chain-row highlight' : 'chain-row');
        entry.appendChild(el('span', 'chain-label', row.label));
        entry.appendChild(el('span', 'chain-value', formatNumber(row.value)));
        const track = el('span', 'bar-track');
        const bar = el('span', row.highlight ? 'bar-fill accent' : 'bar-fill');
        bar.style.width = Math.min(100, (magnitude(row.value) / maxAbs) * 100).toFixed(2) + '%';
        track.appendChild(bar);
        entry.appendChild(track);
        table.appendChild(entry);
        if (row.detail) table.appendChild(el('div', 'chain-detail', row.detail));
    }
    container.appendChild(table);
    if (banner) container.appendChild(banner);
}

function renderVetoBanner(): HTMLElement {
    const banner = el('div', 'banner veto');
    banner.appendChild(el('strong', undefined, t('VETO — target removed from candidates', 'VETO — 整目标被剔除')));
    banner.appendChild(el('div', undefined, t(
        'Δ > 0 and σatt ≥ σavoidmin and Δ ≥ Tavoid while the fleet still has a hittable ship: the engine returns 0, so this ship never enters the argmax.',
        'Δ > 0 且 σatt ≥ σavoidmin 且 Δ ≥ Tavoid，且目标舰队仍有可命中的船时，引擎直接返回 0：该目标不参与 argmax，不是「排最后」。',
    )));
    return banner;
}

function renderMainTargetBanner(): HTMLElement {
    const banner = el('div', 'banner warn');
    banner.appendChild(el('strong', undefined, 'use_ship_main_target = yes'));
    banner.appendChild(el('div', undefined, t(
        'This weapon follows the ship main target, so the weapon-layer score below does not take effect.',
        '该武器沿用舰船主目标，武器层分数不生效。',
    )));
    return banner;
}

function renderShipChain(result: ChainResultView): ChainRow[] {
    const ship = result.shipChain;
    const f = formatNumber;
    return [
        {
            label: t('W1 · size 1/(1+min(σ,σmax)·κsize)', 'W1 · 尺寸 1/(1+min(σ,σmax)·κsize)'),
            detail: t('min(σ, σmax) = ' + f(ship.sizeCapped), 'min(σ, σmax) = ' + f(ship.sizeCapped)),
            value: ship.W1,
        },
        {
            label: t('W2 · × evasion 1/(1+Δ·κev)', 'W2 · × 闪避 1/(1+Δ·κev)'),
            detail: t('τ = ' + f(ship.shipTracking) + ', Δ = ' + f(ship.evasionDelta), 'τ = ' + f(ship.shipTracking) + '，Δ = ' + f(ship.evasionDelta))
                + t(' · factor ' + f(ship.evasionFactor), ' · 因子 ' + f(ship.evasionFactor)),
            value: ship.W2,
        },
        {
            label: t('W3 · × distance max(1−d·κd, dmin)', 'W3 · × 距离 max(1−d·κd, dmin)'),
            detail: t(
                'factor ' + f(ship.distanceFactor) + ' (d = ' + f(targetState.distance) + ')',
                '因子 ' + f(ship.distanceFactor) + '（d = ' + f(targetState.distance) + '）',
            ),
            value: ship.W3,
        },
        {
            label: t('W4 · × preset weight ŵtgt', 'W4 · × 预置权重 ŵtgt'),
            detail: t(
                'ŵtgt = ' + f(ship.targetWeight) + ' = 1 + ρ + ship_target_weight_mult',
                'ŵtgt = ' + f(ship.targetWeight) + ' = 1 + ρ + ship_target_weight_mult',
            ),
            value: ship.W4,
        },
        {
            label: t('W5 · × low health / unarmed / starbase', 'W5 · × 残血 / 无武装 / 星基'),
            detail: t(
                f(ship.lowHealthFactor) + ' / ' + f(ship.unarmedFactor) + ' / ' + f(ship.starbaseFactor),
                f(ship.lowHealthFactor) + ' / ' + f(ship.unarmedFactor) + ' / ' + f(ship.starbaseFactor),
            ),
            value: ship.W5,
        },
        {
            label: t('W6 · × random factor 1+r·κr', 'W6 · × 随机扰动 1+r·κr'),
            detail: t(
                'factor ' + f(ship.randomFactor) + (optionState.useRandom === true ? '' : ' (off)'),
                '因子 ' + f(ship.randomFactor) + (optionState.useRandom === true ? '' : '（未开启）'),
            ),
            value: ship.W6,
        },
        {
            label: t('W(ship) · final', 'W(ship) · 最终'),
            detail: t('argmax over candidates', '在候选中取 argmax'),
            value: ship.weight,
            highlight: true,
        },
    ];
}

function renderWeaponChain(result: ChainResultView): ChainRow[] {
    const weapon = result.weapon;
    const f = formatNumber;
    return [
        {
            label: t('p · hit chance clamp(acc − clamp(ε−τw,0,1),0,1)', 'p · 命中率 clamp(acc − clamp(ε−τw,0,1),0,1)'),
            detail: t('base damage = ' + f(weapon.baseDamage) + ' (range midpoint)', '基础伤害 = ' + f(weapon.baseDamage) + '（区间中点）'),
            value: weapon.p,
        },
        { label: t('Ds · shield component', 'Ds · 盾分量'), detail: '', value: weapon.damageSplit.Ds },
        { label: t('Da · armor component', 'Da · 甲分量'), detail: '', value: weapon.damageSplit.Da },
        {
            label: t('Dh · hull component (kill check)', 'Dh · 船体分量（斩杀判据）'),
            detail: t('kill bonus triggers when Dh ≥ hull', 'Dh ≥ 船体 时触发斩杀加成'),
            value: weapon.damageSplit.Dh,
        },
        { label: t('ΣD = Ds + Da + Dh', 'ΣD = Ds + Da + Dh'), detail: '', value: weapon.sumD },
        { label: t('S0 = ΣD × p × ŵtgt', 'S0 = ΣD × p × ŵtgt'), detail: '', value: weapon.S0 },
        {
            label: t('S1 = S0 × kill bonus', 'S1 = S0 × 斩杀加成'),
            detail: t('×' + f(weapon.killBonus), '×' + f(weapon.killBonus)),
            value: weapon.S1,
        },
        {
            label: t('S2 = S1 × unarmed penalty', 'S2 = S1 × 无武装降权'),
            detail: t('×' + f(weapon.unarmedPenalty), '×' + f(weapon.unarmedPenalty)),
            value: weapon.S2,
        },
        {
            label: t('wk · target_weights (additive)', 'wk · target_weights（加法项）'),
            detail: t('additive, can outrank the whole chain', '加法项，可以盖过整条乘法链'),
            value: weapon.wk,
        },
        { label: t('S = S2 + wk', 'S = S2 + wk'), detail: '', value: weapon.score },
        {
            label: t('final = S × Mcur × Mrec', 'final = S × Mcur × Mrec'),
            detail: 'Mcur ' + f(weapon.currentTargetMultiplier) + ' · Mrec ' + f(weapon.recentTargetPenalizer),
            value: weapon.final,
            highlight: true,
        },
    ];
}

function renderNotes(result: ChainResultView): void {
    if (!notesEl) return;
    notesEl.textContent = '';
    const ship = result.shipChain;
    const weapon = result.weapon;

    // 提示文案由面板按结果状态自行生成：targetingWeights.ts 的 notes 是中文模块文本，
    // 且该模块不允许修改，直接透传会在英文界面下破坏双语约束。
    const notes: string[] = [
        t(
            'The two layers are independent: the ship layer and the weapon layer each run their own argmax.',
            '两层互不相乘：舰船层与武器层各自 argmax。',
        ),
    ];
    if (!currentWeapon) {
        notes.push(t(
            'No weapon template is selected, so the weapon layer uses the numbers typed in the form.',
            '当前未选择武器模板，武器层使用的是表单里手动填入的数值。',
        ));
    }
    if (result.veto) {
        notes.push(t(
            'Veto: the engine returns 0 for this candidate; it never enters the argmax at all.',
            '触发整目标否决：引擎对该候选直接返回 0，它不参与 argmax，不是「排最后」。',
        ));
    }
    if (ship.evasionDelta <= 0) {
        notes.push(t(
            'Δ ≤ 0: tracking beats evasion, so the ship layer applies no evasion penalty.',
            'Δ ≤ 0：追踪盖过闪避，舰船层不施加闪避惩罚。',
        ));
    }
    if (ship.distanceFactor <= result.distanceWeightMin + 1e-9) {
        notes.push(t(
            'The distance factor hit its floor: beyond 450 the target stops decaying.',
            '距离因子已触下限：d ≥ 450 之后不再衰减。',
        ));
    }
    if (weapon.damageSplit.Ds > 0 || weapon.damageSplit.Da > 0) {
        notes.push(t(
            'Layer components are not clamped by that layer pool, so shields and armor make ΣD larger; high evasion (lower p) is the only real counter.',
            '层分量不被该层存量夹住，所以带盾甲的目标 ΣD 反而更大；唯一有效反制是高闪避（压低 p）。',
        ));
    }
    if (weapon.killBonus > 1) {
        notes.push(t(
            'Kill bonus triggered: the check uses Dh ≥ hull, not total damage.',
            '斩杀加成触发：判据是船体分量 Dh ≥ 目标当前船体，不是总伤。',
        ));
    }
    if (weapon.wk > 0) {
        notes.push(t(
            'wk is additive, so one target_weights entry can outrank the whole multiplicative chain.',
            'wk 是加法项，单个 target_weights 条目就能盖过整条乘法链。',
        ));
    }
    if (optionState.useRandom !== true) {
        notes.push(t(
            'The random factor is off here; the engine enables it by default with a [1, 4) multiplier — a main reason targeting looks unstable.',
            '本面板未启用随机扰动；引擎默认开启，乘数 ∈ [1, 4)，是索敌看起来不稳定的主因之一。',
        ));
    }

    const list = el('ul', 'notes-list');
    for (const note of notes) list.appendChild(el('li', undefined, note));
    notesEl.appendChild(list);
}

/**
 * Host 的结果载荷是 `{ command:'result', usesShipMainTarget, result:{ veto, shipChain, weapon, defines } }`
 * —— 乘法链本体在 `message.result` 里。早期版本在顶层找 `shipChain`，取到 undefined 就整段放弃渲染，
 * 于是「分析」永远得不到结果面板。顶层回退保留给没有 result 信封的旧形状。
 */
function asChainResult(message: Record<string, unknown>): ChainResultView | undefined {
    const envelope = typeof message.result === 'object' && message.result !== null && !Array.isArray(message.result)
        ? message.result as Record<string, unknown>
        : message;
    const shipChain = envelope.shipChain;
    const weaponLayer = envelope.weapon;
    if (typeof shipChain !== 'object' || shipChain === null) return undefined;
    if (typeof weaponLayer !== 'object' || weaponLayer === null) return undefined;
    const defines = envelope.defines;
    const distanceWeightMin = typeof defines === 'object' && defines !== null
        ? Number((defines as Record<string, unknown>).distanceWeightMin ?? 0.1)
        : 0.1;
    return {
        veto: envelope.veto === true,
        // usesShipMainTarget 由 Host 放在结果消息顶层（不在 result 内），两处都认。
        usesShipMainTarget: message.usesShipMainTarget === true || envelope.usesShipMainTarget === true,
        shipChain: shipChain as unknown as ShipChainView,
        weapon: weaponLayer as unknown as WeaponLayerView,
        distanceWeightMin: Number.isFinite(distanceWeightMin) ? distanceWeightMin : 0.1,
    };
}

function renderResult(): void {
    const result = lastResult;
    if (!result) return;
    renderChain(
        shipChainEl,
        t('Stage 1 · ship layer W(ship)', 'Stage 1 · 舰船层 W(ship)'),
        renderShipChain(result),
        result.veto ? renderVetoBanner() : undefined,
    );
    renderChain(
        weaponChainEl,
        t('Stage 2 · weapon layer S(weapon)', 'Stage 2 · 武器层 S(weapon)'),
        renderWeaponChain(result),
        result.usesShipMainTarget ? renderMainTargetBanner() : undefined,
    );
    renderNotes(result);
}

// ─── Messaging ─────────────────────────────────────────────────────────────────

function scheduleCompute(): void {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        requestCompute();
    }, DEBOUNCE_MS);
}

/**
 * 计算永远可发起：武器字段来自表单（有模板就是模板自动填的，没有就是手动值），
 * 缺字段按缺省估算并在表单上标注，所以不存在「请先选择一个武器模板」这种死路。
 */
function requestCompute(): void {
    const maxHull = Number(targetState.maxHull);
    const shipSizeId = targetState.shipSizeId.trim();
    vscode.postMessage({
        command: 'compute',
        weaponId: currentWeapon?.id ?? '',
        weapon: {
            ...weaponInput,
            useShipMainTarget: weaponUseShipMainTarget,
        },
        attacker: {
            tracking: Number(attackerState.tracking ?? 0),
            sizeMultiplier: Number(attackerState.sizeMultiplier ?? 1),
        },
        target: {
            shipSizeId: shipSizeId.length > 0 ? shipSizeId : undefined,
            sizeMultiplier: Number(targetState.sizeMultiplier),
            evasion: Number(targetState.evasion),
            distance: Number(targetState.distance),
            hull: Number(targetState.hull),
            maxHull: Number.isFinite(maxHull) && maxHull > 0 ? maxHull : undefined,
            shield: Number(targetState.shield),
            armor: Number(targetState.armor),
            armed: targetState.armed === true,
            isStarbase: targetState.isStarbase === true,
            isCurrentMainTarget: optionState.isCurrentMainTarget === true,
            isRecentNonLatest: optionState.isRecentNonLatest === true,
        },
        rho: Number(optionState.rho ?? 0),
        targetWeightMultModifier: Number(optionState.targetWeightMultModifier ?? 0),
        randomRoll: Number(optionState.randomRoll ?? 0),
        useRandom: optionState.useRandom === true,
        fleetHasHittable: optionState.fleetHasHittable === true,
        targetFocus: optionState.targetFocus === true,
    });
}

function setStatus(text: string, kind: 'info' | 'error' | 'ok'): void {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'status ' + kind;
}

function readStats(raw: unknown): Record<'workspace' | 'vanilla', ScanStats> {
    const fallback = { workspace: { files: 0, templates: 0 }, vanilla: { files: 0, templates: 0 } };
    if (typeof raw !== 'object' || raw === null) return fallback;
    const record = raw as Record<string, unknown>;
    const read = (key: string): ScanStats => {
        const entry = record[key];
        if (typeof entry !== 'object' || entry === null) return { files: 0, templates: 0 };
        const value = entry as Record<string, unknown>;
        return {
            files: typeof value.files === 'number' ? value.files : 0,
            templates: typeof value.templates === 'number' ? value.templates : 0,
        };
    };
    return { workspace: read('workspace'), vanilla: read('vanilla') };
}

function handleInit(message: Record<string, unknown>): void {
    if (message.locale === 'zh-cn' || message.locale === 'en') locale = message.locale;
    const rawShipSizeOptions = Array.isArray(message.shipSizeOptions) ? message.shipSizeOptions : [];
    shipSizeOptions = rawShipSizeOptions.filter((entry): entry is ShipSizeOption => typeof entry === 'object' && entry !== null);
    const rawWeapons = Array.isArray(message.weapons) ? message.weapons : [];
    weaponOptions = rawWeapons.filter((entry): entry is WeaponOption => typeof entry === 'object' && entry !== null)
        .map(option => ({
            ...option,
            displayLabel: typeof option.displayLabel === 'string' && option.displayLabel
                ? option.displayLabel
                : option.id,
        }));
    scannedShipSizes = Array.isArray(message.shipSizes)
        ? message.shipSizes.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
    const rawDefaults = typeof message.weaponDefaults === 'object' && message.weaponDefaults !== null
        ? message.weaponDefaults as Record<string, unknown>
        : undefined;
    if (rawDefaults) {
        const readNumber = (key: string, fallback: number): number => {
            const value = rawDefaults[key];
            return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
        };
        weaponDefaults = {
            minDamage: readNumber('min_damage', weaponDefaults.minDamage),
            maxDamage: readNumber('max_damage', weaponDefaults.maxDamage),
            accuracy: readNumber('accuracy', weaponDefaults.accuracy),
            tracking: readNumber('tracking', weaponDefaults.tracking),
            shieldDamage: readNumber('shield_damage', weaponDefaults.shieldDamage),
            armorDamage: readNumber('armor_damage', weaponDefaults.armorDamage),
            hullDamage: readNumber('hull_damage', weaponDefaults.hullDamage),
            shieldPenetration: readNumber('shield_penetration', weaponDefaults.shieldPenetration),
            armorPenetration: readNumber('armor_penetration', weaponDefaults.armorPenetration),
            sizeDamageFactor: readNumber('size_damage_factor', weaponDefaults.sizeDamageFactor),
            targetWeights: {},
        };
        weaponInput = { ...weaponDefaults, targetWeights: {} };
    }
    if (loadingEl) loadingEl.classList.add('hidden');

    if (presetSelect) {
        presetSelect.textContent = '';
        const custom = el('option');
        custom.value = '';
        custom.textContent = t('Custom / manual', '自定义 / 手动');
        presetSelect.appendChild(custom);
        for (const shipSize of shipSizeOptions) {
            const option = el('option');
            option.value = shipSize.id;
            option.textContent = shipSize.label;
            presetSelect.appendChild(option);
        }
    }

    renderWeaponDatalist();
    buildTargetForms();
    buildWeaponForm();
    renderWeaponFacts();
    refreshShipSizeOptions();
    if (btnReveal) btnReveal.disabled = true;

    if (weaponOptions.length === 0) {
        setStatus(t(
            'No weapon component template was found under common/component_templates in the workspace or the configured game roots. Weapon fields can still be filled in manually.',
            '在工作区与已配置游戏根的 common/component_templates 下没有找到武器组件模板；仍可手动填写武器参数后分析。',
        ), 'error');
        scheduleCompute();
        return;
    }
    const stats = readStats(message.stats);
    setStatus(
        t(
            weaponOptions.length + ' weapon templates · workspace ' + stats.workspace.templates + ' / vanilla '
                + stats.vanilla.templates + ' · ' + scannedShipSizes.length + ' ship sizes',
            '解析出 ' + weaponOptions.length + ' 个武器模板（工作区 ' + stats.workspace.templates
                + ' / 原版 ' + stats.vanilla.templates + '）· ' + scannedShipSizes.length + ' 个 ship_size',
        ),
        'ok',
    );
    // 初始模板只由 Host 下发（右键菜单带入的 id 优先，否则第一条）：
    // 这里再抢发一次 selectWeapon 会和光标预选赛跑，把用户光标处的模板覆盖掉。
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toWeaponInput(raw: unknown): WeaponInput {
    const source = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const read = (key: WeaponInputKey, fallback: number): number => {
        const value = source[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    const weights: Record<string, number> = {};
    const rawWeights = source.targetWeights;
    if (typeof rawWeights === 'object' && rawWeights !== null && !Array.isArray(rawWeights)) {
        for (const [key, value] of Object.entries(rawWeights as Record<string, unknown>)) {
            if (key && typeof value === 'number' && Number.isFinite(value)) weights[key] = value;
        }
    }
    return {
        minDamage: read('minDamage', weaponDefaults.minDamage),
        maxDamage: read('maxDamage', weaponDefaults.maxDamage),
        accuracy: read('accuracy', weaponDefaults.accuracy),
        tracking: read('tracking', weaponDefaults.tracking),
        shieldDamage: read('shieldDamage', weaponDefaults.shieldDamage),
        armorDamage: read('armorDamage', weaponDefaults.armorDamage),
        hullDamage: read('hullDamage', weaponDefaults.hullDamage),
        shieldPenetration: read('shieldPenetration', weaponDefaults.shieldPenetration),
        armorPenetration: read('armorPenetration', weaponDefaults.armorPenetration),
        sizeDamageFactor: read('sizeDamageFactor', weaponDefaults.sizeDamageFactor),
        targetWeights: weights,
    };
}

/**
 * Host 下发的模板载荷形如 { command:'weapon', weapon:{…} }；
 * 字段全在 message.weapon 上（早期版本误读顶层，导致 id 变空串、
 * 分析永远报「请先选择一个武器模板」、跳转静默失败、字段渲染成 undefined）。
 */
function handleWeapon(message: Record<string, unknown>): void {
    const payload = typeof message.weapon === 'object' && message.weapon !== null && !Array.isArray(message.weapon)
        ? message.weapon as Record<string, unknown>
        : message;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const known = weaponOptions.find(option => option.id === id);
    currentWeapon = {
        id,
        displayLabel: typeof payload.displayLabel === 'string' && payload.displayLabel
            ? payload.displayLabel
            : (known?.displayLabel ?? id),
        templateTypeKey: typeof payload.templateTypeKey === 'string' ? payload.templateTypeKey : '',
        type: typeof payload.type === 'string' ? payload.type : undefined,
        source: payload.source === 'vanilla' ? 'vanilla' : 'workspace',
        useShipMainTarget: payload.useShipMainTarget === true,
        targetWeightKeys: asStringArray(payload.targetWeightKeys),
        targetableShipSizes: asStringArray(payload.targetableShipSizes),
        missingKeys: asStringArray(payload.missingKeys),
        dynamicKeys: asStringArray(payload.dynamicKeys),
        csvKeys: asStringArray(payload.csvKeys),
        input: toWeaponInput(payload.input),
    };
    weaponInput = { ...currentWeapon.input, targetWeights: { ...currentWeapon.input.targetWeights } };
    weaponUseShipMainTarget = currentWeapon.useShipMainTarget;
    estimatedTemplateKeys = new Set<string>([...currentWeapon.missingKeys, ...currentWeapon.dynamicKeys]);
    csvTemplateKeys = new Set<string>(currentWeapon.csvKeys ?? []);
    targetableShipSizesText = currentWeapon.targetableShipSizes.join(' ');

    if (weaponSearch && weaponSearch.value.trim() !== currentWeapon.displayLabel) {
        weaponSearch.value = currentWeapon.displayLabel;
    }
    if (btnReveal) btnReveal.disabled = !currentWeapon.id;
    buildWeaponForm();
    renderWeaponFacts();
    refreshShipSizeOptions();
    scheduleCompute();
}

function handleMessage(message: Record<string, unknown>): void {
    switch (message.command) {
        case 'init':
            handleInit(message);
            break;
        case 'weapon':
            handleWeapon(message);
            break;
        case 'result':
            lastResult = asChainResult(message);
            renderResult();
            break;
        case 'loading':
            if (loadingEl) {
                loadingEl.classList.remove('hidden');
                loadingEl.textContent = typeof message.text === 'string' ? message.text : t('Loading...', '加载中...');
            }
            break;
        case 'error':
            setStatus(typeof message.message === 'string' ? message.message : t('Failed.', '失败。'), 'error');
            break;
    }
}

on(window, 'message', event => {
    const data: unknown = (event as MessageEvent).data;
    if (!data || typeof data !== 'object') return;
    handleMessage(data as Record<string, unknown>);
});

if (presetSelect) on(presetSelect, 'change', () => applyShipSizeOption(presetSelect.value));
if (weaponSearch) {
    on(weaponSearch, 'input', handleWeaponSearchInput);
    on(weaponSearch, 'change', handleWeaponSearchInput);
}
if (btnCompute) on(btnCompute, 'click', () => requestCompute());
if (btnReveal) {
    on(btnReveal, 'click', () => {
        if (currentWeapon?.id) vscode.postMessage({ command: 'revealWeapon', id: currentWeapon.id });
    });
}
on(window, 'pagehide', () => disposeAll());

vscode.postMessage({ command: 'ready' });
