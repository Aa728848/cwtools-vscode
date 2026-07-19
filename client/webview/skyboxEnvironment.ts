/**
 * SkyboxEnvironment — shared Stellaris worldgfx environment controller.
 *
 * Attaches to a panel's Three.js scene and applies a worldgfx preset:
 *   - skybox background cubemap (BC3 DDS, YCoCg, HSV shift, background LUT)
 *   - PMREM environment reflections (environment_map + cubemap_intensity)
 *   - camera-attached light rig (cam_light_1/2/3 + ambient + rim + back light)
 *   - fullscreen 3D-LUT color grading pass (color_lut, optional toggle)
 *
 * Heavy DDS decode runs in a Blob worker (skyboxEnvWorker.js); results are
 * cached in small bounded LRU maps. All GPU resources are disposed on switch.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { hsvToRgb, type EnvironmentPreset } from './environmentTypes';

export interface SkyboxEnvironmentHooks {
    /** Panel hides its built-in fallback lights (preset lighting takes over) */
    hideDefaults(): void;
    /** Panel restores its built-in fallback lights + solid background color */
    restoreDefaults(): void;
    onLog?: (text: string, level: 'info' | 'warn' | 'error') => void;
}

interface WorkerDecodeResult {
    kind: 'result';
    id: number;
    faces: ArrayBuffer[];
    size: number;
    error?: string;
}

const SKYBOX_CACHE_MAX = 2;
const ENVMAP_CACHE_MAX = 2;
const LUT_CACHE_MAX = 4;
/** Brightness scale for the camera light rig (PDX light value → three intensity multiplier) */
const CAM_LIGHT_SCALE = 2.2;
const RIM_LIGHT_SCALE = 1.6;
const AMBIENT_LIGHT_SCALE = 1.0;
const BACK_LIGHT_SCALE = 0.5;

/** Parse an uncompressed 24/32-bit TGA into RGBA pixels with TOP-LEFT origin. */
function parseTgaRgba(buffer: ArrayBuffer): { pixels: Uint8Array; width: number; height: number } {
    const view = new DataView(buffer);
    const idLen = view.getUint8(0);
    const imageType = view.getUint8(2);
    const width = view.getUint16(12, true);
    const height = view.getUint16(14, true);
    const bpp = view.getUint8(16);
    const descriptor = view.getUint8(17);
    if (imageType !== 2) throw new Error(`Unsupported TGA image type ${imageType} (need uncompressed true-color)`);
    if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported TGA bpp ${bpp}`);
    if (width < 1 || height < 1 || width * height > 64 * 1024 * 1024) throw new Error(`Bad TGA size ${width}x${height}`);
    const bytesPerPixel = bpp / 8;
    const src = new Uint8Array(buffer, 18 + idLen, width * height * bytesPerPixel);
    const pixels = new Uint8Array(width * height * 4);
    const topOrigin = (descriptor & 0x20) !== 0;
    for (let y = 0; y < height; y++) {
        const srcRow = topOrigin ? y : height - 1 - y;
        for (let x = 0; x < width; x++) {
            const si = (srcRow * width + x) * bytesPerPixel;
            const di = (y * width + x) * 4;
            pixels[di] = src[si + 2]!;     // R ← B
            pixels[di + 1] = src[si + 1]!; // G
            pixels[di + 2] = src[si]!;     // B ← R
            pixels[di + 3] = bpp === 32 ? src[si + 3]! : 255;
        }
    }
    return { pixels, width, height };
}

/** Build a 32x32x32 Data3DTexture from a 1024x32 PDX LUT strip (RGBA, top-left origin). */
function buildLut3DTexture(strip: Uint8Array): THREE.Data3DTexture {
    const data = new Uint8Array(32 * 32 * 32 * 4);
    for (let b = 0; b < 32; b++) {
        for (let g = 0; g < 32; g++) {
            for (let r = 0; r < 32; r++) {
                const si = (g * 1024 + b * 32 + r) * 4;
                const di = ((b * 32 * 32 + g * 32 + r) * 4);
                data[di] = strip[si]!;
                data[di + 1] = strip[si + 1]!;
                data[di + 2] = strip[si + 2]!;
                data[di + 3] = 255;
            }
        }
    }
    const tex = new THREE.Data3DTexture(data, 32, 32, 32);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
}

const LutGradeShader = {
    uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        lutMap: { value: null as THREE.Data3DTexture | null },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler3D lutMap;
        varying vec2 vUv;
        void main() {
            vec4 color = texture2D(tDiffuse, vUv);
            vec3 coord = clamp(color.rgb, 0.0, 1.0) * (31.0 / 32.0) + (0.5 / 32.0);
            gl_FragColor = vec4(texture(lutMap, coord).rgb, color.a);
        }`,
};

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number, dispose: (v: V) => void): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > max) {
        const oldest = cache.keys().next().value as K;
        const evicted = cache.get(oldest);
        if (evicted !== undefined) dispose(evicted);
        cache.delete(oldest);
    }
}

