import { expect } from 'chai';
import {
    chunkRevalidateBatches,
    DIAGNOSTIC_REVALIDATE_BATCH_SIZE,
    isDiagnosticRelevantFile,
    isNeverValidatedState,
    selectRevalidateTargets,
    shouldOpenDocumentForRevalidate,
    type DiagnosticsFreshnessState,
} from '../../extension/diagnosticRevalidation';

describe('diagnostic revalidation helpers', () => {
    describe('isNeverValidatedState', () => {
        it('treats an explicit validated:false as never validated (new server contract)', () => {
            const state: DiagnosticsFreshnessState = {
                freshness: 'stale',
                epoch: 0,
                validated: false,
                hasDiagnosticsField: false,
            };
            expect(isNeverValidatedState(state)).to.equal(true);
        });

        it('treats an explicit validated:true as validated even at epoch 0', () => {
            const state: DiagnosticsFreshnessState = {
                freshness: 'stale',
                epoch: 0,
                validated: true,
                hasDiagnosticsField: true,
            };
            expect(isNeverValidatedState(state)).to.equal(false);
        });

        it('falls back to the legacy epoch:0 + stale + no-diagnostics shape (old server)', () => {
            expect(isNeverValidatedState({ freshness: 'stale', epoch: 0, hasDiagnosticsField: false })).to.equal(true);
        });

        it('treats a stale response that carries an empty diagnostics array as validated', () => {
            expect(isNeverValidatedState({ freshness: 'stale', epoch: 0, hasDiagnosticsField: true })).to.equal(false);
        });

        it('treats a stale response that carries diagnostics as validated', () => {
            expect(isNeverValidatedState({ freshness: 'stale', epoch: 7, hasDiagnosticsField: true })).to.equal(false);
        });

        it('ignores a non-boolean validated field and uses the legacy shape', () => {
            // Same narrowing the file tool performs on the raw LSP payload.
            const wire: Record<string, unknown> = { freshness: 'stale', epoch: 0, validated: 'false' };
            const state: DiagnosticsFreshnessState = {
                freshness: String(wire.freshness),
                epoch: typeof wire.epoch === 'number' ? wire.epoch : 0,
                validated: typeof wire.validated === 'boolean' ? wire.validated : undefined,
                hasDiagnosticsField: Array.isArray(wire.diagnostics),
            };
            expect(isNeverValidatedState(state)).to.equal(true);
        });

        it('does not classify pending or fresh responses as never validated', () => {
            expect(isNeverValidatedState({ freshness: 'pending', epoch: 0, hasDiagnosticsField: false })).to.equal(false);
            expect(isNeverValidatedState({ freshness: 'fresh', epoch: 3, hasDiagnosticsField: true })).to.equal(false);
        });
    });

    describe('shouldOpenDocumentForRevalidate', () => {
        it('opens a file the server never had, even when revalidateFiles reported success', () => {
            expect(shouldOpenDocumentForRevalidate(true, false)).to.equal(true);
        });

        it('skips opening when the document is already open and revalidation was triggered', () => {
            expect(shouldOpenDocumentForRevalidate(true, true)).to.equal(false);
        });

        it('opens when the revalidation request failed', () => {
            expect(shouldOpenDocumentForRevalidate(false, true)).to.equal(true);
            expect(shouldOpenDocumentForRevalidate(false, false)).to.equal(true);
        });
    });

    describe('isDiagnosticRelevantFile', () => {
        it('accepts every extension the CWTools server reports diagnostics for', () => {
            for (const name of ['a.txt', 'a.gui', 'a.yml', 'a.gfx', 'a.asset', 'a.cwt', 'a.entity', 'a.shader', 'a.fxh']) {
                expect(isDiagnosticRelevantFile(name), name).to.equal(true);
            }
        });

        it('matches extensions case-insensitively', () => {
            expect(isDiagnosticRelevantFile('events/main_events/C:\\x\\A.TXT')).to.equal(true);
        });

        it('rejects unrelated files', () => {
            expect(isDiagnosticRelevantFile('README.md')).to.equal(false);
            expect(isDiagnosticRelevantFile('common/scripted_effects')).to.equal(false);
            expect(isDiagnosticRelevantFile('dir.with.dots/file')).to.equal(false);
            expect(isDiagnosticRelevantFile('.txt')).to.equal(false);
        });
    });

    describe('selectRevalidateTargets', () => {
        it('filters, deduplicates and sorts deterministically', () => {
            const targets = selectRevalidateTargets([
                'b.txt',
                'a.txt',
                'b.txt',
                'notes.md',
                'A.GUI',
            ]);
            expect(targets).to.deep.equal(['A.GUI', 'a.txt', 'b.txt']);
        });

        it('caps the result at the batch size by default', () => {
            const many = Array.from({ length: DIAGNOSTIC_REVALIDATE_BATCH_SIZE + 5 }, (_, i) => `f${i}.txt`);
            expect(selectRevalidateTargets(many)).to.have.length(DIAGNOSTIC_REVALIDATE_BATCH_SIZE);
            expect(selectRevalidateTargets(many, 3)).to.have.length(3);
        });
    });

    describe('chunkRevalidateBatches', () => {
        it('splits into bounded batches without losing or reordering entries', () => {
            const items = Array.from({ length: 5 }, (_, i) => i);
            expect(chunkRevalidateBatches(items, 2)).to.deep.equal([[0, 1], [2, 3], [4]]);
            expect(chunkRevalidateBatches(items, 10)).to.deep.equal([[0, 1, 2, 3, 4]]);
            expect(chunkRevalidateBatches([], 2)).to.deep.equal([]);
        });

        it('never produces an empty or infinite batch for a non-positive size', () => {
            expect(chunkRevalidateBatches(['a', 'b'], 0)).to.deep.equal([['a'], ['b']]);
            expect(chunkRevalidateBatches(['a'], -5)).to.deep.equal([['a']]);
        });

        it('uses the server batch size as the default', () => {
            const items = Array.from({ length: DIAGNOSTIC_REVALIDATE_BATCH_SIZE * 2 + 1 }, (_, i) => i);
            const batches = chunkRevalidateBatches(items);
            expect(batches).to.have.length(3);
            expect(batches[0]).to.have.length(DIAGNOSTIC_REVALIDATE_BATCH_SIZE);
        });
    });
});
