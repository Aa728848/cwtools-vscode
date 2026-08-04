import { expect } from 'chai';
import { parseAssetFile } from '../../extension/entityAssetParser';

describe('entity asset parser', () => {
    it('parses timed and start particle events without retaining sound-only events', () => {
        const parsed = parseAssetFile(`
entity = {
    name = "test_ship"
    pdxmesh = "test_mesh"
    state = {
        name = "death"
        state_time = 12.5
        looping = no
        start_event = { node = "engine" particle = "engine_idle" keep_particle = yes trigger_once = yes }
        event = { time = 2.5 node = "target_locator_1" particle = "small_explosion" trigger_once = yes sound = { soundeffect = "boom" } }
        event = { time = 1 sound = { soundeffect = "sound_only" } }
    }
}
`, 'test.asset');

        const state = parsed.entities[0]!.states[0]!;
        expect(state.stateTime).to.equal(12.5);
        expect(state.looping).to.equal(false);
        expect(state.particleEvents).to.deep.include.members([
            {
                kind: 'start_event',
                time: 0,
                node: 'engine',
                particle: 'engine_idle',
                keepParticle: true,
                triggerOnce: true,
                line: 9,
            },
            {
                kind: 'event',
                time: 2.5,
                node: 'target_locator_1',
                particle: 'small_explosion',
                triggerOnce: true,
                line: 10,
            },
        ]);
        expect(state.particleEvents).to.have.length(2);
    });

    it('keeps animation and particle events on the same state variant', () => {
        const parsed = parseAssetFile(`
entity = {
    name = animated_ship
    state = {
        name = moving
        animation = engine_move
        event = { time = 0.25 node = E01 particle = moving_exhaust }
    }
}
`, 'animated.asset');

        const state = parsed.entities[0]!.states[0]!;
        expect(state.animation).to.equal('engine_move');
        expect(state.particleEvents).to.deep.include({
            kind: 'event',
            time: 0.25,
            node: 'E01',
            particle: 'moving_exhaust',
            line: 7,
        });
    });
});
