/**
 * GUI Preview Webview - renders Paradox GUI elements visually.
 * Runs inside the VS Code webview context.
 */

interface vscode { postMessage(message: unknown): void; }
declare const acquireVsCodeApi: () => vscode;
const vscode: vscode = acquireVsCodeApi();

// ─── Types ──────────────────────────────────────────────────────────────────

interface GuiElement {
    type: string;
    name: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    sizeExplicit?: boolean;
    percentWidth?: boolean;
    percentHeight?: boolean;
    orientation?: string;
    origo?: string;
    clipping?: boolean;
    alwaysTransparent?: boolean;
    spriteKey?: string;
    spriteAttr?: 'spriteType' | 'quadTextureSprite';
    spriteTexture?: string;
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

// ─── Colors ─────────────────────────────────────────────────────────────────

const COLORS: Record<string, { bg: string; border: string; tag: string }> = {
    containerWindowType: { bg: 'rgba(80,110,160,0.12)', border: '#4a6a9a', tag: 'Container' },
    buttonType:          { bg: 'rgba(60,120,210,0.18)', border: '#3c78d2', tag: 'Button' },
    effectButtonType:    { bg: 'rgba(90,60,190,0.18)', border: '#5a3cbe', tag: 'EffectBtn' },
    guiButtonType:       { bg: 'rgba(60,120,210,0.18)', border: '#3c78d2', tag: 'GuiBtn' },
    iconType:            { bg: 'rgba(60,170,80,0.18)', border: '#3caa50', tag: 'Icon' },
    instantTextBoxType:  { bg: 'rgba(210,150,40,0.18)', border: '#d29628', tag: 'Text' },
    textboxType:         { bg: 'rgba(210,150,40,0.18)', border: '#d29628', tag: 'TextBox' },
    editBoxType:         { bg: 'rgba(190,130,50,0.18)', border: '#be8232', tag: 'Edit' },
    smoothListboxType:   { bg: 'rgba(140,90,170,0.15)', border: '#8c5aaa', tag: 'List' },
    listBoxType:         { bg: 'rgba(140,90,170,0.15)', border: '#8c5aaa', tag: 'List' },
    listboxType:         { bg: 'rgba(140,90,170,0.15)', border: '#8c5aaa', tag: 'List' },
    scrollbarType:       { bg: 'rgba(110,110,110,0.15)', border: '#6e6e6e', tag: 'Scroll' },
    extendedScrollbarType: { bg: 'rgba(110,110,110,0.15)', border: '#6e6e6e', tag: 'ExtScroll' },
    checkboxType:        { bg: 'rgba(40,170,170,0.18)', border: '#28aaaa', tag: 'Check' },
    background:          { bg: 'rgba(30,30,50,0.35)', border: '#2a2a40', tag: 'BG' },
    gridBoxType:         { bg: 'rgba(160,120,60,0.15)', border: '#a0783c', tag: 'Grid' },
    windowType:          { bg: 'rgba(80,110,160,0.12)', border: '#4a6a9a', tag: 'Window' },
    dropDownBoxType:     { bg: 'rgba(100,140,180,0.15)', border: '#648cb4', tag: 'DropDown' },
    spinnerType:         { bg: 'rgba(120,100,160,0.15)', border: '#7864a0', tag: 'Spinner' },
    OverlappingElementsBoxType: { bg: 'rgba(130,130,80,0.15)', border: '#828250', tag: 'Overlap' },
    positionType:        { bg: 'rgba(90,90,90,0.10)', border: '#5a5a5a', tag: 'Pos' },
    browserType:         { bg: 'rgba(80,80,120,0.15)', border: '#505078', tag: 'Browser' },
    scrollAreaType:      { bg: 'rgba(80,130,170,0.15)', border: '#5082aa', tag: 'ScrollArea' },
    expandButton:        { bg: 'rgba(180,100,40,0.18)', border: '#b46428', tag: 'Expand' },
    expandedWindow:      { bg: 'rgba(130,90,50,0.15)', border: '#825a32', tag: 'ExpandWin' },
    checkBoxType:        { bg: 'rgba(40,170,170,0.18)', border: '#28aaaa', tag: 'Check' },
    overlappingElementsBoxType: { bg: 'rgba(130,130,80,0.15)', border: '#828250', tag: 'Overlap' },
};
const DEFAULT_COLOR = { bg: 'rgba(90,90,90,0.15)', border: '#5a5a5a', tag: '?' };

// ─── Viewport State ─────────────────────────────────────────────────────────

let scale = 0.8;
let panX = 20;
let panY = 60;
let isDragging = false;
let lastMX = 0, lastMY = 0;

function updateTransform() {
    const c = document.getElementById('canvas-container')!;
    c.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    document.getElementById('zoom-level')!.textContent = `${Math.round(scale * 100)}%`;
}

// ─── Image Helpers ────────────────────────────────────────────────────────────

function applyImageStyles(img: HTMLImageElement, div: HTMLElement, el: GuiElement) {
    // VS Code Webviews globally apply `img { max-width: 100%; }` which breaks multi-frame scaling
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';

    if (el.spriteDefType === 'corneredTileSpriteType') {
        const bx = el.borderSize?.x ?? 0;
        const by = el.borderSize?.y ?? 0;

        if (bx > 0 || by > 0) {
            // Canvas-based 9-slice (CSS border-image unreliable with data: URIs in webview)
            img.style.display = 'none';

            const drawNineSlice = () => {
                const canvas = document.createElement('canvas');
                canvas.style.position = 'absolute';
                canvas.style.top = '0';
                canvas.style.left = '0';
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.pointerEvents = 'none';
                canvas.style.opacity = '0.90';

                const dw = div.offsetWidth || parseInt(div.style.width) || 200;
                const dh = div.offsetHeight || parseInt(div.style.height) || 200;
                canvas.width = dw;
                canvas.height = dh;

                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const sw = img.naturalWidth;
                const sh = img.naturalHeight;
                if (sw === 0 || sh === 0) return;

                const sl = Math.min(bx, sw / 2);
                const sr = Math.min(bx, sw / 2);
                const st = Math.min(by, sh / 2);
                const sb = Math.min(by, sh / 2);
                const scw = sw - sl - sr;
                const sch = sh - st - sb;

                const dl = Math.min(bx, dw / 2);
                const dr = Math.min(bx, dw / 2);
                const dt = Math.min(by, dh / 2);
                const db = Math.min(by, dh / 2);
                const dcw = dw - dl - dr;
                const dch = dh - dt - db;

                // Top-left, top-center, top-right
                if (sl > 0 && st > 0) ctx.drawImage(img, 0, 0, sl, st, 0, 0, dl, dt);
                if (scw > 0 && st > 0) ctx.drawImage(img, sl, 0, scw, st, dl, 0, dcw, dt);
                if (sr > 0 && st > 0) ctx.drawImage(img, sw - sr, 0, sr, st, dw - dr, 0, dr, dt);
                // Mid-left, center, mid-right
                if (sl > 0 && sch > 0) ctx.drawImage(img, 0, st, sl, sch, 0, dt, dl, dch);
                if (scw > 0 && sch > 0) ctx.drawImage(img, sl, st, scw, sch, dl, dt, dcw, dch);
                if (sr > 0 && sch > 0) ctx.drawImage(img, sw - sr, st, sr, sch, dw - dr, dt, dr, dch);
                // Bot-left, bot-center, bot-right
                if (sl > 0 && sb > 0) ctx.drawImage(img, 0, sh - sb, sl, sb, 0, dh - db, dl, db);
                if (scw > 0 && sb > 0) ctx.drawImage(img, sl, sh - sb, scw, sb, dl, dh - db, dcw, db);
                if (sr > 0 && sb > 0) ctx.drawImage(img, sw - sr, sh - sb, sr, sb, dw - dr, dh - db, dr, db);

                div.appendChild(canvas);
            };

            if (img.complete && img.naturalWidth > 0) {
                requestAnimationFrame(() => drawNineSlice());
            } else {
                img.onload = () => requestAnimationFrame(() => drawNineSlice());
            }
        } else {
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'fill';
        }
    } else if (el.noOfFrames && el.noOfFrames > 1) {
        img.style.width = `${el.noOfFrames * 100}%`;
        img.style.height = '100%';
        img.style.objectFit = 'fill';
        let f = 0;
        if (el.frame !== undefined && el.frame > 0) {
            f = el.frame - 1;
        }
        f = Math.max(0, Math.min(f, el.noOfFrames - 1));
        img.style.left = `-${f * 100}%`; 
        div.style.overflow = 'hidden';
    }
}

// ─── PDX Layout Engine ──────────────────────────────────────────────────────

// Orientation/origo → fraction of parent/widget size
// Maps orientation string to (fx, fy) where anchor = (parent_w * fx, parent_h * fy)
const ORIENTATION_FRACS: Record<string, [number, number]> = {
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

function normalizeOrientation(raw: string): string {
    return (raw || '').trim().replace(/['"]/g, '').toUpperCase().replace(/[-\s]+/g, '_');
}

/** Anchor point in parent coordinates from orientation */
function orientationToAnchor(parentW: number, parentH: number, orientation: string): { x: number; y: number } {
    const [fx, fy] = ORIENTATION_FRACS[normalizeOrientation(orientation)] ?? [0, 0];
    return { x: parentW * fx, y: parentH * fy };
}

/** Origo offset: distance from widget top-left to the origo point */
function origoToOffset(widgetW: number, widgetH: number, origo: string): { x: number; y: number } {
    const [fx, fy] = ORIENTATION_FRACS[normalizeOrientation(origo)] ?? [0, 0];
    return { x: widgetW * fx, y: widgetH * fy };
}

/**
 * PDX core layout formula:
 *   top_left = anchor + position - origo_offset
 * centerPosition = yes acts as origo = CENTER
 */
function computeTopLeft(
    parentW: number, parentH: number,
    widgetW: number, widgetH: number,
    orientation: string, origo: string,
    posX: number, posY: number,
    centerPosition: boolean,
): { x: number; y: number } {
    const anchor = orientationToAnchor(parentW, parentH, orientation);
    const effectiveOrigo = centerPosition ? 'CENTER' : origo;
    const offset = origoToOffset(widgetW, widgetH, effectiveOrigo);
    return {
        x: anchor.x + posX - offset.x,
        y: anchor.y + posY - offset.y,
    };
}

// ─── Default Sizes (from Stellaris reference) ───────────────────────────────

const DEFAULT_SIZE: Record<string, [number, number]> = {
    'containerWindowType': [200, 150],
    'windowType': [200, 150],
    'iconType': [32, 32],
    'buttonType': [142, 34],
    'effectButtonType': [142, 34],
    'guiButtonType': [30, 30],
    'instantTextBoxType': [200, 20],
    'textboxType': [200, 80],
    'editBoxType': [200, 30],
    'checkboxType': [24, 24],
    'checkBoxType': [24, 24],
    'listBoxType': [200, 150],
    'listboxType': [200, 150],
    'smoothListboxType': [200, 150],
    'scrollbarType': [20, 200],
    'extendedScrollbarType': [20, 200],
    'OverlappingElementsBoxType': [200, 30],
    'gridBoxType': [200, 200],
    'dropDownBoxType': [200, 30],
    'spinnerType': [120, 30],
    'positionType': [0, 0],
    'scrollAreaType': [200, 150],
    'expandButton': [142, 30],
    'expandedWindow': [200, 150],
    'browserType': [200, 150],
};

/**
 * Determine the effective display size of a widget.
 * 
 * PDX Rules (from gui_model.py / widget_items.py):
 *   - spriteType attr: size = natural_image_size × scale. Widget 'size' is IGNORED.
 *   - quadTextureSprite w/ corneredTileSpriteType: size = widget's declared size (9-patch)
 *   - quadTextureSprite w/ plain spriteType in GFX: size = natural_image_size × scale
 *   - background: fills parent container
 *   - Negative size values: parent_size + value (e.g. -20 → parent - 20)
 *   - instantTextBoxType: maxWidth/maxHeight take priority as dimensions
 */
function effectiveSize(el: GuiElement, parentW = 0, parentH = 0): { w: number; h: number } {
    let w = el.size.width;
    let h = el.size.height;

    // Handle percentage sizes (e.g. width = 100% → parent width)
    if (el.percentWidth && parentW > 0) {
        w = Math.round(parentW * w / 100);
    }
    if (el.percentHeight && parentH > 0) {
        h = Math.round(parentH * h / 100);
    }

    // Handle negative size (parent - N)
    if (w < 0 && parentW > 0) w = parentW + w;
    if (h < 0 && parentH > 0) h = parentH + h;

    // Apply margin reduction
    if (el.margin) {
        if (w > 0) w = w - el.margin.left - el.margin.right;
        if (h > 0) h = h - el.margin.top - el.margin.bottom;
    }

    // Determine render mode:
    // 1. spriteType attribute → fixed (natural image size), ignore widget size
    // 2. quadTextureSprite → check GFX registry:
    //    - corneredTileSpriteType / textSpriteType → widget size
    //    - spriteType in GFX → fixed (natural image size)
    // NOTE: scale is NOT applied here — it's purely visual (CSS transform)
    // Special: corneredTileSpriteType ALWAYS uses widget size, even when called via spriteType attr
    const isCorneredTile = el.spriteDefType === 'corneredTileSpriteType';
    const isFixedSprite = !isCorneredTile && (
        el.spriteAttr === 'spriteType' ||
        (el.spriteAttr === 'quadTextureSprite' &&
         el.spriteDefType === 'spriteType')
    );
    if (isFixedSprite && el.textureWidth && el.textureHeight) {
        let tw = el.textureWidth;
        if (el.noOfFrames && el.noOfFrames > 1) {
            tw = Math.round(tw / el.noOfFrames);
        }
        return { w: tw, h: el.textureHeight };
    }

    // instantTextBoxType uses maxWidth/maxHeight as its actual dimensions
    if (el.type === 'instantTextBoxType' || el.type === 'textboxType' || el.type === 'editBoxType') {
        if (el.maxWidth) w = el.maxWidth;
        if (el.maxHeight) h = el.maxHeight;
    } else {
        if (w <= 0 && el.maxWidth) w = el.maxWidth;
        if (h <= 0 && el.maxHeight) h = el.maxHeight;
    }

    // Use texture dimensions when explicit size is missing
    if (w <= 0 && el.textureWidth) {
        w = el.textureWidth;
        if (el.noOfFrames && el.noOfFrames > 1) {
            w = Math.round(w / el.noOfFrames);
        }
    }
    if (h <= 0 && el.textureHeight) h = el.textureHeight;

    // Container sizing: PDX containers without explicit size inherit parent dimensions
    const isContainerType = el.type === 'containerWindowType' || el.type === 'windowType'
        || el.type === 'scrollAreaType' || el.type === 'dropDownBoxType' || el.type === 'expandedWindow';
    if (isContainerType && (w <= 0 || h <= 0)) {
        // First try: inherit parent size
        if (w <= 0 && parentW > 0) w = parentW;
        if (h <= 0 && parentH > 0) h = parentH;
        // Fallback: auto-size from children bounding box (when parent size unknown)
        if ((w <= 0 || h <= 0) && el.children.length > 0) {
            let maxR = 0, maxB = 0;
            for (const ch of el.children) {
                if (ch.type === 'background') continue;
                if (Math.abs(ch.position.x) > 5000 || Math.abs(ch.position.y) > 5000) continue;
                const cs = effectiveSize(ch);
                const r = Math.max(0, ch.position.x) + cs.w;
                const b = Math.max(0, ch.position.y) + cs.h;
                if (r > maxR) maxR = r;
                if (b > maxB) maxB = b;
            }
            if (w <= 0) w = maxR + 10;
            if (h <= 0) h = maxB + 10;
        }
    }

    // Type-specific defaults
    if (w <= 0 || h <= 0) {
        const def = DEFAULT_SIZE[el.type] ?? [60, 24];
        if (w <= 0) w = def[0];
        if (h <= 0) h = def[1];
    }

    return { w, h };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderElement(el: GuiElement, parent: HTMLElement, parentW = 0, parentH = 0): HTMLElement {
    const c = COLORS[el.type] ?? DEFAULT_COLOR;
    const { w, h } = effectiveSize(el, parentW, parentH);

    // Skip elements with position > 5000 (off-screen, used for game logic)
    if (Math.abs(el.position.x) > 5000 || Math.abs(el.position.y) > 5000) {
        const placeholder = document.createElement('div');
        placeholder.style.display = 'none';
        parent.appendChild(placeholder);
        return placeholder;
    }

    // size = { width = 0 height = 0 } on containerWindowType means hidden in PDX
    if (el.sizeExplicit && el.size.width === 0 && el.size.height === 0
        && (el.type === 'containerWindowType' || el.type === 'windowType')) {
        const placeholder = document.createElement('div');
        placeholder.style.display = 'none';
        parent.appendChild(placeholder);
        return placeholder;
    }

    const div = document.createElement('div');
    div.className = 'el';
    div.dataset.line = String(el.line);
    
    if (el.alwaysTransparent) {
        div.classList.add('always-transparent');
    }
    // PDX containers only clip when clipping = yes; listboxes always clip
    if (el.clipping || el.type === 'smoothListboxType' || el.type === 'listBoxType' || el.type === 'listboxType') {
        div.style.overflow = 'hidden';
    }

    // Background fills its parent
    if (el.type === 'background') {
        div.classList.add('el-bg');
        if (el.position.x !== 0 || el.position.y !== 0) {
            div.style.left = `${el.position.x}px`;
            div.style.top = `${el.position.y}px`;
        }

        if (el.spriteTexture && (el.spriteTexture.startsWith('data:') || el.spriteTexture.includes('://'))) {
            const img = document.createElement('img');
            img.className = 'el-img';
            img.src = el.spriteTexture;
            if (el.spriteDefType === 'corneredTileSpriteType') {
                // corneredTileSpriteType: stretch to fill parent container
                img.style.objectFit = 'fill';
                img.style.maxWidth = 'none';
                img.style.maxHeight = 'none';
            } else {
                // spriteType: display at original texture dimensions
                if (el.textureWidth && el.textureHeight) {
                    img.style.width = `${el.textureWidth}px`;
                    img.style.height = `${el.textureHeight}px`;
                    img.style.objectFit = 'fill';
                }
            }
            // Don't run applyImageStyles for background — simple fill is sufficient
            div.appendChild(img);
            div.style.backgroundColor = c.bg;
            div.style.borderColor = c.border;
        } else if (el.spriteKey) {
            div.style.backgroundColor = c.bg;
            div.style.borderColor = c.border;
            const lbl = document.createElement('span');
            lbl.className = 'sprite-ref';
            lbl.textContent = el.spriteKey;
            div.appendChild(lbl);
        } else {
            div.style.backgroundColor = c.bg;
            div.style.borderColor = c.border;
        }

        parent.appendChild(div);
        return div;
    }

    // ── PDX Layout: compute pixel-accurate top-left ──
    // Apply margin offset to position
    const marginLeft = el.margin?.left ?? 0;
    const marginTop = el.margin?.top ?? 0;
    const tl = computeTopLeft(
        parentW, parentH, w, h,
        el.orientation ?? '', el.origo ?? '',
        el.position.x + marginLeft, el.position.y + marginTop,
        el.centerPosition ?? false,
    );

    div.style.left = `${tl.x}px`;
    div.style.top = `${tl.y}px`;
    div.style.width = `${w}px`;
    div.style.height = `${h}px`;

    // Scale: apply directly to dimensions (NOT via CSS transform) so resize handles stay normally sized
    // PDX: scale does NOT apply to containerWindowType/windowType, only to controls within
    const transforms: string[] = [];
    const isContainer = el.type === 'containerWindowType' || el.type === 'windowType';
    const elScale = el.scale ?? 1;
    if (elScale !== 1 && !isContainer) {
        // Apply scale to the div's actual dimensions
        const scaledW = Math.round(w * elScale);
        const scaledH = Math.round(h * elScale);
        div.style.width = `${scaledW}px`;
        div.style.height = `${scaledH}px`;
    }
    // PDX rotation: radians, negative sign convention (negate for CSS)
    // Rotation pivot: center of widget rect (matching game engine behavior)
    if (el.rotation && el.rotation !== 0) {
        const degrees = -(el.rotation * 180 / Math.PI);
        transforms.push(`rotate(${degrees}deg)`);
    }
    if (transforms.length > 0) {
        div.style.transform = transforms.join(' ');
    }
    // PDX: scale from top-left normally, but center when centerPosition or rotation
    if ((el.rotation && el.rotation !== 0) || (el.centerPosition && elScale !== 1)) {
        div.style.transformOrigin = 'center center';
    } else {
        div.style.transformOrigin = '0 0';
    }

    // Alpha / opacity
    if (el.alpha !== undefined && el.alpha !== 1) {
        div.style.opacity = String(Math.max(0, Math.min(1, el.alpha)));
    }

    div.style.backgroundColor = c.bg;
    div.style.borderColor = c.border;

    // Name label
    const nameLabel = document.createElement('div');
    nameLabel.className = 'el-name';
    nameLabel.textContent = el.name || '(no name)';
    nameLabel.style.color = c.border;
    div.appendChild(nameLabel);

    // Type tag
    const tag = document.createElement('span');
    tag.className = 'el-tag';
    tag.textContent = c.tag;
    tag.style.borderColor = c.border;
    tag.style.color = c.border;
    div.appendChild(tag);

    // Text content
    if (el.text && ['instantTextBoxType', 'textboxType', 'editBoxType'].includes(el.type)) {
        const td = document.createElement('div');
        td.className = 'el-text';
        td.textContent = el.text;
        if (el.format === 'center' || el.format === 'centre') td.style.textAlign = 'center';
        else if (el.format === 'right') td.style.textAlign = 'right';
        div.appendChild(td);
    }

    // Sprite / texture display
    if (el.spriteTexture) {
        if (el.spriteTexture.startsWith('dds:') || el.spriteTexture.startsWith('tga:')) {
            // DDS decode failed / TGA - show placeholder
            const texPath = el.spriteTexture.substring(4);
            div.classList.add('has-texture');
            const sl = document.createElement('span');
            sl.className = 'sprite-ref';
            sl.textContent = `📦 ${el.spriteKey ?? texPath}`;
            sl.title = texPath;
            div.appendChild(sl);
        } else if (el.spriteTexture.startsWith('data:') || el.spriteTexture.includes('://')) {
            // Decoded DDS (data URI) or webview URI - display as image
            const img = document.createElement('img');
            img.className = 'el-img';
            img.src = el.spriteTexture;
            
            // Apply specific multi-frame or tile logic
            applyImageStyles(img, div, el);
            
            img.onerror = () => { img.style.display = 'none'; };
            div.appendChild(img);
        } else {
            // Unresolved texture ref
            const sl = document.createElement('span');
            sl.className = 'sprite-ref';
            sl.textContent = el.spriteKey ?? el.spriteTexture;
            div.appendChild(sl);
        }
    } else if (el.spriteKey) {
        const sl = document.createElement('span');
        sl.className = 'sprite-ref';
        sl.textContent = el.spriteKey;
        div.appendChild(sl);
    }

    // Hover tooltip (only in non-edit mode)
    div.addEventListener('mouseenter', (e) => {
        if (editMode) return;
        e.stopPropagation(); showTip(el, e); div.classList.add('hover');
    });
    div.addEventListener('mouseleave', (e) => {
        if (editMode) return;
        e.stopPropagation(); hideTip(); div.classList.remove('hover');
    });
    div.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editMode) {
            if (e.ctrlKey) {
                toggleSelection(el, div);
            } else {
                selectElement(el, div);
            }
        } else {
            vscode.postMessage({ command: 'goToLine', line: el.line });
        }
    });

    // Edit mode: drag to move (skip if Ctrl held — Ctrl is for multi-select)
    div.addEventListener('mousedown', (e) => {
        if (!editMode || e.button !== 0 || e.altKey || e.ctrlKey) return;
        if ((e.target as HTMLElement).classList.contains('resize-handle')) return;
        e.stopPropagation();
        e.preventDefault();
        startDrag(el, div, e);
    });

    // Store DOM ↔ data mapping
    elMap.set(el.line, { el, div });

    // Render children (pass this element's size as parent dimensions)
    for (const child of el.children) {
        renderElement(child, div, w, h);
    }

    parent.appendChild(div);
    return div;
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

function showTip(el: GuiElement, e: MouseEvent) {
    const t = document.getElementById('tooltip')!;
    const c = COLORS[el.type] ?? DEFAULT_COLOR;
    const { w, h } = effectiveSize(el);
    let html = `<div class="tip-type" style="color:${c.border}">${c.tag}</div>`;
    html += `<div class="tip-name">${el.name || '(unnamed)'}</div>`;
    html += `<table>`;
    html += `<tr><td>Pos</td><td>(${el.position.x}, ${el.position.y})</td></tr>`;
    html += `<tr><td>Size</td><td>${w} × ${h}</td></tr>`;
    if (el.orientation) html += `<tr><td>Orient</td><td>${el.orientation}</td></tr>`;
    if (el.origo) html += `<tr><td>Origo</td><td>${el.origo}</td></tr>`;
    if (el.scale !== undefined && el.scale !== 1) html += `<tr><td>Scale</td><td>${el.scale}</td></tr>`;
    if (el.rotation !== undefined && el.rotation !== 0) html += `<tr><td>Rotation</td><td>${el.rotation} rad</td></tr>`;
    if (el.alpha !== undefined && el.alpha !== 1) html += `<tr><td>Alpha</td><td>${el.alpha}</td></tr>`;
    if (el.centerPosition) html += `<tr><td>CenterPos</td><td>yes</td></tr>`;
    if (el.spriteKey) html += `<tr><td>Sprite</td><td>${el.spriteKey}</td></tr>`;
    if (el.spriteTexture) {
        const texPath = el.spriteTexture.startsWith('dds:') || el.spriteTexture.startsWith('tga:')
            ? el.spriteTexture.substring(4) : el.spriteTexture;
        html += `<tr><td>Texture</td><td>${texPath}</td></tr>`;
    }
    if (el.text) html += `<tr><td>Text</td><td>${el.text}</td></tr>`;
    if (el.font) html += `<tr><td>Font</td><td>${el.font}</td></tr>`;
    for (const [k, v] of Object.entries(el.properties)) {
        html += `<tr><td>${k}</td><td>${v}</td></tr>`;
    }
    html += `</table>`;
    html += `<div class="tip-line">Line ${el.line} · Click to jump</div>`;
    t.innerHTML = html;
    t.classList.remove('hidden');
    t.style.left = `${e.clientX + 14}px`;
    t.style.top = `${e.clientY + 14}px`;
    requestAnimationFrame(() => {
        const r = t.getBoundingClientRect();
        if (r.right > window.innerWidth) t.style.left = `${e.clientX - r.width - 14}px`;
        if (r.bottom > window.innerHeight) t.style.top = `${e.clientY - r.height - 14}px`;
    });
}

function hideTip() { document.getElementById('tooltip')!.classList.add('hidden'); }

// ─── Top-level Layout ───────────────────────────────────────────────────────

function renderAll(elements: GuiElement[], fileName: string) {
    const root = document.getElementById('gui-root')!;
    root.innerHTML = '';
    document.getElementById('title')!.textContent = `GUI Preview: ${fileName}`;

    // Calculate canvas size
    let maxR = 0, maxB = 0;
    for (const el of elements) {
        // Skip elements with extreme positions (hidden off-screen)
        if (Math.abs(el.position.x) > 5000 || Math.abs(el.position.y) > 5000) continue;
        const { w, h } = effectiveSize(el);
        const r = Math.max(0, el.position.x) + w;
        const b = Math.max(0, el.position.y) + h;
        if (r > maxR) maxR = r;
        if (b > maxB) maxB = b;
    }

    const screenW = Math.max(800, maxR + 50);
    const screenH = Math.max(600, maxB + 50);

    const canvas = document.createElement('div');
    canvas.className = 'card-body';
    canvas.style.width = `${screenW}px`;
    canvas.style.height = `${screenH}px`;
    canvas.style.position = 'relative';
    canvas.style.backgroundColor = 'rgba(20,20,30,0.5)';
    canvas.style.border = '1px solid #444';
    canvas.style.margin = '20px auto';
    canvas.style.overflow = 'visible';

    for (const el of elements) {
        renderElement(el, canvas, screenW, screenH);
    }
    
    root.appendChild(canvas);
    // Only fit to view on first render; preserve pan/zoom on re-renders
    if (!hasRendered) {
        hasRendered = true;
        requestAnimationFrame(fitToView);
    }
}

// ─── Viewport ───────────────────────────────────────────────────────────────

function fitToView() {
    const root = document.getElementById('gui-root')!;
    const vp = document.getElementById('viewport')!;
    if (!root.firstChild) return;
    const vpR = vp.getBoundingClientRect();
    // Measure content at scale=1
    const oldT = document.getElementById('canvas-container')!.style.transform;
    document.getElementById('canvas-container')!.style.transform = 'translate(0,0) scale(1)';
    const rR = root.getBoundingClientRect();
    document.getElementById('canvas-container')!.style.transform = oldT;
    if (rR.width === 0 || rR.height === 0) return;
    scale = Math.min((vpR.width - 40) / rR.width, (vpR.height - 40) / rR.height, 1.5);
    panX = 20;
    panY = 20;
    updateTransform();
}

function setupControls() {
    const vp = document.getElementById('viewport')!;

    vp.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            isDragging = true;
            lastMX = e.clientX;
            lastMY = e.clientY;
            vp.style.cursor = 'grabbing';
            e.preventDefault();
        }
        // Click on empty area in edit mode → deselect
        if (editMode && e.button === 0 && !e.altKey && (e.target === vp || (e.target as HTMLElement).id === 'canvas-container' || (e.target as HTMLElement).id === 'gui-root' || (e.target as HTMLElement).classList.contains('card-body'))) {
            clearSelection();
        }
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX += e.clientX - lastMX;
        panY += e.clientY - lastMY;
        lastMX = e.clientX;
        lastMY = e.clientY;
        updateTransform();
    });
    window.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; document.getElementById('viewport')!.style.cursor = ''; }
    });

    vp.addEventListener('wheel', (e) => {
        e.preventDefault();
        const d = e.deltaY > 0 ? -0.08 : 0.08;
        const ns = Math.max(0.1, Math.min(5, scale + d));
        const rect = vp.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        panX = mx - (mx - panX) * (ns / scale);
        panY = my - (my - panY) * (ns / scale);
        scale = ns;
        updateTransform();
    }, { passive: false });

    document.getElementById('btn-zoom-in')!.onclick = () => { scale = Math.min(5, scale + 0.2); updateTransform(); };
    document.getElementById('btn-zoom-out')!.onclick = () => { scale = Math.max(0.1, scale - 0.2); updateTransform(); };
    document.getElementById('btn-fit')!.onclick = fitToView;
    document.getElementById('btn-reset')!.onclick = () => { scale = 1; panX = 20; panY = 20; updateTransform(); };
    document.getElementById('btn-preview')!.onclick = () => {
        document.body.classList.toggle('preview-mode');
        document.getElementById('btn-preview')!.classList.toggle('active');
    };
    document.getElementById('btn-edit')!.onclick = toggleEditMode;
    document.getElementById('btn-layers')!.onclick = () => {
        const sp = document.getElementById('side-panel')!;
        sp.classList.toggle('hidden');
        document.getElementById('btn-layers')!.classList.toggle('active');
    };
    document.getElementById('layers-collapse-all')!.onclick = () => {
        document.querySelectorAll('.layer-children').forEach(el => el.classList.add('collapsed'));
        document.querySelectorAll('.layer-expand').forEach(el => el.textContent = '▸');
    };
    document.getElementById('layers-expand-all')!.onclick = () => {
        document.querySelectorAll('.layer-children').forEach(el => el.classList.remove('collapsed'));
        document.querySelectorAll('.layer-expand').forEach(el => el.textContent = '▾');
    };
}

