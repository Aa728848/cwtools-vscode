import { expect } from 'chai';
import { parseSolarSystemFile, toRelativeOrbitAngle } from '../../extension/solarSystemParser';

describe('solar system orbit angle resolution', () => {
    it('accumulates orbit_angle across bodies at each hierarchical level', () => {
        const [system] = parseSolarSystemFile(`
angle_test = {
    class = sc_g
    planet = {
        class = pc_g_star
        orbit_distance = 0
        orbit_angle = 10
        planet = { class = pc_a_star orbit_distance = 10 orbit_angle = 45 }
        planet = { class = pc_b_star orbit_distance = 0 orbit_angle = 45 }
    }
    planet = {
        class = pc_continental
        orbit_distance = 30
        orbit_angle = 20
        moon = { class = pc_barren_cold orbit_distance = 10 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
    }
    planet = { class = pc_barren orbit_distance = 20 orbit_angle = 30 }
}
`);

        expect(system).to.not.equal(undefined);
        expect(system!.bodies.map(body => body.resolvedOrbitAngle)).to.deep.equal([10, 30, 60]);

        const star = system!.bodies[0]!;
        expect(star.subPlanets.map(body => body.resolvedOrbitAngle)).to.deep.equal([45, 90]);

        const planet = system!.bodies[1]!;
        expect(planet.moons.map(moon => moon.resolvedOrbitAngle)).to.deep.equal([90, 180, 270, 360]);
        expect(planet.moons.map(moon => moon.resolvedOrbitRadius)).to.deep.equal([10, 10, 10, 10]);
    });

    it('converts an absolute preview angle back to a sibling-relative angle', () => {
        expect(toRelativeOrbitAngle(180, 90)).to.equal(90);
        expect(toRelativeOrbitAngle(10, 350)).to.equal(20);
        expect(toRelativeOrbitAngle(350, 10)).to.equal(340);
    });

    it('keeps ring-world segment arcs aligned with the cumulative sibling angle', () => {
        const [system] = parseSolarSystemFile(`
ring_angle_test = {
    class = sc_g
    planet = { class = pc_g_star orbit_distance = 0 orbit_angle = 10 }
    planet = { class = pc_barren orbit_distance = 30 orbit_angle = 20 }
    change_orbit = 20
    planet = { class = pc_ringworld_habitable orbit_distance = 0 orbit_angle = 30 }
    planet = { class = pc_ringworld_tech orbit_distance = 0 orbit_angle = 30 }
}
`);

        const ringAnchor = system!.bodies[2]!;
        expect(system!.bodies.map(body => body.resolvedOrbitAngle)).to.deep.equal([10, 30, 60, 90]);
        expect(ringAnchor.ringGroup?.segments.map(segment => [segment.startAngle, segment.endAngle]))
            .to.deep.equal([[30, 60], [60, 90]]);
        expect(ringAnchor.ringGroup?.totalAngle).to.equal(60);
    });

    it('uses stable field-specific preview values for random and range inputs', () => {
        const source = `
random_preview_test = {
    class = sc_g
    planet = {
        class = pc_g_star
        orbit_distance = random
        orbit_angle = random
        size = random
        count = random
    }
    planet = {
        class = pc_continental
        orbit_distance = { min = 10 max = 30 }
        orbit_angle = { min = 40 max = 80 }
        size = { min = 10 max = 20 }
        count = { min = 2 max = 4 }
    }
}
`;

        const first = parseSolarSystemFile(source)[0]!;
        const second = parseSolarSystemFile(source)[0]!;
        const randomBody = first.bodies[0]!;
        const rangedBody = first.bodies[1]!;

        expect(randomBody.resolvedOrbitRadius).to.equal(0);
        expect(randomBody.resolvedSize).to.equal(15);
        expect(randomBody.resolvedCount).to.equal(1);
        expect(randomBody.resolvedOrbitAngle).to.be.at.least(0).and.lessThan(360);
        expect(second.bodies[0]!.resolvedOrbitAngle).to.equal(randomBody.resolvedOrbitAngle);

        expect(rangedBody.resolvedOrbitRadius).to.equal(20);
        expect(rangedBody.resolvedOrbitAngle).to.equal(randomBody.resolvedOrbitAngle + 60);
        expect(rangedBody.resolvedSize).to.equal(15);
        expect(rangedBody.resolvedCount).to.equal(3);
    });
});
