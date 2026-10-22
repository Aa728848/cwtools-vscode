/**
 * Ship icon sheet assembly.
 *
 * Turns resolved ship icons into one horizontal sheet: every mesh file is read
 * through a caller-supplied reader, rasterised into its frame, and the frames are
 * concatenated in sprite frame order. The damaged sheet is the same geometry drawn
 * with the damaged palette. Pure and deterministic: no vscode, no fs, no clock, no
 * Math.random, so the same input always produces the same pixels.
 *
 * Placement never drops a size: a shared icon means several ship sizes resolve to
 * the same sprite frame, and losing the extra sizes would silently draw only a
 * fraction of the selection. A conflicting size is packed into a free frame, and
 * once the sheet has no free frame left it is widened instead.
 */

import type { ShipIconMesh } from './meshGeometry';
import { mergeShipIconMeshes, readPdxMeshGeometry } from './meshGeometry';
import type { ResolvedShipIcon } from './shipIconDefinitions';
import {
    composeHorizontalSheet,
    DEFAULT_SHIP_ICON_STYLE,
    renderShipIconFrame,
    type RgbaImage,
    type ShipIconStyle,
} from './shipIconRender';

/** Reads one game file as raw bytes; a missing or unreadable file resolves to undefined. */
export type ShipIconBinaryReader = (relativePath: string) => Promise<ArrayBuffer | undefined>;

/**
 * How a size reached its frame:
 * - aligned: its own resolved frame number was still free;
 * - packed: its own frame was taken, so it moved to the smallest free frame;
 * - widened: every frame was taken, so the sheet grew by a frame for it.
 */
export type ShipIconFrameKind = 'aligned' | 'packed' | 'widened';

export interface ShipIconSheetPlaced {
    shipSize: string;
    /** 1-based frame the size ended up in; frame 1 is the leftmost cell. */
    frame: number;
    kind: ShipIconFrameKind;
    meshFiles: string[];
    warnings: string[];
}

/** How the placement rules were used; the three counts add up to placed.length. */
export interface ShipIconSheetAlignment {
    aligned: number;
    packed: number;
    widened: number;
}

export interface ShipIconSheetResult {
    image: RgbaImage;
    frameCount: number;
    placed: ShipIconSheetPlaced[];
    warnings: string[];
    /** Mesh files that were referenced but could not be used; their size keeps a hull-less frame. */
    skippedFiles: string[];
    alignment: ShipIconSheetAlignment;
}

export interface BuildShipIconSheetOptions {
    style?: Partial<ShipIconStyle>;
    /** Damaged variant: every frame is drawn with the damaged palette. */
    damaged?: boolean;
}

interface RenderItem {
    shipSize: string;
    frame: number;
    sheetFrames: number;
    kind: ShipIconFrameKind;
    meshFiles: string[];
    warnings: string[];
    image: RgbaImage;
}

function asFrameCount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const rounded = Math.floor(value);
    return rounded > 0 ? rounded : 0;
}

/** One message per distinct text: the same failure must not be listed once per size. */
function addWarning(list: string[], message: string): void {
    if (!list.includes(message)) list.push(message);
}

/** Keeps untrusted resolve results out of the renderer when they are malformed. */
function isResolvedShipIcon(candidate: ResolvedShipIcon | undefined): candidate is ResolvedShipIcon {
    if (candidate === undefined || typeof candidate !== 'object') return false;
    return typeof candidate.shipSize === 'string' && Array.isArray(candidate.meshFiles);
}

/** What one mesh path yielded during a single build. */
interface MeshFileOutcome {
    /** Geometry when the bytes were readable and carried triangles. */
    geometry?: ShipIconMesh;
    /** Set when the file could not be turned into bytes at all. */
    failure?: string;
}

/**
 * Reads every mesh path at most once per build. A listing that repeats a file, or
 * two sizes that share one hull, then cost one read and one merge instead of one
 * per occurrence.
 *
 * A file with no geometry is reported once for the whole sheet, in the merged
 * wording: on mods that hang many sizes off one locator-only carrier the old
 * per-size "no usable triangles" line repeated until the interesting warnings were
 * unreadable.
 */
class SheetMeshReader {
    private readonly cache = new Map<string, Promise<MeshFileOutcome>>();

