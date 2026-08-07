const HEADER_MAGIC = 0x40624040; // @@b@

export interface PdxMeshAnchorNames {
    locators: Set<string>;
    bones: Set<string>;
}

function readCString(view: DataView, start: number): { value: string; next: number } | undefined {
    let value = '';
    let position = start;
    while (position < view.byteLength) {
        const byte = view.getUint8(position++);
        if (byte === 0) return { value, next: position };
        if (value.length >= 1024) return undefined;
        value += String.fromCharCode(byte);
    }
    return undefined;
}

function skipProperty(view: DataView, start: number): number | undefined {
    let position = start + 1; // ! marker
    if (position >= view.byteLength) return undefined;
    const nameLength = view.getUint8(position++);
    position += nameLength;
    if (position + 5 > view.byteLength) return undefined;
    const type = String.fromCharCode(view.getUint8(position++));
    const count = view.getInt32(position, true);
    position += 4;
    if (count < 0) return undefined;

    if (type === 'i' || type === 'f') {
        const byteLength = count * 4;
        return Number.isSafeInteger(byteLength) && position + byteLength <= view.byteLength
            ? position + byteLength
            : undefined;
    }
    if (type === 's') {
        if (position + 4 > view.byteLength) return undefined;
        const stringLength = view.getInt32(position, true);
        position += 4;
        return stringLength >= 0 && position + stringLength <= view.byteLength
            ? position + stringLength
            : undefined;
    }
    return undefined;
}

/** Read only exact locator and bone object names from a binary PDX mesh. */
export function parsePdxMeshAnchorNames(buffer: ArrayBuffer): PdxMeshAnchorNames | undefined {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint32(0, true) !== HEADER_MAGIC) return undefined;

    const locators = new Set<string>();
    const bones = new Set<string>();
    const stack: Array<{ depth: number; name: string }> = [];
    let position = 4;
    while (position < view.byteLength) {
        const marker = view.getUint8(position);
        if (marker === 0x5b) {
            let depth = 0;
            while (position < view.byteLength && view.getUint8(position) === 0x5b) {
                depth++;
                position++;
            }
            const objectName = readCString(view, position);
            if (!objectName || depth === 0) return undefined;
            position = objectName.next;
            while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
            const parent = stack[stack.length - 1];
            if (parent?.name === 'locator' && parent.depth === depth - 1) locators.add(objectName.value);
            if (parent?.name === 'skeleton' && parent.depth === depth - 1) bones.add(objectName.value);
            stack.push({ depth, name: objectName.value });
            continue;
        }
        if (marker === 0x21) {
            const next = skipProperty(view, position);
            if (next === undefined) return undefined;
            position = next;
            continue;
        }
        return undefined;
    }

    return { locators, bones };
}

export function normalizedPdxMeshAnchorNames(buffer: ArrayBuffer): Set<string> | undefined {
    const parsed = parsePdxMeshAnchorNames(buffer);
    if (!parsed) return undefined;
    return new Set([...parsed.locators, ...parsed.bones].map(name => name.toLowerCase()));
}
