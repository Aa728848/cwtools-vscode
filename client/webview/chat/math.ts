import { escapeHtml } from './formatters';

const GREEK_LETTERS: Record<string, string> = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'π',
    rho: 'ρ', varrho: 'ρ', sigma: 'σ', varsigma: 'σ', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
    Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const MATH_SYMBOLS: Record<string, string> = {
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
    circ: '∘', bullet: '•', cap: '∩', cup: '∪', setminus: '∖', lor: '∨', land: '∧',
    sim: '∼', approx: '≈', cong: '≅', equiv: '≡', propto: '∝',
    neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    parallel: '∥', perp: '⊥',
    to: '→', rightarrow: '→', leftarrow: '←', uparrow: '↑', downarrow: '↓',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⇔', implies: '⟹',
    leftrightarrow: '↔', mapsto: '↦',
    infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄',
    emptyset: '∅', varnothing: '∅', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
    dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
    prime: '′',
};

const BIG_OPERATORS: Record<string, string> = {
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
};

const MATH_FUNCTIONS = new Set([
    'sin', 'cos', 'tan', 'sec', 'csc', 'cot',
    'arcsin', 'arccos', 'arctan', 'exp', 'ln', 'log', 'lg',
    'lim', 'min', 'max', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'Pr'
]);

const ACCENT_MAP: Record<string, string> = {
    vec: '→',
    hat: '^',
    bar: '¯',
    overline: '¯',
    underline: '_',
    dot: '˙',
    ddot: '¨',
    tilde: '~',
};

interface ParseOptions {
    displayMode?: boolean;
}

export class TeXParser {
    private pos = 0;
    private depth = 0;
    private readonly src: string;
    private readonly displayMode: boolean;

    constructor(src: string, options: ParseOptions = {}) {
        if (src.length > 16_000) throw new Error('Formula exceeds rendering limit.');
        this.src = src.trim();
        this.displayMode = options.displayMode ?? false;
    }

    private peek(): string {
        return this.pos < this.src.length ? this.src[this.pos]! : '';
    }

    private next(): string {
        return this.pos < this.src.length ? this.src[this.pos++]! : '';
    }

