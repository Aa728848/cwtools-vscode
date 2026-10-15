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

interface PresetOption {
    id: string;
    label: string;
    sizeMultiplier: number;
    evasion: number;
    distance: number;
    hull: number;
    maxHull: number;
    shield: number;
    armor: number;
    armed: boolean;
    isStarbase: boolean;
    shipSizeId: string;
}

interface WeaponOption {
    id: string;
    templateTypeKey: string;
    type?: string;
    source: 'workspace' | 'vanilla';
    useShipMainTarget: boolean;
    targetWeightKeys: string[];
    missingKeys: string[];
    dynamicKeys: string[];
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
const weaponSelect = document.getElementById('weapon-select') as HTMLSelectElement | null;
const btnReveal = document.getElementById('btn-reveal') as HTMLButtonElement | null;
const btnCompute = document.getElementById('btn-compute') as HTMLButtonElement | null;
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const formBody = document.getElementById('form-body');
const attackerBody = document.getElementById('attacker-body');
const optionsBody = document.getElementById('options-body');
const weaponFacts = document.getElementById('weapon-facts');
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

let targetState: TargetFormState = {
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

let presets: PresetOption[] = [];
let currentWeapon: WeaponDetail | undefined;
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

function buildForms(): void {
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

function applyPreset(presetId: string): void {
    const preset = presets.find(entry => entry.id === presetId);
    if (!preset) return;
    targetState = {
        sizeMultiplier: preset.sizeMultiplier,
        evasion: preset.evasion,
        distance: preset.distance,
        hull: preset.hull,
        maxHull: preset.maxHull,
        shield: preset.shield,
        armor: preset.armor,
        shipSizeId: preset.shipSizeId,
        armed: preset.armed,
        isStarbase: preset.isStarbase,
    };
    buildForms();
    refreshShipSizeOptions();
    scheduleCompute();
}

// ─── Weapon catalogue ──────────────────────────────────────────────────────────

function refreshShipSizeOptions(): void {
    const datalist = document.getElementById('ship-size-options');
    const input = document.getElementById('ship-size-id');
    if (!datalist || !(input instanceof HTMLInputElement)) return;
    datalist.textContent = '';
    const keys = currentWeapon?.targetWeightKeys ?? [];
    for (const key of keys) {
        const option = el('option');
        option.value = key;
        datalist.appendChild(option);
    }
    if (keys.length > 0 && !keys.includes(input.value)) {
        input.value = keys[0]!;
        targetState.shipSizeId = keys[0]!;
    }
}

function renderWeaponFacts(): void {
    if (!weaponFacts) return;
    weaponFacts.textContent = '';
    const weapon = currentWeapon;
    if (!weapon) return;

    weaponFacts.appendChild(el('div', 'facts-title', t('Weapon template fields', '武器模板字段')));
    const grid = el('div', 'facts-grid');
    const input = weapon.input;
    const rows: Array<[string, string]> = [
        [t('Damage range', '伤害区间'), input.minDamage + ' – ' + input.maxDamage],
        [t('Accuracy acc', '命中率 acc'), String(input.accuracy)],
        [t('Tracking trk', '追踪率 trk'), String(input.tracking)],
        [t('Shield / armor / hull', '盾 / 甲 / 船体倍率'), input.shieldDamage + ' / ' + input.armorDamage + ' / ' + input.hullDamage],
        [t('Penetration', '穿透'), input.shieldPenetration + ' / ' + input.armorPenetration],
        ['size_damage_factor', String(input.sizeDamageFactor)],
        ['use_ship_main_target', weapon.useShipMainTarget ? t('yes', '是') : t('no', '否')],
        [t('Declared as', '顶层声明'), weapon.templateTypeKey],
        [t('Source', '来源'), weapon.source === 'workspace' ? t('workspace', '工作区') : t('vanilla', '原版')],
    ];
    for (const [label, value] of rows) {
        const row = el('div', 'fact');
        row.appendChild(el('span', 'fact-label', label));
        row.appendChild(el('span', 'fact-value', value));
        grid.appendChild(row);
    }
    weaponFacts.appendChild(grid);

    const weightEntries = Object.entries(input.targetWeights).sort((a, b) => a[0].localeCompare(b[0]));
    if (weightEntries.length > 0) {
        const list = el('div', 'fact');
        list.appendChild(el('span', 'fact-label', t('target_weights (additive wk)', 'target_weights（加法项 wk）')));
        list.appendChild(el('span', 'fact-value', weightEntries.map(([key, value]) => key + '=' + value).join('  ')));
        weaponFacts.appendChild(list);
    }
    if (weapon.targetableShipSizes.length > 0) {
        const list = el('div', 'fact');
        list.appendChild(el('span', 'fact-label', t('targetable_ship_sizes', 'targetable_ship_sizes')));
        list.appendChild(el('span', 'fact-value', weapon.targetableShipSizes.join(', ')));
        weaponFacts.appendChild(list);
    }
    if (weapon.missingKeys.length > 0) {
        weaponFacts.appendChild(el(
            'div',
            'fact-warning',
            t(
                'Missing template fields, estimated with the default value: ' + weapon.missingKeys.join(', '),
                '模板缺失以下字段，已按缺省值估算：' + weapon.missingKeys.join('、'),
            ),
        ));
    }
    if (weapon.dynamicKeys.length > 0) {
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
    const maxAbs = rows.reduce((acc, row) => Math.max(acc, Math.abs(row.value)), 0) || 1;
    for (const row of rows) {
        const entry = el('div', row.highlight ? 'chain-row highlight' : 'chain-row');
        entry.appendChild(el('span', 'chain-label', row.label));
        entry.appendChild(el('span', 'chain-value', formatNumber(row.value)));
        const track = el('span', 'bar-track');
        const bar = el('span', row.highlight ? 'bar-fill accent' : 'bar-fill');
        bar.style.width = Math.min(100, (Math.abs(row.value) / maxAbs) * 100).toFixed(2) + '%';
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

function asChainResult(message: Record<string, unknown>): ChainResultView | undefined {
    const shipChain = message.shipChain;
    const weaponLayer = message.weapon;
    if (typeof shipChain !== 'object' || shipChain === null) return undefined;
    if (typeof weaponLayer !== 'object' || weaponLayer === null) return undefined;
    const defines = message.defines;
    const distanceWeightMin = typeof defines === 'object' && defines !== null
        ? Number((defines as Record<string, unknown>).distanceWeightMin ?? 0.1)
        : 0.1;
    return {
        veto: message.veto === true,
        usesShipMainTarget: message.usesShipMainTarget === true,
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

function requestCompute(): void {
    if (!currentWeapon) return;
    const maxHull = Number(targetState.maxHull);
    const shipSizeId = targetState.shipSizeId.trim();
    vscode.postMessage({
        command: 'compute',
        weaponId: currentWeapon.id,
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

function handleInit(message: Record<string, unknown>): void {
    if (message.locale === 'zh-cn' || message.locale === 'en') locale = message.locale;
    const rawPresets = Array.isArray(message.presets) ? message.presets : [];
    presets = rawPresets.filter((entry): entry is PresetOption => typeof entry === 'object' && entry !== null);
    const rawWeapons = Array.isArray(message.weapons) ? message.weapons : [];
    const weaponOptions = rawWeapons.filter((entry): entry is WeaponOption => typeof entry === 'object' && entry !== null);
    if (loadingEl) loadingEl.classList.add('hidden');

    if (presetSelect) {
        presetSelect.textContent = '';
        for (const preset of presets) {
            const option = el('option');
            option.value = preset.id;
            option.textContent = preset.label;
            presetSelect.appendChild(option);
        }
    }

    if (weaponSelect) {
        weaponSelect.textContent = '';
        for (const weapon of weaponOptions) {
            const option = el('option');
            option.value = weapon.id;
            option.textContent = weapon.id
                + (weapon.type ? ' (' + weapon.type + ')' : '')
                + (/(_component_template|starbase)$/.test(weapon.templateTypeKey) ? ' {' + weapon.templateTypeKey + '}' : '')
                + (weapon.useShipMainTarget ? t(' · ship main target', ' · 沿用舰船主目标') : '');
            weaponSelect.appendChild(option);
        }
    }

    buildForms();

    if (weaponOptions.length === 0) {
        setStatus(t(
            'No weapon component template was found under common/component_templates in the workspace or the configured game roots.',
            '在工作区与已配置游戏根的 common/component_templates 下没有找到武器组件模板。',
        ), 'error');
        return;
    }
    const scanned = typeof message.scannedFileCount === 'number' ? message.scannedFileCount : 0;
    setStatus(
        t(weaponOptions.length + ' weapon templates from ' + scanned + ' files.', '从 ' + scanned + ' 个文件里解析出 ' + weaponOptions.length + ' 个武器模板。'),
        'ok',
    );
}

function handleWeapon(message: Record<string, unknown>): void {
    const rawInput = message.input;
    currentWeapon = {
        id: typeof message.id === 'string' ? message.id : '',
        templateTypeKey: typeof message.templateTypeKey === 'string' ? message.templateTypeKey : '',
        type: typeof message.type === 'string' ? message.type : undefined,
        source: message.source === 'vanilla' ? 'vanilla' : 'workspace',
        useShipMainTarget: message.useShipMainTarget === true,
        targetWeightKeys: Array.isArray(message.targetWeightKeys) ? (message.targetWeightKeys as string[]) : [],
        missingKeys: Array.isArray(message.missingKeys) ? (message.missingKeys as string[]) : [],
        dynamicKeys: Array.isArray(message.dynamicKeys) ? (message.dynamicKeys as string[]) : [],
        targetableShipSizes: Array.isArray(message.targetableShipSizes) ? (message.targetableShipSizes as string[]) : [],
        input: (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as WeaponInput,
    };
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

if (presetSelect) on(presetSelect, 'change', () => applyPreset(presetSelect.value));
if (weaponSelect) {
    on(weaponSelect, 'change', () => {
        vscode.postMessage({ command: 'selectWeapon', id: weaponSelect.value });
    });
}
if (btnCompute) on(btnCompute, 'click', () => requestCompute());
if (btnReveal) {
    on(btnReveal, 'click', () => {
        if (currentWeapon) vscode.postMessage({ command: 'revealWeapon', id: currentWeapon.id });
    });
}
on(window, 'pagehide', () => disposeAll());

vscode.postMessage({ command: 'ready' });