    constructor(
        private readonly readBinary: ShipIconBinaryReader,
        private readonly warnings: string[],
        private readonly skippedFiles: string[],
    ) { }

    read(meshFile: string): Promise<MeshFileOutcome> {
        // Game paths are authored on a case-insensitive filesystem, so two spellings are one file.
        const key = meshFile.toLowerCase();
        let outcome = this.cache.get(key);
        if (outcome === undefined) {
            outcome = this.load(meshFile);
            this.cache.set(key, outcome);
        }
        return outcome;
    }

    private async load(meshFile: string): Promise<MeshFileOutcome> {
        let buffer: ArrayBuffer | undefined;
        try {
            buffer = await this.readBinary(meshFile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.skip(meshFile);
            return { failure: `mesh '${meshFile}' could not be read: ${message}` };
        }
        if (!(buffer instanceof ArrayBuffer)) {
            this.skip(meshFile);
            return { failure: `mesh '${meshFile}' is not available` };
        }
        const geometry = readPdxMeshGeometry(buffer);
        if (geometry === undefined) {
            this.skip(meshFile);
            addWarning(
                this.warnings,
                `mesh '${meshFile}' has no geometry (often a locator-only carrier); skipped`,
            );
            return {};
        }
        return { geometry };
    }

    private skip(meshFile: string): void {
        if (!this.skippedFiles.includes(meshFile)) this.skippedFiles.push(meshFile);
    }
}

async function renderItem(
    entry: ResolvedShipIcon,
    meshes: SheetMeshReader,
    style: Partial<ShipIconStyle>,
    damaged: boolean,
): Promise<RenderItem> {
    const warnings: string[] = [];
    const frameStyle: Partial<ShipIconStyle> = damaged
        ? { ...style, damaged: true }
        : { ...style, damaged: false };
    const geometries: ShipIconMesh[] = [];
    const meshFiles: string[] = [];
    const seen = new Set<string>();
    for (const meshFile of entry.meshFiles) {
        if (typeof meshFile !== 'string' || meshFile === '') continue;
        const key = meshFile.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        meshFiles.push(meshFile);
        const outcome = await meshes.read(meshFile);
        if (outcome.failure !== undefined) {
            addWarning(warnings, outcome.failure);
            continue;
        }
        if (outcome.geometry !== undefined) geometries.push(outcome.geometry);
    }
    if (geometries.length === 0 && meshFiles.length > 0) {
        addWarning(warnings, 'no usable mesh, so the frame stays blank');
    }
    return {
        shipSize: entry.shipSize,
        frame: asFrameCount(entry.frame),
        sheetFrames: asFrameCount(entry.sheetFrames),
        kind: 'aligned',
        meshFiles,
        warnings,
        image: renderShipIconFrame(mergeShipIconMeshes(geometries), frameStyle),
    };
}

interface Slot { index: number; item: RenderItem; }

/** Smallest unused slot index inside [0, limit), or undefined when the sheet is full. */
function firstFreeSlot(taken: ReadonlySet<number>, limit: number): number | undefined {
    for (let index = 0; index < limit; index++) {
        if (!taken.has(index)) return index;
    }
    return undefined;
}

interface LayoutResult {
    slots: Slot[];
    frameCount: number;
    alignment: ShipIconSheetAlignment;
}

/**
 * Sheet layout: frame numbers are 1-based, gaps keep a blank frame so the sprite
 * indices still line up with the game's sprite sheet. Allocation order is: own
 * frame, else the smallest free frame of the sheet, else a frame the sheet grows
 * for. The free-frame search covers the frames the sheet actually has, which is
 * never fewer than the item's own noOfFrames.
 */
function layoutSlots(items: readonly RenderItem[], warnings: string[]): LayoutResult {
    const alignment: ShipIconSheetAlignment = { aligned: 0, packed: 0, widened: 0 };
    let frameCount = 0;
    for (const item of items) frameCount = Math.max(frameCount, item.sheetFrames, item.frame);

    if (frameCount <= 0) {
        if (items.length === 0) return { slots: [], frameCount: 0, alignment };
        addWarning(warnings, `no sprite frame number could be resolved; packing ${items.length} frame(s) in selection order instead`);
        const slots: Slot[] = items.map((item, index) => {
            item.kind = 'packed';
            return { index, item };
        });
        alignment.packed = items.length;
        return { slots, frameCount: items.length, alignment };
    }

    const slots: Slot[] = [];
    const taken = new Set<number>();
    const unplaced: RenderItem[] = [];
    // Frames past the declared width, handed out once every declared frame is taken.
    let widenCursor = frameCount;

    for (const item of items) {
        if (item.frame <= 0) {
            unplaced.push(item);
            continue;
        }
        const own = item.frame - 1;
        if (!taken.has(own)) {
            taken.add(own);
            item.kind = 'aligned';
            alignment.aligned += 1;
            slots.push({ index: own, item });
            continue;
        }
        const free = firstFreeSlot(taken, frameCount);
        if (free !== undefined) {
            taken.add(free);
            item.kind = 'packed';
            alignment.packed += 1;
            addWarning(
                item.warnings,
                `frame ${item.frame} is already used by another ship size; packed into free frame ${free + 1} instead`,
            );
            slots.push({ index: free, item });
            continue;
        }
        const declared = frameCount;
        while (taken.has(widenCursor)) widenCursor += 1;
        const index = widenCursor;
        taken.add(index);
        widenCursor = index + 1;
        frameCount = Math.max(frameCount, widenCursor);
        item.kind = 'widened';
        alignment.widened += 1;
        addWarning(
            item.warnings,
            `frame ${item.frame} is already used and none of the sheet's ${declared} frame(s) is free; the sheet was widened to ${frameCount} frame(s) and this size is drawn at frame ${index + 1} (widened)`,
        );
        slots.push({ index, item });
    }

    // Sizes without a frame number are appended after the sheet so the selection is not lost.
    const base = frameCount;
    let cursor = base;
    for (const item of unplaced) {
        item.kind = 'widened';
        alignment.widened += 1;
        addWarning(
            item.warnings,
            `frame number is unresolved; drawn at frame ${cursor + 1}, after the sheet's ${base} frame(s)`,
        );
        slots.push({ index: cursor, item });
        cursor += 1;
    }
    return { slots, frameCount: Math.max(base, cursor), alignment };
}

/**
 * Build the whole sheet. Missing meshes leave a frame with only the background (a
 * transparent one unless the style asks for the panel) that still holds its frame
 * number, so the remaining sizes keep their sprite indices.
 */
export async function buildShipIconSheet(
    resolved: readonly ResolvedShipIcon[],
    readBinary: ShipIconBinaryReader,
    options?: BuildShipIconSheetOptions,
): Promise<ShipIconSheetResult> {
    const style = options?.style ?? DEFAULT_SHIP_ICON_STYLE;
    const damaged = options?.damaged === true;
    const warnings: string[] = [];
    const skippedFiles: string[] = [];
    const meshes = new SheetMeshReader(readBinary, warnings, skippedFiles);

    const input: readonly ResolvedShipIcon[] = Array.isArray(resolved) ? resolved : [];
    const entries = input.filter(isResolvedShipIcon);
    const items: RenderItem[] = [];
    for (const entry of entries) {
        items.push(await renderItem(entry, meshes, style, damaged));
    }

    const layout = layoutSlots(items, warnings);
    const placeholder = renderShipIconFrame(undefined, style);
    const frames: RgbaImage[] = [];
    for (let index = 0; index < layout.frameCount; index++) frames.push(placeholder);
    for (const slot of layout.slots) frames[slot.index] = slot.item.image;

    const image = frames.length > 0
        ? composeHorizontalSheet(frames, layout.frameCount)
        : { width: 0, height: 0, pixels: new Uint8Array(0) };

    const placed: ShipIconSheetPlaced[] = layout.slots
        .slice()
        .sort((left, right) => left.index - right.index)
        .map((slot) => ({
            shipSize: slot.item.shipSize,
            frame: slot.index + 1,
            kind: slot.item.kind,
            meshFiles: slot.item.meshFiles,
            warnings: slot.item.warnings,
        }));

    return {
        image,
        frameCount: layout.frameCount,
        placed,
        warnings,
        skippedFiles,
        alignment: layout.alignment,
    };
}
