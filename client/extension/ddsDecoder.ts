/**
 * DDS texture decoder for Stellaris/Paradox game assets.
 * Supports: DXT1 (BC1), DXT3 (BC2), DXT5 (BC3), uncompressed BGRA/BGR.
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
            outRgba = downscale(rgba, width, height, outW, outH) as unknown as Uint8Array;
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
