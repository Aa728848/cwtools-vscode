"use strict";
/**
 * PDXScript GUI file parser for Paradox Interactive games.
 * Parses .gui files and .gfx sprite definition files.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGuiFile = parseGuiFile;
exports.parseGfxFile = parseGfxFile;
exports.buildSpriteIndex = buildSpriteIndex;
// ─── Tokenizer ──────────────────────────────────────────────────────────────
var TokenType;
(function (TokenType) {
    TokenType[TokenType["LBrace"] = 0] = "LBrace";
    TokenType[TokenType["RBrace"] = 1] = "RBrace";
    TokenType[TokenType["Equals"] = 2] = "Equals";
    TokenType[TokenType["String"] = 3] = "String";
    TokenType[TokenType["Identifier"] = 4] = "Identifier";
    TokenType[TokenType["Number"] = 5] = "Number";
    TokenType[TokenType["Comment"] = 6] = "Comment";
    TokenType[TokenType["EOF"] = 7] = "EOF";
})(TokenType || (TokenType = {}));
function tokenize(input) {
    const tokens = [];
    let i = 0;
    let line = 1;
    while (i < input.length) {
        const ch = input[i];
        if (ch === '\n') {
            line++;
            i++;
            continue;
        }
        if (ch === '\r') {
            line++;
            i++;
            if (i < input.length && input[i] === '\n')
                i++;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            i++;
            continue;
        }
        if (ch === '#') {
            while (i < input.length && input[i] !== '\n' && input[i] !== '\r')
                i++;
            continue;
        }
        if (ch === '{') {
            tokens.push({ type: TokenType.LBrace, value: '{', line });
            i++;
            continue;
        }
        if (ch === '}') {
            tokens.push({ type: TokenType.RBrace, value: '}', line });
            i++;
            continue;
        }
        if (ch === '=') {
            tokens.push({ type: TokenType.Equals, value: '=', line });
            i++;
            continue;
        }
        if (ch === '"') {
            i++;
            const start = i;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\n')
                    line++;
                i++;
            }
            tokens.push({ type: TokenType.String, value: input.slice(start, i), line });
            if (i < input.length)
                i++;
            continue;
        }
        // Numbers: must be a sign followed by digit, or a digit
        if ((ch >= '0' && ch <= '9') || ((ch === '-' || ch === '+') && i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9')) {
            const start = i;
            if (ch === '-' || ch === '+')
                i++;
            while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.'))
                i++;
            tokens.push({ type: TokenType.Number, value: input.slice(start, i), line });
            continue;
        }
        // Arithmetic expressions @[ ... ]
        if (ch === '@' && i + 1 < input.length && input[i + 1] === '[') {
            const start = i;
            i += 2;
            let depth = 1;
            while (i < input.length && depth > 0) {
                if (input[i] === '[')
                    depth++;
                else if (input[i] === ']')
                    depth--;
                if (input[i] === '\n')
                    line++;
                i++;
            }
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }
        // Identifiers
        if (isIdentStart(ch)) {
            const start = i;
            while (i < input.length && isIdentCont(input[i]))
                i++;
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }
        i++; // skip unknown
    }
    tokens.push({ type: TokenType.EOF, value: '', line });
    return tokens;
}
function isIdentStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '@';
}
function isIdentCont(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_' || ch === '.' || ch === '@' ||
        ch === ':' || ch === '/' || ch === '\\' ||
        ch === '-' || ch === '!' || ch === '%';
}
class Parser {
    constructor(tokens, parentVars) {
        this.tokens = tokens;
        this.pos = 0;
        this.variables = new Map(parentVars !== null && parentVars !== void 0 ? parentVars : []);
    }
    peek() {
        var _a;
        return (_a = this.tokens[this.pos]) !== null && _a !== void 0 ? _a : { type: TokenType.EOF, value: '', line: 0 };
    }
    advance() {
        return this.tokens[this.pos++];
    }
    parse() {
        const nodes = [];
        while (this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node)
                nodes.push(node);
        }
        return nodes;
    }
    parseBlock() {
        const nodes = [];
        while (this.peek().type !== TokenType.RBrace && this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node)
                nodes.push(node);
        }
        if (this.peek().type === TokenType.RBrace)
            this.advance();
        return nodes;
    }
    parseStatement() {
        const keyToken = this.advance();
        if (keyToken.type === TokenType.EOF)
            return null;
        // Variable definition: @VAR = value
        if (keyToken.value.startsWith('@') && this.peek().type === TokenType.Equals) {
            this.advance(); // skip =
            const valToken = this.advance();
            const numVal = parseFloat(valToken.value);
            if (!isNaN(numVal) && valToken.type !== TokenType.String) {
                this.variables.set(keyToken.value, numVal);
            }
            else {
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
            }
            else {
                const valToken = this.advance();
                const resolved = this.resolveValue(valToken);
                return { key: keyToken.value, line: keyToken.line, value: resolved };
            }
        }
        // Bare identifier/value
        const resolved = this.resolveValue(keyToken);
        return { key: String(resolved), line: keyToken.line };
    }
    resolveValue(token) {
        if (token.type === TokenType.Number) {
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
                return !isNaN(nv) ? nv : v;
            }
        }
        return token.value;
    }
    evaluateExpression(expr) {
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
            }
        }
        catch (_a) {
            return expr;
        }
        return expr; // Unresolved or non-math expr
    }
}
// ─── GUI Element Builder ────────────────────────────────────────────────────
const GUI_ELEMENT_TYPES = new Set([
    'containerWindowType', 'buttonType', 'effectButtonType', 'guiButtonType',
    'iconType', 'instantTextBoxType', 'textboxType', 'editBoxType',
    'smoothListboxType', 'listBoxType', 'scrollbarType', 'extendedScrollbarType',
    'checkboxType', 'spinnerType', 'OverlappingElementsBoxType', 'positionType',
    'browserType',
]);
function numProp(nodes, key) {
    const n = nodes.find(n => n.key === key && typeof n.value === 'number');
    return n === null || n === void 0 ? void 0 : n.value;
}
function strProp(nodes, key) {
    const n = nodes.find(n => n.key === key && n.value !== undefined);
    return n !== undefined ? String(n.value) : undefined;
}
function getPos(nodes) {
    var _a, _b;
    const p = nodes.find(n => n.key === 'position' && n.children);
    if (!(p === null || p === void 0 ? void 0 : p.children))
        return { x: 0, y: 0 };
    const x = (_a = numProp(p.children, 'x')) !== null && _a !== void 0 ? _a : 0;
    const y = (_b = numProp(p.children, 'y')) !== null && _b !== void 0 ? _b : 0;
    return { x, y };
}
function getSize(nodes) {
    var _a, _b, _c, _d;
    const s = nodes.find(n => n.key === 'size' && n.children);
    if (!(s === null || s === void 0 ? void 0 : s.children))
        return { width: 0, height: 0 };
    const w = (_b = (_a = numProp(s.children, 'width')) !== null && _a !== void 0 ? _a : numProp(s.children, 'x')) !== null && _b !== void 0 ? _b : 0;
    const h = (_d = (_c = numProp(s.children, 'height')) !== null && _c !== void 0 ? _c : numProp(s.children, 'y')) !== null && _d !== void 0 ? _d : 0;
    return { width: w, height: h };
}
function buildElement(type, nodes, line, spriteIndex) {
    var _a, _b, _c, _d, _e, _f;
    const name = (_a = strProp(nodes, 'name')) !== null && _a !== void 0 ? _a : '';
    const position = getPos(nodes);
    const size = getSize(nodes);
    const orientation = (_b = strProp(nodes, 'orientation')) !== null && _b !== void 0 ? _b : strProp(nodes, 'Orientation');
    const origo = strProp(nodes, 'origo');
    const alwaysTransparentStr = (_c = strProp(nodes, 'alwaystransparent')) !== null && _c !== void 0 ? _c : strProp(nodes, 'alwaysTransparent');
    const alwaysTransparent = alwaysTransparentStr === 'yes';
    // Sprite reference
    const spriteKey = (_d = strProp(nodes, 'quadTextureSprite')) !== null && _d !== void 0 ? _d : strProp(nodes, 'spriteType');
    const spriteTexture = spriteKey ? spriteIndex.get(spriteKey) : undefined;
    const text = strProp(nodes, 'text');
    const font = strProp(nodes, 'font');
    const format = strProp(nodes, 'format');
    const maxWidth = numProp(nodes, 'maxWidth');
    const maxHeight = numProp(nodes, 'maxHeight');
    // Extra properties
    const skipKeys = new Set([
        'name', 'position', 'size', 'orientation', 'Orientation', 'origo',
        'alwaystransparent', 'alwaysTransparent',
        'quadTextureSprite', 'spriteType', 'text', 'font', 'format',
        'maxWidth', 'maxHeight', 'background',
        ...GUI_ELEMENT_TYPES,
    ]);
    const properties = {};
    for (const n of nodes) {
        if (!skipKeys.has(n.key) && n.value !== undefined && !n.children) {
            properties[n.key] = n.value;
        }
    }
    // Children
    const children = [];
    // Background pseudo-element first (so it renders behind)
    for (const n of nodes) {
        if (n.key === 'background' && n.children) {
            const bgSprite = (_e = strProp(n.children, 'quadTextureSprite')) !== null && _e !== void 0 ? _e : strProp(n.children, 'spriteType');
            children.push({
                type: 'background',
                name: (_f = strProp(n.children, 'name')) !== null && _f !== void 0 ? _f : 'bg',
                position: { x: 0, y: 0 },
                size: { width: 0, height: 0 }, // fill parent
                spriteKey: bgSprite,
                spriteTexture: bgSprite ? spriteIndex.get(bgSprite) : undefined,
                children: [],
                properties: {},
                line: n.line,
            });
        }
    }
    // Real child elements
    for (const n of nodes) {
        if (GUI_ELEMENT_TYPES.has(n.key) && n.children) {
            children.push(buildElement(n.key, n.children, n.line, spriteIndex));
        }
    }
    return {
        type, name, position, size, orientation, origo, alwaysTransparent,
        spriteKey, spriteTexture, text, font, format,
        maxWidth, maxHeight, children, properties, line,
    };
}
// ─── Public API ─────────────────────────────────────────────────────────────
function parseGuiFile(content, spriteIndex) {
    const tokens = tokenize(content);
    const parser = new Parser(tokens);
    const rootNodes = parser.parse();
    const elements = [];
    for (const node of rootNodes) {
        if (node.key === 'guiTypes' && node.children) {
            for (const child of node.children) {
                if (GUI_ELEMENT_TYPES.has(child.key) && child.children) {
                    elements.push(buildElement(child.key, child.children, child.line, spriteIndex));
                }
            }
        }
        else if (GUI_ELEMENT_TYPES.has(node.key) && node.children) {
            elements.push(buildElement(node.key, node.children, node.line, spriteIndex));
        }
    }
    return elements;
}
function parseGfxFile(content) {
    const tokens = tokenize(content);
    const parser = new Parser(tokens);
    const rootNodes = parser.parse();
    const sprites = [];
    function findSprites(nodes) {
        var _a;
        for (const node of nodes) {
            const isSprite = ['spriteType', 'corneredTileSpriteType', 'frameAnimatedSpriteType',
                'flagSpriteType', 'textSpriteType', 'progressbartype'].includes(node.key);
            if (isSprite && node.children) {
                const name = strProp(node.children, 'name');
                const texturefile = (_a = strProp(node.children, 'texturefile')) !== null && _a !== void 0 ? _a : strProp(node.children, 'textureFile');
                if (name) {
                    sprites.push({ name, texturefile: texturefile !== null && texturefile !== void 0 ? texturefile : '', noOfFrames: numProp(node.children, 'noOfFrames') });
                }
            }
            if (node.children)
                findSprites(node.children);
        }
    }
    findSprites(rootNodes);
    return sprites;
}
function buildSpriteIndex(gfxContents) {
    const index = new Map();
    for (const { content } of gfxContents) {
        for (const sprite of parseGfxFile(content)) {
            index.set(sprite.name, sprite.texturefile);
        }
    }
    return index;
}
