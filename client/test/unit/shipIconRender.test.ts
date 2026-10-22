import { expect } from 'chai';
import { readPdxMeshGeometry, mergeShipIconMeshes } from '../../extension/shipIcon/meshGeometry';
import type { ShipIconMesh } from '../../extension/shipIcon/meshGeometry';
import {
    DEFAULT_SHIP_ICON_STYLE,
    composeHorizontalSheet,
    renderShipIconFrame,
} from '../../extension/shipIcon/shipIconRender';
import type { RgbaImage } from '../../extension/shipIcon/shipIconRender';
import { encodeDdsArgb8888 } from '../../extension/shipIcon/ddsWrite';

function object(depth: number, name: string): Buffer {
    return Buffer.concat([Buffer.alloc(depth, 0x5b), Buffer.from(name, 'latin1'), Buffer.from([0])]);
}

/** A '!' property carrying floats ('f') or 32-bit elements ('i'). */
function property(name: string, type: 'f' | 'i', values: readonly number[]): Buffer {
    const nameBytes = Buffer.from(name, 'latin1');
    const header = Buffer.alloc(1 + 1 + nameBytes.length + 1 + 4);
    let offset = 0;
    header.writeUInt8(0x21, offset++);
    header.writeUInt8(nameBytes.length, offset++);
    nameBytes.copy(header, offset);
    offset += nameBytes.length;
    header.write(type, offset++, 'latin1');
    header.writeUInt32LE(values.length, offset);
    const data = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => {
        if (type === 'f') data.writeFloatLE(value, index * 4);
        else data.writeUInt32LE(value, index * 4);
    });
    return Buffer.concat([header, data]);
}

/** A string property, written the way vanilla meshes store them: length includes the NUL. */
function stringProperty(name: string, value: string): Buffer {
    const nameBytes = Buffer.from(name, 'latin1');
    const valueBytes = Buffer.from(value + '\0', 'latin1');
    const header = Buffer.alloc(1 + 1 + nameBytes.length + 1 + 4 + 4);
    let offset = 0;
    header.writeUInt8(0x21, offset++);
    header.writeUInt8(nameBytes.length, offset++);
    nameBytes.copy(header, offset);
    offset += nameBytes.length;
    header.write('s', offset++, 'latin1');
    header.writeUInt32LE(1, offset);
    offset += 4;
    header.writeUInt32LE(valueBytes.length, offset);
    return Buffer.concat([header, valueBytes]);
}

// The magic's fifth byte doubles as the first '!' property marker, so a real pdxmesh
// continues with the pdxasset property's name length right after "@@b@".
function binaryMesh(parts: readonly Buffer[]): Buffer {
    return Buffer.concat([
        Buffer.from('@@b@', 'latin1'),
        property('pdxasset', 'i', [2, 0]),
        ...parts,
    ]);
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function quadGeometry(): Buffer[] {
    return [
        property('p', 'f', [-5, 0, -2, 5, 0, -2, 5, 0, 2, -5, 0, 2]),
        property('tri', 'i', [0, 1, 2, 0, 2, 3]),
    ];
}

function triangleGeometry(): Buffer[] {
    return [property('p', 'f', [-4, 0, -1, 4, 0, -1, 0, 0, 4]), property('tri', 'i', [0, 1, 2])];
}

/** One [mesh] node with its optional [material] shader. */
function meshNode(geometry: readonly Buffer[], shader?: string): Buffer[] {
    const parts = [object(3, 'mesh'), ...geometry];
    if (shader !== undefined) parts.push(object(4, 'material'), stringProperty('shader', shader));
    return parts;
}

function groupMesh(name: string, ...meshes: Buffer[][]): Buffer {
    return Buffer.concat([object(2, name), ...meshes.flat()]);
}

function quadFile(groupName: string, shader?: string): Buffer {
    return binaryMesh([object(1, 'object'), groupMesh(groupName, meshNode(quadGeometry(), shader))]);
}

function triangleFile(): Buffer {
    return binaryMesh([object(1, 'object'), groupMesh('hullShape', meshNode(triangleGeometry(), 'PdxMeshShip'))]);
}

function frameAt(width: number, height: number, rgba: readonly [number, number, number, number]): RgbaImage {
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        pixels.set(rgba, index * 4);
    }
    return { width, height, pixels };
}

function hasPixel(image: RgbaImage, rgba: readonly [number, number, number, number]): boolean {
    for (let index = 0; index < image.width * image.height; index++) {
        const offset = index * 4;
        if (
            image.pixels[offset] === rgba[0] &&
            image.pixels[offset + 1] === rgba[1] &&
            image.pixels[offset + 2] === rgba[2] &&
            image.pixels[offset + 3] === rgba[3]
        ) {
            return true;
        }
    }
    return false;
}

