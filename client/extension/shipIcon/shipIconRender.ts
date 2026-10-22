/**
 * Ship icon frame rendering: orthographic top-down projection, supersampled scanline
 * silhouette, and the vanilla-style composition of a framed panel (transparent margin,
 * accent border ring, interior gradient), a near-black hull silhouette and a same-hue glow.
 *
 * The palettes are per-pixel samples of the vanilla sheets
 * (gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds and its _damaged
 * counterpart), measured per pixel on the 80x40 cell of frame 6:
 *
 *   x=0 and x=width-1          fully transparent 1px margin (alpha 0)
 *   x=1, x=78, y=0, y=39       the 1px accent border ring
 *   x=2..77, y=1..38           the interior gradient, bright at the top and dark at
 *                              the bottom: (40,58,53) -> (17,27,24) intact,
 *                              (60,16,16) -> (27,7,7) damaged
 *
 * The border is the bright colour that an earlier reading mistook for the bottom of the
 * gradient; the gradient itself never reaches it. The vertical axis carries no transparent
 * row of its own, because in the vanilla sheet the outermost rows are border rather than
 * margin, so the margin is horizontal only. The glow reuses the border colour.
 * A damaged frame therefore differs from an intact one only by its palette: no geometry is
 * cut away.
 *
 * All arithmetic is integer or IEEE double so that identical input yields identical bytes
 * on every platform; nothing here depends on Math.random, Date or libm extensions.
 */

import type { ShipIconMesh } from './meshGeometry';

/** Channel triples, 0..255, in R,G,B order. */
export interface ShipIconPalette {
    /** Interior gradient colour on the first interior row of a cell. */
    panelTop: readonly [number, number, number];
    /** Interior gradient colour on the last interior row of a cell. */
    panelBottom: readonly [number, number, number];
    /** Hull silhouette colour. */
    silhouette: readonly [number, number, number];
    /** The 1px border ring around the interior, and the glow colour. */
    accent: readonly [number, number, number];
}

/** Whether a cell gets the opaque panel gradient or stays transparent outside the hull. */
export type ShipIconBackground = 'transparent' | 'panel';

export interface ShipIconStyle {
    cellWidth: number;
    cellHeight: number;
    supersampling: number;
    padding: number;
    fill: number;
    glow: boolean;
    background: ShipIconBackground;
    normalPalette: ShipIconPalette;
    damagedPalette: ShipIconPalette;
    /** Draw with the damaged palette; the geometry is untouched. */
    damaged: boolean;
}

export interface RgbaImage {
    width: number;
    height: number;
    /** RGBA8, row-major, top to bottom, length = width * height * 4. */
    pixels: Uint8Array;
}

/**
 * Vanilla ship_sizes_top.dds: interior gradient (40,58,53) -> (17,27,24), border and glow
 * (55,105,84), hull (9,9,9).
 */
const NORMAL_PALETTE: ShipIconPalette = {
    panelTop: [40, 58, 53],
    panelBottom: [17, 27, 24],
    silhouette: [9, 9, 9],
    accent: [55, 105, 84],
};

/**
 * Vanilla ship_sizes_top_damaged.dds: interior gradient (60,16,16) -> (27,7,7), border and
 * glow (99,26,26), hull (11,3,3).
 */
const DAMAGED_PALETTE: ShipIconPalette = {
    panelTop: [60, 16, 16],
    panelBottom: [27, 7, 7],
    silhouette: [11, 3, 3],
    accent: [99, 26, 26],
};

export const DEFAULT_SHIP_ICON_STYLE: ShipIconStyle = {
    cellWidth: 80,
    cellHeight: 40,
    supersampling: 5,
    padding: 1,
    fill: 0.96,
    glow: true,
    background: 'panel',
    normalPalette: NORMAL_PALETTE,
    damagedPalette: DAMAGED_PALETTE,
    damaged: false,
};

/**
 * Extents below this fraction of the reference extent count as degenerate: an axis this flat
 * carries no usable height, and a footprint axis this flat leaves no top face to look at.
 */
const DEGENERATE_EXTENT_RATIO = 0.05;

