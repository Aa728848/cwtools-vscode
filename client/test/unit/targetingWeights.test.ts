import { expect } from 'chai';
import {
    computeTargetingChain,
    executeTargetingWeightQuery,
    VANILLA_TARGETING_DEFINES,
    type TargetingChainInput,
} from '../../extension/ai/targetingWeights';

/**
 * 复算 docs/stellaris-targeting-weight-4.5.2.md §6 算例：
 * 一门 ENERGY_LANCE（600-1500，mh = 1.5 / ms = 0.5 / ma = 2.0，acc = 0.85，trk = 0）
 * 对两条船：护卫舰 σ=5 / ε=0.6 / 船体盾甲 240-225-225 / d=72 / wtgt=1.561，
 * 雷击舰 σ=8 / ε=0.424 / 720-0-0 / d=64.5 / wtgt=1.379。
 */
const ENERGY_LANCE = {
    minDamage: 600,
    maxDamage: 1500,
    accuracy: 0.85,
    tracking: 0,
    shieldDamage: 0.5,
    armorDamage: 2.0,
    hullDamage: 1.5,
} as const;

function chain(overrides: Partial<TargetingChainInput>): TargetingChainInput {
    return {
        attacker: { tracking: 0, sizeMultiplier: 3 },
        weapon: { ...ENERGY_LANCE },
        target: {
            sizeMultiplier: 5,
            evasion: 0.6,
            distance: 72,
            hull: 240,
            shield: 225,
            armor: 225,
            armed: true,
        },
        ...overrides,
    };
}

