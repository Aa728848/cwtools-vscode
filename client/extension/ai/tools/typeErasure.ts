/**
 * TypeScript-to-JavaScript erasure for the run_code QuickJS guest.
 *
 * The guest executes plain JavaScript in QuickJS/WASM, so model-authored
 * TypeScript must be erased before evaluation. A regex pass over the source is
 * not sufficient: TypeScript type-annotation grammar overlaps JavaScript
 * object-literal shorthand, so a naive pattern silently rewrites a value into a
 * bare identifier. '{ isRegex: false }' becomes '{ isRegex }', which then
 * throws "ReferenceError: isRegex is not defined" inside the guest and makes
 * PTC mode appear broken.
 *
 * This module tokenizes the program first and only erases where the token
 * stream proves a type context. Strings, template literals, regular
 * expressions, comments, numbers, and identifiers come from a dedicated
 * scanner, so no transformation can reach inside a literal.
 */

/** Outcome of erasing TypeScript syntax from one program. */
export interface TypeErasureResult {
    /** Erased JavaScript source. */
    code: string;
    /** Applied erasure categories, in first-use order (diagnostics only). */
    applied: string[];
}

type TokenKind = 'ws' | 'comment' | 'string' | 'template' | 'regex' | 'number' | 'ident' | 'punct';

interface Token {
    readonly kind: TokenKind;
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly line: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const WHITESPACE = /\s/;
/** ECMAScript LineTerminators: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const HEX_DIGIT = /[0-9a-fA-F_]/;
const DECIMAL_PART = /[0-9_]/;
const REGEX_FLAG = /[a-z]/i;

/** Keywords after which a slash opens a regular expression literal, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/** Longest-first so multi-character punctuation wins over its prefix. */
const MULTI_CHARACTER_PUNCTUATION = [
    '>>>=', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '...',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
] as const;

/** Tokens after which a type annotation may begin. */
const TYPE_CONTEXT_PREFIX = new Set([
    ':', 'as', 'satisfies', 'extends', 'implements', '|', '&', '<', 'new',
    '=>', ',', '[', '?', 'function', 'return', '=', 'await', 'yield',
    'typeof', 'keyof', 'in', 'readonly',
]);

/** Tokens that may immediately follow a complete erased type. */
const TYPE_END = new Set([
    '(', ')', ',', ';', ']', '}', '=', '=>', '|', '&', '>', ':', '{', '[',
    'as', 'satisfies', 'extends', 'implements', '?', '.',
]);

/**
 * Keywords that can begin an expression but never END one. A `!` that follows
 * one of these is prefix logical negation, not a non-null assertion.
 */
const NON_EXPRESSION_END_KEYWORDS = new Set([
    'return', 'typeof', 'delete', 'void', 'new', 'in', 'instanceof', 'case', 'do', 'else',
    'yield', 'await', 'throw', 'of', 'if', 'while', 'for', 'switch', 'catch', 'var', 'let', 'const',
]);

/**
 * Built-in type names. A single bare name inside a paren group is a
 * parenthesized type when it is one of these (`(number) => R`), and a parameter
 * binding otherwise (`(x) => R`).
 */
const TYPE_KEYWORD_NAMES = new Set([
    'string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object',
    'symbol', 'bigint', 'null', 'undefined', 'this', 'true', 'false',
]);

/** Keywords that may prefix an atom inside a type expression. */
const TYPE_PREFIX_KEYWORDS = new Set([
    'typeof', 'keyof', 'readonly', 'infer', 'unique', 'abstract', 'new', 'import', 'asserts',
]);

/** Keywords whose parenthesized head is not an expression.
 * A `!` immediately after the closing paren is prefix negation, not a
 * non-null assertion.
 */
const CONTROL_HEAD_KEYWORDS = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'with',
]);

/** Keywords (or a name) that may follow `declare` in an ambient declaration. */
const DECLARE_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'class', 'namespace', 'module', 'global',
    'interface', 'type', 'enum', 'abstract', 'async', 'export', 'import',
]);

/** Modifiers that may precede a class member or a typed parameter. */
const MEMBER_MODIFIERS = new Set([
    'static', 'readonly', 'public', 'private', 'protected', 'declare', 'override', 'accessor', 'abstract',
]);

/** Keywords that can start a new statement when no semicolon terminates the previous one. */
const STATEMENT_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'class', 'return', 'if', 'for', 'while', 'do', 'switch',
    'try', 'throw', 'import', 'export', 'interface', 'type', 'enum', 'async', 'await', 'break',
    'continue', 'with', 'debugger', 'delete', 'void', 'new', 'super', 'this', 'default',
]);

const MATCHING_CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const MATCHING_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function isIdentifierStart(character: string | undefined): boolean {
    return character !== undefined && IDENT_START.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
    return character !== undefined && IDENT_PART.test(character);
}

/** Skip a single- or double-quoted string, honoring backslash escapes. */
function skipQuotedString(source: string, start: number): number {
    const quote = source[start];
    let cursor = start + 1;
    while (cursor < source.length) {
        const character = source[cursor] ?? '';
        if (character === '\\') { cursor += 2; continue; }
        if (character === quote) return cursor + 1;
        if (character === '\n') return cursor;
        cursor++;
    }
    return cursor;
}

/**
 * True when a '/' starts a regular-expression literal rather than the division
 * operator, judged from the last significant character before it. An empty
 * string means start-of-input or a position where an expression is expected.
 */
function regexAllowedAfter(previousSignificant: string): boolean {
    if (previousSignificant === '') return true;
    if (/[A-Za-z0-9_$\\.]/.test(previousSignificant)) return false;
    return previousSignificant !== ')' && previousSignificant !== ']' && previousSignificant !== '}';
}
/**
 * Skip a template literal, including nested ${...} substitutions that may
 * themselves contain strings, nested templates, comments, and braces.
 */
function skipTemplateLiteral(source: string, start: number): number {
    const length = source.length;
// NOTE (known limitation): a `${...}` substitution is skipped as opaque text, so a
// type assertion written INSIDE a substitution (`\`a${x as number}b\``) is not
// erased. The old regex-based eraser masked whole template literals too, so this
// is pre-existing, and the substitution is usually already valid JavaScript.
    let cursor = start + 1;
    let depth = 0;
    /** Braces opened inside the current `${...}` substitution. */
    let braceDepth = 0;
    // A regex literal inside a `${...}` substitution may contain quotes
    // (`/\"/g`), so '/' context has to be tracked. Read as a
    // string, that quote desynchronises the scan and every later token is
    // misclassified, which corrupts unrelated statements further down the file.
    let previousSignificant = '';
    while (cursor < length) {
        const character = source[cursor] ?? '';
        if (character === '\\') { cursor += 2; previousSignificant = '\\'; continue; }
        if (depth === 0 && character === '`') return cursor + 1;
        if (character === '$' && source[cursor + 1] === '{') { depth++; braceDepth++; cursor += 2; previousSignificant = '{'; continue; }
        if (depth === 0) { if (!WHITESPACE.test(character)) previousSignificant = character; cursor++; continue; }
        // Only the brace that balances the `${` closes the substitution. An
        // object literal or an arrow body inside it also contains braces, and
        // treating the first `}` as the end cut the template short - the
        // template's own text was then tokenised as code and its `: ` was
        // erased as a type annotation.
        if (character === '{') { braceDepth++; cursor++; previousSignificant = '{'; continue; }
        if (character === '}') {
            braceDepth--;
            cursor++;
            previousSignificant = '}';
            if (braceDepth === 0) depth--;
            continue;
        }
        if (character === '/' && regexAllowedAfter(previousSignificant)) {
            cursor = skipRegexLiteral(source, cursor);
            previousSignificant = '/';
            continue;
        }
        if (character === '/' && source[cursor + 1] === '/') {
            while (cursor < length && source[cursor] !== '\n') cursor++;
            continue;
        }
        if (character === '/' && source[cursor + 1] === '*') {
            cursor += 2;
            while (cursor < length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor++;
            cursor = Math.min(length, cursor + 2);
            continue;
        }
        if (character === "\"" || character === "'") { cursor = skipQuotedString(source, cursor); previousSignificant = "\""; continue; }
        if (character === '`') { cursor = skipTemplateLiteral(source, cursor); previousSignificant = '`'; continue; }
        if (!WHITESPACE.test(character)) previousSignificant = character;
        cursor++;
    }
    return length;
}
/** Skip a regular expression literal body plus its trailing flags. */
function skipRegexLiteral(source: string, start: number): number {
    const length = source.length;
    let cursor = start + 1;
    let inCharacterClass = false;
    while (cursor < length) {
        const character = source[cursor] ?? '';
        if (character === '\\') { cursor += 2; continue; }
        if (character === '\n') break;
        if (inCharacterClass) {
            if (character === ']') inCharacterClass = false;
        } else if (character === '[') {
            inCharacterClass = true;
        } else if (character === '/') {
            cursor++;
            break;
        }
        cursor++;
    }
    while (cursor < length && REGEX_FLAG.test(source[cursor] ?? '')) cursor++;
    return cursor;
}

/** Split one program into literals, identifiers, punctuation, and trivia. */
function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    const length = source.length;
    let cursor = 0;
    let line = 1;
    let previous: Token | undefined;
    const push = (kind: TokenKind, start: number, startLine: number, end: number): void => {
        const token: Token = { kind, text: source.slice(start, end), start, end, line: startLine };
        tokens.push(token);
        if (kind !== 'ws' && kind !== 'comment') previous = token;
    };
    /** A slash is division unless the previous significant token can end an expression. */
    const regexAllowed = (): boolean => {
        if (previous === undefined) return true;
        if (previous.kind === 'ident') return REGEX_PRECEDING_KEYWORDS.has(previous.text);
        if (previous.kind === 'string' || previous.kind === 'number'
            || previous.kind === 'template' || previous.kind === 'regex') return false;
        if (previous.kind === 'punct') {
            return previous.text !== ')' && previous.text !== ']' && previous.text !== '}';
        }
        return true;
    };
    while (cursor < length) {
        const character = source[cursor] ?? '';
        const startLine = line;
        if (LINE_TERMINATOR.test(character)) {
            line++;
            cursor++;
            push('ws', cursor - 1, startLine, cursor);
            continue;
        }
        if (WHITESPACE.test(character)) {
            const start = cursor;
            while (cursor < length) {
                const following = source[cursor] ?? '';
                if (LINE_TERMINATOR.test(following)) { line++; cursor++; continue; }
                if (!WHITESPACE.test(following)) break;
                cursor++;
            }
            push('ws', start, startLine, cursor);
            continue;
        }
        if (character === '/' && source[cursor + 1] === '/') {
            const start = cursor;
            while (cursor < length && !LINE_TERMINATOR.test(source[cursor] ?? '')) cursor++;
            push('comment', start, startLine, cursor);
            continue;
        }
        if (character === '/' && source[cursor + 1] === '*') {
            const start = cursor;
            cursor += 2;
            while (cursor < length && !(source[cursor] === '*' && source[cursor + 1] === '/')) {
                if (LINE_TERMINATOR.test(source[cursor] ?? '')) line++;
                cursor++;
            }
            cursor = Math.min(length, cursor + 2);
            push('comment', start, startLine, cursor);
            continue;
        }
        if (character === '"' || character === "'") {
            const start = cursor;
            cursor = skipQuotedString(source, cursor);
            push('string', start, startLine, cursor);
            continue;
        }
        if (character === '\u0060') {
            const start = cursor;
            const end = skipTemplateLiteral(source, cursor);
            for (let index = cursor; index < end; index++) if (LINE_TERMINATOR.test(source[index] ?? '')) line++;
            cursor = end;
            push('template', start, startLine, cursor);
            continue;
        }
        if (character === '/') {
            if (regexAllowed()) {
                const start = cursor;
                cursor = skipRegexLiteral(source, cursor);
                push('regex', start, startLine, cursor);
                continue;
            }
            push('punct', cursor, startLine, cursor + 1);
            cursor++;
            continue;
        }
        if (DIGIT.test(character) || (character === '.' && DIGIT.test(source[cursor + 1] ?? ''))) {
            const start = cursor;
            if (character === '0' && /[xXoObB]/.test(source[cursor + 1] ?? '')) {
                cursor += 2;
                while (cursor < length && HEX_DIGIT.test(source[cursor] ?? '')) cursor++;
            } else {
                while (cursor < length && DECIMAL_PART.test(source[cursor] ?? '')) cursor++;
                if (source[cursor] === '.') {
                    cursor++;
                    while (cursor < length && DECIMAL_PART.test(source[cursor] ?? '')) cursor++;
                }
                if (/[eE]/.test(source[cursor] ?? '')) {
                    cursor++;
                    if (/[+-]/.test(source[cursor] ?? '')) cursor++;
                    while (cursor < length && DIGIT.test(source[cursor] ?? '')) cursor++;
                }
            }
            if (source[cursor] === 'n') cursor++;
            push('number', start, startLine, cursor);
            continue;
        }
        if (isIdentifierStart(character)) {
            const start = cursor;
            while (cursor < length && isIdentifierPart(source[cursor])) cursor++;
            push('ident', start, startLine, cursor);
            continue;
        }
        const punctuation = MULTI_CHARACTER_PUNCTUATION.find(candidate => source.startsWith(candidate, cursor));
        if (punctuation !== undefined) {
            push('punct', cursor, startLine, cursor + punctuation.length);
            cursor += punctuation.length;
            continue;
        }
        push('punct', cursor, startLine, cursor + 1);
        cursor++;
    }
    return tokens;
}

