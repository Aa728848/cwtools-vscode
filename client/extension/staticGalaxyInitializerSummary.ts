/**
 * Pure initializer summarization for the Static Galaxy preview (no VS Code
 * dependencies, unit-testable). The index class lives in
 * `staticGalaxyInitializers.ts`.
 */
import { SolarSystem } from './solarSystemParser';

export interface StaticGalaxyInitializerSummary {
    starClass?: string;
    color?: string;
    planetCount: number;
    moonCount: number;
    beltCount: number;
    hasRing: boolean;
}

/** Star-class colors aligned with the solar system preview palette. */
export const STAR_CLASS_COLORS: Record<string, string> = {
    sc_a: '#C8D8FF',
    sc_b: '#AAC8FF',
    sc_f: '#F8F0D0',
    sc_g: '#FFD800',
    sc_k: '#FF9030',
    sc_m: '#FF4040',
    sc_m_giant: '#CC2020',
    sc_t: '#8B4513',
    sc_black_hole: '#B050FF',
    sc_neutron_star: '#00FFFF',
    sc_pulsar: '#FF00FF',
    sc_binary_1: '#FFD800',
    sc_binary_2: '#FF9030',
    sc_trinary_1: '#FFD800',
    sc_trinary_2: '#FF9030',
    sc_trinary_3: '#C8D8FF',
};

function countMoons(system: SolarSystem): number {
    let count = 0;
    const walk = (bodies: SolarSystem['bodies']): void => {
        for (const body of bodies) {
            count += body.moons.length;
            walk(body.moons);
            walk(body.subPlanets);
        }
    };
    walk(system.bodies);
    return count;
}

/** Summarizes one parsed initializer for the Inspector and canvas coloring. */
export function summarizeInitializer(system: SolarSystem): StaticGalaxyInitializerSummary {
    const star = system.bodies.find(b => b.bodyType === 'star');
    const starClass = system.starClass || star?.planetClass || undefined;
    const planetCount = system.bodies.filter(b => b.bodyType !== 'star').length
        + system.bodies.reduce((n, b) => n + b.subPlanets.length, 0);
    const hasRing = system.bodies.some(b => b.isRingSegment || b.ringGroup !== undefined);
    return {
        starClass,
        color: starClass ? STAR_CLASS_COLORS[starClass] : undefined,
        planetCount,
        moonCount: countMoons(system),
        beltCount: system.asteroidBelts.length,
        hasRing,
    };
}
