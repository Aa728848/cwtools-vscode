/**
 * Estimated hyperlane heuristic for `random_hyperlanes = yes` scenarios.
 *
 * This is NOT Stellaris' generator — the real runtime algorithm is
 * undocumented. The estimate connects each system to its k nearest neighbors
 * within the scenario's max hyperlane distance and exists purely as an
 * optional, clearly-labeled preview layer. It is never written back to source.
 */

export interface StaticGalaxyEstimatePoint {
    nodeKey: string;
    x: number;
    y: number;
}

/** Default reach when the scenario does not set max_hyperlane_distance. */
export const STATIC_GALAXY_DEFAULT_LANE_DISTANCE = 50;

/**
 * k-nearest-neighbor estimate: each system links to at most k neighbors no
 * farther than maxDistance. k scales with the scenario's hyperlane density
 * (3 at density 1) and is clamped to [1, 6]. Undirected pairs are deduped.
 */
export function estimateHyperlanes(
    points: StaticGalaxyEstimatePoint[],
    maxDistance: number,
    density = 1,
): Array<[string, string]> {
    if (points.length < 2 || maxDistance <= 0) return [];
    const k = Math.max(1, Math.min(6, Math.round(3 * (density > 0 ? density : 1))));
    const maxDistSq = maxDistance * maxDistance;
    const seen = new Set<string>();
    const lanes: Array<[string, string]> = [];

    for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const neighbors: Array<{ nodeKey: string; distSq: number }> = [];
        for (let j = 0; j < points.length; j++) {
            if (j === i) continue;
            const b = points[j]!;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distSq = dx * dx + dy * dy;
            if (distSq <= maxDistSq) neighbors.push({ nodeKey: b.nodeKey, distSq });
        }
        neighbors.sort((p, q) => p.distSq - q.distSq);
        for (const neighbor of neighbors.slice(0, k)) {
            const key = [a.nodeKey, neighbor.nodeKey].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            lanes.push([a.nodeKey, neighbor.nodeKey]);
        }
    }
    return lanes;
}