describe('ship icon mesh geometry', () => {
    it('reads vertices and triangles from a binary pdxmesh', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(quadFile('hullShape', 'PdxMeshShip')));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
        expect(mesh!.indices.length).to.equal(6);
        expect([...mesh!.indices]).to.deep.equal([0, 1, 2, 0, 2, 3]);
        expect(mesh!.positions[0]).to.be.closeTo(-5, 1e-5);
        expect(mesh!.positions[11]).to.be.closeTo(2, 1e-5);
    });

    it('decodes little-endian float coordinates exactly', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode([
                    property('p', 'f', [0.1, 1234.5, -0.25, 1e-3, -7, 42.125, 0, 0, 0]),
                    property('tri', 'i', [0, 1, 2]),
                ], 'PdxMeshShip'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions[0]).to.be.closeTo(0.1, 1e-6);
        expect(mesh!.positions[1]).to.be.closeTo(1234.5, 1e-3);
        expect(mesh!.positions[2]).to.be.closeTo(-0.25, 1e-6);
        expect(mesh!.positions[3]).to.be.closeTo(1e-3, 1e-9);
        expect(mesh!.positions[4]).to.be.closeTo(-7, 1e-5);
        expect(mesh!.positions[5]).to.be.closeTo(42.125, 1e-4);
    });

    it('keeps the geometry of separate mesh nodes separate', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode([property('p', 'f', [-5, 0, -2, 5, 0, -2, 5, 0, 2]), property('tri', 'i', [0, 1, 2])], 'PdxMeshShip'),
                meshNode([property('p', 'f', [-1, 0, -1, 1, 0, -1, 1, 0, 1]), property('tri', 'i', [0, 1, 2])], 'PdxMeshShip'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(18);
        expect([...mesh!.indices]).to.deep.equal([0, 1, 2, 3, 4, 5]);
    });

    it('skips physics collision proxies by shader, ignoring case and the trailing NUL', () => {
        for (const shader of ['Collision', 'collision', 'COLLISION', 'Collision\0']) {
            const mixed = readPdxMeshGeometry(arrayBuffer(binaryMesh([
                object(1, 'object'),
                groupMesh('hullShape', meshNode(quadGeometry(), 'PdxMeshShip')),
                groupMesh('c_bodyShape', meshNode([
                    property('p', 'f', [-8, 0, -8, 8, 0, -8, 8, 0, 8, -8, 0, 8]),
                    property('tri', 'i', [0, 1, 2, 0, 2, 3]),
                ], shader)),
            ])));
            expect(mixed, shader).not.to.equal(undefined);
            expect(mixed!.positions.length, shader).to.equal(12);
            expect(mixed!.indices.length, shader).to.equal(6);
        }
    });

    it('keeps submeshes whose shader is not the collision proxy', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode(quadGeometry(), 'PdxMeshShip'),
                meshNode(triangleGeometry(), 'PdxMeshCollision2'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(21);
    });

    it('keeps submeshes that carry no material block at all', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(quadFile('hullShape')));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
    });

    it('drops alpha and additive effect submeshes when visible geometry exists', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode(triangleGeometry(), 'PdxMeshShip'),
                meshNode(quadGeometry(), 'AlphaBlend_00'),
                meshNode(quadGeometry(), 'PdxMeshAlphaAdditiveAnimateUV'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(9);
        expect(mesh!.indices.length).to.equal(3);
        expect([...mesh!.indices]).to.deep.equal([0, 1, 2]);
    });

    it('falls back to effect submeshes when the model has nothing else to draw', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('hullShape', meshNode(quadGeometry(), 'AlphaBlend_00')),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
        expect(mesh!.indices.length).to.equal(6);
    });

    it('keeps PdxMeshShipDiffuseEmissive while dropping PdxMeshAlphaBlend', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode(quadGeometry(), 'PdxMeshShipDiffuseEmissive'),
                meshNode(triangleGeometry(), 'PdxMeshAlphaBlend'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
        expect(mesh!.indices.length).to.equal(6);
    });

    it('treats alphablend case variants as effects but keeps them for an effect-only model', () => {
        for (const shader of ['AlphaBlend_00', 'alphablend_00', 'ALPHABLEND_00']) {
            const mixed = readPdxMeshGeometry(arrayBuffer(binaryMesh([
                object(1, 'object'),
                groupMesh(
                    'hullShape',
                    meshNode(triangleGeometry(), 'PdxMeshShip'),
                    meshNode(quadGeometry(), shader),
                ),
            ])));
            expect(mixed!.positions.length, shader).to.equal(9);
            const onlyEffect = readPdxMeshGeometry(arrayBuffer(quadFile('hullShape', shader)));
            expect(onlyEffect!.positions.length, shader).to.equal(12);
        }
    });

    it('keeps emissive shaders whose alpha suffix is not a blend or additive family', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh(
                'hullShape',
                meshNode(quadGeometry(), 'PdxMeshShipDiffuseEmissiveAlpha'),
                meshNode(triangleGeometry(), 'PdxMeshAlphaBlend'),
            ),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
    });

    it('ignores property blocks outside a mesh node', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('hullShape', meshNode(quadGeometry(), 'PdxMeshShip')),
            object(2, 'locator'),
            object(3, 'light_locator_01'),
            property('p', 'f', [1, 2, 3]),
            property('q', 'f', [0, 0, 0, 1]),
        ])));
        expect(mesh).not.to.equal(undefined);
        expect(mesh!.positions.length).to.equal(12);
    });

    it('skips glass, shadow and decal groups', () => {
        for (const group of ['GlassLens', 'ShadowBox', 'DecalPlane']) {
            expect(readPdxMeshGeometry(arrayBuffer(quadFile(group, 'PdxMeshShip')))).to.equal(undefined);
        }
        const mixed = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('GlassLens', meshNode(quadGeometry(), 'PdxMeshShip')),
            groupMesh('hullShape', meshNode(triangleGeometry(), 'PdxMeshShip')),
        ])));
        expect(mixed).not.to.equal(undefined);
        expect(mixed!.positions.length).to.equal(9);
        expect(mixed!.indices.length).to.equal(3);
    });

    it('drops mesh nodes with out-of-range indices', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('hullShape', meshNode([
                property('p', 'f', [-5, 0, -2, 5, 0, -2, 5, 0, 2]),
                property('tri', 'i', [0, 1, 3]),
            ], 'PdxMeshShip')),
        ])));
        expect(mesh).to.equal(undefined);
    });

    it('drops mesh nodes whose float count is not a multiple of three', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('hullShape', meshNode([
                property('p', 'f', [-5, 0, -2, 5]),
                property('tri', 'i', [0, 1, 2]),
            ], 'PdxMeshShip')),
        ])));
        expect(mesh).to.equal(undefined);
    });

    it('drops mesh nodes that have positions but no triangles', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(binaryMesh([
            object(1, 'object'),
            groupMesh('hullShape', meshNode([property('p', 'f', [-5, 0, -2, 5, 0, -2, 5, 0, 2])], 'PdxMeshShip')),
        ])));
        expect(mesh).to.equal(undefined);
    });

    it('rejects non-binary and empty input without throwing', () => {
        expect(readPdxMeshGeometry(arrayBuffer(Buffer.from('pdxasset file = "hull.obj"', 'latin1')))).to.equal(undefined);
        expect(readPdxMeshGeometry(arrayBuffer(Buffer.from('@@b@', 'latin1')))).to.equal(undefined);
        expect(readPdxMeshGeometry(new ArrayBuffer(0))).to.equal(undefined);
    });

    it('survives truncation at any offset without throwing', () => {
        const full = quadFile('hullShape', 'PdxMeshShip');
        for (const cut of [4, 6, 12]) {
            expect(readPdxMeshGeometry(arrayBuffer(full.subarray(0, cut)))).to.equal(undefined);
        }
        for (let cut = 0; cut <= full.byteLength; cut++) {
            let mesh: ReturnType<typeof readPdxMeshGeometry>;
            expect(() => {
                mesh = readPdxMeshGeometry(arrayBuffer(full.subarray(0, cut)));
            }).not.to.throw();
            if (!mesh) continue;
            expect(mesh.positions.length % 3).to.equal(0);
            expect(mesh.indices.length % 3).to.equal(0);
            const vertexCount = mesh.positions.length / 3;
            for (const index of mesh.indices) expect(index).to.be.lessThan(vertexCount);
        }
    });

    it('merges meshes with renumbered indices', () => {
        const first = readPdxMeshGeometry(arrayBuffer(quadFile('hullShape', 'PdxMeshShip')))!;
        const second = readPdxMeshGeometry(arrayBuffer(triangleFile()))!;
        const merged = mergeShipIconMeshes([first, second]);
        expect(merged).not.to.equal(undefined);
        expect(merged!.positions.length).to.equal(21);
        expect([...merged!.indices]).to.deep.equal([0, 1, 2, 0, 2, 3, 4, 5, 6]);
        expect(merged!.positions[12]).to.be.closeTo(-4, 1e-5);
        expect(mergeShipIconMeshes([])).to.equal(undefined);
        expect(mergeShipIconMeshes([{ positions: new Float32Array(0), indices: new Uint32Array(0) }])).to.equal(undefined);
    });
});

