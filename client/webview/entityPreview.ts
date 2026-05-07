/**
 * Entity Preview — Three.js Webview Renderer
 *
 * Renders PDX entity models in a VS Code webview using Three.js.
 * Handles mesh loading via Web Worker, DDS texture decoding, PBR material
 * pipeline, and interactive orbit camera controls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parsePdxMesh, type ParsedMeshFile, type ParsedSubMesh } from './pdxMeshParser';

// ── VS Code API ──────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

// ── i18n ─────────────────────────────────────────────────────────────────────

const locale = document.body.dataset.locale ?? 'en';
const isChinese = locale.startsWith('zh');

const i18n: Record<string, { en: string; zh: string }> = {
    title:          { en: 'Entity Preview',               zh: '实体预览' },
    focus:          { en: 'Focus (F)',                     zh: '聚焦 (F)' },
    wireframe:      { en: 'Wireframe',                     zh: '线框' },
    locators:       { en: 'Locators',                      zh: '定位器' },
    disableNormals: { en: 'Disable Normals',               zh: '禁用法线' },
    loading:        { en: 'Loading...',                     zh: '加载中...' },
    noEntity:       { en: 'No entity loaded',              zh: '未加载实体' },
    openHint:       { en: 'Open a .asset file and click preview', zh: '打开 .asset 文件并点击预览按钮' },
};

function applyI18n() {
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n!;
        const entry = i18n[key];
        if (entry) {
            el.textContent = isChinese ? entry.zh : entry.en;
        }
    });
}

applyI18n();

interface ResolvedMeshSetting {
    name: string;
    index: number;
    diffuse?: string;   // webview URI
    normal?: string;
    specular?: string;
    shader?: string;
}

interface EntityData {
    name: string;
    pdxmesh?: string;
    scale?: number;
    resolvedMeshSettings?: ResolvedMeshSetting[];
    textureMap?: Record<string, string>;  // relative path → webview URI
    locators?: Array<{
        name: string;
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?: number;
    }>;
    attaches?: Array<{ locatorName: string; entityName: string }>;
    states?: Array<{ name: string }>;
}

interface RenderMessage {
    command: 'render';
    entity: EntityData;
    meshBase64?: string;  // base64-encoded .mesh binary
    fileName: string;
}

// ── DOM Elements ─────────────────────────────────────────────────────────────

const toolbar = document.getElementById('toolbar')!;
const canvasContainer = document.getElementById('canvas-container')!;
const loadingOverlay = document.getElementById('loading-overlay')!;
const progressText = loadingOverlay.querySelector('.progress-text') as HTMLElement;
const progressBarFill = loadingOverlay.querySelector('.progress-bar-fill') as HTMLElement;
const infoPanel = document.getElementById('info-panel')!;
const entityTree = document.getElementById('entity-tree')!;
const errorBanner = document.getElementById('error-banner')!;
const emptyState = document.getElementById('empty-state')!;

// Toolbar controls
const entityNameEl = toolbar.querySelector('.entity-name') as HTMLElement;
const wireframeToggle = document.getElementById('chk-wireframe') as HTMLInputElement;
const locatorToggle = document.getElementById('chk-locators') as HTMLInputElement;
const normalToggle = document.getElementById('chk-normals') as HTMLInputElement;

// ── Three.js Setup ───────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let currentModel: THREE.Group | null = null;
let locatorHelpers: THREE.Group | null = null;
let animationFrameId = 0;

function initThree() {
    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    canvasContainer.appendChild(renderer.domElement);

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color().setStyle(
        getComputedStyle(document.body).getPropertyValue('--ep-bg').trim() || '#1e1e1e'
    );

    // Camera
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    camera.position.set(5, 3, 8);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 5000;

    // Lighting — balanced PBR setup
    // Total intensity ~1.85 to avoid washing out diffuse textures
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x444455, 0.4);
    hemiLight.position.set(0, 20, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x8899bb, 0.2);
    fillLight.position.set(-3, -2, -5);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0x556688, 0.1);
    rimLight.position.set(0, -5, 3);
    scene.add(rimLight);

    // Grid helper (subtle)
    const grid = new THREE.GridHelper(20, 20, 0x333333, 0x222222);
    grid.material.opacity = 0.3;
    grid.material.transparent = true;
    scene.add(grid);

    handleResize();
    animate();
}

function animate() {
    animationFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function handleResize() {
    const w = canvasContainer.clientWidth;
    const h = canvasContainer.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
}

// ── Texture Loading ──────────────────────────────────────────────────────────

/**
 * DDS header parsing for webview-side texture loading.
 * Decompresses BC1 (DXT1) and BC3 (DXT5) in software to RGBA DataTexture
 * so that channel remapping (PDX RRxG normals, specular) always works.
 */
