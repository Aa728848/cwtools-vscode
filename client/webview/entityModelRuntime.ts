import * as THREE from 'three';
import type { ParsedBone, ParsedLocator, ParsedSubMesh } from './pdxMeshParser';
import { pdxScriptEuler } from './pdxLocatorRotation';
import { decompressBC1, decompressBC3, rgb565 } from './bcDecode';
import { pdxHelperFunctions, pdxNormalFragmentMaps, pdxRoughnessFragment, pdxMetalnessFragment, pdxEmissiveFragment } from './pdxShaders';

export interface ResolvedMeshSetting {
    name: string;
    index?: number;
    diffuse?: string;   // webview URI
    normal?: string;
    specular?: string;
    shader?: string;
}

interface EntityMaterialData {
    resolvedMeshSettings?: readonly ResolvedMeshSetting[];
    textureMap?: Readonly<Record<string, string>>;
}

interface MaterialUpgradeOptions {
    textureCache: EntityTextureCache;
    hideSingleTexture?: boolean;
    getEnvMapIntensity(): number;
    isCurrent(): boolean;
    onError(error: unknown): void;
    customizeShader?(shader: THREE.WebGLProgramParametersWithUniforms, hasSpecularMap: boolean): void;
}

interface ScriptLocatorTransform {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
}

export function applyScriptLocatorTransform(
    object: THREE.Object3D,
    locator: ScriptLocatorTransform,
    includeScale = false,
): void {
    if (locator.position) object.position.set(...locator.position);
    if (locator.rotation) object.setRotationFromEuler(pdxScriptEuler(...locator.rotation));
    if (includeScale && locator.scale !== undefined) object.scale.setScalar(locator.scale);
}