// ─── Layers Panel ────────────────────────────────────────────────────────────

let activeLayerLine: number | null = null;

function buildLayerTree(elements: GuiElement[], container: HTMLElement, depth = 0) {
    for (const el of elements) {
        // Skip off-screen elements (position > 5000)
        if (Math.abs(el.position.x) > 5000 || Math.abs(el.position.y) > 5000) continue;
        // Skip hidden containerWindowType (explicit size 0x0)
        if (el.sizeExplicit && el.size.width === 0 && el.size.height === 0
            && (el.type === 'containerWindowType' || el.type === 'windowType')) continue;

        const hasChildren = el.children.length > 0;
        const c = COLORS[el.type] ?? DEFAULT_COLOR;

        // Item row
        const item = document.createElement('div');
        item.className = 'layer-item';
        item.style.paddingLeft = `${6 + depth * 12}px`;
        item.dataset.line = String(el.line);

        // Expand button (for containers with children)
        const expand = document.createElement('button');
        expand.className = 'layer-expand';
        if (hasChildren) {
            expand.textContent = '▾';
            expand.onclick = (e) => {
                e.stopPropagation();
                const childContainer = item.nextElementSibling as HTMLElement;
                if (childContainer?.classList.contains('layer-children')) {
                    childContainer.classList.toggle('collapsed');
                    expand.textContent = childContainer.classList.contains('collapsed') ? '▸' : '▾';
                }
            };
        } else {
            expand.style.visibility = 'hidden';
        }
        item.appendChild(expand);

        // Visibility toggle
        const toggle = document.createElement('button');
        toggle.className = 'layer-toggle';
        toggle.textContent = '👁';
        toggle.title = '切换可见性';
        toggle.onclick = (e) => {
            e.stopPropagation();
            // Determine which elements to toggle: all selected if this is part of selection, else just this one
            const isInSelection = editMode && selectedElements.some(s => s.el.line === el.line) && selectedElements.length > 1;
            const targetLines = isInSelection ? selectedElements.map(s => s.el.line) : [el.line];

            // Decide new state based on the clicked element
            const clickedDiv = document.querySelector(`.el[data-line="${el.line}"]`) as HTMLElement;
            const willShow = clickedDiv?.style.display === 'none';

            for (const line of targetLines) {
                const elDiv = document.querySelector(`.el[data-line="${line}"]`) as HTMLElement;
                const layerItem = document.querySelector(`.layer-item[data-line="${line}"]`) as HTMLElement;
                if (elDiv) {
                    elDiv.style.display = willShow ? '' : 'none';
                }
                if (layerItem) {
                    layerItem.classList.toggle('hidden-el', !willShow);
                    const btn = layerItem.querySelector('.layer-toggle');
                    if (btn) btn.textContent = willShow ? '👁' : '🚫';
                }
            }
        };
        item.appendChild(toggle);

        // Color icon
        const icon = document.createElement('span');
        icon.className = 'layer-icon';
        icon.style.background = c.border;
        item.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'layer-name';
        nameSpan.textContent = el.name || '(unnamed)';
        nameSpan.title = `${el.name || '(unnamed)'} — ${el.type}`;
        item.appendChild(nameSpan);

        // Type badge
        const typeSpan = document.createElement('span');
        typeSpan.className = 'layer-type';
        typeSpan.textContent = c.tag;
        item.appendChild(typeSpan);

        // Click to locate / select
        item.onclick = (e) => {
            if (editMode) {
                const entry = elMap.get(el.line);
                if (!entry) return;

                if (e.ctrlKey) {
                    // Ctrl+Click: toggle this item in the multi-selection
                    toggleSelection(entry.el, entry.div);
                } else {
                    // Plain click: single select
                    selectElement(entry.el, entry.div);
                }
                activeLayerLine = el.line;
            } else {
                // Preview mode: highlight + jump to line
                document.querySelectorAll('.layer-item.active').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                activeLayerLine = el.line;

                document.querySelectorAll('.el.layer-highlight').forEach(i => i.classList.remove('layer-highlight'));
                const elDiv = document.querySelector(`.el[data-line="${el.line}"]`) as HTMLElement;
                if (elDiv) {
                    elDiv.classList.add('layer-highlight');
                    const vp = document.getElementById('viewport')!;
                    const vpRect = vp.getBoundingClientRect();
                    const elRect = elDiv.getBoundingClientRect();
                    const cx = elRect.left + elRect.width / 2;
                    const cy = elRect.top + elRect.height / 2;
                    const vpCx = vpRect.left + vpRect.width / 2;
                    const vpCy = vpRect.top + vpRect.height / 2;
                    if (cx < vpRect.left || cx > vpRect.right || cy < vpRect.top || cy > vpRect.bottom) {
                        panX += vpCx - cx;
                        panY += vpCy - cy;
                        updateTransform();
                    }
                }
                vscode.postMessage({ command: 'goToLine', line: el.line });
            }
        };

        container.appendChild(item);

        // Children container
        if (hasChildren) {
            const childContainer = document.createElement('div');
            childContainer.className = 'layer-children';
            buildLayerTree(el.children, childContainer, depth + 1);
            container.appendChild(childContainer);
        }
    }
}