function loadDDSTexture(buffer: ArrayBuffer): THREE.DataTexture | THREE.CompressedTexture | null {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x20534444) return null; // 'DDS '

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
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
    const gMask = view.getUint32(96, true);
    const bMask = view.getUint32(100, true);
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

// ── BC1/BC3 Software Decompression ──────────────────────────────────────────

/** Expand a 16-bit RGB565 color to [R, G, B] (0-255) */
function rgb565(c: number): [number, number, number] {
    return [
        ((c >> 11) & 0x1f) * 255 / 31 | 0,
        ((c >> 5) & 0x3f) * 255 / 63 | 0,
        (c & 0x1f) * 255 / 31 | 0,
    ];
}

/** Decompress BC1 (DXT1) compressed data → RGBA Uint8Array */
function decompressBC1(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const bw = Math.max(1, (width + 3) >> 2);
    const bh = Math.max(1, (height + 3) >> 2);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockIdx = (by * bw + bx) * 8;
            const c0raw = src[blockIdx]! | (src[blockIdx + 1]! << 8);
            const c1raw = src[blockIdx + 2]! | (src[blockIdx + 3]! << 8);
            const c0 = rgb565(c0raw);
            const c1 = rgb565(c1raw);

            // Build 4-color palette
            const palette: [number, number, number, number][] = [
                [c0[0], c0[1], c0[2], 255],
                [c1[0], c1[1], c1[2], 255],
                [0, 0, 0, 255],
                [0, 0, 0, 255],
            ];

            if (c0raw > c1raw) {
                palette[2] = [(2 * c0[0] + c1[0] + 1) / 3 | 0, (2 * c0[1] + c1[1] + 1) / 3 | 0, (2 * c0[2] + c1[2] + 1) / 3 | 0, 255];
                palette[3] = [(c0[0] + 2 * c1[0] + 1) / 3 | 0, (c0[1] + 2 * c1[1] + 1) / 3 | 0, (c0[2] + 2 * c1[2] + 1) / 3 | 0, 255];
            } else {
                palette[2] = [(c0[0] + c1[0] + 1) / 2 | 0, (c0[1] + c1[1] + 1) / 2 | 0, (c0[2] + c1[2] + 1) / 2 | 0, 255];
                palette[3] = [0, 0, 0, 0]; // transparent
            }

            // 4 bytes of 2-bit indices
            const bits = src[blockIdx + 4]! | (src[blockIdx + 5]! << 8) |
                (src[blockIdx + 6]! << 16) | (src[blockIdx + 7]! << 24);

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const idx = (py * 4 + px) * 2;
                    const ci = (bits >>> idx) & 3;
                    const p = palette[ci]!;
                    const oi = (y * width + x) * 4;
                    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2]; out[oi + 3] = p[3];
                }
            }
        }
    }
    return out;
}

