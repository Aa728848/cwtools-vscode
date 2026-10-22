/**
 * Binary PDX mesh (pdxmesh) geometry extraction for ship icons.
 *
 * The object tree is walked structurally: every [mesh] node owns position/index property
 * pairs and its [material] child names the shader. Physics proxies (shader = Collision)
 * enclose the whole hull and would fatten the silhouette, while glass/shadow/decal groups
 * are invisible helpers; both are dropped. Unstructured byte scanning cannot see shaders,
 * which is why the tree is parsed instead of searching for property markers.
 */

export interface ShipIconMesh {
    /** Flat xyz triples in hull-local coordinates. */
    positions: Float32Array;
    /** Triangle indices into positions, three per triangle. */
    indices: Uint32Array;
}

const BINARY_MAGIC: readonly number[] = [0x40, 0x40, 0x62, 0x40, 0x21]; // "@@b@!"
// The fifth magic byte is the first '!' property marker, so the walk starts there.
const WALK_START = 4;
const MARKER_OBJECT = 0x5b; // '['
const MARKER_PROPERTY = 0x21; // '!'
const TYPE_FLOAT = 0x66; // 'f'
const TYPE_INT = 0x69; // 'i'
const TYPE_STRING = 0x73; // 's'
const MESH_NODE_NAME = 'mesh';
const COLLISION_SHADER = 'collision';
// Transparent and additive shader families: flattened into a silhouette they become a black slab.
const EFFECT_SHADER_PATTERNS: readonly RegExp[] = [/^alphablend/, /alpha(additive|blend)/];
const SKIPPED_GROUP_FRAGMENTS: readonly string[] = ['Glass', 'Shadow', 'Decal'];
const MAX_OBJECT_NAME_LENGTH = 1024;

interface GeometryPart {
    positionsOffset: number;
    positionCount: number;
    indicesOffset: number;
    indexCount: number;
}

interface SubMesh {
    group: string;
    shader: string;
    parts: GeometryPart[];
}

interface ActiveMesh {
    depth: number;
    mesh: SubMesh;
}

function readAscii(view: DataView, start: number, end: number): string {
    let text = '';
    for (let index = start; index < end; index++) text += String.fromCharCode(view.getUint8(index));
    return text;
}

function readObjectName(view: DataView, start: number): { value: string; next: number } | undefined {
    const limit = Math.min(view.byteLength, start + MAX_OBJECT_NAME_LENGTH);
    for (let index = start; index < limit; index++) {
        if (view.getUint8(index) === 0) return { value: readAscii(view, start, index), next: index + 1 };
    }
    return undefined;
}

/** Read the object tree; a malformed or truncated tail simply ends the walk. */
function readSubMeshes(view: DataView): SubMesh[] {
    const length = view.byteLength;
    const subMeshes: SubMesh[] = [];
    const stack: string[] = [];
    let groupName = '';
    let current: ActiveMesh | undefined;
    let offset = WALK_START;
    while (offset < length) {
        const marker = view.getUint8(offset);
        if (marker === MARKER_OBJECT) {
            let depth = 0;
            while (offset < length && view.getUint8(offset) === MARKER_OBJECT) {
                depth++;
                offset++;
            }
            const name = readObjectName(view, offset);
            if (!name) break;
            offset = name.next;
            while (stack.length >= depth) stack.pop();
            stack.push(name.value);
            if (depth === 2) groupName = name.value;
            // Leaving a mesh node must stop collecting: locator positions follow the hull.
            if (current && depth <= current.depth) current = undefined;
            if (name.value === MESH_NODE_NAME) {
                const mesh: SubMesh = { group: groupName, shader: '', parts: [] };
                subMeshes.push(mesh);
                current = { depth, mesh };
            }
            continue;
        }
        if (marker !== MARKER_PROPERTY) break;

        let cursor = offset + 1;
        if (cursor >= length) break;
        const nameLength = view.getUint8(cursor++);
        // Name bytes plus the type byte and the 32-bit element count.
        if (cursor + nameLength + 5 > length) break;
        const propertyName = readAscii(view, cursor, cursor + nameLength);
        cursor += nameLength;
        const type = view.getUint8(cursor++);
        const elementCount = view.getUint32(cursor, true);
        cursor += 4;
        if (type === TYPE_STRING) {
            if (cursor + 4 > length) break;
            const stringLength = view.getUint32(cursor, true);
            cursor += 4;
            if (cursor + stringLength > length) break;
            if (current && propertyName === 'shader' && current.mesh.shader === '') {
                current.mesh.shader = readAscii(view, cursor, cursor + stringLength);
            }
            cursor += stringLength;
        } else if (type === TYPE_FLOAT || type === TYPE_INT) {
            const byteLength = elementCount * 4;
            if (cursor + byteLength > length) break;
            if (current && type === TYPE_FLOAT && propertyName === 'p') {
                current.mesh.parts.push({
                    positionsOffset: cursor,
                    positionCount: elementCount,
                    indicesOffset: -1,
                    indexCount: 0,
                });
            } else if (current && type === TYPE_INT && propertyName === 'tri') {
                const part = current.mesh.parts[current.mesh.parts.length - 1];
                if (part && part.indicesOffset < 0) {
                    part.indicesOffset = cursor;
                    part.indexCount = elementCount;
                }
            }
            cursor += byteLength;
        } else {
            break;
        }
        offset = cursor;
    }
    return subMeshes;
}