function updateLayersPanel(elements: GuiElement[]) {
    const tree = document.getElementById('layers-tree');
    if (!tree) return;
    tree.innerHTML = '';
    buildLayerTree(elements, tree);
}

// ─── Search ─────────────────────────────────────────────────────────────────

let searchResults: HTMLElement[] = [];
let searchIndex = -1;

function setupSearch() {
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    const searchCount = document.getElementById('search-count')!;
    const btnSearch = document.getElementById('btn-search');
    const btnClose = document.getElementById('search-close');
    const btnPrev = document.getElementById('search-prev');
    const btnNext = document.getElementById('search-next');

    if (!searchBar || !searchInput || !btnSearch) return;

    function toggleSearch() {
        searchBar!.classList.toggle('hidden');
        if (!searchBar!.classList.contains('hidden')) {
            searchInput!.focus();
            searchInput!.select();
        } else {
            clearSearch();
        }
    }

    function clearSearch() {
        document.querySelectorAll('.el.search-highlight').forEach(el => el.classList.remove('search-highlight'));
        searchResults = [];
        searchIndex = -1;
        searchCount!.textContent = '';
    }

    function doSearch() {
        clearSearch();
        const query = searchInput!.value.trim().toLowerCase();
        if (!query) return;

        const allEls = document.querySelectorAll('.el[data-line]');
        allEls.forEach(el => {
            const nameEl = el.querySelector('.el-name');
            if (nameEl && nameEl.textContent?.toLowerCase().includes(query)) {
                (el as HTMLElement).classList.add('search-highlight');
                searchResults.push(el as HTMLElement);
            }
        });

        searchCount!.textContent = searchResults.length > 0 ? `找到 ${searchResults.length} 个` : '无匹配';
        if (searchResults.length > 0) {
            searchIndex = 0;
            scrollToResult();
        }
    }

    function scrollToResult() {
        if (searchResults.length === 0) return;
        // Remove previous active
        document.querySelectorAll('.el.search-active').forEach(el => el.classList.remove('search-active'));
        const el = searchResults[searchIndex];
        el.classList.add('search-active');
        searchCount!.textContent = `${searchIndex + 1}/${searchResults.length}`;

        // Pan viewport to element
        const vp = document.getElementById('viewport')!;
        const vpRect = vp.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const cx = elRect.left + elRect.width / 2;
        const cy = elRect.top + elRect.height / 2;
        const vpCx = vpRect.left + vpRect.width / 2;
        const vpCy = vpRect.top + vpRect.height / 2;
        if (cx < vpRect.left || cx > vpRect.right || cy < vpRect.top || cy > vpRect.bottom) {
            panX += vpCx - cx;
            panY += vpCy - cy;
            updateTransform();
        }
    }

    btnSearch!.onclick = toggleSearch;
    btnClose!.onclick = toggleSearch;
    btnPrev!.onclick = () => {
        if (searchResults.length === 0) return;
        searchIndex = (searchIndex - 1 + searchResults.length) % searchResults.length;
        scrollToResult();
    };
    btnNext!.onclick = () => {
        if (searchResults.length === 0) return;
        searchIndex = (searchIndex + 1) % searchResults.length;
        scrollToResult();
    };
    searchInput!.addEventListener('input', doSearch);
    searchInput!.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                searchIndex = (searchIndex - 1 + searchResults.length) % searchResults.length;
            } else {
                searchIndex = (searchIndex + 1) % searchResults.length;
            }
            scrollToResult();
        } else if (e.key === 'Escape') {
            toggleSearch();
        }
    });

    // Ctrl+F shortcut
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            toggleSearch();
        }
    });
}

