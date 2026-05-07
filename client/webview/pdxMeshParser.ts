/**
 * PDX Mesh Binary Parser
 *
 * Parses Clausewitz Engine .mesh binary files into structured data
 * that Three.js can directly consume. Ported from io_pdx_mesh/pdx_data.py.
 *
 * Binary format:
 *   header: @@b@ (4 bytes)
 *   Then alternating objects ([depth][name]\0) and properties (![len][name][type][count][data])
 *   Data types: 'i' = int32, 'f' = float32, 's' = string
 *
 * Uses zero-copy TypedArray slicing for large vertex/index arrays to avoid
 * memory duplication on 50-100MB mod meshes.
 */

// ── Data Structures ──────────────────────────────────────────────────────────

export interface ParsedMeshMaterial {
    shader: string;
    diffuse?: string;
    normal?: string;
    specular?: string;
}

export interface ParsedSubMesh {
    name: string;
    positions: Float32Array;
    normals: Float32Array;
    tangents?: Float32Array;
    uvs: Float32Array[];
    indices: Uint16Array | Uint32Array;
    material: ParsedMeshMaterial;
    boundingSphere?: { cx: number; cy: number; cz: number; r: number };
    aabb?: { min: [number, number, number]; max: [number, number, number] };
    skin?: {
        boneCount: number;
        boneIndices: Int32Array;
        weights: Float32Array;
    };
}

export interface ParsedBone {
    name: string;
    index: number;
    parentIndex: number;
    inverseBindMatrix: Float32Array; // 3×4 = 12 floats
}

export interface ParsedLocator {
    name: string;
    position: [number, number, number];
    rotation: [number, number, number, number]; // quaternion (x,y,z,w)
    parentBone?: string;
}

export interface ParsedShape {
    lod: number;
    meshes: ParsedSubMesh[];
    skeleton: ParsedBone[];
}

export interface ParsedMeshFile {
    shapes: ParsedShape[];
    locators: ParsedLocator[];
}

// ── Parser Implementation ────────────────────────────────────────────────────

const HEADER_MAGIC = 0x40624040; // '@@b@' as little-endian uint32

/**
 * Read a null-terminated latin-1 string starting at `pos`.
 * Returns [string, newPos].
 */
function readCString(view: DataView, pos: number): [string, number] {
    let str = '';
    while (pos < view.byteLength) {
        const b = view.getUint8(pos);
        if (b === 0) { pos++; break; }
        str += String.fromCharCode(b);
        pos++;
    }
    return [str, pos];
}

/**
 * Parse a property value block: type(1) + count(4) + data
 * Returns [values, newPos].
 *
 * For large arrays, attempts zero-copy TypedArray slicing. Falls back to
 * byte-copy if the offset isn't aligned (TypedArrays require alignment
 * equal to their element size).
 */
function parsePropertyData(
    view: DataView,
    buffer: ArrayBuffer,
    pos: number,
): [number[] | string[] | Float32Array | Int32Array, number, string] {
    const typeChar = String.fromCharCode(view.getUint8(pos));
    pos += 1;
    const count = view.getInt32(pos, true);
    pos += 4;

    if (typeChar === 'i') {
        const byteLen = count * 4;
        if (count > 64) {
            // Zero-copy only if 4-byte aligned; otherwise copy
            if (pos % 4 === 0) {
                const arr = new Int32Array(buffer, pos, count);
                return [arr, pos + byteLen, 'i'];
            }
            const copy = new Int32Array(count);
            for (let i = 0; i < count; i++) {
                copy[i] = view.getInt32(pos + i * 4, true);
            }
            return [copy, pos + byteLen, 'i'];
        }
        const vals: number[] = [];
        for (let i = 0; i < count; i++) {
            vals.push(view.getInt32(pos, true));
            pos += 4;
        }
        return [vals, pos, 'i'];
    }

    if (typeChar === 'f') {
        const byteLen = count * 4;
        if (count > 64) {
            // Zero-copy only if 4-byte aligned; otherwise copy
            if (pos % 4 === 0) {
                const arr = new Float32Array(buffer, pos, count);
                return [arr, pos + byteLen, 'f'];
            }
            const copy = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                copy[i] = view.getFloat32(pos + i * 4, true);
            }
            return [copy, pos + byteLen, 'f'];
        }
        const vals: number[] = [];
        for (let i = 0; i < count; i++) {
            vals.push(view.getFloat32(pos, true));
            pos += 4;
        }
        return [vals, pos, 'f'];
    }

    if (typeChar === 's') {
        // String: read string length (int32), then string bytes
        const strLen = view.getInt32(pos, true);
        pos += 4;
        let str = '';
        for (let i = 0; i < strLen; i++) {
            const b = view.getUint8(pos + i);
            if (b !== 0) str += String.fromCharCode(b);
        }
        pos += strLen;
        return [[str], pos, 's'];
    }

    throw new Error(`Unknown PDX data type '${typeChar}' at offset ${pos - 5}`);
}