/** Decompress BC3 (DXT5) compressed data → RGBA Uint8Array */
function decompressBC3(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const bw = Math.max(1, (width + 3) >> 2);
    const bh = Math.max(1, (height + 3) >> 2);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockIdx = (by * bw + bx) * 16;

            // -- Alpha block (8 bytes) --
            const a0 = src[blockIdx]!;
            const a1 = src[blockIdx + 1]!;

            // Build 8-value alpha palette
            const alphas = new Uint8Array(8);
            alphas[0] = a0;
            alphas[1] = a1;
            if (a0 > a1) {
                for (let i = 1; i <= 6; i++) {
                    alphas[1 + i] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
                }
            } else {
                for (let i = 1; i <= 4; i++) {
                    alphas[1 + i] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
                }
                alphas[6] = 0;
                alphas[7] = 255;
            }

            // 6 bytes of 3-bit alpha indices (48 bits for 16 pixels)
            // Read as a 48-bit value
            let alphaBits = 0n;
            for (let i = 0; i < 6; i++) {
                alphaBits |= BigInt(src[blockIdx + 2 + i]!) << BigInt(i * 8);
            }

            // -- Color block (8 bytes, same as BC1) --
            const colorOff = blockIdx + 8;
            const c0raw = src[colorOff]! | (src[colorOff + 1]! << 8);
            const c1raw = src[colorOff + 2]! | (src[colorOff + 3]! << 8);
            const c0 = rgb565(c0raw);
            const c1 = rgb565(c1raw);

            const palette: [number, number, number][] = [
                c0,
                c1,
                [(2 * c0[0] + c1[0] + 1) / 3 | 0, (2 * c0[1] + c1[1] + 1) / 3 | 0, (2 * c0[2] + c1[2] + 1) / 3 | 0],
                [(c0[0] + 2 * c1[0] + 1) / 3 | 0, (c0[1] + 2 * c1[1] + 1) / 3 | 0, (c0[2] + 2 * c1[2] + 1) / 3 | 0],
            ];

            const colorBits = src[colorOff + 4]! | (src[colorOff + 5]! << 8) |
                (src[colorOff + 6]! << 16) | (src[colorOff + 7]! << 24);

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;

                    const pixelIdx = py * 4 + px;

                    // Color index (2 bits)
                    const ci = (colorBits >>> (pixelIdx * 2)) & 3;
                    const p = palette[ci]!;

                    // Alpha index (3 bits)
                    const ai = Number((alphaBits >> BigInt(pixelIdx * 3)) & 7n);

                    const oi = (y * width + x) * 4;
                    out[oi] = p[0]; out[oi + 1] = p[1]; out[oi + 2] = p[2];
                    out[oi + 3] = alphas[ai]!;
                }
            }
        }
    }
    return out;
}