// ─── Visual Editor ──────────────────────────────────────────────────────────

let editMode = false;
let allElements: GuiElement[] = [];
let spriteNames: string[] = [];
let effectNames: string[] = [];
let hasRendered = false;  // track whether first render has occurred
const elMap = new Map<number, { el: GuiElement; div: HTMLElement }>();
let selectedElements: Array<{ el: GuiElement; div: HTMLElement }> = [];

// ── Edit Mode Toggle ──
function toggleEditMode() {
    editMode = !editMode;
    document.body.classList.toggle('edit-mode', editMode);
    document.getElementById('btn-edit')!.classList.toggle('active', editMode);
    if (!editMode) {
        clearSelection();
        hideContextMenu();
        clearSnapGuides();
    }
}

// ── Selection ──
function selectElement(el: GuiElement, div: HTMLElement) {
    clearSelection();
    selectedElements = [{ el, div }];
    div.classList.add('selected');
    addResizeHandles(div, el);
    updatePropertiesPanel();
    updateAlignButtons();
    // Highlight in layers
    document.querySelectorAll('.layer-item.active').forEach(i => i.classList.remove('active'));
    const layerItem = document.querySelector(`.layer-item[data-line="${el.line}"]`);
    if (layerItem) layerItem.classList.add('active');
}