function isCollisionShader(shader: string): boolean {
    return shader.replace(/\0+$/, '').toLowerCase() === COLLISION_SHADER;
}

/** True for alpha-blended and additive effect planes; visible hull shaders never match. */
function isEffectShader(shader: string): boolean {
    const normalized = shader.replace(/\0+$/, '').toLowerCase();
    return EFFECT_SHADER_PATTERNS.some(pattern => pattern.test(normalized));
}

function isSkippedGroup(name: string): boolean {
    return SKIPPED_GROUP_FRAGMENTS.some(fragment => name.includes(fragment));
}

function collectGeometry(
    view: DataView,
    subMeshes: readonly SubMesh[],
    vertices: number[],
    triangles: number[],
): void {
    for (const subMesh of subMeshes) {
        for (const part of subMesh.parts) appendPart(view, part, vertices, triangles);
    }
}

/** Append one position/index pair; malformed or out-of-range pairs are dropped whole. */
function appendPart(view: DataView, part: GeometryPart, vertices: number[], triangles: number[]): void {
    if (part.indicesOffset < 0 || part.positionCount === 0 || part.positionCount % 3 !== 0) return;
    if (part.indexCount === 0 || part.indexCount % 3 !== 0) return;
    const vertexCount = part.positionCount / 3;
    for (let index = 0; index < part.indexCount; index++) {
        if (view.getUint32(part.indicesOffset + index * 4, true) >= vertexCount) return;
    }
    const baseVertex = vertices.length / 3;
    for (let index = 0; index < part.positionCount; index++) {
        vertices.push(view.getFloat32(part.positionsOffset + index * 4, true));
    }
    for (let index = 0; index < part.indexCount; index++) {
        triangles.push(baseVertex + view.getUint32(part.indicesOffset + index * 4, true));
    }
}

/** Read all usable triangles of a binary pdxmesh; undefined when nothing is usable. */
export function readPdxMeshGeometry(buffer: ArrayBuffer): ShipIconMesh | undefined {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < BINARY_MAGIC.length) return undefined;
    const view = new DataView(buffer);
    for (let index = 0; index < BINARY_MAGIC.length; index++) {
        if (view.getUint8(index) !== BINARY_MAGIC[index]) return undefined;
    }

    const candidates = readSubMeshes(view).filter(
        subMesh => !isCollisionShader(subMesh.shader) && !isSkippedGroup(subMesh.group),
    );
    const visible = candidates.filter(subMesh => !isEffectShader(subMesh.shader));
    const vertices: number[] = [];
    const triangles: number[] = [];
    collectGeometry(view, visible.length > 0 ? visible : candidates, vertices, triangles);
    // Effect planes are only dropped when they are not the sole geometry: an effect-only
    // model still has to draw something rather than produce an empty frame.
    if (triangles.length === 0 && visible.length > 0 && visible.length < candidates.length) {
        vertices.length = 0;
        collectGeometry(view, candidates, vertices, triangles);
    }
    if (triangles.length === 0) return undefined;
    return { positions: Float32Array.from(vertices), indices: Uint32Array.from(triangles) };
}

/** Concatenate meshes into one hull, skipping entries whose indices are out of range. */
export function mergeShipIconMeshes(meshes: readonly ShipIconMesh[]): ShipIconMesh | undefined {
    const parts: Array<{ positions: Float32Array; indices: Uint32Array; baseVertex: number }> = [];
    let vertexTotal = 0;
    let indexTotal = 0;
    for (const mesh of meshes) {
        if (!mesh) continue;
        const vertexCount = Math.floor(mesh.positions.length / 3);
        if (vertexCount === 0 || mesh.indices.length < 3 || mesh.indices.length % 3 !== 0) continue;
        let valid = true;
        for (let index = 0; index < mesh.indices.length; index++) {
            if ((mesh.indices[index] ?? 0) >= vertexCount) {
                valid = false;
                break;
            }
        }
        if (!valid) continue;
        parts.push({ positions: mesh.positions, indices: mesh.indices, baseVertex: vertexTotal });
        vertexTotal += vertexCount;
        indexTotal += mesh.indices.length;
    }
    if (indexTotal === 0) return undefined;

    const positions = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(indexTotal);
    let positionCursor = 0;
    let indexCursor = 0;
    for (const part of parts) {
        const floatCount = Math.floor(part.positions.length / 3) * 3;
        positions.set(part.positions.subarray(0, floatCount), positionCursor);
        positionCursor += floatCount;
        for (let index = 0; index < part.indices.length; index++) {
            indices[indexCursor + index] = part.baseVertex + (part.indices[index] ?? 0);
        }
        indexCursor += part.indices.length;
    }
    return { positions, indices };
}
