import type { GuiElement } from '../shared/guiPreview';

export const ORIENTATION_FRACS: Record<string, [number, number]> = {
    'UPPER_LEFT': [0, 0], 'TOP_LEFT': [0, 0], 'LEFT_UP': [0, 0],
    'UPPER_CENTER': [0.5, 0], 'TOP': [0.5, 0], 'CENTER_UP': [0.5, 0],
    'CENTERUP': [0.5, 0], 'CENTERED_UP': [0.5, 0],
    'UPPER_RIGHT': [1, 0], 'TOP_RIGHT': [1, 0], 'RIGHT_UP': [1, 0],
    'CENTER_LEFT': [0, 0.5], 'CENTERED_LEFT': [0, 0.5], 'LEFT': [0, 0.5],
    'CENTER': [0.5, 0.5], 'CENTRE': [0.5, 0.5], 'CENTER_CENTER': [0.5, 0.5],
    'CENTER_RIGHT': [1, 0.5], 'CENTERED_RIGHT': [1, 0.5], 'RIGHT': [1, 0.5],
    'LOWER_LEFT': [0, 1], 'BOTTOM_LEFT': [0, 1], 'LEFT_DOWN': [0, 1],
    'LOWER_CENTER': [0.5, 1], 'BOTTOM': [0.5, 1], 'CENTER_DOWN': [0.5, 1],
    'CENTERED_DOWN': [0.5, 1],
    'LOWER_RIGHT': [1, 1], 'BOTTOM_RIGHT': [1, 1], 'RIGHT_DOWN': [1, 1],
};

const DEFAULT_SIZE: Record<string, [number, number]> = {
    containerWindowType: [200, 150], windowType: [200, 150], iconType: [32, 32],
    buttonType: [142, 34], effectButtonType: [142, 34], guiButtonType: [30, 30],
    instantTextBoxType: [200, 20], textboxType: [200, 80], editBoxType: [200, 30],
    checkboxType: [24, 24], checkBoxType: [24, 24], listBoxType: [200, 150],
    listboxType: [200, 150], smoothListboxType: [200, 150], scrollbarType: [20, 200],
    extendedScrollbarType: [20, 200], OverlappingElementsBoxType: [200, 30],
    gridBoxType: [200, 200], dropDownBoxType: [200, 30], spinnerType: [120, 30],
    positionType: [0, 0], scrollAreaType: [200, 150], expandButton: [142, 30],
    expandedWindow: [200, 150], browserType: [200, 150],
};

export const GUI_OFF_CANVAS_THRESHOLD = 5_000;