/**
 * Vanilla ship_sizes_top.dds, sampled per pixel on the 80x40 cell of frame 6: the interior
 * gradient runs (40,58,53) -> (17,27,24), the 1px border ring and the glow share (55,105,84).
 */
const VANILLA_NORMAL = {
    panelTop: [40, 58, 53],
    panelBottom: [17, 27, 24],
    silhouette: [9, 9, 9],
    accent: [55, 105, 84],
} as const;
/**
 * Vanilla ship_sizes_top_damaged.dds, same cell: the interior gradient runs
 * (60,16,16) -> (27,7,7), the border ring and the glow share (99,26,26).
 */
const VANILLA_DAMAGED = {
    panelTop: [60, 16, 16],
    panelBottom: [27, 7, 7],
    silhouette: [11, 3, 3],
    accent: [99, 26, 26],
} as const;

/**
 * Measured cell geometry: a transparent column at each horizontal edge, then the 1px border
 * ring, so the gradient covers x=2..77 and y=1..38. The outermost rows are border, not margin.
 */
const CELL = { width: 80, height: 40, margin: 1, border: 1 } as const;
const INTERIOR = {
    firstColumn: CELL.margin + CELL.border,
    lastColumn: CELL.width - 1 - (CELL.margin + CELL.border),
    firstRow: CELL.border,
    lastRow: CELL.height - 1 - CELL.border,
    rows: CELL.height - 1 - CELL.border - CELL.border + 1,
} as const;

function quad(): ReturnType<typeof readPdxMeshGeometry> {
    return readPdxMeshGeometry(arrayBuffer(quadFile('hullShape', 'PdxMeshShip')));
}

function pixelAt(image: RgbaImage, x: number, y: number): number[] {
    const offset = (y * image.width + x) * 4;
    return [
        image.pixels[offset] ?? 0,
        image.pixels[offset + 1] ?? 0,
        image.pixels[offset + 2] ?? 0,
        image.pixels[offset + 3] ?? 0,
    ];
}

