import { expect } from 'chai';
import {
    createDiagnosticSnapshot,
    diffDiagnosticSnapshots,
    hasAddedErrors,
} from '../../extension/ai/runner/diagnosticSnapshot';
import type { ValidationError } from '../../extension/ai/types';

function error(overrides: Partial<ValidationError> = {}): ValidationError {
    return {
        code: 'CW001',
        severity: 'error',
        message: '  bad   value\nhere  ',
        line: 3,
        column: 7,
        ...overrides,
    };
}

describe('diagnostic snapshot', () => {
    it('normalizes fields, metadata, and sorts deterministically', () => {
        const snapshot = createDiagnosticSnapshot([
            error({ message: ' z ', line: 10, data: { source: 'lsp' } }),
            error({ message: 'a\tmessage', severity: 'warning', code: 'fallback', data: { code: 'DATA', source: 'custom' } }),
        ]);

        expect(snapshot.status).to.equal('fresh');
        expect(snapshot.complete).to.equal(true);
        expect(snapshot.diagnostics).to.deep.equal([
            { message: 'a message', severity: 'warning', code: 'DATA', source: 'custom', line: 3, column: 7 },
            { message: 'z', severity: 'error', code: 'CW001', source: 'lsp', line: 10, column: 7 },
        ]);
    });

    it('preserves duplicate diagnostics as a multiset', () => {
        const before = createDiagnosticSnapshot([error()]);
        const after = createDiagnosticSnapshot([error(), error()]);
        const delta = diffDiagnosticSnapshots(before, after);
        expect(delta.comparable).to.equal(true);
        expect(delta.added).to.have.length(1);
        expect(delta.removed).to.have.length(0);
        expect(hasAddedErrors(delta)).to.equal(true);
    });

    it('keeps a pre-existing diagnostic unchanged when edits only shift its position', () => {
        const before = createDiagnosticSnapshot([error({ line: 3, column: 7 })]);
        const after = createDiagnosticSnapshot([error({ line: 30, column: 2 })]);
        const delta = diffDiagnosticSnapshots(before, after);
        expect(delta.added).to.deep.equal([]);
        expect(delta.removed).to.deep.equal([]);
    });

    it('does not compare incomplete or non-fresh snapshots', () => {
        const fresh = createDiagnosticSnapshot([]);
        for (const status of ['pending', 'stale', 'unavailable'] as const) {
            const delta = diffDiagnosticSnapshots(fresh, createDiagnosticSnapshot([], { status }));
            expect(delta).to.deep.equal({ comparable: false, added: [], removed: [] });
        }
        expect(diffDiagnosticSnapshots(fresh, createDiagnosticSnapshot([], { complete: false })).comparable).to.equal(false);
    });

    it('reports only newly added errors', () => {
        const before = createDiagnosticSnapshot([error({ severity: 'warning', message: 'warning' })]);
        const after = createDiagnosticSnapshot([
            error({ severity: 'warning', message: 'warning' }),
            error({ severity: 'info', message: 'note' }),
        ]);
        const delta = diffDiagnosticSnapshots(before, after);
        expect(hasAddedErrors(delta)).to.equal(false);
        expect(delta.added[0]?.severity).to.equal('info');
    });
});
