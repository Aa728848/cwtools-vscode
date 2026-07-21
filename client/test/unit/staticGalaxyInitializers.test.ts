import { expect } from 'chai';
import { summarizeInitializer, STAR_CLASS_COLORS } from '../../extension/staticGalaxyInitializerSummary';
import { parseSolarSystemFile } from '../../extension/solarSystemParser';

describe('staticGalaxyInitializers', () => {
    it('summarizes star class, planets, moons and belts', () => {
        const [system] = parseSolarSystemFile(`
my_init = {
    class = sc_g
    asteroid_belt = { type = rocky_asteroid_belt radius = 100 }
    planet = {
        class = pc_g_star
        orbit_distance = 0
        orbit_angle = 0
    }
    planet = {
        class = pc_continental
        orbit_distance = 30
        orbit_angle = 20
        moon = { class = pc_barren orbit_distance = 10 orbit_angle = 90 }
    }
    planet = { class = pc_toxic orbit_distance = 50 orbit_angle = 40 }
}
`);
        const info = summarizeInitializer(system!);
        expect(info.starClass).to.equal('sc_g');
        expect(info.color).to.equal(STAR_CLASS_COLORS['sc_g']);
        expect(info.planetCount).to.equal(2);
        expect(info.moonCount).to.equal(1);
        expect(info.beltCount).to.equal(1);
        expect(info.hasRing).to.equal(false);
    });

    it('flags ring worlds', () => {
        const [system] = parseSolarSystemFile(`
ring_init = {
    class = sc_b
    planet = { class = pc_b_star orbit_distance = 0 orbit_angle = 0 }
    planet = { class = pc_ringworld_habitable orbit_distance = 30 orbit_angle = 10 }
    planet = { class = pc_ringworld_habitable orbit_distance = 0 orbit_angle = 40 }
}
`);
        const info = summarizeInitializer(system!);
        expect(info.starClass).to.equal('sc_b');
        expect(info.hasRing).to.equal(true);
    });
});