export function decodeModelBase64(data: string): ArrayBuffer {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * Apply PDX locator transform to a Three.js object.
 * Handles `tx` (full transform matrix) and `p`/`q` (position + quaternion).
 * PDX locator tx is 16 floats (4x4 column-major), bone tx is 12 floats (3x4 column-major).
 */
export function applyLocatorTransform(obj: THREE.Object3D, loc: ParsedLocator, includeScale = false): void {
    if (loc.transform) {
        const tx = loc.transform;
        const m = new THREE.Matrix4();

        if (tx.length >= 16) {
            // 4x4 column-major (locator format): stride=4
            // Column 0: [0,1,2,3], Column 1: [4,5,6,7], Column 2: [8,9,10,11], Column 3: [12,13,14,15]
            // Three.js Matrix4.set() takes row-major arguments
            m.set(
                tx[0]!, tx[4]!, tx[8]!,  tx[12]!,  // row 0
                tx[1]!, tx[5]!, tx[9]!,  tx[13]!,  // row 1
                tx[2]!, tx[6]!, tx[10]!, tx[14]!,  // row 2
                tx[3]!, tx[7]!, tx[11]!, tx[15]!,  // row 3
            );
        } else if (tx.length >= 12) {
            // 3x4 column-major (bone format): stride=3
            // Column 0: [0,1,2], Column 1: [3,4,5], Column 2: [6,7,8], Column 3: [9,10,11]
            m.set(
                tx[0]!, tx[3]!, tx[6]!, tx[9]!,   // row 0
                tx[1]!, tx[4]!, tx[7]!, tx[10]!,   // row 1
                tx[2]!, tx[5]!, tx[8]!, tx[11]!,   // row 2
                0,      0,      0,      1,          // row 3
            );
        } else {
            // Fallback to p/q
            obj.position.set(loc.position[0], loc.position[1], loc.position[2]);
            const q = new THREE.Quaternion(loc.rotation[0], loc.rotation[1], loc.rotation[2], loc.rotation[3]);
            obj.setRotationFromQuaternion(q);
            return;
        }

        // Decompose into position, quaternion, scale
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        m.decompose(pos, quat, scl);

        obj.position.copy(pos);
        obj.quaternion.copy(quat);
        if (includeScale) obj.scale.copy(scl);
    } else {
        obj.position.set(loc.position[0], loc.position[1], loc.position[2]);
        const q = new THREE.Quaternion(loc.rotation[0], loc.rotation[1], loc.rotation[2], loc.rotation[3]);
        obj.setRotationFromQuaternion(q);
    }
}

interface SkeletonBuildResult {
    root: THREE.Bone;
    orderedBones: THREE.Bone[];
}

/** Build a THREE.Bone hierarchy from PDX parsed bone data. */
export function buildSkeletonFromParsedBones(
    parsedBones: ParsedBone[],
    positionScale = 1.0,
): SkeletonBuildResult | null {
    if (parsedBones.length === 0) return null;

    const bones: THREE.Bone[] = [];
    for (const pb of parsedBones) {
        const bone = new THREE.Bone();
        bone.name = pb.name;
        bones.push(bone);
    }

    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        if (pb.parentIndex >= 0 && pb.parentIndex < bones.length) {
            const bone = bones[i]!;
            const parent = bones[pb.parentIndex]!;
            let ancestor: THREE.Object3D | null = parent;
            while (ancestor && ancestor !== bone) ancestor = ancestor.parent;
            if (ancestor !== bone) parent.add(bone);
        }
    }

    function pdxToMatrix4(m: Float32Array): THREE.Matrix4 {
        const mat = new THREE.Matrix4();
        mat.elements[0]  = m[0]!; mat.elements[1]  = m[1]!; mat.elements[2]  = m[2]!; mat.elements[3]  = 0;
        mat.elements[4]  = m[3]!; mat.elements[5]  = m[4]!; mat.elements[6]  = m[5]!; mat.elements[7]  = 0;
        mat.elements[8]  = m[6]!; mat.elements[9]  = m[7]!; mat.elements[10] = m[8]!; mat.elements[11] = 0;
        mat.elements[12] = m[9]!; mat.elements[13] = m[10]!; mat.elements[14] = m[11]!; mat.elements[15] = 1;
        return mat;
    }

    const worldMatrices: THREE.Matrix4[] = [];
    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        const m = pb.inverseBindMatrix;
        if (!m || m.length < 12) { worldMatrices.push(new THREE.Matrix4()); continue; }
        const invBind = pdxToMatrix4(m);
        if (Math.abs(invBind.determinant()) < 1e-10) { worldMatrices.push(new THREE.Matrix4()); continue; }
        worldMatrices.push(invBind.clone().invert());
    }

    for (let i = 0; i < parsedBones.length; i++) {
        const pb = parsedBones[i]!;
        const worldMat = worldMatrices[i]!;
        let localMat: THREE.Matrix4;
        if (pb.parentIndex >= 0 && pb.parentIndex < parsedBones.length) {
            localMat = worldMatrices[pb.parentIndex]!.clone().invert().multiply(worldMat);
        } else {
            localMat = worldMat;
        }
        const pos = new THREE.Vector3(); const rot = new THREE.Quaternion(); const scl = new THREE.Vector3();
        localMat.decompose(pos, rot, scl);
        if (positionScale !== 1.0) pos.multiplyScalar(positionScale);
        bones[i]!.position.copy(pos);
        bones[i]!.quaternion.copy(rot);
        if (scl.x > 0.001 && scl.y > 0.001 && scl.z > 0.001) bones[i]!.scale.copy(scl);
    }

    const rootIdx = parsedBones.findIndex(b => b.parentIndex < 0);
    const root = rootIdx >= 0 ? bones[rootIdx]! : bones[0]!;
    root.updateWorldMatrix(false, true);

    return { root, orderedBones: bones };
}

/**
 * DDS header parsing for webview-side texture loading.
 * Decompresses BC1 (DXT1) and BC3 (DXT5) in software to RGBA DataTexture
 * so that channel remapping (PDX RRxG normals, specular) always works.
 */
function loadDDSTexture(buffer: ArrayBuffer): THREE.DataTexture | THREE.CompressedTexture | null {
    if (buffer.byteLength < 128) return null;
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x20534444) return null; // 'DDS '

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    if (width < 1 || height < 1 || width * height > 64 * 1024 * 1024) return null;
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);

    // Check for FourCC formats
    if (pfFlags & 0x4) { // DDPF_FOURCC
        const dataOffset = 128;

        switch (fourCC) {
            case 0x31545844: { // 'DXT1' = BC1
                const blockSize = 8;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const compData = new Uint8Array(buffer, dataOffset, dataLength);
                const rgba = decompressBC1(compData, width, height);
                return configureDataTexture(new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat));
            }
            case 0x35545844: { // 'DXT5' = BC3
                const blockSize = 16;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const compData = new Uint8Array(buffer, dataOffset, dataLength);
                const rgba = decompressBC3(compData, width, height);
                return configureDataTexture(new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat));
            }
            case 0x33545844: { // 'DXT3' = BC2 — rare, keep as CompressedTexture
                const blockSize = 16;
                const dataLength = Math.max(1, Math.floor((width + 3) / 4)) *
                    Math.max(1, Math.floor((height + 3) / 4)) * blockSize;
                const data = new Uint8Array(buffer, dataOffset, dataLength);
                const tex = new THREE.CompressedTexture(
                    [{ data, width, height }] as unknown as ImageData[],
                    width, height,
                    THREE.RGBA_S3TC_DXT3_Format,
                );
                tex.needsUpdate = true;
                return tex;
            }
            default:
                return decodeDDSToRGBA(buffer, width, height);
        }
    }

    // Uncompressed RGBA
    return decodeDDSToRGBA(buffer, width, height);
}

