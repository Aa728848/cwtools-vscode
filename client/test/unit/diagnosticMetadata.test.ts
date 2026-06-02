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