function countColour(image: RgbaImage, rgba: readonly [number, number, number, number]): number {
    let count = 0;
    for (let index = 0; index < image.width * image.height; index++) {
        const offset = index * 4;
        if (image.pixels[offset] === rgba[0] && image.pixels[offset + 1] === rgba[1] &&
            image.pixels[offset + 2] === rgba[2] && image.pixels[offset + 3] === rgba[3]) {
            count++;
        }
    }
    return count;
}

function alphaChannel(image: RgbaImage): number[] {
    const alphas: number[] = [];
    for (let index = 3; index < image.pixels.length; index += 4) alphas.push(image.pixels[index] ?? 0);
    return alphas;
}

/** One flag per pixel: is the pixel an opaque hull pixel of the given colour? */
function hullMask(image: RgbaImage, hull: readonly [number, number, number]): boolean[] {
    const mask: boolean[] = [];
    for (let index = 0; index < image.width * image.height; index++) {
        const offset = index * 4;
        mask.push(
            image.pixels[offset] === hull[0] &&
            image.pixels[offset + 1] === hull[1] &&
            image.pixels[offset + 2] === hull[2] &&
            image.pixels[offset + 3] === 255,
        );
    }
    return mask;
}

/**
 * The row colour the measured gradient must produce, recomputed here with integer
 * interpolation on purpose: the assertion must not call the renderer's own helper.
 */
function gradientRow(
    palette: { readonly panelTop: readonly number[]; readonly panelBottom: readonly number[] },
    y: number,
    firstRow: number,
    rows: number,
): number[] {
    const row = Math.min(rows - 1, Math.max(0, y - firstRow));
    const interpolate = (index: number): number => {
        const top = palette.panelTop[index] ?? 0;
        const bottom = palette.panelBottom[index] ?? 0;
        if (rows <= 1) return top;
        return top + Math.round(((bottom - top) * row) / (rows - 1));
    };
    return [interpolate(0), interpolate(1), interpolate(2)];
}

function channelDistance(pixel: readonly number[], target: readonly [number, number, number]): number {
    return Math.abs((pixel[0] ?? 0) - target[0]) +
        Math.abs((pixel[1] ?? 0) - target[1]) +
        Math.abs((pixel[2] ?? 0) - target[2]);
}