/** Configure a DataTexture with proper filtering/wrapping for 3D rendering */
function configureDataTexture(tex: THREE.DataTexture): THREE.DataTexture {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

function decodeDDSToRGBA(buffer: ArrayBuffer, width: number, height: number): THREE.DataTexture {
    const view = new DataView(buffer);
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);
    const rgbBitCount = view.getUint32(88, true);
    const rMask = view.getUint32(92, true);
    const aMask = view.getUint32(104, true);

    // DX10 extended header adds 20 bytes
    const dataOffset = (pfFlags & 0x4) && fourCC === 0x30315844 ? 148 : 128;
    const pixelCount = width * height;
    const bpp = rgbBitCount || 32;
    const bytesPerPixel = bpp / 8;
    const srcData = new Uint8Array(buffer, dataOffset, pixelCount * bytesPerPixel);
    const rgbaData = new Uint8Array(pixelCount * 4);

    if (bpp === 32) {
        // 32-bit: determine channel order from masks
        const isBGRA = (rMask === 0x00FF0000 || rMask === 0);
        for (let i = 0; i < pixelCount; i++) {
            const si = i * 4;
            if (isBGRA) {
                rgbaData[si] = srcData[si + 2]!;       // R ← B
                rgbaData[si + 1] = srcData[si + 1]!;   // G
                rgbaData[si + 2] = srcData[si]!;        // B ← R
            } else {
                rgbaData[si] = srcData[si]!;            // R
                rgbaData[si + 1] = srcData[si + 1]!;    // G
                rgbaData[si + 2] = srcData[si + 2]!;    // B
            }
            rgbaData[si + 3] = aMask ? srcData[si + 3]! : 255;
        }
    } else if (bpp === 24) {
        // 24-bit BGR (no alpha)
        for (let i = 0; i < pixelCount; i++) {
            const si = i * 3;
            rgbaData[i * 4] = srcData[si + 2]!;       // R ← B
            rgbaData[i * 4 + 1] = srcData[si + 1]!;   // G
            rgbaData[i * 4 + 2] = srcData[si]!;        // B ← R
            rgbaData[i * 4 + 3] = 255;                 // A = opaque
        }
    } else if (bpp === 16) {
        // 16-bit: likely RGB565
        for (let i = 0; i < pixelCount; i++) {
            const val = srcData[i * 2]! | (srcData[i * 2 + 1]! << 8);
            const c = rgb565(val);
            rgbaData[i * 4] = c[0];
            rgbaData[i * 4 + 1] = c[1];
            rgbaData[i * 4 + 2] = c[2];
            rgbaData[i * 4 + 3] = 255;
        }
    } else {
        // Fallback: fill grey
        console.warn(`[DDS] Unsupported uncompressed bpp: ${bpp}`);
        rgbaData.fill(128);
    }

    return configureDataTexture(new THREE.DataTexture(rgbaData, width, height, THREE.RGBAFormat));
}

/** Owns the base textures; materials own their borrowed clones. */
export class EntityTextureCache {
    private readonly entries = new Map<string, Promise<THREE.Texture | null>>();
    private readonly lifetime = new AbortController();

    async load(uri: string): Promise<THREE.Texture | null> {
        if (!uri || this.lifetime.signal.aborted) return null;
        const promise = this.entries.get(uri) ?? fetchTextureRaw(uri, this.lifetime.signal);
        this.entries.delete(uri);
        this.entries.set(uri, promise);
        if (this.entries.size > 128) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) {
                void this.entries.get(oldest)?.then(texture => texture?.dispose());
                this.entries.delete(oldest);
            }
        }
        const texture = await promise;
        return this.lifetime.signal.aborted ? null : texture?.clone() ?? null;
    }

    dispose(): void {
        this.lifetime.abort();
        for (const promise of this.entries.values()) void promise.then(texture => texture?.dispose());
        this.entries.clear();
    }
}