const SILHOUETTE_COVERAGE = 110;
const GLOW_MAX_ALPHA = 215;
const GLOW_BLUR_RADIUS = 2;
const GLOW_BLUR_PASSES = 3;
// Refuse absurd supersample buffers instead of letting the allocation throw.
const MAX_SUPERSAMPLED_PIXELS = 1 << 26;

function sanitizeLength(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
}

function sanitizeChannel(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(255, Math.max(0, Math.floor(value)));
}

function sanitizeTriple(
    value: readonly number[] | undefined,
    fallback: readonly [number, number, number],
): readonly [number, number, number] {
    return [
        sanitizeChannel(value?.[0], fallback[0]),
        sanitizeChannel(value?.[1], fallback[1]),
        sanitizeChannel(value?.[2], fallback[2]),
    ];
}

/** Unset palette fields keep the matching default, so a caller may override just the accent. */
function sanitizePalette(
    value: Partial<ShipIconPalette> | undefined,
    fallback: ShipIconPalette,
): ShipIconPalette {
    return {
        panelTop: sanitizeTriple(value?.panelTop, fallback.panelTop),
        panelBottom: sanitizeTriple(value?.panelBottom, fallback.panelBottom),
        silhouette: sanitizeTriple(value?.silhouette, fallback.silhouette),
        accent: sanitizeTriple(value?.accent, fallback.accent),
    };
}

function sanitizeBackground(value: ShipIconBackground | undefined): ShipIconBackground {
    return value === 'transparent' ? 'transparent' : DEFAULT_SHIP_ICON_STYLE.background;
}

function resolveStyle(style?: Partial<ShipIconStyle>): ShipIconStyle {
    const current = style ?? {};
    return {
        cellWidth: sanitizeLength(current.cellWidth, DEFAULT_SHIP_ICON_STYLE.cellWidth),
        cellHeight: sanitizeLength(current.cellHeight, DEFAULT_SHIP_ICON_STYLE.cellHeight),
        supersampling: Math.max(1, sanitizeLength(current.supersampling, DEFAULT_SHIP_ICON_STYLE.supersampling)),
        padding: sanitizeLength(current.padding, DEFAULT_SHIP_ICON_STYLE.padding),
        fill: current.fill !== undefined && Number.isFinite(current.fill)
            ? Math.max(0, current.fill)
            : DEFAULT_SHIP_ICON_STYLE.fill,
        glow: current.glow ?? DEFAULT_SHIP_ICON_STYLE.glow,
        background: sanitizeBackground(current.background),
        normalPalette: sanitizePalette(current.normalPalette, DEFAULT_SHIP_ICON_STYLE.normalPalette),
        damagedPalette: sanitizePalette(current.damagedPalette, DEFAULT_SHIP_ICON_STYLE.damagedPalette),
        damaged: current.damaged ?? DEFAULT_SHIP_ICON_STYLE.damaged,
    };
}

/** Round half away from zero, matching C++ lround instead of Math.round's half-up. */
function lround(value: number): number {
    return value < 0 ? -Math.round(-value) : Math.round(value);
}

function clampToInt32(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value > 2147483647) return 2147483647;
    if (value < -2147483648) return -2147483648;
    return value;
}

function readComponent(positions: Float32Array, index: number): number {
    return positions[index] ?? Number.NaN;
}

function componentOf(axis: number, x: number, y: number, z: number): number {
    if (axis === 0) return x;
    return axis === 1 ? y : z;
}

/**
 * Coverage map in 0..255, or undefined when the mesh yields no geometry to draw.
 * Mirrors the project and rasterize steps of example/main.cpp.
 */
