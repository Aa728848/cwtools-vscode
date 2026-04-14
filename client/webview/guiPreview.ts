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
    children: GuiElement[];
    properties: Record<string, unknown>;
    line: number;
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
        // Approximate 9-slice: stretch image to fill container
        // (True 9-slice with CSS border-image doesn't work in VSCode webviews)
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'fill';
    } else if (el.noOfFrames && el.noOfFrames > 1) {
        img.style.width = `${el.noOfFrames * 100}%`;
        img.style.height = '100%';
        img.style.objectFit = 'fill';
        let f = 0;
        if (el.frame !== undefined && el.frame > 0) {
            f = el.frame - 1; // PDX frame is 1-indexed
        }
        f = Math.max(0, Math.min(f, el.noOfFrames - 1));
        // Slide the enlarged image to the left by f * 100% of the parent's width 
        // to show the f-th frame within the parent's clipping window.
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
    const elScale = el.scale ?? 1;

    // Handle negative size (parent - N)
    if (w < 0 && parentW > 0) w = parentW + w;
    if (h < 0 && parentH > 0) h = parentH + h;

    // Determine render mode:
    // 1. spriteType attribute → ALWAYS fixed (natural size × scale), ignore widget size
    // 2. quadTextureSprite → check GFX registry:
    //    - corneredTileSpriteType / textSpriteType → 9-patch at widget size
    //    - spriteType in GFX → fixed (natural size × scale)
    const isFixedSprite = (
        el.spriteAttr === 'spriteType' ||  // spriteType attribute always means fixed
        (el.spriteAttr === 'quadTextureSprite' &&  // quadTexture referencing a plain sprite
         el.spriteDefType === 'spriteType')
    );
    if (isFixedSprite && el.textureWidth && el.textureHeight) {
        let tw = el.textureWidth;
        if (el.noOfFrames && el.noOfFrames > 1) {
            tw = Math.round(tw / el.noOfFrames);
        }
        return { w: Math.round(tw * elScale), h: Math.round(el.textureHeight * elScale) };
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

    // Container auto-size from children bounding box
    // Uses computeTopLeft for accurate child position calculation
    const isContainerType = el.type === 'containerWindowType' || el.type === 'windowType'
        || el.type === 'scrollAreaType' || el.type === 'dropDownBoxType' || el.type === 'expandedWindow';
    if (isContainerType && (w <= 0 || h <= 0)) {
        if (el.children.length > 0) {
            let maxR = 0, maxB = 0;
            // First pass to get a rough parent size for orientation calculations
            for (const ch of el.children) {
                if (ch.type === 'background') continue;
                if (Math.abs(ch.position.x) > 5000 || Math.abs(ch.position.y) > 5000) continue;
                const cs = effectiveSize(ch);
                const cScale = ch.scale ?? 1;
                // Simple estimate using raw position for first pass
                const r = Math.max(0, ch.position.x) + cs.w * cScale;
                const b = Math.max(0, ch.position.y) + cs.h * cScale;
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
            // Background: corneredTileSpriteType stretches to fill (9-patch),
            // other sprites fill while maintaining aspect ratio
            if (el.spriteDefType === 'corneredTileSpriteType') {
                img.style.objectFit = 'fill';
            } else {
                img.style.objectFit = 'contain';
            }
            img.style.objectPosition = 'top left';
            applyImageStyles(img, div, el);
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
    const tl = computeTopLeft(
        parentW, parentH, w, h,
        el.orientation ?? '', el.origo ?? '',
        el.position.x, el.position.y,
        el.centerPosition ?? false,
    );

    div.style.left = `${tl.x}px`;
    div.style.top = `${tl.y}px`;
    div.style.width = `${w}px`;
    div.style.height = `${h}px`;

    // Scale and rotation (visual only, doesn't affect layout position)
    const transforms: string[] = [];
    const elScale = el.scale ?? 1;
    if (elScale !== 1) {
        transforms.push(`scale(${elScale})`);
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
    // PDX: scale from top-left, but rotation from center
    // Use center origin when rotation is present, top-left otherwise
    if (el.rotation && el.rotation !== 0) {
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

    // Hover tooltip
    div.addEventListener('mouseenter', (e) => { e.stopPropagation(); showTip(el, e); div.classList.add('hover'); });
    div.addEventListener('mouseleave', (e) => { e.stopPropagation(); hideTip(); div.classList.remove('hover'); });
    div.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ command: 'goToLine', line: el.line }); });

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
    requestAnimationFrame(fitToView);
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
    document.getElementById('btn-layers')!.onclick = () => {
        document.getElementById('layers-panel')!.classList.toggle('hidden');
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
        toggle.title = 'Toggle visibility';
        toggle.onclick = (e) => {
            e.stopPropagation();
            const elDiv = document.querySelector(`.el[data-line="${el.line}"]`) as HTMLElement;
            if (elDiv) {
                const isHidden = elDiv.style.display === 'none';
                elDiv.style.display = isHidden ? '' : 'none';
                toggle.textContent = isHidden ? '👁' : '🚫';
                item.classList.toggle('hidden-el', !isHidden);
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

        // Click to locate
        item.onclick = () => {
            // Highlight in layers
            document.querySelectorAll('.layer-item.active').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            activeLayerLine = el.line;

            // Highlight element in preview
            document.querySelectorAll('.el.layer-highlight').forEach(i => i.classList.remove('layer-highlight'));
            const elDiv = document.querySelector(`.el[data-line="${el.line}"]`) as HTMLElement;
            if (elDiv) {
                elDiv.classList.add('layer-highlight');
                // Scroll element into view by panning the canvas
                const vp = document.getElementById('viewport')!;
                const vpRect = vp.getBoundingClientRect();
                const elRect = elDiv.getBoundingClientRect();
                const cx = elRect.left + elRect.width / 2;
                const cy = elRect.top + elRect.height / 2;
                const vpCx = vpRect.left + vpRect.width / 2;
                const vpCy = vpRect.top + vpRect.height / 2;
                // Only pan if element is mostly off-screen
                if (cx < vpRect.left || cx > vpRect.right || cy < vpRect.top || cy > vpRect.bottom) {
                    panX += vpCx - cx;
                    panY += vpCy - cy;
                    updateTransform();
                }
            }
            // Also jump to line in editor
            vscode.postMessage({ command: 'goToLine', line: el.line });
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

// ─── Init ───────────────────────────────────────────────────────────────────

window.addEventListener('message', e => {
    if (e.data.command === 'render') {
        renderAll(e.data.data, e.data.fileName);
        updateLayersPanel(e.data.data);
    }
});

setupControls();
updateTransform();
vscode.postMessage({ command: 'ready' });
