/**
 * Stellaris 4.5.2 战斗索敌权重计算（纯计算，无副作用）。
 *
 * 实现 docs/stellaris-targeting-weight-4.5.2.md §2（舰船层乘法链 W1..W6 与整目标否决）
 * 与 §3（武器层 p / ΣD 三层分摊 / S0..S + wk 加法项）的**归一化形式**：把引擎内部的
 * 定点数 F = 100000 当作实数 1.0，除法按 C 风格向零截断的误差忽略不计。
 *
 * 两层互不相乘，各自 argmax（CShipTargeting::CalcBestTarget 与
 * CWeaponComponentTargeting::CalcBestTarget）；武器模板写 use_ship_main_target = yes 时
 * 武器直接沿用舰船主目标，武器层分数不参与（误区 8）。
 *
 * 本模块刻意不 import vscode / fs / path，供后续 webview 面板（P3-1）直接复用。
 */

/** 索敌相关 define 的语义化视图，字段名对应 vanilla 00_defines.txt 里的 define。 */
export interface TargetingDefines {
    /** COMBAT_SHIP_TARGETING_SIZE_MULT */
    sizeSlope: number;
    /** COMBAT_SHIP_TARGETING_SIZE_MAX */
    sizeMax: number;
    /** COMBAT_SHIP_TARGETING_TRACKING_MULT */
    trackingMult: number;
    /** COMBAT_SHIP_EVASION_TARGETING_WEIGHT */
    evasionWeight: number;
    /** COMBAT_SHIP_LOW_HEALTH_THRESHOLD */
    lowHealthThreshold: number;
    /** COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT */
    lowHealthWeight: number;
    /** COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT */
    distanceWeight: number;
    /** COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN */
    distanceWeightMin: number;
    /** COMBAT_SHIP_UNARMED_TARGETING_WEIGHT */
    unarmedWeight: number;
    /** COMBAT_SHIP_STARBASE_TARGETING_WEIGHT */
    starbaseWeight: number;
    /** COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE */
    avoidMinShipSize: number;
    /** COMBAT_SHIP_EVASION_AVOID_THRESHOLD */
    avoidThreshold: number;
    /** RANDOM_TARGETING_WEIGHT */
    randomWeight: number;
    /** SHIP_CURRENT_TARGET_MULTIPLIER */
    currentTargetMultiplier: number;
    /** SHIP_RECENT_TARGET_PENALIZER */
    recentTargetPenalizer: number;
}

/** vanilla 取值（Stellaris 4.5.2 common/defines/00_defines.txt, NCombat / NShip）。 */
export const VANILLA_TARGETING_DEFINES: TargetingDefines = {
    sizeSlope: 0.03,
    sizeMax: 10,
    trackingMult: 2.0,
    evasionWeight: 2.0,
    lowHealthThreshold: 0.5,
    lowHealthWeight: 1.5,
    distanceWeight: 0.002,
    distanceWeightMin: 0.10,
    unarmedWeight: 0.005,
    starbaseWeight: 0.75,
    avoidMinShipSize: 8,
    avoidThreshold: 0.7,
    randomWeight: 3.0,
    currentTargetMultiplier: 1.1,
    recentTargetPenalizer: 0.3,
};

/** NShip 块常量：尺寸放大上限 MAX_DAMAGE_SCALING。 */
const MAX_DAMAGE_SCALING = 100;

export interface TargetingAttackerInput {
    /** 攻击方舰船追踪（0..1，引擎要求）。 */
    tracking: number;
    /** 攻击方 combat_size_multiplier。 */
    sizeMultiplier: number;
}

export interface TargetingWeaponInput {
    minDamage: number;
    maxDamage: number;
    /** accuracy（0..1）。 */
    accuracy: number;
    /** tracking（0..1），武器模板追踪率，不乘 κtrk。 */
    tracking: number;
    /** shield_damage (ms)。 */
    shieldDamage: number;
    /** armor_damage (ma)。 */
    armorDamage: number;
    /** hull_damage (mh)。 */
    hullDamage: number;
    shieldPenetration?: number;
    armorPenetration?: number;
    sizeDamageFactor?: number;
    /** target_weights 表：键为 ship_size id，值为**加法项** wk。 */
    targetWeights?: Record<string, number>;
}

