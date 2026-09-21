import { expect } from 'chai';
import { renderMarkdown, renderInlineMarkdown } from '../../webview/chat/markdown';
import { renderDisplayMath, renderInlineMath, texToMathML } from '../../webview/chat/math';

describe('Chat Markdown Math Rendering', () => {
    it('preserves display delimiters inside code spans and incomplete formulas', () => {
        expect(renderMarkdown('Use `$$x$$` literally')).to.include('<code>$$x$$</code>');
        expect(renderMarkdown('$$x$')).to.not.include('<math');
        expect(renderMarkdown('```ts\n$$x$$')).to.not.include('<math');
    });

    it('bounds recursive and oversized formulas and escapes entity input', () => {
        expect(renderDisplayMath('{'.repeat(1000) + 'x' + '}'.repeat(1000))).to.include('md-math-fallback');
        expect(renderDisplayMath('x'.repeat(16001))).to.include('md-math-fallback');
        expect(texToMathML('&lt;script&gt;')).to.include('&amp;');
        expect(texToMathML('\\constructor')).to.not.include('function Object');
    });

    describe('User report formula regression', () => {
        it('renders display math with Chinese text and math symbols', () => {
            const raw = '$$\\text{单次脉冲写入量}=200 \\times 27 \\sim 38 ...$$';
            const html = renderMarkdown(raw);

            expect(html).to.include('class="md-math-block"');
            expect(html).to.include('display="block"');
            expect(html).to.include('<mtext>单次脉冲写入量</mtext>');
            expect(html).to.include('<mo>=</mo>');
            expect(html).to.include('<mn>200</mn>');
            expect(html).to.include('<mo>×</mo>');
            expect(html).to.include('<mn>27</mn>');
            expect(html).to.include('<mo>∼</mo>');
            expect(html).to.include('<mn>38</mn>');
            expect(html).to.include('<mo>…</mo>');
        });

        it('handles multiline display math blocks', () => {
            const raw = '$$\n\\text{单次脉冲写入量}=200 \\times 27 \\sim 38\n$$';
            const html = renderMarkdown(raw);

            expect(html).to.include('class="md-math-block"');
            expect(html).to.include('<mtext>单次脉冲写入量</mtext>');
        });
    });

    describe('Code blocks with math language', () => {
        it('renders ```math code blocks as display math', () => {
            const raw = '```math\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n```';
            const html = renderMarkdown(raw);

            expect(html).to.include('class="md-math-block"');
            expect(html).to.include('<mfrac>');
            expect(html).to.include('<msqrt>');
            expect(html).to.include('<mo>±</mo>');
        });

        it('renders ```latex code blocks as display math', () => {
            const raw = '```latex\nE = mc^2\n```';
            const html = renderMarkdown(raw);

            expect(html).to.include('class="md-math-block"');
            expect(html).to.include('<msup>');
        });
    });

    describe('Inline math formulas', () => {
        it('renders inline math in normal text', () => {
            const text = '这是爱因斯坦质能方程 $E = mc^2$ 的结果。';
            const html = renderMarkdown(text);

            expect(html).to.include('class="md-math-inline"');
            expect(html).to.include('<math xmlns="http://www.w3.org/1998/Math/MathML">');
            expect(html).to.include('<mi>E</mi>');
            expect(html).to.include('<mo>=</mo>');
            expect(html).to.include('<mi>m</mi>');
            expect(html).to.include('<msup><mrow><mi>c</mi></mrow><mrow><mn>2</mn></mrow></msup>');
        });

        it('distinguishes currency dollar signs from math', () => {
            const text = 'Cost is $50 and $100 today, while $E = mc^2$ is physics.';
            const html = renderMarkdown(text);

            expect(html).to.include('$50 and $100');
            expect(html).to.include('class="md-math-inline"');
            expect(html).to.not.include('data-raw="50 and"');
        });

        it('handles escaped dollar signs \\$', () => {
            const text = 'Price is \\$50 and \\$100.';
            const html = renderMarkdown(text);

            expect(html).to.include('Price is $50 and $100.');
            expect(html).to.not.include('md-math-inline');
        });

        it('protects inline code containing dollar signs', () => {
            const text = 'In PHP, `$foo = $bar` is code, but $x + y$ is math.';
            const html = renderMarkdown(text);

            expect(html).to.include('<code>$foo = $bar</code>');
            expect(html).to.include('class="md-math-inline"');
        });
    });

    describe('TeX mathematical constructs', () => {
        it('parses fractions, roots, and scripts', () => {
            const tex = '\\frac{a + b}{\\sqrt{c}} = x_1^2';
            const mathml = texToMathML(tex);

            expect(mathml).to.include('<mfrac>');
            expect(mathml).to.include('<msqrt>');
            expect(mathml).to.include('<msubsup>');
        });

        it('parses Greek letters and operators', () => {
            const tex = '\\alpha + \\beta \\le \\gamma \\quad \\text{where } \\gamma \\approx \\infty';
            const mathml = texToMathML(tex);

            expect(mathml).to.include('<mi>α</mi>');
            expect(mathml).to.include('<mi>β</mi>');
            expect(mathml).to.include('<mo>≤</mo>');
            expect(mathml).to.include('<mi>γ</mi>');
            expect(mathml).to.include('<mspace width="1em"/>');
            expect(mathml).to.include('<mo>≈</mo>');
            expect(mathml).to.include('<mo>∞</mo>');
        });

        it('parses big operators and limits', () => {
            const tex = '\\sum_{i=1}^n i = \\lim_{x \\to 0} f(x)';
            const mathml = texToMathML(tex, { displayMode: true });

            expect(mathml).to.include('<munderover>');
            expect(mathml).to.include('<mo>∑</mo>');
            expect(mathml).to.include('<munder>');
            expect(mathml).to.include('<mi>lim</mi>');
        });

        it('parses matrices and environments', () => {
            const tex = '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}';
            const mathml = texToMathML(tex);

            expect(mathml).to.include('<mtable>');
            expect(mathml).to.include('<mtr>');
            expect(mathml).to.include('<mtd><mi>a</mi></mtd>');
            expect(mathml).to.include('<mo stretchy="true">(</mo>');
        });

        it('parses cases environment', () => {
            const tex = 'f(x) = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}';
            const mathml = texToMathML(tex);

            expect(mathml).to.include('<mtable>');
            expect(mathml).to.include('<mo stretchy="true">{</mo>');
            expect(mathml).to.include('<mo>≥</mo>');
            expect(mathml).to.include('<mo>&lt;</mo>');
        });

        it('parses accents (vec, hat, bar, etc.)', () => {
            const tex = '\\vec{F} = m \\hat{a}';
            const mathml = texToMathML(tex);

            expect(mathml).to.include('<mover><mrow><mi>F</mi></mrow><mo stretchy="true">→</mo></mover>');
            expect(mathml).to.include('<mover><mrow><mi>a</mi></mrow><mo stretchy="true">^</mo></mover>');
        });
    });

    describe('Security and XSS mitigation', () => {
        it('safely escapes HTML tags in \\text', () => {
            const raw = '$$\\text{<script>alert("xss")</script>}$$';
            const html = renderMarkdown(raw);

            expect(html).to.not.include('<script>');
            expect(html).to.include('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        });

        it('safely escapes HTML in raw attributes', () => {
            const raw = '$$\\text{" onmouseover="alert(1)}$$';
            const html = renderMarkdown(raw);

            expect(html).to.not.include('" onmouseover="alert(1)"');
            expect(html).to.include('&quot; onmouseover=&quot;alert(1)');
        });

        it('safely escapes less-than and greater-than in math operators', () => {
            const raw = '$a < b \\text{ and } c > d$';
            const html = renderMarkdown(raw);

            expect(html).to.include('<mo>&lt;</mo>');
            expect(html).to.include('<mo>&gt;</mo>');
        });
    });

    describe('Markdown integration context', () => {
        it('renders math in list items', () => {
            const raw = '- 基础公式：$a^2 + b^2 = c^2$\n- 次要公式：$E = mc^2$';
            const html = renderMarkdown(raw);

            expect(html).to.include('<ul>');
            expect(html).to.include('<li>基础公式：<span class="md-math-inline"');
        });

        it('renders math in markdown tables', () => {
            const raw = '| 符号 | 意义 |\n| :--- | :--- |\n| $E$ | 能量 |\n| $m$ | 质量 |';
            const html = renderMarkdown(raw);

            expect(html).to.include('<table');
            expect(html).to.include('<span class="md-math-inline"');
        });

        it('renders math in blockquotes', () => {
            const raw = '> 经典物理：\n> $$F = ma$$';
            const html = renderMarkdown(raw);

            expect(html).to.include('<blockquote>');
            expect(html).to.include('class="md-math-block"');
        });
    });

    describe('Fault tolerance and fallback', () => {
        it('does not throw on unclosed delimiters or malformed input', () => {
            expect(() => renderMarkdown('$$\\frac{unclosed')).to.not.throw();
            expect(() => renderMarkdown('$unclosed inline')).to.not.throw();
        });

        it('renders empty string for empty math input', () => {
            expect(renderDisplayMath('')).to.equal('');
            expect(renderInlineMath('')).to.equal('');
        });
    });
});
