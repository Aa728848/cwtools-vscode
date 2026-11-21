/**
 * Offscreen 2D Canvas Renderer & Pixel-Diff Evidence Builder for `.gui` Verification.
 *
 * Renders `GuiVisualRenderable` snapshots (including nine-slice sprites) to
 * fixed-size PNG captures inside the Webview and computes before/after diff
 * summaries using `shared/guiVisualVerification.ts`.
 */

import type { GuiElement, GuiRegion } from '../shared/guiPreview';
import {
    compareRgbaImages,
    GUI_VISUAL_HEIGHT,
    GUI_VISUAL_WIDTH,
    type GuiVisualCapture,
    type GuiVisualEvidence,
} from '../shared/guiVisualVerification';

export interface GuiVisualRenderable {
    element: GuiElement;
    div: HTMLElement;
    bounds: { left: number; top: number; right: number; bottom: number };
}

interface CaptureMetadata {
    requestId: string;
    runId: string;
    file: string;
    round: number;
}

function contentFrame(items: Iterable<GuiVisualRenderable>): GuiRegion {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const item of items) {
        count++;
        left = Math.min(left, item.bounds.left);
        top = Math.min(top, item.bounds.top);
        right = Math.max(right, item.bounds.right);
        bottom = Math.max(bottom, item.bounds.bottom);
    }
    if (!count) return { x: 0, y: 0, width: 800, height: 600 };
    return {
        x: left - 24,
        y: top - 24,
        width: Math.max(1, right - left + 48),
        height: Math.max(1, bottom - top + 48),
    };
}

function captureSource(element: GuiElement): string | undefined {
    if (element.captureTexture) return element.captureTexture;
    return element.spriteTexture?.startsWith('data:image/') ? element.spriteTexture : undefined;
}

function loadImage(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Unable to load a GUI texture for visual verification.'));
        image.src = source;
    });
}

function drawNineSlice(
    context: CanvasRenderingContext2D,
    image: HTMLImageElement,
    element: GuiElement,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    const bx = element.borderSize?.x ?? 0;
    const by = element.borderSize?.y ?? 0;
    const sw = image.naturalWidth;
    const sh = image.naturalHeight;
    const sl = Math.min(bx, sw / 2);
    const sr = Math.min(bx, sw / 2);
    const st = Math.min(by, sh / 2);
    const sb = Math.min(by, sh / 2);
    const scw = sw - sl - sr;
    const sch = sh - st - sb;
    const dl = Math.min(bx, width / 2);
    const dr = Math.min(bx, width / 2);
    const dt = Math.min(by, height / 2);
    const db = Math.min(by, height / 2);
    const dcw = width - dl - dr;
    const dch = height - dt - db;
    if (sl > 0 && st > 0) context.drawImage(image, 0, 0, sl, st, x, y, dl, dt);
    if (scw > 0 && st > 0) context.drawImage(image, sl, 0, scw, st, x + dl, y, dcw, dt);
    if (sr > 0 && st > 0) context.drawImage(image, sw - sr, 0, sr, st, x + width - dr, y, dr, dt);
    if (sl > 0 && sch > 0) context.drawImage(image, 0, st, sl, sch, x, y + dt, dl, dch);
    if (scw > 0 && sch > 0) context.drawImage(image, sl, st, scw, sch, x + dl, y + dt, dcw, dch);
    if (sr > 0 && sch > 0) context.drawImage(image, sw - sr, st, sr, sch, x + width - dr, y + dt, dr, dch);
    if (sl > 0 && sb > 0) context.drawImage(image, 0, sh - sb, sl, sb, x, y + height - db, dl, db);
    if (scw > 0 && sb > 0) context.drawImage(image, sl, sh - sb, scw, sb, x + dl, y + height - db, dcw, db);
    if (sr > 0 && sb > 0) context.drawImage(image, sw - sr, sh - sb, sr, sb, x + width - dr, y + height - db, dr, db);
}

