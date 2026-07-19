/** Expand a 16-bit RGB565 color to [R, G, B] (0-255) */
export function rgb565(c: number): [number, number, number] {
    return [
        ((c >> 11) & 0x1f) * 255 / 31 | 0,
        ((c >> 5) & 0x3f) * 255 / 63 | 0,
        (c & 0x1f) * 255 / 31 | 0,
    ];
}

/** Decompress BC1 (DXT1) compressed data → RGBA Uint8Array */
export function decompressBC1(src: Uint8Array, width: number, height: number): Uint8Array {
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
                palette[3] = [0, 0, 0, 0];
            }

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
export function decompressBC3(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const bw = Math.max(1, (width + 3) >> 2);
    const bh = Math.max(1, (height + 3) >> 2);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockIdx = (by * bw + bx) * 16;

            const a0 = src[blockIdx]!;
            const a1 = src[blockIdx + 1]!;

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

            let alphaBits = 0n;
            for (let i = 0; i < 6; i++) {
                alphaBits |= BigInt(src[blockIdx + 2 + i]!) << BigInt(i * 8);
            }

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

                    const ci = (colorBits >>> (pixelIdx * 2)) & 3;
                    const p = palette[ci]!;

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