async function fetchTexture(uri: string): Promise<THREE.Texture | null> {
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
        if (uri.includes('.dds')) {
            const resp = await fetch(uri);
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

    // Invisible / shadow-only shaders
    if (s.includes('invisible') || s.includes('shadow')) return 'invisible';

    // Additive / alpha blend / flow additive / simple / hologram
    if (s.includes('additive') || s.includes('alphablend') ||
        s.includes('hologram') || s === 'pdxmeshsimple') return 'additive';

    // PBR shaders: PdxMeshStandard, PdxMeshShipFlow, PdxMeshStandardSkinned, etc.
    return 'pbr';
}

// ── PBR Material Creation ────────────────────────────────────────────────────

interface ResolvedTextures {
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
function resolveSubmeshTextures(
    submeshIndex: number,
    submeshName: string,
    meshMaterial: { shader?: string; diffuse?: string; normal?: string; specular?: string },
    entity: EntityData,
): ResolvedTextures {
    // Match by submesh name from binary mesh against GFX meshsettings name, index 0 (base layer)
    const ms = entity.resolvedMeshSettings?.find(s => s.name === submeshName && s.index === 0)
        ?? entity.resolvedMeshSettings?.find(s => s.name === submeshName);
    const textureMap = entity.textureMap ?? {};

    // Helper: resolve a mesh-embedded relative path via textureMap
    const resolve = (relPath?: string): string | undefined => {
        if (!relPath) return undefined;
        // Try exact
        if (textureMap[relPath]) return textureMap[relPath];
        // Normalize separators
        const norm = relPath.replace(/\\/g, '/');
        if (textureMap[norm]) return textureMap[norm];
        // Try bare filename (last component)
        const basename = norm.split('/').pop() ?? '';
        if (basename && textureMap[basename]) return textureMap[basename];
        // Case-insensitive
        const lower = norm.toLowerCase();
        const baseLower = basename.toLowerCase();
        for (const [k, v] of Object.entries(textureMap)) {
            if (k.toLowerCase() === lower || k.toLowerCase() === baseLower) return v;
        }
        return undefined;
    };

    // GFX meshsettings shader takes priority over binary mesh shader
    const shader = ms?.shader || meshMaterial.shader || 'PdxMeshStandard';
    const shaderCategory = classifyShader(shader);

    const hasDiffuse = !!(ms?.diffuse || meshMaterial.diffuse);
    const hasNormal = !!(ms?.normal || meshMaterial.normal);
    const hasSpecular = !!(ms?.specular || meshMaterial.specular);
    const definedCount = [hasDiffuse, hasNormal, hasSpecular].filter(Boolean).length;

    const result: ResolvedTextures = {
        diffuse: ms?.diffuse ?? resolve(meshMaterial.diffuse),
        normal: ms?.normal ?? resolve(meshMaterial.normal),
        specular: ms?.specular ?? resolve(meshMaterial.specular),
        shader,
        shaderCategory,
        definedCount,
    };

    console.log(`[Material] Submesh ${submeshIndex} "${submeshName}" shader="${shader}" cat=${shaderCategory} defined=${definedCount} ms=${ms ? `found(${ms.name})` : 'none'} resolved=(${result.diffuse ? '✓' : '✗'}, ${result.normal ? '✓' : '✗'}, ${result.specular ? '✓' : '✗'})`);

    return result;
}

/**
 * Create a Three.js material for a submesh based on its shader category.
 *
 * PBR shaders (Standard, ShipFlow, etc.):
 *   - ≥2 defined textures → full PBR
 *   - 1 defined texture → transparent (incomplete material)
 *   - 0 defined → default grey
 *
 * Additive / Invisible shaders → always transparent
 */
async function createSubmeshMaterial(
    textures: ResolvedTextures,
): Promise<THREE.MeshStandardMaterial> {
    // Non-PBR shaders → transparent
    if (textures.shaderCategory !== 'pbr') {
        return new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    // PBR shader with only 1 defined texture → transparent (incomplete material)
    if (textures.definedCount === 1) {
        return new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    // PBR shader with 0 or ≥2 defined textures → render
    const mat = new THREE.MeshStandardMaterial({
        color: 0x888888,
        metalness: 0.15,
        roughness: 0.65,
        side: THREE.DoubleSide,
        envMapIntensity: 0.4,
    });

    const hasAnyResolved = textures.diffuse || textures.normal || textures.specular;
    if (hasAnyResolved) {
        const [diffTex, normTex, specTex] = await Promise.all([
            fetchTexture(textures.diffuse ?? ''),
            fetchTexture(textures.normal ?? ''),
            fetchTexture(textures.specular ?? ''),
        ]);

        if (diffTex) {
            diffTex.colorSpace = THREE.SRGBColorSpace;
            mat.map = diffTex;
            mat.color.set(0xffffff);
        }

        if (normTex) {
            // PDX uses RRxG normal map format:
            //   X = G * 2 - 1
            //   Y = -(A * 2 - 1)
            //   Z = sqrt(1 - X² - Y²)
            //   B = emissive (NOT normal Z!)
            // Three.js expects standard tangent-space: R=X, G=Y, B=Z
            const remappedNorm = remapPdxNormalTexture(normTex);
            if (remappedNorm) {
                remappedNorm.colorSpace = THREE.LinearSRGBColorSpace;
                mat.normalMap = remappedNorm;
            } else {
                // Fallback: use original texture even if channels aren't ideal
                normTex.colorSpace = THREE.LinearSRGBColorSpace;
                mat.normalMap = normTex;
            }
        }

        // PDX Specular map channels:
        //   R = Empire color mask (ignore for now)
        //   G = Specular intensity (0-1)
        //   B = Metalness (0-1)
        //   A = Glossiness (0-1) → Roughness = 1 - Glossiness
        //
        // We need to remap these into Three.js expected channels:
        //   roughnessMap reads G channel → we need to put (1-gloss) there
        //   metalnessMap reads B channel → metalness is already in B
        if (specTex) {
            const remapped = remapPdxSpecularTexture(specTex);
            if (remapped) {
                remapped.colorSpace = THREE.LinearSRGBColorSpace;
                mat.roughnessMap = remapped;
                mat.roughness = 1.0;
                mat.metalnessMap = remapped;
                mat.metalness = 1.0;
            }
        }

        mat.needsUpdate = true;
    }

    return mat;
}

/**
 * Remap a PDX RRxG normal map to standard Three.js tangent-space format.
 *
 * PDX format (from UnpackRRxGNormal):
 *   X = G_channel * 2 - 1
 *   Y = -(A_channel * 2 - 1)
 *   Z = sqrt(1 - X² - Y²)
 *   B_channel = emissive (NOT used for normals)
 *
 * Three.js expects: R = X*0.5+0.5, G = Y*0.5+0.5, B = Z*0.5+0.5
 */
function remapPdxNormalTexture(tex: THREE.Texture): THREE.DataTexture | null {
    try {
        const image = tex.image;
        if (!image) return null;

        let width: number, height: number, pixels: Uint8Array;

        if (tex instanceof THREE.DataTexture) {
            width = tex.image.width;
            height = tex.image.height;
            const d = tex.image.data as unknown as Uint8Array;
            pixels = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        } else if (tex instanceof THREE.CompressedTexture) {
            // Can't remap compressed textures
            console.log('[Material] Normal map is compressed, skipping remap');
            return null;
        } else if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) {
            const canvas = document.createElement('canvas');
            width = image.width || (image as HTMLImageElement).naturalWidth;
            height = image.height || (image as HTMLImageElement).naturalHeight;
            if (!width || !height) return null;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            const imgData = ctx.getImageData(0, 0, width, height);
            pixels = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
        } else if (image instanceof ImageData) {
            width = image.width;
            height = image.height;
            const d = image.data as unknown as Uint8Array;
            pixels = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        } else {
            return null;
        }

        const outData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const si = i * 4;
            // PDX channels: R=?, G=normalX, B=emissive, A=normalY
            const gCh = pixels[si + 1]!; // G channel → normal X
            const aCh = pixels[si + 3]!; // A channel → normal Y (inverted)

            // Unpack to [-1, 1]
            const nx = (gCh / 255) * 2 - 1;
            const ny = -((aCh / 255) * 2 - 1); // Y is negated in PDX
            const nzSq = 1 - nx * nx - ny * ny;
            const nz = Math.sqrt(Math.max(0, nzSq));

            // Re-pack to [0, 255] for Three.js standard normal map
            outData[si] = Math.round((nx * 0.5 + 0.5) * 255);     // R = X
            outData[si + 1] = Math.round((ny * 0.5 + 0.5) * 255); // G = Y
            outData[si + 2] = Math.round((nz * 0.5 + 0.5) * 255); // B = Z
            outData[si + 3] = 255;                                  // A
        }

        const outTex = new THREE.DataTexture(outData, width, height, THREE.RGBAFormat);
        outTex.needsUpdate = true;
        return outTex;
    } catch (err) {
        console.warn('[Material] Failed to remap normal texture:', err);
        return null;
    }
}

/**
 * Remap a PDX specular texture into Three.js-compatible channels.
 * Input:  R=empire, G=specular, B=metalness, A=glossiness
 * Output: R=0, G=(1-glossiness)=roughness, B=metalness, A=255
 *
 * Three.js reads roughnessMap.G for roughness and metalnessMap.B for metalness.
 */
function remapPdxSpecularTexture(tex: THREE.Texture): THREE.DataTexture | null {
    try {
        // Get the image data from the texture
        const image = tex.image;
        if (!image) return null;

        let width: number, height: number, pixels: Uint8Array;

        if (image instanceof ImageData) {
            width = image.width;
            height = image.height;
            const d = image.data as unknown as Uint8Array;
            pixels = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        } else if (tex instanceof THREE.DataTexture) {
            width = tex.image.width;
            height = tex.image.height;
            const d = tex.image.data as unknown as Uint8Array;
            pixels = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        } else if (tex instanceof THREE.CompressedTexture) {
            // Can't remap compressed textures — use defaults
            console.log('[Material] Specular is compressed, using defaults');
            return null;
        } else if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) {
            // Draw to canvas to read pixel data
            const canvas = document.createElement('canvas');
            width = image.width || (image as HTMLImageElement).naturalWidth;
            height = image.height || (image as HTMLImageElement).naturalHeight;
            if (!width || !height) return null;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            const imgData = ctx.getImageData(0, 0, width, height);
            pixels = new Uint8Array(imgData.data);
        } else {
            return null;
        }

        // Remap: for each pixel, create new RGBA where:
        // R = 0 (unused)
        // G = 1 - A_original (roughness from glossiness)
        // B = B_original (metalness stays)
        // A = 255
        const outData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const si = i * 4;
            const glossiness = pixels[si + 3]!; // A channel = glossiness
            const metalness = pixels[si + 2]!;  // B channel = metalness

            outData[si] = 0;                           // R (unused)
            outData[si + 1] = 255 - glossiness;        // G = roughness = 1 - glossiness
            outData[si + 2] = metalness;               // B = metalness
            outData[si + 3] = 255;                     // A
        }

        const outTex = new THREE.DataTexture(outData, width, height, THREE.RGBAFormat);
        outTex.needsUpdate = true;
        return outTex;
    } catch (err) {
        console.warn('[Material] Failed to remap specular texture:', err);
        return null;
    }
}