// ── Helpers to coerce parsed values ──────────────────────────────────────────

function asNumberArray(v: number[] | string[] | Float32Array | Int32Array): number[] {
    if (v instanceof Float32Array || v instanceof Int32Array) return Array.from(v);
    return v as number[];
}

function asFloat32(v: number[] | string[] | Float32Array | Int32Array): Float32Array {
    if (v instanceof Float32Array) return v;
    if (v instanceof Int32Array) return new Float32Array(v);
    return new Float32Array(v as number[]);
}

function asInt32(v: number[] | string[] | Float32Array | Int32Array): Int32Array {
    if (v instanceof Int32Array) return v;
    if (v instanceof Float32Array) return new Int32Array(v);
    return new Int32Array(v as number[]);
}

function asString(v: number[] | string[] | Float32Array | Int32Array): string {
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
    return '';
}

// ── Intermediate parse tree ──────────────────────────────────────────────────

interface PdxNode {
    name: string;
    depth: number;
    props: Map<string, number[] | string[] | Float32Array | Int32Array>;
    children: PdxNode[];
}

/**
 * Parse a .mesh binary buffer into an intermediate tree structure.
 * This scans structure headers ([object and !property markers) and uses
 * zero-copy TypedArray slicing for large data arrays.
 */
function parseToTree(
    buffer: ArrayBuffer,
    onProgress?: (percent: number) => void,
): PdxNode {
    const view = new DataView(buffer);
    const eof = buffer.byteLength;
    let pos = 0;

    // Validate header
    if (eof < 4 || view.getUint32(0, true) !== HEADER_MAGIC) {
        throw new Error('Invalid PDX mesh file: missing @@b@ header');
    }
    pos = 4;

    const root: PdxNode = { name: 'File', depth: 0, props: new Map(), children: [] };
    const depthStack: PdxNode[] = [root];
    let currentDepth = 0;
    let lastProgressReport = 0;

    while (pos < eof) {
        // Progress reporting for large files
        if (onProgress && pos - lastProgressReport > 1024 * 1024) {
            onProgress(Math.floor((pos / eof) * 100));
            lastProgressReport = pos;
        }

        const nextByte = view.getUint8(pos);

        // Object: starts with '[' (0x5B)
        if (nextByte === 0x5B) {
            let depth = 0;
            while (pos < eof && view.getUint8(pos) === 0x5B) {
                depth++;
                pos++;
            }
            const [objName, newPos] = readCString(view, pos);
            pos = newPos;

            const node: PdxNode = { name: objName, depth, props: new Map(), children: [] };

            // Adjust stack to match depth
            if (depth <= currentDepth) {
                // Go back up the tree
                while (depthStack.length > depth) depthStack.pop();
            }

            const parent = depthStack[depthStack.length - 1]!;
            parent.children.push(node);
            depthStack.push(node);
            currentDepth = depth;
        }
        // Property: starts with '!' (0x21)
        else if (nextByte === 0x21) {
            pos++; // skip '!'
            const nameLen = view.getUint8(pos);
            pos++;
            let propName = '';
            for (let i = 0; i < nameLen; i++) {
                propName += String.fromCharCode(view.getUint8(pos + i));
            }
            pos += nameLen;

            const [values, newPos] = parsePropertyData(view, buffer, pos);
            pos = newPos;

            const current = depthStack[depthStack.length - 1]!;
            current.props.set(propName, values);
        }
        else {
            throw new Error(`Unknown byte 0x${nextByte.toString(16)} at offset ${pos}`);
        }
    }

    if (onProgress) onProgress(100);
    return root;
}