describe('Stellaris targeting weight chain', () => {
    it('reproduces the design document section 6 ship-layer and hit-chance numbers', () => {
        const escort = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5,
                evasion: 0.6,
                distance: 72,
                hull: 240,
                shield: 225,
                armor: 225,
                armed: true,
            },
            targetWeightMultModifier: 0.561,
        }));
        const raider = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 8,
                evasion: 0.424,
                distance: 64.5,
                hull: 720,
                shield: 0,
                armor: 0,
                armed: true,
            },
            targetWeightMultModifier: 0.379,
        }));

        // W1 尺寸 = 1 / (1 + σ·κsize)
        expect(escort.shipChain.W1).to.be.closeTo(0.8696, 0.001);
        expect(raider.shipChain.W1).to.be.closeTo(0.8065, 0.001);
        // 闪避因子是 1/(1 + Δ·κev) 这个**单因子**，不是累计值
        expect(escort.shipChain.evasionFactor).to.be.closeTo(0.4545, 0.001);
        expect(raider.shipChain.evasionFactor).to.be.closeTo(0.5411, 0.001);
        // 距离因子 = 1 - d·κd
        expect(escort.shipChain.distanceFactor).to.be.closeTo(0.856, 0.001);
        expect(raider.shipChain.distanceFactor).to.be.closeTo(0.871, 0.001);
        // W(ship) = 尺寸 × 闪避 × 距离 × ŵtgt
        expect(escort.shipChain.weight).to.be.closeTo(0.528, 0.001);
        expect(raider.shipChain.weight).to.be.closeTo(0.524, 0.001);
        // p = acc - ε
        expect(escort.weapon.p).to.be.closeTo(0.25, 0.001);
        expect(raider.weapon.p).to.be.closeTo(0.426, 0.001);
    });

    it('applies the shield and armor split without clamping layer components', () => {
        const escort = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5,
                evasion: 0.6,
                distance: 72,
                hull: 240,
                shield: 225,
                armor: 225,
                armed: true,
            },
        }));
        // D = 1050; Cs = 1050, Ds = 0.5·1050; D 剩 825; Ca = 825, Da = 2.0·825; D 剩 600; Dh = 1.5·600
        expect(escort.weapon.baseDamage).to.equal(1050);
        expect(escort.weapon.damageSplit.Ds).to.be.closeTo(525, 1e-9);
        expect(escort.weapon.damageSplit.Da).to.be.closeTo(1650, 1e-9);
        expect(escort.weapon.damageSplit.Dh).to.be.closeTo(900, 1e-9);
        expect(escort.weapon.sumD).to.be.closeTo(3075, 1e-9);
        // 层分量没有被该层存量（225）夹住——这正是"盾甲吸引仇恨"的根因。
        expect(escort.weapon.damageSplit.Da).to.be.greaterThan(225);
    });

    it('applies the kill bonus from the hull component only', () => {
        const killed = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 900, shield: 225, armor: 225, armed: true,
            },
        }));
        const survived = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 901, shield: 225, armor: 225, armed: true,
            },
        }));
        expect(killed.weapon.damageSplit.Dh).to.be.closeTo(900, 1e-9);
        expect(killed.weapon.killBonus).to.equal(1.5);
        expect(killed.weapon.S1).to.be.closeTo(killed.weapon.S0 * 1.5, 1e-9);
        expect(survived.weapon.killBonus).to.equal(1);
        expect(survived.weapon.S1).to.be.closeTo(survived.weapon.S0, 1e-9);
    });

    it('vetoes the whole target when the fleet still has a hittable ship', () => {
        const vetoed = computeTargetingChain(chain({
            attacker: { tracking: 0, sizeMultiplier: 10 },
            target: {
                sizeMultiplier: 3, evasion: 0.9, distance: 30,
                hull: 200, shield: 0, armor: 0, armed: true,
            },
            fleetHasHittable: true,
        }));
        expect(vetoed.veto).to.equal(true);
        expect(vetoed.shipChain.vetoCheck).to.deep.equal({
            evasionDeltaPositive: true,
            attackerSizeLargeEnough: true,
            deltaAboveThreshold: true,
            fleetHasHittable: true,
        });
        expect(vetoed.shipChain.weight).to.equal(0);
        expect(vetoed.shipChain.W6).to.equal(0);
        expect(vetoed.notes.join(' ')).to.contain('否决');

        // 同一目标但舰队里没有可命中目标时，只是不否决，而是照常低权重参与 argmax。
        const notVetoed = computeTargetingChain(chain({
            attacker: { tracking: 0, sizeMultiplier: 10 },
            target: {
                sizeMultiplier: 3, evasion: 0.9, distance: 30,
                hull: 200, shield: 0, armor: 0, armed: true,
            },
            fleetHasHittable: false,
        }));
        expect(notVetoed.veto).to.equal(false);
        expect(notVetoed.shipChain.weight).to.be.greaterThan(0);
        // 小船 σatt < σavoidmin 时不满足尺寸门槛，同样不否决。
        const smallAttacker = computeTargetingChain(chain({
            attacker: { tracking: 0, sizeMultiplier: 5 },
            target: {
                sizeMultiplier: 3, evasion: 0.9, distance: 30,
                hull: 200, shield: 0, armor: 0, armed: true,
            },
            fleetHasHittable: true,
        }));
        expect(smallAttacker.shipChain.vetoCheck.attackerSizeLargeEnough).to.equal(false);
        expect(smallAttacker.veto).to.equal(false);
    });

    it('drops an unarmed target in both layers', () => {
        const armed = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        const unarmed = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: false,
            },
        }));
        expect(unarmed.shipChain.unarmedFactor).to.equal(VANILLA_TARGETING_DEFINES.unarmedWeight);
        expect(unarmed.weapon.unarmedPenalty).to.equal(VANILLA_TARGETING_DEFINES.unarmedWeight);
        expect(unarmed.shipChain.W5).to.be.closeTo(armed.shipChain.W5 * 0.005, 1e-9);
        expect(unarmed.weapon.S2).to.be.closeTo(armed.weapon.S2 * 0.005, 1e-9);
    });

    it('treats target_weights as an additive bonus that can outrank the chain', () => {
        const plain = computeTargetingChain(chain({
            target: {
                shipSizeId: 'corridor', sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        const boosted = computeTargetingChain(chain({
            weapon: { ...ENERGY_LANCE, targetWeights: { corridor: 100 } },
            target: {
                shipSizeId: 'corridor', sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        const missed = computeTargetingChain(chain({
            weapon: { ...ENERGY_LANCE, targetWeights: { cruiser: 100 } },
            target: {
                shipSizeId: 'corridor', sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        expect(plain.weapon.wk).to.equal(0);
        expect(boosted.weapon.wk).to.equal(100);
        // 加法，不是倍率：score = S2 + wk
        expect(boosted.weapon.score).to.be.closeTo(plain.weapon.score + 100, 1e-9);
        // wk 不被乘法链缩放，所以给一个足够大的值就能盖过整条链。
        const dominant = computeTargetingChain(chain({
            weapon: { ...ENERGY_LANCE, targetWeights: { corridor: 10_000 } },
            target: {
                shipSizeId: 'corridor', sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        expect(dominant.weapon.score).to.be.greaterThan(plain.weapon.score * 5);
        // 键未命中则不加。
        expect(missed.weapon.wk).to.equal(0);
        expect(missed.weapon.score).to.be.closeTo(plain.weapon.score, 1e-9);
    });

    it('applies the current-target stickiness and recent-target penalizer', () => {
        const base = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        }));
        const sticky = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
                isCurrentMainTarget: true,
            },
        }));
        const penalized = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
                isRecentNonLatest: true,
            },
        }));
        const spread = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
                isCurrentMainTarget: true,
            },
            targetFocus: true,
        }));
        expect(base.weapon.currentTargetMultiplier).to.equal(1);
        expect(sticky.weapon.currentTargetMultiplier).to.equal(1.1);
        expect(sticky.weapon.final).to.be.closeTo(sticky.weapon.score * 1.1, 1e-9);
        expect(penalized.weapon.recentTargetPenalizer).to.equal(0.3);
        expect(penalized.weapon.final).to.be.closeTo(penalized.weapon.score * 0.3, 1e-9);
        // targetFocus = 1（spread）时 Mcur 不施加。
        expect(spread.weapon.currentTargetMultiplier).to.equal(1);
        expect(spread.weapon.final).to.be.closeTo(spread.weapon.score, 1e-9);
    });

    it('covers define overrides, low-health, starbase, size scaling and the random factor', () => {
        const baseline = computeTargetingChain(chain({}));
        const steeper = computeTargetingChain(chain({ defines: { sizeSlope: 0.1 } }));
        expect(baseline.shipChain.W1).to.be.closeTo(1 / 1.15, 1e-9);
        expect(steeper.shipChain.W1).to.be.closeTo(1 / 1.5, 1e-9);
        expect(steeper.defines.sizeSlope).to.equal(0.1);
        // 未覆盖的 define 仍用 vanilla。
        expect(steeper.defines.sizeMax).to.equal(VANILLA_TARGETING_DEFINES.sizeMax);

        const lowHealth = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 100, maxHull: 400, shield: 0, armor: 0, armed: true,
            },
        }));
        expect(lowHealth.shipChain.lowHealthFactor).to.equal(1.5);
        const healthy = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 200, maxHull: 400, shield: 0, armor: 0, armed: true,
            },
        }));
        expect(healthy.shipChain.lowHealthFactor).to.equal(1);

        const starbase = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 0, armor: 0, armed: true, isStarbase: true,
            },
        }));
        expect(starbase.shipChain.starbaseFactor).to.equal(0.75);
        const starbaseCurrent = computeTargetingChain(chain({
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 0, armor: 0, armed: true,
                isStarbase: true, isCurrentMainTarget: true,
            },
        }));
        expect(starbaseCurrent.shipChain.starbaseFactor).to.equal(1);

        const scaled = computeTargetingChain(chain({
            weapon: { ...ENERGY_LANCE, sizeDamageFactor: 0.05 },
            target: {
                sizeMultiplier: 10, evasion: 0.6, distance: 72,
                hull: 240, shield: 0, armor: 0, armed: true,
            },
        }));
        expect(scaled.weapon.baseDamage).to.equal(1050);
        expect(scaled.weapon.damageSplit.Dh).to.be.closeTo(1050 * 1.5 * (1 + 10 * 0.05), 1e-9);
        const unscaled = computeTargetingChain(chain({
            weapon: { ...ENERGY_LANCE, sizeDamageFactor: 0 },
            target: {
                sizeMultiplier: 10, evasion: 0.6, distance: 72,
                hull: 240, shield: 0, armor: 0, armed: true,
            },
        }));
        expect(unscaled.weapon.damageSplit.Dh).to.be.closeTo(1575, 1e-9);

        const randomized = computeTargetingChain(chain({
            useRandom: true,
            randomRoll: 0.5,
        }));
        expect(baseline.shipChain.randomFactor).to.equal(1);
        expect(randomized.shipChain.randomFactor).to.equal(2.5);
        expect(randomized.shipChain.W6).to.be.closeTo(randomized.shipChain.W5 * 2.5, 1e-9);
    });

    it('returns a structured error instead of throwing on untrusted tool arguments', () => {
        const missing = executeTargetingWeightQuery({ weapon: ENERGY_LANCE });
        expect(String(missing.error)).to.contain('attacker, weapon and target must all be objects');

        const badNumber = executeTargetingWeightQuery({
            attacker: { tracking: 'high', sizeMultiplier: 3 },
            weapon: ENERGY_LANCE,
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        });
        expect(String(badNumber.error)).to.contain('attacker.tracking must be a finite number');
        expect(String(badNumber.hint)).to.contain('finite number');

        const badWeights = executeTargetingWeightQuery({
            attacker: { tracking: 0, sizeMultiplier: 3 },
            weapon: { ...ENERGY_LANCE, targetWeights: { corridor: 'high' } },
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        });
        expect(String(badWeights.error)).to.contain('weapon.targetWeights.corridor');

        const ok = executeTargetingWeightQuery({
            attacker: { tracking: 0, sizeMultiplier: 3 },
            weapon: ENERGY_LANCE,
            target: {
                sizeMultiplier: 5, evasion: 0.6, distance: 72,
                hull: 240, shield: 225, armor: 225, armed: true,
            },
        });
        expect(ok.error).to.equal(undefined);
        expect((ok.shipChain as { W1: number }).W1).to.be.closeTo(0.8696, 0.001);
    });
});
