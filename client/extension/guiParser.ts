/**
 * PDXScript GUI file parser for Paradox Interactive games.
 * Parses .gui files and .gfx sprite definition files.
 */

// ─── Data Types ─────────────────────────────────────────────────────────────

export interface GuiElement {
    type: string;
    name: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    sizeExplicit?: boolean;
    percentWidth?: boolean;   // true when width was specified as e.g. "100%"
    percentHeight?: boolean;  // true when height was specified as e.g. "100%"
    orientation?: string;
    origo?: string;
    moveable?: boolean;
    clipping?: boolean;
    alwaysTransparent?: boolean;
    spriteKey?: string;
    spriteAttr?: 'spriteType' | 'quadTextureSprite';  // which GUI attr referenced the sprite
    spriteTexture?: string;
    spriteDefType?: string;  // GFX registry type (corneredTileSpriteType, spriteType, etc.)
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
}

export interface SpriteInfo {
    name: string;
    texturefile: string;
    noOfFrames?: number;
    spriteDefType?: string;
    borderSize?: { x: number; y: number };
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

enum TokenType {
    LBrace, RBrace, Equals, String, Identifier, Number, Comment, EOF,
}

interface Token {
    type: TokenType;
    value: string;
    line: number;
}

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;

    while (i < input.length) {
        const ch = input[i];

        if (ch === '\n') { line++; i++; continue; }
        if (ch === '\r') { line++; i++; if (i < input.length && input[i] === '\n') i++; continue; }
        if (ch === ' ' || ch === '\t') { i++; continue; }

        if (ch === '#') {
            while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
            continue;
        }
        if (ch === '{') { tokens.push({ type: TokenType.LBrace, value: '{', line }); i++; continue; }
        if (ch === '}') { tokens.push({ type: TokenType.RBrace, value: '}', line }); i++; continue; }
        if (ch === '=') { tokens.push({ type: TokenType.Equals, value: '=', line }); i++; continue; }

        if (ch === '"') {
            i++;
            const start = i;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\n') line++;
                i++;
            }
            tokens.push({ type: TokenType.String, value: input.slice(start, i), line });
            if (i < input.length) i++;
            continue;
        }

        // Numbers: must be a sign followed by digit, or a digit
        // Also consume trailing % for percentage values (e.g. 100%)
        if ((ch >= '0' && ch <= '9') || ((ch === '-' || ch === '+') && i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9')) {
            const start = i;
            if (ch === '-' || ch === '+') i++;
            while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) i++;
            if (i < input.length && input[i] === '%') i++; // consume trailing %
            tokens.push({ type: TokenType.Number, value: input.slice(start, i), line });
            continue;
        }

        // Arithmetic expressions @[ ... ]
        if (ch === '@' && i + 1 < input.length && input[i + 1] === '[') {
            const start = i;
            i += 2;
            let depth = 1;
            while (i < input.length && depth > 0) {
                if (input[i] === '[') depth++;
                else if (input[i] === ']') depth--;
                if (input[i] === '\n') line++;
                i++;
            }
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }

        // Identifiers
        if (isIdentStart(ch)) {
            const start = i;
            while (i < input.length && isIdentCont(input[i])) i++;
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }

        i++; // skip unknown
    }
    tokens.push({ type: TokenType.EOF, value: '', line });
    return tokens;
}

function isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '@';
}

function isIdentCont(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_' || ch === '.' || ch === '@' ||
        ch === ':' || ch === '/' || ch === '\\' ||
        ch === '-' || ch === '!' || ch === '%';
}

// ─── Parser ─────────────────────────────────────────────────────────────────

interface PdxNode {
    key: string;
    line: number;
    value?: string | number;
    children?: PdxNode[];
}

class Parser {
    private tokens: Token[];
    private pos: number;
    private variables: Map<string, number | string>;

    constructor(tokens: Token[], parentVars?: Map<string, number | string>) {
        this.tokens = tokens;
        this.pos = 0;
        this.variables = new Map(parentVars ?? []);
    }