// ── Tree → ParsedMeshFile conversion ─────────────────────────────────────────

function extractMaterial(meshNode: PdxNode): ParsedMeshMaterial {
    const matNode = meshNode.children.find(c => c.name === 'material');
    if (!matNode) return { shader: 'PdxMeshStandard' };
    return {
        shader: asString(matNode.props.get('shader') ?? ['']),
        diffuse: asString(matNode.props.get('diff') ?? []),
        normal: asString(matNode.props.get('n') ?? []),
        specular: asString(matNode.props.get('spec') ?? []),
    };
}

function extractSkin(meshNode: PdxNode): ParsedSubMesh['skin'] | undefined {
    const skinNode = meshNode.children.find(c => c.name === 'skin');
    if (!skinNode) return undefined;
    const bones = skinNode.props.get('bones');
    const ix = skinNode.props.get('ix');
    const w = skinNode.props.get('w');
    if (!bones || !ix || !w) return undefined;
    return {
        boneCount: asNumberArray(bones)[0] ?? 0,
        boneIndices: asInt32(ix),
        weights: asFloat32(w),
    };
}

function extractSubMesh(meshNode: PdxNode, nameOverride?: string): ParsedSubMesh {
    const p = meshNode.props.get('p');
    const n = meshNode.props.get('n');
    const ta = meshNode.props.get('ta');
    const tri = meshNode.props.get('tri');

    if (!p || !tri) throw new Error(`Mesh node missing positions or triangles`);

    const positions = asFloat32(p);
    const normals = n ? asFloat32(n) : new Float32Array(positions.length);
    const tangents = ta ? asFloat32(ta) : undefined;

    // Collect UV channels
    const uvs: Float32Array[] = [];
    for (let i = 0; i <= 3; i++) {
        const uv = meshNode.props.get(`u${i}`);
        if (uv) uvs.push(asFloat32(uv));
    }

    // Triangle indices
    const rawIndices = asInt32(tri);
    const vertexCount = positions.length / 3;
    const indices = vertexCount > 65535
        ? new Uint32Array(rawIndices)
        : new Uint16Array(rawIndices);

    // AABB
    const aabbNode = meshNode.children.find(c => c.name === 'aabb');
    let aabb: ParsedSubMesh['aabb'] | undefined;
    if (aabbNode) {
        const min = asNumberArray(aabbNode.props.get('min') ?? []);
        const max = asNumberArray(aabbNode.props.get('max') ?? []);
        if (min.length >= 3 && max.length >= 3) {
            aabb = {
                min: [min[0]!, min[1]!, min[2]!],
                max: [max[0]!, max[1]!, max[2]!],
            };
        }
    }

    // Bounding sphere
    const bs = meshNode.props.get('boundingsphere');
    let boundingSphere: ParsedSubMesh['boundingSphere'] | undefined;
    if (bs) {
        const bsArr = asNumberArray(bs);
        if (bsArr.length >= 4) {
            boundingSphere = { cx: bsArr[0]!, cy: bsArr[1]!, cz: bsArr[2]!, r: bsArr[3]! };
        }
    }

    return {
        name: nameOverride || meshNode.name,
        positions,
        normals,
        tangents,
        uvs,
        indices,
        material: extractMaterial(meshNode),
        aabb,
        boundingSphere,
        skin: extractSkin(meshNode),
    };
}

function extractSkeleton(skelNode: PdxNode): ParsedBone[] {
    return skelNode.children.map(boneNode => {
        const ix = asNumberArray(boneNode.props.get('ix') ?? [0]);
        const pa = asNumberArray(boneNode.props.get('pa') ?? [-1]);
        const tx = boneNode.props.get('tx');
        return {
            name: boneNode.name,
            index: ix[0] ?? 0,
            parentIndex: pa[0] ?? -1,
            inverseBindMatrix: tx ? asFloat32(tx) : new Float32Array(12),
        };
    });
}