function toggleSelection(el: GuiElement, div: HTMLElement) {
    const idx = selectedElements.findIndex(s => s.el.line === el.line);
    if (idx >= 0) {
        selectedElements[idx].div.classList.remove('selected');
        removeResizeHandles(selectedElements[idx].div);
        selectedElements.splice(idx, 1);
        // Unhighlight in layers
        const layerItem = document.querySelector(`.layer-item[data-line="${el.line}"]`);
        if (layerItem) layerItem.classList.remove('active');
    } else {
        selectedElements.push({ el, div });
        div.classList.add('selected');
        if (selectedElements.length === 1) addResizeHandles(div, el);
        // Highlight in layers
        const layerItem = document.querySelector(`.layer-item[data-line="${el.line}"]`);
        if (layerItem) layerItem.classList.add('active');
    }
    updatePropertiesPanel();
    updateAlignButtons();
}

function clearSelection() {
    for (const s of selectedElements) {
        s.div.classList.remove('selected');
        removeResizeHandles(s.div);
    }
    selectedElements = [];
    // Clear all layer highlights
    document.querySelectorAll('.layer-item.active').forEach(i => i.classList.remove('active'));
    updatePropertiesPanel();
    updateAlignButtons();
}

// ── Resize Handles ──
function addResizeHandles(div: HTMLElement, el: GuiElement) {
    removeResizeHandles(div);
    const dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const d of dirs) {
        const h = document.createElement('div');
        h.className = `resize-handle ${d}`;
        h.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            startResize(el, div, d, e);
        });
        div.appendChild(h);
    }
}

function removeResizeHandles(div: HTMLElement) {
    div.querySelectorAll('.resize-handle').forEach(h => h.remove());
}

// ── Drag Engine ──
interface DragState {
    el: GuiElement;
    div: HTMLElement;
    startX: number;
    startY: number;
    origPosX: number;
    origPosY: number;
    origVisualLeft: number;
    origVisualTop: number;
    // For multi-select: offsets for all other selected items
    others: Array<{ el: GuiElement; div: HTMLElement; origPosX: number; origPosY: number; origVisualLeft: number; origVisualTop: number }>;
}
let dragState: DragState | null = null;

function startDrag(el: GuiElement, div: HTMLElement, e: MouseEvent) {
    // If clicking an unselected element, select it first
    if (!selectedElements.find(s => s.el.line === el.line)) {
        selectElement(el, div);
    }
    const parsePx = (s: string) => parseInt(s.replace('px', '')) || 0;
    const others = selectedElements
        .filter(s => s.el.line !== el.line)
        .map(s => ({ el: s.el, div: s.div, origPosX: s.el.position.x, origPosY: s.el.position.y, origVisualLeft: parsePx(s.div.style.left), origVisualTop: parsePx(s.div.style.top) }));
    dragState = {
        el, div,
        startX: e.clientX,
        startY: e.clientY,
        origPosX: el.position.x,
        origPosY: el.position.y,
        origVisualLeft: parsePx(div.style.left),
        origVisualTop: parsePx(div.style.top),
        others,
    };
    // Push undo for drag start — track whether position property existed in source
    const hadPos = (prop: string, elem: GuiElement) => {
        const pl = elem.propertyLines?.[prop];
        return pl !== undefined && pl !== elem.line;
    };
    pushUndo({ type: 'move', items: [
        { el, origX: el.position.x, origY: el.position.y, hadPositionLine: hadPos('position', el) },
        ...others.map(o => ({ el: o.el, origX: o.origPosX, origY: o.origPosY, hadPositionLine: hadPos('position', o.el) })),
    ] });
}

window.addEventListener('mousemove', (e) => {
    if (dragState) {
        const dx = (e.clientX - dragState.startX) / scale;
        const dy = (e.clientY - dragState.startY) / scale;
        let newX = Math.round(dragState.origPosX + dx);
        let newY = Math.round(dragState.origPosY + dy);

        // Snap
        const snapResult = computeSnap(dragState.el, newX, newY);
        newX = snapResult.x;
        newY = snapResult.y;
        showSnapGuides(snapResult.guides);

        const finalDx = newX - dragState.origPosX;
        const finalDy = newY - dragState.origPosY;

        dragState.el.position.x = newX;
        dragState.el.position.y = newY;
        dragState.div.style.left = `${dragState.origVisualLeft + finalDx}px`;
        dragState.div.style.top = `${dragState.origVisualTop + finalDy}px`;

        // Move others by same delta
        for (const o of dragState.others) {
            o.el.position.x = o.origPosX + finalDx;
            o.el.position.y = o.origPosY + finalDy;
            o.div.style.left = `${o.origVisualLeft + finalDx}px`;
            o.div.style.top = `${o.origVisualTop + finalDy}px`;
        }

        // Show coordinate tooltip
        showDragTooltip(e.clientX, e.clientY, newX, newY);
        updatePropertiesPanel();
        e.preventDefault();
    }

    if (resizeState) {
        handleResizeMove(e);
        e.preventDefault();
    }
});

window.addEventListener('mouseup', () => {
    if (dragState) {
        // Only send position updates if the element actually moved
        const moved = dragState.el.position.x !== dragState.origPosX ||
                      dragState.el.position.y !== dragState.origPosY;
        if (moved) {
            const items = [dragState, ...dragState.others.map(o => ({ el: o.el, div: o.div }))];
            for (const item of items) {
                vscode.postMessage({
                    command: 'updateProperty',
                    line: item.el.line,
                    property: 'position',
                    value: { x: item.el.position.x, y: item.el.position.y },
                    propertyLine: item.el.propertyLines?.['position'] ?? item.el.line,
                });
            }
        } else {
            // No movement — remove the undo entry that was pushed in startDrag
            undoStack.pop();
        }
        dragState = null;
        hideDragTooltip();
        clearSnapGuides();
    }
    if (resizeState) {
        finishResize();
    }
});

// ── Resize Engine ──
interface ResizeItemState {
    el: GuiElement;
    div: HTMLElement;
    origW: number;
    origH: number;
    origPosX: number;
    origPosY: number;
    useScale: boolean;    // true for texture-sized elements (iconType etc.)
    origScale: number;    // original scale value when useScale is true
}
interface ResizeState {
    items: ResizeItemState[];
    dir: string;
    startX: number;
    startY: number;
}
let resizeState: ResizeState | null = null;

/** Check if element should use scale (not size) for resizing.
 *  Only container types (containerWindowType, windowType) use size.
 *  All other child controls (buttonType, iconType, effectButtonType, etc.) use scale. */
function shouldUseScale(el: GuiElement): boolean {
    const containerTypes = new Set(['containerWindowType', 'windowType', 'scrollAreaType', 'dropDownBoxType', 'expandedWindow']);
    return !containerTypes.has(el.type);
}

function startResize(el: GuiElement, div: HTMLElement, dir: string, e: MouseEvent) {
    // Use structural undo so all elements can be restored via snapshot
    pushUndo({ type: 'structural' });

    // Build items from all selected elements (or just the one if not in selection)
    const items: ResizeItemState[] = [];
    const makeItem = (itemEl: GuiElement, itemDiv: HTMLElement): ResizeItemState => {
        const { w, h } = effectiveSize(itemEl);
        const useScale = shouldUseScale(itemEl);
        const origScale = itemEl.scale ?? 1;
        const isContainerEl = itemEl.type === 'containerWindowType' || itemEl.type === 'windowType';
        // origW/origH must be the VISUAL size (including scale), since div dimensions are base*scale
        const visualW = (useScale && !isContainerEl) ? w * origScale : w;
        const visualH = (useScale && !isContainerEl) ? h * origScale : h;
        return { el: itemEl, div: itemDiv, origW: visualW, origH: visualH, origPosX: itemEl.position.x, origPosY: itemEl.position.y, useScale, origScale };
    };

    if (selectedElements.length > 1 && selectedElements.some(s => s.el.line === el.line)) {
        for (const sel of selectedElements) {
            items.push(makeItem(sel.el, sel.div));
        }
    } else {
        items.push(makeItem(el, div));
    }
    resizeState = { items, dir, startX: e.clientX, startY: e.clientY };
}

function handleResizeMove(e: MouseEvent) {
    if (!resizeState) return;
    const dx = (e.clientX - resizeState.startX) / scale;
    const dy = (e.clientY - resizeState.startY) / scale;
    const dir = resizeState.dir;

    for (const s of resizeState.items) {
        let newW = s.origW, newH = s.origH, newX = s.origPosX, newY = s.origPosY;
        if (dir.includes('e')) newW = Math.max(10, s.origW + dx);
        if (dir.includes('w')) { newW = Math.max(10, s.origW - dx); newX = s.origPosX + (s.origW - newW); }
        if (dir.includes('s')) newH = Math.max(10, s.origH + dy);
        if (dir.includes('n')) { newH = Math.max(10, s.origH - dy); newY = s.origPosY + (s.origH - newH); }

        if (s.useScale) {
            // Scale-based resize: compute new scale from size ratio
            const baseW = s.origW / s.origScale;
            const baseH = s.origH / s.origScale;
            const scaleX = newW / baseW;
            const scaleY = newH / baseH;
            const newScale = Math.max(0.01, Math.round(((scaleX + scaleY) / 2) * 1000) / 1000);
            s.el.scale = newScale;
            // Set div to visual size directly (consistent with renderElement)
            const visualW = Math.round(baseW * newScale);
            const visualH = Math.round(baseH * newScale);
            s.div.style.width = `${visualW}px`;
            s.div.style.height = `${visualH}px`;
        } else {
            s.el.size.width = Math.round(newW);
            s.el.size.height = Math.round(newH);
            s.div.style.width = `${s.el.size.width}px`;
            s.div.style.height = `${s.el.size.height}px`;
        }
        s.el.position.x = Math.round(newX);
        s.el.position.y = Math.round(newY);
        s.div.style.left = `${s.el.position.x}px`;
        s.div.style.top = `${s.el.position.y}px`;
    }
    const primary = resizeState.items[0];
    const displayW = primary.useScale ? Math.round((primary.origW / primary.origScale) * (primary.el.scale ?? 1)) : primary.el.size.width;
    const displayH = primary.useScale ? Math.round((primary.origH / primary.origScale) * (primary.el.scale ?? 1)) : primary.el.size.height;
    showDragTooltip(e.clientX, e.clientY, displayW, displayH, true);
    updatePropertiesPanel();
}