export function normalizeOrientation(raw: string): string {
    return (raw || '').trim().replace(/['"]/g, '').toUpperCase().replace(/[-\s]+/g, '_');
}

export function isOffCanvasElement(el: GuiElement): boolean {
    return Math.abs(el.position.x) >= GUI_OFF_CANVAS_THRESHOLD || Math.abs(el.position.y) >= GUI_OFF_CANVAS_THRESHOLD;
}

export function computeTopLeft(
    parentW: number, parentH: number, widgetW: number, widgetH: number,
    orientation: string, origo: string, posX: number, posY: number,
    centerPosition: boolean, parentAnchorOverride?: { x: number; y: number },
): { x: number; y: number } {
    const fraction = (value: string): [number, number] => ORIENTATION_FRACS[normalizeOrientation(value)] ?? [0, 0];
    const [fx, fy] = fraction(orientation);
    const anchor = parentAnchorOverride
        ? {
            x: fx === 0.5 ? parentAnchorOverride.x : parentW * fx,
            y: fy === 0.5 ? parentAnchorOverride.y : parentH * fy,
        }
        : { x: parentW * fx, y: parentH * fy };
    const [ox, oy] = fraction(centerPosition ? 'CENTER' : origo);
    return {
        x: anchor.x + posX - widgetW * ox,
        y: anchor.y + posY - widgetH * oy,
    };
}

export function effectiveSize(el: GuiElement, parentW = 0, parentH = 0): { w: number; h: number } {
    let w = el.size.width;
    let h = el.size.height;
    if (el.percentWidth && parentW > 0) w = Math.round(parentW * w / 100);
    if (el.percentHeight && parentH > 0) h = Math.round(parentH * h / 100);
    if (w < 0 && parentW > 0) w = parentW + w;
    if (h < 0 && parentH > 0) h = parentH + h;
    if (el.margin) {
        if (w > 0) w -= el.margin.left + el.margin.right;
        if (h > 0) h -= el.margin.top + el.margin.bottom;
    }
    const isCorneredTile = el.spriteDefType === 'corneredTileSpriteType';
    const isFixedSprite = !isCorneredTile && (
        el.spriteAttr === 'spriteType'
        || (el.spriteAttr === 'quadTextureSprite' && el.spriteDefType === 'spriteType')
    );
    if (isFixedSprite && el.textureWidth && el.textureHeight) {
        const width = el.noOfFrames && el.noOfFrames > 1
            ? Math.round(el.textureWidth / el.noOfFrames)
            : el.textureWidth;
        return { w: width, h: el.textureHeight };
    }
    if (['instantTextBoxType', 'textboxType', 'editBoxType'].includes(el.type)) {
        if (el.maxWidth) w = el.maxWidth;
        if (el.maxHeight) h = el.maxHeight;
    } else {
        if (w <= 0 && el.maxWidth) w = el.maxWidth;
        if (h <= 0 && el.maxHeight) h = el.maxHeight;
    }
    if (w <= 0 && el.textureWidth) {
        w = el.noOfFrames && el.noOfFrames > 1
            ? Math.round(el.textureWidth / el.noOfFrames)
            : el.textureWidth;
    }
    if (h <= 0 && el.textureHeight) h = el.textureHeight;
    const isContainerType = ['containerWindowType', 'windowType', 'scrollAreaType', 'dropDownBoxType', 'expandedWindow'].includes(el.type);
    if (isContainerType && (w <= 0 || h <= 0)) {
        if (w <= 0 && parentW > 0) w = parentW;
        if (h <= 0 && parentH > 0) h = parentH;
        if ((w <= 0 || h <= 0) && el.children.length > 0) {
            let maxR = 0;
            let maxB = 0;
            for (const child of el.children) {
                if (child.type === 'background' || isOffCanvasElement(child)) continue;
                const size = effectiveSize(child);
                maxR = Math.max(maxR, Math.max(0, child.position.x) + size.w);
                maxB = Math.max(maxB, Math.max(0, child.position.y) + size.h);
            }
            if (w <= 0) w = maxR + 10;
            if (h <= 0) h = maxB + 10;
        }
    }
    if (w <= 0 || h <= 0) {
        const fallback = DEFAULT_SIZE[el.type] ?? [60, 24];
        if (w <= 0) w = fallback[0];
        if (h <= 0) h = fallback[1];
    }
    return { w, h };
}

export function computeGuiCanvasSize(elements: GuiElement[]): { width: number; height: number } {
    let maxR = 0;
    let maxB = 0;
    let anchored = false;
    for (const element of elements) {
        if (isOffCanvasElement(element)) continue;
        const orientation = normalizeOrientation(element.orientation ?? '');
        if (orientation && !['UPPER_LEFT', 'TOP_LEFT', 'LEFT_UP'].includes(orientation)) {
            anchored = true;
            continue;
        }
        const size = effectiveSize(element);
        maxR = Math.max(maxR, Math.max(0, element.position.x) + size.w);
        maxB = Math.max(maxB, Math.max(0, element.position.y) + size.h);
    }
    return anchored
        ? { width: Math.max(1920, maxR + 50), height: Math.max(1080, maxB + 50) }
        : { width: Math.max(800, maxR + 50), height: Math.max(600, maxB + 50) };
}
