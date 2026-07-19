/**
 * Skybox environment decode worker.
 *
 * Runs inside a Blob worker in the webview. Decodes PDX DDS cubemaps
 * (sky backgrounds and prefiltered environment maps) off the main thread:
 *   - BC1/BC3 software decompression, mip level 0 only
 *   - optional YCoCg → RGB (PDX sky encoding: Y in alpha, Co in R, Cg in G)
 *   - optional HSV shift (galaxy_background_hsv_shift)
 *   - optional CPU 3D-LUT grade (galaxy_background_lut, skybox only)
 */
import { decompressBC1, decompressBC3 } from './bcDecode';
import { applyHsvShift, sampleColorLut, ycocgToRgb } from './environmentTypes';

interface SkyboxDecodeRequest {
    kind: 'skybox';
    id: number;
    buffer: ArrayBuffer;
    ycocg: boolean;
    hsvShift?: [number, number, number];
    /** RGBA pixels of a 1024x32 PDX color LUT strip (optional) */
    lutPixels?: Uint8Array;
}

interface EnvmapDecodeRequest {
    kind: 'envmap';
    id: number;
    buffer: ArrayBuffer;
}

type DecodeRequest = SkyboxDecodeRequest | EnvmapDecodeRequest;

interface DecodeResult {
    kind: 'result';
    id: number;
    faces: ArrayBuffer[];
    size: number;
    error?: string;
}

const workerScope = globalThis as unknown as {
    onmessage: ((ev: MessageEvent<DecodeRequest>) => void) | null;
    postMessage(message: DecodeResult, transfer?: Transferable[]): void;
};

const FOURCC_DXT1 = 0x31545844; // 'DXT1'
const FOURCC_DXT5 = 0x35545844; // 'DXT5'
const DDSCAPS2_CUBEMAP = 0x00000200;

function decodeCubemap(buffer: ArrayBuffer): { faces: Uint8Array[]; size: number } {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x20534444) throw new Error('Not a DDS file');
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);
    const caps2 = view.getUint32(112, true);

    if (width !== height) throw new Error(`Cubemap faces must be square (${width}x${height})`);
    if (width > 4096) throw new Error(`Cubemap too large (${width})`);
    const isCube = (caps2 & DDSCAPS2_CUBEMAP) !== 0;
    const faceCount = isCube ? 6 : 1;

    if (!(pfFlags & 0x4)) throw new Error('Only FourCC-compressed DDS cubemaps are supported');
    const blockBytes = fourCC === FOURCC_DXT1 ? 8 : fourCC === FOURCC_DXT5 ? 16 : 0;
    if (blockBytes === 0) throw new Error(`Unsupported DDS FourCC 0x${fourCC.toString(16)}`);

    // DDS cubemap layout: each face is stored with its FULL mip chain before the
    // next face begins (face0 mip0..mipN, face1 mip0..mipN, ...).
    const mipCount = Math.max(1, view.getUint32(28, true) || 1);
    let faceStride = 0;
    for (let level = 0; level < mipCount; level++) {
        const lw = Math.max(1, width >> level);
        const lh = Math.max(1, height >> level);
        faceStride += Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * blockBytes;
    }
    const dataOffset = 128;
    if (buffer.byteLength < dataOffset + faceStride * faceCount) {
        throw new Error(`DDS too small for ${faceCount} face(s) x ${mipCount} mip(s)`);
    }

    const mip0Bytes = Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * blockBytes;
    const faces: Uint8Array[] = [];
    for (let f = 0; f < faceCount; f++) {
        const comp = new Uint8Array(buffer, dataOffset + f * faceStride, mip0Bytes);
        faces.push(fourCC === FOURCC_DXT1
            ? decompressBC1(comp, width, height)
            : decompressBC3(comp, width, height));
    }
    return { faces, size: width };
}

function postProcessSkybox(face: Uint8Array, req: SkyboxDecodeRequest): void {
    const shift = req.hsvShift;
    const hasShift = !!shift && (shift[0] !== 0 || shift[1] !== 0 || shift[2] !== 0);
    const lut = req.lutPixels;
    if (!req.ycocg && !hasShift && !lut) return;

    for (let i = 0; i < face.length; i += 4) {
        let r = face[i]! / 255;
        let g = face[i + 1]! / 255;
        let b = face[i + 2]! / 255;
        if (req.ycocg) {
            [r, g, b] = ycocgToRgb(face[i + 3]! / 255, r, g);
        }
        if (hasShift && shift) {
            [r, g, b] = applyHsvShift(r, g, b, shift[0], shift[1], shift[2]);
        }
        if (lut) {
            [r, g, b] = sampleColorLut(lut, r, g, b);
        }
        face[i] = Math.round(r * 255);
        face[i + 1] = Math.round(g * 255);
        face[i + 2] = Math.round(b * 255);
        face[i + 3] = 255;
    }
}

workerScope.onmessage = (ev: MessageEvent<DecodeRequest>) => {
    const req = ev.data;
    try {
        const { faces, size } = decodeCubemap(req.buffer);
        if (req.kind === 'skybox') {
            for (const face of faces) postProcessSkybox(face, req);
        }
        const transfer = faces.map(f => f.buffer as ArrayBuffer);
        workerScope.postMessage({ kind: 'result', id: req.id, faces: transfer, size }, transfer);
    } catch (error) {
        workerScope.postMessage({
            kind: 'result',
            id: req.id,
            faces: [],
            size: 0,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