function rasterizeMesh(mesh: ShipIconMesh, style: ShipIconStyle): Uint8Array | undefined {
    const width = style.cellWidth;
    const height = style.cellHeight;
    if (width <= 0 || height <= 0) return undefined;

    const positions = mesh.positions;
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) return undefined;

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let finiteVertices = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const x = readComponent(positions, vertex * 3);
        const y = readComponent(positions, vertex * 3 + 1);
        const z = readComponent(positions, vertex * 3 + 2);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        finiteVertices++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    if (finiteVertices === 0) return undefined;

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    // Stellaris models are Y-up: the vertical (hull height) axis is Y, and the icon looks
    // straight down onto the X/Z plane.
    //
    // The reference implementation instead took the *smallest* bounding-box axis as the
    // vertical one, which is only a proxy for "the flattest axis" and holds only while Y happens
    // to be the flattest. On a hull that is longer in Y than in X/Z it picks X and the icon
    // degenerates into a side view. That heuristic survives here only as the fallback for the
    // hulls Y-up cannot show: one that is flat in Y (a sheet) has no height of its own, and one
    // whose X/Z footprint collapses to a line has no top face to look down on.
    const maxExtent = Math.max(extentX, extentY, extentZ);
    const footprintLong = Math.max(extentX, extentZ);
    const footprintShort = Math.min(extentX, extentZ);
    let heightAxis: number;
    if (extentY >= DEGENERATE_EXTENT_RATIO * maxExtent &&
        footprintShort >= DEGENERATE_EXTENT_RATIO * footprintLong) {
        heightAxis = 1;
    } else {
        heightAxis = 0;
        let heightExtent = extentX;
        if (extentY < heightExtent) {
            heightAxis = 1;
            heightExtent = extentY;
        }
        if (extentZ < heightExtent) {
            heightAxis = 2;
        }
    }

    let lengthAxis = 0;
    let sideAxis = 0;
    if (heightAxis === 0) {
        lengthAxis = extentY >= extentZ ? 1 : 2;
        sideAxis = extentY >= extentZ ? 2 : 1;
    } else if (heightAxis === 1) {
        lengthAxis = extentX >= extentZ ? 0 : 2;
        sideAxis = extentX >= extentZ ? 2 : 0;
    } else {
        lengthAxis = extentX >= extentY ? 0 : 1;
        sideAxis = extentX >= extentY ? 1 : 0;
    }

    const screenX = new Float64Array(vertexCount);
    const screenY = new Float64Array(vertexCount);
    const drawable = new Uint8Array(vertexCount);
    let minScreenX = Number.POSITIVE_INFINITY;
    let maxScreenX = Number.NEGATIVE_INFINITY;
    let minScreenY = Number.POSITIVE_INFINITY;
    let maxScreenY = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const x = readComponent(positions, vertex * 3);
        const y = readComponent(positions, vertex * 3 + 1);
        const z = readComponent(positions, vertex * 3 + 2);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const px = componentOf(lengthAxis, x, y, z);
        const py = componentOf(sideAxis, x, y, z);
        screenX[vertex] = px;
        screenY[vertex] = py;
        drawable[vertex] = 1;
        if (px < minScreenX) minScreenX = px;
        if (px > maxScreenX) maxScreenX = px;
        if (py < minScreenY) minScreenY = py;
        if (py > maxScreenY) maxScreenY = py;
    }
    if (minScreenX > maxScreenX) return undefined;

    const spanX = Math.max(maxScreenX - minScreenX, 1e-9);
    const spanY = Math.max(maxScreenY - minScreenY, 1e-9);
    const availableWidth = width - 2 * style.padding;
    const availableHeight = height - 2 * style.padding;
    if (availableWidth <= 0 || availableHeight <= 0) return undefined;
    const scale = Math.min(availableWidth / spanX, availableHeight / spanY) * style.fill;
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const offsetX = (width - spanX * scale) / 2 - minScreenX * scale;
    const offsetY = (height - spanY * scale) / 2 - minScreenY * scale;

    const supersampling = style.supersampling;
    const supersampledWidth = width * supersampling;
    const supersampledHeight = height * supersampling;
    if (supersampledWidth * supersampledHeight > MAX_SUPERSAMPLED_PIXELS) return undefined;
    const mask = new Uint8Array(supersampledWidth * supersampledHeight);

    const pixelX = new Int32Array(vertexCount);
    const pixelY = new Int32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        if (drawable[vertex] !== 1) continue;
        const x = screenX[vertex] ?? 0;
        const y = screenY[vertex] ?? 0;
        pixelX[vertex] = clampToInt32(lround((x * scale + offsetX) * supersampling));
        pixelY[vertex] = clampToInt32(lround((supersampledHeight - 1) - (y * scale + offsetY) * supersampling));
    }

    const triangleCount = Math.floor(mesh.indices.length / 3);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
        const i0 = mesh.indices[triangle * 3] ?? 0;
        const i1 = mesh.indices[triangle * 3 + 1] ?? 0;
        const i2 = mesh.indices[triangle * 3 + 2] ?? 0;
        if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
        if (drawable[i0] !== 1 || drawable[i1] !== 1 || drawable[i2] !== 1) continue;

        const x0 = pixelX[i0] ?? 0;
        const y0 = pixelY[i0] ?? 0;
        const x1 = pixelX[i1] ?? 0;
        const y1 = pixelY[i1] ?? 0;
        const x2 = pixelX[i2] ?? 0;
        const y2 = pixelY[i2] ?? 0;

        const rowStart = Math.max(0, Math.min(y0, y1, y2));
        const rowEnd = Math.min(supersampledHeight - 1, Math.max(y0, y1, y2));
        for (let row = rowStart; row <= rowEnd; row++) {
            let left = 2147483647;
            let right = -2147483648;
            for (let edge = 0; edge < 3; edge++) {
                let ax: number;
                let ay: number;
                let bx: number;
                let by: number;
                if (edge === 0) {
                    ax = x0;
                    ay = y0;
                    bx = x1;
                    by = y1;
                } else if (edge === 1) {
                    ax = x1;
                    ay = y1;
                    bx = x2;
                    by = y2;
                } else {
                    ax = x2;
                    ay = y2;
                    bx = x0;
                    by = y0;
                }
                if (ay === by) {
                    if (row === ay) {
                        left = Math.min(left, Math.min(ax, bx));
                        right = Math.max(right, Math.max(ax, bx));
                    }
                    continue;
                }
                if ((row >= ay && row < by) || (row >= by && row < ay)) {
                    const numerator = (bx - ax) * (row - ay);
                    const crossing = ax + Math.trunc(numerator / (by - ay));
                    left = Math.min(left, crossing);
                    right = Math.max(right, crossing);
                }
            }
            if (left > right) continue;
            const clampedLeft = Math.max(left, 0);
            const clampedRight = Math.min(right, supersampledWidth - 1);
            if (clampedLeft > clampedRight) continue;
            const rowBase = row * supersampledWidth;
            for (let column = clampedLeft; column <= clampedRight; column++) mask[rowBase + column] = 255;
        }
    }

    const coverage = new Uint8Array(width * height);
    const cells = supersampling * supersampling;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = 0; dy < supersampling; dy++) {
                const rowBase = (y * supersampling + dy) * supersampledWidth + x * supersampling;
                for (let dx = 0; dx < supersampling; dx++) sum += mask[rowBase + dx] ?? 0;
            }
            coverage[y * width + x] = Math.floor(sum / cells);
        }
    }
    return coverage;
}

