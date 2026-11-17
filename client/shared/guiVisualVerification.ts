import { isRecord } from './protocolValidation';
import type { GuiRegion } from './guiPreview';

export const GUI_VISUAL_WIDTH = 960;
export const GUI_VISUAL_HEIGHT = 720;
export const GUI_VISUAL_MAX_IMAGE_CHARS = 2_000_000;
export const GUI_VISUAL_PIXEL_THRESHOLD = 12;
export const GUI_VISUAL_MAX_REVIEW_ROUNDS = 2;

export interface GuiVisualCapture {
    dataUrl: string;
    width: number;
    height: number;
    frame: GuiRegion;
}

export interface GuiVisualMetrics {
    changedPixels: number;
    totalPixels: number;
    changeRatio: number;
    bounds?: GuiRegion;
}

export interface GuiVisualEvidence {
    requestId: string;
    runId: string;
    file: string;
    round: number;
    status: 'ready' | 'after_only';
    before?: string;
    after: string;
    diff?: string;
    metrics?: GuiVisualMetrics;
    frame: GuiRegion;
    createdAt: number;
}

export interface GuiVisualCaptureRequestMessage {
    type: 'guiVisualCaptureRequest';
    requestId: string;
    runId: string;
    file: string;
    round: number;
    before?: GuiVisualCapture;
}

export interface GuiVisualCaptureResponseMessage {
    type: 'guiVisualCaptureResponse';
    requestId: string;
    runId: string;
    capture?: GuiVisualCapture;
    evidence?: GuiVisualEvidence;
    error?: string;
}

export interface GuiVisualComparison {
    metrics: GuiVisualMetrics;
    diffRgba: Uint8ClampedArray;
}

export function compareRgbaImages(
    before: Uint8ClampedArray,
    after: Uint8ClampedArray,
    width: number,
    height: number,
    threshold = GUI_VISUAL_PIXEL_THRESHOLD,
): GuiVisualComparison {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > GUI_VISUAL_WIDTH || height > GUI_VISUAL_HEIGHT) {
        throw new Error('Invalid visual comparison dimensions.');
    }
    const expected = width * height * 4;
    if (before.length !== expected || after.length !== expected) {
        throw new Error('Visual comparison buffers must have identical RGBA dimensions.');
    }
    const diffRgba = new Uint8ClampedArray(expected);
    let changedPixels = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 0; index < expected; index += 4) {
        const delta = Math.max(
            Math.abs(before[index]! - after[index]!),
            Math.abs(before[index + 1]! - after[index + 1]!),
            Math.abs(before[index + 2]! - after[index + 2]!),
            Math.abs(before[index + 3]! - after[index + 3]!),
        );
        const changed = delta > threshold;
        const pixel = index / 4;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        if (changed) {
            changedPixels++;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            diffRgba[index] = 255;
            diffRgba[index + 1] = 32;
            diffRgba[index + 2] = 220;
            diffRgba[index + 3] = 255;
        } else {
            const gray = Math.round((before[index]! + before[index + 1]! + before[index + 2]!) / 3);
            diffRgba[index] = gray;
            diffRgba[index + 1] = gray;
            diffRgba[index + 2] = gray;
            diffRgba[index + 3] = 72;
        }
    }
    const metrics: GuiVisualMetrics = {
        changedPixels,
        totalPixels: width * height,
        changeRatio: changedPixels / (width * height),
        ...(maxX >= 0 ? { bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } } : {}),
    };
    return { metrics, diffRgba };
}

function isDataImageUrl(value: unknown): value is string {
    return typeof value === 'string'
        && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)
        && value.length <= GUI_VISUAL_MAX_IMAGE_CHARS;
}

function isImageReference(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= GUI_VISUAL_MAX_IMAGE_CHARS;
}

function isDimension(value: unknown, maximum: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum;
}

function isFrame(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
        && Number(value.width) >= 0 && Number(value.height) >= 0;
}

export function isGuiVisualCapture(value: unknown): value is GuiVisualCapture {
    if (!isRecord(value)) return false;
    return isDataImageUrl(value.dataUrl)
        && isDimension(value.width, GUI_VISUAL_WIDTH)
        && isDimension(value.height, GUI_VISUAL_HEIGHT)
        && isFrame(value.frame);
}

export function isGuiVisualMetrics(value: unknown): value is GuiVisualMetrics {
    if (!isRecord(value)) return false;
    return typeof value.changedPixels === 'number' && Number.isInteger(value.changedPixels) && value.changedPixels >= 0
        && typeof value.totalPixels === 'number' && Number.isInteger(value.totalPixels) && value.totalPixels > 0
        && value.changedPixels <= value.totalPixels
        && typeof value.changeRatio === 'number' && value.changeRatio >= 0 && value.changeRatio <= 1
        && (value.bounds === undefined || isFrame(value.bounds));
}

export function isGuiVisualEvidence(value: unknown, dataImages = false): value is GuiVisualEvidence {
    if (!isRecord(value)) return false;
    const image = dataImages ? isDataImageUrl : isImageReference;
    if (typeof value.requestId !== 'string' || value.requestId.length === 0 || value.requestId.length > 160
        || typeof value.runId !== 'string' || value.runId.length === 0 || value.runId.length > 160
        || typeof value.file !== 'string' || value.file.length === 0 || value.file.length > 4096
        || !Number.isInteger(value.round) || Number(value.round) < 1 || Number(value.round) > GUI_VISUAL_MAX_REVIEW_ROUNDS
        || !['ready', 'after_only'].includes(String(value.status))
        || !image(value.after) || !isFrame(value.frame)
        || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return false;
    if (value.before !== undefined && !image(value.before)) return false;
    if (value.diff !== undefined && !image(value.diff)) return false;
    if (value.metrics !== undefined && !isGuiVisualMetrics(value.metrics)) return false;
    return value.status === 'after_only' || (value.before !== undefined && value.diff !== undefined && value.metrics !== undefined);
}

export const isGuiVisualCaptureRequest = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    return typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 160
        && typeof value.runId === 'string' && value.runId.length > 0 && value.runId.length <= 160
        && typeof value.file === 'string' && value.file.length > 0 && value.file.length <= 4096
        && Number.isInteger(value.round) && Number(value.round) >= 0 && Number(value.round) <= GUI_VISUAL_MAX_REVIEW_ROUNDS
        && (value.before === undefined || isGuiVisualCapture(value.before));
};