function finishResize() {
    if (!resizeState) return;
    for (const s of resizeState.items) {
        if (s.origPosX !== s.el.position.x || s.origPosY !== s.el.position.y) {
            vscode.postMessage({
                command: 'updateProperty', line: s.el.line, property: 'position',
                value: { x: s.el.position.x, y: s.el.position.y },
                propertyLine: s.el.propertyLines?.['position'] ?? s.el.line,
            });
        }
        if (s.useScale) {
            vscode.postMessage({
                command: 'updateProperty', line: s.el.line, property: 'scale',
                value: s.el.scale ?? 1,
                propertyLine: s.el.propertyLines?.['scale'] ?? s.el.line,
            });
        } else {
            vscode.postMessage({
                command: 'updateProperty', line: s.el.line, property: 'size',
                value: { width: s.el.size.width, height: s.el.size.height },
                propertyLine: s.el.propertyLines?.['size'] ?? s.el.line,
            });
        }
    }
    resizeState = null;
    hideDragTooltip();
}

// ── Drag Coordinate Tooltip ──
function showDragTooltip(mx: number, my: number, valX: number, valY: number, isSize = false) {
    let tip = document.getElementById('drag-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'drag-tooltip';
        document.body.appendChild(tip);
    }
    tip.textContent = isSize ? `${valX} × ${valY}` : `(${valX}, ${valY})`;
    tip.style.left = `${mx + 14}px`;
    tip.style.top = `${my + 14}px`;
    tip.style.display = 'block';
}

function hideDragTooltip() {
    const tip = document.getElementById('drag-tooltip');
    if (tip) tip.style.display = 'none';
}

// ── Undo/Redo ──
type UndoEntry =
    | { type: 'move'; items: Array<{ el: GuiElement; origX: number; origY: number; hadPositionLine: boolean }> }
    | { type: 'resize'; el: GuiElement; origX: number; origY: number; origW: number; origH: number }
    | { type: 'property'; el: GuiElement; property: string; oldValue: unknown; newValue: unknown }
    | { type: 'structural' };  // add/delete/duplicate — use VS Code’s native undo

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const MAX_UNDO = 100;

function pushUndo(entry: UndoEntry) {
    undoStack.push(entry);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
}

function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    if (entry.type === 'move') {
        const nowPositions = entry.items.map(i => ({
            el: i.el, origX: i.el.position.x, origY: i.el.position.y,
            hadPositionLine: true, // now it exists in source
        }));
        for (const item of entry.items) {
            // Look up the CURRENT element from elMap (undo entry's el may be stale after re-render)
            const current = elMap.get(item.el.line);
            const currentEl = current?.el ?? item.el;
            const currentPropLines = currentEl.propertyLines;

            currentEl.position.x = item.origX;
            currentEl.position.y = item.origY;
            if (current) { current.div.style.left = `${item.origX}px`; current.div.style.top = `${item.origY}px`; }
            if (!item.hadPositionLine) {
                // Property didn't exist before — remove the inserted line
                const posLine = currentPropLines?.['position'];
                if (posLine && posLine !== currentEl.line) {
                    vscode.postMessage({
                        command: 'removePropertyLine',
                        line: currentEl.line,
                        property: 'position',
                        propertyLine: posLine,
                    });
                }
            } else {
                vscode.postMessage({
                    command: 'updateProperty', line: currentEl.line, property: 'position',
                    value: { x: item.origX, y: item.origY },
                    propertyLine: currentPropLines?.['position'] ?? currentEl.line,
                });
            }
        }
        redoStack.push({ type: 'move', items: nowPositions });
    } else if (entry.type === 'resize') {
        const nowW = entry.el.size.width, nowH = entry.el.size.height;
        const nowX = entry.el.position.x, nowY = entry.el.position.y;
        entry.el.size.width = entry.origW;
        entry.el.size.height = entry.origH;
        entry.el.position.x = entry.origX;
        entry.el.position.y = entry.origY;
        const m = elMap.get(entry.el.line);
        if (m) {
            m.div.style.width = `${entry.origW}px`;
            m.div.style.height = `${entry.origH}px`;
            m.div.style.left = `${entry.origX}px`;
            m.div.style.top = `${entry.origY}px`;
        }
        vscode.postMessage({ command: 'updateProperty', line: entry.el.line, property: 'size', value: { width: entry.origW, height: entry.origH }, propertyLine: entry.el.propertyLines?.['size'] ?? entry.el.line });
        vscode.postMessage({ command: 'updateProperty', line: entry.el.line, property: 'position', value: { x: entry.origX, y: entry.origY }, propertyLine: entry.el.propertyLines?.['position'] ?? entry.el.line });
        redoStack.push({ type: 'resize', el: entry.el, origX: nowX, origY: nowY, origW: nowW, origH: nowH });
    } else if (entry.type === 'structural') {
        // Delegate to VS Code's native document undo
        vscode.postMessage({ command: 'vscodeUndo' });
        // Don't push to redo — VS Code manages its own redo
    }
    updatePropertiesPanel();
}

function redo() {
    const entry = redoStack.pop();
    if (!entry) return;
    pushUndo(entry); // this also clears redo, but that's fine since we popped
    // Re-apply (same logic as original action)
    if (entry.type === 'move') {
        for (const item of entry.items) {
            item.el.position.x = item.origX;
            item.el.position.y = item.origY;
            const m = elMap.get(item.el.line);
            if (m) { m.div.style.left = `${item.origX}px`; m.div.style.top = `${item.origY}px`; }
            vscode.postMessage({
                command: 'updateProperty', line: item.el.line, property: 'position',
                value: { x: item.origX, y: item.origY },
                propertyLine: item.el.propertyLines?.['position'] ?? item.el.line,
            });
        }
    } else if (entry.type === 'resize') {
        entry.el.size.width = entry.origW;
        entry.el.size.height = entry.origH;
        entry.el.position.x = entry.origX;
        entry.el.position.y = entry.origY;
        const m = elMap.get(entry.el.line);
        if (m) {
            m.div.style.width = `${entry.origW}px`;
            m.div.style.height = `${entry.origH}px`;
            m.div.style.left = `${entry.origX}px`;
            m.div.style.top = `${entry.origY}px`;
        }
        vscode.postMessage({ command: 'updateProperty', line: entry.el.line, property: 'size', value: { width: entry.origW, height: entry.origH }, propertyLine: entry.el.propertyLines?.['size'] ?? entry.el.line });
        vscode.postMessage({ command: 'updateProperty', line: entry.el.line, property: 'position', value: { x: entry.origX, y: entry.origY }, propertyLine: entry.el.propertyLines?.['position'] ?? entry.el.line });
    }
}

// ── Snap Engine ──
const SNAP_THRESHOLD = 5;

interface SnapGuide { type: 'h' | 'v'; pos: number; }
interface SnapResult { x: number; y: number; guides: SnapGuide[]; }

function computeSnap(el: GuiElement, newX: number, newY: number): SnapResult {
    const { w, h } = effectiveSize(el);
    const guides: SnapGuide[] = [];
    let snappedX = newX, snappedY = newY;
    const parentDiv = elMap.get(el.line)?.div.parentElement;
    if (!parentDiv) return { x: newX, y: newY, guides: [] };

    // Collect sibling edges
    const siblings: Array<{ left: number; top: number; right: number; bottom: number; cx: number; cy: number }> = [];
    for (const [line, entry] of elMap) {
        if (line === el.line) continue;
        if (entry.div.parentElement !== parentDiv) continue;
        const sw = entry.div.offsetWidth || entry.el.size.width;
        const sh = entry.div.offsetHeight || entry.el.size.height;
        const sl = entry.el.position.x;
        const st = entry.el.position.y;
        siblings.push({ left: sl, top: st, right: sl + sw, bottom: st + sh, cx: sl + sw / 2, cy: st + sh / 2 });
    }

    const myEdges = { left: newX, top: newY, right: newX + w, bottom: newY + h, cx: newX + w / 2, cy: newY + h / 2 };

    // Snap X
    let bestDx = SNAP_THRESHOLD + 1;
    for (const s of siblings) {
        for (const [myVal, sVal] of [[myEdges.left, s.left], [myEdges.left, s.right], [myEdges.right, s.left], [myEdges.right, s.right], [myEdges.cx, s.cx]]) {
            const d = Math.abs(myVal - sVal);
            if (d < bestDx) {
                bestDx = d;
                snappedX = newX + (sVal - myVal);
                guides.push({ type: 'v', pos: sVal });
            }
        }
    }
    // Snap Y
    let bestDy = SNAP_THRESHOLD + 1;
    for (const s of siblings) {
        for (const [myVal, sVal] of [[myEdges.top, s.top], [myEdges.top, s.bottom], [myEdges.bottom, s.top], [myEdges.bottom, s.bottom], [myEdges.cy, s.cy]]) {
            const d = Math.abs(myVal - sVal);
            if (d < bestDy) {
                bestDy = d;
                snappedY = newY + (sVal - myVal);
                guides.push({ type: 'h', pos: sVal });
            }
        }
    }

    // Only keep active guides
    const finalGuides: SnapGuide[] = [];
    if (bestDx <= SNAP_THRESHOLD) finalGuides.push(...guides.filter(g => g.type === 'v'));
    else snappedX = newX;
    if (bestDy <= SNAP_THRESHOLD) finalGuides.push(...guides.filter(g => g.type === 'h'));
    else snappedY = newY;

    return { x: snappedX, y: snappedY, guides: finalGuides };
}

function showSnapGuides(guides: SnapGuide[]) {
    const container = document.getElementById('snap-guides');
    if (!container) return;
    container.innerHTML = '';
    for (const g of guides) {
        const line = document.createElement('div');
        line.className = `snap-line ${g.type === 'h' ? 'horizontal' : 'vertical'}`;
        if (g.type === 'h') line.style.top = `${g.pos}px`;
        else line.style.left = `${g.pos}px`;
        container.appendChild(line);
    }
}

function clearSnapGuides() {
    const container = document.getElementById('snap-guides');
    if (container) container.innerHTML = '';
}

// ── Alignment Tools ──
function updateAlignButtons() {
    const btns = document.querySelectorAll('.align-btn') as NodeListOf<HTMLButtonElement>;
    const enabled = selectedElements.length >= 2;
    btns.forEach(b => b.disabled = !enabled);
}

