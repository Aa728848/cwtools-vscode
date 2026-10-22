/**
 * Minimal uncompressed ARGB8888 DDS writer.
 *
 * The layout mirrors `write_dds` in example/main.cpp so the output loads in the same
 * editors and matches vanilla Stellaris icon sheets byte for byte in header fields.
 */

import type { RgbaImage } from './shipIconRender';

const DDS_HEADER_BYTES = 128;
const DDS_MAGIC = 0x20534444; // "DDS " little-endian
const DDS_HEADER_SIZE = 124;
const DDS_FLAGS = 0x1007; // CAPS | HEIGHT | WIDTH | PITCH
const DDS_PIXEL_FORMAT_SIZE = 32;
const DDS_PIXEL_FORMAT_FLAGS = 0x41; // RGB | ALPHAPIXELS
const DDS_CAPS_TEXTURE = 0x1000;

export function encodeDdsArgb8888(image: RgbaImage): Uint8Array {
    const width = image.width;
    const height = image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid DDS dimensions: ${width}x${height}`);
    }
    const pixelBytes = width * height * 4;
    if (image.pixels.length !== pixelBytes) {
        throw new Error(`DDS pixel buffer is ${image.pixels.length} bytes, expected ${pixelBytes}`);
    }

    const out = new Uint8Array(DDS_HEADER_BYTES + pixelBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, DDS_MAGIC, true);
    view.setUint32(4, DDS_HEADER_SIZE, true);
    view.setUint32(8, DDS_FLAGS, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(20, width * 4, true);
    view.setUint32(24, 0, true); // depth
    view.setUint32(28, 0, true); // mipMapCount
    // 11 reserved words (32..75) stay zero.
    view.setUint32(76, DDS_PIXEL_FORMAT_SIZE, true);
    view.setUint32(80, DDS_PIXEL_FORMAT_FLAGS, true);
    view.setUint32(84, 0, true); // fourCC
    view.setUint32(88, 32, true); // bitCount
    view.setUint32(92, 0x00ff0000, true); // R
    view.setUint32(96, 0x0000ff00, true); // G
    view.setUint32(100, 0x000000ff, true); // B
    view.setUint32(104, 0xff000000, true); // A
    view.setUint32(108, DDS_CAPS_TEXTURE, true);
    // caps2, caps3, caps4 and reserved2 (112..127) stay zero.

    const pixels = image.pixels;
    for (let index = 0; index < width * height; index++) {
        const source = index * 4;
        const target = DDS_HEADER_BYTES + source;
        out[target] = pixels[source + 2] ?? 0; // B
        out[target + 1] = pixels[source + 1] ?? 0; // G
        out[target + 2] = pixels[source] ?? 0; // R
        out[target + 3] = pixels[source + 3] ?? 0; // A
    }
    return out;
}
