/**
 * Shared PDXScript tokenizer — used by guiParser and solarSystemParser.
 */
export enum TokenType {
    LBrace, RBrace, Equals, String, Identifier, Number, Comment, Comma, EOF,
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;
    startOffset: number;
    endOffset: number;
}

export interface TokenizeOptions {
    /** Handle # line comments (default true) */
    comments?: boolean;
    /** Handle trailing % on numbers like "100%" (default true) */
    percent?: boolean;
    /** Emit comma tokens instead of skipping them (default false). */
    comma?: boolean;
}

export function tokenize(input: string, opts: TokenizeOptions = {}): Token[] {
    const handleComments = opts.comments !== false;
    const handlePercent = opts.percent !== false;
    const handleComma = opts.comma === true;
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;

    while (i < input.length) {
         
        const ch = input[i]!;

        if (ch === '\n') { line++; i++; continue; }
        if (ch === '\r') { line++; i++; if (i < input.length && input[i] === '\n') i++; continue; }
        if (ch === ' ' || ch === '\t') { i++; continue; }

        if (handleComments && ch === '#') {
            while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
            continue;
        }
        if (ch === '{') { tokens.push({ type: TokenType.LBrace, value: '{', line, startOffset: i, endOffset: i + 1 }); i++; continue; }
        if (ch === '}') { tokens.push({ type: TokenType.RBrace, value: '}', line, startOffset: i, endOffset: i + 1 }); i++; continue; }
        if (ch === '=') { tokens.push({ type: TokenType.Equals, value: '=', line, startOffset: i, endOffset: i + 1 }); i++; continue; }
        if (handleComma && ch === ',') { tokens.push({ type: TokenType.Comma, value: ',', line, startOffset: i, endOffset: i + 1 }); i++; continue; }

        if (ch === '"') {
            const tokenLine = line;
            const tokenStart = i;
            i++;
            const start = i;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\n') line++;
                i++;
            }
            const tokenEnd = i < input.length ? i + 1 : i;
            tokens.push({ type: TokenType.String, value: input.slice(start, i), line: tokenLine, startOffset: tokenStart, endOffset: tokenEnd });
            if (i < input.length) i++;
            continue;
        }

        // Numbers
         
        if ((ch >= '0' && ch <= '9') || ((ch === '-' || ch === '+') && i + 1 < input.length && input[i + 1]! >= '0' && input[i + 1]! <= '9')) {
            const start = i;
            if (ch === '-' || ch === '+') i++;
             
            while (i < input.length && ((input[i]! >= '0' && input[i]! <= '9') || input[i]! === '.')) i++;
            if (handlePercent && i < input.length && input[i] === '%') i++;
            tokens.push({ type: TokenType.Number, value: input.slice(start, i), line, startOffset: start, endOffset: i });
            continue;
        }

        // Arithmetic expressions @[ ... ]
        if (ch === '@' && i + 1 < input.length && input[i + 1] === '[') {
            const start = i;
            const tokenLine = line;
            i += 2;
            let depth = 1;
            while (i < input.length && depth > 0) {
                if (input[i] === '[') depth++;
                else if (input[i] === ']') depth--;
                if (input[i] === '\n') line++;
                i++;
            }
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line: tokenLine, startOffset: start, endOffset: i });
            continue;
        }

        // Identifiers
        if (isIdentStart(ch)) {
            const start = i;
             
            while (i < input.length && isIdentCont(input[i]!)) i++;
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line, startOffset: start, endOffset: i });
            continue;
        }

        i++; // skip unknown
    }
    tokens.push({ type: TokenType.EOF, value: '', line, startOffset: input.length, endOffset: input.length });
    return tokens;
}

export function isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '@';
}

export function isIdentCont(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_' || ch === '.' || ch === '@' ||
        ch === ':' || ch === '/' || ch === '\\' ||
        ch === '-' || ch === '!' || ch === '%';
}
