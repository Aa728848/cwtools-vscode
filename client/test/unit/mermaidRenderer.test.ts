import { expect } from 'chai';
import { calculateMermaidPreviewWidth, sanitizeMermaidSource } from '../../webview/chat/mermaidRenderer';

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

describe('calculateMermaidPreviewWidth', () => {
    it('limits a tall 4K path diagram without changing its aspect ratio', () => {
        expect(calculateMermaidPreviewWidth(1200, 2400)).to.equal(400);
    });

    it('keeps ordinary diagrams at their natural width', () => {
        expect(calculateMermaidPreviewWidth(640, 480)).to.equal(640);
    });

    it('fits the preview to a shorter viewport', () => {
        expect(calculateMermaidPreviewWidth(1200, 2400, 560)).to.equal(280);
    });

    it('rejects invalid Mermaid view boxes', () => {
        expect(calculateMermaidPreviewWidth(1200, 0)).to.equal(undefined);
        expect(calculateMermaidPreviewWidth(Number.NaN, 480)).to.equal(undefined);
        expect(calculateMermaidPreviewWidth(1200, 480, 0)).to.equal(undefined);
    });
});