function blurHorizontal(source: Uint8Array, target: Uint8Array, width: number, height: number, radius: number): void {
    const window = radius * 2 + 1;
    for (let y = 0; y < height; y++) {
        const rowBase = y * width;
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dx = -radius; dx <= radius; dx++) {
                const column = Math.min(width - 1, Math.max(0, x + dx));
                sum += source[rowBase + column] ?? 0;
            }
            target[rowBase + x] = Math.floor(sum / window);
        }
    }
}

function blurVertical(source: Uint8Array, target: Uint8Array, width: number, height: number, radius: number): void {
    const window = radius * 2 + 1;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                const row = Math.min(height - 1, Math.max(0, y + dy));
                sum += source[row * width + x] ?? 0;
            }
            target[y * width + x] = Math.floor(sum / window);
        }
    }
}

/** Three separable box-blur passes with integer sums: a cheap gaussian, byte-stable. */
function boxBlur(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    const current = source.slice();
    const scratch = new Uint8Array(source.length);
    for (let pass = 0; pass < GLOW_BLUR_PASSES; pass++) {
        blurHorizontal(current, scratch, width, height, radius);
        blurVertical(scratch, current, width, height, radius);
    }
    return current;
}

/** One panel row channel: row 0 is the top colour, the last row the bottom colour. */
function interpolateChannel(top: number, bottom: number, y: number, height: number): number {
    if (height <= 1) return top;
    return top + Math.round(((bottom - top) * y) / (height - 1));
}

/**
 * Smallest cell that carries the vanilla frame decoration. At 8px a cell still holds a 1px
 * margin, a 1px border and a 4x6 interior, so all three parts stay visible.
 */
