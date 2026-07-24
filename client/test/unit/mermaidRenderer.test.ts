import { expect } from 'chai';
import { sanitizeMermaidSource } from '../../webview/chat/mermaidRenderer';

describe('sanitizeMermaidSource', () => {
    it('strips Markdown backticks that break the Mermaid lexer', () => {
        const source = 'flowchart TD\n    A["`Infinite_megastructure_starbase` ship_size 定义"] --> B["`starbase_level`\nexe_starbase_levels.txt"]';
        const sanitized = sanitizeMermaidSource(source);

        expect(sanitized).to.not.include('`');
        expect(sanitized).to.include('A["Infinite_megastructure_starbase ship_size 定义"]');
    });

    it('leaves valid Mermaid source untouched', () => {
        const source = 'flowchart TD\n    A["plain label"] --> B{choice}';
        expect(sanitizeMermaidSource(source)).to.equal(source);
    });
});
