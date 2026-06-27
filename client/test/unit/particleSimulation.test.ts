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
});
