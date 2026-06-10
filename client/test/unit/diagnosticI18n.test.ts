import { expect } from 'chai';
import { buildDiagnosticHint, enrichDiagnosticsInPlace, diagnosticCodeString, HINT_PREFIX } from '../../extension/diagnosticI18n';
import type { EnrichableDiagnostic } from '../../extension/diagnosticI18n';

describe('diagnostic i18n enrichment', () => {
    describe('diagnosticCodeString', () => {
        it('handles string, number, object-form, and missing codes', () => {
            expect(diagnosticCodeString('CW102')).to.equal('CW102');
            expect(diagnosticCodeString(42)).to.equal('42');
            expect(diagnosticCodeString({ value: 'CW102', target: 'https://example.com' })).to.equal('CW102');
            expect(diagnosticCodeString(undefined)).to.equal(undefined);
            expect(diagnosticCodeString(null)).to.equal(undefined);
        });
    });

    describe('buildDiagnosticHint (Chinese)', () => {
        const zh = (message: string, code?: string) => buildDiagnosticHint(message, code, true);

        it('translates unknown trigger/effect errors with the symbol preserved', () => {
            expect(zh('unknown trigger has_pop used.', 'CW102'))
                .to.include('has_pop').and.to.include('触发条件');
            expect(zh('unknown effect set_pop used.', 'CW103'))
                .to.include('set_pop').and.to.include('效果');
        });

        it('translates scope errors with actual and expected scopes', () => {
            const hint = zh('any_owned_pop trigger used in incorrect scope. In fleet but expected country', 'CW104');
            expect(hint).to.include('any_owned_pop');
            expect(hint).to.include('fleet');
            expect(hint).to.include('country');
        });

        it('translates missing localisation with key and language', () => {
            const hint = zh('Localisation key my_event.1.desc is not defined for English', 'CW100');
            expect(hint).to.include('my_event.1.desc');
            expect(hint).to.include('English');
        });

        it('translates rule-structure errors', () => {
            expect(zh('cost is unexpected in tech_lasers_1', 'CW262'))
                .to.include('cost').and.to.include('tech_lasers_1');
            expect(zh('Missing area, expecting at least 1', 'CW242'))
                .to.include('area');
            expect(zh('Expecting yes or no, got maybe', 'CW240'))
                .to.include('maybe');
            expect(zh('Expected value of type sprite', 'CW240'))
                .to.include('sprite');
        });

        it('translates did-you-mean suggestion variants', () => {
            const unexpected = zh("costt is unexpected in tech_lasers_1 (did you mean 'cost'?)", 'CW262');
            expect(unexpected).to.include('costt').and.to.include('tech_lasers_1');
            expect(unexpected).to.include('是否想写 "cost"');

            const typeValue = zh("Expected value of type technology, got 'tech_laser1' (did you mean 'tech_lasers_1'?)", 'CW240');
            expect(typeValue).to.include('technology').and.to.include('tech_laser1');
            expect(typeValue).to.include('是否想写 "tech_lasers_1"');

            const gotOnly = zh("Expected value of type sprite, got 'GFX_missing'", 'CW240');
            expect(gotOnly).to.include('sprite').and.to.include('GFX_missing');
        });

        it('translates brace/parse recovery errors', () => {
            expect(zh("Missing '}' for '{' opened at line 12 col 4", 'CW001_MISSING_CLOSE_BRACE'))
                .to.include('12');
            expect(zh("Unmatched '}' - no matching '{' found", 'CW001_UNMATCHED_CLOSE_BRACE'))
                .to.include('多余');
        });

        it('translates encoding and duplicate-definition errors', () => {
            expect(zh('Localisation files must be UTF-8 BOM, this file is not', 'CW254'))
                .to.include('UTF-8 with BOM');
            expect(zh('Key tech_lasers_1 of type technology is defined multiple times', 'CW261'))
                .to.include('tech_lasers_1').and.to.include('technology');
        });

        it('restricts code-gated generic patterns to their codes', () => {
            // "X is not defined" is gated to CW101 to avoid matching unrelated messages.
            expect(zh('my_var is not defined', 'CW101')).to.include('my_var');
            expect(zh('my_var is not defined', 'CW999')).to.equal(undefined);
        });

        it('returns undefined for unknown message shapes', () => {
            expect(zh('Some never-seen-before validator output', 'CW999')).to.equal(undefined);
        });
    });

    describe('buildDiagnosticHint (English)', () => {
        const en = (message: string, code?: string) => buildDiagnosticHint(message, code, false);

        it('returns advice only where curated', () => {
            expect(en('unknown trigger has_pop used.', 'CW102')).to.include('spelling');
            expect(en('File gfx/foo.dds not found, this is case sensitive', 'CW113'))
                .to.include('case sensitive');
            // Pure-translation rules add nothing in English.
            expect(en('Expecting yes or no, got maybe', 'CW240')).to.equal(undefined);
        });
    });

    describe('enrichDiagnosticsInPlace', () => {
        it('replaces the message with Chinese and normalizes source (zh)', () => {
            const diag: EnrichableDiagnostic = {
                message: 'unknown trigger has_pop used.',
                code: 'CW102',
                source: 'CW102',
            };
            enrichDiagnosticsInPlace([diag], true);
            expect(diag.source).to.equal('CWTools');
            expect(diag.message).to.include('触发条件').and.to.include('has_pop');
            expect(diag.message).to.not.include('unknown trigger');
        });

        it('keeps the original message and appends advice (en)', () => {
            const diag: EnrichableDiagnostic = {
                message: 'unknown trigger has_pop used.',
                code: 'CW102',
                source: 'CW102',
            };
            enrichDiagnosticsInPlace([diag], false);
            expect(diag.message.startsWith('unknown trigger has_pop used.')).to.equal(true);
            expect(diag.message).to.include(HINT_PREFIX);
        });

        it('is idempotent', () => {
            const zhDiag: EnrichableDiagnostic = {
                message: 'unknown trigger has_pop used.',
                code: 'CW102',
                source: 'CW102',
            };
            enrichDiagnosticsInPlace([zhDiag], true);
            const zhOnce = zhDiag.message;
            enrichDiagnosticsInPlace([zhDiag], true);
            expect(zhDiag.message).to.equal(zhOnce);

            const enDiag: EnrichableDiagnostic = {
                message: 'unknown trigger has_pop used.',
                code: 'CW102',
                source: 'CW102',
            };
            enrichDiagnosticsInPlace([enDiag], false);
            const enOnce = enDiag.message;
            enrichDiagnosticsInPlace([enDiag], false);
            expect(enDiag.message).to.equal(enOnce);
        });

        it('handles object-form codes and leaves non-CW sources alone', () => {
            const diag: EnrichableDiagnostic = {
                message: 'unknown effect set_pop used.',
                code: { value: 'CW103' },
                source: 'SomeOtherLinter',
            };
            enrichDiagnosticsInPlace([diag], true);
            expect(diag.source).to.equal('SomeOtherLinter');
            expect(diag.message).to.include('效果').and.to.include('set_pop');
        });

        it('leaves unmatched messages untouched apart from source', () => {
            const diag: EnrichableDiagnostic = {
                message: 'Some never-seen-before validator output',
                code: 'CW999',
                source: 'CW999',
            };
            enrichDiagnosticsInPlace([diag], true);
            expect(diag.message).to.equal('Some never-seen-before validator output');
            expect(diag.source).to.equal('CWTools');
        });
    });
});