export interface TargetingTargetInput {
    /** ship_size id，用于查 weapon.targetWeights。 */
    shipSizeId?: string;
    /** 候选船 combat_size_multiplier (σ)。 */
    sizeMultiplier: number;
    /** 候选闪避 (ε)，引擎上限 SHIP_MAX_EVASION = 0.9。 */
    evasion: number;
    /** 候选距离（引擎单位）。 */
    distance: number;
    /** 当前船体 (Vtgt)，也是斩杀判据的右端。 */
    hull: number;
    /** 船体上限；缺省时不做残血判定。 */
    maxHull?: number;
    shield: number;
    armor: number;
    shieldHardening?: number;
    armorHardening?: number;
    /** 面板 DPD > 0（有能力还手）；两层的无武装降权都用它。 */
    armed: boolean;
    isStarbase?: boolean;
    isCurrentMainTarget?: boolean;
    /** 在"最近目标记忆"中且非最新一项。 */
    isRecentNonLatest?: boolean;
}

export interface TargetingChainInput {
    attacker: TargetingAttackerInput;
    weapon: TargetingWeaponInput;
    target: TargetingTargetInput;
    /** 覆盖任意 define；未给出的项用 vanilla 值。 */
    defines?: Partial<TargetingDefines>;
    /** 开战随机量 ρ ∈ [0, 1)，每场战斗每艘船各掷一次，整场不变。 */
    rho?: number;
    /** ship_target_weight_mult 修正值（如光环组件的 +0.5）。 */
    targetWeightMultModifier?: number;
    /** 随机扰动 r ∈ [0, 1)，仅在 useRandom 为 true 时生效。 */
    randomRoll?: number;
    /** CalcBestTarget 的 useRandom；默认关闭以便复现确定性结果。 */
    useRandom?: boolean;
    /** 目标舰队里是否存在至少一艘"可命中"的船；否决判据的第四项。 */
    fleetHasHittable?: boolean;
    /** true = 武器组件 target_focus = spread（引擎 targetFocus = 1）：Mcur 不施加。 */
    targetFocus?: boolean;
}

export interface TargetingShipChain {
    /** true = 整目标被剔除（return 0），不参与 argmax，不是"排最后"。 */
    veto: boolean;
    /** 否决判据逐项取值，便于诊断是哪一项没过。 */
    vetoCheck: {
        /** Δ = ε − τ > 0 */
        evasionDeltaPositive: boolean;
        /** σatt >= σavoidmin */
        attackerSizeLargeEnough: boolean;
        /** Δ >= Tavoid */
        deltaAboveThreshold: boolean;
        /** 目标舰队存在可命中目标 */
        fleetHasHittable: boolean;
    };
    /** min(σ, σmax) */
    sizeCapped: number;
    W1: number;
    /** τ = atrk · κtrk */
    shipTracking: number;
    /** Δ = ε − τ */
    evasionDelta: number;
    /** 1/(1 + Δ·κev)；Δ <= 0 时为 1（无惩罚）。 */
    evasionFactor: number;
    W2: number;
    distanceFactor: number;
    W3: number;
    /** ŵtgt = 1 + ρ + ship_target_weight_mult */
    targetWeight: number;
    W4: number;
    lowHealthFactor: number;
    unarmedFactor: number;
    starbaseFactor: number;
    W5: number;
    randomFactor: number;
    W6: number;
    /** 舰船层最终权重 W(ship)，被否决时为 0。 */
    weight: number;
}