const PANEL_MIN_DECORATED_CELL = 8;

/**
 * The frame decoration of one cell, in pixels.
 *
 * The margin is horizontal only: the vanilla 80x40 cell leaves x=0 and x=width-1 transparent
 * but its outermost rows are the border itself. Both parts are dropped when the cell is
 * narrower or shorter than 8px, where a margin plus a border would leave no interior to
 * gradient across; such a cell simply keeps the gradient over its whole area.
 */
interface PanelInsets {
    /** Transparent columns of the left and right edge, or 0. */
    margin: number;
    /** Accent ring just inside the margin, or 0. */
    border: number;
}

function panelInsets(width: number, height: number): PanelInsets {
    if (width < PANEL_MIN_DECORATED_CELL || height < PANEL_MIN_DECORATED_CELL) {
        return { margin: 0, border: 0 };
    }
    return { margin: 1, border: 1 };
}

/**
 * Base panel: a transparent horizontal margin, the accent border ring, and inside it the
 * vertical gradient whose first row is panelTop and whose last row is panelBottom. Vertical
 * rows carry no margin, so the interior starts on the border's inner edge.
 */
function paintPanel(pixels: Uint8Array, width: number, height: number, palette: ShipIconPalette): void {
    if (width <= 0 || height <= 0) return;
    const { margin, border } = panelInsets(width, height);
    const firstColumn = margin + border;
    const lastColumn = width - 1 - firstColumn;
    const firstRow = border;
    const lastRow = height - 1 - border;
    const interiorRows = Math.max(1, lastRow - firstRow + 1);
    for (let y = 0; y < height; y++) {
        const row = Math.min(interiorRows - 1, Math.max(0, y - firstRow));
        const red = interpolateChannel(palette.panelTop[0], palette.panelBottom[0], row, interiorRows);
        const green = interpolateChannel(palette.panelTop[1], palette.panelBottom[1], row, interiorRows);
        const blue = interpolateChannel(palette.panelTop[2], palette.panelBottom[2], row, interiorRows);
        const rowBase = y * width * 4;
        for (let x = 0; x < width; x++) {
            const offset = rowBase + x * 4;
            if (x < margin || x >= width - margin) {
                // Straight transparent pixel: the margin carries no colour at all.
                pixels[offset] = 0;
                pixels[offset + 1] = 0;
                pixels[offset + 2] = 0;
                pixels[offset + 3] = 0;
                continue;
            }
            const onBorder = border > 0 && (x < firstColumn || x > lastColumn || y < firstRow || y > lastRow);
            if (onBorder) {
                pixels[offset] = palette.accent[0];
                pixels[offset + 1] = palette.accent[1];
                pixels[offset + 2] = palette.accent[2];
            } else {
                pixels[offset] = red;
                pixels[offset + 1] = green;
                pixels[offset + 2] = blue;
            }
            pixels[offset + 3] = 255;
        }
    }
}

/**
 * Restore the transparent margin after compositing: the glow may spill over the border ring,
 * as the vanilla border there is only a flat colour, but it must not fill the columns the
 * measured cell leaves empty.
 */
function clearPanelMargin(pixels: Uint8Array, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const { margin } = panelInsets(width, height);
    if (margin <= 0) return;
    for (let y = 0; y < height; y++) {
        const rowBase = y * width * 4;
        for (let x = 0; x < margin; x++) {
            for (const column of [x, width - 1 - x]) {
                const offset = rowBase + column * 4;
                pixels[offset] = 0;
                pixels[offset + 1] = 0;
                pixels[offset + 2] = 0;
                pixels[offset + 3] = 0;
            }
        }
    }
}

/**
 * Compose one cell: panel (optional), then the glow over it, then the opaque hull.
 * The glow and the hull sit on the interior gradient; only the measured 1px margin of a
 * panel cell stays transparent, and every other pixel of it is opaque.
 */
