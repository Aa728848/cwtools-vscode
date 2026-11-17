import {
    createGuiElementReference,
    flattenGuiElements,
    resolveGuiElementReference,
    type GuiElement,
    type GuiElementAtPath,
    type GuiPreviewSnapshot,
    type GuiRegion,
    type GuiSelection,
} from '../shared/guiPreview';
import { computeGuiCanvasSize, computeTopLeft, effectiveSize, isOffCanvasElement, normalizeOrientation, ORIENTATION_FRACS } from './guiLayout';
import { applyGuiImageStyles } from './guiVisuals';
import { captureGuiImage, createGuiVisualEvidence } from './guiVisualCapture';
import type { GuiVisualCapture, GuiVisualCaptureRequestMessage, GuiVisualCaptureResponseMessage, GuiVisualEvidence } from '../shared/guiVisualVerification';

export interface RenderedElement extends GuiElementAtPath {
    div: HTMLElement;
    bounds: { left: number; top: number; right: number; bottom: number };
}

interface GuiCanvasOptions {
    onSelection: (selection: GuiSelection) => void;
    onOpenSource: (line: number) => void;
}

const TYPE_COLORS: Record<string, string> = {
    containerWindowType: '#6f91bd', windowType: '#6f91bd', background: '#596174',
    buttonType: '#5a96e8', effectButtonType: '#9170dc', guiButtonType: '#5a96e8',
    iconType: '#52bd68', instantTextBoxType: '#d5a33e', textboxType: '#d5a33e',
    editBoxType: '#c99343', smoothListboxType: '#a174bd', listBoxType: '#a174bd',
    listboxType: '#a174bd', scrollbarType: '#858585', extendedScrollbarType: '#858585',
};

function intersects(a: RenderedElement['bounds'], b: GuiRegion): boolean {
    return a.right >= b.x && a.left <= b.x + b.width && a.bottom >= b.y && a.top <= b.y + b.height;
}

/** Persistent, read-only GUI canvas used by the detached Agent Manager. */
export class GuiCanvasView {
    readonly element: HTMLElement;
    private readonly viewport: HTMLElement;
    private readonly surface: HTMLElement;
    private readonly marquee: HTMLElement;
    private readonly rendered = new Map<string, RenderedElement>();
    private readonly listeners = new AbortController();
    private renderListeners?: AbortController;
    private readonly options: GuiCanvasOptions;
    private scale = 0.5;
    private panX = 20;
    private panY = 20;
    private currentFile = '';
    private selection: GuiSelection = { elements: [] };
    private changedPaths = new Set<string>();
    private marqueeMode = false;
    private drag: { kind: 'pan' | 'marquee'; pointerId: number; startX: number; startY: number; lastX: number; lastY: number } | undefined;

    constructor(container: HTMLElement, options: GuiCanvasOptions) {
        this.options = options;
        this.element = document.createElement('div');
        this.element.className = 'manager-gui-canvas';
        this.viewport = document.createElement('div');
        this.viewport.className = 'manager-gui-viewport';
        this.viewport.tabIndex = 0;
        this.viewport.setAttribute('aria-label', 'GUI preview canvas');
        this.surface = document.createElement('div');
        this.surface.className = 'manager-gui-surface';
        this.marquee = document.createElement('div');
        this.marquee.className = 'manager-gui-marquee';
        this.marquee.hidden = true;
        this.viewport.append(this.surface, this.marquee);
        this.element.append(this.viewport);
        container.append(this.element);
        const signal = this.listeners.signal;
        this.viewport.addEventListener('wheel', event => this.onWheel(event), { passive: false, signal });
        this.viewport.addEventListener('pointerdown', event => this.onPointerDown(event), { signal });
        this.viewport.addEventListener('pointermove', event => this.onPointerMove(event), { signal });
        this.viewport.addEventListener('pointerup', event => this.onPointerUp(event), { signal });
        this.viewport.addEventListener('pointercancel', () => this.cancelDrag(), { signal });
        this.viewport.addEventListener('click', event => {
            if (event.target === this.viewport || event.target === this.surface) this.setSelected([], undefined, true);
        }, { signal });
    }

    async captureBaseline(): Promise<GuiVisualCapture> {
        return captureGuiImage(this.rendered.values());
    }

