import { expect } from 'chai';
import { evalCurve } from '../../webview/curveEditor';
import { ParticleEffectSimulation } from '../../webview/particleSimulation';
import type { ParticleEffect } from '../../webview/particleTypes';

describe('particle curve and simulation', () => {
    it('evaluates monotone cubic curves through endpoints without overshoot', () => {
        const points = [{ x: 0, y: 0 }, { x: 0.35, y: 0.8 }, { x: 1, y: 1 }];
        expect(evalCurve(points, 0)).to.equal(0);
        expect(evalCurve(points, 1)).to.equal(1);
        for (let i = 0; i <= 20; i++) {
            const value = evalCurve(points, i / 20);
            expect(value).to.be.at.least(0);
            expect(value).to.be.at.most(1);
        }
    });

    it('spawns, moves, fades, and retires particles', () => {
        const effect: ParticleEffect = {
            name: 'test_effect',
            subsystems: [{
                name: 'spark',
                maxAmount: 16,
                emitterType: 'point',
                duration: { value: -1 },
                life: { value: 0.2 },
                emission: { value: 20 },
                velocity: { value: 1 },
                size: { value: 1, curve: 'grow' },
                color: {
                    r: { value: 255 },
                    g: { value: 200 },
                    b: { value: 100 },
                    alpha: { value: 255, curve: 'fade' },
                },
            }],
            animations: [
                { name: 'grow', start: 0, duration: 1, minValue: 0, maxValue: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], op: 'MUL', time: 'life' },
                { name: 'fade', start: 0, duration: 1, minValue: 0, maxValue: 1, points: [{ x: 0, y: 1 }, { x: 1, y: 0 }], op: 'MUL', time: 'life' },
            ],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        for (let i = 0; i < 10; i++) sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(buffer.positions[2]).to.be.greaterThan(0);
        expect(buffer.colors[3]).to.be.within(0, 1);
    });

    it('chooses stable random frames for non-animated texture grids', () => {
        const effect: ParticleEffect = {
            name: 'flipbook_grid',
            subsystems: [{
                name: 'shards',
                maxAmount: 16,
                emitterType: 'point',
                life: { value: 1 },
                emission: { value: 80 },
                texture: { file: 'gfx/particles/shards.dds', x: 2, y: 2 },
                spritesheetAnimation: false,
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        for (let i = 0; i < 5; i++) sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        const frames = Array.from(buffer.frames.slice(0, buffer.count));
        expect(buffer.count).to.be.greaterThan(1);
        expect(new Set(frames).size).to.be.greaterThan(1);
    });

    it('animates implicit texture grids over short particle lifetimes', () => {
        const effect: ParticleEffect = {
            name: 'implicit_flipbook_grid',
            subsystems: [{
                name: 'fire',
                maxAmount: 1,
                emitterType: 'point',
                duration: { value: -1 },
                life: { value: 0.16 },
                emission: { value: 200 },
                velocity: { value: 0 },
                texture: { file: 'gfx/particles/fire05.dds', x: 2, y: 2 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.04);
        const firstFrame = sim.systems[0]!.buffer.frames[0];
        sim.update(0.08);
        expect(sim.systems[0]!.buffer.frames[0]).to.be.greaterThan(firstFrame ?? -1);
    });

    it('treats range scalars as base plus variance for color and emitter radius', () => {
        const effect: ParticleEffect = {
            name: 'range_semantics',
            subsystems: [{
                name: 'ring',
                maxAmount: 4,
                emitterType: 'sphere',
                sphereEmitterRadius: { a: { value: 40 }, b: { value: 8 } },
                sphereEmitterYaw: { value: 0 },
                sphereEmitterPitch: { value: 0 },
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 0 },
                color: {
                    r: { a: { value: 255 }, b: { value: 15 } },
                    g: { value: 255 },
                    b: { value: 255 },
                    alpha: { value: 255 },
                },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(Math.abs(buffer.positions[0] ?? 0)).to.be.lessThan(0.001);
        expect(Math.abs(buffer.positions[1] ?? 0)).to.be.lessThan(0.001);
        expect(buffer.positions[2]).to.be.within(32, 48);
        expect(buffer.colors[0]).to.be.greaterThan(0.9);
    });

    it('keeps per-particle non-billboard orientation ranges', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_orientation',
            subsystems: [{
                name: 'flash',
                maxAmount: 16,
                emitterType: 'point',
                billboard: false,
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 160 },
                velocity: { value: 0 },
                size: { value: 1 },
                particleYaw: { value: -90 },
                particlePitch: { a: { value: 0 }, b: { value: 90 } },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(2);
        const firstUp = Array.from(buffer.ups.slice(0, 3)).map(value => value.toFixed(3)).join(',');
        const uniqueUps = new Set<string>();
        for (let index = 0; index < buffer.count; index++) {
            uniqueUps.add(Array.from(buffer.ups.slice(index * 3, index * 3 + 3)).map(value => value.toFixed(3)).join(','));
        }
        expect(uniqueUps.size).to.be.greaterThan(1);
        expect(firstUp).not.to.equal('0.000,1.000,0.000');
    });

    it('aligns yaw zero velocity and muzzle quads to the Stellaris Z axis', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_axis',
            subsystems: [{
                name: 'flash',
                maxAmount: 4,
                emitterType: 'point',
                billboard: false,
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocityYaw: { value: 0 },
                velocityPitch: { value: 0 },
                velocity: { value: 5 },
                size: { value: 1 },
                particleYaw: { value: -90 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(Math.abs(buffer.positions[0] ?? 0)).to.be.lessThan(0.001);
        expect(buffer.positions[2]).to.be.greaterThan(0);
        expect(Math.abs(buffer.rights[0] ?? 0)).to.be.lessThan(0.001);
        expect(buffer.rights[2]).to.be.closeTo(1, 0.001);
    });

    it('maps negative particle position x to the Stellaris muzzle-forward axis', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_position_axis',
            subsystems: [{
                name: 'flash',
                maxAmount: 4,
                emitterType: 'point',
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 0 },
                position: { x: { value: -0.75 }, y: { value: 0 }, z: { value: 0 } },
                size: { value: 1 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(Math.abs(buffer.positions[0] ?? 0)).to.be.lessThan(0.001);
        expect(buffer.positions[2]).to.be.closeTo(0.75, 0.001);
    });

    it('spreads non-billboard pitch around the muzzle long axis', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_pitch_axis',
            subsystems: [{
                name: 'flash',
                maxAmount: 4,
                emitterType: 'point',
                billboard: false,
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 0 },
                size: { value: 1 },
                particleYaw: { value: -90 },
                particlePitch: { value: 90 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(Math.abs(buffer.rights[0] ?? 0)).to.be.lessThan(0.001);
        expect(Math.abs(buffer.rights[1] ?? 0)).to.be.lessThan(0.001);
        expect(buffer.rights[2]).to.be.closeTo(1, 0.001);
        expect(buffer.ups[0]).to.be.closeTo(-1, 0.001);
        expect(Math.abs(buffer.ups[1] ?? 0)).to.be.lessThan(0.001);
        expect(Math.abs(buffer.ups[2] ?? 0)).to.be.lessThan(0.001);
    });

    it('applies non-billboard rotation speed ranges per particle', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_orientation_speed',
            subsystems: [{
                name: 'flash',
                maxAmount: 16,
                emitterType: 'point',
                billboard: false,
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 160 },
                velocity: { value: 0 },
                size: { value: 1 },
                rotationSpeedPitch: { a: { value: 0 }, b: { value: 180 } },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        const uniqueUps = new Set<string>();
        for (let index = 0; index < buffer.count; index++) {
            uniqueUps.add(Array.from(buffer.ups.slice(index * 3, index * 3 + 3)).map(value => value.toFixed(4)).join(','));
        }
        expect(buffer.count).to.be.greaterThan(2);
        expect(uniqueUps.size).to.be.greaterThan(1);
    });

    it('adds fast deterministic flutter to short-lived non-billboard range orientations', () => {
        const effect: ParticleEffect = {
            name: 'muzzle_flutter',
            subsystems: [{
                name: 'flash',
                maxAmount: 1,
                emitterType: 'point',
                billboard: false,
                duration: { value: -1 },
                life: { value: 0.18 },
                emission: { value: 200 },
                velocity: { value: 0 },
                size: { value: 1 },
                particleYaw: { value: -90 },
                particlePitch: { a: { value: 0 }, b: { value: 90 } },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.02);
        const firstUp = Array.from(sim.systems[0]!.buffer.ups.slice(0, 3));
        sim.update(0.04);
        const secondUp = Array.from(sim.systems[0]!.buffer.ups.slice(0, 3));
        const delta = Math.hypot(
            (secondUp[0] ?? 0) - (firstUp[0] ?? 0),
            (secondUp[1] ?? 0) - (firstUp[1] ?? 0),
            (secondUp[2] ?? 0) - (firstUp[2] ?? 0),
        );
        expect(delta).to.be.greaterThan(0.05);
    });

    it('applies effect scale to spatial particle properties', () => {
        const effect: ParticleEffect = {
            name: 'scaled_effect',
            scale: 2,
            subsystems: [{
                name: 'spark',
                maxAmount: 4,
                emitterType: 'point',
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 1 },
                size: { value: 1 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(buffer.positions[2]).to.be.closeTo(0.1, 0.001);
        expect(buffer.sizes[0]).to.equal(2);
    });

    it('uses force yaw for planar forces', () => {
        const effect: ParticleEffect = {
            name: 'force_yaw',
            subsystems: [{
                name: 'spark',
                maxAmount: 4,
                emitterType: 'point',
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 0 },
                size: { value: 1 },
                force: 'push',
            }],
            animations: [],
            forces: [{
                name: 'push',
                type: 'planar',
                direction: [1, 0, 0],
                localForce: true,
                yaw: 90,
                amount: { value: 10 },
            }],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(buffer.positions[0]).to.be.lessThan(0);
        expect(Math.abs(buffer.positions[2] ?? 0)).to.be.lessThan(0.001);
    });

    it('simulates point and spin forces', () => {
        const pointEffect: ParticleEffect = {
            name: 'point_force',
            subsystems: [{
                name: 'spark',
                maxAmount: 4,
                emitterType: 'point',
                position: { x: { value: 1 }, y: { value: 0 }, z: { value: 0 } },
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 0 },
                size: { value: 1 },
                force: 'point',
            }],
            animations: [],
            forces: [{
                name: 'point',
                type: 'point',
                position: [0, 0, 0],
                direction: [1, 0, 0],
                amount: { value: 10 },
            }],
        };
        const pointSim = new ParticleEffectSimulation(pointEffect);
        pointSim.update(0.05);
        expect(pointSim.systems[0]!.buffer.positions[2]).to.be.lessThan(-1);

        const spinEffect: ParticleEffect = {
            ...pointEffect,
            name: 'spin_force',
            forces: [{
                name: 'point',
                type: 'spin',
                position: [0, 0, 0],
                direction: [0, 1, 0],
                amount: { value: 10 },
            }],
        };
        const spinSim = new ParticleEffectSimulation(spinEffect);
        spinSim.update(0.05);
        expect(spinSim.systems[0]!.buffer.positions[0]).to.be.lessThan(0);
    });

    it('writes trail tails behind moving particles', () => {
        const effect: ParticleEffect = {
            name: 'trail_effect',
            subsystems: [{
                name: 'spark',
                maxAmount: 4,
                emitterType: 'point',
                trail: true,
                duration: { value: -1 },
                life: { value: 1 },
                emission: { value: 80 },
                velocity: { value: 10 },
                size: { value: 1 },
            }],
            animations: [],
            forces: [],
        };
        const sim = new ParticleEffectSimulation(effect);
        sim.update(0.05);
        const buffer = sim.systems[0]!.buffer;
        expect(buffer.count).to.be.greaterThan(0);
        expect(buffer.trailTails[2]).to.be.lessThan(buffer.positions[2] ?? 0);
    });
});
