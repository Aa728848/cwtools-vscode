import { expect } from 'chai';
import { parsePdxMeshAnchorNames } from '../../extension/pdxMeshAnchors';

function object(depth: number, name: string): Buffer {
    return Buffer.concat([
        Buffer.alloc(depth, 0x5b),
        Buffer.from(name, 'latin1'),
        Buffer.from([0]),
    ]);
}

function stringProperty(name: string, value: string): Buffer {
    const nameBytes = Buffer.from(name, 'latin1');
    const valueBytes = Buffer.from(value, 'latin1');
    const header = Buffer.alloc(1 + 1 + nameBytes.length + 1 + 4 + 4);
    let offset = 0;
    header.writeUInt8(0x21, offset++);
    header.writeUInt8(nameBytes.length, offset++);
    nameBytes.copy(header, offset);
    offset += nameBytes.length;
    header.writeUInt8('s'.charCodeAt(0), offset++);
    header.writeInt32LE(1, offset);
    offset += 4;
    header.writeInt32LE(valueBytes.length, offset);
    return Buffer.concat([header, valueBytes]);
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

describe('PDX mesh anchor names', () => {
    it('does not treat arbitrary binary string values as locator names', () => {
        const mesh = Buffer.concat([
            Buffer.from('@@b@', 'latin1'),
            object(1, 'object'),
            object(2, 'shipShape'),
            stringProperty('material', '13'),
            object(3, 'skeleton'),
            object(4, 'RootBone'),
            object(1, 'locator'),
            object(2, 'engine_01'),
            stringProperty('pa', '13'),
        ]);

        const anchors = parsePdxMeshAnchorNames(arrayBuffer(mesh));
        expect(anchors).not.to.equal(undefined);
        expect([...anchors!.locators]).to.deep.equal(['engine_01']);
        expect([...anchors!.bones]).to.deep.equal(['RootBone']);
        expect(anchors!.locators.has('13')).to.equal(false);
    });

    it('recognizes a numeric name only when it is an actual locator object', () => {
        const mesh = Buffer.concat([
            Buffer.from('@@b@', 'latin1'),
            object(1, 'locator'),
            object(2, '13'),
            object(2, '14'),
        ]);

        const anchors = parsePdxMeshAnchorNames(arrayBuffer(mesh));
        expect([...anchors!.locators]).to.deep.equal(['13', '14']);
    });

    it('rejects malformed mesh data without returning partial names', () => {
        const malformed = Buffer.concat([
            Buffer.from('@@b@', 'latin1'),
            object(1, 'locator'),
            Buffer.from([0x21, 0xff]),
        ]);
        expect(parsePdxMeshAnchorNames(arrayBuffer(malformed))).to.equal(undefined);
    });
});