// ── Mesh → Three.js Geometry ─────────────────────────────────────────────────

function buildGeometry(subMesh: ParsedSubMesh): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();

    // Positions (vec3)
    geo.setAttribute('position', new THREE.BufferAttribute(subMesh.positions, 3));

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

    // Index buffer
    geo.setIndex(new THREE.BufferAttribute(subMesh.indices, 1));

    // Compute missing normals if needed
    if (!subMesh.normals || subMesh.normals.length === 0) {
        geo.computeVertexNormals();
    }

    return geo;
}

// ── Model Loading ────────────────────────────────────────────────────────────

let totalTriangles = 0;
let totalVertices = 0;

async function loadModel(entity: EntityData, meshBuffer: ArrayBuffer | undefined) {
    // Clear previous model
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                if (obj.material instanceof THREE.Material) obj.material.dispose();
            }
        });
        currentModel = null;
    }
    if (locatorHelpers) {
        scene.remove(locatorHelpers);
        locatorHelpers = null;
    }

    totalTriangles = 0;
    totalVertices = 0;

    if (!meshBuffer) {
        showError('No mesh data available');
        return;
    }

    showLoading(true, 'Parsing mesh...');

    try {
        // Parse mesh (synchronous for now; use Worker for files >10MB)
        const parsed: ParsedMeshFile = parsePdxMesh(meshBuffer, (pct) => {
            setProgress(pct, `Parsing mesh... ${pct}%`);
        });

        showLoading(true, 'Building geometry...');

        const modelGroup = new THREE.Group();
        modelGroup.name = entity.name;

        // Apply entity scale
        const scale = entity.scale ?? 1.0;
        modelGroup.scale.setScalar(scale);

        // Maya Z+ forward → Three.js Z- forward: rotate 180° around Y
        modelGroup.rotation.y = Math.PI;

        // Build geometry and per-submesh materials
        let submeshIndex = 0;
        for (const shape of parsed.shapes) {
            for (const subMesh of shape.meshes) {
                const geo = buildGeometry(subMesh);

                // Resolve textures for this submesh:
                // GFX/entity meshsettings (by name) → mesh binary material → textureMap
                const meshMat = subMesh.material;
                const textures = resolveSubmeshTextures(submeshIndex, subMesh.name, {
                    shader: meshMat.shader,
                    diffuse: meshMat.diffuse,
                    normal: meshMat.normal,
                    specular: meshMat.specular,
                }, entity);

                console.log(`[PDX Mesh] Submesh ${submeshIndex} [${textures.shader}/${textures.shaderCategory}]: diffuse=${textures.diffuse ? '✓' : '✗'}, normal=${textures.normal ? '✓' : '✗'}, specular=${textures.specular ? '✓' : '✗'}`);

                const material = await createSubmeshMaterial(textures);
                const mesh = new THREE.Mesh(geo, material);
                mesh.name = `submesh_${submeshIndex}`;

                totalTriangles += (subMesh.indices.length / 3);
                totalVertices += (subMesh.positions.length / 3);

                modelGroup.add(mesh);
                submeshIndex++;
            }
        }

        // Add locator visualization
        locatorHelpers = new THREE.Group();
        locatorHelpers.name = 'locators';
        locatorHelpers.visible = locatorToggle.checked;

        for (const loc of parsed.locators) {
            const helper = new THREE.AxesHelper(0.5);
            helper.position.set(loc.position[0], loc.position[1], loc.position[2]);
            const q = new THREE.Quaternion(loc.rotation[0], loc.rotation[1], loc.rotation[2], loc.rotation[3]);
            helper.setRotationFromQuaternion(q);
            helper.name = loc.name;
            locatorHelpers.add(helper);
        }

        // Also add script-defined locators
        if (entity.locators) {
            for (const loc of entity.locators) {
                // Check if this overrides a mesh locator
                const existing = locatorHelpers.getObjectByName(loc.name);
                if (existing && loc.position) {
                    existing.position.set(loc.position[0], loc.position[1], loc.position[2]);
                    if (loc.rotation) {
                        const euler = new THREE.Euler(
                            loc.rotation[0] * Math.PI / 180,
                            loc.rotation[1] * Math.PI / 180,
                            loc.rotation[2] * Math.PI / 180,
                            'XYZ', // Maya default rotation order
                        );
                        existing.setRotationFromEuler(euler);
                    }
                } else if (loc.position) {
                    // New script-only locator
                    const helper = new THREE.AxesHelper(0.4);
                    helper.position.set(loc.position[0], loc.position[1], loc.position[2]);
                    if (loc.rotation) {
                        const euler = new THREE.Euler(
                            loc.rotation[0] * Math.PI / 180,
                            loc.rotation[1] * Math.PI / 180,
                            loc.rotation[2] * Math.PI / 180,
                            'XYZ',
                        );
                        helper.setRotationFromEuler(euler);
                    }
                    helper.name = loc.name;
                    locatorHelpers.add(helper);
                }
            }
        }

        modelGroup.add(locatorHelpers);
        scene.add(modelGroup);
        currentModel = modelGroup;

        // Fit camera to model
        fitCameraToModel(modelGroup);

        // Update UI
        updateInfoPanel(entity, parsed);
        updateEntityTree(entity);
        showLoading(false);
        emptyState.style.display = 'none';

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`Failed to load mesh: ${msg}`);
        showLoading(false);
    }
}

