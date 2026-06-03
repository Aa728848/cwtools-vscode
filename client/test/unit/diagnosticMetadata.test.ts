import { expect } from 'chai';

describe('diagnostic metadata classification', () => {
    it('classifies common PDX diagnostic families', () => {
        const { classifyDiagnosticFallback } = loadDiagnosticMetadataModule();

        expect(classifyDiagnosticFallback("Expected value of type sprite", '').category)
            .to.equal('unknown_sprite');
        expect(classifyDiagnosticFallback("Expected value of type sound", '').category)
            .to.equal('unknown_sound');
        expect(classifyDiagnosticFallback("Invalid scope: country expected", '').category)
            .to.equal('scope_mismatch');
        expect(classifyDiagnosticFallback("Duplicate definition already defined", '').category)
            .to.equal('duplicate_definition');
        expect(classifyDiagnosticFallback("Expected value of type enum", '').category)
            .to.equal('invalid_value_type');
        expect(classifyDiagnosticFallback("Could not find referenced technology", '').category)
            .to.equal('missing_definition');
        expect(classifyDiagnosticFallback("Missing '}' for block", 'CW001').category)
            .to.equal('brace_or_syntax_error');
    });

    it('extracts semantic fields from fallback diagnostic text', () => {
        const { classifyDiagnosticFallback } = loadDiagnosticMetadataModule();

        const sprite = classifyDiagnosticFallback('Expected value of type sprite: "GFX_missing_event"', '');
        expect(sprite.category).to.equal('unknown_sprite');
        expect(sprite.expectedType).to.equal('sprite');
        expect(sprite.symbol).to.equal('GFX_missing_event');
        expect(sprite.confidence).to.equal('low');
        expect(sprite.metadataSource).to.equal('message_heuristic');

        const scope = classifyDiagnosticFallback('Invalid scope: country expected but got fleet', '');
        expect(scope.category).to.equal('scope_mismatch');
        expect(scope.expectedType).to.equal('country');
        expect(scope.actualType).to.equal('fleet');
    });

    it('prefers structured LSP diagnostic data over fallback fields', () => {
        const { diagnosticMetadata } = loadDiagnosticMetadataModule();

        const metadata = diagnosticMetadata({
            message: 'Expected value of type sprite: "GFX_fallback"',
            code: 'CW999',
            data: {
                category: 'invalid_value_type',
                repairHint: 'Use the structured hint.',
                expectedType: 'portrait',
                actualType: 'string',
                scope: 'leader',
                symbol: 'GFX_structured',
                confidence: 'high',
                metadataSource: 'lsp_data',
            },
        } as any);

        expect(metadata.category).to.equal('invalid_value_type');
        expect(metadata.repairHint).to.equal('Use the structured hint.');
        expect(metadata.expectedType).to.equal('portrait');
        expect(metadata.actualType).to.equal('string');
        expect(metadata.scope).to.equal('leader');
        expect(metadata.symbol).to.equal('GFX_structured');
        expect(metadata.confidence).to.equal('high');
        expect(metadata.metadataSource).to.equal('lsp_data');
    });
});

function loadDiagnosticMetadataModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return {};
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/tools/diagnosticMetadata') as typeof import('../../extension/ai/tools/diagnosticMetadata');
    } finally {
        moduleLoader._load = originalLoad;
    }
}