export class SkyboxEnvironment {
    private presets: EnvironmentPreset[] = [];
    private workerUri: string | undefined;
    private worker: Worker | null = null;
    private workerPromise: Promise<Worker> | null = null;
    private workerBlobUrl: string | null = null;
    private requestId = 0;
    private readonly pending = new Map<number, { resolve: (r: WorkerDecodeResult) => void; reject: (e: Error) => void }>();

    private applyToken = 0;
    private current: { preset: EnvironmentPreset; backgroundIndex: number } | null = null;
    private presetLights: THREE.Object3D[] = [];
    private backgroundTexture: THREE.CubeTexture | null = null;
    private environmentRT: THREE.WebGLRenderTarget | null = null;
    private environmentTexture: THREE.CubeTexture | null = null;
    private pmrem: THREE.PMREMGenerator | null = null;

    private readonly skyboxCache = new Map<string, THREE.CubeTexture>();
    private readonly envmapCache = new Map<string, THREE.CubeTexture>();
    private readonly lutStripCache = new Map<string, Uint8Array>();
    private readonly lut3DCache = new Map<string, THREE.Data3DTexture>();

    private lutEnabled = true;
    private lutPass: ShaderPass | null = null;
    private ownComposer: EffectComposer | null = null;
    private insertedIntoExternal = false;

