import { isFiniteNumber, isRecord } from './protocolValidation';

export interface GuiElement {
    type: string;
    name: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    sizeExplicit?: boolean;
    sizeUsesXY?: boolean;
    percentWidth?: boolean;
    percentHeight?: boolean;
    orientation?: string;
    origo?: string;
    moveable?: boolean;
    clipping?: boolean;
    alwaysTransparent?: boolean;
    spriteKey?: string;
    spriteAttr?: 'spriteType' | 'quadTextureSprite';
    spriteTexture?: string;
    /** Optional data-image used only for taint-free visual verification captures. */
    captureTexture?: string;
    spriteDefType?: string;
    noOfFrames?: number;
    frame?: number;
    textureWidth?: number;
    textureHeight?: number;
    text?: string;
    font?: string;
    format?: string;
    maxWidth?: number;
    maxHeight?: number;
    scale?: number;
    rotation?: number;
    alpha?: number;
    centerPosition?: boolean;
    borderSize?: { x: number; y: number };
    margin?: { top: number; bottom: number; left: number; right: number };
    spacing?: number;
    slotSize?: { width: number; height: number };
    children: GuiElement[];
    properties: Record<string, unknown>;
    line: number;
    endLine: number;
    propertyLines: Record<string, number>;
}

export interface GuiElementReference {
    /** Dot-separated zero-based sibling indexes, stable for one parsed revision. */
    path: string;
    ancestors: string[];
    name: string;
    type: string;
    line: number;
    endLine: number;
}

export interface GuiRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface GuiSelection {
    elements: GuiElementReference[];
    region?: GuiRegion;
}

export interface GuiSelectionContextData extends GuiSelection {
    uri: string;
    documentVersion: number;
}

export interface GuiPreviewSnapshot {
    status: 'ready' | 'empty' | 'error';
    file?: string;
    fileName?: string;
    documentVersion?: number;
    dirty?: boolean;
    pinned?: boolean;
    message?: string;
    elements: GuiElement[];
    selection?: GuiSelection;
    changedPaths?: string[];
}

export interface GuiElementAtPath {
    element: GuiElement;
    path: string;
    ancestors: string[];
}

export function flattenGuiElements(elements: GuiElement[]): GuiElementAtPath[] {
    const result: GuiElementAtPath[] = [];
    const visit = (items: GuiElement[], parentPath: string, ancestors: string[]) => {
        items.forEach((element, index) => {
            const path = parentPath ? `${parentPath}.${index}` : String(index);
            result.push({ element, path, ancestors });
            visit(element.children, path, [...ancestors, element.name || element.type]);
        });
    };
    visit(elements, '', []);
    return result;
}

export function createGuiElementReference(element: GuiElement, path: string, ancestors: string[]): GuiElementReference {
    return {
        path,
        ancestors: [...ancestors],
        name: element.name,
        type: element.type,
        line: element.line,
        endLine: element.endLine,
    };
}

export function resolveGuiElementReference(
    elements: GuiElement[],
    reference: GuiElementReference,
): GuiElementAtPath | undefined {
    const flattened = flattenGuiElements(elements);
    const atPath = flattened.find(item => item.path === reference.path);
    if (atPath && atPath.element.name === reference.name && atPath.element.type === reference.type) {
        return atPath;
    }
    const candidates = flattened.filter(item =>
        item.element.name === reference.name
        && item.element.type === reference.type
        && (reference.ancestors.length === 0 || item.ancestors.join('\0') === reference.ancestors.join('\0')),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
}

function isPositiveLine(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000_000;
}

export function isGuiElementReference(value: unknown): value is GuiElementReference {
    if (!isRecord(value)) return false;
    return typeof value.path === 'string'
        && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,63}$/.test(value.path)
        && Array.isArray(value.ancestors)
        && value.ancestors.length <= 64
        && value.ancestors.every(item => typeof item === 'string' && item.length <= 256)
        && typeof value.name === 'string' && value.name.length <= 256
        && typeof value.type === 'string' && value.type.length <= 128
        && isPositiveLine(value.line)
        && isPositiveLine(value.endLine)
        && value.endLine >= value.line;
}

export function isGuiRegion(value: unknown): value is GuiRegion {
    if (!isRecord(value)) return false;
    const { x, y, width, height } = value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return false;
    if (![x, y, width, height].every(Number.isFinite)) return false;
    return Math.abs(x) <= 10_000_000 && Math.abs(y) <= 10_000_000
        && width >= 0 && height >= 0
        && width <= 20_000_000 && height <= 20_000_000;
}

export function isGuiSelection(value: unknown): value is GuiSelection {
    if (!isRecord(value) || !Array.isArray(value.elements) || value.elements.length > 32) return false;
    if (!value.elements.every(isGuiElementReference)) return false;
    return value.region === undefined || isGuiRegion(value.region);
}

export function isGuiSelectionContextData(value: unknown): value is GuiSelectionContextData {
    if (!isGuiSelection(value)) return false;
    const record = value as unknown as Record<string, unknown>;
    return typeof record.uri === 'string' && record.uri.length > 0 && record.uri.length <= 4096
        && typeof record.documentVersion === 'number'
        && Number.isInteger(record.documentVersion)
        && record.documentVersion >= 0;
}

function isGuiElementTree(value: unknown, depth = 0): value is GuiElement {
    if (depth > 64 || !isRecord(value)) return false;
    if (typeof value.type !== 'string' || typeof value.name !== 'string'
        || !isRecord(value.position) || !isFiniteNumber(value.position.x) || !isFiniteNumber(value.position.y)
        || !isRecord(value.size) || !isFiniteNumber(value.size.width) || !isFiniteNumber(value.size.height)
        || !isPositiveLine(value.line) || !isPositiveLine(value.endLine)
        || !isRecord(value.properties) || !isRecord(value.propertyLines)
        || !Array.isArray(value.children)) return false;
    return value.children.every(child => isGuiElementTree(child, depth + 1));
}

export function isGuiPreviewSnapshot(value: unknown): value is GuiPreviewSnapshot {
    if (!isRecord(value) || !['ready', 'empty', 'error'].includes(String(value.status))) return false;
    if (!Array.isArray(value.elements) || !value.elements.every(element => isGuiElementTree(element))) return false;
    if (value.file !== undefined && typeof value.file !== 'string') return false;
    if (value.fileName !== undefined && typeof value.fileName !== 'string') return false;
    if (value.documentVersion !== undefined && (!Number.isInteger(value.documentVersion) || Number(value.documentVersion) < 0)) return false;
    if (value.dirty !== undefined && typeof value.dirty !== 'boolean') return false;
    if (value.pinned !== undefined && typeof value.pinned !== 'boolean') return false;
    if (value.message !== undefined && typeof value.message !== 'string') return false;
    if (value.selection !== undefined && !isGuiSelection(value.selection)) return false;
    if (value.changedPaths !== undefined && (!Array.isArray(value.changedPaths)
        || value.changedPaths.length > 32
        || !value.changedPaths.every(item => typeof item === 'string'))) return false;
    return true;
}
