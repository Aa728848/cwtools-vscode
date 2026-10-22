import { expect } from 'chai';
import type { RgbaImage, ShipIconStyle } from '../../extension/shipIcon/shipIconRender';
import {
    buildShipIconSheet,
    type ShipIconBinaryReader,
} from '../../extension/shipIcon/shipIconSheet';
import type { ResolvedShipIcon } from '../../extension/shipIcon/shipIconDefinitions';

/** The transparent capability of the style: a gap really is empty, no panel behind it. */
const TRANSPARENT_STYLE: Partial<ShipIconStyle> = { background: 'transparent' };
/** Default-style hull colours, so a panel-only frame can be told apart from a drawn one. */
const NORMAL_HULL: readonly [number, number, number] = [9, 9, 9];
const DAMAGED_HULL: readonly [number, number, number] = [11, 3, 3];

// ── Synthetic pdxmesh fixtures ───────────────────────────────────────────────

/** '@@b@'; the walker resumes on the '!' property marker of the first property. */
const MAGIC = Buffer.from('@@b@', 'latin1');

function object(depth: number, name: string): Buffer {
    return Buffer.concat([Buffer.alloc(depth, 0x5b), Buffer.from(name, 'latin1'), Buffer.from([0])]);
}

function property(name: string, type: 'f' | 'i', values: readonly number[]): Buffer {
    const nameBytes = Buffer.from(name, 'latin1');
    const header = Buffer.alloc(1 + 1 + nameBytes.length + 1 + 4);
    let offset = 0;
    header.writeUInt8(0x21, offset++);
    header.writeUInt8(nameBytes.length, offset++);
    nameBytes.copy(header, offset);
    offset += nameBytes.length;
    header.writeUInt8(type === 'f' ? 0x66 : 0x69, offset++);
    header.writeUInt32LE(values.length, offset);
    const payload = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => {
        if (type === 'f') payload.writeFloatLE(value, index * 4);
        else payload.writeUInt32LE(value, index * 4);
    });
    return Buffer.concat([header, payload]);
}

function arrayBuffer(bytes: Buffer): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A 10 x 20 quad in the X/Y plane: thin on Z, so the top-down view is a rectangle. */
function quadMesh(): Buffer {
    return Buffer.concat([
        MAGIC,
        property('dummy', 'f', []),
        object(1, 'mesh'),
        property('p', 'f', [0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0]),
        property('tri', 'i', [0, 1, 2, 0, 2, 3]),
    ]);
}

/** A narrower hull offset along X, so it renders differently from quadMesh alone. */
function sliverMesh(): Buffer {
    return Buffer.concat([
        MAGIC,
        property('dummy', 'f', []),
        object(1, 'mesh'),
        property('p', 'f', [20, 0, 0, 24, 0, 0, 24, 20, 0, 20, 20, 0]),
        property('tri', 'i', [0, 1, 2, 0, 2, 3]),
    ]);
}

/** Positions but no index pair: a carrier that only holds locators, so it has no geometry. */
function locatorOnlyMesh(): Buffer {
    return Buffer.concat([
        MAGIC,
        property('dummy', 'f', []),
        object(1, 'mesh'),
        property('p', 'f', [0, 0, 0, 1, 0, 0, 0, 1, 0]),
    ]);
}

function readerFor(files: Record<string, Buffer>): ShipIconBinaryReader {
    return async (relativePath: string) => {
        const file = files[relativePath];
        return file === undefined ? undefined : arrayBuffer(file);
    };
}

function icon(
    shipSize: string,
    frame: number,
    sheetFrames: number,
    meshFiles: readonly string[],
): ResolvedShipIcon {
    return { shipSize, frame, sheetFrames, meshFiles: [...meshFiles], warnings: [] };
}

// ── Pixel helpers ────────────────────────────────────────────────────────────