    private skipWhitespace(): void {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) {
            this.pos++;
        }
    }

    public parse(): string {
        return this.parseGroupContent();
    }

    public parseGroupContent(stopChars = ''): string {
        const nodes: string[] = [];
        while (this.pos < this.src.length) {
            this.skipWhitespace();
            const ch = this.peek();
            if (!ch || (stopChars && stopChars.includes(ch))) {
                break;
            }

            const item = this.parseAtomWithScripts();
            if (item) {
                nodes.push(item);
            }
        }
        return nodes.join('');
    }

    private parseAtomWithScripts(): string {
        const atomRes = this.parseAtom();
        let base = atomRes.html;
        const isBigOp = atomRes.isBigOp;
        const isLimitOp = atomRes.isLimitOp;

        if (!base) return '';

        while (this.pos < this.src.length) {
            this.skipWhitespace();
            const ch = this.peek();
            if (ch === '_' || ch === '^') {
                this.next(); // consume _ or ^
                const isSub = ch === '_';
                const scriptArg = this.parseArgument();

                this.skipWhitespace();
                const nextCh = this.peek();
                if ((isSub && nextCh === '^') || (!isSub && nextCh === '_')) {
                    this.next(); // consume second script
                    const secondArg = this.parseArgument();
                    const subArg = isSub ? scriptArg : secondArg;
                    const supArg = isSub ? secondArg : scriptArg;

                    if (isBigOp && this.displayMode) {
                        base = `<munderover>${base}<mrow>${subArg}</mrow><mrow>${supArg}</mrow></munderover>`;
                    } else {
                        base = `<msubsup><mrow>${base}</mrow><mrow>${subArg}</mrow><mrow>${supArg}</mrow></msubsup>`;
                    }
                } else {
                    if (isSub) {
                        if ((isBigOp && this.displayMode) || isLimitOp) {
                            base = `<munder>${base}<mrow>${scriptArg}</mrow></munder>`;
                        } else {
                            base = `<msub><mrow>${base}</mrow><mrow>${scriptArg}</mrow></msub>`;
                        }
                    } else {
                        if (isBigOp && this.displayMode) {
                            base = `<mover>${base}<mrow>${scriptArg}</mrow></mover>`;
                        } else {
                            base = `<msup><mrow>${base}</mrow><mrow>${scriptArg}</mrow></msup>`;
                        }
                    }
                }
            } else {
                break;
            }
        }
        return base;
    }

    public parseArgument(): string {
        this.skipWhitespace();
        const ch = this.peek();
        if (ch === '{') {
            this.next(); // consume '{'
            const content = this.parseGroupContent('}');
            if (this.peek() === '}') this.next();
            return content;
        }
        // Single atom argument
        const res = this.parseAtom();
        return res.html;
    }

    private parseAtom(): { html: string; isBigOp?: boolean; isLimitOp?: boolean } {
        if (++this.depth > 64) throw new Error('Formula nesting exceeds rendering limit.');
        try { return this.parseAtomContent(); } finally { this.depth--; }
    }

    private parseAtomContent(): { html: string; isBigOp?: boolean; isLimitOp?: boolean } {
        this.skipWhitespace();
        if (this.pos >= this.src.length) return { html: '' };

        const ch = this.peek();

        if (ch === '{') {
            this.next();
            const content = this.parseGroupContent('}');
            if (this.peek() === '}') this.next();
            return { html: `<mrow>${content}</mrow>` };
        }

        if (ch === '\\') {
            return this.parseCommand();
        }

        if (ch === '&') {
            this.next();
            return { html: '<mo>&amp;</mo>' };
        }

        // Ellipsis ...
        if (this.src.startsWith('...', this.pos)) {
            this.pos += 3;
            return { html: '<mo>…</mo>' };
        }

        // Numbers
        if (/\d/.test(ch)) {
            let num = '';
            while (this.pos < this.src.length && /[\d.]/.test(this.peek())) {
                num += this.next();
            }
            return { html: `<mn>${escapeHtml(num)}</mn>` };
        }

        // Latin letters
        if (/[a-zA-Z]/.test(ch)) {
            return { html: `<mi>${escapeHtml(this.next())}</mi>` };
        }

        if (ch === '~') {
            this.next();
            return { html: '<mo>∼</mo>' };
        }

        // Standard operator / symbol
        this.next();
        return { html: `<mo>${escapeHtml(ch)}</mo>` };
    }

    private parseCommand(): { html: string; isBigOp?: boolean; isLimitOp?: boolean } {
        this.next(); // consume '\\'
        let cmd = '';
        if (this.pos < this.src.length && /[^a-zA-Z]/.test(this.peek())) {
            cmd = this.next(); // single non-letter command like \\, \{, \}, \,, \;, \!
        } else {
            while (this.pos < this.src.length && /[a-zA-Z]/.test(this.peek())) {
                cmd += this.next();
            }
        }

        // Text & formatting commands
        if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mathbf' || cmd === 'mathit' || cmd === 'mathsf' || cmd === 'mathtt' || cmd === 'operatorname') {
            const textContent = this.parseRawBracedContent();
            let variant = '';
            if (cmd === 'mathbf') variant = ' mathvariant="bold"';
            else if (cmd === 'mathit') variant = ' mathvariant="italic"';
            else if (cmd === 'mathsf') variant = ' mathvariant="sans-serif"';
            else if (cmd === 'mathtt') variant = ' mathvariant="monospace"';
            return { html: `<mtext${variant}>${escapeHtml(textContent)}</mtext>` };
        }

        if (cmd === 'mathbb') {
            const textContent = this.parseRawBracedContent();
            return { html: `<mtext mathvariant="double-struck">${escapeHtml(textContent)}</mtext>` };
        }

        if (cmd === 'mathcal') {
            const textContent = this.parseRawBracedContent();
            return { html: `<mtext mathvariant="script">${escapeHtml(textContent)}</mtext>` };
        }

        // Fractions
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
            const num = this.parseArgument();
            const den = this.parseArgument();
            return { html: `<mfrac><mrow>${num}</mrow><mrow>${den}</mrow></mfrac>` };
        }

        // Binomial coefficient
        if (cmd === 'binom') {
            const top = this.parseArgument();
            const bottom = this.parseArgument();
            return { html: `<mo stretchy="true">(</mo><mfrac linethickness="0"><mrow>${top}</mrow><mrow>${bottom}</mrow></mfrac><mo stretchy="true">)</mo>` };
        }

        // Radicals
        if (cmd === 'sqrt') {
            let degree = '';
            this.skipWhitespace();
            if (this.peek() === '[') {
                this.next();
                degree = this.parseGroupContent(']');
                if (this.peek() === ']') this.next();
            }
            const rad = this.parseArgument();
            if (degree) {
                return { html: `<mroot><mrow>${rad}</mrow><mrow>${degree}</mrow></mroot>` };
            }
            return { html: `<msqrt><mrow>${rad}</mrow></msqrt>` };
        }

        // Accents
        if (Object.prototype.hasOwnProperty.call(ACCENT_MAP, cmd)) {
            const accent = ACCENT_MAP[cmd]!;
            const arg = this.parseArgument();
            if (cmd === 'underline') {
                return { html: `<munder><mrow>${arg}</mrow><mo stretchy="true">${accent}</mo></munder>` };
            }
            return { html: `<mover><mrow>${arg}</mrow><mo stretchy="true">${accent}</mo></mover>` };
        }

        // Delimiters
        if (cmd === 'left') {
            this.skipWhitespace();
            const delim = this.parseDelimiter();
            const inner = this.parseDelimitedContent();
            const leftHtml = delim === '.' ? '' : `<mo stretchy="true">${escapeHtml(delim)}</mo>`;
            return { html: `${leftHtml}<mrow>${inner}</mrow>` };
        }

        if (cmd === 'right') {
            return { html: '' };
        }

        // Environments
        if (cmd === 'begin') {
            return { html: this.parseEnvironment() };
        }

        // Spacing & line breaks
        if (cmd === 'quad') return { html: '<mspace width="1em"/>' };
        if (cmd === 'qquad') return { html: '<mspace width="2em"/>' };
        if (cmd === ',' || cmd === ':') return { html: '<mspace width="0.166em"/>' };
        if (cmd === ';') return { html: '<mspace width="0.277em"/>' };
        if (cmd === '!') return { html: '<mspace width="-0.166em"/>' };
        if (cmd === '\\') return { html: '<mspace linebreak="newline"/>' };

        // Escaped characters
        if (cmd === '{') return { html: '<mo>{</mo>' };
        if (cmd === '}') return { html: '<mo>}</mo>' };
        if (cmd === '%') return { html: '<mo>%</mo>' };
        if (cmd === '_') return { html: '<mo>_</mo>' };
        if (cmd === '$') return { html: '<mo>$</mo>' };
        if (cmd === '&') return { html: '<mo>&amp;</mo>' };
        if (cmd === '#') return { html: '<mo>#</mo>' };

        // Formatting controls that can be safely ignored
        if (cmd === 'displaystyle' || cmd === 'textstyle' || cmd === 'limits' || cmd === 'nolimits') {
            return { html: '' };
        }

        if (Object.prototype.hasOwnProperty.call(GREEK_LETTERS, cmd)) {
            return { html: `<mi>${GREEK_LETTERS[cmd]}</mi>` };
        }

        if (Object.prototype.hasOwnProperty.call(BIG_OPERATORS, cmd)) {
            const isIntegral = cmd.includes('int');
            return { html: `<mo>${BIG_OPERATORS[cmd]}</mo>`, isBigOp: !isIntegral };
        }

        if (Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, cmd)) {
            return { html: `<mo>${MATH_SYMBOLS[cmd]}</mo>` };
        }

        if (MATH_FUNCTIONS.has(cmd)) {
            const isLimitOp = cmd === 'lim' || cmd === 'min' || cmd === 'max' || cmd === 'sup' || cmd === 'inf';
            return { html: `<mi>${escapeHtml(cmd)}</mi>`, isLimitOp };
        }

        // Fallback for unhandled command
        return { html: `<mtext>\\${escapeHtml(cmd)}</mtext>` };
    }

    private parseRawBracedContent(): string {
        this.skipWhitespace();
        if (this.peek() !== '{') {
            return this.next();
        }
        this.next(); // consume '{'
        let depth = 1;
        let content = '';
        while (this.pos < this.src.length && depth > 0) {
            const ch = this.next();
            if (ch === '\\' && this.pos < this.src.length) {
                const nextCh = this.next();
                if (nextCh === '{' || nextCh === '}') {
                    content += nextCh;
                    continue;
                }
                content += '\\' + nextCh;
                continue;
            }
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            if (depth > 0) content += ch;
        }
        return content;
    }

    private parseDelimiter(): string {
        if (this.pos >= this.src.length) return '';
        const ch = this.peek();
        if (ch === '\\') {
            this.next();
            const cmd = this.next();
            if (cmd === '{' || cmd === '}') return cmd;
            if (cmd === '|') return '∥';
            return cmd;
        }
        return this.next();
    }

    private parseDelimitedContent(): string {
        const nodes: string[] = [];
        while (this.pos < this.src.length) {
            this.skipWhitespace();
            if (this.src.startsWith('\\right', this.pos)) {
                this.pos += 6; // consume '\\right'
                this.skipWhitespace();
                const rightDelim = this.parseDelimiter();
                const innerHtml = nodes.join('');
                if (rightDelim && rightDelim !== '.') {
                    return innerHtml + `<mo stretchy="true">${escapeHtml(rightDelim)}</mo>`;
                }
                return innerHtml;
            }
            const item = this.parseAtomWithScripts();
            if (item) nodes.push(item);
        }
        return nodes.join('');
    }

    private parseEnvironment(): string {
        const envName = this.parseRawBracedContent();
        const endTag = `\\end{${envName}}`;
        let envContent = '';
        const endPos = this.src.indexOf(endTag, this.pos);
        if (endPos !== -1) {
            envContent = this.src.slice(this.pos, endPos);
            this.pos = endPos + endTag.length;
        } else {
            envContent = this.src.slice(this.pos);
            this.pos = this.src.length;
        }

        const rows = envContent.split('\\\\').map(row => {
            const cells = row.split('&').map(cell => new TeXParser(cell, { displayMode: this.displayMode }).parse());
            return `<mtr>${cells.map(c => `<mtd>${c}</mtd>`).join('')}</mtr>`;
        }).join('');

        const table = `<mtable>${rows}</mtable>`;
        if (envName === 'pmatrix') {
            return `<mo stretchy="true">(</mo><mrow>${table}</mrow><mo stretchy="true">)</mo>`;
        }
        if (envName === 'bmatrix') {
            return `<mo stretchy="true">[</mo><mrow>${table}</mrow><mo stretchy="true">]</mo>`;
        }
        if (envName === 'Bmatrix') {
            return `<mo stretchy="true">{</mo><mrow>${table}</mrow><mo stretchy="true">}</mo>`;
        }
        if (envName === 'vmatrix') {
            return `<mo stretchy="true">|</mo><mrow>${table}</mrow><mo stretchy="true">|</mo>`;
        }
        if (envName === 'Vmatrix') {
            return `<mo stretchy="true">∥</mo><mrow>${table}</mrow><mo stretchy="true">∥</mo>`;
        }
        if (envName === 'cases') {
            return `<mo stretchy="true">{</mo><mrow>${table}</mrow>`;
        }
        return table;
    }
}