function stylize(
    coverage: Uint8Array,
    width: number,
    height: number,
    style: ShipIconStyle,
): Uint8Array {
    const palette = style.damaged ? style.damagedPalette : style.normalPalette;
    const pixels = new Uint8Array(width * height * 4);
    const opaquePanel = style.background === 'panel';
    if (opaquePanel) paintPanel(pixels, width, height, palette);
    const blurred = style.glow ? boxBlur(coverage, width, height, GLOW_BLUR_RADIUS) : undefined;
    const accentRed = palette.accent[0];
    const accentGreen = palette.accent[1];
    const accentBlue = palette.accent[2];
    const hullRed = palette.silhouette[0];
    const hullGreen = palette.silhouette[1];
    const hullBlue = palette.silhouette[2];
    for (let index = 0; index < coverage.length; index++) {
        const offset = index * 4;
        if ((coverage[index] ?? 0) > SILHOUETTE_COVERAGE) {
            pixels[offset] = hullRed;
            pixels[offset + 1] = hullGreen;
            pixels[offset + 2] = hullBlue;
            pixels[offset + 3] = 255;
            continue;
        }
        if (blurred === undefined) continue;
        const alpha = Math.min(GLOW_MAX_ALPHA, Math.floor(((blurred[index] ?? 0) * 5) / 2));
        if (alpha <= 0) continue;
        if (!opaquePanel) {
            // Straight (non-premultiplied) pixels: the cell keeps its transparent background.
            pixels[offset] = accentRed;
            pixels[offset + 1] = accentGreen;
            pixels[offset + 2] = accentBlue;
            pixels[offset + 3] = alpha;
            continue;
        }
        // Normal source-over blend onto the panel, which stays opaque.
        const keep = 255 - alpha;
        pixels[offset] = Math.round(((pixels[offset] ?? 0) * keep + accentRed * alpha) / 255);
        pixels[offset + 1] = Math.round(((pixels[offset + 1] ?? 0) * keep + accentGreen * alpha) / 255);
        pixels[offset + 2] = Math.round(((pixels[offset + 2] ?? 0) * keep + accentBlue * alpha) / 255);
        pixels[offset + 3] = 255;
    }
    if (opaquePanel) clearPanelMargin(pixels, width, height);
    return pixels;
}

/** Render one 80x40 (by default) frame; missing or unusable geometry still gets the panel. */
export function renderShipIconFrame(mesh: ShipIconMesh | undefined, style?: Partial<ShipIconStyle>): RgbaImage {
    const resolved = resolveStyle(style);
    const width = resolved.cellWidth;
    const height = resolved.cellHeight;
    const coverage = mesh === undefined ? undefined : rasterizeMesh(mesh, resolved);
    const empty = coverage ?? new Uint8Array(Math.max(0, width * height));
    return { width, height, pixels: stylize(empty, width, height, resolved) };
}

/** Concatenate frames left to right, padding with fully transparent slots. */
export function composeHorizontalSheet(frames: readonly RgbaImage[], paddedFrames?: number): RgbaImage {
    const requested = paddedFrames !== undefined && Number.isFinite(paddedFrames)
        ? Math.max(0, Math.floor(paddedFrames))
        : 0;
    const slots: RgbaImage[] = [];
    for (const frame of frames) {
        if (!frame) continue;
        const frameWidth = Math.max(0, Math.floor(Number.isFinite(frame.width) ? frame.width : 0));
        const frameHeight = Math.max(0, Math.floor(Number.isFinite(frame.height) ? frame.height : 0));
        slots.push({ width: frameWidth, height: frameHeight, pixels: frame.pixels });
    }
    const paddingWidth = slots[0]?.width ?? 0;
    const slotCount = Math.max(slots.length, requested);
    while (slots.length < slotCount) slots.push({ width: paddingWidth, height: 0, pixels: new Uint8Array(0) });
    if (slots.length === 0) return { width: 0, height: 0, pixels: new Uint8Array(0) };

    let width = 0;
    let height = 0;
    for (const slot of slots) {
        width += slot.width;
        if (slot.height > height) height = slot.height;
    }
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const rowBase = y * width * 4;
        let cursor = 0;
        for (const slot of slots) {
            const rowBytes = slot.width * 4;
            const start = y * rowBytes;
            if (y < slot.height && start + rowBytes <= slot.pixels.length) {
                pixels.set(slot.pixels.subarray(start, start + rowBytes), rowBase + cursor);
            }
            cursor += rowBytes;
        }
    }
    return { width, height, pixels };
}