function alignSelected(mode: string) {
    if (selectedElements.length < 2) return;
    const items = selectedElements.map(s => {
        const { w, h } = effectiveSize(s.el);
        return { ...s, w, h };
    });
    pushUndo({ type: 'move', items: items.map(i => ({ el: i.el, origX: i.el.position.x, origY: i.el.position.y, hadPositionLine: true })) });

    switch (mode) {
        case 'left': {
            const min = Math.min(...items.map(i => i.el.position.x));
            items.forEach(i => { i.el.position.x = min; i.div.style.left = `${min}px`; });
            break;
        }
        case 'right': {
            const max = Math.max(...items.map(i => i.el.position.x + i.w));
            items.forEach(i => { i.el.position.x = max - i.w; i.div.style.left = `${i.el.position.x}px`; });
            break;
        }
        case 'top': {
            const min = Math.min(...items.map(i => i.el.position.y));
            items.forEach(i => { i.el.position.y = min; i.div.style.top = `${min}px`; });
            break;
        }
        case 'bottom': {
            const max = Math.max(...items.map(i => i.el.position.y + i.h));
            items.forEach(i => { i.el.position.y = max - i.h; i.div.style.top = `${i.el.position.y}px`; });
            break;
        }
        case 'hcenter': {
            const cx = items.reduce((s, i) => s + i.el.position.x + i.w / 2, 0) / items.length;
            items.forEach(i => { i.el.position.x = Math.round(cx - i.w / 2); i.div.style.left = `${i.el.position.x}px`; });
            break;
        }
        case 'vcenter': {
            const cy = items.reduce((s, i) => s + i.el.position.y + i.h / 2, 0) / items.length;
            items.forEach(i => { i.el.position.y = Math.round(cy - i.h / 2); i.div.style.top = `${i.el.position.y}px`; });
            break;
        }
    }
    // Send updates
    for (const item of items) {
        vscode.postMessage({
            command: 'updateProperty', line: item.el.line, property: 'position',
            value: { x: item.el.position.x, y: item.el.position.y },
            propertyLine: item.el.propertyLines?.['position'] ?? item.el.line,
        });
    }
    updatePropertiesPanel();
}

// ── Properties Panel ──
function updatePropertiesPanel() {
    const content = document.getElementById('props-content');
    if (!content) return;
    if (selectedElements.length === 0) {
        content.innerHTML = '<div style="padding:20px;text-align:center;color:#5868a0">选择一个元素以编辑属性</div>';
        return;
    }
    if (selectedElements.length > 1) {
        content.innerHTML = `<div style="padding:20px;text-align:center;color:#5868a0">已选择 ${selectedElements.length} 个元素</div>`;
        return;
    }
    const { el } = selectedElements[0];
    const c = COLORS[el.type] ?? DEFAULT_COLOR;
    let html = '';

    // Identity
    html += `<div class="prop-group"><div class="prop-group-title" style="color:${c.border}">${c.tag}</div>`;
    html += propRow('name', `<input class="prop-input" data-prop="name" value="${escHtml(el.name)}" />`);
    html += `</div>`;

    // Transform
    html += `<div class="prop-group"><div class="prop-group-title">变换</div>`;
    html += propRow('position', `<div class="prop-half"><input class="prop-input" type="number" data-prop="pos-x" value="${el.position.x}" step="1" /><input class="prop-input" type="number" data-prop="pos-y" value="${el.position.y}" step="1" /></div>`);
    html += propRow('size', `<div class="prop-half"><input class="prop-input" type="number" data-prop="size-w" value="${el.size.width}" step="1" /><input class="prop-input" type="number" data-prop="size-h" value="${el.size.height}" step="1" /></div>`);

    const orientations = ['', 'UPPER_LEFT', 'UPPER_RIGHT', 'LOWER_LEFT', 'LOWER_RIGHT', 'CENTER', 'CENTER_UP', 'CENTER_DOWN', 'CENTER_LEFT', 'CENTER_RIGHT'];
    html += propRow('orientation', `<select class="prop-select" data-prop="orientation">${orientations.map(o => `<option value="${o}" ${o === normalizeOrientation(el.orientation ?? '') ? 'selected' : ''}>${o || '(无)'}</option>`).join('')}</select>`);
    html += propRow('origo', `<select class="prop-select" data-prop="origo">${orientations.map(o => `<option value="${o}" ${o === normalizeOrientation(el.origo ?? '') ? 'selected' : ''}>${o || '(无)'}</option>`).join('')}</select>`);
    html += `</div>`;

    // Visual
    html += `<div class="prop-group"><div class="prop-group-title">视觉</div>`;
    html += propRow('缩放', `<input class="prop-input" type="number" data-prop="scale" value="${el.scale ?? 1}" step="0.1" min="0.1" max="10" />`);
    html += propRow('透明度', `<input class="prop-input" type="number" data-prop="alpha" value="${el.alpha ?? 1}" step="0.1" min="0" max="1" />`);
    html += propRow('旋转', `<input class="prop-input" type="number" data-prop="rotation" value="${el.rotation ?? 0}" step="0.1" />`);
    html += propRow('居中', `<input class="prop-checkbox" type="checkbox" data-prop="centerPosition" ${el.centerPosition ? 'checked' : ''} />`);
    html += propRow('裁剪', `<input class="prop-checkbox" type="checkbox" data-prop="clipping" ${el.clipping ? 'checked' : ''} />`);
    html += `</div>`;

    // Sprite
    html += `<div class="prop-group"><div class="prop-group-title">贴图</div>`;
    const spriteAttr = el.spriteAttr ?? 'spriteType';
    const currentSprite = el.spriteKey ?? '';
    html += `<div class="prop-row"><span class="prop-label">贴图</span><div class="sprite-picker" style="position:relative;flex:1;min-width:0"><input class="prop-input" id="sprite-search" data-prop="sprite-select" value="${escHtml(currentSprite)}" placeholder="输入或选择贴图..." autocomplete="off" /></div></div>`;
    if (el.frame !== undefined) html += propRow('帧', `<input class="prop-input" type="number" data-prop="frame" value="${el.frame}" step="1" min="0" />`);
    html += `</div>`;

    // Effect (only for effectButtonType)
    if (el.type === 'effectButtonType') {
        const currentEffect = (el.properties['effect'] as string) ?? '';
        html += `<div class="prop-group"><div class="prop-group-title">效果</div>`;
        html += `<div class="prop-row"><span class="prop-label">effect</span><div class="sprite-picker" style="position:relative;flex:1;min-width:0"><input class="prop-input" id="effect-search" data-prop="effect-select" value="${escHtml(currentEffect)}" placeholder="输入或选择效果..." autocomplete="off" /></div></div>`;
        html += `</div>`;
    }

    // Info
    html += `<div class="prop-group"><div class="prop-group-title">源码</div>`;
    html += propRow('行号', `<span style="font-size:11px;color:#7888a8">${el.line} — ${el.endLine}</span>`);
    html += `</div>`;

    content.innerHTML = html;

    // Attach input handlers
    content.querySelectorAll('[data-prop]').forEach(input => {
        const prop = (input as HTMLElement).dataset.prop!;
        const handler = () => {
            const val = (input as HTMLInputElement).type === 'checkbox'
                ? (input as HTMLInputElement).checked
                : (input as HTMLInputElement).type === 'number'
                    ? parseFloat((input as HTMLInputElement).value)
                    : (input as HTMLInputElement).value;
            applyPropertyChange(el, prop, val);
        };
        input.addEventListener('change', handler);
        // Only add real-time 'input' handler for position fields (need live feedback during drag)
        if ((input as HTMLInputElement).type === 'number' && ['pos-x', 'pos-y'].includes(prop)) {
            input.addEventListener('input', handler);
        }
    });

    // Setup custom sprite autocomplete dropdown
    setupAutocomplete(content, '#sprite-search', 'sprite-dropdown-global', spriteNames);

    // Setup custom effect autocomplete dropdown
    setupAutocomplete(content, '#effect-search', 'effect-dropdown-global', effectNames);
}

/** Reusable autocomplete dropdown for input fields */
function setupAutocomplete(content: HTMLElement, inputSelector: string, dropdownId: string, dataSource: string[]) {
    const inputEl = content.querySelector(inputSelector) as HTMLInputElement;
    if (!inputEl) return;
    // Create dropdown on body to avoid being clipped by overflow
    let dropdown = document.getElementById(dropdownId) as HTMLElement;
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.id = dropdownId;
        dropdown.className = 'sprite-dropdown hidden';
        document.body.appendChild(dropdown);
    }
    let ddIndex = -1;
    const positionDropdown = () => {
        const rect = inputEl.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = `${rect.bottom}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${rect.width}px`;
    };
    const showDropdown = (query: string) => {
        const q = query.toLowerCase();
        const matches = q ? dataSource.filter(s => s.toLowerCase().includes(q)).slice(0, 50) : [];
        if (matches.length === 0) { dropdown.classList.add('hidden'); return; }
        ddIndex = -1;
        dropdown.innerHTML = matches.map(s =>
            `<div class="sprite-option">${escHtml(s)}</div>`
        ).join('');
        positionDropdown();
        dropdown.classList.remove('hidden');
        dropdown.querySelectorAll('.sprite-option').forEach((opt, i) => {
            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                inputEl.value = matches[i];
                dropdown.classList.add('hidden');
                inputEl.dispatchEvent(new Event('change'));
            });
        });
    };
    inputEl.addEventListener('input', () => showDropdown(inputEl.value));
    inputEl.addEventListener('focus', () => { if (inputEl.value) showDropdown(inputEl.value); });
    inputEl.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));
    inputEl.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.sprite-option');
        if (items.length === 0 || dropdown.classList.contains('hidden')) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); ddIndex = Math.min(ddIndex + 1, items.length - 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); ddIndex = Math.max(ddIndex - 1, 0); }
        else if (e.key === 'Enter' && ddIndex >= 0) {
            e.preventDefault();
            inputEl.value = (items[ddIndex] as HTMLElement).textContent!;
            dropdown.classList.add('hidden');
            inputEl.dispatchEvent(new Event('change'));
            return;
        } else if (e.key === 'Escape') { dropdown.classList.add('hidden'); return; }
        else return;
        items.forEach((it, i) => it.classList.toggle('active', i === ddIndex));
        if (ddIndex >= 0) items[ddIndex].scrollIntoView({ block: 'nearest' });
    });
}

