/**
 * DDS texture decoder for Stellaris/Paradox game assets.
 * Supports: DXT1 (BC1), DXT3 (BC2), DXT5 (BC3), BC4 (single-channel), BC5 (normal map), BC7,
 * and uncompressed BGRA/BGR/Luminance.
 * Uses only Node.js built-in modules.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

const DDS_MAGIC = 0x20534444;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_ALPHAPIXELS = 0x1;

const FOURCC_DXT1 = 0x31545844;
const FOURCC_DXT3 = 0x33545844;
const FOURCC_DXT5 = 0x35545844;
const FOURCC_DX10 = 0x30315844;

// DXGI formats for DX10 extended header
const DXGI_FORMAT_BC4_UNORM = 80;
const DXGI_FORMAT_BC4_SNORM = 81;
const DXGI_FORMAT_BC5_UNORM = 83;
const DXGI_FORMAT_BC5_SNORM = 84;
const DXGI_FORMAT_BC7_UNORM = 98;
const DXGI_FORMAT_BC7_UNORM_SRGB = 99;

// Max texture size for preview (larger textures are downscaled)
const MAX_TEX_DIM = 512;

export interface DdsResult {
    dataUri: string;
    width: number;
    height: number;
}

// ─── PNG Encoder ────────────────────────────────────────────────────────────

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
    const rowBytes = w * 4;
    const raw = Buffer.alloc((rowBytes + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (rowBytes + 1)] = 0; // filter: None
        const srcOff = y * rowBytes;
        for (let i = 0; i < rowBytes; i++) {
            raw[y * (rowBytes + 1) + 1 + i] = rgba[srcOff + i];
        }
    }
    const deflated = zlib.deflateSync(raw, { level: 4 });
    const chunks: Buffer[] = [];
    chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); // signature
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    chunks.push(pngChunk('IHDR', ihdr));
    chunks.push(pngChunk('IDAT', deflated));
    chunks.push(pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([tb, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0, 0);
    return Buffer.concat([len, tb, data, crc]);
}

const crcT: number[] = [];
for (let n = 0; n < 256; n++) {
    let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcT[n] = c;
}
function crc32(buf: Buffer): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcT[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return c ^ 0xFFFFFFFF;
}

// ─── Color Helpers ──────────────────────────────────────────────────────────

function rgb565(c: number): [number, number, number] {
    return [((c >> 11) & 0x1F) * 255 / 31 | 0, ((c >> 5) & 0x3F) * 255 / 63 | 0, (c & 0x1F) * 255 / 31 | 0];
}

function mix(a: number, b: number, wa: number, wb: number, d: number): number {
    return (a * wa + b * wb) / d | 0;
}

// ─── Block Decoders ─────────────────────────────────────────────────────────

function putPx(out: Uint8Array, off: number, r: number, g: number, b: number, a: number) {
    if (off >= 0 && off + 3 < out.length) {
        out[off] = r; out[off + 1] = g; out[off + 2] = b; out[off + 3] = a;
    }
}

function decodeDxt1(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    const c0r = view.getUint16(off, true), c1r = view.getUint16(off + 2, true);
    const bits = view.getUint32(off + 4, true);
    const c0 = rgb565(c0r), c1 = rgb565(c1r);
    const pal: [number, number, number, number][] = [
        [c0[0], c0[1], c0[2], 255],
        [c1[0], c1[1], c1[2], 255],
        c0r > c1r
            ? [mix(c0[0], c1[0], 2, 1, 3), mix(c0[1], c1[1], 2, 1, 3), mix(c0[2], c1[2], 2, 1, 3), 255]
            : [mix(c0[0], c1[0], 1, 1, 2), mix(c0[1], c1[1], 1, 1, 2), mix(c0[2], c1[2], 1, 1, 2), 255],
        c0r > c1r
            ? [mix(c0[0], c1[0], 1, 2, 3), mix(c0[1], c1[1], 1, 2, 3), mix(c0[2], c1[2], 1, 2, 3), 255]
            : [0, 0, 0, 0],
    ];
    for (let r = 0; r < 4; r++) {
        const py = oy + r;
        if (py >= h) continue;
        for (let c = 0; c < 4; c++) {
            const px = ox + c;
            if (px >= w) continue;
            const idx = (bits >> (2 * (4 * r + c))) & 3;
            putPx(out, (py * w + px) * 4, pal[idx][0], pal[idx][1], pal[idx][2], pal[idx][3]);
        }
    }
}

function decodeDxt5(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    const a0 = view.getUint8(off), a1 = view.getUint8(off + 1);
    let aBits = 0n;
    for (let i = 0; i < 6; i++) aBits |= BigInt(view.getUint8(off + 2 + i)) << BigInt(i * 8);
    const aLut: number[] = [a0, a1, 0, 0, 0, 0, 0, 0];
    if (a0 > a1) {
        for (let i = 2; i < 8; i++) aLut[i] = ((8 - i) * a0 + (i - 1) * a1) / 7 | 0;
    } else {
        for (let i = 2; i < 6; i++) aLut[i] = ((6 - i) * a0 + (i - 1) * a1) / 5 | 0;
        aLut[6] = 0; aLut[7] = 255;
    }

    const c0r = view.getUint16(off + 8, true), c1r = view.getUint16(off + 10, true);
    const bits = view.getUint32(off + 12, true);
    const c0 = rgb565(c0r), c1 = rgb565(c1r);
    const pal = [c0, c1,
        [mix(c0[0], c1[0], 2, 1, 3), mix(c0[1], c1[1], 2, 1, 3), mix(c0[2], c1[2], 2, 1, 3)] as [number, number, number],
        [mix(c0[0], c1[0], 1, 2, 3), mix(c0[1], c1[1], 1, 2, 3), mix(c0[2], c1[2], 1, 2, 3)] as [number, number, number],
    ];

    for (let r = 0; r < 4; r++) {
        const py = oy + r;
        if (py >= h) continue;
        for (let c = 0; c < 4; c++) {
            const px = ox + c;
            if (px >= w) continue;
            const pi = 4 * r + c;
            const ci = (bits >> (2 * pi)) & 3;
            const ai = Number((aBits >> BigInt(pi * 3)) & 7n);
            putPx(out, (py * w + px) * 4, pal[ci][0], pal[ci][1], pal[ci][2], aLut[ai]);
        }
    }
}

function decodeDxt3(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    const alphas: number[] = [];
    for (let i = 0; i < 8; i++) {
        const b = view.getUint8(off + i);
        alphas.push((b & 0x0F) * 17, (b >> 4) * 17);
    }
    const c0r = view.getUint16(off + 8, true), c1r = view.getUint16(off + 10, true);
    const bits = view.getUint32(off + 12, true);
    const c0 = rgb565(c0r), c1 = rgb565(c1r);
    const pal = [c0, c1,
        [mix(c0[0], c1[0], 2, 1, 3), mix(c0[1], c1[1], 2, 1, 3), mix(c0[2], c1[2], 2, 1, 3)] as [number, number, number],
        [mix(c0[0], c1[0], 1, 2, 3), mix(c0[1], c1[1], 1, 2, 3), mix(c0[2], c1[2], 1, 2, 3)] as [number, number, number],
    ];
    for (let r = 0; r < 4; r++) {
        const py = oy + r;
        if (py >= h) continue;
        for (let c = 0; c < 4; c++) {
            const px = ox + c;
            if (px >= w) continue;
            const pi = 4 * r + c;
            const ci = (bits >> (2 * pi)) & 3;
            putPx(out, (py * w + px) * 4, pal[ci][0], pal[ci][1], pal[ci][2], alphas[pi]);
        }
    }
}

// ─── BC4/BC5 Decoders ───────────────────────────────────────────────────────
// BC4: Single-channel block compression. Same alpha block encoding as DXT5.
// BC5: Two BC4 blocks — one for red, one for green. Blue is reconstructed for normal maps.

function decodeAlphaBlock(view: DataView, off: number): number[] {
    const a0 = view.getUint8(off), a1 = view.getUint8(off + 1);
    let aBits = 0n;
    for (let i = 0; i < 6; i++) aBits |= BigInt(view.getUint8(off + 2 + i)) << BigInt(i * 8);
    const lut: number[] = [a0, a1, 0, 0, 0, 0, 0, 0];
    if (a0 > a1) {
        for (let i = 2; i < 8; i++) lut[i] = ((8 - i) * a0 + (i - 1) * a1) / 7 | 0;
    } else {
        for (let i = 2; i < 6; i++) lut[i] = ((6 - i) * a0 + (i - 1) * a1) / 5 | 0;
        lut[6] = 0; lut[7] = 255;
    }
    const values: number[] = [];
    for (let i = 0; i < 16; i++) {
        const idx = Number((aBits >> BigInt(i * 3)) & 7n);
        values.push(lut[idx]);
    }
    return values;
}

function decodeBc4Block(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    const values = decodeAlphaBlock(view, off);
    for (let r = 0; r < 4; r++) {
        const py = oy + r;
        if (py >= h) continue;
        for (let c = 0; c < 4; c++) {
            const px = ox + c;
            if (px >= w) continue;
            const v = values[r * 4 + c];
            putPx(out, (py * w + px) * 4, v, v, v, 255);
        }
    }
}

function decodeBc5Block(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    const redValues = decodeAlphaBlock(view, off);
    const greenValues = decodeAlphaBlock(view, off + 8);
    for (let r = 0; r < 4; r++) {
        const py = oy + r;
        if (py >= h) continue;
        for (let c = 0; c < 4; c++) {
            const px = ox + c;
            if (px >= w) continue;
            const pi = r * 4 + c;
            const rv = redValues[pi];
            const gv = greenValues[pi];
            // Reconstruct blue for normal maps: b = sqrt(1 - r² - g²)
            const nx = (rv / 255) * 2 - 1;
            const ny = (gv / 255) * 2 - 1;
            const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
            const bv = Math.round((nz * 0.5 + 0.5) * 255);
            putPx(out, (py * w + px) * 4, rv, gv, bv, 255);
        }
    }
}

// ─── BC7 Decoder ────────────────────────────────────────────────────────────
// BC7 has 8 modes (0-7). Each 128-bit block starts with 1-8 mode bits.
// This is a simplified decoder that handles the most common modes used in Stellaris.

/** BC7 partition tables for 2-subset modes (subset count = 2, 64 entries) */
const BC7_PARTITION2: number[][] = [
    [0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1],[0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1],
    [0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1],[0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1],
    [0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1],
    [0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1],
    [0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1],
    [0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
    [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1],
    [0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1],[0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0],[0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0],
    [0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0],[0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0],
    [0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0],[0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1],
    [0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0],[0,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0],
    [0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0],[0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0],
    [0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0],[0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0],[0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0],
    [0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1],[0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1],
    [0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0],[0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0],
    [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],[0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0],
    [0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1],[0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1],
    [0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0],[0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0],
    [0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0],[0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0],
    [0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0],[0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
    [0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0],[0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0],
    [0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0],[0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0],
    [0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1],
    [0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0],[0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0],
    [0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1],[0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1],
    [0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1],[0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1],
    [0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1],[0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0],
    [0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0],[0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1],
];

class BC7BitReader {
    private data: DataView;
    private off: number;
    private bitPos = 0;

    constructor(data: DataView, off: number) {
        this.data = data;
        this.off = off;
    }

    read(bits: number): number {
        let val = 0;
        for (let i = 0; i < bits; i++) {
            const byteIdx = this.off + ((this.bitPos) >> 3);
            const bitIdx = (this.bitPos) & 7;
            if (byteIdx < this.data.byteLength) {
                val |= ((this.data.getUint8(byteIdx) >> bitIdx) & 1) << i;
            }
            this.bitPos++;
        }
        return val;
    }
}

function decodeBc7Block(view: DataView, off: number, out: Uint8Array, ox: number, oy: number, w: number, h: number) {
    if (off + 16 > view.byteLength) return;

    // Determine mode from leading bits
    const firstByte = view.getUint8(off);
    let mode = -1;
    for (let i = 0; i < 8; i++) {
        if (firstByte & (1 << i)) { mode = i; break; }
    }
    if (mode < 0 || mode > 7) {
        // Invalid or reserved mode — fill transparent
        for (let py = oy; py < oy + 4 && py < h; py++)
            for (let px = ox; px < ox + 4 && px < w; px++)
                putPx(out, (py * w + px) * 4, 0, 0, 0, 0);
        return;
    }

    const reader = new BC7BitReader(view, off);
    reader.read(mode + 1); // consume mode bits

    // Mode definitions: [numSubsets, partBits, rotBits, idxSelBit, colorBits, alphaBits, pBits, idxBits, idx2Bits]
    const MODES: number[][] = [
        [3, 4, 0, 0, 4, 0, 1, 3, 0],  // mode 0
        [2, 6, 0, 0, 6, 0, 1, 3, 0],  // mode 1
        [3, 6, 0, 0, 5, 0, 0, 2, 0],  // mode 2
        [2, 6, 0, 0, 7, 0, 1, 2, 0],  // mode 3
        [1, 0, 2, 1, 5, 6, 0, 2, 3],  // mode 4
        [1, 0, 2, 0, 7, 8, 0, 2, 2],  // mode 5
        [1, 0, 0, 0, 7, 7, 1, 4, 0],  // mode 6
        [2, 6, 0, 0, 5, 5, 1, 2, 0],  // mode 7
    ];

    const md = MODES[mode];
    const numSubsets = md[0];
    const partBits = md[1];
    const rotBits = md[2];
    const idxSelBit = md[3];
    const colorBits = md[4];
    const alphaBits = md[5];
    const hasPBits = md[6];
    const idxBits1 = md[7];
    const idxBits2 = md[8];
    const hasAlpha = alphaBits > 0;

    const partition = partBits > 0 ? reader.read(partBits) : 0;
    const rotation = rotBits > 0 ? reader.read(rotBits) : 0;
    const idxSel = idxSelBit > 0 ? reader.read(1) : 0;

    // Read endpoints: numSubsets * 2 endpoints, each with R, G, B, [A] components
    const numEndpoints = numSubsets * 2;
    const endR: number[] = [], endG: number[] = [], endB: number[] = [], endA: number[] = [];
    for (let i = 0; i < numEndpoints; i++) endR.push(reader.read(colorBits));
    for (let i = 0; i < numEndpoints; i++) endG.push(reader.read(colorBits));
    for (let i = 0; i < numEndpoints; i++) endB.push(reader.read(colorBits));
    if (hasAlpha) {
        for (let i = 0; i < numEndpoints; i++) endA.push(reader.read(alphaBits));
    } else {
        for (let i = 0; i < numEndpoints; i++) endA.push((1 << colorBits) - 1);
    }

    // P-bits
    if (hasPBits) {
        if (mode === 1) {
            // Shared p-bits (one per subset)
            for (let s = 0; s < numSubsets; s++) {
                const pb = reader.read(1);
                for (let e = 0; e < 2; e++) {
                    const idx = s * 2 + e;
                    endR[idx] = (endR[idx] << 1) | pb;
                    endG[idx] = (endG[idx] << 1) | pb;
                    endB[idx] = (endB[idx] << 1) | pb;
                    if (hasAlpha) endA[idx] = (endA[idx] << 1) | pb;
                }
            }
        } else {
            // Unique p-bits (one per endpoint)
            for (let i = 0; i < numEndpoints; i++) {
                const pb = reader.read(1);
                endR[i] = (endR[i] << 1) | pb;
                endG[i] = (endG[i] << 1) | pb;
                endB[i] = (endB[i] << 1) | pb;
                if (hasAlpha) endA[i] = (endA[i] << 1) | pb;
            }
        }
    }

    // Expand endpoints to 8 bits
    const cPrec = colorBits + (hasPBits ? 1 : 0);
    const aPrec = (hasAlpha ? alphaBits : colorBits) + (hasPBits ? 1 : 0);
    for (let i = 0; i < numEndpoints; i++) {
        endR[i] = (endR[i] << (8 - cPrec)) | (endR[i] >> (2 * cPrec - 8));
        endG[i] = (endG[i] << (8 - cPrec)) | (endG[i] >> (2 * cPrec - 8));
        endB[i] = (endB[i] << (8 - cPrec)) | (endB[i] >> (2 * cPrec - 8));
        endA[i] = hasAlpha
            ? (endA[i] << (8 - aPrec)) | (endA[i] >> (2 * aPrec - 8))
            : 255;
    }

    // Read color indices
    const useIdx2 = idxBits2 > 0;
    const colorIdxBits = (useIdx2 && idxSel) ? idxBits2 : idxBits1;
    const alphaIdxBits = (useIdx2 && !idxSel) ? idxBits2 : idxBits1;

    // First read primary indices (16 pixels)
    const indices1: number[] = [];
    // Anchor pixels get one less bit
    const anchors1 = getAnchors(numSubsets, partition);
    for (let i = 0; i < 16; i++) {
        const isAnchor = anchors1.includes(i);
        indices1.push(reader.read(idxBits1 - (isAnchor ? 1 : 0)));
    }

    // Read secondary indices if present
    const indices2: number[] = [];
    if (useIdx2) {
        for (let i = 0; i < 16; i++) {
            const isAnchor = (i === 0); // only pixel 0 is anchor for single-subset 2nd index
            indices2.push(reader.read(idxBits2 - (isAnchor ? 1 : 0)));
        }
    }

    // Interpolation weights tables
    const weights2 = [0, 21, 43, 64];
    const weights3 = [0, 9, 18, 27, 37, 46, 55, 64];
    const weights4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
    function getWeights(bits: number): number[] {
        if (bits === 2) return weights2;
        if (bits === 3) return weights3;
        return weights4;
    }

    const cWeights = getWeights(colorIdxBits);
    const aWeights = (useIdx2) ? getWeights(alphaIdxBits) : cWeights;

    // Get partition subset for each pixel
    const partTable = numSubsets > 1 ? (numSubsets === 2 ? BC7_PARTITION2[partition % 64] : null) : null;

    for (let py = 0; py < 4; py++) {
        if (oy + py >= h) continue;
        for (let px = 0; px < 4; px++) {
            if (ox + px >= w) continue;
            const pi = py * 4 + px;
            const subset = partTable ? partTable[pi] : 0;

            const cIdx = (useIdx2 && idxSel) ? indices2[pi] : indices1[pi];
            const aIdx = (useIdx2 && !idxSel) ? indices2[pi] : indices1[pi];

            const ep0 = subset * 2;
            const ep1 = subset * 2 + 1;
            const cw = cWeights[cIdx] ?? 0;
            const aw = aWeights[aIdx] ?? 0;

            let r = ((64 - cw) * endR[ep0] + cw * endR[ep1] + 32) >> 6;
            let g = ((64 - cw) * endG[ep0] + cw * endG[ep1] + 32) >> 6;
            let b = ((64 - cw) * endB[ep0] + cw * endB[ep1] + 32) >> 6;
            let a = ((64 - aw) * endA[ep0] + aw * endA[ep1] + 32) >> 6;

            // Apply rotation
            if (rotation === 1) { const t = a; a = r; r = t; }
            else if (rotation === 2) { const t = a; a = g; g = t; }
            else if (rotation === 3) { const t = a; a = b; b = t; }

            putPx(out, ((oy + py) * w + (ox + px)) * 4,
                Math.min(255, Math.max(0, r)),
                Math.min(255, Math.max(0, g)),
                Math.min(255, Math.max(0, b)),
                Math.min(255, Math.max(0, a)));
        }
    }
}

/** Get anchor indices for BC7 partition (simplified for 1 and 2 subsets) */
function getAnchors(numSubsets: number, partition: number): number[] {
    if (numSubsets === 1) return [0];
    // For 2 subsets: anchor for subset 0 is always pixel 0
    // Anchor for subset 1 is the first pixel in subset 1
    const ANCHOR2: number[] = [
        15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,
        15, 2, 8, 2, 2, 8, 8,15, 2, 8, 2, 2, 8, 8, 2, 2,
        15,15, 6, 8, 2, 8,15,15, 2, 8, 2, 2, 2,15,15, 6,
        6, 2, 6, 8,15,15, 2, 2,15,15,15,15, 3, 6, 6, 8,
    ];
    return [0, ANCHOR2[partition % 64]];
}

// ─── Downscale ──────────────────────────────────────────────────────────────

function downscale(rgba: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
    const out = new Uint8Array(tw * th * 4);
    const xr = w / tw, yr = h / th;
    for (let y = 0; y < th; y++) {
        const sy = Math.min(Math.floor(y * yr), h - 1);
        for (let x = 0; x < tw; x++) {
            const sx = Math.min(Math.floor(x * xr), w - 1);
            const si = (sy * w + sx) * 4, di = (y * tw + x) * 4;
            out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
        }
    }
    return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function decodeDds(filePath: string): DdsResult | null {
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.length < 128) return null;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (view.getUint32(0, true) !== DDS_MAGIC) return null;

        const height = view.getUint32(12, true);
        const width = view.getUint32(16, true);
        if (width === 0 || height === 0 || width > 8192 || height > 8192) return null;

        const pfFlags = view.getUint32(80, true);
        const fourCC = view.getUint32(84, true);
        const bpp = view.getUint32(88, true);
        const rMask = view.getUint32(92, true);

        const dataOff = 128;
        const rgba = new Uint8Array(width * height * 4);
        const bx = Math.ceil(width / 4), by = Math.ceil(height / 4);

        let decoded = false;

        if (pfFlags & DDPF_FOURCC) {
            if (fourCC === FOURCC_DXT1) {
                for (let yr = 0; yr < by; yr++)
                    for (let xr = 0; xr < bx; xr++) {
                        const o = dataOff + (yr * bx + xr) * 8;
                        if (o + 8 <= buf.length) decodeDxt1(view, o, rgba, xr * 4, yr * 4, width, height);
                    }
                decoded = true;
            } else if (fourCC === FOURCC_DXT5) {
                for (let yr = 0; yr < by; yr++)
                    for (let xr = 0; xr < bx; xr++) {
                        const o = dataOff + (yr * bx + xr) * 16;
                        if (o + 16 <= buf.length) decodeDxt5(view, o, rgba, xr * 4, yr * 4, width, height);
                    }
                decoded = true;
            } else if (fourCC === FOURCC_DXT3) {
                for (let yr = 0; yr < by; yr++)
                    for (let xr = 0; xr < bx; xr++) {
                        const o = dataOff + (yr * bx + xr) * 16;
                        if (o + 16 <= buf.length) decodeDxt3(view, o, rgba, xr * 4, yr * 4, width, height);
                    }
                decoded = true;
            } else if (fourCC === FOURCC_DX10) {
                // DX10 extended header: 20 extra bytes after standard 128-byte header
                if (buf.length < 148) return null;
                const dxgiFormat = view.getUint32(128, true);
                const dx10DataOff = 148; // 128 (standard) + 20 (DX10 header)

                if (dxgiFormat === DXGI_FORMAT_BC7_UNORM || dxgiFormat === DXGI_FORMAT_BC7_UNORM_SRGB) {
                    const bc7Rgba = new Uint8Array(width * height * 4);
                    for (let yr = 0; yr < by; yr++)
                        for (let xr = 0; xr < bx; xr++) {
                            const o = dx10DataOff + (yr * bx + xr) * 16;
                            if (o + 16 <= buf.length) decodeBc7Block(view, o, bc7Rgba, xr * 4, yr * 4, width, height);
                        }
                    for (let i = 0; i < bc7Rgba.length; i++) rgba[i] = bc7Rgba[i];
                    decoded = true;
                } else if (dxgiFormat === DXGI_FORMAT_BC4_UNORM || dxgiFormat === DXGI_FORMAT_BC4_SNORM) {
                    for (let yr = 0; yr < by; yr++)
                        for (let xr = 0; xr < bx; xr++) {
                            const o = dx10DataOff + (yr * bx + xr) * 8;
                            if (o + 8 <= buf.length) decodeBc4Block(view, o, rgba, xr * 4, yr * 4, width, height);
                        }
                    decoded = true;
                } else if (dxgiFormat === DXGI_FORMAT_BC5_UNORM || dxgiFormat === DXGI_FORMAT_BC5_SNORM) {
                    for (let yr = 0; yr < by; yr++)
                        for (let xr = 0; xr < bx; xr++) {
                            const o = dx10DataOff + (yr * bx + xr) * 16;
                            if (o + 16 <= buf.length) decodeBc5Block(view, o, rgba, xr * 4, yr * 4, width, height);
                        }
                    decoded = true;
                }
            }
        }

        // Uncompressed 32bpp, 24bpp, 8bpp
        if (!decoded && (bpp === 32 || bpp === 24 || bpp === 8)) {
            const hasAlpha = (pfFlags & DDPF_ALPHAPIXELS) !== 0;
            const isBGRA = rMask === 0x00FF0000;
            const bytesPerPx = bpp / 8;
            // Use pitch from header if available, otherwise calculate
            const headerFlags = view.getUint32(8, true);
            const hasPitch = (headerFlags & 0x8) !== 0;
            const pitch = hasPitch ? view.getUint32(20, true) : width * bytesPerPx;

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const src = dataOff + y * pitch + x * bytesPerPx;
                    const dst = (y * width + x) * 4;
                    if (src + bytesPerPx > buf.length) continue;
                    
                    if (bpp === 32 || bpp === 24) {
                        if (isBGRA) {
                            rgba[dst] = buf[src + 2]; rgba[dst + 1] = buf[src + 1]; rgba[dst + 2] = buf[src];
                        } else {
                            rgba[dst] = buf[src]; rgba[dst + 1] = buf[src + 1]; rgba[dst + 2] = buf[src + 2];
                        }
                        // Always use alpha channel for 32bpp, some editors miss the ALPHAPIXELS flag
                        rgba[dst + 3] = (bpp === 32) ? buf[src + 3] : 255;
                    } else if (bpp === 8) {
                        // 8bpp Luminance/Alpha mask: map white to visible, black to hidden
                        const val = buf[src];
                        rgba[dst] = 255; rgba[dst + 1] = 255; rgba[dst + 2] = 255;
                        rgba[dst + 3] = val; // White is displayed, black is not
                    }
                }
            }
            decoded = true;
        }

        if (!decoded) return null;

        // Downscale large textures for preview
        let outW = width, outH = height;
        let outRgba = rgba;
        if (width > MAX_TEX_DIM || height > MAX_TEX_DIM) {
            const scale = Math.min(MAX_TEX_DIM / width, MAX_TEX_DIM / height);
            outW = Math.max(1, Math.floor(width * scale));
            outH = Math.max(1, Math.floor(height * scale));
            outRgba = new Uint8Array(downscale(rgba, width, height, outW, outH));
        }

        const png = encodePng(outW, outH, outRgba);
        return {
            dataUri: `data:image/png;base64,${png.toString('base64')}`,
            width,
            height,
        };
    } catch {
        return null;
    }
}