/**
 * Convert a TeX formula string to safe MathML.
 */
export function texToMathML(rawTex: string, options: ParseOptions = {}): string {
    const parser = new TeXParser(rawTex, options);
    return parser.parse();
}

/**
 * Render a display math block ($$ ... $$) into a safe HTML container.
 */
export function renderDisplayMath(rawTex: string): string {
    const trimmed = rawTex.trim();
    if (!trimmed) return '';

    try {
        const mathml = texToMathML(trimmed, { displayMode: true });
        return `<div class="md-math-block" data-raw="${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}"><math display="block" xmlns="http://www.w3.org/1998/Math/MathML">${mathml}</math></div>`;
    } catch {
        return `<div class="md-math-block md-math-fallback" data-raw="${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}"><code>${escapeHtml(trimmed)}</code></div>`;
    }
}

/**
 * Render an inline math formula ($ ... $) into a safe HTML container.
 */
export function renderInlineMath(rawTex: string): string {
    const trimmed = rawTex.trim();
    if (!trimmed) return '';

    try {
        const mathml = texToMathML(trimmed, { displayMode: false });
        return `<span class="md-math-inline" data-raw="${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}"><math xmlns="http://www.w3.org/1998/Math/MathML">${mathml}</math></span>`;
    } catch {
        return `<span class="md-math-inline md-math-fallback" data-raw="${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}"><code>${escapeHtml(trimmed)}</code></span>`;
    }
}
