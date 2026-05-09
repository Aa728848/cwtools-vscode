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
    /** Full 4x4 transform matrix (column-major 12 floats from PDX tx property) */
    transform?: Float32Array;
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
        const pa = asString(locNode.props.get('pa') ?? []);
        const txProp = locNode.props.get('tx');

        if (txProp) {
            // Full transform matrix (12 floats: 3x4 column-major, same as bone tx)
            const tx = asFloat32(txProp);
            // PDX tx is a 3x4 column-major matrix:
            // col0: tx[0..2], col1: tx[3..5], col2: tx[6..8], col3(translation): tx[9..11]
            // Blender reads it as: row0=(tx[0],tx[3],tx[6],tx[9]), row1=(tx[1],tx[4],tx[7],tx[10]), ...
            return {
                name: locNode.name,
                position: [tx[9] ?? 0, tx[10] ?? 0, tx[11] ?? 0] as [number, number, number],
                rotation: [0, 0, 0, 1] as [number, number, number, number], // will be overridden by transform
                parentBone: pa || undefined,
                transform: tx,
            };
        }

        const p = asNumberArray(locNode.props.get('p') ?? [0, 0, 0]);
        const q = asNumberArray(locNode.props.get('q') ?? [0, 0, 0, 1]);
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


    // Find the 'object' root node (contains shapes)
    const objectRoot = tree.children.find(c => c.name === 'object');
    if (objectRoot) {
        // Iterate ALL children of object — don't filter by name.
        // PDX mesh files may name shape nodes differently.
        for (const shapeNode of objectRoot.children) {


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


    return result;
}

// ── PDX Animation (.anim) Parser ─────────────────────────────────────────────

export interface ParsedAnimBone {
    name: string;
    /** Which channels are animated: combination of 't','q','s' */
    animatedChannels: string;
    translations?: Float32Array;  // N*3 (xyz per frame)
    rotations?: Float32Array;     // N*4 (quaternion xyzw per frame)
    scales?: Float32Array;        // N*1 (uniform scale per frame)
}

export interface ParsedAnimation {
    fps: number;
    sampleCount: number;
    boneCount: number;
    bones: ParsedAnimBone[];
}

/**
 * Parse a PDX .anim binary file into structured animation data.
 *
 * .anim format (from io_pdx_mesh reference):
 *   info { fps(float), sa(int=frameCount), j(int=boneCount) }
 *     bone_name { sa(string="q"/"tq"/"tqs"), t(float[3]), q(float[4]), s(float[1]) }
 *     bone_name { ... }
 *   samples { t(float[...]), q(float[...]), s(float[...]) }
 *
 * The 'sa' on each bone tells which channels are animated.
 * The 'samples' node contains FLAT arrays where data is interleaved:
 *   for each frame: for each bone (that has that channel): extract stride
 */
export function parsePdxAnim(buffer: ArrayBuffer): ParsedAnimation {
    const tree = parseToTree(buffer);

    // Find 'info' node
    const infoNode = tree.children.find(c => c.name === 'info');
    if (!infoNode) throw new Error('[PDX Anim] No "info" node found');

    const fpsProp = infoNode.props.get('fps');
    const saProp = infoNode.props.get('sa');
    const jProp = infoNode.props.get('j');

    const fps = fpsProp ? asNumberArray(fpsProp)[0] ?? 15 : 15;
    let sampleCount = saProp ? asNumberArray(saProp)[0] ?? 1 : 1;
    const boneCount = jProp ? asNumberArray(jProp)[0] ?? 0 : 0;

    // Parse bone info from CHILDREN of 'info' node (not top-level!)
    const boneInfos: Array<{ name: string; sa: string }> = [];
    for (const child of infoNode.children) {
        const saPropBone = child.props.get('sa');
        const sa = saPropBone ? asString(saPropBone) : '';
        boneInfos.push({ name: child.name, sa });
    }

    // Find 'samples' node (child of root, sibling of 'info')
    const samplesNode = tree.children.find(c => c.name === 'samples');

    // If header sampleCount is ≤ 1 but samples node has data,
    // compute real sample count from data size and animated channel counts.
    if (samplesNode && sampleCount <= 1) {
        const sampleT = samplesNode.props.get('t') ? asFloat32(samplesNode.props.get('t')!) : null;
        const sampleQ = samplesNode.props.get('q') ? asFloat32(samplesNode.props.get('q')!) : null;
        const sampleS = samplesNode.props.get('s') ? asFloat32(samplesNode.props.get('s')!) : null;
        // Count bones with each animated channel
        let tBones = 0, qBones = 0, sBones = 0;
        for (const bi of boneInfos) {
            if (bi.sa.includes('t')) tBones++;
            if (bi.sa.includes('q')) qBones++;
            if (bi.sa.includes('s')) sBones++;
        }
        // Derive frame count from whichever channel has data
        if (sampleT && tBones > 0) sampleCount = Math.max(sampleCount, sampleT.length / 3 / tBones);
        if (sampleQ && qBones > 0) sampleCount = Math.max(sampleCount, sampleQ.length / 4 / qBones);
        if (sampleS && sBones > 0) sampleCount = Math.max(sampleCount, sampleS.length / sBones);
        sampleCount = Math.floor(sampleCount);
    }

    // Build per-bone keyframe tracks by deinterleaving samples
    const bones: ParsedAnimBone[] = [];

    if (samplesNode && sampleCount > 1) {
        const sampleQ = samplesNode.props.get('q') ? asFloat32(samplesNode.props.get('q')!) : null;
        const sampleT = samplesNode.props.get('t') ? asFloat32(samplesNode.props.get('t')!) : null;
        const sampleS = samplesNode.props.get('s') ? asFloat32(samplesNode.props.get('s')!) : null;



        // Determine scale stride (1 for uniform, 3 for non-uniform)
        const scaleLen = 1; // Stellaris uses uniform scale

        // Allocate output per-bone arrays
        const boneData = new Map<string, ParsedAnimBone>();
        for (const bi of boneInfos) {
            const bone: ParsedAnimBone = { name: bi.name, animatedChannels: bi.sa };
            if (bi.sa.includes('q')) bone.rotations = new Float32Array(sampleCount * 4);
            if (bi.sa.includes('t')) bone.translations = new Float32Array(sampleCount * 3);
            if (bi.sa.includes('s')) bone.scales = new Float32Array(sampleCount);
            boneData.set(bi.name, bone);
        }

        // Deinterleave: for each frame, for each bone (in order), extract stride
        let qIdx = 0, tIdx = 0, sIdx = 0;
        for (let frame = 0; frame < sampleCount; frame++) {
            for (const bi of boneInfos) {
                const bone = boneData.get(bi.name)!;
                if (bi.sa.includes('q') && sampleQ && bone.rotations) {
                    bone.rotations[frame * 4 + 0] = sampleQ[qIdx]!;
                    bone.rotations[frame * 4 + 1] = sampleQ[qIdx + 1]!;
                    bone.rotations[frame * 4 + 2] = sampleQ[qIdx + 2]!;
                    bone.rotations[frame * 4 + 3] = sampleQ[qIdx + 3]!;
                    qIdx += 4;
                }
                if (bi.sa.includes('t') && sampleT && bone.translations) {
                    bone.translations[frame * 3 + 0] = sampleT[tIdx]!;
                    bone.translations[frame * 3 + 1] = sampleT[tIdx + 1]!;
                    bone.translations[frame * 3 + 2] = sampleT[tIdx + 2]!;
                    tIdx += 3;
                }
                if (bi.sa.includes('s') && sampleS && bone.scales) {
                    bone.scales[frame] = sampleS[sIdx]!;
                    sIdx += scaleLen;
                }
            }
        }

        for (const bi of boneInfos) {
            const bone = boneData.get(bi.name)!;
            const child = infoNode.children.find(c => c.name === bi.name);

            // For channels NOT in 'sa' (not animated in samples), use the initial
            // value from the info node as a constant single-frame track.
            // This is critical for bones that have a constant transform (e.g. a fixed
            // tilt angle) that is not animated across frames.
            if (child) {
                if (!bi.sa.includes('t')) {
                    const tProp = child.props.get('t');
                    if (tProp) bone.translations = asFloat32(tProp);
                }
                if (!bi.sa.includes('q')) {
                    const qProp = child.props.get('q');
                    if (qProp) bone.rotations = asFloat32(qProp);
                }
                if (!bi.sa.includes('s')) {
                    const sProp = child.props.get('s');
                    if (sProp) bone.scales = asFloat32(sProp);
                }
            }

            bones.push(bone);
        }
    } else {
        // No samples or 1 frame — use initial pose from info bone props
        for (const bi of boneInfos) {
            const child = infoNode.children.find(c => c.name === bi.name)!;
            const tProp = child.props.get('t');
            const qProp = child.props.get('q');
            const sProp = child.props.get('s');
            bones.push({
                name: bi.name,
                animatedChannels: bi.sa,
                translations: tProp ? asFloat32(tProp) : undefined,
                rotations: qProp ? asFloat32(qProp) : undefined,
                scales: sProp ? asFloat32(sProp) : undefined,
            });
        }
    }

    return { fps, sampleCount, boneCount, bones };
}