/** @deprecated Use decodeDds instead */
export function ddsToDataUri(filePath: string): string | null {
    const result = decodeDds(filePath);
    return result?.dataUri ?? null;
}

/**
 * Decode a TGA file to a data URI PNG.
 * Supports: uncompressed true-color (type 2) and RLE true-color (type 10),
 * with 24-bit (BGR) and 32-bit (BGRA) pixel formats.
 */
export function decodeTga(filePath: string): DdsResult | null {
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.length < 18) return null;

        const idLen = buf[0];
        const imgType = buf[2]; // 2=uncompressed, 10=RLE
        const width = buf.readUInt16LE(12);
        const height = buf.readUInt16LE(14);
        const bpp = buf[16]; // bits per pixel (24 or 32)
        const descriptor = buf[17];

        if ((imgType !== 2 && imgType !== 10) || (bpp !== 24 && bpp !== 32)) return null;
        if (width === 0 || height === 0 || width > 8192 || height > 8192) return null;

        const bytesPerPixel = bpp / 8;
        const pixelCount = width * height;
        const rgba = new Uint8Array(pixelCount * 4);
        let dataOffset = 18 + idLen;

        if (imgType === 2) {
            // Uncompressed
            for (let i = 0; i < pixelCount; i++) {
                const off = dataOffset + i * bytesPerPixel;
                rgba[i * 4]     = buf[off + 2]; // R
                rgba[i * 4 + 1] = buf[off + 1]; // G
                rgba[i * 4 + 2] = buf[off];     // B
                rgba[i * 4 + 3] = bpp === 32 ? buf[off + 3] : 255; // A
            }
        } else {
            // RLE compressed
            let pixIdx = 0;
            let pos = dataOffset;
            while (pixIdx < pixelCount && pos < buf.length) {
                const header = buf[pos++];
                const count = (header & 0x7F) + 1;
                if (header & 0x80) {
                    // RLE packet: one pixel repeated
                    const b = buf[pos], g = buf[pos + 1], r = buf[pos + 2];
                    const a = bpp === 32 ? buf[pos + 3] : 255;
                    pos += bytesPerPixel;
                    for (let j = 0; j < count && pixIdx < pixelCount; j++, pixIdx++) {
                        rgba[pixIdx * 4]     = r;
                        rgba[pixIdx * 4 + 1] = g;
                        rgba[pixIdx * 4 + 2] = b;
                        rgba[pixIdx * 4 + 3] = a;
                    }
                } else {
                    // Raw packet
                    for (let j = 0; j < count && pixIdx < pixelCount; j++, pixIdx++) {
                        rgba[pixIdx * 4]     = buf[pos + 2]; // R
                        rgba[pixIdx * 4 + 1] = buf[pos + 1]; // G
                        rgba[pixIdx * 4 + 2] = buf[pos];     // B
                        rgba[pixIdx * 4 + 3] = bpp === 32 ? buf[pos + 3] : 255;
                        pos += bytesPerPixel;
                    }
                }
            }
        }

        // TGA origin: bit 5 of descriptor = 1 means top-left, 0 means bottom-left
        const topToBottom = (descriptor & 0x20) !== 0;
        if (!topToBottom) {
            // Flip vertically
            const rowBytes = width * 4;
            const tmp = new Uint8Array(rowBytes);
            for (let y = 0; y < height / 2; y++) {
                const topOff = y * rowBytes;
                const botOff = (height - 1 - y) * rowBytes;
                tmp.set(rgba.subarray(topOff, topOff + rowBytes));
                rgba.set(rgba.subarray(botOff, botOff + rowBytes), topOff);
                rgba.set(tmp, botOff);
            }
        }

        // Downscale large textures
        let outW = width, outH = height;
        let outRgba: Uint8Array = rgba;
        const MAX_DIM = 512;
        if (width > MAX_DIM || height > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
            outW = Math.max(1, Math.round(width * ratio));
            outH = Math.max(1, Math.round(height * ratio));
            outRgba = new Uint8Array(downscale(rgba, width, height, outW, outH));
        }

        const png = encodePng(outW, outH, outRgba);
        return {
            dataUri: `data:image/png;base64,${png.toString('base64')}`,
            width,
            height,
        };
    } catch {
        return null;
    }
}