async function fetchTextureRaw(uri: string, signal: AbortSignal): Promise<THREE.Texture | null> {
    if (!uri) return null;
    try {
        // Check if it's a data URI (from extension-side DDS decode)
        if (uri.startsWith('data:')) {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const tex = new THREE.Texture(img);
                    tex.needsUpdate = true;
                    resolve(tex);
                };
                img.onerror = () => resolve(null);
                img.src = uri;
            });
        }

        // Fetch binary DDS via webview resource URI
        if (uri.toLowerCase().includes('.dds')) {
            const resp = await fetch(uri, { signal });
            if (!resp.ok) return null;
            const buffer = await resp.arrayBuffer();
            return loadDDSTexture(buffer);
        }

        // Standard image (PNG/TGA already decoded by extension)
        return new Promise((resolve) => {
            const loader = new THREE.TextureLoader();
            loader.load(uri, resolve, undefined, () => resolve(null));
        });
    } catch {
        return null;
    }
}

export function resolveMeshTextureUri(textureMap: Readonly<Record<string, string>>, relPath?: string): string | undefined {
    if (!relPath) return undefined;
    // Try exact
    if (Object.prototype.hasOwnProperty.call(textureMap, relPath)) return textureMap[relPath];
    // Normalize separators
    const norm = relPath.replace(/\\/g, '/');
    if (Object.prototype.hasOwnProperty.call(textureMap, norm)) return textureMap[norm];
    // Try bare filename (last component)
    const basename = norm.split('/').pop() ?? '';
    if (basename && Object.prototype.hasOwnProperty.call(textureMap, basename)) return textureMap[basename];
    // Case-insensitive
    const lower = norm.toLowerCase();
    const baseLower = basename.toLowerCase();
    for (const [k, v] of Object.entries(textureMap)) {
        if (k.toLowerCase() === lower || k.toLowerCase() === baseLower) return v;
    }
    return undefined;
}

// ── Shader Classification ────────────────────────────────────────────────────

/** Shader categories determine how we render each submesh */
type ShaderCategory = 'pbr' | 'additive' | 'invisible';

/**
 * Classify a PDX shader effect name into a render category.
 * - pbr: Standard opaque PBR (DiffuseMap + NormalMap + SpecularMap)
 * - additive: Additive/alpha blend effects → transparent in preview
 * - invisible: Shadow-only / invisible effects → transparent
 */
function classifyShader(shaderName: string): ShaderCategory {
    if (!shaderName) return 'pbr'; // default
    const s = shaderName.toLowerCase();

    // Invisible / shadow-only / collision shaders
    if (s.includes('invisible') || s.includes('shadow') || s === 'collision') return 'invisible';

    // Additive / alpha blend / flow additive / simple / hologram
    if (s.includes('additive') || s.includes('alphablend') ||
        s.includes('hologram') || s === 'pdxmeshsimple') return 'additive';

    // PBR shaders: PdxMeshStandard, PdxMeshShipFlow, PdxMeshStandardSkinned, etc.
    return 'pbr';
}

// ── PBR Material Creation ────────────────────────────────────────────────────

export interface ResolvedTextures {
    diffuse?: string;
    normal?: string;
    specular?: string;
    shader: string;
    shaderCategory: ShaderCategory;
    definedCount: number;
}

/**
 * Resolve textures for a submesh at a given index.
 * Priority: GFX/entity meshsettings → mesh-embedded material → textureMap lookup
 */