    private peek(): Token {
        return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0 };
    }

    private advance(): Token {
        return this.tokens[this.pos++];
    }

    parse(): PdxNode[] {
        const nodes: PdxNode[] = [];
        while (this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        return nodes;
    }

    parseBlock(): PdxNode[] {
        const nodes: PdxNode[] = [];
        while (this.peek().type !== TokenType.RBrace && this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        if (this.peek().type === TokenType.RBrace) this.advance();
        return nodes;
    }

    private parseStatement(): PdxNode | null {
        const keyToken = this.advance();
        if (keyToken.type === TokenType.EOF) return null;

        // Variable definition: @VAR = value
        if (keyToken.value.startsWith('@') && this.peek().type === TokenType.Equals) {
            this.advance(); // skip =
            const valToken = this.advance();
            const numVal = parseFloat(valToken.value);
            if (!isNaN(numVal) && valToken.type !== TokenType.String) {
                this.variables.set(keyToken.value, numVal);
            } else {
                this.variables.set(keyToken.value, valToken.value);
            }
            return null;
        }

        // key = value or key = { ... }
        if (this.peek().type === TokenType.Equals) {
            this.advance(); // skip =
            if (this.peek().type === TokenType.LBrace) {
                this.advance(); // skip {
                const children = this.parseBlock();
                return { key: keyToken.value, line: keyToken.line, children };
            } else {
                const valToken = this.advance();
                const resolved = this.resolveValue(valToken);
                return { key: keyToken.value, line: keyToken.line, value: resolved };
            }
        }

        // Bare identifier/value
        const resolved = this.resolveValue(keyToken);
        return { key: String(resolved), line: keyToken.line };
    }

    private resolveValue(token: Token): string | number {
        if (token.type === TokenType.Number) {
            // Preserve percentage values as strings (e.g. "100%") for size parsing
            if (token.value.endsWith('%')) {
                return token.value;
            }
            return parseFloat(token.value);
        }
        if (token.value.startsWith('@[')) {
            return this.evaluateExpression(token.value);
        }
        if (token.value.startsWith('@')) {
            const v = this.variables.get(token.value);
            if (v !== undefined) {
                // Return as number if possible
                const nv = typeof v === 'string' ? parseFloat(v) : v;
                return !isNaN(nv as number) ? nv : v;
            }
        }
        return token.value;
    }

    private evaluateExpression(expr: string): string | number {
        // Strip out @[ and ]
        let inner = expr.slice(2, -1).trim();
        // Replace variables with their values
        const vars = Array.from(this.variables.entries()).sort((a, b) => b[0].length - a[0].length);
        for (const [k, v] of vars) {
            // Variable key in definition always has @ prepended (e.g., '@foo').
            // Inside expressions, it can be '@foo' or just 'foo'.
            const rawKey = k.startsWith('@') ? k.substring(1) : k;

            // 1. Exact string match for '@foo'
            inner = inner.split(k).join(String(v));
            // 2. Word boundary match for 'foo'
            const regex = new RegExp(`\\b${rawKey}\\b`, 'g');
            inner = inner.replace(regex, String(v));
        }
        
        try {
            // Only allow basic math characters to prevent injection/errors
            if (/^[0-9\.\+\-\*\/\s\(\)]+$/.test(inner)) {
                const result = new Function(`return (${inner})`)();
                return typeof result === 'number' && !isNaN(result) ? result : expr;
            } else {
                console.warn("Expression math regex failed or contains unresolved variables:", inner);
            }
        } catch (e) {
            console.warn("Expression evaluation threw:", inner, e);
            return expr;
        }
        return expr; // Unresolved or non-math expr
    }
}

// ─── GUI Element Builder ────────────────────────────────────────────────────

const GUI_ELEMENT_TYPES = new Set([
    'containerWindowType', 'buttonType', 'effectButtonType', 'guiButtonType',
    'iconType', 'instantTextBoxType', 'textboxType', 'editBoxType',
    'smoothListboxType', 'listBoxType', 'listboxType',
    'scrollbarType', 'extendedScrollbarType', 'scrollAreaType',
    'checkboxType', 'checkBoxType', 'spinnerType',
    'OverlappingElementsBoxType', 'overlappingElementsBoxType',
    'positionType', 'browserType', 'gridBoxType', 'windowType',
    'dropDownBoxType', 'expandButton', 'expandedWindow',
    // Case-insensitive aliases found in real game/mod files
    'ButtonType', 'IconType', 'ContainerWindowType',
]);

/** Normalize a GUI element type key to its canonical form */
function normalizeTypeKey(key: string): string {
    const lower = key.toLowerCase();
    const TYPE_MAP: Record<string, string> = {
        'buttontype': 'buttonType',
        'icontype': 'iconType',
        'containerwindowtype': 'containerWindowType',
        'effectbuttontype': 'effectButtonType',
        'guibuttontype': 'guiButtonType',
        'instanttextboxtype': 'instantTextBoxType',
        'textboxtype': 'textboxType',
        'editboxtype': 'editBoxType',
        'smoothlistboxtype': 'smoothListboxType',
        'listboxtype': 'listBoxType',
        'scrollbartype': 'scrollbarType',
        'extendedscrollbartype': 'extendedScrollbarType',
        'scrollareatype': 'scrollAreaType',
        'checkboxtype': 'checkboxType',
        'spinnertype': 'spinnerType',
        'overlappingelementsboxtype': 'OverlappingElementsBoxType',
        'positiontype': 'positionType',
        'browsertype': 'browserType',
        'gridboxtype': 'gridBoxType',
        'windowtype': 'windowType',
        'dropdownboxtype': 'dropDownBoxType',
    };
    return TYPE_MAP[lower] ?? key;
}

function numProp(nodes: PdxNode[], key: string): number | undefined {
    const n = nodes.find(n => n.key === key && typeof n.value === 'number');
    return n?.value as number | undefined;
}

function strProp(nodes: PdxNode[], key: string): string | undefined {
    const n = nodes.find(n => n.key === key && n.value !== undefined);
    return n !== undefined ? String(n.value) : undefined;
}

function getPos(nodes: PdxNode[]): { x: number; y: number } {
    const p = nodes.find(n => n.key === 'position' && n.children);
    if (!p?.children) return { x: 0, y: 0 };
    const x = numProp(p.children, 'x') ?? 0;
    const y = numProp(p.children, 'y') ?? 0;
    return { x, y };
}

function getSize(nodes: PdxNode[]): { width: number; height: number; explicit: boolean; usesWidthHeight: boolean; percentW: boolean; percentH: boolean } {
    const s = nodes.find(n => n.key === 'size' && n.children);
    if (!s?.children) return { width: 0, height: 0, explicit: false, usesWidthHeight: false, percentW: false, percentH: false };
    const hasWidth = numProp(s.children, 'width') !== undefined || strProp(s.children, 'width') !== undefined;
    const hasHeight = numProp(s.children, 'height') !== undefined || strProp(s.children, 'height') !== undefined;

    // Handle percentage values like "100%"
    let percentW = false, percentH = false;
    let w = numProp(s.children, 'width') ?? 0;
    let h = numProp(s.children, 'height') ?? 0;

    const wStr = strProp(s.children, 'width');
    const hStr = strProp(s.children, 'height');
    if (wStr && String(wStr).endsWith('%')) {
        w = parseFloat(String(wStr)) || 100;
        percentW = true;
    }
    if (hStr && String(hStr).endsWith('%')) {
        h = parseFloat(String(hStr)) || 100;
        percentH = true;
    }

    // Fallback to x/y keys
    if (w === 0 && !percentW) w = numProp(s.children, 'x') ?? 0;
    if (h === 0 && !percentH) h = numProp(s.children, 'y') ?? 0;

    return { width: w, height: h, explicit: true, usesWidthHeight: hasWidth || hasHeight, percentW, percentH };
}

function getMargin(nodes: PdxNode[]): { top: number; bottom: number; left: number; right: number } | undefined {
    const m = nodes.find(n => n.key === 'margin' && n.children);
    if (!m?.children) return undefined;
    const top = numProp(m.children, 'top') ?? 0;
    const bottom = numProp(m.children, 'bottom') ?? 0;
    const left = numProp(m.children, 'left') ?? 0;
    const right = numProp(m.children, 'right') ?? 0;
    if (top === 0 && bottom === 0 && left === 0 && right === 0) return undefined;
    return { top, bottom, left, right };
}

function getSlotSize(nodes: PdxNode[]): { width: number; height: number } | undefined {
    const s = nodes.find(n => n.key === 'slotSize' && n.children);
    if (!s?.children) return undefined;
    const w = numProp(s.children, 'width') ?? numProp(s.children, 'x') ?? 0;
    const h = numProp(s.children, 'height') ?? numProp(s.children, 'y') ?? 0;
    return { width: w, height: h };
}

function buildElement(type: string, nodes: PdxNode[], line: number, spriteIndex: Map<string, SpriteInfo>): GuiElement {
    // Normalize the type to canonical form
    const normalizedType = normalizeTypeKey(type);

    const name = strProp(nodes, 'name') ?? '';
    const position = getPos(nodes);
    const sizeResult = getSize(nodes);
    const size = { width: sizeResult.width, height: sizeResult.height };
    // Only mark as explicitly sized (for hiding 0x0) when using width/height format
    const sizeExplicit = sizeResult.explicit && sizeResult.usesWidthHeight;
    const percentWidth = sizeResult.percentW || undefined;
    const percentHeight = sizeResult.percentH || undefined;
    const orientation = strProp(nodes, 'orientation') ?? strProp(nodes, 'Orientation');
    const origo = strProp(nodes, 'origo');
    const alwaysTransparentStr = strProp(nodes, 'alwaystransparent') ?? strProp(nodes, 'alwaysTransparent');
    const alwaysTransparent = alwaysTransparentStr === 'yes';
    const clippingStr = strProp(nodes, 'clipping');
    const clipping = clippingStr === 'yes';

    // Margin support
    const margin = getMargin(nodes);

    // Spacing for OverlappingElementsBoxType and lists
    const spacingVal = numProp(nodes, 'spacing');
    const spacing = spacingVal !== undefined ? spacingVal : undefined;

    // SlotSize for gridBoxType
    const slotSize = getSlotSize(nodes);

    // Sprite reference — track which attribute was used
    // spriteType attr: fixed size = natural image × scale (size property IGNORED)
    // quadTextureSprite attr: check GFX registry type for render mode
    const quadSprite = strProp(nodes, 'quadTextureSprite');
    const spriteTypeAttr = strProp(nodes, 'spriteType');
    const spriteKey = quadSprite ?? spriteTypeAttr;
    const spriteAttr: 'spriteType' | 'quadTextureSprite' | undefined = quadSprite ? 'quadTextureSprite' : (spriteTypeAttr ? 'spriteType' : undefined);
    const spriteInfo = spriteKey ? spriteIndex.get(spriteKey) : undefined;
    const spriteTexture = spriteInfo?.texturefile;
    const spriteDefType = spriteInfo?.spriteDefType;
    const noOfFrames = spriteInfo?.noOfFrames;

    const frame = numProp(nodes, 'frame');

    const text = strProp(nodes, 'text');
    const font = strProp(nodes, 'font');
    const format = strProp(nodes, 'format');
    const maxWidth = numProp(nodes, 'maxWidth');
    const maxHeight = numProp(nodes, 'maxHeight');

    // Visual transform properties
    const scale = numProp(nodes, 'scale');
    const rotation = numProp(nodes, 'rotation');
    const alpha = numProp(nodes, 'alpha');
    const centerPositionStr = strProp(nodes, 'centerPosition');
    const centerPosition = centerPositionStr === 'yes';

    // Extra properties
    const skipKeys = new Set([
        'name', 'position', 'size', 'orientation', 'Orientation', 'origo',
        'alwaystransparent', 'alwaysTransparent', 'clipping',
        'quadTextureSprite', 'spriteType', 'text', 'font', 'format',
        'maxWidth', 'maxHeight', 'background', 'backGround',
        'scale', 'rotation', 'alpha', 'centerPosition',
        'margin', 'spacing', 'slotSize',
        ...GUI_ELEMENT_TYPES,
    ]);
    const properties: Record<string, unknown> = {};
    for (const n of nodes) {
        if (!skipKeys.has(n.key) && n.value !== undefined && !n.children) {
            properties[n.key] = n.value;
        }
    }

    // Children
    const children: GuiElement[] = [];

    // Background pseudo-element first (so it renders behind)
    // Case-insensitive: support both "background" and "backGround"
    for (const n of nodes) {
        if ((n.key === 'background' || n.key === 'backGround') && n.children) {
            const bgSprite = strProp(n.children, 'quadTextureSprite') ?? strProp(n.children, 'spriteType');
            const bgSpriteInfo = bgSprite ? spriteIndex.get(bgSprite) : undefined;
            const bgFrame = numProp(n.children, 'frame');
            const bgPos = getPos(n.children);
            children.push({
                type: 'background',
                name: strProp(n.children, 'name') ?? 'bg',
                position: bgPos,
                size: { width: 0, height: 0 }, // fill parent
                spriteKey: bgSprite,
                spriteTexture: bgSpriteInfo?.texturefile,
                spriteDefType: bgSpriteInfo?.spriteDefType,
                noOfFrames: bgSpriteInfo?.noOfFrames,
                borderSize: bgSpriteInfo?.borderSize,
                frame: bgFrame,
                children: [],
                properties: {},
                line: n.line,
            });
        }
    }

    // Real child elements (with case-normalized type check)
    for (const n of nodes) {
        if (GUI_ELEMENT_TYPES.has(n.key) && n.children) {
            children.push(buildElement(n.key, n.children, n.line, spriteIndex));
        } else if (n.children && !['background', 'backGround', 'position', 'size', 'margin', 'slotSize'].includes(n.key)) {
            // Check if the key is a GUI element type with different casing
            const normalized = normalizeTypeKey(n.key);
            if (GUI_ELEMENT_TYPES.has(normalized) || normalized !== n.key) {
                children.push(buildElement(normalized, n.children, n.line, spriteIndex));
            }
        }
    }

    return {
        type: normalizedType, name, position, size, sizeExplicit, percentWidth, percentHeight,
        orientation, origo, clipping, alwaysTransparent,
        spriteKey, spriteAttr, spriteTexture, spriteDefType, noOfFrames, frame, text, font, format,
        maxWidth, maxHeight, scale, rotation, alpha, centerPosition,
        borderSize: spriteInfo?.borderSize,
        margin, spacing, slotSize,
        children, properties, line,
    };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseGuiFile(content: string, spriteIndex: Map<string, SpriteInfo>): GuiElement[] {
    const tokens = tokenize(content);
    const parser = new Parser(tokens);
    const rootNodes = parser.parse();

    const elements: GuiElement[] = [];

    for (const node of rootNodes) {
        if (node.key === 'guiTypes' && node.children) {
            for (const child of node.children) {
                const childNorm = normalizeTypeKey(child.key);
                if ((GUI_ELEMENT_TYPES.has(child.key) || GUI_ELEMENT_TYPES.has(childNorm)) && child.children) {
                    elements.push(buildElement(child.key, child.children, child.line, spriteIndex));
                }
            }
        } else if (GUI_ELEMENT_TYPES.has(node.key) && node.children) {
            elements.push(buildElement(node.key, node.children, node.line, spriteIndex));
        } else if (node.children) {
            const nodeNorm = normalizeTypeKey(node.key);
            if (GUI_ELEMENT_TYPES.has(nodeNorm)) {
                elements.push(buildElement(node.key, node.children, node.line, spriteIndex));
            }
        }
    }

    // 1. Extract templates like scrollbarType so they don't float freely and can be instanced
    const templates = new Map<string, GuiElement>();
    function extractTemplates(els: GuiElement[]) {
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            if (el.type === 'scrollbarType' || el.type === 'extendedScrollbarType') {
                templates.set(el.name, el);
                els.splice(i, 1);
            } else {
                extractTemplates(el.children);
            }
        }
    }
    extractTemplates(elements);

    // 2. Inject scrollbars into containers that use them
    function injectScrollbars(els: GuiElement[]) {
        for (const el of els) {
            const rawSbName = el.properties['scrollbartype'] ?? el.properties['scrollbarType'];
            if (rawSbName && typeof rawSbName === 'string') {
                const sbName = rawSbName.replace(/['"]/g, '');
                const tmpl = templates.get(sbName);
                if (tmpl) {
                    const sb: GuiElement = JSON.parse(JSON.stringify(tmpl));
                    const isHorz = sb.properties['horizontal'] === 'yes' || sb.properties['horizontal'] === 1;
                    if (isHorz) {
                        sb.position.y += el.size.height;
                        if (!sb.size.width) sb.size.width = el.size.width; 
                    } else {
                        sb.position.x += el.size.width;
                        if (!sb.size.height) sb.size.height = el.size.height;
                    }
                    el.children.push(sb);
                } else {
                    const isHorz = sbName.toLowerCase().includes('horizontal');
                    el.children.push({
                        type: 'scrollbarType',
                        name: `(scrollbar: ${sbName})`,
                        position: { x: isHorz ? 0 : el.size.width, y: isHorz ? el.size.height : 0 },
                        size: { width: isHorz ? el.size.width : 16, height: isHorz ? 16 : el.size.height },
                        children: [],
                        properties: {},
                        line: el.line,
                    });
                }
            }
            injectScrollbars(el.children);
        }
    }
    injectScrollbars(elements);

    // 3. Extract option-template containers (those with an 'option_button' child)
    // These are list-item templates used by listBoxType elements
    const optionTemplates: GuiElement[] = [];
    for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        if ((el.type === 'containerWindowType' || el.type === 'windowType')
            && el.children.some(c => c.name === 'option_button')) {
            optionTemplates.push(el);
            elements.splice(i, 1);
        }
    }

    // 4. Inject option templates into listBoxType / smoothListboxType elements
    if (optionTemplates.length > 0) {
        function injectOptionTemplates(els: GuiElement[]) {
            for (const el of els) {
                if (el.type === 'listBoxType' || el.type === 'listboxType' || el.type === 'smoothListboxType') {
                    // Check if the listbox name contains 'option' or just inject the first template
                    const tmpl = optionTemplates[0];
                    if (tmpl) {
                        const copy: GuiElement = JSON.parse(JSON.stringify(tmpl));
                        copy.position = { x: 0, y: 0 };
                        el.children.push(copy);
                    }
                }
                injectOptionTemplates(el.children);
            }
        }
        injectOptionTemplates(elements);
    }

    return elements;
}

export function parseGfxFile(content: string): SpriteInfo[] {
    const tokens = tokenize(content);
    const parser = new Parser(tokens);
    const rootNodes = parser.parse();
    const sprites: SpriteInfo[] = [];

    function findSprites(nodes: PdxNode[]) {
        for (const node of nodes) {
            const isSprite = ['spriteType', 'corneredTileSpriteType', 'frameAnimatedSpriteType',
                'flagSpriteType', 'textSpriteType', 'progressbartype', 'portraitType'].includes(node.key);
            if (isSprite && node.children) {
                const name = strProp(node.children, 'name');
                const texturefile = strProp(node.children, 'texturefile')
                    ?? strProp(node.children, 'textureFile')
                    ?? strProp(node.children, 'masking_texture'); // portraitType uses this
                if (name) {
                    let borderSize: { x: number; y: number } | undefined;
                    const bsNode = node.children.find(c => c.key === 'borderSize' && c.children);
                    if (bsNode && bsNode.children) {
                        const bx = numProp(bsNode.children, 'x') ?? 0;
                        const by = numProp(bsNode.children, 'y') ?? 0;
                        if (bx > 0 || by > 0) borderSize = { x: bx, y: by };
                    }
                    sprites.push({ name, texturefile: texturefile ?? '', noOfFrames: numProp(node.children, 'noOfFrames'), spriteDefType: node.key, borderSize });
                }
            }
            if (node.children) findSprites(node.children);
        }
    }
    findSprites(rootNodes);
    return sprites;
}

export function buildSpriteIndex(gfxContents: Array<{ path: string; content: string }>): Map<string, SpriteInfo> {
    const index = new Map<string, SpriteInfo>();
    for (const { content } of gfxContents) {
        for (const sprite of parseGfxFile(content)) {
            index.set(sprite.name, sprite);
        }
    }
    return index;
}