    /** envMapIntensity applied to PBR materials; panels read this when creating materials */
    public envMapIntensity = 0.4;

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.PerspectiveCamera,
        private readonly hooks: SkyboxEnvironmentHooks,
        private readonly externalComposer?: EffectComposer,
    ) {
        if (!this.camera.parent) this.scene.add(this.camera);
    }

    setPresets(presets: EnvironmentPreset[], workerUri?: string): void {
        this.presets = presets;
        this.workerUri = workerUri;
    }

    get hasPresets(): boolean {
        return this.presets.length > 0;
    }

    get currentPreset(): EnvironmentPreset | null {
        return this.current?.preset ?? null;
    }

    get colorLutActive(): boolean {
        return !!this.lutPass;
    }

    setLutEnabled(enabled: boolean): void {
        this.lutEnabled = enabled;
        const cur = this.current;
        if (cur) {
            void this.applyPreset(cur.preset.id, cur.backgroundIndex);
        }
    }

    /** Apply a preset (null = back to panel defaults). Safe against rapid switching. */
    async applyPreset(presetId: string | null, backgroundIndex = -1): Promise<void> {
        const token = ++this.applyToken;
        this.clearEnvironment();

        if (!presetId) {
            this.current = null;
            this.hooks.restoreDefaults();
            return;
        }
        const preset = this.presets.find(p => p.id === presetId);
        if (!preset) {
            this.current = null;
            this.hooks.restoreDefaults();
            return;
        }

        this.hooks.hideDefaults();
        this.installLights(preset);
        // Presets without any camera light definition (e.g. `default`) would leave
        // the model unlit — keep the panel's fallback lights in that case.
        if (this.presetLights.length === 0) {
            this.hooks.restoreDefaults();
        }
        this.current = { preset, backgroundIndex };

        const usableBgs = preset.backgrounds.filter(b => b.textureUri);
        // Auto-pick the game's catch-all background (trigger `always = yes` — the
        // galactic-rim texture the ship designer uses); fall back to the last entry.
        const alwaysIdx = usableBgs.findIndex(b => b.trigger?.startsWith('always'));
        const autoIndex = alwaysIdx >= 0 ? alwaysIdx : usableBgs.length - 1;
        const chosenIndex = backgroundIndex >= 0 ? backgroundIndex : autoIndex;
        const bg = usableBgs[chosenIndex] ?? usableBgs[autoIndex];
        if (bg?.textureUri) {
            try {
                const lutPixels = preset.backgroundLutUri
                    ? await this.fetchLutStrip(preset.backgroundLutUri)
                    : undefined;
                const cacheKey = `${bg.texturePath}|${preset.backgroundHsvShift?.join(',') ?? ''}|${preset.backgroundLutUri ?? ''}`;
                let cube = this.skyboxCache.get(cacheKey);
                if (!cube) {
                    const resp = await fetch(bg.textureUri);
                    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
                    const buffer = await resp.arrayBuffer();
                    // Copy the cached LUT strip — postMessage transfer would detach the cache
                    const lutCopy = lutPixels ? lutPixels.slice() : undefined;
                    const decoded = await this.decodeInWorker({
                        kind: 'skybox',
                        id: 0,
                        buffer,
                        ycocg: bg.ycocg,
                        hsvShift: preset.backgroundHsvShift,
                        lutPixels: lutCopy,
                    }, [buffer, ...(lutCopy ? [lutCopy.buffer as ArrayBuffer] : [])]);
                    cube = this.cubeTextureFromFaces(decoded, THREE.SRGBColorSpace);
                    lruSet(this.skyboxCache, cacheKey, cube, SKYBOX_CACHE_MAX, t => t.dispose());
                }
                if (token !== this.applyToken) return;
                this.scene.background = cube;
                this.backgroundTexture = cube;
            } catch (error) {
                this.log(`Skybox background failed: ${error instanceof Error ? error.message : error}`, 'warn');
            }
        }

        if (preset.environmentMapUri) {
            try {
                let cube = this.envmapCache.get(preset.environmentMapUri);
                if (!cube) {
                    const resp = await fetch(preset.environmentMapUri);
                    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
                    const buffer = await resp.arrayBuffer();
                    const decoded = await this.decodeInWorker({ kind: 'envmap', id: 0, buffer }, [buffer]);
                    cube = this.cubeTextureFromFaces(decoded, THREE.SRGBColorSpace);
                    lruSet(this.envmapCache, preset.environmentMapUri, cube, ENVMAP_CACHE_MAX, t => t.dispose());
                }
                if (token !== this.applyToken) return;
                if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
                const rt = this.pmrem.fromCubemap(cube);
                this.environmentRT?.dispose();
                this.environmentRT = rt;
                this.environmentTexture = cube;
                this.scene.environment = rt.texture;
                this.envMapIntensity = preset.cubemapIntensity ?? 0.4;
                this.applyEnvMapIntensity();
            } catch (error) {
                this.log(`Environment map failed: ${error instanceof Error ? error.message : error}`, 'warn');
            }
        }

        if (this.lutEnabled && preset.colorLutUri) {
            try {
                await this.enableLutPass(preset.colorLutUri);
            } catch (error) {
                this.log(`Color LUT failed: ${error instanceof Error ? error.message : error}`, 'warn');
            }
        }
    }

    /** Renders via the internal composer when LUT grading is active. Returns true if handled. */
    renderFrame(deltaTime?: number): boolean {
        if (this.ownComposer) {
            this.ownComposer.render(deltaTime);
            return true;
        }
        return false;
    }

    setSize(width: number, height: number): void {
        this.ownComposer?.setSize(width, height);
    }

    private log(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        this.hooks.onLog?.(text, level);
    }

    // ── Lighting rig ─────────────────────────────────────────────────────────

    private installLights(preset: EnvironmentPreset): void {
        const mkCamLight = (
            hsv: [number, number, number] | undefined,
            localPos: THREE.Vector3,
            scale: number,
        ): void => {
            if (!hsv) return;
            const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
            const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
            const light = new THREE.DirectionalLight(color, CAM_LIGHT_SCALE * scale);
            light.position.copy(localPos);
            light.target.position.set(0, 0, 0);
            this.camera.add(light);
            this.camera.add(light.target);
            this.presetLights.push(light, light.target);
        };
        // PDX: key from left-up, fill/rim from lower right, top light sweeping over
        mkCamLight(preset.camLight1Hsv, new THREE.Vector3(-2.2, 1.6, 1.2), 1.0);
        mkCamLight(preset.camLight2Hsv, new THREE.Vector3(2.0, -0.9, 0.8), 1.0);
        mkCamLight(preset.camLight3Hsv, new THREE.Vector3(0.3, 2.4, -0.8), 1.0);

        if (preset.rimLightHsv) {
            const [r, g, b] = hsvToRgb(...preset.rimLightHsv);
            const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
            const rim = new THREE.DirectionalLight(color, RIM_LIGHT_SCALE);
            rim.position.set(0.4, 0.6, -2.2); // behind the subject relative to view
            rim.target.position.set(0, 0, 0);
            this.camera.add(rim);
            this.camera.add(rim.target);
            this.presetLights.push(rim, rim.target);
        }

        if (preset.ambientHsv) {
            const [r, g, b] = hsvToRgb(...preset.ambientHsv);
            const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
            const ambient = new THREE.AmbientLight(color, AMBIENT_LIGHT_SCALE);
            this.scene.add(ambient);
            this.presetLights.push(ambient);
        }

        if (preset.systemBackLightHsv) {
            const [r, g, b] = hsvToRgb(...preset.systemBackLightHsv);
            const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
            const hemi = new THREE.HemisphereLight(color, new THREE.Color(0x000000), BACK_LIGHT_SCALE);
            this.scene.add(hemi);
            this.presetLights.push(hemi);
        }
    }

    private applyEnvMapIntensity(): void {
        const intensity = this.envMapIntensity;
        this.scene.traverse(obj => {
            if (obj instanceof THREE.Mesh) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) {
                    if (m instanceof THREE.MeshStandardMaterial) m.envMapIntensity = intensity;
                }
            }
        });
    }

    // ── LUT color grading ────────────────────────────────────────────────────

    private async fetchLutStrip(uri: string): Promise<Uint8Array> {
        const cached = this.lutStripCache.get(uri);
        if (cached) {
            // refresh LRU position
            this.lutStripCache.delete(uri);
            this.lutStripCache.set(uri, cached);
            return cached;
        }
        const resp = await fetch(uri);
        if (!resp.ok) throw new Error(`fetch ${resp.status}`);
        const { pixels, width, height } = parseTgaRgba(await resp.arrayBuffer());
        if (width !== 1024 || height !== 32) throw new Error(`Unexpected LUT size ${width}x${height}`);
        lruSet(this.lutStripCache, uri, pixels, LUT_CACHE_MAX, () => undefined);
        return pixels;
    }

    private async enableLutPass(lutUri: string): Promise<void> {
        let lutTex = this.lut3DCache.get(lutUri);
        if (!lutTex) {
            const strip = await this.fetchLutStrip(lutUri);
            lutTex = buildLut3DTexture(strip);
            lruSet(this.lut3DCache, lutUri, lutTex, LUT_CACHE_MAX, t => t.dispose());
        }

        const pass = new ShaderPass(LutGradeShader);
        (pass.uniforms['lutMap'] as { value: THREE.Data3DTexture }).value = lutTex;
        this.lutPass = pass;

        if (this.externalComposer) {
            this.externalComposer.addPass(pass);
            this.insertedIntoExternal = true;
        } else {
            const composer = new EffectComposer(this.renderer);
            composer.addPass(new RenderPass(this.scene, this.camera));
            composer.addPass(new OutputPass());
            composer.addPass(pass);
            this.ownComposer = composer;
            const size = this.renderer.getSize(new THREE.Vector2());
            composer.setSize(size.x, size.y);
        }
    }

    private removeLutPass(): void {
        if (this.lutPass) {
            if (this.externalComposer && this.insertedIntoExternal) {
                const idx = this.externalComposer.passes.indexOf(this.lutPass);
                if (idx >= 0) this.externalComposer.passes.splice(idx, 1);
                this.insertedIntoExternal = false;
            }
            this.lutPass.dispose();
            this.lutPass = null;
        }
        this.ownComposer?.dispose();
        this.ownComposer = null;
    }

    // ── Worker management ────────────────────────────────────────────────────

    private async ensureWorker(): Promise<Worker> {
        if (this.worker) return this.worker;
        if (!this.workerUri) throw new Error('No environment worker URI');
        if (!this.workerPromise) {
            this.workerPromise = (async () => {
                const resp = await fetch(this.workerUri!);
                if (!resp.ok) throw new Error(`worker fetch ${resp.status}`);
                const code = await resp.text();
                this.workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
                const w = new Worker(this.workerBlobUrl);
                w.onmessage = (ev: MessageEvent<WorkerDecodeResult>) => {
                    const msg = ev.data;
                    const p = this.pending.get(msg.id);
                    if (!p) return;
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(msg.error));
                    else p.resolve(msg);
                };
                w.onerror = (ev) => {
                    for (const p of this.pending.values()) p.reject(new Error(ev.message ?? 'worker error'));
                    this.pending.clear();
                };
                this.worker = w;
                return w;
            })();
        }
        return this.workerPromise;
    }

    private async decodeInWorker(
        req: { kind: 'skybox'; id: number; buffer: ArrayBuffer; ycocg: boolean; hsvShift?: [number, number, number]; lutPixels?: Uint8Array }
            | { kind: 'envmap'; id: number; buffer: ArrayBuffer },
        transfer: Transferable[],
    ): Promise<WorkerDecodeResult> {
        const w = await this.ensureWorker();
        const id = ++this.requestId;
        req.id = id;
        return new Promise<WorkerDecodeResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            w.postMessage(req, transfer);
        });
    }

    private cubeTextureFromFaces(result: WorkerDecodeResult, colorSpace: THREE.ColorSpace): THREE.CubeTexture {
        const images: THREE.DataTexture[] = [];
        for (let i = 0; i < 6; i++) {
            const buf = result.faces[i % result.faces.length]!;
            // Cube upload in three r184 requires per-face DataTexture (isDataTexture)
            const face = new THREE.DataTexture(new Uint8Array(buf), result.size, result.size, THREE.RGBAFormat);
            face.needsUpdate = true;
            images.push(face);
        }
        const tex = new THREE.CubeTexture(images);
        tex.format = THREE.RGBAFormat;
        tex.type = THREE.UnsignedByteType;
        tex.colorSpace = colorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        return tex;
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    private clearEnvironment(): void {
        for (const obj of this.presetLights) {
            obj.removeFromParent();
            if (obj instanceof THREE.Light) obj.dispose();
        }
        this.presetLights = [];
        // background/environment are not cached here — caches own them
        this.backgroundTexture = null;
        this.scene.background = null;
        this.environmentTexture = null;
        this.environmentRT?.dispose();
        this.environmentRT = null;
        this.scene.environment = null;
        this.removeLutPass();
    }

    dispose(): void {
        this.applyToken++;
        this.clearEnvironment();
        for (const t of this.skyboxCache.values()) t.dispose();
        this.skyboxCache.clear();
        for (const t of this.envmapCache.values()) t.dispose();
        this.envmapCache.clear();
        for (const t of this.lut3DCache.values()) t.dispose();
        this.lut3DCache.clear();
        this.lutStripCache.clear();
        this.pmrem?.dispose();
        this.pmrem = null;
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.workerBlobUrl) {
            URL.revokeObjectURL(this.workerBlobUrl);
            this.workerBlobUrl = null;
        }
        this.workerPromise = null;
        this.pending.clear();
    }
}