export function resolveSubmeshTextures(
    submeshIndex: number,
    submeshName: string,
    meshMaterial: { shader?: string; diffuse?: string; normal?: string; specular?: string },
    entity: EntityMaterialData,
    meshIndexInShape = 0,
    debug = false,
): ResolvedTextures {
    // Match by shape name + mesh index within shape (meshsettings index = material slot within shape)
    const meshSettings = entity.resolvedMeshSettings ?? [];
    const namedSetting = meshSettings.find(s => s.name === submeshName && s.index === meshIndexInShape)
        ?? meshSettings.find(s => s.name === submeshName);
    const unnamedSettings = meshSettings.filter(s => s.name === '__unnamed');
    // A sole unnamed meshsettings block is the default for the whole mesh. If there are
    // multiple unnamed blocks, their intended targets are ambiguous, so do not guess.
    // Never let that default turn collision/shadow geometry into a visible PBR mesh.
    const canUseGlobalDefault = classifyShader(meshMaterial.shader ?? '') !== 'invisible';
    const globalDefaultSetting = unnamedSettings.length === 1 && canUseGlobalDefault
        ? unnamedSettings[0]
        : undefined;
    const ms = namedSetting ?? globalDefaultSetting;
    const textureMap = entity.textureMap ?? {};

    // GFX meshsettings shader takes priority over binary mesh shader
    const shader = ms?.shader || meshMaterial.shader || 'PdxMeshStandard';
    const shaderCategory = classifyShader(shader);

    const hasDiffuse = !!(ms?.diffuse || meshMaterial.diffuse);
    const hasNormal = !!(ms?.normal || meshMaterial.normal);
    const hasSpecular = !!(ms?.specular || meshMaterial.specular);
    const definedCount = [hasDiffuse, hasNormal, hasSpecular].filter(Boolean).length;

    const result: ResolvedTextures = {
        diffuse: ms?.diffuse ?? resolveMeshTextureUri(textureMap, meshMaterial.diffuse),
        normal: ms?.normal ?? resolveMeshTextureUri(textureMap, meshMaterial.normal),
        specular: ms?.specular ?? resolveMeshTextureUri(textureMap, meshMaterial.specular),
        shader,
        shaderCategory,
        definedCount,
    };

    if (debug) console.log(`[Material] Submesh ${submeshIndex} "${submeshName}" shader="${shader}" cat=${shaderCategory} defined=${definedCount} ms=${ms ? `found(${ms.name})` : 'none'} resolved=(${result.diffuse ? '✓' : '✗'}, ${result.normal ? '✓' : '✗'}, ${result.specular ? '✓' : '✗'})`);

    return result;
}

/**
 * Create a placeholder material synchronously.
 */
export function createPlaceholderMaterial(textures: ResolvedTextures, hideSingleTexture = true): THREE.MeshStandardMaterial {
    if (textures.shaderCategory !== 'pbr' || (hideSingleTexture && textures.definedCount === 1)) {
        return new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    return new THREE.MeshStandardMaterial({
        color: 0x666666,
        metalness: 0.15,
        roughness: 0.65,
        side: THREE.DoubleSide,
    });
}

/**
 * Fetch textures asynchronously and upgrade the material.
 */
export async function upgradeSubmeshMaterial(
    mesh: THREE.Mesh,
    textures: ResolvedTextures,
    options: MaterialUpgradeOptions,
): Promise<void> {
    if (textures.shaderCategory !== 'pbr' || ((options.hideSingleTexture ?? true) && textures.definedCount === 1)) {
        return;
    }

    const hasAnyResolved = textures.diffuse || textures.normal || textures.specular;
    if (!hasAnyResolved) return;

    if (!options.isCurrent()) return;
    try {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x888888,
            metalness: textures.specular ? 1.0 : 0.15,
            roughness: textures.specular ? 1.0 : 0.65,
            side: THREE.DoubleSide,
            envMapIntensity: options.getEnvMapIntensity(),
            emissive: 0x000000,
            emissiveIntensity: 0.0,
        });

        const [diffTex, normTex, specTex] = await Promise.all([
            options.textureCache.load(textures.diffuse ?? ''),
            options.textureCache.load(textures.normal ?? ''),
            options.textureCache.load(textures.specular ?? ''),
        ]);

        if (!options.isCurrent()) {
            diffTex?.dispose();
            normTex?.dispose();
            specTex?.dispose();
            mat.dispose();
            return;
        }

        if (diffTex) {
            diffTex.colorSpace = THREE.SRGBColorSpace;
            mat.map = diffTex;
            mat.color.set(0xffffff);
        }

        if (normTex) {
            normTex.colorSpace = THREE.LinearSRGBColorSpace;
            mat.normalMap = normTex;
        }

        if (specTex) {
            specTex.colorSpace = THREE.LinearSRGBColorSpace;
            mat.roughnessMap = specTex;
            mat.metalnessMap = specTex;
            mat.roughness = 1.0;
            mat.metalness = 1.0;
        }

        mat.onBeforeCompile = (shader) => {
            const hasNormalAtCompile = !!mat.normalMap;
            const hasSpecAtCompile = !!mat.roughnessMap;

            // Inject PDX GLSL shader fragment (imported from pdxShaders.ts)
            shader.fragmentShader = pdxHelperFunctions + shader.fragmentShader;

            if (hasNormalAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_maps>', pdxNormalFragmentMaps);
            }

            if (hasSpecAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <roughnessmap_fragment>', pdxRoughnessFragment);
            }

            if (hasSpecAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <metalnessmap_fragment>', pdxMetalnessFragment);
            }

            if (hasNormalAtCompile) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <emissivemap_fragment>', pdxEmissiveFragment);
            }
            options.customizeShader?.(shader, hasSpecAtCompile);
        };

        mat.needsUpdate = true;
        
        if (mesh.material instanceof THREE.Material) {
            mesh.material.dispose();
        }
        mesh.material = mat;
    } catch (err) {
        if (options.isCurrent()) options.onError(err);
    }
}