function fitCameraToModel(model: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2.0;

    camera.position.copy(center);
    camera.position.x += dist * 0.5;
    camera.position.y += dist * 0.3;
    camera.position.z += dist * 0.8;

    controls.target.copy(center);
    controls.update();
}

// ── UI Updates ───────────────────────────────────────────────────────────────

function showLoading(visible: boolean, text?: string) {
    loadingOverlay.classList.toggle('hidden', !visible);
    if (text) progressText.textContent = text;
}

function setProgress(percent: number, text?: string) {
    progressBarFill.style.width = `${percent}%`;
    if (text) progressText.textContent = text;
}

function showError(msg: string) {
    errorBanner.textContent = `⚠ ${msg}`;
    errorBanner.classList.add('visible');
    setTimeout(() => errorBanner.classList.remove('visible'), 8000);
}

function updateInfoPanel(entity: EntityData, parsed: ParsedMeshFile) {
    const locCount = parsed.locators.length + (entity.locators?.length ?? 0);
    infoPanel.innerHTML = `
        <div class="info-group"><span class="info-label">Mesh:</span><span class="info-value">${entity.pdxmesh ?? '-'}</span></div>
        <div class="info-group"><span class="info-label">Triangles:</span><span class="info-value">${totalTriangles.toLocaleString()}</span></div>
        <div class="info-group"><span class="info-label">Vertices:</span><span class="info-value">${totalVertices.toLocaleString()}</span></div>
        <div class="info-group"><span class="info-label">Shapes:</span><span class="info-badge">${parsed.shapes.length}</span></div>
        <div class="info-group"><span class="info-label">Locators:</span><span class="info-badge">${locCount}</span></div>
        ${entity.scale ? `<div class="info-group"><span class="info-label">Scale:</span><span class="info-value">${entity.scale}</span></div>` : ''}
    `;
}