function framePixels(image: RgbaImage, index: number): Uint8Array {
    const cellWidth = 80;
    const left = index * cellWidth;
    const pixels = new Uint8Array(cellWidth * image.height * 4);
    for (let y = 0; y < image.height; y++) {
        const source = (y * image.width + left) * 4;
        pixels.set(image.pixels.subarray(source, source + cellWidth * 4), y * cellWidth * 4);
    }
    return pixels;
}

function maxAlpha(pixels: Uint8Array): number {
    let highest = 0;
    for (let index = 3; index < pixels.length; index += 4) {
        if ((pixels[index] ?? 0) > highest) highest = pixels[index] ?? 0;
    }
    return highest;
}

function isBlank(pixels: Uint8Array): boolean {
    return maxAlpha(pixels) === 0;
}

function hasColour(pixels: Uint8Array, rgb: readonly [number, number, number]): boolean {
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] === rgb[0] && pixels[index + 1] === rgb[1] && pixels[index + 2] === rgb[2]) {
            return true;
        }
    }
    return false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('shipIconSheet', () => {
    it('places each size on its 1-based frame and keeps blank frames for the gaps', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 4, ['gfx/models/ships/a.mesh']), icon('cruiser', 3, 4, ['gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount).to.equal(4);
        expect(sheet.image.width).to.equal(4 * 80);
        expect(sheet.image.height).to.equal(40);
        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame]))
            .to.deep.equal([['corvette', 1], ['cruiser', 3]]);

        expect(isBlank(framePixels(sheet.image, 0))).to.equal(false);
        expect(isBlank(framePixels(sheet.image, 1)), 'frame 2 is a gap').to.equal(true);
        expect(isBlank(framePixels(sheet.image, 2))).to.equal(false);
        expect(isBlank(framePixels(sheet.image, 3)), 'frame 4 is unused padding').to.equal(true);
    });

    it('pads the sheet to noOfFrames even when the highest frame is lower', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 2, 6, ['gfx/models/ships/a.mesh'])],
            readerFor({ 'gfx/models/ships/a.mesh': quadMesh() }),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount).to.equal(6);
        expect(sheet.image.width).to.equal(6 * 80);
        expect(isBlank(framePixels(sheet.image, 1))).to.equal(false);
        expect(isBlank(framePixels(sheet.image, 5))).to.equal(true);
    });

    it('keeps a transparent frame and a warning when a mesh file is missing', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 2, ['gfx/models/ships/a.mesh']), icon('destroyer', 2, 2, ['gfx/models/ships/gone.mesh'])],
            readerFor({ 'gfx/models/ships/a.mesh': quadMesh() }),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount).to.equal(2);
        expect(isBlank(framePixels(sheet.image, 0))).to.equal(false);
        expect(isBlank(framePixels(sheet.image, 1)), 'the missing mesh leaves a blank frame').to.equal(true);

        const destroyer = sheet.placed.find((entry) => entry.shipSize === 'destroyer');
        expect(destroyer?.frame, 'the blank frame still holds its slot').to.equal(2);
        expect(destroyer?.warnings.join(' | ')).to.contain('gone.mesh');
        expect(sheet.skippedFiles).to.deep.equal(['gfx/models/ships/gone.mesh']);
    });

    it('reports a throwing reader as a skipped file instead of failing the sheet', async () => {
        const throwing: ShipIconBinaryReader = async (relativePath: string) => {
            throw new Error(`denied: ${relativePath}`);
        };
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])],
            throwing,
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount).to.equal(1);
        expect(isBlank(framePixels(sheet.image, 0))).to.equal(true);
        expect(sheet.skippedFiles).to.deep.equal(['gfx/models/ships/a.mesh']);
        expect(sheet.placed[0]?.warnings.join(' | ')).to.contain('denied');
    });

    it('draws the damaged sheet as a pure palette swap, with no per-size seed', async () => {
        const files = { 'gfx/models/ships/a.mesh': quadMesh() };
        const first = await buildShipIconSheet([icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])], readerFor(files), { damaged: true });
        const second = await buildShipIconSheet([icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])], readerFor(files), { damaged: true });

        expect([...first.image.pixels]).to.deep.equal([...second.image.pixels]);

        // The size name no longer feeds a seed, so two sizes sharing one mesh match.
        const other = await buildShipIconSheet([icon('destroyer', 1, 1, ['gfx/models/ships/a.mesh'])], readerFor(files), { damaged: true });
        expect([...other.image.pixels]).to.deep.equal([...first.image.pixels]);

        expect(hasColour(framePixels(first.image, 0), DAMAGED_HULL)).to.equal(true);
        expect(hasColour(framePixels(first.image, 0), NORMAL_HULL)).to.equal(false);
    });

    it('fills the default-style gap frames with the opaque panel', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 3, ['gfx/models/ships/a.mesh'])],
            readerFor({ 'gfx/models/ships/a.mesh': quadMesh() }),
        );

        expect(sheet.frameCount).to.equal(3);
        expect(maxAlpha(framePixels(sheet.image, 1)), 'a gap still carries the panel').to.equal(255);
        expect(hasColour(framePixels(sheet.image, 1), NORMAL_HULL), 'but no hull').to.equal(false);
        expect(maxAlpha(framePixels(sheet.image, 2))).to.equal(255);
        expect(hasColour(framePixels(sheet.image, 0), NORMAL_HULL)).to.equal(true);
    });

    it('swaps only the palette between the normal and the damaged sheet', async () => {
        const files = { 'gfx/models/ships/a.mesh': quadMesh() };
        const normal = await buildShipIconSheet([icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])], readerFor(files));
        const damaged = await buildShipIconSheet([icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])], readerFor(files), { damaged: true });

        const normalPixels = framePixels(normal.image, 0);
        const damagedPixels = framePixels(damaged.image, 0);
        expect([...normalPixels]).not.to.deep.equal([...damagedPixels]);
        // Both cells stay opaque and keep the same coverage: only the colours moved.
        expect(maxAlpha(normalPixels)).to.equal(255);
        expect(maxAlpha(damagedPixels)).to.equal(255);
        expect(hasColour(normalPixels, NORMAL_HULL)).to.equal(true);
        expect(hasColour(damagedPixels, DAMAGED_HULL)).to.equal(true);
        expect(hasColour(normalPixels, DAMAGED_HULL)).to.equal(false);
        expect(hasColour(damagedPixels, NORMAL_HULL)).to.equal(false);
    });

    it('packs tightly in selection order and warns when no frame number resolves', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 0, 0, ['gfx/models/ships/a.mesh']), icon('destroyer', 0, 0, ['gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
        );

        expect(sheet.frameCount).to.equal(2);
        expect(sheet.image.width).to.equal(2 * 80);
        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame]))
            .to.deep.equal([['corvette', 1], ['destroyer', 2]]);
        expect(sheet.warnings.join(' | ')).to.contain('selection order');
    });

    it('appends a size without a frame number after the resolved frames', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 0, 2, ['gfx/models/ships/a.mesh']), icon('destroyer', 1, 2, ['gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
        );

        expect(sheet.frameCount).to.equal(3);
        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame]))
            .to.deep.equal([['destroyer', 1], ['corvette', 3]]);
        expect(sheet.placed.find((entry) => entry.shipSize === 'corvette')?.warnings.join(' | '))
            .to.contain('frame number is unresolved');
    });

    // ── Frame allocation: aligned / packed / widened ─────────────────────────

    it('keeps a free own frame and warns nobody about it', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 3, ['gfx/models/ships/a.mesh']), icon('cruiser', 3, 3, ['gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame, entry.kind])).to.deep.equal([
            ['corvette', 1, 'aligned'],
            ['cruiser', 3, 'aligned'],
        ]);
        expect(sheet.alignment).to.deep.equal({ aligned: 2, packed: 0, widened: 0 });
        for (const placed of sheet.placed) expect(placed.warnings).to.deep.equal([]);
    });

    it('packs a shared frame into the smallest free frame instead of dropping the size', async () => {
        const sheet = await buildShipIconSheet(
            [
                icon('corvette', 1, 3, ['gfx/models/ships/a.mesh']),
                icon('cruiser', 1, 3, ['gfx/models/ships/b.mesh']),
                icon('destroyer', 1, 3, ['gfx/models/ships/a.mesh']),
            ],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount).to.equal(3);
        expect(sheet.image.width).to.equal(3 * 80);
        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame, entry.kind])).to.deep.equal([
            ['corvette', 1, 'aligned'],
            ['cruiser', 2, 'packed'],
            ['destroyer', 3, 'packed'],
        ]);
        expect(sheet.alignment).to.deep.equal({ aligned: 1, packed: 2, widened: 0 });
        expect(isBlank(framePixels(sheet.image, 2)), 'the packed size is drawn, not dropped').to.equal(false);

        const packed = sheet.placed.find((entry) => entry.shipSize === 'cruiser');
        expect(packed?.warnings.join(' | ')).to.contain('packed');
        expect(packed?.warnings.join(' | ')).to.contain('frame 1');
    });

    it('widens the sheet when every frame is used rather than losing the size', async () => {
        const files = {
            'gfx/models/ships/a.mesh': quadMesh(),
            'gfx/models/ships/b.mesh': sliverMesh(),
        };
        const sheet = await buildShipIconSheet(
            [
                icon('corvette', 1, 2, ['gfx/models/ships/a.mesh']),
                icon('cruiser', 1, 2, ['gfx/models/ships/b.mesh']),
                icon('destroyer', 1, 2, ['gfx/models/ships/a.mesh']),
                icon('battleship', 1, 2, ['gfx/models/ships/b.mesh']),
            ],
            readerFor(files),
            { style: TRANSPARENT_STYLE },
        );

        expect(sheet.frameCount, 'two declared frames plus two widened ones').to.equal(4);
        expect(sheet.image.width, 'the sheet grows by one cell per widened size').to.equal(4 * 80);
        expect(sheet.placed.map((entry) => [entry.shipSize, entry.frame, entry.kind])).to.deep.equal([
            ['corvette', 1, 'aligned'],
            ['cruiser', 2, 'packed'],
            ['destroyer', 3, 'widened'],
            ['battleship', 4, 'widened'],
        ]);
        expect(sheet.alignment).to.deep.equal({ aligned: 1, packed: 1, widened: 2 });

        for (let index = 0; index < 4; index++) {
            expect(isBlank(framePixels(sheet.image, index)), `frame ${index + 1} is drawn`).to.equal(false);
        }
        const widened = sheet.placed.find((entry) => entry.shipSize === 'destroyer');
        expect(widened?.warnings.join(' | ')).to.contain('widened');
        expect(widened?.warnings.join(' | ')).to.contain('widened to 3 frame(s)');
    });

    it('keeps the backing plate on every empty frame of a packed sheet', async () => {
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 4, ['gfx/models/ships/a.mesh']), icon('cruiser', 1, 4, ['gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
            // Default style, so an empty frame is visible as an opaque panel without a hull.
        );

        expect(sheet.frameCount).to.equal(4);
        expect(sheet.alignment.packed).to.equal(1);
        for (const index of [2, 3]) {
            const pixels = framePixels(sheet.image, index);
            expect(maxAlpha(pixels), `frame ${index + 1} still carries the panel`).to.equal(255);
            expect(hasColour(pixels, NORMAL_HULL), `frame ${index + 1} has no hull`).to.equal(false);
        }
    });

    // ── Warning merging ──────────────────────────────────────────────────────

    it('reads a shared mesh file once and merges its geometry once per size', async () => {
        const reads: string[] = [];
        const files: Record<string, Buffer> = { 'gfx/models/ships/a.mesh': quadMesh() };
        const counting: ShipIconBinaryReader = async (relativePath: string) => {
            reads.push(relativePath);
            const file = files[relativePath];
            return file === undefined ? undefined : arrayBuffer(file);
        };
        const sheet = await buildShipIconSheet(
            [
                icon('corvette', 1, 2, ['gfx/models/ships/a.mesh', 'gfx/models/ships/a.mesh']),
                icon('destroyer', 1, 2, ['gfx/models/ships/a.mesh']),
            ],
            counting,
            { style: TRANSPARENT_STYLE },
        );

        expect(reads, 'one read for one file, however often it is listed').to.deep.equal(['gfx/models/ships/a.mesh']);
        expect(sheet.placed[0]?.meshFiles).to.deep.equal(['gfx/models/ships/a.mesh']);

        // Listing the same hull twice must not double the geometry.
        const once = await buildShipIconSheet(
            [icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])],
            readerFor(files),
            { style: TRANSPARENT_STYLE },
        );
        expect([...framePixels(sheet.image, 0)]).to.deep.equal([...framePixels(once.image, 0)]);
    });

    it('reports a geometry-less mesh once for the whole sheet, in the locator wording', async () => {
        const locator = 'gfx/models/ships/locator_carrier.mesh';
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 2, [locator]), icon('destroyer', 2, 2, [locator])],
            readerFor({ [locator]: locatorOnlyMesh() }),
            { style: TRANSPARENT_STYLE },
        );

        const reported = sheet.warnings.filter((warning) => warning.includes('locator_carrier.mesh'));
        expect(reported).to.deep.equal([
            `mesh '${locator}' has no geometry (often a locator-only carrier); skipped`,
        ]);
        expect(sheet.skippedFiles).to.deep.equal([locator]);
        expect(sheet.placed.map((entry) => entry.frame), 'both sizes keep a blank frame').to.deep.equal([1, 2]);
        for (let index = 0; index < 2; index++) expect(isBlank(framePixels(sheet.image, index))).to.equal(true);
    });

    it('keeps one warning per distinct message inside a size', async () => {
        const gone = 'gfx/models/ships/gone.mesh';
        const sheet = await buildShipIconSheet(
            [icon('corvette', 1, 1, [gone, gone])],
            readerFor({}),
            { style: TRANSPARENT_STYLE },
        );

        const warnings = sheet.placed[0]?.warnings ?? [];
        expect(warnings.filter((warning) => warning.includes('gone.mesh'))).to.have.length(1);
        expect(sheet.skippedFiles).to.deep.equal([gone]);
    });

    it('returns an empty image for an empty selection', async () => {
        const sheet = await buildShipIconSheet([], readerFor({}));
        expect(sheet.frameCount).to.equal(0);
        expect(sheet.image.width).to.equal(0);
        expect(sheet.placed).to.deep.equal([]);
    });

    it('merges every mesh of a size into one frame', async () => {
        const single = await buildShipIconSheet(
            [icon('corvette', 1, 1, ['gfx/models/ships/a.mesh'])],
            readerFor({ 'gfx/models/ships/a.mesh': quadMesh() }),
        );
        const merged = await buildShipIconSheet(
            [icon('corvette', 1, 1, ['gfx/models/ships/a.mesh', 'gfx/models/ships/b.mesh'])],
            readerFor({
                'gfx/models/ships/a.mesh': quadMesh(),
                'gfx/models/ships/b.mesh': sliverMesh(),
            }),
        );

        expect(merged.frameCount).to.equal(1);
        expect(merged.skippedFiles).to.deep.equal([]);
        expect([...merged.image.pixels]).not.to.deep.equal([...single.image.pixels]);
    });
});