export function scaleFloat32Array(values: Float32Array, scale: number): Float32Array {
    if (scale === 1.0) return values;
    const scaled = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
        scaled[i] = values[i]! * scale;
    }
    return scaled;
}

export function buildGeometry(subMesh: ParsedSubMesh, positionScale = 1.0): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();

    // Positions (vec3)
    const positions = scaleFloat32Array(subMesh.positions, positionScale);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Normals (vec3)
    if (subMesh.normals.length > 0) {
        geo.setAttribute('normal', new THREE.BufferAttribute(subMesh.normals, 3));
    }

    // Tangents (vec4)
    if (subMesh.tangents && subMesh.tangents.length > 0) {
        geo.setAttribute('tangent', new THREE.BufferAttribute(subMesh.tangents, 4));
    }

    // UVs — channel 0
    // PDX UVs use DirectX convention (V=0 at top), matching DDS top-down storage
    if (subMesh.uvs.length > 0 && subMesh.uvs[0]!.length > 0) {
        geo.setAttribute('uv', new THREE.BufferAttribute(subMesh.uvs[0]!, 2));
    }

    // Skinning attributes
    if (subMesh.skin) {
        const vertexCount = positions.length / 3;

        const declared = subMesh.skin.boneCount || 4;
        const derived = vertexCount > 0
            ? Math.round(subMesh.skin.boneIndices.length / vertexCount)
            : declared;
        const stride = derived >= 1 && derived <= 8 ? derived : declared;
        const influences = Math.min(stride, 4);

        // First pass: find the majority bone index among valid vertices
        const boneCounts = new Map<number, number>();
        for (let v = 0; v < vertexCount; v++) {
            for (let b = 0; b < influences; b++) {
                const idx = subMesh.skin.boneIndices[v * stride + b] ?? -1;
                const wt = subMesh.skin.weights[v * stride + b] ?? 0;
                if (idx >= 0 && wt > 0.001) {
                    boneCounts.set(idx, (boneCounts.get(idx) || 0) + 1);
                }
            }
        }
        let defaultBone = 0;
        let maxCount = 0;
        for (const [boneIdx, count] of boneCounts) {
            if (count > maxCount) { maxCount = count; defaultBone = boneIdx; }
        }

        // Second pass: build skinIndex/skinWeight buffers
        const skinIndices = new Uint16Array(vertexCount * 4);
        const skinWeights = new Float32Array(vertexCount * 4);
        for (let v = 0; v < vertexCount; v++) {
            let weightSum = 0;
            for (let b = 0; b < influences; b++) {
                const rawIdx = subMesh.skin.boneIndices[v * stride + b] ?? -1;
                const rawWt = subMesh.skin.weights[v * stride + b] ?? 0;
                skinIndices[v * 4 + b] = rawIdx >= 0 ? rawIdx : 0;
                skinWeights[v * 4 + b] = rawIdx >= 0 ? rawWt : 0;
                weightSum += skinWeights[v * 4 + b]!;
            }
            // Unbound vertices: bind to the majority bone so they move
            // with the rest of the submesh instead of collapsing to origin.
            if (weightSum < 0.001) {
                skinIndices[v * 4] = defaultBone;
                skinWeights[v * 4] = 1.0;
            }
        }
        geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
    }

    // Index buffer
    geo.setIndex(new THREE.BufferAttribute(subMesh.indices, 1));

    // Compute missing normals if needed
    if (!subMesh.normals || subMesh.normals.length === 0) {
        geo.computeVertexNormals();
    }

    return geo;
}