function updateEntityTree(entity: EntityData) {
    let html = '<div class="tree-title">Entity Tree</div>';
    html += `<div class="tree-item selected"><span class="tree-icon">📦</span><span class="tree-label">${entity.name}</span><span class="tree-sublabel">${entity.pdxmesh ?? ''}</span></div>`;

    if (entity.attaches) {
        for (const attach of entity.attaches) {
            html += `<div class="tree-item" style="padding-left:36px"><span class="tree-icon">🔗</span><span class="tree-label">${attach.locatorName}</span><span class="tree-sublabel">→ ${attach.entityName}</span></div>`;
        }
    }

    entityTree.innerHTML = html;
}

// ── Toolbar Event Handlers ───────────────────────────────────────────────────

wireframeToggle.addEventListener('change', () => {
    if (!currentModel) return;
    currentModel.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
            obj.material.wireframe = wireframeToggle.checked;
        }
    });
});

locatorToggle.addEventListener('change', () => {
    if (locatorHelpers) locatorHelpers.visible = locatorToggle.checked;
});

// Store original normal maps so they can be restored
const savedNormalMaps = new WeakMap<THREE.MeshStandardMaterial, THREE.Texture | null>();

normalToggle.addEventListener('change', () => {
    if (!currentModel) return;
    currentModel.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
            const mat = obj.material;
            if (normalToggle.checked) {
                // Save and remove normal map
                if (!savedNormalMaps.has(mat)) {
                    savedNormalMaps.set(mat, mat.normalMap);
                }
                mat.normalMap = null;
                mat.needsUpdate = true;
            } else {
                // Restore saved normal map
                const saved = savedNormalMaps.get(mat);
                if (saved !== undefined) {
                    mat.normalMap = saved;
                    mat.needsUpdate = true;
                }
            }
        }
    });
});