/** Render an enum member as an object key: bare when it is a valid identifier. */
function jsonObjectKey(text: string, kind: TokenKind): string {
    const raw = kind === 'string' ? text.replace(/^["']|["']$/g, '') : text;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : JSON.stringify(raw);
}

/** Number of leading '<' characters of a possibly multi-character token. */
function openingAngleDepth(text: string): number {
    let depth = 0;
    while (depth < text.length && text[depth] === '<') depth++;
    return depth;
}

/** Number of leading '>' characters of a possibly multi-character token. */
function closingAngleDepth(text: string): number {
    let depth = 0;
    while (depth < text.length && text[depth] === '>') depth++;
    return depth;
}

/**
 * A token-indexed view of one program: significant-token addressing plus the
 * erasure bookkeeping shared by every pass. Erased ranges are recorded as dead
 * token indices and rendered out once at the end, so passes never have to agree
 * on string offsets.
 */
class ErasurePlan {
    private readonly tokens: Token[];
    /** Raw token index of each significant (non-trivia) token, in order. */
    private readonly significant: number[];
    private readonly dead = new Set<number>();
    private readonly replacements = new Map<number, { readonly end: number; readonly text: string }>();
    private readonly labels: string[] = [];
    /** Bumped whenever the dead set changes, to invalidate derived caches. */
    private deadRevision = 0;

    private readonly source: string;

    constructor(source: string) {
        this.source = source;
        this.tokens = tokenize(source);
        this.significant = [];
        for (let index = 0; index < this.tokens.length; index++) {
            const kind = this.tokens[index]?.kind;
            if (kind !== 'ws' && kind !== 'comment') this.significant.push(index);
        }
    }

    get size(): number {
        return this.significant.length;
    }

    text(position: number): string {
        return this.token(position)?.text ?? '';
    }

    kind(position: number): TokenKind {
        return this.token(position)?.kind ?? 'punct';
    }

    /** Token text as it appeared in the source, ignoring earlier erasure. */
    originalText(position: number): string {
        return this.token(position)?.text ?? '';
    }

    start(position: number): number {
        return this.token(position)?.start ?? 0;
    }

    end(position: number): number {
        return this.token(position)?.end ?? 0;
    }

    line(position: number): number {
        return this.token(position)?.line ?? 0;
    }

    /** True when a line terminator separates these two adjacent tokens. */
    hasLineBreakBetween(left: number, right: number): boolean {
        const leftToken = this.token(left);
        const rightToken = this.token(right);
        if (!leftToken || !rightToken) return false;
        for (let index = leftToken.end; index < rightToken.start; index++) {
            if (LINE_TERMINATOR.test(this.source[index] ?? '')) return true;
        }
        return false;
    }

    isIdentifier(position: number): boolean {
        return this.kind(position) === 'ident';
    }

    isLiteral(position: number): boolean {
        const kind = this.kind(position);
        return kind === 'string' || kind === 'template' || kind === 'regex' || kind === 'number';
    }

    /** True when both significant tokens are adjacent in the original source. */
    adjacent(left: number, right: number): boolean {
        return this.end(left) === this.start(right);
    }

    isDead(position: number): boolean {
        if (position < 0 || position >= this.size) return true;
        return this.dead.has(this.significant[position] as number);
    }

    /** Next live significant position at or after the argument, or {@link size}. */
    next(position: number): number {
        let cursor = Math.max(0, position);
        while (cursor < this.size && this.isDead(cursor)) cursor++;
        return cursor;
    }

    /** Previous live significant position at or before the argument, or -1. */
    previous(position: number): number {
        let cursor = Math.min(position, this.size - 1);
        while (cursor >= 0 && this.isDead(cursor)) cursor--;
        return cursor;
    }

    get revision(): number {
        return this.deadRevision;
    }

    kill(position: number, label = ''): void {
        if (position < 0 || position >= this.size) return;
        this.dead.add(this.significant[position] as number);
        this.deadRevision++;
        this.note(label);
    }

    killRange(from: number, to: number, label = ''): void {
        if (from > to) return;
        for (let position = Math.max(0, from); position <= to && position < this.size; position++) {
            this.dead.add(this.significant[position] as number);
        }
        this.deadRevision++;
        this.note(label);
    }

    /**
     * Replace a significant-token range with generated code. The anchor token
     * stays live so {@link render} still visits it and emits the replacement;
     * only the tokens after the anchor are erased.
     */
    replace(from: number, to: number, text: string, label = ''): void {
        if (from < 0 || to >= this.size || from > to) return;
        this.replacements.set(from, { end: to, text });
        this.killRange(from + 1, to);
        this.note(label);
    }

    hasReplacement(position: number): boolean {
        if (this.isDead(position)) return false;
        return this.replacements.has(position);
    }

    replacementAt(position: number): { readonly end: number; readonly text: string } | undefined {
        return this.replacements.get(position);
    }

    private note(label: string): void {
        if (label && !this.labels.includes(label)) this.labels.push(label);
    }

    get applied(): string[] {
        return [...this.labels];
    }

    /**
     * Render the source with every erased range removed and replacement inlined.
     * Erased tokens advance the cursor past their own text; the gap refill then
     * only ever restores trivia (whitespace and comments) that sat between two
     * surviving tokens, never the text that was just erased.
     */
    render(source: string): string {
        let output = '';
        let cursor = 0;
        for (let position = 0; position < this.size; position++) {
            const token = this.token(position) as Token;
            if (this.isDead(position)) {
                cursor = Math.max(cursor, token.end);
                continue;
            }
            if (token.start > cursor) output += source.slice(cursor, token.start);
            const replacement = this.replacements.get(position);
            if (replacement !== undefined) {
                output += replacement.text;
                const endToken = this.token(replacement.end) as Token;
                cursor = endToken.end;
                continue;
            }
            output += token.text;
            cursor = token.end;
        }

        output += source.slice(cursor);
        return output;
    }

    private token(position: number): Token | undefined {
        const raw = this.significant[position];
        return raw === undefined ? undefined : this.tokens[raw];
    }
}

/** Bracket and angle-bracket matching plus type scanning over one program. */
class TokenNavigator {
    private enclosingTable = new Int32Array(0);
    private enclosingRevision = -1;

    constructor(private readonly plan: ErasurePlan) {}

    /**
     * True when the source between the end of the PREVIOUS token and the start of
     * `position` contains an ECMAScript line terminator. Comparing two tokens'
     * line numbers is not enough: the preceding token may itself be multiline (a
     * template literal or a block comment), which would hide the break.
     */
    hasPrecedingLineBreak(position: number): boolean {
        const previous = this.plan.previous(position - 1);
        if (previous < 0) return false;
        return this.plan.hasLineBreakBetween(previous, position);
    }

    /** Significant position of the token matching the opener at the argument. */
    matchCloser(position: number): number {
        const open = this.plan.text(position);
        const close = MATCHING_CLOSER[open];
        if (close === undefined) return -1;
        let depth = 0;
        for (let cursor = position; cursor < this.plan.size; cursor++) {
            if (this.plan.isDead(cursor)) continue;
            const text = this.plan.text(cursor);
            if (text === open) depth++;
            else if (text === close) {
                depth--;
                if (depth === 0) return cursor;
            }
        }
        return -1;
    }

    /** Significant position of the opener matching the closer at the argument. */
    matchOpener(position: number): number {
        const close = this.plan.text(position);
        const open = MATCHING_OPENER[close];
        if (open === undefined) return -1;
        let depth = 0;
        for (let cursor = position; cursor >= 0; cursor--) {
            if (this.plan.isDead(cursor)) continue;
            const text = this.plan.text(cursor);
            if (text === close) depth++;
            else if (text === open) {
                depth--;
                if (depth === 0) return cursor;
            }
        }
        return -1;
    }

    /**
     * Significant position of the '>' closing the generic list opened at the
     * argument, or -1 when the angle bracket is a comparison operator.
     */
    matchAngle(position: number): number {
        if (openingAngleDepth(this.plan.text(position)) === 0) return -1;
        let depth = 0;
        for (let cursor = position; cursor < this.plan.size; cursor++) {
            if (this.plan.isDead(cursor)) continue;
            const text = this.plan.text(cursor);
            if (this.plan.kind(cursor) === 'punct') {
                const opens = openingAngleDepth(text);
                if (opens > 0) {
                    depth += opens;
                    const closes = closingAngleDepth(text);
                    if (closes > 0) {
                        depth -= closes;
                        if (depth <= 0) return cursor;
                    }
                    continue;
                }
                const closes = closingAngleDepth(text);
                if (closes > 0) {
                    depth -= closes;
                    if (depth <= 0) return cursor;
                }
                if (text === ';') return -1;
                continue;
            }
            if (text === ';') return -1;
        }
        return -1;
    }

    /**
     * Nearest unmatched opener enclosing the argument, or -1. Results are
     * memoized because every annotation colon asks this question, and a fresh
     * scan per colon would make erasure quadratic on large programs.
     */
    enclosingOpener(position: number): number {
        this.ensureEnclosingTable();
        return this.enclosingTable[position] ?? -1;
    }

    /**
     * Fill the enclosing-opener table for every position in one forward pass.
     * Scanning backwards from each queried position instead made overall cost
     * quadratic: a multi-megabyte input spent minutes in this method alone.
     * The table is rebuilt only when the dead set changes.
     */
    private ensureEnclosingTable(): void {
        const revision = this.plan.revision;
        if (this.enclosingRevision === revision && this.enclosingTable.length === this.plan.size) return;
        const size = this.plan.size;
        const table = new Int32Array(size);
        // An Int32Array defaults to 0, which is a valid token position, so the
        // 'no enclosing opener' sentinel has to be written explicitly.
        table.fill(-1);
        const stack: number[] = [];
        for (let cursor = 0; cursor < size; cursor++) {
            if (this.plan.isDead(cursor)) continue;
            const text = this.plan.text(cursor);
            // The enclosing opener of an opener or a closer is the group it sits
            // in, i.e. the stack top before the bracket itself is applied.
            if (text === '(' || text === '[' || text === '{') {
                table[cursor] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
                stack.push(cursor);
                continue;
            }
            if (text === ')' || text === ']' || text === '}') {
                table[cursor] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
                stack.pop();
                continue;
            }
            // Brackets are unambiguous, so no statement boundary can hide an
            // enclosing opener: an object literal's `{` is still the answer for
            // a colon inside it, which is exactly what keeps `key: value` safe.
            table[cursor] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
        }
        this.enclosingTable = table;
        this.enclosingRevision = revision;
    }
    /** True when the nearest unmatched opener enclosing the argument is '('. */
    isInsideParentheses(position: number): boolean {
        const opener = this.enclosingOpener(position);
        return opener >= 0 && this.plan.text(opener) === '(';
    }

    /** True when the argument sits directly inside a class body. */
    isInsideClassBody(position: number): boolean {
        const opener = this.enclosingOpener(position);
        if (opener < 0 || this.plan.text(opener) !== '{') return false;
        let cursor = this.plan.previous(opener - 1);
        for (let steps = 0; steps < 64 && cursor >= 0; steps++) {
            const text = this.plan.text(cursor);
            if (text === 'class') {
                // `class` must introduce a CLASS, not be an object key or a
                // member name: `{ class: { a: 1 } }` has the word followed by
                // ':', and treating the inner object as a class body would
                // erase its first property initializer.
                const after = this.plan.next(cursor + 1);
                if (after >= this.plan.size) return false;
                const afterText = this.plan.text(after);
                const afterKind = this.plan.kind(after);
                return afterText === '{' || afterText === 'extends' || afterKind === 'ident';
            }
            if (text === ';' || text === '{' || text === '}' || text === '(' || text === ')') return false;
            cursor = this.plan.previous(cursor - 1);
        }
        return false;
    }

    /**
     * Last significant position of the type expression starting at the
     * argument, or one less than the argument when no type atom is present.
     */
    /**
     * Position of the last token of the expression starting at `start`, stopping
     * at `limit`. Used for enum initializers, which are expressions rather than
     * types: the type scanner stops after the first atom and would leave the
     * remainder of `1 << 2` in the output.
     */
    /**
     * True when a paren group is a function type's PARAMETER LIST rather than a
     * parenthesized type. Only a parameter list may continue past a following
     * arrow: in `(a: A): ((b: B) => C) => body` the return type is the whole
     * parenthesized group and the arrow starts the body, so treating it as a
     * parameter list swallowed the body.
     */
    /**
     * True when this closing paren closes a control-flow head (`if (…)`,
     * `while (…)`, `for (…)`, `switch (…)`, `catch (…)`, `with (…)`) rather
     * than a call or grouping. A `!` directly after such a head is prefix
     * logical negation, not a non-null assertion.
     */
    isControlHeadCloser(close: number): boolean {
        const opener = this.matchOpener(close);
        if (opener < 0) return false;
        const head = this.plan.previous(opener - 1);
        if (head < 0) return false;
        if (!this.plan.isIdentifier(head)) return false;
        return CONTROL_HEAD_KEYWORDS.has(this.plan.text(head));
    }

    /**
     * True when this closing brace ends a BLOCK (or a class/function body)
     * rather than an object literal. A block closer ends a statement, so a
     * following '!' is prefix negation; an object literal is a value.
     */
    isBlockCloser(close: number): boolean {
        const opener = this.matchOpener(close);
        if (opener < 0) return false;
        const head = this.plan.previous(opener - 1);
        if (head < 0) return true;
        const headText = this.plan.text(head);
        // A block opener follows a control head, an arrow, a function/class
        // header, or another block boundary. An object literal follows '=',
        // '(', ',', 'return', '=>', '[' or an operator.
        if (headText === ')' || headText === '=>' || headText === 'class' || headText === 'else'
            || headText === 'try' || headText === 'finally' || headText === 'do'
            || headText === '}' || headText === ';' || headText === '{') return true;
        if (CONTROL_HEAD_KEYWORDS.has(headText)) return true;
        // A labelled block (`l: { ... }`) is closed by a brace whose head is the
        // label's ':'.
        if (headText === ':') return true;
        // A class DECLARATION body is closed by a brace whose head is the class
        // name (`class C { ... }`), optionally preceded by `extends X`.
        if (this.plan.isIdentifier(head)) {
            let probe = this.plan.previous(head - 1);
            for (let steps = 0; steps < 8 && probe >= 0; steps++) {
                const probeText = this.plan.text(probe);
                if (probeText === 'class') return true;
                if (probeText === 'extends' || this.plan.isIdentifier(probe)) {
                    probe = this.plan.previous(probe - 1);
                    continue;
                }
                return false;
            }
        }
        return false;
    }
    looksLikeParameterList(open: number, close: number): boolean {
        let depth = 0;
        let first = -1;
        for (let cursor = this.plan.next(open + 1); cursor < close; cursor = this.plan.next(cursor + 1)) {
            const text = this.plan.text(cursor);
            if (text === '(' || text === '[' || text === '{') {
                if (first < 0) first = cursor;
                depth++;
                continue;
            }
            if (text === ')' || text === ']' || text === '}') { depth--; continue; }
            if (depth !== 0) continue;
            if (text === '=>') return false;
            if (first < 0) first = cursor;
        }
        if (first < 0) return true;
        const firstText = this.plan.text(first);
        if (firstText === '...' || firstText === '{' || firstText === '[') return true;
        // A nested group means a parenthesized type ((A) => B), not a binding.
        if (firstText === '(') return false;
        if (this.plan.kind(first) !== 'ident') return false;
        // A binding is a name followed by ':' or '?' (an annotation/optional
        // marker), or a bare name that is the whole parameter. A lone type name
        // such as (number) is a parenthesized type, so it is only a parameter
        // when something else in the group marks it as binding position.
        const second = this.plan.next(first + 1);
        if (second >= close) {
            // A single bare name: '(number) => R' is a type, '(x) => R' is a
            // parameter list. Type keywords are the discriminator.
            return !TYPE_KEYWORD_NAMES.has(firstText);
        }
        const secondText = this.plan.text(second);
        return secondText === ':' || secondText === '?' || secondText === ',';
    }
    scanExpressionEnd(start: number, limit: number): number {
        let cursor = this.plan.next(start);
        let last = start - 1;
        let depth = 0;
        let guard = 0;
        while (cursor < this.plan.size && cursor < limit && guard++ < 4096) {
            const text = this.plan.text(cursor);
            if (text === '(' || text === '[' || text === '{') {
                const close = this.matchCloser(cursor);
                if (close < 0 || close >= limit) return last;
                last = close;
                cursor = this.plan.next(close + 1);
                continue;
            }
            if (text === ')' || text === ']' || text === '}') {
                if (depth === 0) return last;
                depth--;
            }
            if (text === ',' && depth === 0) return last;
            last = cursor;
            cursor = this.plan.next(cursor + 1);
        }
        return last;
    }

    scanTypeEnd(start: number): number {
        let cursor = this.plan.next(start);
        if (cursor >= this.plan.size) return start - 1;
        let last = start - 1;
        let expectingAtom = true;
        let conditional = false;
        let parameterList = false;
        let guard = 0;
        while (cursor < this.plan.size && guard++ < 4096) {
            const text = this.plan.text(cursor);
            const kind = this.plan.kind(cursor);
            if (!expectingAtom) {
                if (text === '|' || text === '&') {
                    expectingAtom = true;
                    last = cursor;
                    cursor = this.plan.next(cursor + 1);
                    continue;
                }
                if (text === 'extends' && kind === 'ident') {
                    conditional = true;
                    expectingAtom = true;
                    last = cursor;
                    cursor = this.plan.next(cursor + 1);
                    continue;
                }
                // A type predicate narrows with `is`: `x is string`,
                // `asserts x is string`, `this is C`. The `is` keyword continues
                // the annotation and the narrowed type follows it.
                if (text === 'is' && kind === 'ident') {
                    expectingAtom = true;
                    last = cursor;
                    cursor = this.plan.next(cursor + 1);
                    continue;
                }
                // `(a: A) => R` is a function type and continues; `): R => expr`
                // is an arrow function whose return type was just erased, so
                // only a preceding parameter list may continue past `=>`.
                if (text === '=>' && kind === 'punct' && parameterList) {
                    expectingAtom = true;
                    last = cursor;
                    cursor = this.plan.next(cursor + 1);
                    continue;
                }
                if ((text === '?' || text === ':') && conditional) {
                    expectingAtom = true;
                    last = cursor;
                    cursor = this.plan.next(cursor + 1);
                    continue;
                }
                // ASI: once the type is complete, a token that starts a NEW line
                // and cannot continue a type begins a separate statement. Without
                // this, `type T = number` followed by a line starting with `[`
                // would be read as the indexed-access type `number[...]` and the
                // following statement would be erased with the alias.
                if (this.plan.line(cursor) > this.plan.line(last)
                    && (text === '[' || text === '(' || text === '{' || STATEMENT_KEYWORDS.has(text))) {
                    return last;
                }
                return last;
            }
            if (text === '(' || text === '[' || text === '{') {
                const close = this.matchCloser(cursor);
                if (close < 0) return last;
                // The parameter-list test needs the group's own bounds, so it
                // runs before the cursor moves past the closing paren.
                parameterList = text === '(' && this.looksLikeParameterList(cursor, close);
                last = close;
                cursor = this.plan.next(close + 1);
                // An ARRAY type may follow any group: `(A | B)[]`, `({ a: number })[]`,
                // `[A, B][]`, `{ a: number }[]`. Without this the group is erased
                // but the `[]` suffix survives, turning the declarator into an
                // array binding pattern. A `[]` directly after `)` is ALWAYS an
                // array type: a function type puts `=>` there first, so the
                // parameter-list flag must not suppress the suffix. The same-line
                // guard keeps a following statement that starts with `[` out.
                while (cursor < this.plan.size && this.plan.text(cursor) === '['
                    && this.plan.line(cursor) === this.plan.line(last)) {
                    const suffix = this.matchCloser(cursor);
                    if (suffix < 0) break;
                    last = suffix;
                    cursor = this.plan.next(suffix + 1);
                }
                expectingAtom = false;
                continue;
            }
            if (TYPE_PREFIX_KEYWORDS.has(text) && kind === 'ident') {
                last = cursor;
                cursor = this.plan.next(cursor + 1);
                continue;
            }
            if (kind === 'ident' || kind === 'string' || kind === 'number' || kind === 'template') {
                parameterList = false;
                last = cursor;
                cursor = this.plan.next(cursor + 1);
                while (cursor < this.plan.size && this.plan.text(cursor) === '.') {
                    const member = this.plan.next(cursor + 1);
                    if (member >= this.plan.size || !this.plan.isIdentifier(member)) break;
                    last = member;
                    cursor = this.plan.next(member + 1);
                }
                if (cursor < this.plan.size && this.plan.text(cursor) === '<') {
                    const close = this.matchAngle(cursor);
                    if (close < 0) return last;
                    last = close;
                    cursor = this.plan.next(close + 1);
                }
                while (cursor < this.plan.size && this.plan.text(cursor) === '[') {
                    // ASI: a '[' that starts a NEW line begins a separate
                    // statement, not an indexed-access type on this one.
                    if (this.plan.line(cursor) > this.plan.line(last)) break;
                    const close = this.matchCloser(cursor);
                    if (close < 0) break;
                    last = close;
                    cursor = this.plan.next(close + 1);
                }
                expectingAtom = false;
                continue;
            }
            return last;
        }
        return last;
    }

    /**
     * Contents guard for a candidate angle-bracket list: rejects expression-like
     * content so a comparison such as 'a < b' is never read as type arguments.
     */
    looksLikeTypeArguments(open: number, close: number): boolean {
        let depth = 0;
        let previous = -1;
        for (let cursor = this.plan.next(open + 1); cursor < close; cursor = this.plan.next(cursor + 1)) {
            const text = this.plan.text(cursor);
            const kind = this.plan.kind(cursor);
            // A parenthesised group is only legal inside a type-argument list as
            // a FUNCTION TYPE (`id<(n: number) => number>`). Any other group means
            // this is a comparison chain: TypeScript keeps
            // `(a < (b + c) > (d, e))` a comparison, and erasing it turned the
            // expression into a call.
            if (text === '(') {
                const group = this.matchCloser(cursor);
                const afterGroup = group >= 0 ? this.plan.next(group + 1) : -1;
                const isFunctionType = afterGroup >= 0 && afterGroup <= close
                    && this.plan.text(afterGroup) === '=>';
                if (!isFunctionType) return false;
                depth++; previous = cursor; continue;
            }
            if (text === '[' || text === '{' || text === '<') { depth++; previous = cursor; continue; }
            if (text === ')' || text === ']' || text === '}' || text === '>') {
                // A closer at depth 0 cannot appear inside a type-argument list:
                // the list would have to span a group boundary. In `(f < f) > (g())`
                // the matched `>` lies beyond the `)`, so this is a comparison.
                if (depth === 0) return false;
                depth--;
                previous = cursor;
                continue;
            }
            if (depth !== 0) { previous = cursor; continue; }
            if (kind === 'string' || kind === 'number' || kind === 'template' || kind === 'regex') return false;
            // A function type is a legal type argument (`id<(n: number) =>
            // number>`), so `=>` is accepted when it follows a closing paren of
            // a nested group. A bare `b => c` is not a type, and a comparison
            // chain never contains `=>`.
            if (text === '=>') {
                if (previous >= 0 && this.plan.text(previous) === ')') { previous = cursor; continue; }
                return false;
            }
            // `=` is admitted because a generic parameter list may declare a
            // default (`<T = string>`); a bare assignment cannot appear inside a
            // comparison chain, and `==`/`===` stay rejected below.
            if (text === ';' || text === '==' || text === '==='
                || text === '!=' || text === '!==' || text === '&&' || text === '||' || text === '??'
                || text === '?' || text === '+' || text === '-' || text === '*' || text === '/'
                || text === '%' || text === '!' || text === 'new' || text === 'instanceof'
                || text === 'return' || text === 'function') {
                return false;
            }
            previous = cursor;
        }
        return true;
    }
}

/** Erase one program, returning the JavaScript that the guest can evaluate. */
/**
 * Evaluate a compile-time constant enum initializer. Enum members may use
 * arithmetic and digit separators, and TypeScript folds them; emitting the raw
 * text would still run, but an unparsed value would also break the
 * auto-increment counter that resumes after an explicit member.
 *
 * Returns null when the text is not a constant number, in which case the raw
 * text is preserved (it may reference another enum member). Only the subset of
 * JavaScript that can appear in a legal enum initializer is evaluated, and the
 * evaluator never runs guest code.
 */
function evaluateConstant(raw: string): number | null {
    const text = raw.replace(/_/g, '').trim();
    if (!text) return null;
    if (/^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text)) {
        const value = Number(text);
        return Number.isFinite(value) ? value : null;
    }
    // Fold the small set of constant expressions TypeScript accepts here:
    // unary sign, + - * / % **, << >> >>>, & | ^, and parentheses.
    if (!/^[-+*/%&|^<>()\d\s.eExXa-fA-F]+$/.test(text)) return null;
    let value: number;
    try {
        // Restricted by the character guard above: digits, operators, and
        // parentheses only, so nothing can reference the surrounding scope.
        value = Number(new Function('return (' + text + ');')());
    } catch {
        return null;
    }
    return Number.isFinite(value) ? value : null;
}

export function eraseTypeScript(source: string): TypeErasureResult {
    if (!source) return { code: '', applied: [] };
    const plan = new ErasurePlan(source);
    if (plan.size === 0) return { code: source, applied: [] };
    const navigator = new TokenNavigator(plan);

    /**
     * True when the declaration at `position` begins a statement. A preceding
     * semicolon or block brace is conclusive; a declaration that is the first
     * token on its own line is also a statement start, which covers source that
     * omits semicolons.
     */
    const isStatementStart = (position: number): boolean => {
        const before = plan.previous(position - 1);
        if (before < 0) return true;
        const text = plan.text(before);
        if (text === ';' || text === '{' || text === '}' || text === ')' || text === 'export' || text === 'declare') return true;
        return plan.line(position) > plan.line(before);
    };

    /**
     * True when the identifier at `position` is an object-literal property name
     * (`{ declare: 1 }`) rather than a statement keyword. A property name is
     * followed by ':' or ',' and sits inside an object literal.
     */
    const isObjectKey = (position: number): boolean => {
        const next = plan.next(position + 1);
        if (next >= plan.size) return false;
        const nextText = plan.text(next);
        // `{ a: 1 }` (property), `{ a, b }` and `{ a }` (shorthand), and
        // `{ a() {} }` / `{ a*() {} }` / `{ async a() {} }` / `{ get a() {} }`
        // (method shorthand) all use the word as a KEY; only a declaration
        // position makes it a type. A method key is followed by '(' or '*', or
        // by a get/set/async modifier before the parameter list.
        const isMethodKey = nextText === '(' || nextText === '*'
            || nextText === 'get' || nextText === 'set' || nextText === 'async';
        if (nextText !== ':' && nextText !== ',' && nextText !== '}' && !isMethodKey) return false;
        const opener = navigator.enclosingOpener(position);
        return opener >= 0 && plan.text(opener) === '{';
    };

    /** Position terminating a statement that has no trailing semicolon. */
    const statementEnd = (position: number): number => {
        let depth = 0;
        let cursor = position;
        // The starting token is the declaration's own keyword; treating it as a
        // statement boundary would return a position BEFORE `position`, and the
        // caller's `position = terminator` would then fail to advance (an
        // infinite loop). Boundaries are only considered after the first token.
        let started = false;
        while (cursor < plan.size) {
            const text = plan.text(cursor);
            if (text === '(' || text === '[' || text === '{') { depth++; started = true; cursor = plan.next(cursor + 1); continue; }
            if (text === ')' || text === ']' || text === '}') {
                if (depth === 0) return Math.max(position, cursor - 1);
                depth--;
                cursor = plan.next(cursor + 1);
                continue;
            }
            if (depth === 0 && started) {
                if (text === ';') return cursor;
                // A new statement that begins on a later line ends this one. The
                // test is on the CURRENT token against the previous one: a
                // multi-line union type starts lines with '|', which is not a
                // statement keyword, so those are not mistaken for a new
                // statement.
                const previous = plan.previous(cursor - 1);
                if (previous >= position && STATEMENT_KEYWORDS.has(text)
                    && plan.line(cursor) > plan.line(previous)) {
                    return previous;
                }
            }
            started = true;
            cursor = plan.next(cursor + 1);
        }
        return plan.size - 1;
    };

    /** Kill 'interface Name ... { ... }' starting at the argument; -1 when malformed. */
    const eraseInterface = (position: number): number => {
        let cursor = position;
        while (cursor < plan.size && plan.text(cursor) !== '{' && plan.text(cursor) !== ';') {
            cursor = plan.next(cursor + 1);
        }
        if (cursor >= plan.size || plan.text(cursor) !== '{') return -1;
        const close = navigator.matchCloser(cursor);
        if (close < 0) return -1;
        plan.killRange(position, close, 'interface');
        return close;
    };

    /** Replace 'enum Name { ... }' with a frozen object literal. */
    /**
     * Lower `enum Name { ... }` to a frozen object literal.
     *
     * TypeScript numeric enums auto-increment: `enum E { A, B, C }` is
     * `{ A: 0, B: 1, C: 2 }` (not `{ A: "A", ... }`), and a member with an
     * explicit numeric value continues from there (`{ A, B = 5, C }` is
     * `{ A: 0, B: 5, C: 6 }`). String enums do not auto-increment. Getting this
     * wrong is silent: the program runs and returns the wrong value, which is
     * worse than a syntax error.
     *
     * TypeScript also emits a reverse mapping for numeric members
     * (`E[0] === "A"`). A frozen plain object cannot express that without
     * changing the shape of `E`, so reverse lookup is not reproduced here.
     */
    const eraseEnum = (position: number): number => {
        const name = plan.next(position + 1);
        if (name >= plan.size || !plan.isIdentifier(name)) return -1;
        const brace = plan.next(name + 1);
        if (brace >= plan.size || plan.text(brace) !== '{') return -1;
        const close = navigator.matchCloser(brace);
        if (close < 0) return -1;
        // Members are collected first, then emitted as sequential assignments. A
        // member initializer may reference an EARLIER member (`enum E { A = 1,
        // B = A + 1 }`) or an outer constant (`enum E { A = K }`); inside a
        // single object literal the former would read the enclosing scope, so
        // each reference to a known earlier member is rewritten to a property
        // access on the enum object itself.
        interface EnumMember {
            readonly key: string;
            readonly name: string | null;
            readonly value: string;
        }
        const members: EnumMember[] = [];
        /** Local name of the object being built; used for member references. */
        const enumObject = 'enum_' + plan.text(name);
        const known = new Set<string>();
        /**
         * JS expression for the previous member's value, used by auto-increment.
         * A computed member is unknown at erase time, so it is read from the
         * enum object at runtime — TypeScript continues from the member's value
         * too, and a literal counter would silently produce the wrong number.
         */
        let previousValue: string | null = null;
        let autoValue = 0;
        let stringMode = false;
        let cursor = plan.next(brace + 1);
        while (cursor < close) {
            const kind = plan.kind(cursor);
            if (kind === 'ident' || kind === 'string' || kind === 'number') {
                const key = jsonObjectKey(plan.text(cursor), kind);
                const name = kind === 'ident' ? plan.text(cursor) : null;
                const assign = plan.next(cursor + 1);
                let value: string;
                if (assign < close && plan.text(assign) === '=') {
                    // An enum initializer is an EXPRESSION, not a type: it may be
                    // negative (-1), use arithmetic (1 << 2), or contain digit
                    // separators. The type scanner stops after the first atom,
                    // which would leave the rest of the expression in the output.
                    const valueStart = plan.next(assign + 1);
                    const last = navigator.scanExpressionEnd(valueStart, close);
                    const raw = source.slice(plan.start(valueStart), plan.end(last)).trim();
                    const isString = raw.startsWith('"') || raw.startsWith("'");
                    const numeric = isString ? null : evaluateConstant(raw);
                    if (isString) {
                        stringMode = true;
                        previousValue = null;
                        value = raw;
                    } else if (numeric !== null) {
                        value = String(numeric);
                        autoValue = numeric + 1;
                        previousValue = value;
                    } else {
                        // A computed initializer: rewrite references to earlier
                        // members so they read from the enum object.
                        value = raw;
                        for (const earlier of known) {
                            if (earlier === name) continue;
                            value = value.replace(
                                new RegExp('\\b' + earlier + '\\b', 'g'),
                                enumObject + '[' + JSON.stringify(earlier) + ']',
                            );
                        }
                        previousValue = enumObject + '[' + JSON.stringify(key.replace(/^"(.*)"$/, '$1')) + ']';
                    }
                    cursor = plan.next(last + 1);
                } else if (stringMode) {
                    // TypeScript rejects an uninitialized member after a string
                    // member, so this input does not compile either way; naming
                    // the member keeps it addressable.
                    value = JSON.stringify(plan.text(cursor));
                    cursor = plan.next(cursor + 1);
                } else {
                    // No initializer: continue from the previous member. A pure
                    // number folds here; anything else stays a runtime expression.
                    if (previousValue === null) {
                        value = String(autoValue);
                    } else {
                        const folded = Number(previousValue);
                        value = Number.isFinite(folded) ? String(folded + 1) : previousValue + ' + 1';
                    }
                    autoValue = 0;
                    previousValue = value;
                    cursor = plan.next(cursor + 1);
                }
                members.push({ key, name, value });
                if (name !== null) known.add(name);
                continue;
            }
            cursor = plan.next(cursor + 1);
        }
        const enumName = plan.text(name);
        if (members.length === 0) {
            plan.replace(position, close, 'const ' + enumName + ' = Object.freeze({});', 'enum');
            return close;
        }
        // Bracket notation needs a string key; `jsonObjectKey` returns either a
        // bare identifier or an already-quoted string, so normalise both.
        const statements = members
            .map(member => enumObject + '[' + JSON.stringify(member.key.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')) + '] = ' + member.value + ';')
            .join(' ');
        const iife = 'const ' + enumName + ' = (() => { const ' + enumObject + ' = {}; '
            + statements + ' return Object.freeze(' + enumObject + '); })();';
        plan.replace(position, close, iife, 'enum');
        return close;
    };

    // ---- Declarations: import type / export type / interface / type alias / declare / enum ----
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        const text = plan.text(position);
        if (text !== 'import' && text !== 'export' && text !== 'interface'
            && text !== 'type' && text !== 'declare' && text !== 'enum' && text !== 'const') continue;
        // These words are also legal property and member names. A declaration is
        // only a declaration when the word starts a statement: `{ declare: 1 }`
        // and `class C { interface() {} }` must be left alone.
        if (isObjectKey(position) || navigator.isInsideClassBody(position)) continue;
        // `const enum E { ... }`: the `const` modifier is not JavaScript, so drop
        // it and lower what remains as an ordinary enum.
        if (text === 'const') {
            const enumKeyword = plan.next(position + 1);
            if (enumKeyword < plan.size && plan.text(enumKeyword) === 'enum') {
                plan.kill(position, 'const enum modifier');
            }
            continue;
        }
        const terminator = statementEnd(position);
        if (text === 'import' || text === 'export') {
            const after = plan.next(position + 1);
            const afterText = after < plan.size ? plan.text(after) : '';
            if (afterText === 'type') {
                plan.killRange(position, terminator, 'type-only import or export');
                position = terminator;
                continue;
            }
            if (afterText === 'interface') {
                const end = eraseInterface(after);
                if (end >= 0) {
                    plan.killRange(position, end, 'type-only declaration');
                    position = end;
                }
                continue;
            }
            if (afterText === 'declare') {
                plan.killRange(position, terminator, 'type-only declaration');
                position = terminator;
                continue;
            }
            continue;
        }
        if (text === 'interface') {
            // `{ interface() {} }` and `{ interface: 1 }` use the word as a member
            // name; erasing it leaves `{ }` / `{ , a: 1 }`.
            if (isObjectKey(position)) continue;
            const name = plan.next(position + 1);
            if (name >= plan.size || !plan.isIdentifier(name)) continue;
            if (!isStatementStart(position)) continue;
            const end = eraseInterface(position);
            if (end >= 0) position = end;
            continue;
        }
        if (text === 'type') {
            if (!isStatementStart(position)) continue;
            const name = plan.next(position + 1);
            let assign = plan.next(name + 1);
            // `type C<T> = ...` / `type C<T extends U> = ...`: step over the
            // type-parameter list before looking for the `=`.
            if (assign < plan.size && plan.text(assign) === '<') {
                const close = navigator.matchAngle(assign);
                if (close >= 0) assign = plan.next(close + 1);
            }
            if (name >= plan.size || !plan.isIdentifier(name)) continue;
            if (assign >= plan.size || plan.text(assign) !== '=') continue;
            // The alias ends where its TYPE ends. Using the statement terminator
            // instead could swallow the next statement when ASI joins them
            // (`type T = number` followed by a line starting with `[`), so the
            // type is measured directly and the alias is killed to that point.
            const typeEnd = navigator.scanTypeEnd(plan.next(assign + 1));
            if (typeEnd < assign) continue;
            plan.killRange(position, typeEnd, 'type alias');
            position = typeEnd;
            continue;
        }
        if (text === 'declare') {
            if (!isStatementStart(position)) continue;
            // `{ declare: 1 }` uses the word as an object key. A declare
            // statement is always followed by a declaration keyword or name.
            const declared = plan.next(position + 1);
            const declaredText = declared < plan.size ? plan.text(declared) : '';
            if (!DECLARE_KEYWORDS.has(declaredText) && !plan.isIdentifier(declared)) continue;
            // An ambient declaration produces NO runtime code, so the whole
            // statement must disappear. Killing only the `declare` keyword
            // leaves the declaration behind, which is exactly the shape the
            // guest prelude uses (`declare class ToolCallError ...`), so a
            // partial erase turns valid input into a syntax error.
            //
            // The end is the first `;` or the first `{...}` body at top level:
            // a `{` inside parentheses belongs to a parameter or return type
            // (`declare function f(a: { x: number }): void`), so all three
            // depth counters have to be zero before either counts.
            let declaredEnd = -1;
            let parens = 0;
            let brackets = 0;
            let braces = 0;
            let cursor = declared;
            while (cursor < plan.size) {
                const token = plan.text(cursor);
                // ASI: a token that starts a NEW line and cannot continue the
                // declaration ends it, so a bare `declare const g: number`
                // followed by a line starting with `[` does not swallow that
                // statement. This runs before the bracket accounting below,
                // which would otherwise treat the `[` as part of the type.
                if (parens === 0 && brackets === 0 && braces === 0 && cursor > declared
                    && plan.line(cursor) > plan.line(plan.previous(cursor - 1))
                    && (token === '[' || token === '(' || token === '{' || STATEMENT_KEYWORDS.has(token))) {
                    declaredEnd = plan.previous(cursor - 1);
                    break;
                }
                if (token === '(') { parens++; cursor = plan.next(cursor + 1); continue; }
                if (token === ')') { if (parens > 0) parens--; cursor = plan.next(cursor + 1); continue; }
                if (token === '[') { brackets++; cursor = plan.next(cursor + 1); continue; }
                if (token === ']') { if (brackets > 0) brackets--; cursor = plan.next(cursor + 1); continue; }
                if (token === '{') {
                    if (parens === 0 && brackets === 0 && braces === 0) {
                        const close = navigator.matchCloser(cursor);
                        if (close < 0) break;
                        declaredEnd = close;
                        const trailing = plan.next(close + 1);
                        if (trailing < plan.size && plan.text(trailing) === ';') declaredEnd = trailing;
                        break;
                    }
                    braces++;
                    cursor = plan.next(cursor + 1);
                    continue;
                }
                if (token === '}') { if (braces > 0) braces--; cursor = plan.next(cursor + 1); continue; }
                if (token === ';' && parens === 0 && brackets === 0 && braces === 0) { declaredEnd = cursor; break; }
                cursor = plan.next(cursor + 1);
            }
            if (declaredEnd < position) declaredEnd = declared;
            plan.killRange(position, declaredEnd, 'ambient declaration');
            position = declaredEnd;
            continue;
        }
        if (text === 'enum') {
            if (!isStatementStart(position)) continue;
            const end = eraseEnum(position);
            if (end >= 0) position = end;
            continue;
        }
    }
    /** Namespace names already lowered, for `namespace N` MERGE declarations. */
    const loweredNamespaces = new Set<string>();
    /** Exported bindings per merged namespace name, so later blocks can see them. */
    const mergedNamespaceExports = new Map<string, Set<string>>();

    // ---- `namespace` / `module` declarations ----
    // A namespace holding only types contributes nothing at runtime, but one with
    /**
     * Significant position of the body `{` of a function/class member declared at
     * `binding`, or -1. Used by the namespace lowering, which needs the body's end
     * to append the assignment that publishes the member.
     */
    const findMemberBody = (binding: number, limit: number): number => {
        let cursor = plan.next(binding + 1);
        // A type-parameter list may precede the parameter list.
        if (cursor < limit && plan.text(cursor) === '<') {
            const angle = navigator.matchAngle(cursor);
            if (angle < 0) return -1;
            cursor = plan.next(angle + 1);
        }
        if (cursor >= limit || plan.text(cursor) !== '(') return -1;
        const params = navigator.matchCloser(cursor);
        if (params < 0) return -1;
        cursor = plan.next(params + 1);
        // An optional return-type annotation, then the body.
        if (cursor < limit && plan.text(cursor) === ':') {
            const typeEnd = navigator.scanTypeEnd(plan.next(cursor + 1));
            if (typeEnd < cursor) return -1;
            cursor = plan.next(typeEnd + 1);
        }
        return cursor < limit && plan.text(cursor) === '{' ? cursor : -1;
    };
    /** Significant position of a class declaration's body `{`, or -1. */
    const findClassBody = (binding: number, limit: number): number => {
        let cursor = plan.next(binding + 1);
        for (let steps = 0; steps < 512 && cursor < limit; steps++) {
            const token = plan.text(cursor);
            if (token === '{') return cursor;
            if (token === ';') return -1;
            if (token === '<') {
                const angle = navigator.matchAngle(cursor);
                if (angle < 0) return -1;
                cursor = plan.next(angle + 1);
                continue;
            }
            if (token === '(') {
                const inner = navigator.matchCloser(cursor);
                if (inner < 0) return -1;
                cursor = plan.next(inner + 1);
                continue;
            }
            cursor = plan.next(cursor + 1);
        }
        return -1;
    };
    // exported values is real code: `namespace N { export const a = 1 }` followed
    // by `N.a` must keep working. Lower it to the shape TypeScript itself emits,
    // so exported bindings keep their values and their `N.x` access path.
    //
    // `declare module` is handled by the `declare` pass and never reaches here.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.kind(position) !== 'ident') continue;
        const text = plan.text(position);
        if (text !== 'namespace' && text !== 'module') continue;
        const before = plan.previous(position - 1);
        if (before >= 0 && plan.text(before) === 'declare') continue;
        if (!isStatementStart(position)) continue;
        // The declaration name may be an identifier (`namespace N`) or a string
        // literal (`module "pkg"`); the body brace follows it.
        const namePosition = plan.next(position + 1);
        let brace = namePosition;
        if (brace < plan.size && (plan.isIdentifier(brace) || plan.kind(brace) === 'string')) {
            brace = plan.next(brace + 1);
        }
        while (brace < plan.size && plan.text(brace) === '.') {
            const member = plan.next(brace + 1);
            if (member >= plan.size) break;
            brace = plan.next(member + 1);
        }
        if (brace >= plan.size || plan.text(brace) !== '{') continue;
        const close = navigator.matchCloser(brace);
        if (close < 0) continue;
        if (namePosition >= plan.size || !plan.isIdentifier(namePosition)) {
            // An ambient module name is a string literal: no runtime binding.
            plan.killRange(position, close, 'ambient module declaration');
            position = close;
            continue;
        }
        const name = plan.text(namePosition);
        // Rewrite the declaration head into an IIFE over a namespace object, then
        // expose each exported binding as a property of that object.
        // The replacement spans the declaration head AND the body brace, so the
        // original `{` does not survive as a stray block; the closing brace comes
        // from the tail replacement below.
        // TypeScript MERGES repeated `namespace N` declarations. A plain `const N`
        // for each one is a lexical redefinition, so a name already lowered here
        // reuses the existing object instead.
        const merged = loweredNamespaces.has(name);
        loweredNamespaces.add(name);
        // TypeScript's own shape: `(function (N) { ... })(N || (N = {}))`. The
        // first declaration creates the object; a MERGED one reuses it, which is
        // what makes `namespace N {...} namespace N {...}` legal rather than a
        // lexical redefinition.
        const head = (merged ? '' : 'var ' + name + '; ') + '(function (' + name + ') {';
        plan.replace(position, brace, head, 'namespace declaration');
        plan.replace(close, close, '})(' + name + ' || (' + name + ' = {}));', 'namespace declaration');
        // The body's exported bindings are written as properties of the parameter,
        // so no local `const name` is created and the merge stays legal.
        // Begin with `;`: the member before the tail may end with `}`, and
        // without a separator `}` + `return` is a syntax error under ASI.
        // (The tail is written by the replacement above.)
        // Which bindings are EXPORTED. Only those become properties, and a
        // reference to one inside the body must resolve through the namespace
        // object; a non-exported local stays a plain local, or it would read an
        // undefined property.
        // A MERGED namespace shares one runtime object, so a binding exported by
        // an EARLIER block of the same name is in scope here as `N.x`.
        const exported = mergedNamespaceExports.get(name) ?? new Set<string>();
        mergedNamespaceExports.set(name, exported);
        for (let scan = plan.next(brace + 1); scan < close; scan = plan.next(scan + 1)) {
            if (plan.text(scan) !== 'export') continue;
            const declared = plan.next(scan + 1);
            if (declared >= close) continue;
            const declaredText = plan.text(declared);
            if (declaredText !== 'const' && declaredText !== 'let' && declaredText !== 'var'
                && declaredText !== 'function' && declaredText !== 'class' && declaredText !== 'enum') continue;
            const binding = plan.next(declared + 1);
            if (binding < close && plan.isIdentifier(binding)) exported.add(plan.text(binding));
        }
        let cursor = plan.next(brace + 1);
        let sawExport = false;
        while (cursor < close) {
            if (plan.isDead(cursor)) { cursor = plan.next(cursor + 1); continue; }
            const token = plan.text(cursor);
            if (token === 'export') {
                plan.kill(cursor, 'namespace export keyword');
                sawExport = true;
                cursor = plan.next(cursor + 1);
                continue;
            }
            if (token === 'const' || token === 'let' || token === 'var') {
                const binding = plan.next(cursor + 1);
                if (sawExport && binding < close && plan.isIdentifier(binding)) {
                    plan.replace(cursor, binding, name + '.' + plan.text(binding), 'namespace export binding');
                }
                sawExport = false;
                cursor = plan.next(cursor + 1);
                continue;
            }
            if (token === 'function' || token === 'class') {
                const binding = plan.next(cursor + 1);
                if (sawExport && binding < close && plan.isIdentifier(binding)) {
                    // Keep the DECLARATION intact (`function f(): T { ... }`) so
                    // the later passes still see and erase its own annotations,
                    // and append the namespace assignment after the body. The
                    // generated text is then plain JavaScript with no annotation
                    // for those passes to miss.
                    const bodyOpen = token === 'class' ? findClassBody(binding, close) : findMemberBody(binding, close);
                    if (bodyOpen >= 0) {
                        const bodyClose = navigator.matchCloser(bodyOpen);
                        if (bodyClose > bodyOpen) {
                            plan.replace(bodyClose, bodyClose, '} ' + name + '.' + plan.text(binding) + ' = ' + plan.text(binding) + ';', 'namespace export binding');
                            // Continue the walk INSIDE the body so bare references
                            // to exported siblings are qualified too; skipping to the
                            // closing brace left them bare and undefined.
                            cursor = bodyOpen;
                            sawExport = false;
                            continue;
                        }
                    }
                }
                sawExport = false;
                cursor = plan.next(cursor + 1);
                continue;
            }
            if (token === 'enum') {
                const binding = plan.next(cursor + 1);
                if (sawExport && binding < close && plan.isIdentifier(binding)) {
                    // The enum pass lowers `enum E {...}` to a const that runs
                    // later, so publish it after its own body closes.
                    const enumName = plan.next(binding + 1);
                    const enumOpen = enumName < close && plan.text(enumName) === '{' ? enumName : findMemberBody(binding, close);
                    const enumClose = enumOpen >= 0 ? navigator.matchCloser(enumOpen) : -1;
                    if (enumClose > enumOpen) {
                        plan.replace(enumClose, enumClose, '} ' + name + '.' + plan.text(binding) + ' = ' + plan.text(binding) + ';', 'namespace export binding');
                        cursor = enumOpen;
                        sawExport = false;
                        continue;
                    }
                }
                sawExport = false;
                cursor = plan.next(cursor + 1);
                continue;
            }
            if (token === ';' || token === '{' || token === '}') { sawExport = false; cursor = plan.next(cursor + 1); continue; }
            // A bare reference to an exported sibling resolves through the
            // namespace object, matching TypeScript's namespace scoping.
            if (exported.has(token) && plan.isIdentifier(cursor)) {
                const previous = plan.previous(cursor - 1);
                const previousText = previous >= 0 ? plan.text(previous) : '<sof>';
                const nextToken = plan.next(cursor + 1);
                const nextText = nextToken < close ? plan.text(nextToken) : '';
                // Skip declaration and keyword positions: `function f`, `class C`,
                // `const a`, and a member access (already qualified).
                const declaration = previousText === 'function' || previousText === 'class'
                    || previousText === 'const' || previousText === 'let' || previousText === 'var'
                    || previousText === 'enum' || nextText === ':';
                if (previousText !== '.' && !declaration) {
                    plan.replace(cursor, cursor, name + '.' + token, 'namespace member reference');
                }
            }
            cursor = plan.next(cursor + 1);
        }
        position = close;
    }

    // ---- `abstract` classes and abstract member declarations ----
    // `abstract` is a TypeScript-only modifier. On a class it is dropped; on a
    // member declaration (`abstract run(): number;`) the whole declaration is
    // type-only and must disappear, or the class body holds a bare call.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== 'abstract' || !plan.isIdentifier(position)) continue;
        const after = plan.next(position + 1);
        if (after >= plan.size) continue;
        const afterText = plan.text(after);
        // `abstract` is a MODIFIER only in a declaration. The same word is a
        // legal member name (`o.abstract`, `{ abstract: 1 }`) and a class
        // field (`abstract = 5`), so require declaration position: preceded by
        // the start, `;`, `{`, `}`, or `export`.
        const before = plan.previous(position - 1);
        const beforeText = before >= 0 ? plan.text(before) : '<sof>';
        const declarationPosition = before < 0 || beforeText === ';' || beforeText === '{'
            || beforeText === '}' || beforeText === 'export' || beforeText === 'declare';
        if (!declarationPosition) continue;
        // `abstract() { ... }` is a method named "abstract", not a modifier:
        // a modifier is never followed directly by a parameter list or body.
        if (afterText === '(' || afterText === '{') continue;
        // `abstract = 5` is a field named "abstract", not a modifier.
        if (afterText === '=' || afterText === ':' || afterText === ';') continue;
        // `abstract class C {}` drops only the word, and `class` is checked first
        // because the word after the modifier is a declaration keyword, not a member
        // name.
        if (afterText === 'class') {
            plan.kill(position, 'abstract class modifier');
            continue;
        }
        // `abstract[0];` and `abstract.n = 1;` are EXPRESSIONS on a variable named
        // abstract. A member declaration after the modifier continues with a member
        // NAME (an identifier, a string/number key, a computed key, or `*`), and the
        // scan below would otherwise delete the whole statement - silently.
        if (!plan.isIdentifier(after) && plan.kind(after) !== 'string' && plan.kind(after) !== 'number'
            && afterText !== '*' && afterText !== '[') continue;
        // An abstract MEMBER only exists inside a class body, and its declaration
        // must end with `;` before the body's `}`; the scan below must never cross
        // a closing brace.
        if (!navigator.isInsideClassBody(position)) continue;
        // An abstract member has no body: erase through its terminating ';'.
        let cursor = plan.next(position + 1);
        let guard = 0;
        while (cursor < plan.size && guard++ < 256) {
            const token = plan.text(cursor);
            if (token === '{') { const close = navigator.matchCloser(cursor); if (close < 0) break; cursor = plan.next(close + 1); continue; }
            if (token === ';') { plan.killRange(position, cursor, 'abstract member declaration'); break; }
            if (token === '}' ) break;
            cursor = plan.next(cursor + 1);
        }
    }

    // ---- Uninitialized class fields are type-only ----
    // `class C { a: number; }` and `class C { a?: number; }` declare a shape and
    // emit NOTHING in TypeScript; only an initializer creates the property. Left
    // as a bare `a;` the field becomes a real own property, so
    // `Object.keys(new C())` would differ.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        if (!navigator.isInsideClassBody(position)) continue;
        // A PRIVATE field name is `#` followed by the name, two tokens.
        let nameStart = position;
        let privateMarker = -1;
        if (plan.text(position) === '#' && plan.isIdentifier(plan.next(position + 1))) {
            privateMarker = position;
            nameStart = plan.next(position + 1);
            position = nameStart;
        }
        if (!plan.isIdentifier(nameStart) && plan.kind(nameStart) !== 'string'
            && plan.kind(nameStart) !== 'number' && plan.text(nameStart) !== '[') continue;
        // A member must start a member line.
        const head = plan.previous(privateMarker >= 0 ? privateMarker - 1 : nameStart - 1);
        const headText = head >= 0 ? plan.text(head) : '<sof>';
        const memberStart = head < 0 || headText === '{' || headText === ';' || headText === '}'
            || headText === 'static' || headText === 'readonly' || headText === 'declare'
            || headText === 'public' || headText === 'private' || headText === 'protected';
        if (!memberStart) continue;
        // A MODIFIER head must itself start a member line. In
        // `class C { p = c ? s.readonly[0] : 1; }` the word `readonly` is followed
        // by `[`, so it looked like a member, but it follows a '?' inside a
        // ternary. Brace/terminator heads are unambiguous and need no check.
        const modifierHead = head >= 0 && (headText === 'static' || headText === 'readonly'
            || headText === 'declare' || headText === 'public' || headText === 'private'
            || headText === 'protected' || headText === 'abstract' || headText === 'override');
        if (modifierHead) {
            const headBefore = plan.previous(head - 1);
            const headBeforeText = headBefore >= 0 ? plan.text(headBefore) : '<sof>';
            // `class C { readonly a: T }` — the head sits after the class body's
            // '{' and possibly a class NAME, both of which are valid.
            if (!(headBeforeText === '{' || headBeforeText === ';' || headBeforeText === '}'
                || headBeforeText === '(' || headBeforeText === '<sof>')) {
                const nameOwner = plan.previous(headBefore - 1);
                const nameOwnerText = nameOwner >= 0 ? plan.text(nameOwner) : '<sof>';
                if (nameOwnerText !== 'class' && nameOwnerText !== 'extends') continue;
            }
        }
        let cursor = position;
        if (plan.text(cursor) === '[') {
            const bracket = navigator.matchCloser(cursor);
            if (bracket < 0) continue;
            // `[k: string]: number;` is an INDEX SIGNATURE, not a computed field
            // key; the dedicated pass removes it whole. Treating it as a field
            // here would erase only the annotation and leave `[k: string];`.
            let signature = false;
            for (let probe = plan.next(cursor + 1); probe < bracket; probe = plan.next(probe + 1)) {
                if (plan.text(probe) === ':') { signature = true; break; }
            }
            if (signature) continue;
            cursor = plan.next(bracket + 1);
        } else {
            cursor = plan.next(cursor + 1);
        }
        // An optional marker ('?') or a definite-assignment marker ('!')
        // precedes either an annotation or a method signature. Both are
        // type-only, and a field that carries one with no initializer emits
        // nothing in TypeScript.
        if (cursor < plan.size && (plan.text(cursor) === '?' || plan.text(cursor) === '!')) {
            cursor = plan.next(cursor + 1);
        }
        // A parameter list, initializer, or type-parameter list makes this real
        // code: only a bare annotation with no value is type-only.
        if (cursor < plan.size && plan.text(cursor) === ':') {
            const typeEnd = navigator.scanTypeEnd(plan.next(cursor + 1));
            if (typeEnd < cursor) continue;
            cursor = plan.next(typeEnd + 1);
        } else if (cursor < plan.size && plan.text(cursor) === '<') {
            const angle = navigator.matchAngle(cursor);
            if (angle < 0) continue;
            cursor = plan.next(angle + 1);
            if (cursor < plan.size && plan.text(cursor) === ':') {
                const typeEnd = navigator.scanTypeEnd(plan.next(cursor + 1));
                if (typeEnd < cursor) continue;
                cursor = plan.next(typeEnd + 1);
            } else {
                continue;
            }
        } else {
            continue;
        }
        // A private field is a BRAND: `this.#p` is invalid unless `#p` is
        // declared in the class, so the declaration must survive whether or not
        // it has an initializer. Strip only the marker and the annotation.
        if (privateMarker >= 0) {
            // The annotation ends at the initializer when there is one.
            const annotationEnd = cursor < plan.size && plan.text(cursor) === '='
                ? plan.previous(cursor - 1)
                : cursor;
            // Stop before the terminator so a field with no initializer keeps its
            // ';'. Everything between the name and the initializer (or the ';') is
            // the optional/definite marker and the annotation.
            const lastKilled = cursor < plan.size && plan.text(cursor) === '=' ? annotationEnd : plan.previous(cursor - 1);
            for (let probe = plan.next(nameStart + 1); probe <= lastKilled; probe = plan.next(probe + 1)) {
                plan.kill(probe, 'private field annotation');
            }
            continue;
        }
        // A field with an INITIALIZER is runtime code: only its annotation is
        // type-only. A field without one emits nothing in TypeScript.
        if (cursor < plan.size && plan.text(cursor) === '=') {
            // Kill from the annotation's ':' (or the optional/definite marker)
            // through the token before '='. For a computed key the ':' follows the
            // closing bracket, so the key itself must survive.
            const annotation = plan.previous(cursor - 1);
            let annotationStart = plan.next(nameStart + 1);
            if (plan.text(nameStart) === '[') {
                const bracket = navigator.matchCloser(nameStart);
                if (bracket < 0) continue;
                annotationStart = plan.next(bracket + 1);
            }
            for (let probe = annotationStart; probe <= annotation; probe = plan.next(probe + 1)) {
                plan.kill(probe, 'field annotation');
            }
            continue;
        }
        if (cursor >= plan.size || plan.text(cursor) !== ';') continue;
        plan.killRange(position, cursor, 'uninitialized class field');
        position = cursor;
    }
    // ---- Inline `type` modifiers in import/export specifier lists ----
    // `import { type Foo, bar } from "m"` is TypeScript-only syntax: the `type`
    // keyword marks Foo as a type-only binding and has no runtime meaning.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        const text = plan.text(position);
        if (text !== 'import' && text !== 'export') continue;
        const brace = plan.next(position + 1);
        if (brace >= plan.size || plan.text(brace) !== '{') continue;
        const close = navigator.matchCloser(brace);
        if (close < 0) continue;
        let cursor = plan.next(brace + 1);
        let depth = 0;
        for (; cursor < close; cursor = plan.next(cursor + 1)) {
            const token = plan.text(cursor);
            if (token === '{' || token === '[' || token === '(') { depth++; continue; }
            if (token === '}' || token === ']' || token === ')') { depth--; continue; }
            if (depth !== 0) continue;
            if (token !== 'type' || !plan.isIdentifier(cursor)) continue;
            const before = plan.previous(cursor - 1);
            const beforeText = before >= 0 ? plan.text(before) : '';
            if (beforeText !== '{' && beforeText !== ',') continue;
            const after = plan.next(cursor + 1);
            if (after >= close) continue;
            const afterText = plan.text(after);
            // `{ type }` names a binding called "type"; `{ type Foo }` is a
            // type-only specifier. TypeScript drops the whole specifier, so the
            // binding name goes with the keyword, along with one separator.
            if (afterText === ',' || afterText === '}') continue;
            let specifierEnd = after;
            if (plan.isIdentifier(after)) {
                const asKeyword = plan.next(after + 1);
                if (asKeyword < close && plan.text(asKeyword) === 'as') {
                    const alias = plan.next(asKeyword + 1);
                    if (alias < close && plan.isIdentifier(alias)) specifierEnd = alias;
                }
            }
            const following = plan.next(specifierEnd + 1);
            if (following < close && plan.text(following) === ',') {
                plan.killRange(cursor, following, 'inline type-only import specifier');
            } else {
                plan.killRange(cursor, specifierEnd, 'inline type-only import specifier');
                // Last specifier in the list: drop the comma before it instead.
                const trailing = plan.previous(cursor - 1);
                if (trailing >= 0 && plan.text(trailing) === ',') {
                    plan.kill(trailing, 'inline type-only import specifier');
                }
            }
            cursor = plan.next(specifierEnd + 1);
        }
    }

    // ---- Generic type parameter lists and type arguments ----
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== '<') continue;
        const close = navigator.matchAngle(position);
        if (close < 0) continue;
        if (!navigator.looksLikeTypeArguments(position, close)) continue;
        const after = plan.next(close + 1);
        const afterText = after < plan.size ? plan.text(after) : '<eof>';
        const before = plan.previous(position - 1);
        const beforeText = before >= 0 ? plan.text(before) : '<sof>';
        const beforeIsIdentifier = before >= 0 && plan.isIdentifier(before);
        const prior = before >= 0 ? plan.previous(before - 1) : -1;
        const priorText = prior >= 0 ? plan.text(prior) : '<sof>';
        const callLike = beforeIsIdentifier && (afterText === '(' || afterText === '.');
        const typeReference = beforeIsIdentifier && TYPE_CONTEXT_PREFIX.has(beforeText) && TYPE_END.has(afterText);
        const functionGeneric = beforeIsIdentifier
            && (priorText === 'function' || priorText === 'get' || priorText === 'set'
                || priorText === 'class' || priorText === 'interface')
            && (afterText === '(' || afterText === '{' || TYPE_END.has(afterText));
        // A class EXPRESSION (`const C = class<T> {}`) and a heritage clause
        // (`class Impl extends Base<number>`) both carry a declaration generic
        // list that must be erased. `extends` also appears inside a conditional
        // type, but the guard above already rejected expression-like content.
        const classExpression = beforeIsIdentifier && priorText === '=' && afterText === '{';
        const heritageGeneric = beforeIsIdentifier && priorText === 'extends' && afterText === '{';
        const arrowGeneric = beforeIsIdentifier && afterText === '=>';
        const bareArrowGeneric = !beforeIsIdentifier && afterText === '('
            && (before < 0 || TYPE_CONTEXT_PREFIX.has(beforeText));
        if (callLike || typeReference || functionGeneric || arrowGeneric || bareArrowGeneric
            || classExpression || heritageGeneric) {
            plan.killRange(position, close, 'generic type arguments');
        }
    }

    // ---- `implements` heritage clauses are erased entirely ----
    // A heritage clause is followed by one or more type names
    // (`implements A, B<T> {`). The same word is also a legal method name
    // (`implements() { }`) and object key (`{ implements: 3 }`), so the pass
    // fires only when a type name actually follows.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== 'implements' || !plan.isIdentifier(position)) continue;
        // A heritage clause can only follow a class NAME (`class C implements I`)
        // or an `extends` clause (`class C extends B implements I`). The word is a
        // legal sloppy-mode identifier everywhere else, and erasing it there
        // destroyed the program: `for (var implements in xs)` became
        // `for (var xs)`, which silently truncated the loop.
        const className = plan.previous(position - 1);
        const classNameHead = className >= 0 ? plan.previous(className - 1) : -1;
        const classNameHeadText = classNameHead >= 0 ? plan.text(classNameHead) : '<sof>';
        if (className < 0 || !plan.isIdentifier(className)
            || (classNameHeadText !== 'class' && classNameHeadText !== 'extends')) continue;
        // The type name may be a keyword-shaped TYPE (`implements readonly`,
        // `implements keyof`), which is not an identifier token. The heritage
        // position is unambiguous once the class name has been matched.
        // TYPE_ONLY_MODIFIERS is declared later in this scope, so its members are
        // listed here as words to avoid a temporal-dead-zone read.
        const HERITAGE_TYPE_WORDS = new Set([
            'readonly', 'abstract', 'declare', 'keyof', 'unique', 'asserts', 'infer',
            'private', 'public', 'protected', 'override', 'static', 'accessor', 'type',
        ]);
        const isTypeName = (at: number): boolean => at < plan.size && (plan.isIdentifier(at)
            || HERITAGE_TYPE_WORDS.has(plan.text(at)));
        const clause = plan.next(position + 1);
        if (!isTypeName(clause)) continue;
        let end = navigator.scanTypeEnd(clause);
        if (end < clause) continue;
        // `scanTypeEnd` reads a keyword-shaped name (`readonly`, `keyof`) as a
        // type PREFIX and consumes the class body that follows. When the scan
        // does not land on the class body but the bare name does, the name is
        // the whole heritage type.
        if (plan.text(plan.next(end + 1)) !== '{') {
            const bareNext = plan.next(clause + 1);
            const bareNextText = bareNext < plan.size ? plan.text(bareNext) : '';
            if (bareNextText === '{' || bareNextText === ',') end = clause;
        }
        // `implements A, B {` lists several types separated by commas.
        for (let guard = 0; guard < 64; guard++) {
            const comma = plan.next(end + 1);
            if (comma >= plan.size || plan.text(comma) !== ',') break;
            const nextType = plan.next(comma + 1);
            if (!isTypeName(nextType)) break;
            let nextEnd = navigator.scanTypeEnd(nextType);
            if (nextEnd < nextType) break;
            // Same prefix-name fallback as above for a keyword-shaped type name.
            if (plan.text(plan.next(nextEnd + 1)) !== '{') {
                const bareNext = plan.next(nextType + 1);
                const bareNextText = bareNext < plan.size ? plan.text(bareNext) : '';
                if (bareNextText === '{' || bareNextText === ',') nextEnd = nextType;
            }
            end = nextEnd;
        }
        // The clause must terminate at the class body, not at a property colon.
        const body = plan.next(end + 1);
        if (body >= plan.size || plan.text(body) !== '{') continue;
        plan.killRange(position, end, 'implements clause');
    }

    // ---- Statement labels ----
    // `loop: for (...) { }` is runtime JavaScript and the label is real syntax;
    // the annotation pass must not read `loop:` as a type annotation. The colon
    // is left alone here, and the annotation pass skips a colon whose name is a
    // label (it is followed by a statement keyword on the same line).
    // (No transformation is needed: this comment documents why none is done.)

    // ---- Type assertions and satisfies expressions ----
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        const text = plan.text(position);
        if ((text !== 'as' && text !== 'satisfies') || !plan.isIdentifier(position)) continue;
        const before = plan.previous(position - 1);
        const after = plan.next(position + 1);
        if (before < 0 || after >= plan.size) continue;
        const beforeText = plan.text(before);
        const afterText = plan.text(after);
        if (beforeText === '.' || beforeText === '{' || beforeText === ',' || beforeText === '=') continue;
        // 'function as() {}' / 'class as {}' use the word as a BINDING NAME, and
        // the name is runtime syntax: erasing it leaves 'function { ... }'.
        if (beforeText === 'function' || beforeText === 'class') continue;
        // `class D extends as {}` — the identifier after `extends` is the heritage
        // EXPRESSION (a base class), never an assertion. Erasing it produced
        // `class D extends` and a SyntaxError.
        if (beforeText === 'extends') continue;
        // A heritage clause may name the base through `new`/dotting; the first
        // token after `extends` is covered above, and `extends a.b` reaches here
        // only for a trailing word, which the expression-end test below rejects.
        // TypeScript's own scanner rule: a LINE BREAK before `as`/`satisfies`
        // terminates the expression statement, so the word is an ordinary
        // identifier there (a brace or literal followed by a newline and then
        // `as[0];`). TypeScript implements
        // exactly this check (`scanner.hasPrecedingLineBreak()`), and without it
        // any valid plain JavaScript of that shape was silently rewritten.
        if (navigator.hasPrecedingLineBreak(position)) continue;
        // `as`/`satisfies` is an ASSERTION only when the token before it can END
        // an expression. The same words are ordinary identifiers: `return as();`,
        // `const as = 1`, `for (const as of xs)`, `f(as)`, `x = as`. Without this
        // test the assertion pass erased the reference and left `return;`.
        const endsExpression = (plan.isIdentifier(before) && !NON_EXPRESSION_END_KEYWORDS.has(beforeText))
            || plan.isLiteral(before)
            || beforeText === ')' || beforeText === ']' || beforeText === '}';
        if (!endsExpression) continue;
        // The right-hand side must look like a TYPE: a name, a keyword type, a
        // literal type, a group, or `keyof`-style prefix. A call or a member
        // access means this was the identifier `as` in expression position.
        // `v as (number)` and `v as (string|number)[]` parenthesize the TYPE.
        // A ':'-less group after the operator is a cast, not a call: a CALL would
        // need a member/identifier before the '(' (the 'as' operator itself is
        // followed directly by the group). Reject only the shapes that cannot be
        // a type.
        if (afterText === ')' || afterText === ';' || afterText === ','
            || afterText === '=' || afterText === '.' || afterText === '=>') continue;
        // A group after the operator is a parenthesized type only when the group's
        // contents look like a type; `as(x)` would be the identifier `as` called.
        if (afterText === '(') {
            const group = navigator.matchCloser(after);
            if (group < 0) continue;
            const first = plan.next(after + 1);
            if (first >= group) continue;
            const firstText = plan.text(first);
            const typeStart = TYPE_KEYWORD_NAMES.has(firstText) || plan.isIdentifier(first)
                || firstText === '{' || firstText === '[' || firstText === 'typeof'
                || firstText === 'keyof' || firstText === 'readonly' || firstText === 'new';
            if (!typeStart) continue;
        }
        // 'import { x as y }' renames a binding; that is runtime syntax, not a type.
        let importExport = false;
        let depth = 0;
        for (let cursor = position - 1; cursor >= 0; cursor = plan.previous(cursor - 1)) {
            const token = plan.text(cursor);
            if (token === '}') { depth++; continue; }
            if (token === '{') {
                if (depth > 0) { depth--; continue; }
                const owner = plan.previous(cursor - 1);
                importExport = owner >= 0 && (plan.text(owner) === 'import' || plan.text(owner) === 'export');
                break;
            }
        }
        if (importExport) continue;
        const end = navigator.scanTypeEnd(after);
        if (end < after) continue;
        plan.killRange(position, end, text === 'as' ? 'type assertion' : 'satisfies expression');
    }

    // ---- Definite-assignment assertions in class fields ----
    // `class C { x!: number }` marks the field as assigned elsewhere; the `!`
    // is not JavaScript and disappears with its annotation.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== '!' || !navigator.isInsideClassBody(position)) continue;
        const before = plan.previous(position - 1);
        const after = plan.next(position + 1);
        if (before < 0 || after >= plan.size) continue;
        // A PRIVATE name (`#p!`) is also a field name; '#' and the name are
        // separate tokens, so accept an identifier that follows '#'.
        const marked = plan.previous(before - 1);
        const namedField = plan.isIdentifier(before)
            || (marked >= 0 && plan.text(marked) === '#' && plan.isIdentifier(before));
        if (!namedField || plan.text(after) !== ':') continue;
        plan.kill(position, 'definite assignment assertion');
    }

    // ---- Non-null assertions ----
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== '!') continue;
        const before = plan.previous(position - 1);
        const after = plan.next(position + 1);
        if (before < 0 || after >= plan.size) continue;
        const beforeText = plan.text(before);
        // The operator position decides: a `!` whose left neighbour can END an
        // expression is a non-null assertion and is removed wherever it appears
        // (`o.a! + 1`, `n! ?? 2`, `o.a! === 1`, `m.get("k")!`). A `!` in prefix
        // position follows an operator, an opening delimiter, or a keyword that
        // cannot end an expression, so logical negation is untouched.
        // A closing paren only ends an expression when it closes a call or a
        // grouping, not when it closes an `if (…)` / `while (…)` head, where a
        // following `!` is prefix negation (`if (x) !b;`).
        if (beforeText === ')' && navigator.isControlHeadCloser(before)) continue;
        // ASI: a '!' that starts a NEW line begins a new statement, so it is
        // prefix negation. This is idiomatic in minified JavaScript
        // (`var a = String("x")\n!0;`) and erasing it glues the statements.
        if (navigator.hasPrecedingLineBreak(position)) continue;
        // A '}' may close a BLOCK as well as an object literal. When it closes a
        // block the statement has ended, so the '!' starts a new expression and
        // is prefix negation (`if (d) { return } !!(a.d = b);`). A genuine non-null
        // assertion cannot follow a block-closing '}' either way.
        if (beforeText === '}' && navigator.isBlockCloser(before)) continue;
        const endsExpression = (plan.isIdentifier(before) && !NON_EXPRESSION_END_KEYWORDS.has(beforeText))
            || plan.isLiteral(before)
            || beforeText === ')' || beforeText === ']' || beforeText === '}';
        if (!endsExpression) continue;
        plan.kill(position, 'non-null assertion');
    }

    // ---- Index signatures ----
    //
    // `class A { [k: string]: number; }` declares only a type: the guest has no
    // index signature, and leaving it in is a hard syntax error.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== '[') continue;
        if (!navigator.isInsideClassBody(position)) continue;
        // The signature must START a member line. Without this test a `[` inside a
        // field initializer was read as an index signature: in
        // `class C { p = c ? [] : n.x; }` the consequent `[]` matched, and the
        // whole initializer was deleted.
        const memberHead = plan.previous(position - 1);
        const memberHeadText = memberHead >= 0 ? plan.text(memberHead) : '<sof>';
        const memberStart = memberHead < 0 || memberHeadText === '{' || memberHeadText === ';'
            || memberHeadText === '}' || memberHeadText === 'static' || memberHeadText === 'readonly'
            || memberHeadText === 'declare' || memberHeadText === 'public' || memberHeadText === 'private'
            || memberHeadText === 'protected' || memberHeadText === 'abstract' || memberHeadText === 'override'
            || memberHeadText === 'accessor';
        if (!memberStart) continue;
        const bracket = navigator.matchCloser(position);
        if (bracket < 0) continue;
        const colon = plan.next(bracket + 1);
        if (colon >= plan.size || plan.text(colon) !== ':') continue;
        // A computed KEY is followed by an annotation or an initializer too, so
        // require the bracket contents to look like `name: Type`: exactly one
        // top-level colon and an identifier before it.
        let innerColon = -1;
        for (let probe = plan.next(position + 1); probe < bracket; probe = plan.next(probe + 1)) {
            if (plan.text(probe) !== ':') continue;
            if (innerColon >= 0) { innerColon = -2; break; }
            innerColon = probe;
        }
        if (innerColon < 0) continue;
        const keyName = plan.next(position + 1);
        if (keyName >= innerColon || !plan.isIdentifier(keyName)) continue;
        const typeEnd = navigator.scanTypeEnd(plan.next(colon + 1));
        if (typeEnd < colon) continue;
        const terminator = plan.next(typeEnd + 1);
        if (terminator >= plan.size || plan.text(terminator) !== ';') continue;
        plan.killRange(position, terminator, 'index signature');
        position = terminator;
    }
    // ---- Type-only member and function declarations with no body ----
    // An overload signature (`function f(x: number): number;`) and a bodiless
    // member (`m?(): void;`, `[k: string]: number;`) are TypeScript-only: leaving
    // them in makes the guest reject the whole program. A declaration is
    // type-only when it ends at a `;` without ever reaching a `{` body.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        const text = plan.text(position);
        const isFunction = text === 'function' && plan.isIdentifier(position);
        const isMemberKey = plan.isIdentifier(position) || plan.kind(position) === 'string'
            || plan.kind(position) === 'number';
        if (!isFunction && !isMemberKey) continue;
        if (!isFunction && !navigator.isInsideClassBody(position)) continue;
        if (isFunction && !isStatementStart(position)) continue;
        if (!isFunction) {
            // A MEMBER must start a member line. Without this the pass fires on
            // the callee of an initializer: in `class F { x = loadConfig(); }`
            // the identifier `loadConfig` is inside the class body, is followed
            // by `(...)` and then `;`, so it looked like a bodiless member and
            // the initializer was destroyed.
            const head = plan.previous(position - 1);
            const headText = head >= 0 ? plan.text(head) : '<sof>';
            const memberStart = head < 0 || headText === '{' || headText === ';' || headText === '}'
                || headText === 'static' || headText === 'readonly' || headText === 'declare'
                || headText === 'public' || headText === 'private' || headText === 'protected'
                || headText === 'abstract' || headText === 'override' || headText === 'accessor'
                || headText === 'get' || headText === 'set' || headText === 'async' || headText === '*';
            if (!memberStart) continue;
        }
        let cursor = plan.next(position + 1);
        if (isFunction) {
            // Step over the function name, then any type-parameter list.
            if (cursor >= plan.size || !plan.isIdentifier(cursor)) continue;
            cursor = plan.next(cursor + 1);
            if (cursor < plan.size && plan.text(cursor) === '<') {
                const angle = navigator.matchAngle(cursor);
                if (angle < 0) continue;
                cursor = plan.next(angle + 1);
            }
        } else {
            // A member may carry `?` or a type-parameter list before its
            // parameter list.
            if (cursor < plan.size && plan.text(cursor) === '?') cursor = plan.next(cursor + 1);
            if (cursor < plan.size && plan.text(cursor) === '<') {
                const angle = navigator.matchAngle(cursor);
                if (angle < 0) continue;
                cursor = plan.next(angle + 1);
            }
        }
        if (cursor >= plan.size || plan.text(cursor) !== '(') continue;
        const parenClose = navigator.matchCloser(cursor);
        if (parenClose < 0) continue;
        let after = plan.next(parenClose + 1);
        // A return-type annotation still follows: this pass runs before the
        // annotation pass, so the type is intact and can be measured.
        if (after < plan.size && plan.text(after) === ':') {
            const typeEnd = navigator.scanTypeEnd(plan.next(after + 1));
            if (typeEnd >= after) after = plan.next(typeEnd + 1);
        }
        // A body makes this a real declaration; only a `;` proves it is type-only.
        if (after >= plan.size || plan.text(after) !== ';') continue;
        plan.killRange(position, after, 'declaration without a body');
        position = after;
    }

    // ---- Variable declaration annotations ----
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position)) continue;
        const text = plan.text(position);
        if (text !== 'const' && text !== 'let' && text !== 'var') continue;
        const before = plan.previous(position - 1);
        if (before >= 0) {
            const beforeText = plan.text(before);
            // Semicolon-less source puts the declaration first on its own line,
            // and a preceding declaration that was just erased leaves the
            // previous surviving token further back, so a line boundary counts
            // as a statement start here as well.
            const legitimate = beforeText === '(' || beforeText === ',' || beforeText === ';'
                || beforeText === '{' || beforeText === '}' || beforeText === 'export' || beforeText === 'for'
                || beforeText === '=>' || beforeText === 'do' || beforeText === 'else'
                || plan.line(position) > plan.line(before);
            if (!legitimate) continue;
        }
        let cursor = plan.next(position + 1);
        let guard = 0;
        while (cursor < plan.size && guard++ < 256) {
            if (plan.text(cursor) === '{' || plan.text(cursor) === '[') {
                // A destructuring pattern is only a binding target; an array
                // literal after `const x` is part of an initializer, not a name.
                const close = navigator.matchCloser(cursor);
                if (close < 0) break;
                // A binding pattern is a name only in binding position: directly
                // after the declarator keyword or a top-level comma
                // (`const [x]: T = ...`), whereas `const x = [ ... ]` starts an
                // initializer. Whitespace between the two is legal.
                const name = plan.previous(cursor - 1);
                const nameText = name >= 0 ? plan.text(name) : '';
                const bindingPosition = nameText === 'const' || nameText === 'let'
                    || nameText === 'var' || nameText === ',';
                const destructuring = bindingPosition && (plan.text(cursor) === '{' || plan.text(cursor) === '[');
                if (!destructuring && plan.text(cursor) === '[') break;
                cursor = plan.next(close + 1);
            } else if (plan.isIdentifier(cursor)) {
                // `of`/`in` end a `for` head binding; they are not part of the
                // declarator, and scanning past them walked out of the head and
                // into the next statement.
                if (plan.text(cursor) === 'of' || plan.text(cursor) === 'in') break;
                cursor = plan.next(cursor + 1);
            } else {
                break;
            }
            if (cursor < plan.size && plan.text(cursor) === '!') {
                const afterBang = plan.next(cursor + 1);
                if (afterBang < plan.size && plan.text(afterBang) === ':') {
                    plan.kill(cursor, 'definite assignment assertion');
                    cursor = afterBang;
                }
            }
            if (cursor < plan.size && plan.text(cursor) === ':') {
                const end = navigator.scanTypeEnd(plan.next(cursor + 1));
                if (end > cursor) plan.killRange(cursor, end, 'variable type annotation');
                cursor = plan.next(end + 1);
            }
            let closing = 0;
            while (cursor < plan.size) {
                const token = plan.text(cursor);
                if (token === '(' || token === '[' || token === '{') closing++;
                else if (token === ')' || token === ']' || token === '}') {
                    if (closing === 0) break;
                    closing--;
                } else if (closing === 0 && (token === ',' || token === ';')) break;
                cursor = plan.next(cursor + 1);
            }
            // Only a comma introduces another declarator; anything else ends the
            // declaration. Without this test a `)` (a `for` head) fell through and
            // the scan continued into the following statement.
            if (cursor >= plan.size || plan.text(cursor) !== ',') break;
            cursor = plan.next(cursor + 1);
        }
    }

    // ---- Annotation colons: parameters, return types, class members ----
    const memberStartKeyword = (text: string): boolean =>
        text === 'static' || text === 'async' || text === 'get' || text === 'set' || text === 'public' || text === 'declare';
    const stripAnnotations = (): void => {
        for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
            if (plan.isDead(position) || plan.text(position) !== ':') continue;
            const before = plan.previous(position - 1);
            if (before < 0) continue;
            const beforeText = plan.text(before);
            // Return type annotation:  ') : Type {'  or  ') : Type =>'
            if (beforeText === ')') {
                const end = navigator.scanTypeEnd(plan.next(position + 1));
                if (end < position) continue;
                const after = plan.next(end + 1);
                if (after >= plan.size) continue;
                const afterText = plan.text(after);
                if (afterText !== '{' && afterText !== '=>') continue;
                const opener = navigator.matchOpener(before);
                if (opener < 0) continue;
                if (plan.text(opener) !== '(') {
                    // A single bare arrow parameter has no parentheses: `x : T => ...`
                    if (afterText !== '=>' || !plan.isIdentifier(opener)) continue;
                    plan.killRange(position, end, 'return type annotation');
                    continue;
                }
                const head = plan.previous(opener - 1);
                const headText = head >= 0 ? plan.text(head) : '<sof>';
                // A ':' admits an arrow function stored as an object property or a
                // class field (`{ m: (x: T): R => ... }`); the parameter list still has to
                // be a real paren group, which matchOpener already verified, so no
                // comparison or ternary reaches this branch.
                // A CALL or member/construction site also ends in ')', and the
                // colon after it may belong to a ternary rather than a return
                // type: in `c ? a => A(a) : b => B(b)` the group is the call
                // `A(a)`, so erasing the colon would delete the ternary
                // separator. The discriminator is the token BEFORE the callee: an
                // arrow body (`=>`), `new`, a member (`.`), or a
                // chained call means this group is not a parameter list. A
                // function-introducing keyword or modifier keeps it one, because
                // `function f(x): T` and `async m(x): T` are declarations.
                const FUNCTION_HEADS = new Set([
                    'function', 'async', 'get', 'set', 'static', 'public', 'private',
                    'protected', 'readonly', 'abstract', 'override', 'declare',
                ]);
                const headOwner = head >= 0 ? plan.previous(head - 1) : -1;
                const headOwnerText = headOwner >= 0 ? plan.text(headOwner) : '<sof>';
                const callSite = plan.isIdentifier(head)
                    && (headOwnerText === '=>' || headOwnerText === 'new' || headOwnerText === '.'
                        || headOwnerText === ')' || headOwnerText === ']'
                        || (plan.isIdentifier(headOwner) && !FUNCTION_HEADS.has(headOwnerText)));
                if (callSite) continue;
                // `v ? (1) : class {}` / `v ? f(1) : class {}`: the ':' is the
                // ternary separator, and the alternative is a class expression.
                // A return type is a TYPE, so it never starts with `class`.
                const typeHead = plan.next(position + 1);
                const typeHeadText = typeHead < plan.size ? plan.text(typeHead) : '<eof>';
                if (typeHeadText === 'class' || typeHeadText === 'extends') continue;
                const parameterList = head < 0 || plan.isIdentifier(head) || headText === 'function'
                    || headText === ')' || headText === ']' || headText === '=' || headText === '('
                    || headText === ',' || headText === 'return' || headText === '=>' || headText === 'async'
                    || headText === ':' || headText === '{' || headText === ';'
                    || headText === '[' || headText === '?' || headText === '=>';
                if (!parameterList) continue;
                plan.killRange(position, end, 'return type annotation');
                continue;
            }
            // Parameter or class member annotation:  name : Type  /  name ? : Type
            let name = -1;
            let optionalMark = -1;
            let destructured = false;
            if (plan.isIdentifier(before)) {
                name = before;
            } else if (beforeText === '?') {
                const candidate = plan.previous(before - 1);
                if (candidate >= 0 && plan.isIdentifier(candidate)) {
                    name = candidate;
                    optionalMark = before;
                }
            } else if (beforeText === ']' && (navigator.isInsideClassBody(position)
                || navigator.isInsideParentheses(position))) {
                // A computed class member key (`class C { [k]: number = 1 }`) or
                // an array binding pattern (`function g([x, y]: T)`).
                const opener = navigator.matchOpener(before);
                if (opener < 0) continue;
                const keyHead = plan.previous(opener - 1);
                const keyHeadText = keyHead >= 0 ? plan.text(keyHead) : '<sof>';
                // A binding pattern is introduced by a parameter-list or
                // declarator position; a computed key starts a member line.
                const bindingHead = keyHead < 0 || keyHeadText === '(' || keyHeadText === ','
                    || keyHeadText === 'const' || keyHeadText === 'let' || keyHeadText === 'var';
                // A `}` head counts only when it closes a BLOCK (a method body),
                // not an object literal: in `c ? {}[k] : alt` the bracket indexes an
                // object literal and the `:` belongs to the ternary.
                // A MODIFIER head is only a member head when the modifier itself
                // starts a member line: in `1 ? readonly[2] : x` the word `readonly`
                // is an ordinary variable, not a modifier.
                const keyHeadOwner = keyHead >= 0 ? plan.previous(keyHead - 1) : -1;
                const keyHeadOwnerText = keyHeadOwner >= 0 ? plan.text(keyHeadOwner) : '<sof>';
                const MODIFIER_WORDS = ['static', 'readonly', 'public', 'private', 'protected'];
                const keyHeadIsModifier = MODIFIER_WORDS.includes(keyHeadText);
                const keyHeadOwnerIsDelimiter = keyHeadOwner < 0 || keyHeadOwnerText === '{'
                    || keyHeadOwnerText === ';' || keyHeadOwnerText === '}' || keyHeadOwnerText === '('
                    || keyHeadOwnerText === ',' || MODIFIER_WORDS.includes(keyHeadOwnerText);
                const memberStart = keyHead < 0 || keyHeadText === '{' || keyHeadText === ';'
                    || (keyHeadText === '}' && navigator.isBlockCloser(keyHead))
                    || (keyHeadIsModifier && keyHeadOwnerIsDelimiter);
                // `s.readonly[0]` is an INDEX expression on a property that merely
                // happens to be named like a modifier; a computed key and a binding
                // pattern are both preceded by a delimiter, never by '.'.
                const beforeKeyHead = plan.previous(keyHead - 1);
                if (beforeKeyHead >= 0 && plan.text(beforeKeyHead) === '.') continue;
                if (!bindingHead && !memberStart) continue;
                const end = navigator.scanTypeEnd(plan.next(position + 1));
                if (end < position) continue;
                plan.killRange(position, end, 'computed member or binding pattern annotation');
                continue;
            } else if (beforeText === '}') {
                // A destructuring BINDING pattern may carry an annotation:
                // `function f({ a, b }: T)`, `const [x, y]: T = ...`. A literal
                // that ends in `}`/`]` in expression position is not a binding,
                // which the caller's context checks below filter out.
                const opener = navigator.matchOpener(before);
                if (opener < 0) continue;
                const bindingHead = plan.previous(opener - 1);
                const bindingHeadText = bindingHead >= 0 ? plan.text(bindingHead) : '<sof>';
                const bindingPosition = bindingHead < 0 || bindingHeadText === '('
                    || bindingHeadText === ',' || bindingHeadText === 'const'
                    || bindingHeadText === 'let' || bindingHeadText === 'var'
                    || (plan.isIdentifier(bindingHead) && MEMBER_MODIFIERS.has(bindingHeadText));
                if (!bindingPosition) continue;
                name = before;
                destructured = true;
            }
            if (name < 0) continue;
            const head = plan.previous(name - 1);
            const headText = head >= 0 ? plan.text(head) : '<sof>';
            const inParentheses = navigator.isInsideParentheses(position);
            const inClassBody = navigator.isInsideClassBody(position);
            // A constructor parameter property carries its modifiers before the
            // name; the head is the last modifier, so look through every leading
            // modifier back to the parameter-list opener or comma.
            let leadingModifier = -1;
            for (let cursor = head; cursor >= 0; cursor = plan.previous(cursor - 1)) {
                if (!plan.isIdentifier(cursor) || !MEMBER_MODIFIERS.has(plan.text(cursor))) break;
                leadingModifier = cursor;
            }
            const modifierHead = leadingModifier >= 0 ? plan.previous(leadingModifier - 1) : -1;
            const modifierHeadText = modifierHead >= 0 ? plan.text(modifierHead) : '<sof>';
            // A TypeScript 'this' parameter is a compile-time receiver annotation
            // only and is erased whole, together with its separator.
            if (inParentheses && beforeText === 'this' && (head < 0 || headText === '(' || headText === ',')) {
                const typeStart = navigator.scanTypeEnd(plan.next(position + 1));
                if (typeStart >= position) {
                    const separator = plan.next(typeStart + 1);
                    const hasSeparator = separator < plan.size && plan.text(separator) === ',';
                    plan.killRange(before, hasSeparator ? separator : typeStart, 'this parameter');
                    if (!hasSeparator) {
                        // Last parameter: drop the comma that introduced it.
                        const leading = plan.previous(before - 1);
                        if (leading >= 0 && plan.text(leading) === ',') plan.kill(leading, 'this parameter');
                    }
                    continue;
                }
            }
            const modifierContext = inParentheses
                && leadingModifier >= 0
                && (modifierHeadText === '(' || modifierHeadText === ',');
            const parameterContext = head < 0 || headText === '('
                || (headText === ',' && inParentheses)
                || modifierContext
                || (head >= 0 && plan.text(head) === '...' && inParentheses);
            // A MODIFIER head only counts when it is itself the first token of a
            // member line: in `a.abstract\nM: c.d;` the word `abstract` is a property
            // access, so `M:` is a statement LABEL, not a member annotation.
            const headOwner = head >= 0 ? plan.previous(head - 1) : -1;
            const headOwnerText = headOwner >= 0 ? plan.text(headOwner) : '<sof>';
            const headIsModifier = MEMBER_MODIFIERS.has(headText)
                && (headOwner < 0 || headOwnerText === '{' || headOwnerText === ';'
                    || headOwnerText === '}' || headOwnerText === '(' || headOwnerText === ','
                    || MEMBER_MODIFIERS.has(headOwnerText));
            const memberContext = head >= 0 && plan.isIdentifier(head) && headIsModifier;
            if (destructured) {
                // The pattern already proved binding position; the annotation is
                // type-only wherever it appears.
                const end = navigator.scanTypeEnd(plan.next(position + 1));
                if (end < position) continue;
                plan.killRange(position, end, 'destructuring type annotation');
                continue;
            }
            if (!parameterContext && !inParentheses && !inClassBody && !memberContext) continue;
            if (!parameterContext && !inParentheses) {
                // A class member must start a member line.
                const memberStart = head < 0 || headText === '{' || headText === ';'
                    || headText === '}' || memberContext || memberStartKeyword(headText);
                if (!memberStart) continue;
            }
            // Reject the ternary operator:  cond ? a : b
            if (optionalMark < 0) {
                let ternary = false;
                let depth = 0;
                for (let cursor = position - 1; cursor >= 0; cursor = plan.previous(cursor - 1)) {
                    const token = plan.text(cursor);
                    if (token === ')' || token === ']' || token === '}') { depth++; continue; }
                    if (token === '(' || token === '[' || token === '{') {
                        if (depth === 0) break;
                        depth--;
                        continue;
                    }
                    if (depth !== 0) continue;
                    if (token === ';') break;
                    if (token === '?') {
                        const afterQuestion = plan.next(cursor + 1);
                        if (afterQuestion < plan.size && plan.text(afterQuestion) !== ':'
                            && plan.text(afterQuestion) !== '.') {
                            ternary = true;
                            break;
                        }
                    }
                }
                if (ternary) continue;
            }
            // A statement label (`L: /]/;`) is not a type annotation. The colon
            // follows a lone identifier that BEGINS the statement; an annotation
            // always follows a binding name, which is never at statement start.
            const labelTarget = plan.next(position + 1);
            const labelTargetText = labelTarget < plan.size ? plan.text(labelTarget) : '';
            void labelTargetText;
            // A class member (`{ v: T }`) and an object property are NOT labels:
            // their ':' is an annotation or a value separator.
            const atStatementStart = (head < 0 || headText === ';' || headText === '{'
                || headText === '}') && !navigator.isInsideClassBody(position);
            if (atStatementStart) {
                // `let x: T` / `const x: T` / `var x: T` are declarations.
                const isDeclaration = headText === 'let' || headText === 'const' || headText === 'var';
                if (!isDeclaration) continue;
            }
            const end = navigator.scanTypeEnd(plan.next(position + 1));
            if (end < position) continue;
            plan.killRange(position, end, 'type annotation');
            if (optionalMark >= 0) plan.kill(optionalMark, 'optional marker');
        }
    };
    stripAnnotations();
    stripAnnotations();

    // ---- Modifiers that exist only in TypeScript ----
    // `private`, `protected`, `readonly`, `abstract`, `override`, and `declare` are not
    // JavaScript syntax: in a class body or a parameter list they are removed
    // along with the annotation they modify. `static`, `async`, `get`, and `set`
    // are real JavaScript and stay.
    //
    // `accessor` is TypeScript-only as well: the ES2020 QuickJS guest has no
    // accessor or decorator support, so leaving it in place is a hard syntax
    // error. Erasing it yields a plain field, which preserves read/write
    // behavior.
    const TYPE_ONLY_MODIFIERS = new Set([
        'private', 'public', 'protected', 'readonly', 'abstract', 'override', 'declare', 'accessor',
    ]);
    /** Modifiers that turn a constructor parameter into a declared field. */
    const PARAMETER_PROPERTY_MODIFIERS = new Set(['private', 'public', 'protected', 'readonly']);