    async captureVisual(request: GuiVisualCaptureRequestMessage): Promise<GuiVisualCaptureResponseMessage> {
        try {
            if (request.round === 0) {
                return {
                    type: 'guiVisualCaptureResponse',
                    requestId: request.requestId,
                    runId: request.runId,
                    capture: await this.captureBaseline(),
                };
            }
            const evidence: GuiVisualEvidence = await createGuiVisualEvidence(this.rendered.values(), {
                requestId: request.requestId,
                runId: request.runId,
                file: request.file,
                round: request.round,
            }, request.before);
            return {
                type: 'guiVisualCaptureResponse',
                requestId: request.requestId,
                runId: request.runId,
                evidence,
            };
        } catch (error) {
            return {
                type: 'guiVisualCaptureResponse',
                requestId: request.requestId,
                runId: request.runId,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    setMarqueeMode(enabled: boolean): void {
        this.marqueeMode = enabled;
        this.element.classList.toggle('is-marquee-mode', enabled);
    }

    zoomBy(factor: number): void {
        this.scale = Math.max(0.05, Math.min(4, this.scale * factor));
        this.updateTransform();
    }

    actualSize(): void {
        this.scale = 1;
        this.panX = 20;
        this.panY = 20;
        this.updateTransform();
    }

    fit(): void {
        const rect = this.viewport.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        let left = 0;
        let top = 0;
        let right = Number.parseFloat(this.surface.style.width) || 800;
        let bottom = Number.parseFloat(this.surface.style.height) || 600;
        if (this.rendered.size > 0) {
            left = Number.POSITIVE_INFINITY;
            top = Number.POSITIVE_INFINITY;
            right = Number.NEGATIVE_INFINITY;
            bottom = Number.NEGATIVE_INFINITY;
            for (const item of this.rendered.values()) {
                left = Math.min(left, item.bounds.left);
                top = Math.min(top, item.bounds.top);
                right = Math.max(right, item.bounds.right);
                bottom = Math.max(bottom, item.bounds.bottom);
            }
        }
        const width = Math.max(1, right - left);
        const height = Math.max(1, bottom - top);
        this.scale = Math.max(0.05, Math.min(1.5, (rect.width - 32) / width, (rect.height - 32) / height));
        this.panX = (rect.width - width * this.scale) / 2 - left * this.scale;
        this.panY = (rect.height - height * this.scale) / 2 - top * this.scale;
        this.updateTransform();
    }

    applySnapshot(snapshot: GuiPreviewSnapshot): void {
        const nextFile = snapshot.file ?? '';
        const preserveView = nextFile === this.currentFile;
        this.currentFile = nextFile;
        this.changedPaths = new Set(snapshot.changedPaths ?? []);
        this.render(snapshot.elements);
        const restored = (snapshot.selection?.elements ?? []).flatMap(reference => {
            const resolved = resolveGuiElementReference(snapshot.elements, reference);
            return resolved ? [createGuiElementReference(resolved.element, resolved.path, resolved.ancestors)] : [];
        });
        this.setSelected(restored, snapshot.selection?.region, false);
        if (!preserveView) requestAnimationFrame(() => this.fit());
        else this.updateTransform();
    }

    dispose(): void {
        this.listeners.abort();
        this.renderListeners?.abort();
        this.element.remove();
        this.rendered.clear();
    }

    private render(elements: GuiElement[]): void {
        this.renderListeners?.abort();
        this.renderListeners = new AbortController();
        const renderSignal = this.renderListeners.signal;
        this.rendered.clear();
        this.surface.replaceChildren();
        const size = computeGuiCanvasSize(elements);
        this.surface.style.width = `${size.width}px`;
        this.surface.style.height = `${size.height}px`;
        const fragment = document.createDocumentFragment();
        const visit = (items: GuiElement[], parent: HTMLElement, parentW: number, parentH: number,
            parentPath: string, ancestors: string[], offsetX: number, offsetY: number,
            parentAnchorOverride?: { x: number; y: number }) => {
            items.forEach((element, index) => {
                const path = parentPath ? `${parentPath}.${index}` : String(index);
                if (isOffCanvasElement(element)) return;
                if (element.sizeExplicit && element.size.width === 0 && element.size.height === 0
                    && ['containerWindowType', 'windowType'].includes(element.type)) return;
                const size = effectiveSize(element, parentW, parentH);
                const isBackground = element.type === 'background';
                const isContainer = ['containerWindowType', 'windowType'].includes(element.type);
                const elementScale = element.scale ?? 1;
                const width = isBackground ? parentW : (!isContainer && elementScale !== 1 ? Math.round(size.w * elementScale) : size.w);
                const height = isBackground ? parentH : (!isContainer && elementScale !== 1 ? Math.round(size.h * elementScale) : size.h);
                const topLeft = isBackground
                    ? { x: element.position.x, y: element.position.y }
                    : computeTopLeft(parentW, parentH, width, height,
                        element.orientation ?? '', element.origo ?? '',
                        element.position.x + (element.margin?.left ?? 0), element.position.y + (element.margin?.top ?? 0),
                        element.centerPosition ?? false, parentAnchorOverride);
                const div = document.createElement('div');
                div.className = 'manager-gui-element';
                div.dataset.path = path;
                div.dataset.line = String(element.line);
                div.dataset.type = element.type;
                div.style.left = `${topLeft.x}px`;
                div.style.top = `${topLeft.y}px`;
                div.style.width = `${Math.max(0, width)}px`;
                div.style.height = `${Math.max(0, height)}px`;
                div.style.borderColor = TYPE_COLORS[element.type] ?? '#727b88';
                if (element.alpha !== undefined) div.style.opacity = String(Math.max(0, Math.min(1, element.alpha)));
                if (element.clipping || ['smoothListboxType', 'listBoxType', 'listboxType'].includes(element.type)) div.style.overflow = 'hidden';
                if (element.rotation) {
                    div.style.transform = `rotate(${-(element.rotation * 180 / Math.PI)}deg)`;
                    div.style.transformOrigin = 'center center';
                }
                const name = document.createElement('span');
                name.className = 'manager-gui-element-name';
                name.textContent = element.name || '(unnamed)';
                div.append(name);
                if (element.text && ['instantTextBoxType', 'textboxType', 'editBoxType'].includes(element.type)) {
                    const text = document.createElement('span');
                    text.className = 'manager-gui-element-text';
                    text.textContent = element.text;
                    if (element.format === 'right') text.style.textAlign = 'right';
                    if (element.format === 'center' || element.format === 'centre') text.style.textAlign = 'center';
                    div.append(text);
                }
                if (element.spriteTexture) {
                    if (element.spriteTexture.startsWith('data:') || element.spriteTexture.includes('://')) {
                        const image = document.createElement('img');
                        image.className = 'manager-gui-element-image';
                        image.src = element.spriteTexture;
                        image.alt = '';
                        image.draggable = false;
                        applyGuiImageStyles(image, div, element);
                        image.onerror = () => { image.style.display = 'none'; };
                        div.append(image);
                    } else {
                        const reference = document.createElement('span');
                        reference.className = 'manager-gui-sprite-reference';
                        reference.textContent = element.spriteKey ?? element.spriteTexture;
                        div.append(reference);
                    }
                }
                div.addEventListener('click', event => {
                    if (this.marqueeMode || this.drag) return;
                    event.stopPropagation();
                    const additive = event.ctrlKey || event.metaKey;
                    const existing = this.selection.elements.some(item => item.path === path);
                    const next = additive
                        ? existing
                            ? this.selection.elements.filter(item => item.path !== path)
                            : [...this.selection.elements, createGuiElementReference(element, path, ancestors)]
                        : [createGuiElementReference(element, path, ancestors)];
                    this.setSelected(next, undefined, true);
                }, { signal: renderSignal });
                div.addEventListener('dblclick', event => {
                    event.stopPropagation();
                    this.options.onOpenSource(element.line);
                }, { signal: renderSignal });
                const absolute = {
                    left: offsetX + topLeft.x,
                    top: offsetY + topLeft.y,
                    right: offsetX + topLeft.x + width,
                    bottom: offsetY + topLeft.y + height,
                };
                this.rendered.set(path, { element, path, ancestors, div, bounds: absolute });
                parent.append(div);
                const orientation = normalizeOrientation(element.orientation ?? '');
                const [fx, fy] = ORIENTATION_FRACS[orientation] ?? [0, 0];
                const childAnchor = fx === 0.5 || fy === 0.5
                    ? { x: parentW / 2 - topLeft.x, y: parentH / 2 - topLeft.y }
                    : undefined;
                visit(element.children, div, width, height, path,
                    [...ancestors, element.name || element.type], absolute.left, absolute.top, childAnchor);
            });
        };
        visit(elements, fragment as unknown as HTMLElement, size.width, size.height, '', [], 0, 0);
        this.surface.append(fragment);
        for (const path of this.changedPaths) this.rendered.get(path)?.div.classList.add('is-agent-changed');
    }

    private setSelected(references: GuiSelection['elements'], region: GuiRegion | undefined, notify: boolean): void {
        const paths = new Set(references.map(item => item.path));
        const leafReferences = references.filter(item => ![...paths].some(other => other !== item.path && other.startsWith(item.path + '.')));
        this.selection = { elements: leafReferences.slice(0, 32), ...(region ? { region } : {}) };
        const selectedPaths = new Set(this.selection.elements.map(item => item.path));
        for (const item of this.rendered.values()) item.div.classList.toggle('is-selected', selectedPaths.has(item.path));
        if (notify) this.options.onSelection(this.selection);
    }

    private updateTransform(): void {
        this.surface.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
        this.element.style.setProperty('--manager-gui-zoom', String(this.scale));
    }

    private onWheel(event: WheelEvent): void {
        event.preventDefault();
        const rect = this.viewport.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const logicalX = (x - this.panX) / this.scale;
        const logicalY = (y - this.panY) / this.scale;
        const nextScale = Math.max(0.05, Math.min(4, this.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
        this.panX = x - logicalX * nextScale;
        this.panY = y - logicalY * nextScale;
        this.scale = nextScale;
        this.updateTransform();
    }

    private onPointerDown(event: PointerEvent): void {
        const panning = event.button === 1 || (event.button === 0 && event.altKey);
        const selecting = this.marqueeMode && event.button === 0;
        if (!panning && !selecting) return;
        event.preventDefault();
        this.viewport.setPointerCapture(event.pointerId);
        this.drag = { kind: panning ? 'pan' : 'marquee', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
        if (selecting) {
            const rect = this.viewport.getBoundingClientRect();
            this.marquee.hidden = false;
            this.marquee.style.left = `${event.clientX - rect.left}px`;
            this.marquee.style.top = `${event.clientY - rect.top}px`;
            this.marquee.style.width = '0px';
            this.marquee.style.height = '0px';
        }
    }

    private onPointerMove(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.kind === 'pan') {
            this.panX += event.clientX - drag.lastX;
            this.panY += event.clientY - drag.lastY;
            drag.lastX = event.clientX;
            drag.lastY = event.clientY;
            this.updateTransform();
            return;
        }
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        const rect = this.viewport.getBoundingClientRect();
        this.marquee.style.left = `${Math.min(drag.startX, event.clientX) - rect.left}px`;
        this.marquee.style.top = `${Math.min(drag.startY, event.clientY) - rect.top}px`;
        this.marquee.style.width = `${Math.abs(event.clientX - drag.startX)}px`;
        this.marquee.style.height = `${Math.abs(event.clientY - drag.startY)}px`;
    }

    private onPointerUp(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this.drag = undefined;
        this.marquee.hidden = true;
        if (this.viewport.hasPointerCapture(event.pointerId)) this.viewport.releasePointerCapture(event.pointerId);
        if (drag.kind !== 'marquee') return;
        const rect = this.viewport.getBoundingClientRect();
        const left = (Math.min(drag.startX, event.clientX) - rect.left - this.panX) / this.scale;
        const top = (Math.min(drag.startY, event.clientY) - rect.top - this.panY) / this.scale;
        const region: GuiRegion = {
            x: left,
            y: top,
            width: Math.abs(event.clientX - drag.startX) / this.scale,
            height: Math.abs(event.clientY - drag.startY) / this.scale,
        };
        const references = [...this.rendered.values()]
            .filter(item => intersects(item.bounds, region))
            .map(item => createGuiElementReference(item.element, item.path, item.ancestors));
        this.setSelected(references, region, true);
    }

    private cancelDrag(): void {
        this.drag = undefined;
        this.marquee.hidden = true;
    }
}
