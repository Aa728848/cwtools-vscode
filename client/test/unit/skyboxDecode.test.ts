import { expect } from 'chai';
import { decompressBC3 } from '../../webview/bcDecode';
import { applyHsvShift, hsvToRgb, sampleColorLut, ycocgToRgb } from '../../webview/environmentTypes';

const SKY_DDS = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris\\gfx\\map\\sky_rim.dds';
const LUT_TGA = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris\\gfx\\worldgfx\\colorcorrection_neutral.tga';
const ENV_DDS = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris\\gfx\\worldgfx\\cubemap_filtered_ldr.dds';

function readDdsHeader(fs: typeof import('fs'), file: string) {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(128);
    fs.readSync(fd, header, 0, 128, 0);
    fs.closeSync(fd);
    return {
        width: header.readUInt32LE(16),
        height: header.readUInt32LE(12),
        mipCount: header.readUInt32LE(28) || 1,
        fourCC: header.toString('ascii', 84, 88),
        caps2: header.readUInt32LE(112),
    };
}

describe('skybox decode pipeline', () => {
    it('YCoCg→RGB round-trips neutral gray', () => {
        // neutral: Co=Cg=0.5 → achromatic
        const [r, g, b] = ycocgToRgb(0.7, 0.5, 0.5);
        expect(r).to.be.closeTo(0.7, 1e-6);
        expect(g).to.be.closeTo(0.7, 1e-6);
        expect(b).to.be.closeTo(0.7, 1e-6);
    });

    it('hsvToRgb produces primaries', () => {
        const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).to.be.closeTo(b[i]!, 1e-9));
        close([...hsvToRgb(0, 1, 1)], [1, 0, 0]);
        close([...hsvToRgb(1 / 3, 1, 1)], [0, 1, 0]);
        close([...hsvToRgb(2 / 3, 1, 1)], [0, 0, 1]);
        close([...hsvToRgb(0.5, 0, 0.5)], [0.5, 0.5, 0.5]);
    });

    it('applyHsvShift wraps hue and clamps saturation/value', () => {
        const [r, g, b] = applyHsvShift(1, 0, 0, 1 / 3, 0, 0); // red → green
        expect(r).to.be.closeTo(0, 1e-6);
        expect(g).to.be.closeTo(1, 1e-6);
        expect(b).to.be.closeTo(0, 1e-6);
        const [, gs] = applyHsvShift(0, 0.5, 0.5, 0, -1, 0);
        expect(gs).to.be.at.least(0);
    });

    it('sampleColorLut is identity on the neutral LUT (real game file)', () => {
         
        const fs = require('fs') as typeof import('fs');
        if (!fs.existsSync(LUT_TGA)) return;
        const buf = fs.readFileSync(LUT_TGA);
        // 1024x32, 24bpp BGR, bottom-left origin → convert to RGBA top-left
        const width = 1024, height = 32;
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const srcRow = height - 1 - y;
            for (let x = 0; x < width; x++) {
                const si = 18 + (srcRow * width + x) * 3;
                const di = (y * width + x) * 4;
                pixels[di] = buf[si + 2]!;
                pixels[di + 1] = buf[si + 1]!;
                pixels[di + 2] = buf[si]!;
                pixels[di + 3] = 255;
            }
        }
        for (const [r, g, b] of [[0.2, 0.5, 0.8], [0, 0, 0], [1, 1, 1], [0.9, 0.1, 0.4]] as const) {
            const [lr, lg, lb] = sampleColorLut(pixels, r, g, b);
            expect(lr, `R@${r},${g},${b}`).to.be.closeTo(r, 0.02);
            expect(lg, `G@${r},${g},${b}`).to.be.closeTo(g, 0.02);
            expect(lb, `B@${r},${g},${b}`).to.be.closeTo(b, 0.02);
        }
    });

    it('decodes sky_rim.dds face 0 to sane non-black pixels (real game file)', () => {
         
        const fs = require('fs') as typeof import('fs');
        if (!fs.existsSync(SKY_DDS)) return;
        const h = readDdsHeader(fs, SKY_DDS);
        expect(h.fourCC).to.equal('DXT5');
        expect(h.caps2 & 0x200).to.not.equal(0); // cubemap
        const faceBytes = (h.width >> 2) * (h.height >> 2) * 16;
        const fd = fs.openSync(SKY_DDS, 'r');
        const comp = Buffer.alloc(faceBytes);
        fs.readSync(fd, comp, 0, faceBytes, 128);
        fs.closeSync(fd);
        const rgba = decompressBC3(new Uint8Array(comp.buffer, comp.byteOffset, faceBytes), h.width, h.height);
        // Sample brightness: galaxy sky should be mostly dark but with visible stars/nebula
        let sum = 0, lit = 0;
        const stride = 997 * 4; // sparse sample
        for (let i = 0; i < rgba.length; i += stride) {
            const lum = rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
            sum += lum;
            if (lum > 30) lit++;
        }
        const samples = Math.floor(rgba.length / stride);
        expect(sum / samples, 'mean luminance should be > 0 (not fully black)').to.be.greaterThan(1);
        expect(lit / samples, 'some pixels should be visible (stars)').to.be.greaterThan(0.01);
    });

    it('decodes cubemap_filtered_ldr.dds face 0 (mip-chain stride, real game file)', () => {
         
        const fs = require('fs') as typeof import('fs');
        if (!fs.existsSync(ENV_DDS)) return;
        const h = readDdsHeader(fs, ENV_DDS);
        expect(h.fourCC).to.equal('DXT5');
        // Per-face mip chain stride (DXT5, 10 levels from 512 down to 1)
        let faceStride = 0;
        for (let l = 0; l < h.mipCount; l++) {
            const lw = Math.max(1, h.width >> l);
            const lh = Math.max(1, h.height >> l);
            faceStride += Math.max(1, lw >> 2) * Math.max(1, lh >> 2) * 16;
        }
        expect(128 + faceStride * 6).to.equal(fs.statSync(ENV_DDS).size);
        const mip0 = (h.width >> 2) * (h.height >> 2) * 16;
        const fd = fs.openSync(ENV_DDS, 'r');
        const comp = Buffer.alloc(mip0);
        fs.readSync(fd, comp, 0, mip0, 128);
        fs.closeSync(fd);
        const rgba = decompressBC3(new Uint8Array(comp.buffer, comp.byteOffset, mip0), h.width, h.height);
        let sum = 0;
        const stride = 101 * 4;
        for (let i = 0; i < rgba.length; i += stride) {
            sum += rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
        }
        expect(sum / Math.floor(rgba.length / stride), 'env map should not be fully black').to.be.greaterThan(10);
    });
});