export interface TargetingWeaponLayer {
    /** 命中率 p。 */
    p: number;
    /** 区间中点（索敌路径 useRandom = false）。 */
    baseDamage: number;
    damageSplit: {
        /** 盾分量 ms·Cs */
        Ds: number;
        /** 甲分量 ma·Ca */
        Da: number;
        /** 船体分量 mh·剩余伤害；斩杀判据用的是它。 */
        Dh: number;
    };
    /** ΣD = Ds + Da + Dh */
    sumD: number;
    S0: number;
    /** 斩杀加成倍率（1.5 或 1）。 */
    killBonus: number;
    S1: number;
    /** 无武装降权倍率（κun 或 1）。 */
    unarmedPenalty: number;
    S2: number;
    /** target_weights 加法项；未命中为 0。 */
    wk: number;
    /** S = S2 + wk */
    score: number;
    /** 当前主目标粘性倍率（Mcur 或 1）。 */
    currentTargetMultiplier: number;
    /** 近期记忆惩罚倍率（Mrec 或 1）。 */
    recentTargetPenalizer: number;
    /** S(weapon) 最终比较值 = score × Mcur × Mrec。 */
    final: number;
}

export interface TargetingChainResult {
    veto: boolean;
    shipChain: TargetingShipChain;
    weapon: TargetingWeaponLayer;
    /** 本次实际生效的 define 值（vanilla + 覆盖），便于核对"改了 define 会怎样"。 */
    defines: TargetingDefines;
    notes: string[];
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function resolveDefines(partial?: Partial<TargetingDefines>): TargetingDefines {
    const merged: TargetingDefines = { ...VANILLA_TARGETING_DEFINES };
    if (!partial) {
        return merged;
    }
    for (const key of Object.keys(VANILLA_TARGETING_DEFINES) as Array<keyof TargetingDefines>) {
        const value = partial[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * 计算单个候选目标的完整索敌权重链。纯函数：不读文件、不依赖 vscode。
 */
export function computeTargetingChain(input: TargetingChainInput): TargetingChainResult {
    const defs = resolveDefines(input.defines);
    const attacker = input.attacker;
    const weapon = input.weapon;
    const target = input.target;

    // ---- 舰船层（§2） ----------------------------------------------------
    const sizeCapped = Math.min(target.sizeMultiplier, defs.sizeMax);
    const W1 = 1 / (1 + sizeCapped * defs.sizeSlope);
    const shipTracking = attacker.tracking * defs.trackingMult;
    const evasionDelta = target.evasion - shipTracking;
    const vetoCheck = {
        evasionDeltaPositive: evasionDelta > 0,
        attackerSizeLargeEnough: attacker.sizeMultiplier >= defs.avoidMinShipSize,
        deltaAboveThreshold: evasionDelta >= defs.avoidThreshold,
        fleetHasHittable: input.fleetHasHittable === true,
    };
    const veto = vetoCheck.evasionDeltaPositive
        && vetoCheck.attackerSizeLargeEnough
        && vetoCheck.deltaAboveThreshold
        && vetoCheck.fleetHasHittable;
    const evasionFactor = evasionDelta > 0 ? 1 / (1 + evasionDelta * defs.evasionWeight) : 1;
    const distanceFactor = Math.max(1 - target.distance * defs.distanceWeight, defs.distanceWeightMin);
    const targetWeight = 1 + (input.rho ?? 0) + (input.targetWeightMultModifier ?? 0);

    const maxHull = target.maxHull;
    const hasHealthRatio = typeof maxHull === 'number' && Number.isFinite(maxHull) && maxHull > 0;
    const healthRatio = hasHealthRatio ? clamp(target.hull / (maxHull as number), 0, 1) : null;
    const lowHealthFactor = healthRatio !== null && healthRatio < defs.lowHealthThreshold ? defs.lowHealthWeight : 1;
    const unarmedFactor = target.armed ? 1 : defs.unarmedWeight;
    const starbaseFactor = target.isStarbase === true && target.isCurrentMainTarget !== true
        ? defs.starbaseWeight
        : 1;
    const randomRoll = clamp(input.randomRoll ?? 0, 0, 1);
    const randomFactor = input.useRandom === true ? 1 + randomRoll * defs.randomWeight : 1;

    // 引擎在否决时直接 return 0，后续各项不再计算；这里保留因子供诊断，但把 W2..W6 归零。
    const W2 = veto ? 0 : W1 * evasionFactor;
    const W3 = veto ? 0 : W2 * distanceFactor;
    const W4 = veto ? 0 : W3 * targetWeight;
    const W5 = veto ? 0 : W4 * lowHealthFactor * unarmedFactor * starbaseFactor;
    const W6 = veto ? 0 : W5 * randomFactor;

    const shipChain: TargetingShipChain = {
        veto,
        vetoCheck,
        sizeCapped,
        W1,
        shipTracking,
        evasionDelta,
        evasionFactor,
        W2,
        distanceFactor,
        W3,
        targetWeight,
        W4,
        lowHealthFactor,
        unarmedFactor,
        starbaseFactor,
        W5,
        randomFactor,
        W6,
        weight: W6,
    };

    // ---- 武器层（§3） ----------------------------------------------------
    const baseDamage = (weapon.minDamage + weapon.maxDamage) / 2;
    const sizeFactor = weapon.sizeDamageFactor ?? 0;
    const scaledDamage = sizeFactor > 0
        ? baseDamage * (1 + clamp(target.sizeMultiplier, 1, MAX_DAMAGE_SCALING) * sizeFactor)
        : baseDamage;

    // D 在每一层都被 min(·) 扣减，层分量本身不被该层存量夹住——这就是"盾甲吸引仇恨"的根因。
    let remaining = scaledDamage;
    let Ds = 0;
    let Da = 0;
    if (target.shield > 0) {
        const s = clamp((weapon.shieldPenetration ?? 0) - (target.shieldHardening ?? 0), 0, 1);
        const Cs = (1 - s) * remaining;
        remaining -= Math.min(Cs, target.shield);
        Ds = weapon.shieldDamage * Cs;
    }
    if (target.armor > 0) {
        const a = clamp((weapon.armorPenetration ?? 0) - (target.armorHardening ?? 0), 0, 1);
        const Ca = (1 - a) * remaining;
        remaining -= Math.min(Ca, target.armor);
        Da = weapon.armorDamage * Ca;
    }
    const Dh = weapon.hullDamage * remaining;

    const p = clamp(
        weapon.accuracy - clamp(target.evasion - weapon.tracking, 0, 1),
        0,
        1,
    );
    const sumD = Ds + Da + Dh;
    const S0 = sumD * p * targetWeight;
    const killBonus = Dh >= target.hull ? 1.5 : 1;
    const S1 = S0 * killBonus;
    const unarmedPenalty = target.armed ? 1 : defs.unarmedWeight;
    const S2 = S1 * unarmedPenalty;
    const wk = target.shipSizeId !== undefined ? weapon.targetWeights?.[target.shipSizeId] ?? 0 : 0;
    const score = S2 + wk;
    const currentTargetMultiplier = target.isCurrentMainTarget === true && input.targetFocus !== true
        ? defs.currentTargetMultiplier
        : 1;
    const recentTargetPenalizer = target.isRecentNonLatest === true ? defs.recentTargetPenalizer : 1;

    const weaponLayer: TargetingWeaponLayer = {
        p,
        baseDamage,
        damageSplit: { Ds, Da, Dh },
        sumD,
        S0,
        killBonus,
        S1,
        unarmedPenalty,
        S2,
        wk,
        score,
        currentTargetMultiplier,
        recentTargetPenalizer,
        final: score * currentTargetMultiplier * recentTargetPenalizer,
    };

    const notes = buildNotes(input, defs, shipChain, weaponLayer, healthRatio !== null);
    return { veto, shipChain, weapon: weaponLayer, defines: defs, notes };
}

function buildNotes(
    input: TargetingChainInput,
    defs: TargetingDefines,
    shipChain: TargetingShipChain,
    weaponLayer: TargetingWeaponLayer,
    hasHealthRatio: boolean,
): string[] {
    const notes: string[] = [];
    notes.push('两层互不相乘：舰船层与武器层各自 argmax；武器模板写 use_ship_main_target = yes 时武器直接沿用舰船主目标，武器层分数不参与（误区 8）。');
    notes.push('索敌不是每 tick 重算：已有有效主目标时只在 (TotalTicks + shipID) mod fp == 0 的 tick 重算，fp = 50（targetFocus = 1）或 10。');

    if (shipChain.veto) {
        notes.push('触发整目标否决：直接 return 0，该候选从候选集中剔除，不参与 argmax（误区 6）。判据为 Δ>0 且 σatt ≥ σavoidmin 且 Δ ≥ Tavoid 且目标舰队存在可命中目标。');
    }
    if (shipChain.evasionDelta <= 0) {
        notes.push('Δ ≤ 0（追踪盖过闪避），舰船层不施加闪避惩罚。');
    }
    if (shipChain.distanceFactor === defs.distanceWeightMin) {
        notes.push(`距离因子已触下限 ${defs.distanceWeightMin}（d ≥ ${(1 - defs.distanceWeightMin) / defs.distanceWeight}），更远不再衰减。`);
    }
    if (input.randomRoll === undefined && input.useRandom !== true) {
        notes.push(`本次未启用随机扰动（useRandom 默认 false）。引擎默认开启，末项乘数 ∈ [1, 1+κr) = [1, ${1 + defs.randomWeight})，是索敌不稳定的主因之一（误区 10）。`);
    }
    if (!hasHealthRatio) {
        notes.push('未提供 target.maxHull，舰船层不做残血判定（h < θh 收人头加成未生效）。');
    }
    if (weaponLayer.damageSplit.Ds > 0 || weaponLayer.damageSplit.Da > 0) {
        notes.push('目标带盾/甲：层分量不被该层存量夹住，只有从剩余伤害里扣减的量才被 min 夹住，所以 ΣD 反而更大。有效反制只有高闪避（压低 p）（误区 1）。');
    }
    if (weaponLayer.killBonus > 1) {
        notes.push('斩杀加成触发：判据是船体分量 Dh ≥ 目标当前船体，不是总伤（误区 7）。');
    }
    if (weaponLayer.wk > 0) {
        notes.push('命中 weapon.target_weights：wk 是**加法项**而非倍率，可以盖过整条乘法链，用法与直觉相反（误区 4）。');
    }
    if (input.rho !== undefined && input.rho > 0) {
        notes.push('ρ 是开战瞬间每艘船各掷一次、整场不变的随机量，所以两条设计完全相同的船每场战斗的 ŵtgt 也不同（误区 5）。');
    }
    notes.push('ai_weight 是 AI 建造/决策权重，与战斗索敌无关（误区 2）。');
    return notes;
}

/** 工具调用入口：校验并收窄不可信的工具参数，失败时返回结构化错误而不是抛出。 */
export function executeTargetingWeightQuery(args: unknown): Record<string, unknown> {
    let input: TargetingChainInput;
    try {
        input = parseTargetingChainInput(args);
    } catch (error) {
        return {
            error: `query_targeting_weight: ${error instanceof Error ? error.message : String(error)}`,
            hint: 'Pass numeric attacker/weapon/target fields; every field must be a finite number.',
        };
    }
    return computeTargetingChain(input) as unknown as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(source: Record<string, unknown>, key: string, path: string): number {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${path}.${key} must be a finite number.`);
    }
    return value;
}

function optionalNumber(source: Record<string, unknown>, key: string, path: string): number | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${path}.${key} must be a finite number when provided.`);
    }
    return value;
}

function requireBoolean(source: Record<string, unknown>, key: string, path: string): boolean {
    const value = source[key];
    if (typeof value !== 'boolean') {
        throw new Error(`${path}.${key} must be a boolean.`);
    }
    return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string, path: string): boolean | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${path}.${key} must be a boolean when provided.`);
    }
    return value;
}

function optionalNumberRecord(
    source: Record<string, unknown>,
    key: string,
    path: string,
): Record<string, number> | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`${path}.${key} must be an object mapping ship_size id to number.`);
    }
    const out: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
        if (typeof entryValue !== 'number' || !Number.isFinite(entryValue)) {
            throw new Error(`${path}.${key}.${entryKey} must be a finite number.`);
        }
        out[entryKey] = entryValue;
    }
    return out;
}

/**
 * 把工具参数（不可信输入）收窄为 TargetingChainInput。
 * 未知字段一律忽略并按缺省处理；类型错误立即抛出带字段路径的消息。
 */
export function parseTargetingChainInput(args: unknown): TargetingChainInput {
    if (!isRecord(args)) {
        throw new Error('arguments must be an object.');
    }
    const attackerRaw = args.attacker;
    const weaponRaw = args.weapon;
    const targetRaw = args.target;
    if (!isRecord(attackerRaw) || !isRecord(weaponRaw) || !isRecord(targetRaw)) {
        throw new Error('attacker, weapon and target must all be objects.');
    }

    const definesRaw = args.defines;
    let defines: Partial<TargetingDefines> | undefined;
    if (definesRaw !== undefined && definesRaw !== null) {
        if (!isRecord(definesRaw)) {
            throw new Error('defines must be an object when provided.');
        }
        defines = {};
        for (const key of Object.keys(VANILLA_TARGETING_DEFINES) as Array<keyof TargetingDefines>) {
            const value = optionalNumber(definesRaw, key, 'defines');
            if (value !== undefined) {
                defines[key] = value;
            }
        }
    }

    const shipSizeIdRaw = targetRaw.shipSizeId;
    if (shipSizeIdRaw !== undefined && shipSizeIdRaw !== null && typeof shipSizeIdRaw !== 'string') {
        throw new Error('target.shipSizeId must be a string when provided.');
    }

    return {
        attacker: {
            tracking: requireNumber(attackerRaw, 'tracking', 'attacker'),
            sizeMultiplier: requireNumber(attackerRaw, 'sizeMultiplier', 'attacker'),
        },
        weapon: {
            minDamage: requireNumber(weaponRaw, 'minDamage', 'weapon'),
            maxDamage: requireNumber(weaponRaw, 'maxDamage', 'weapon'),
            accuracy: requireNumber(weaponRaw, 'accuracy', 'weapon'),
            tracking: requireNumber(weaponRaw, 'tracking', 'weapon'),
            shieldDamage: requireNumber(weaponRaw, 'shieldDamage', 'weapon'),
            armorDamage: requireNumber(weaponRaw, 'armorDamage', 'weapon'),
            hullDamage: requireNumber(weaponRaw, 'hullDamage', 'weapon'),
            shieldPenetration: optionalNumber(weaponRaw, 'shieldPenetration', 'weapon'),
            armorPenetration: optionalNumber(weaponRaw, 'armorPenetration', 'weapon'),
            sizeDamageFactor: optionalNumber(weaponRaw, 'sizeDamageFactor', 'weapon'),
            targetWeights: optionalNumberRecord(weaponRaw, 'targetWeights', 'weapon'),
        },
        target: {
            shipSizeId: shipSizeIdRaw === null ? undefined : shipSizeIdRaw as string | undefined,
            sizeMultiplier: requireNumber(targetRaw, 'sizeMultiplier', 'target'),
            evasion: requireNumber(targetRaw, 'evasion', 'target'),
            distance: requireNumber(targetRaw, 'distance', 'target'),
            hull: requireNumber(targetRaw, 'hull', 'target'),
            maxHull: optionalNumber(targetRaw, 'maxHull', 'target'),
            shield: requireNumber(targetRaw, 'shield', 'target'),
            armor: requireNumber(targetRaw, 'armor', 'target'),
            shieldHardening: optionalNumber(targetRaw, 'shieldHardening', 'target'),
            armorHardening: optionalNumber(targetRaw, 'armorHardening', 'target'),
            armed: requireBoolean(targetRaw, 'armed', 'target'),
            isStarbase: optionalBoolean(targetRaw, 'isStarbase', 'target'),
            isCurrentMainTarget: optionalBoolean(targetRaw, 'isCurrentMainTarget', 'target'),
            isRecentNonLatest: optionalBoolean(targetRaw, 'isRecentNonLatest', 'target'),
        },
        defines,
        rho: optionalNumber(args, 'rho', 'root'),
        targetWeightMultModifier: optionalNumber(args, 'targetWeightMultModifier', 'root'),
        randomRoll: optionalNumber(args, 'randomRoll', 'root'),
        useRandom: optionalBoolean(args, 'useRandom', 'root'),
        fleetHasHittable: optionalBoolean(args, 'fleetHasHittable', 'root'),
        targetFocus: optionalBoolean(args, 'targetFocus', 'root'),
    };
}