function propRow(label: string, control: string): string {
    return `<div class="prop-row"><span class="prop-label">${label}</span>${control}</div>`;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function applyPropertyChange(el: GuiElement, prop: string, value: unknown) {
    const entry = elMap.get(el.line);
    if (!entry) return;

    // Push undo entry so property changes can be undone via snapshot
    pushUndo({ type: 'structural' });

    if (prop === 'pos-x' || prop === 'pos-y') {
        if (prop === 'pos-x') el.position.x = value as number;
        else el.position.y = value as number;
        entry.div.style.left = `${el.position.x}px`;
        entry.div.style.top = `${el.position.y}px`;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: 'position',
            value: { x: el.position.x, y: el.position.y },
            propertyLine: el.propertyLines?.['position'] ?? el.line,
        });
    } else if (prop === 'size-w' || prop === 'size-h') {
        if (prop === 'size-w') el.size.width = value as number;
        else el.size.height = value as number;
        entry.div.style.width = `${el.size.width}px`;
        entry.div.style.height = `${el.size.height}px`;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: 'size',
            value: { width: el.size.width, height: el.size.height },
            propertyLine: el.propertyLines?.['size'] ?? el.line,
        });
    } else if (prop === 'name') {
        el.name = value as string;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: 'name', value,
            propertyLine: el.propertyLines?.['name'] ?? el.line,
        });
    } else if (prop === 'orientation' || prop === 'origo') {
        (el as unknown as Record<string, unknown>)[prop] = (value as string) || undefined;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: prop, value: value || 'UPPER_LEFT',
            propertyLine: el.propertyLines?.[prop] ?? el.line,
        });
    } else if (prop === 'centerPosition' || prop === 'clipping') {
        (el as unknown as Record<string, unknown>)[prop] = value;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: prop, value: value ? 'yes' : 'no',
            propertyLine: el.propertyLines?.[prop] ?? el.line,
        });
    } else if (prop === 'sprite-select') {
        const spriteAttr = el.spriteAttr ?? 'spriteType';
        el.spriteKey = (value as string) || undefined;
        vscode.postMessage({
            command: 'updateProperty', line: el.line,
            property: spriteAttr, value,
            propertyLine: el.propertyLines?.[spriteAttr] ?? el.line,
        });
    } else if (prop === 'effect-select') {
        el.properties['effect'] = value;
        vscode.postMessage({
            command: 'updateProperty', line: el.line,
            property: 'effect', value,
            propertyLine: el.propertyLines?.['effect'] ?? el.line,
        });
    } else if (prop === 'scale') {
        const newScale = value as number;
        el.scale = newScale;
        // Apply scale to dimensions directly (consistent with renderElement)
        const isContainer = el.type === 'containerWindowType' || el.type === 'windowType';
        if (!isContainer) {
            const { w, h } = effectiveSize(el);
            entry.div.style.width = `${Math.round(w * newScale)}px`;
            entry.div.style.height = `${Math.round(h * newScale)}px`;
        }
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: 'scale', value: newScale,
            propertyLine: el.propertyLines?.['scale'] ?? el.line,
        });
    } else {
        (el as unknown as Record<string, unknown>)[prop] = value;
        vscode.postMessage({
            command: 'updateProperty', line: el.line, property: prop, value,
            propertyLine: el.propertyLines?.[prop] ?? el.line,
        });
    }
}

// ── Context Menu ──
let contextMenuTarget: { el: GuiElement; div: HTMLElement } | null = null;

function showContextMenu(e: MouseEvent) {
    e.preventDefault();
    const menu = document.getElementById('edit-context-menu')!;
    menu.classList.remove('hidden');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    // Adjust if off-screen
    requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = `${e.clientX - r.width}px`;
        if (r.bottom > window.innerHeight) menu.style.top = `${e.clientY - r.height}px`;
    });
}

function hideContextMenu() {
    document.getElementById('edit-context-menu')!.classList.add('hidden');
}

function setupContextMenu() {
    const menu = document.getElementById('edit-context-menu')!;

    // Right-click on viewport in edit mode
    document.getElementById('viewport')!.addEventListener('contextmenu', (e) => {
        if (!editMode) return;
        e.preventDefault();
        // Find which element was right-clicked
        const target = (e.target as HTMLElement).closest('.el') as HTMLElement;
        if (target) {
            const line = parseInt(target.dataset.line ?? '0');
            const entry = elMap.get(line);
            if (entry) {
                contextMenuTarget = entry;
                if (!selectedElements.find(s => s.el.line === line)) {
                    selectElement(entry.el, entry.div);
                }
            }
        } else {
            contextMenuTarget = null;
            clearSelection();
        }
        showContextMenu(e);
    });

    // Menu button actions
    menu.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = (btn as HTMLElement).dataset.action;
            hideContextMenu();
            handleContextAction(action!);
        });
    });

    // Close menu on click outside
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target as Node)) hideContextMenu();
    });
}

function handleContextAction(action: string) {
    if (action === 'delete') {
        deleteSelected();
    } else if (action === 'duplicate') {
        duplicateSelected();
    } else if (action.startsWith('add-')) {
        const typeMap: Record<string, string> = {
            'add-container': 'containerWindowType',
            'add-icon': 'iconType',
            'add-button': 'buttonType',
            'add-effectbutton': 'effectButtonType',
            'add-guibutton': 'guiButtonType',
            'add-text': 'instantTextBoxType',
        };
        const type = typeMap[action];
        if (!type) return;
        // Find parent — use context target or first top-level element
        let parentEl: GuiElement | null = null;
        if (contextMenuTarget) {
            // If target is a container, add inside it; otherwise add to its parent
            const isContainer = contextMenuTarget.el.type === 'containerWindowType' || contextMenuTarget.el.type === 'windowType';
            if (isContainer) {
                parentEl = contextMenuTarget.el;
            } else {
                // Find parent by looking up the tree
                for (const el of allElements) {
                    if (findChild(el, contextMenuTarget.el.line)) { parentEl = el; break; }
                }
            }
        }
        if (!parentEl && allElements.length > 0) parentEl = allElements[0];
        if (!parentEl) return;
        const newName = `new_${type.replace('Type', '')}_${Date.now() % 10000}`;
        vscode.postMessage({
            command: 'addElement',
            parentEndLine: parentEl.endLine,
            type, name: newName,
            x: 0, y: 0, w: 100, h: 50,
        });
        pushUndo({ type: 'structural' });
    }
}

function findChild(parent: GuiElement, line: number): boolean {
    for (const c of parent.children) {
        if (c.line === line) return true;
        if (findChild(c, line)) return true;
    }
    return false;
}

function deleteSelected() {
    if (selectedElements.length === 0) return;
    pushUndo({ type: 'structural' });
    for (const s of selectedElements) {
        vscode.postMessage({
            command: 'deleteElement',
            startLine: s.el.line,
            endLine: s.el.endLine,
        });
    }
    clearSelection();
}

function duplicateSelected() {
    if (selectedElements.length === 0) return;
    pushUndo({ type: 'structural' });
    for (const s of selectedElements) {
        const newName = s.el.name + '_copy';
        vscode.postMessage({
            command: 'duplicateElement',
            startLine: s.el.line,
            endLine: s.el.endLine,
            newName,
        });
    }
}

// ── Keyboard Shortcuts ──
function setupEditorKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Don't intercept keys when focus is in an input/select/textarea
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        if (!editMode) {
            if (e.key === 'e' || e.key === 'E') {
                toggleEditMode();
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'e' || e.key === 'E') {
            toggleEditMode();
            e.preventDefault();
            return;
        }

        if (e.key === 'Escape') {
            clearSelection();
            hideContextMenu();
            e.preventDefault();
            return;
        }

        if (e.key === 'Delete') {
            deleteSelected();
            e.preventDefault();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            duplicateSelected();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            redo();
            return;
        }

        // Arrow keys move selected elements by 1px (or 10px with Shift)
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selectedElements.length > 0) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            pushUndo({ type: 'move', items: selectedElements.map(s => ({ el: s.el, origX: s.el.position.x, origY: s.el.position.y, hadPositionLine: true })) });
            for (const s of selectedElements) {
                if (e.key === 'ArrowLeft') s.el.position.x -= step;
                if (e.key === 'ArrowRight') s.el.position.x += step;
                if (e.key === 'ArrowUp') s.el.position.y -= step;
                if (e.key === 'ArrowDown') s.el.position.y += step;
                s.div.style.left = `${s.el.position.x}px`;
                s.div.style.top = `${s.el.position.y}px`;
                vscode.postMessage({
                    command: 'updateProperty', line: s.el.line, property: 'position',
                    value: { x: s.el.position.x, y: s.el.position.y },
                    propertyLine: s.el.propertyLines?.['position'] ?? s.el.line,
                });
            }
            updatePropertiesPanel();
        }
    });
}

// ── Side Panel Tabs ──
function setupSidePanelTabs() {
    const tabLayers = document.getElementById('tab-layers');
    const tabProps = document.getElementById('tab-properties');
    const layersPanel = document.getElementById('layers-panel');
    const propsPanel = document.getElementById('properties-panel');
    if (!tabLayers || !tabProps || !layersPanel || !propsPanel) return;

    tabLayers.onclick = () => {
        tabLayers.classList.add('active');
        tabProps.classList.remove('active');
        layersPanel.classList.remove('hidden');
        propsPanel.classList.add('hidden');
    };
    tabProps.onclick = () => {
        tabProps.classList.add('active');
        tabLayers.classList.remove('active');
        propsPanel.classList.remove('hidden');
        layersPanel.classList.add('hidden');
    };
}

// ── Setup Alignment Buttons ──
function setupAlignButtons() {
    document.getElementById('btn-align-left')?.addEventListener('click', () => alignSelected('left'));
    document.getElementById('btn-align-right')?.addEventListener('click', () => alignSelected('right'));
    document.getElementById('btn-align-top')?.addEventListener('click', () => alignSelected('top'));
    document.getElementById('btn-align-bottom')?.addEventListener('click', () => alignSelected('bottom'));
    document.getElementById('btn-align-hcenter')?.addEventListener('click', () => alignSelected('hcenter'));
    document.getElementById('btn-align-vcenter')?.addEventListener('click', () => alignSelected('vcenter'));
}

// ─── Init ───────────────────────────────────────────────────────────────────

window.addEventListener('message', e => {
    if (e.data.command === 'render') {
        elMap.clear();
        allElements = e.data.data;
        spriteNames = e.data.spriteNames ?? [];
        effectNames = e.data.effectNames ?? [];
        renderAll(e.data.data, e.data.fileName);
        updateLayersPanel(e.data.data);
        clearSelection();
    }
});

setupControls();
setupSearch();
setupEditorKeyboard();
setupContextMenu();
setupSidePanelTabs();
setupAlignButtons();
updateTransform();
vscode.postMessage({ command: 'ready' });
