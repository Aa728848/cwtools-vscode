/**
 * Shared types for the Stellaris worldgfx environment system.
 * Used by both the extension host (worldgfxPresets.ts) and the webview
 * panels (skyboxEnvironment.ts). Pure types + pure math — no Node or DOM APIs.
 */

/** One selectable skybox background from a gfx_settings block. */
export interface EnvironmentBackground {
    /** Original texture path from the config, e.g. "gfx/map/sky_rim.dds" */
    texturePath: string;
    /** Webview URI (undefined when the file could not be resolved) */
    textureUri?: string;
    /** Texture pixels are YCoCg-encoded (Y in alpha, Co in R, Cg in G) */
    ycocg: boolean;
    /** Short label derived from the file name, e.g. "core" / "mid" / "rim" / "stars" */
    label: string;
    /** Raw trigger text, e.g. "distance_to_core_percent < 0.50" */
    trigger?: string;
}

export interface EnvironmentPreset {
    /** world = <id> from the gfx_settings block, e.g. "default", "m_star", "ship_designer" */
    id: string;
    /** Source file name, e.g. "star_m_class.txt" */
    fileName: string;
    backgrounds: EnvironmentBackground[];
    /** galaxy_background_hsv_shift */
    backgroundHsvShift?: [number, number, number];
    /** galaxy_background_lut — applied on CPU to the skybox only */
    backgroundLutUri?: string;
    /** color_lut — fullscreen color grading, applied as a post pass */
    colorLutUri?: string;
    /** environment_map — prefiltered cubemap used for PBR reflections */
    environmentMapUri?: string;
    cubemapIntensity?: number;
    /** ambient (HSV) */
    ambientHsv?: [number, number, number];
    camLight1Hsv?: [number, number, number];
    camLight2Hsv?: [number, number, number];
    camLight3Hsv?: [number, number, number];
    rimLightHsv?: [number, number, number];
    systemBackLightHsv?: [number, number, number];
    tonemapMiddleGrey?: number;
    tonemapWhiteLuminance?: number;
}

/** Message posted from extension to webview with all available presets. */
export interface EnvironmentsMessage {
    command: 'environments';
    presets: EnvironmentPreset[];
    /** Webview URI of the skyboxEnvWorker.js bundle */
    workerUri?: string;
}

// ── Color math (pure, no dependencies) ───────────────────────────────────────

/** HSV (h,s,v each 0..1, h wraps) → RGB 0..1 */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

/** RGB 0..1 → [h, s, v] each 0..1 */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
        if (h < 0) h += 1;
    }
    const s = max === 0 ? 0 : d / max;
    return [h, s, max];
}

/**
 * Apply the game's galaxy_background_hsv_shift to an RGB pixel (0..1).
 * Hue wraps, saturation/value clamp.
 */
export function applyHsvShift(
    r: number, g: number, b: number,
    dh: number, ds: number, dv: number,
): [number, number, number] {
    if (dh === 0 && ds === 0 && dv === 0) return [r, g, b];
    const [h, s, v] = rgbToHsv(r, g, b);
    const nh = ((h + dh) % 1 + 1) % 1;
    const ns = Math.min(1, Math.max(0, s + ds));
    const nv = Math.min(1, Math.max(0, v + dv));
    return hsvToRgb(nh, ns, nv);
}

/**
 * PDX YCoCg-DXT5 decode: Y is stored in the alpha channel, Co in red,
 * Cg in green (each chroma centered at 0.5). Inputs/outputs 0..1.
 */
export function ycocgToRgb(y: number, co: number, cg: number): [number, number, number] {
    const cO = co - 0.5;
    const cG = cg - 0.5;
    const r = y + cO - cG;
    const g = y + cG;
    const b = y - cO - cG;
    return [
        Math.min(1, Math.max(0, r)),
        Math.min(1, Math.max(0, g)),
        Math.min(1, Math.max(0, b)),
    ];
}

/**
 * Sample a PDX 1024x32 color-correction LUT (32 tiles of 32x32, tile index =
 * blue slice) with trilinear interpolation. lutPixels = RGBA bytes of the
 * 1024x32 image. Input/output RGB in 0..1.
 */
export function sampleColorLut(
    lutPixels: Uint8Array, r: number, g: number, b: number,
): [number, number, number] {
    const x = Math.min(31, Math.max(0, r * 31));
    const y = Math.min(31, Math.max(0, g * 31));
    const z = Math.min(31, Math.max(0, b * 31));
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const x1 = Math.min(31, x0 + 1), y1 = Math.min(31, y0 + 1), z1 = Math.min(31, z0 + 1);
    const fx = x - x0, fy = y - y0, fz = z - z0;

    const fetch = (xi: number, yi: number, zi: number, c: number): number => {
        // tile zi occupies columns [zi*32, zi*32+32) of the 1024x32 strip
        const px = zi * 32 + xi;
        const idx = (yi * 1024 + px) * 4 + c;
        return lutPixels[idx]! / 255;
    };

    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const c00 = fetch(x0, y0, z0, c) + (fetch(x1, y0, z0, c) - fetch(x0, y0, z0, c)) * fx;
        const c10 = fetch(x0, y1, z0, c) + (fetch(x1, y1, z0, c) - fetch(x0, y1, z0, c)) * fx;
        const c01 = fetch(x0, y0, z1, c) + (fetch(x1, y0, z1, c) - fetch(x0, y0, z1, c)) * fx;
        const c11 = fetch(x0, y1, z1, c) + (fetch(x1, y1, z1, c) - fetch(x0, y1, z1, c)) * fx;
        const c0 = c00 + (c10 - c00) * fy;
        const c1 = c01 + (c11 - c01) * fy;
        out[c] = c0 + (c1 - c0) * fz;
    }
    return out;
}