// Focus button — reframe camera to fit model (like Maya's F key)
const focusBtn = document.getElementById('btn-focus');
focusBtn?.addEventListener('click', () => {
    if (currentModel) fitCameraToModel(currentModel);
});

// F key shortcut for focus
window.addEventListener('keydown', (e) => {
    // Don't intercept if user is typing in an input
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (currentModel) fitCameraToModel(currentModel);
    }
});

// ── Window Events ────────────────────────────────────────────────────────────

window.addEventListener('resize', handleResize);
new ResizeObserver(handleResize).observe(canvasContainer);

// ── Cleanup ──────────────────────────────────────────────────────────────────

let isDisposed = false;

function disposeAll() {
    if (isDisposed) return;
    isDisposed = true;

    // Stop render loop
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = 0;
    }

    // Dispose model
    if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                const mat = obj.material;
                if (mat instanceof THREE.MeshStandardMaterial) {
                    mat.map?.dispose();
                    mat.normalMap?.dispose();
                    mat.roughnessMap?.dispose();
                    mat.metalnessMap?.dispose();
                    mat.dispose();
                } else if (mat instanceof THREE.Material) {
                    mat.dispose();
                }
            }
        });
        currentModel = null;
    }

    if (locatorHelpers) {
        scene.remove(locatorHelpers);
        locatorHelpers = null;
    }

    // Dispose renderer
    if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
        const canvas = renderer.domElement;
        canvas.parentElement?.removeChild(canvas);
    }

    // Dispose controls
    if (controls) {
        controls.dispose();
    }
}

// ── Entity Selector ──────────────────────────────────────────────────────────

const entitySelect = document.getElementById('sel-entity') as HTMLSelectElement;

entitySelect.addEventListener('change', () => {
    const idx = parseInt(entitySelect.value, 10);
    if (!isNaN(idx)) {
        vscode.postMessage({ command: 'selectEntity', index: idx });
    }
});

function updateEntitySelector(entities: Array<{ name: string; index: number }>, selectedIndex: number) {
    entitySelect.innerHTML = '';
    for (const e of entities) {
        const opt = document.createElement('option');
        opt.value = String(e.index);
        opt.textContent = e.name || `entity_${e.index}`;
        entitySelect.appendChild(opt);
    }
    entitySelect.value = String(selectedIndex);
    // Show/hide selector based on entity count
    entitySelect.style.display = entities.length > 1 ? 'inline-block' : 'none';
}

// ── Message Handler ──────────────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg?.command) return;

    switch (msg.command) {
        case 'entityList': {
            updateEntitySelector(msg.entities ?? [], msg.selectedIndex ?? 0);
            break;
        }
        case 'render': {
            const data = msg as RenderMessage;
            entityNameEl.textContent = data.entity.name || data.fileName;
            emptyState.style.display = 'none';
            document.title = `Entity: ${data.entity.name || data.fileName}`;
            // Decode base64 mesh data to ArrayBuffer
            let meshBuffer: ArrayBuffer | undefined;
            if (data.meshBase64) {
                const binary = atob(data.meshBase64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                meshBuffer = bytes.buffer;
            }
            await loadModel(data.entity, meshBuffer);
            break;
        }
        case 'dispose': {
            disposeAll();
            break;
        }
    }
});

// ── Initialize ───────────────────────────────────────────────────────────────

initThree();