/**
 * Every modifier that may precede a parameter-property BINDING name. `override`
 * and `static` are not parameter properties themselves, but they appear in the
 * modifier RUN (`public override x: T`), and stopping the scan at them made the
 * modifier the parameter name - `this.override = override`.
 */
const PARAMETER_MODIFIER_RUN = new Set([
    'private', 'public', 'protected', 'readonly', 'override', 'static', 'declare', 'abstract', 'accessor',
]);
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.kind(position) !== 'ident') continue;
        if (!TYPE_ONLY_MODIFIERS.has(plan.text(position))) continue;
        const after = plan.next(position + 1);
        if (after >= plan.size) continue;
        const afterText = plan.text(after);
        const startsMember = plan.isIdentifier(after) || afterText === '...'
            || afterText === '[' || afterText === '{' || afterText === '*';
        if (!startsMember) continue;
        // A loop head is parenthesized too, so its binding would otherwise look
        // like a modifier: `for (const override of xs)` must keep its name.
        // A modifier never follows a declarator keyword, and the binding of a
        // `for...of` / `for...in` head is followed by `of` / `in`.
        const beforeModifier = plan.previous(position - 1);
        const beforeModifierText = beforeModifier >= 0 ? plan.text(beforeModifier) : '';
        if (beforeModifierText === 'const' || beforeModifierText === 'let' || beforeModifierText === 'var') continue;
        // A member access (`x.readonly[0]`) or a string/template key uses the word
        // as a property name, never as a modifier.
        if (beforeModifierText === '.') continue;
        if (afterText === 'of' || afterText === 'in') continue;
        const inClassBody = navigator.isInsideClassBody(position);
        if (!inClassBody && !navigator.isInsideParentheses(position)) continue;
        if (inClassBody) {
            // A member modifier starts a member line; inside a field initializer
            // (`e = readonly[0]`) the word is an ordinary identifier.
            const memberHead = plan.previous(position - 1);
            const memberHeadText = memberHead >= 0 ? plan.text(memberHead) : '<sof>';
            const memberLine = memberHead < 0 || memberHeadText === '{' || memberHeadText === ';'
                || memberHeadText === '}' || memberHeadText === '(' || memberHeadText === ','
                || TYPE_ONLY_MODIFIERS.has(memberHeadText) || memberHeadText === 'static'
                || memberHeadText === 'accessor';
            if (!memberLine) continue;
            // The word before a class NAME is not a member: `class readonly { }`.
            if (memberHeadText === 'class' || memberHeadText === 'extends') continue;
        } else {
            // A parameter property appears in a PARAMETER LIST: the modifier is the
            // first token after `(` or `,`, and a BINDING name follows. In
            // `(readonly instanceof Object)` the word is an ordinary operand of
            // `instanceof`, not a modifier.
            if (!plan.isIdentifier(after) && afterText !== '...') continue;
            if (beforeModifierText !== '(' && beforeModifierText !== ',') continue;
            // `for (const override of xs)` is already excluded above by the
            // declarator check; a call argument (`f(public)`) has an identifier
            // before the `(` and is therefore not a parameter property either.
            // `(readonly instanceof Object)` also starts the group with `(`, but the
            // word is an OPERAND. In a parameter property the token after the binding
            // name is a parameter-list delimiter.
            // A parameter property may carry a CHAIN of modifiers
            // (`private readonly name: T`), so walk past any further modifiers
            // before requiring the parameter-list delimiter.
            let binding = after;
            for (let guard = 0; guard < 8; guard++) {
                const nextToken = plan.next(binding + 1);
                if (nextToken >= plan.size || !TYPE_ONLY_MODIFIERS.has(plan.text(binding))) break;
                binding = nextToken;
            }
            if (afterText === '...') binding = after;
            const afterBinding = plan.next(binding + 1);
            const afterBindingText = afterBinding < plan.size ? plan.text(afterBinding) : '<eof>';
            const bindingDelimiter = afterBindingText === ':' || afterBindingText === ','
                || afterBindingText === ')' || afterBindingText === '?' || afterBindingText === '!'
                || afterBindingText === '=' || afterBindingText === ';';
            if (afterText !== '...' && !bindingDelimiter) continue;
        }
        plan.kill(position, 'type-only modifier');
    }

    // ---- Constructor parameter properties ----
    // `constructor(private x: number) {}` declares AND assigns a field in
    // TypeScript. Erasing just the modifiers turns it into a plain parameter, so
    // `this.x` silently becomes `undefined`. Reproduce the assignment by
    // prepending `this.x = x;` to the constructor body whenever the parameter
    // carried an accessibility modifier (or `readonly`).
    //
    // This pass runs last: the modifiers and annotations it inspects have already
    // been erased from the token stream, so it reads the original token text.
    for (let position = 0; position < plan.size; position = plan.next(position + 1)) {
        if (plan.isDead(position) || plan.text(position) !== 'constructor' || !plan.isIdentifier(position)) continue;
        const open = plan.next(position + 1);
        if (open >= plan.size || plan.text(open) !== '(') continue;
        const close = navigator.matchCloser(open);
        if (close < 0) continue;
        const body = plan.next(close + 1);
        if (body >= plan.size || plan.text(body) !== '{') continue;
        const bodyClose = navigator.matchCloser(body);
        if (bodyClose < 0) continue;
        // The modifiers were already erased from the live stream, so walk every
        // raw position and read the original text instead of the dead-token
        // skipping accessors.
        const properties: string[] = [];
        let depth = 0;
        for (let cursor = open + 1; cursor < close; cursor++) {
            const token = plan.originalText(cursor);
            if (token === '(' || token === '[' || token === '{' || token === '<') { depth++; continue; }
            if (token === ')' || token === ']' || token === '}' || token === '>') { depth--; continue; }
            if (depth !== 0) continue;
            if (!PARAMETER_PROPERTY_MODIFIERS.has(token)) continue;
            // The parameter name is the first identifier after the modifier run.
            let name = cursor + 1;
            while (name < close && PARAMETER_MODIFIER_RUN.has(plan.originalText(name))) name++;
            if (name >= close || !plan.isIdentifier(name)) continue;
            const parameterName = plan.originalText(name);
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameterName)) continue;
            if (!properties.includes(parameterName)) properties.push(parameterName);
        }
        if (properties.length === 0) continue;
        const assignments = properties.map(name => 'this.' + name + ' = ' + name + ';').join(' ');
        // In a derived class the assignments must follow the super call:
        // touching this before super() throws "this is not initialized".
        let anchor = body;
        let prefix = '{';
        const first = plan.next(body + 1);
        if (first < bodyClose && plan.text(first) === 'super') {
            const call = plan.next(first + 1);
            const callClose = call < bodyClose && plan.text(call) === '(' ? navigator.matchCloser(call) : -1;
            const terminator = callClose > 0 ? plan.next(callClose + 1) : -1;
            if (terminator > 0 && terminator < bodyClose && plan.text(terminator) === ';') {
                // The anchor token is replaced wholesale, so stand in for the
                // semicolon itself: `super()` stays intact and only the field
                // assignments are appended after it.
                anchor = terminator;
                prefix = ';';
            }
        }
        // The replacement writes generated text in place of the anchor token; the
        // original body then follows, so the assignments land before it.
        plan.replace(anchor, anchor, prefix + ' ' + assignments, 'constructor parameter property');
    }

    return { code: plan.render(source), applied: plan.applied };
}

/** Convenience wrapper: erase TypeScript syntax and return only the code. */
export function stripTypeScriptTypes(source: string): string {
    return eraseTypeScript(source).code;
}
