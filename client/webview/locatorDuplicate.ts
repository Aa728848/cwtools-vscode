export type LocatorVector3 = [number, number, number];

export interface LocatorTransform {
    position: LocatorVector3;
    /** Rotation around X, Y and Z in degrees. */
    rotation: LocatorVector3;
}

export interface SpecialDuplicateOptions {
    copies: number;
    positionStep: LocatorVector3;
    rotationStep: LocatorVector3;
    /** Rotate each copied position around the model origin before adding positionStep. */
    orbitAroundOrigin?: boolean;
}

export interface LocatorTransformDelta {
    position: LocatorVector3;
    rotation: LocatorVector3;
}

const DEG_TO_RAD = Math.PI / 180;

/** Apply an XYZ Euler rotation to a point. */
function rotatePointXYZ(point: LocatorVector3, rotation: LocatorVector3): LocatorVector3 {
    const x = rotation[0] * DEG_TO_RAD;
    const y = rotation[1] * DEG_TO_RAD;
    const z = rotation[2] * DEG_TO_RAD;
    const cx = Math.cos(x);
    const sx = Math.sin(x);
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cz = Math.cos(z);
    const sz = Math.sin(z);

    // Match Three.js Euler order XYZ.
    return [
        cy * cz * point[0] - cy * sz * point[1] + sy * point[2],
        (cx * sz + sx * cz * sy) * point[0]
            + (cx * cz - sx * sz * sy) * point[1]
            - sx * cy * point[2],
        (sx * sz - cx * cz * sy) * point[0]
            + (sx * cz + cx * sz * sy) * point[1]
            + cx * cy * point[2],
    ];
}

/**
 * Build Maya-style special duplicates. Each copy accumulates the supplied
 * position and rotation step from the original locator.
 */
export function buildSpecialDuplicateTransforms(
    source: LocatorTransform,
    options: SpecialDuplicateOptions,
): LocatorTransform[] {
    const copies = Math.max(0, Math.floor(options.copies));
    const result: LocatorTransform[] = [];

    for (let index = 1; index <= copies; index++) {
        const rotationDelta: LocatorVector3 = [
            options.rotationStep[0] * index,
            options.rotationStep[1] * index,
            options.rotationStep[2] * index,
        ];
        const basePosition = options.orbitAroundOrigin
            ? rotatePointXYZ(source.position, rotationDelta)
            : source.position;

        result.push({
            position: [
                basePosition[0] + options.positionStep[0] * index,
                basePosition[1] + options.positionStep[1] * index,
                basePosition[2] + options.positionStep[2] * index,
            ],
            rotation: [
                source.rotation[0] + rotationDelta[0],
                source.rotation[1] + rotationDelta[1],
                source.rotation[2] + rotationDelta[2],
            ],
        });
    }

    return result;
}

/** Generate collision-free locator names while preserving numeric suffix width. */
export function generateDuplicateLocatorNames(
    sourceName: string,
    copies: number,
    existingNames: Iterable<string>,
): string[] {
    const used = new Set(Array.from(existingNames, name => name.toLowerCase()));
    const suffixMatch = /^(.*?)(\d+)$/.exec(sourceName);
    const prefix = suffixMatch ? suffixMatch[1]! : `${sourceName}_copy_`;
    const width = suffixMatch ? suffixMatch[2]!.length : 2;
    let nextNumber = suffixMatch ? Number.parseInt(suffixMatch[2]!, 10) + 1 : 1;
    const result: string[] = [];

    while (result.length < Math.max(0, Math.floor(copies))) {
        const candidate = `${prefix}${String(nextNumber).padStart(width, '0')}`;
        nextNumber++;
        if (used.has(candidate.toLowerCase())) continue;
        used.add(candidate.toLowerCase());
        result.push(candidate);
    }

    return result;
}

function shortestAngleDelta(target: number, source: number): number {
    return ((target - source + 540) % 360) - 180;
}

/** Capture the transform change made after an in-place Shift+D duplicate. */
export function getLocatorTransformDelta(
    source: LocatorTransform,
    target: LocatorTransform,
): LocatorTransformDelta {
    return {
        position: [
            target.position[0] - source.position[0],
            target.position[1] - source.position[1],
            target.position[2] - source.position[2],
        ],
        rotation: [
            shortestAngleDelta(target.rotation[0], source.rotation[0]),
            shortestAngleDelta(target.rotation[1], source.rotation[1]),
            shortestAngleDelta(target.rotation[2], source.rotation[2]),
        ],
    };
}

/** Apply a remembered Shift+D transform change to the current locator. */
export function applyLocatorTransformDelta(
    source: LocatorTransform,
    delta: LocatorTransformDelta,
): LocatorTransform {
    return {
        position: [
            source.position[0] + delta.position[0],
            source.position[1] + delta.position[1],
            source.position[2] + delta.position[2],
        ],
        rotation: [
            source.rotation[0] + delta.rotation[0],
            source.rotation[1] + delta.rotation[1],
            source.rotation[2] + delta.rotation[2],
        ],
    };
}