export async function captureGuiImage(
    items: Iterable<GuiVisualRenderable>,
    frame?: GuiRegion,
): Promise<GuiVisualCapture> {
    const renderables = [...items];
    const captureFrame = frame ?? contentFrame(renderables);
    const canvas = document.createElement('canvas');
    canvas.width = GUI_VISUAL_WIDTH;
    canvas.height = GUI_VISUAL_HEIGHT;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable for GUI visual verification.');
    context.fillStyle = '#17191d';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(0.01, Math.min(2, (canvas.width - 48) / captureFrame.width, (canvas.height - 48) / captureFrame.height));
    const offsetX = (canvas.width - captureFrame.width * scale) / 2 - captureFrame.x * scale;
    const offsetY = (canvas.height - captureFrame.height * scale) / 2 - captureFrame.y * scale;
    context.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    const images = new Map<string, Promise<HTMLImageElement>>();
    for (const item of renderables) {
        const source = captureSource(item.element);
        if (source && !images.has(source)) images.set(source, loadImage(source));
    }
    const loaded = new Map<string, HTMLImageElement>();
    await Promise.all([...images].map(async ([source, promise]) => {
        try { loaded.set(source, await promise); } catch { /* placeholder remains visible */ }
    }));
    for (const item of renderables) {
        const { element, bounds } = item;
        const x = bounds.left;
        const y = bounds.top;
        const width = Math.max(0, bounds.right - bounds.left);
        const height = Math.max(0, bounds.bottom - bounds.top);
        if (!width || !height) continue;
        context.save();
        if (element.rotation) {
            context.translate(x + width / 2, y + height / 2);
            context.rotate(-element.rotation);
            context.translate(-x - width / 2, -y - height / 2);
        }
        context.globalAlpha = Math.max(0, Math.min(1, element.alpha ?? 1));
        context.fillStyle = 'rgba(75, 88, 105, 0.18)';
        context.fillRect(x, y, width, height);
        context.strokeStyle = item.div.style.borderColor || '#727b88';
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
        const source = captureSource(element);
        const image = source ? loaded.get(source) : undefined;
        if (image) {
            if (element.spriteDefType === 'corneredTileSpriteType' && (element.borderSize?.x || element.borderSize?.y)) {
                drawNineSlice(context, image, element, x, y, width, height);
            } else {
                const frames = element.noOfFrames && element.noOfFrames > 1 ? element.noOfFrames : 1;
                const frame = Math.max(0, Math.min((element.frame ?? 1) - 1, frames - 1));
                const sourceWidth = image.naturalWidth / frames;
                context.drawImage(image, frame * sourceWidth, 0, sourceWidth, image.naturalHeight, x, y, width, height);
            }
        } else if (element.spriteTexture && !source) {
            context.fillStyle = '#9aa4b2';
            context.font = '10px monospace';
            context.fillText(element.spriteKey ?? element.spriteTexture, x + 4, y + Math.min(height - 3, 18), Math.max(0, width - 8));
        }
        const label = element.text || element.name;
        if (label) {
            context.beginPath();
            context.rect(x, y, width, height);
            context.clip();
            context.globalAlpha = Math.max(0, Math.min(1, element.alpha ?? 1));
            context.fillStyle = '#d4d9e0';
            context.font = element.text ? '12px "Segoe UI", sans-serif' : '11px "Segoe UI", sans-serif';
            context.textBaseline = 'top';
            const text = element.text && ['center', 'centre', 'right'].includes(element.format ?? '')
                ? element.text
                : label;
            if (element.format === 'right') {
                context.textAlign = 'right';
                context.fillText(text, x + width - 5, y + 4, Math.max(0, width - 10));
            } else if (element.format === 'center' || element.format === 'centre') {
                context.textAlign = 'center';
                context.fillText(text, x + width / 2, y + 4, Math.max(0, width - 10));
            } else {
                context.textAlign = 'left';
                context.fillText(text, x + 4, y + 3, Math.max(0, width - 8));
            }
        }
        context.restore();
    }
    return {
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
        frame: captureFrame,
    };
}

async function rgbaForCapture(capture: GuiVisualCapture): Promise<Uint8ClampedArray> {
    const image = await loadImage(capture.dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = capture.width;
    canvas.height = capture.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for GUI visual comparison.');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

export async function createGuiVisualEvidence(
    items: Iterable<GuiVisualRenderable>,
    metadata: CaptureMetadata,
    before?: GuiVisualCapture,
): Promise<GuiVisualEvidence> {
    const after = await captureGuiImage(items, before?.frame);
    if (!before) {
        return {
            ...metadata,
            status: 'after_only',
            after: after.dataUrl,
            frame: after.frame,
            createdAt: Date.now(),
        };
    }
    const [beforeRgba, afterRgba] = await Promise.all([rgbaForCapture(before), rgbaForCapture(after)]);
    const comparison = compareRgbaImages(beforeRgba, afterRgba, after.width, after.height);
    const canvas = document.createElement('canvas');
    canvas.width = after.width;
    canvas.height = after.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for GUI visual comparison.');
    context.putImageData(new ImageData(comparison.diffRgba, canvas.width, canvas.height), 0, 0);
    return {
        ...metadata,
        status: 'ready',
        before: before.dataUrl,
        after: after.dataUrl,
        diff: canvas.toDataURL('image/png'),
        metrics: comparison.metrics,
        frame: after.frame,
        createdAt: Date.now(),
    };
}