describe('ship icon frame rendering', () => {
    it('exposes the documented defaults', () => {
        expect(DEFAULT_SHIP_ICON_STYLE.cellWidth).to.equal(80);
        expect(DEFAULT_SHIP_ICON_STYLE.cellHeight).to.equal(40);
        expect(DEFAULT_SHIP_ICON_STYLE.supersampling).to.equal(5);
        expect(DEFAULT_SHIP_ICON_STYLE.padding).to.equal(1);
        expect(DEFAULT_SHIP_ICON_STYLE.fill).to.be.closeTo(0.96, 1e-9);
        expect(DEFAULT_SHIP_ICON_STYLE.glow).to.equal(true);
        expect(DEFAULT_SHIP_ICON_STYLE.background).to.equal('panel');
        expect(DEFAULT_SHIP_ICON_STYLE.damaged).to.equal(false);
        expect({ ...DEFAULT_SHIP_ICON_STYLE.normalPalette }).to.deep.equal({ ...VANILLA_NORMAL });
        expect({ ...DEFAULT_SHIP_ICON_STYLE.damagedPalette }).to.deep.equal({ ...VANILLA_DAMAGED });
    });

    it('paints the measured vanilla cell frame around an empty grid', () => {
        const empty = renderShipIconFrame(undefined);
        expect(empty.width).to.equal(CELL.width);
        expect(empty.height).to.equal(CELL.height);
        expect(empty.pixels.length).to.equal(CELL.width * CELL.height * 4);

        // A fully transparent 1px margin on both horizontal edges, carrying no colour at all.
        for (let y = 0; y < empty.height; y++) {
            expect(pixelAt(empty, 0, y), `margin x=0 y=${y}`).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(empty, CELL.width - 1, y), `margin x=${CELL.width - 1} y=${y}`).to.deep.equal([0, 0, 0, 0]);
        }

        // The 1px border ring just inside the margin is the accent colour, fully opaque.
        for (let y = 0; y < empty.height; y++) {
            expect(pixelAt(empty, 1, y), `left border y=${y}`).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
            expect(pixelAt(empty, CELL.width - 2, y), `right border y=${y}`).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        }
        // The outermost rows are border too, not margin: that is why the vertical axis has none.
        for (let x = 1; x < CELL.width - 1; x++) {
            expect(pixelAt(empty, x, 0), `top border x=${x}`).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
            expect(pixelAt(empty, x, CELL.height - 1), `bottom border x=${x}`).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        }

        // Inside the border: the gradient, bright at the top and dark at the bottom.
        expect(pixelAt(empty, 40, INTERIOR.firstRow)).to.deep.equal([...VANILLA_NORMAL.panelTop, 255]);
        expect(pixelAt(empty, 40, INTERIOR.lastRow)).to.deep.equal([...VANILLA_NORMAL.panelBottom, 255]);
        for (let y = INTERIOR.firstRow; y <= INTERIOR.lastRow; y++) {
            const expected = gradientRow(VANILLA_NORMAL, y, INTERIOR.firstRow, INTERIOR.rows);
            expect(pixelAt(empty, INTERIOR.firstColumn, y), `left interior column y=${y}`).to.deep.equal([...expected, 255]);
            expect(pixelAt(empty, 40, y), `middle interior column y=${y}`).to.deep.equal([...expected, 255]);
            expect(pixelAt(empty, INTERIOR.lastColumn, y), `right interior column y=${y}`).to.deep.equal([...expected, 255]);
        }
        // Concretely: the measured rows y=3 and y=36 sit at the bright and the dark end.
        const bright = pixelAt(empty, 40, 3);
        const dark = pixelAt(empty, 40, 36);
        expect(bright[0] ?? 0).to.be.greaterThan(dark[0] ?? 0);
        expect(bright[1] ?? 0).to.be.greaterThan(dark[1] ?? 0);
        expect(bright[2] ?? 0).to.be.greaterThan(dark[2] ?? 0);
        expect(dark[0]).to.be.greaterThan(VANILLA_NORMAL.panelBottom[0] - 2);
        expect(dark[0]).to.be.lessThan(VANILLA_NORMAL.panelTop[0]);
    });

    it('keeps the damaged frame decoration in place and only changes the colours', () => {
        const normal = renderShipIconFrame(undefined);
        const damaged = renderShipIconFrame(undefined, { damaged: true });
        expect(alphaChannel(damaged), 'the margin stays transparent').to.deep.equal(alphaChannel(normal));
        for (let y = 0; y < damaged.height; y++) {
            expect(pixelAt(damaged, 0, y)).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(damaged, CELL.width - 1, y)).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(damaged, 1, y)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
            expect(pixelAt(damaged, CELL.width - 2, y)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
        }
        for (let x = 1; x < damaged.width - 1; x++) {
            expect(pixelAt(damaged, x, 0)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
            expect(pixelAt(damaged, x, CELL.height - 1)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
        }
        expect(pixelAt(damaged, 40, INTERIOR.firstRow)).to.deep.equal([...VANILLA_DAMAGED.panelTop, 255]);
        expect(pixelAt(damaged, 40, INTERIOR.lastRow)).to.deep.equal([...VANILLA_DAMAGED.panelBottom, 255]);
        for (let y = INTERIOR.firstRow; y <= INTERIOR.lastRow; y++) {
            const expected = gradientRow(VANILLA_DAMAGED, y, INTERIOR.firstRow, INTERIOR.rows);
            expect(pixelAt(damaged, 40, y)).to.deep.equal([...expected, 255]);
        }
        expect(Buffer.from(normal.pixels).equals(Buffer.from(damaged.pixels))).to.equal(false);
    });

    it('drops the margin and the border on a cell too small to hold them', () => {
        for (const [width, height] of [[4, 4], [6, 20], [80, 6], [6, 40]] as const) {
            const label = `${width}x${height}`;
            const frame = renderShipIconFrame(undefined, { cellWidth: width, cellHeight: height });
            expect(frame.width, label).to.equal(width);
            expect(frame.height, label).to.equal(height);
            for (let y = 0; y < height; y++) {
                const expected = gradientRow(VANILLA_NORMAL, y, 0, height);
                for (let x = 0; x < width; x++) {
                    // The gradient spans the whole cell, so no pixel of it is transparent.
                    expect(pixelAt(frame, x, y), `${label} x=${x} y=${y}`).to.deep.equal([...expected, 255]);
                }
            }
            const bare = renderShipIconFrame(undefined, {
                cellWidth: width,
                cellHeight: height,
                background: 'transparent',
            });
            expect(alphaChannel(bare).every((alpha) => alpha === 0), `${label} stays empty`).to.equal(true);
        }

        // The decoration starts at 8px, where margin, border and a 4x6 interior all still fit.
        const smallest = renderShipIconFrame(undefined, { cellWidth: 8, cellHeight: 8 });
        for (let y = 0; y < 8; y++) {
            expect(pixelAt(smallest, 0, y)).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(smallest, 7, y)).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(smallest, 1, y)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        }
        // The border rows stop where the margin columns start.
        for (let x = 1; x < 7; x++) {
            expect(pixelAt(smallest, x, 0)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
            expect(pixelAt(smallest, x, 7)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        }
        expect(pixelAt(smallest, 3, 1)).to.deep.equal([...VANILLA_NORMAL.panelTop, 255]);
        expect(pixelAt(smallest, 3, 6)).to.deep.equal([...VANILLA_NORMAL.panelBottom, 255]);
    });

    it('keeps the margin transparent and everything else opaque when the hull is drawn', () => {
        const frame = renderShipIconFrame(quad());
        for (let y = 0; y < frame.height; y++) {
            for (let x = 0; x < frame.width; x++) {
                const onMargin = x < CELL.margin || x >= CELL.width - CELL.margin;
                const pixel = pixelAt(frame, x, y);
                if (onMargin) {
                    // The glow may spill over the border ring, but never into the margin.
                    expect(pixel, `margin x=${x} y=${y}`).to.deep.equal([0, 0, 0, 0]);
                    continue;
                }
                expect(pixel[3], `panel x=${x} y=${y}`).to.equal(255);
            }
        }
        expect(countColour(frame, [...VANILLA_NORMAL.silhouette, 255])).to.be.greaterThan(0);
        // The glow changes colours inside the margin-less area only, never the alpha map.
        const plain = renderShipIconFrame(quad(), { glow: false });
        expect(alphaChannel(plain)).to.deep.equal(alphaChannel(frame));
        // Disabling the glow leaves the border rows pure accent wherever the hull is absent.
        expect(pixelAt(plain, 1, 0)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        expect(pixelAt(plain, 40, 0)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        expect(pixelAt(plain, 40, CELL.height - 1)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
    });

    it('leaves the background transparent when the style asks for it', () => {
        const frame = renderShipIconFrame(quad(), { background: 'transparent' });
        let clear = 0;
        let glow = 0;
        let opaqueNotHull = 0;
        let paintedClear = 0;
        // Without the glow the empty background must really be empty: no panel is painted.
        const bare = renderShipIconFrame(quad(), { background: 'transparent', glow: false });
        let bareClear = 0;
        let barePainted = 0;
        for (let index = 0; index < bare.width * bare.height; index++) {
            const offset = index * 4;
            if (bare.pixels[offset + 3] !== 0) continue;
            bareClear++;
            if (bare.pixels[offset] !== 0 || bare.pixels[offset + 1] !== 0 || bare.pixels[offset + 2] !== 0) {
                barePainted++;
            }
        }
        expect(bareClear, 'the background outside the hull is empty').to.be.greaterThan(0);
        expect(barePainted, 'and it carries no colour').to.equal(0);
        for (let index = 0; index < frame.width * frame.height; index++) {
            const offset = index * 4;
            const alpha = frame.pixels[offset + 3] ?? 0;
            const red = frame.pixels[offset] ?? 0;
            const green = frame.pixels[offset + 1] ?? 0;
            const blue = frame.pixels[offset + 2] ?? 0;
            if (alpha === 0) {
                clear++;
                if (red !== 0 || green !== 0 || blue !== 0) paintedClear++;
                continue;
            }
            if (alpha === 255) {
                if (red !== VANILLA_NORMAL.silhouette[0] || green !== VANILLA_NORMAL.silhouette[1] ||
                    blue !== VANILLA_NORMAL.silhouette[2]) {
                    opaqueNotHull++;
                }
                continue;
            }
            if (red !== VANILLA_NORMAL.accent[0] || green !== VANILLA_NORMAL.accent[1] ||
                blue !== VANILLA_NORMAL.accent[2]) {
                opaqueNotHull++;
                continue;
            }
            glow++;
        }
        expect(paintedClear, 'a transparent pixel carries no colour').to.equal(0);
        expect(clear + glow, 'the cell classifies into glow and hull only').to.be.greaterThan(0);
        expect(opaqueNotHull, 'only the hull is opaque, only the accent glows').to.equal(0);
        expect(glow).to.be.greaterThan(0);
    });

    it('draws the near-black vanilla silhouette for both palettes', () => {
        const normal = renderShipIconFrame(quad());
        const damaged = renderShipIconFrame(quad(), { damaged: true });
        expect(countColour(normal, [...VANILLA_NORMAL.silhouette, 255])).to.be.greaterThan(0);
        expect(countColour(damaged, [...VANILLA_DAMAGED.silhouette, 255])).to.be.greaterThan(0);
        expect(countColour(normal, [...VANILLA_DAMAGED.silhouette, 255]), 'the damaged hull is not in the intact frame').to.equal(0);
        expect(hasPixel(normal, [0, 0, 0, 255]), 'the hull is near-black, not pure black').to.equal(false);
    });

    it('swaps only the palette for a damaged frame', () => {
        const normal = renderShipIconFrame(quad());
        const damaged = renderShipIconFrame(quad(), { damaged: true });
        expect(alphaChannel(normal), 'the alpha distribution is unchanged').to.deep.equal(alphaChannel(damaged));
        expect(hullMask(damaged, VANILLA_DAMAGED.silhouette), 'the same pixels are hull pixels')
            .to.deep.equal(hullMask(normal, VANILLA_NORMAL.silhouette));

        // Both frames keep an empty margin and carry their own accent on the border ring.
        const normalPlain = renderShipIconFrame(quad(), { glow: false });
        const damagedPlain = renderShipIconFrame(quad(), { glow: false, damaged: true });
        for (const plain of [normalPlain, damagedPlain]) {
            expect(pixelAt(plain, 0, 20)).to.deep.equal([0, 0, 0, 0]);
            expect(pixelAt(plain, CELL.width - 1, 20)).to.deep.equal([0, 0, 0, 0]);
        }
        expect(pixelAt(normalPlain, 40, 0)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        expect(pixelAt(damagedPlain, 40, 0)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
        expect(pixelAt(normalPlain, CELL.width - 2, 20)).to.deep.equal([...VANILLA_NORMAL.accent, 255]);
        expect(pixelAt(damagedPlain, CELL.width - 2, 20)).to.deep.equal([...VANILLA_DAMAGED.accent, 255]);
        expect(Buffer.from(normal.pixels).equals(Buffer.from(damaged.pixels))).to.equal(false);

        expect(alphaChannel(renderShipIconFrame(quad(), { background: 'transparent' })))
            .to.deep.equal(alphaChannel(renderShipIconFrame(quad(), { damaged: true, background: 'transparent' })));
    });

    it('composites the glow outside the hull, never over it', () => {
        const frame = renderShipIconFrame(quad());
        const plain = renderShipIconFrame(quad(), { glow: false });
        const hull = hullMask(frame, VANILLA_NORMAL.silhouette);
        let changed = 0;
        let changedInsideHull = 0;
        let accentDominant = 0;
        for (let index = 0; index < frame.width * frame.height; index++) {
            const offset = index * 4;
            const differs =
                frame.pixels[offset] !== plain.pixels[offset] ||
                frame.pixels[offset + 1] !== plain.pixels[offset + 1] ||
                frame.pixels[offset + 2] !== plain.pixels[offset + 2];
            if (!differs) continue;
            changed++;
            if (hull[index] === true) {
                changedInsideHull++;
                continue;
            }
            const pixel = pixelAt(frame, index % frame.width, Math.floor(index / frame.width));
            const plainPixel = pixelAt(plain, index % plain.width, Math.floor(index / plain.width));
            // The interior gradient can be darker than the accent, so the check is the
            // direction the glow moved the pixel in, not which end it is nearer to.
            if (channelDistance(pixel, VANILLA_NORMAL.accent) < channelDistance(plainPixel, VANILLA_NORMAL.accent)) {
                accentDominant++;
            }
        }
        expect(changed, 'the glow paints something').to.be.greaterThan(0);
        expect(changedInsideHull, 'the hull is not blended over').to.equal(0);
        expect(accentDominant, 'the glow pulls the pixel towards the accent').to.equal(changed);
    });

    it('is byte-for-byte deterministic for identical input', () => {
        const first = renderShipIconFrame(quad());
        const second = renderShipIconFrame(quad());
        expect(Buffer.from(first.pixels).equals(Buffer.from(second.pixels))).to.equal(true);
        const damagedA = renderShipIconFrame(quad(), { damaged: true });
        const damagedB = renderShipIconFrame(quad(), { damaged: true });
        expect(Buffer.from(damagedA.pixels).equals(Buffer.from(damagedB.pixels))).to.equal(true);
        const alsoDamaged = renderShipIconFrame(quad(), { damaged: true, background: 'transparent' });
        const alsoDamagedB = renderShipIconFrame(quad(), { damaged: true, background: 'transparent' });
        expect(Buffer.from(alsoDamaged.pixels).equals(Buffer.from(alsoDamagedB.pixels))).to.equal(true);
    });
});

/**
 * An axis-aligned box: the smallest mesh that has a real extent on all three axes, so the
 * projection axis choice becomes observable instead of collapsing onto one plane.
 */
function boxMesh(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
): ShipIconMesh {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const positions = Float32Array.from([
        x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
        x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1,
    ]);
    const indices = Uint32Array.from([
        0, 1, 2, 0, 2, 3,
        4, 6, 5, 4, 7, 6,
        0, 4, 5, 0, 5, 1,
        1, 5, 6, 1, 6, 2,
        2, 6, 7, 2, 7, 3,
        3, 7, 4, 3, 4, 0,
    ]);
    return { positions, indices };
}

/** Width and height of the drawn hull, measured on its opaque silhouette pixels. */
function silhouetteBounds(image: RgbaImage): { width: number; height: number } {
    const hull = VANILLA_NORMAL.silhouette;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < image.width * image.height; index++) {
        const offset = index * 4;
        if (image.pixels[offset + 3] !== 255) continue;
        if (image.pixels[offset] !== hull[0] || image.pixels[offset + 1] !== hull[1] ||
            image.pixels[offset + 2] !== hull[2]) continue;
        const x = index % image.width;
        const y = Math.floor(index / image.width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (minX > maxX || minY > maxY) return { width: 0, height: 0 };
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Stellaris models are Y-up, so an icon always looks straight down onto the X/Z plane. The
 * smallest bounding-box axis is no substitute: on a hull that is long in Y it picks X and the
 * icon becomes a side view. It survives only as the fallback for a hull that is flat in Y.
 */
describe('ship icon projection axis', () => {
    it('looks down on a hull that is longest in Y instead of showing a side view', () => {
        // x 2, y 10, z 4: the smallest bounding-box axis is X, so the old rule projected onto
        // the Y/Z plane and drew the 10:4 side view. Y-up projects onto X/Z: the 4:2 footprint.
        const bounds = silhouetteBounds(renderShipIconFrame(boxMesh([-1, -5, -2], [1, 5, 2])));
        expect(bounds.width, `bbox ${bounds.width}x${bounds.height}`).to.be.greaterThan(bounds.height);
        const aspect = bounds.width / Math.max(1, bounds.height);
        // 2 is the X/Z footprint; the Y/Z side view would land near 2.5 instead.
        expect(aspect, `bbox ${bounds.width}x${bounds.height}`).to.be.greaterThan(1.8);
        expect(aspect, `bbox ${bounds.width}x${bounds.height}`).to.be.lessThan(2.3);
    });

    it('keeps a hull that is shallow in Y on the Y-up plane as well', () => {
        // x 10, y 0.5, z 4: still Y-up, and the Y extent is right at the threshold, so the
        // smallest-axis fallback would pick Y too -- the footprint must stay the X/Z rectangle.
        const bounds = silhouetteBounds(renderShipIconFrame(boxMesh([-5, -0.25, -2], [5, 0.25, 2])));
        expect(bounds.width, `bbox ${bounds.width}x${bounds.height}`).to.be.greaterThan(bounds.height);
    });

    it('falls back to the flattest axis, without failing, when the hull is flat in Y', () => {
        // y is identically zero, as on a sheet: Y carries no height, so the old heuristic runs.
        const frame = renderShipIconFrame(boxMesh([-5, 0, -2], [5, 0, 2]));
        const bounds = silhouetteBounds(frame);
        expect(bounds.width, 'the flat hull is still drawn').to.be.greaterThan(0);
        expect(bounds.height, 'the flat hull is still drawn').to.be.greaterThan(0);
        expect(bounds.width).to.be.greaterThan(bounds.height);
    });
});

describe('ship icon sheet composition', () => {
    it('concatenates frames horizontally using the tallest height', () => {
        const first = frameAt(8, 4, [10, 20, 30, 255]);
        const second = frameAt(6, 2, [1, 2, 3, 255]);
        const sheet = composeHorizontalSheet([first, second]);
        expect(sheet.width).to.equal(14);
        expect(sheet.height).to.equal(4);
        expect(sheet.pixels.length).to.equal(14 * 4 * 4);
        expect([...sheet.pixels.subarray(0, 4)]).to.deep.equal([10, 20, 30, 255]);
        expect([...sheet.pixels.subarray(8 * 4, 8 * 4 + 4)]).to.deep.equal([1, 2, 3, 255]);
        const fillerRow = 3 * 14 * 4 + 8 * 4;
        expect([...sheet.pixels.subarray(fillerRow, fillerRow + 4)]).to.deep.equal([0, 0, 0, 0]);
    });

    it('pads the sheet with transparent frames of the first width', () => {
        const sheet = composeHorizontalSheet([frameAt(8, 4, [9, 9, 9, 255])], 3);
        expect(sheet.width).to.equal(24);
        expect(sheet.height).to.equal(4);
        const secondSlot = 8 * 4;
        expect([...sheet.pixels.subarray(secondSlot, secondSlot + 4)]).to.deep.equal([0, 0, 0, 0]);
    });

    it('returns a zero-width image instead of failing on empty input', () => {
        const empty = composeHorizontalSheet([]);
        expect(empty.width).to.equal(0);
        expect(empty.height).to.equal(0);
        expect(empty.pixels.length).to.equal(0);
        const padded = composeHorizontalSheet([], 4);
        expect(padded.width).to.equal(0);
        expect(padded.pixels.length).to.equal(0);
    });
});

describe('ship icon DDS encoding', () => {
    it('writes the documented ARGB8888 header', () => {
        const frame = frameAt(3, 2, [0x11, 0x22, 0x33, 0x44]);
        const out = encodeDdsArgb8888(frame);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        expect(String.fromCharCode(...out.subarray(0, 4))).to.equal('DDS ');
        expect(view.getUint32(4, true)).to.equal(124);
        expect(view.getUint32(8, true)).to.equal(0x1007);
        expect(view.getUint32(12, true)).to.equal(2);
        expect(view.getUint32(16, true)).to.equal(3);
        expect(view.getUint32(20, true)).to.equal(12);
        expect(view.getUint32(24, true)).to.equal(0);
        expect(view.getUint32(28, true)).to.equal(0);
        for (let offset = 32; offset < 76; offset += 4) expect(view.getUint32(offset, true)).to.equal(0);
        expect(view.getUint32(76, true)).to.equal(32);
        expect(view.getUint32(80, true)).to.equal(0x41);
        expect(view.getUint32(84, true)).to.equal(0);
        expect(view.getUint32(88, true)).to.equal(32);
        expect(view.getUint32(92, true)).to.equal(0x00ff0000);
        expect(view.getUint32(96, true)).to.equal(0x0000ff00);
        expect(view.getUint32(100, true)).to.equal(0x000000ff);
        expect(view.getUint32(104, true)).to.equal(0xff000000);
        expect(view.getUint32(108, true)).to.equal(0x1000);
        expect(view.getUint32(112, true)).to.equal(0);
        expect(view.getUint32(116, true)).to.equal(0);
        expect(view.getUint32(120, true)).to.equal(0);
        expect(view.getUint32(124, true)).to.equal(0);
    });

    it('writes BGRA bytes and the exact total length', () => {
        const out = encodeDdsArgb8888(frameAt(3, 2, [0x11, 0x22, 0x33, 0x44]));
        expect(out.length).to.equal(128 + 3 * 2 * 4);
        expect([...out.subarray(128, 132)]).to.deep.equal([0x33, 0x22, 0x11, 0x44]);
        const last = 128 + 3 * 2 * 4 - 4;
        expect([...out.subarray(last)]).to.deep.equal([0x33, 0x22, 0x11, 0x44]);
    });

    it('throws on programmer errors', () => {
        expect(() => encodeDdsArgb8888({ width: 0, height: 4, pixels: new Uint8Array(0) })).to.throw(Error);
        expect(() => encodeDdsArgb8888({ width: 4, height: -1, pixels: new Uint8Array(0) })).to.throw(Error);
        expect(() => encodeDdsArgb8888({ width: 4, height: 4, pixels: new Uint8Array(16) })).to.throw(Error);
    });

    it('encodes a rendered frame end to end', () => {
        const mesh = readPdxMeshGeometry(arrayBuffer(triangleFile()));
        const frame = renderShipIconFrame(mesh);
        const sheet = composeHorizontalSheet([frame, frame]);
        const out = encodeDdsArgb8888(sheet);
        expect(out.length).to.equal(128 + 160 * 40 * 4);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        expect(view.getUint32(12, true)).to.equal(40);
        expect(view.getUint32(16, true)).to.equal(160);
        expect(view.getUint32(20, true)).to.equal(640);
    });
});