function extractLocators(locatorRoot: PdxNode): ParsedLocator[] {
    return locatorRoot.children.map(locNode => {
        const p = asNumberArray(locNode.props.get('p') ?? [0, 0, 0]);
        const q = asNumberArray(locNode.props.get('q') ?? [0, 0, 0, 1]);
        const pa = asString(locNode.props.get('pa') ?? []);
        return {
            name: locNode.name,
            position: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0],
            rotation: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1],
            parentBone: pa || undefined,
        };
    });
}

/**
 * Parse a .mesh binary ArrayBuffer into a ParsedMeshFile.
 *
 * @param buffer - Raw binary data from the .mesh file
 * @param onProgress - Optional callback for progress (0-100)
 * @param maxLod - Maximum LOD level to parse (default 0 = highest quality only)
 */
export function parsePdxMesh(
    buffer: ArrayBuffer,
    onProgress?: (percent: number) => void,
    maxLod = 0,
): ParsedMeshFile {
    const tree = parseToTree(buffer, onProgress);

    const result: ParsedMeshFile = { shapes: [], locators: [] };

    // Debug: log the top-level tree structure
    console.log('[PDX Mesh] Tree root children:', tree.children.map(c =>
        `${c.name}(props=[${[...c.props.keys()].join(',')}], children=[${c.children.map(cc => cc.name).join(',')}])`
    ).join(' | '));

    // Find the 'object' root node (contains shapes)
    const objectRoot = tree.children.find(c => c.name === 'object');
    if (objectRoot) {
        // Iterate ALL children of object — don't filter by name.
        // PDX mesh files may name shape nodes differently.
        for (const shapeNode of objectRoot.children) {
            console.log(`[PDX Mesh] object child: "${shapeNode.name}", props=[${[...shapeNode.props.keys()].join(',')}], children=[${shapeNode.children.map(c => c.name).join(',')}]`);

            const lodProp = shapeNode.props.get('lod');
            const lod = lodProp ? asNumberArray(lodProp)[0] ?? 0 : 0;
            if (lod > maxLod) continue;

            const meshes: ParsedSubMesh[] = [];
            let skeleton: ParsedBone[] = [];

            // Strategy 1: This node itself has mesh data (p + tri)
            if (shapeNode.props.has('p') && shapeNode.props.has('tri')) {
                try {
                    meshes.push(extractSubMesh(shapeNode));
                } catch (e) {
                    console.warn(`[PDX Mesh] Failed to extract mesh from "${shapeNode.name}": ${e}`);
                }
            }

            // Strategy 2: Children have mesh data
            for (const child of shapeNode.children) {
                if (child.props.has('p') && child.props.has('tri')) {
                    try {
                        // Use parent shape name (e.g. 'HullShape') instead of generic child name ('mesh')
                        meshes.push(extractSubMesh(child, shapeNode.name));
                    } catch (e) {
                        console.warn(`[PDX Mesh] Failed to parse sub-mesh "${child.name}": ${e}`);
                    }
                } else if (child.name === 'skeleton') {
                    skeleton = extractSkeleton(child);
                } else {
                    // Strategy 3: Grandchildren have mesh data
                    for (const gc of child.children) {
                        if (gc.props.has('p') && gc.props.has('tri')) {
                            try {
                                // Use grandparent shape name
                                meshes.push(extractSubMesh(gc, shapeNode.name));
                            } catch (e) {
                                console.warn(`[PDX Mesh] Failed to parse gc-mesh "${gc.name}": ${e}`);
                            }
                        }
                    }
                }
            }

            if (meshes.length > 0 || skeleton.length > 0) {
                result.shapes.push({ lod, meshes, skeleton });
            }
        }
    } else {
        console.warn('[PDX Mesh] No "object" node found. Top-level:', tree.children.map(c => c.name).join(', '));
    }

    // Find the 'locator' root node
    const locatorRoot = tree.children.find(c => c.name === 'locator');
    if (locatorRoot) {
        result.locators = extractLocators(locatorRoot);
    }

    console.log(`[PDX Mesh] Result: ${result.shapes.length} shapes, ${result.shapes.reduce((s, sh) => s + sh.meshes.length, 0)} submeshes, ${result.locators.length} locators`);

    return result;
}
