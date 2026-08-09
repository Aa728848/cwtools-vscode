import { expect } from 'chai';
import { buildDiagnosticHint, enrichDiagnosticsInPlace, diagnosticCodeString, filterLocalisationDiagnostics, foldLocalisationWarnings, foldRelatedCallSiteInformation, HINT_PREFIX, isLocalisationDiagnostic } from '../../extension/diagnosticI18n';
import type { EnrichableDiagnostic, FoldableDiagnostic } from '../../extension/diagnosticI18n';

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

    describe('localisation diagnostic filtering', () => {
        it('recognizes localisation codes and their subcodes in string and object form', () => {
            expect(isLocalisationDiagnostic({ code: 'CW100' })).to.equal(true);
            expect(isLocalisationDiagnostic({ code: 'cw255_detail' })).to.equal(true);
            expect(isLocalisationDiagnostic({ code: { value: 'CW275' } })).to.equal(true);
            expect(isLocalisationDiagnostic({ code: 'CW102' })).to.equal(false);
        });

        it('removes only localisation diagnostics', () => {
            const diagnostics = [
                { code: 'CW100', message: 'missing localisation' },
                { code: 'CW102', message: 'unknown trigger' },
                { code: undefined, message: 'uncoded parser recovery' },
            ];
            expect(filterLocalisationDiagnostics(diagnostics)).to.deep.equal(diagnostics.slice(1));
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

        it('translates the CW274D call-site definition hint', () => {
            const hint = zh('This scripted_effect my_effect results in an error when expanded at a call site', 'CW274D');
            expect(hint).to.include('my_effect');
            expect(hint).to.include('调用点');
            expect(hint).to.include('CW274');
        });

        it('translates brace/parse recovery errors', () => {            expect(zh("Missing '}' for '{' opened at line 12 col 4", 'CW001_MISSING_CLOSE_BRACE'))
                .to.include('12');
            expect(zh("Unmatched '}' - no matching '{' found", 'CW001_UNMATCHED_CLOSE_BRACE'))
                .to.include('多余');
        });

        it('translates scripted_action scope ordering errors', () => {
            const hint = zh('In scripted_action, user_scope must be the first entry and scope must be the second entry', 'CW999');
            expect(hint).to.include('scripted_action');
            expect(hint).to.include('user_scope');
            expect(hint).to.include('scope');
            expect(hint).to.include('第一项');
            expect(hint).to.include('第二项');
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
            expect(en('In scripted_action, user_scope must be the first entry and scope must be the second entry', 'CW999'))
                .to.include('Move user_scope to the first entry');
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

    describe('foldLocalisationWarnings', () => {
        interface TestDiagnostic extends FoldableDiagnostic {
            data?: string;
        }
        const WARNING = 1;
        const ERROR = 0;
        const uri = { fsPath: '/mod/events/test.txt' };
        const rangeAt = (line: number) => ({
            start: { line, character: 4 },
            end: { line, character: 10 },
        });
        const warning = (code: string, line: number, message: string, data?: string): TestDiagnostic => ({
            message,
            code,
            severity: WARNING,
            range: rangeAt(line),
            data,
        });
        const at = <T>(list: readonly T[], index: number): T => {
            const value = list[index];
            if (value === undefined) throw new Error(`expected index ${index} to exist`);
            return value;
        };

        it('folds same-code localisation warnings into one entry with related locations', () => {
            const diags = [
                warning('CW255', 2, 'Localisation key a is not defined for English'),
                warning('CW255', 5, 'Localisation key b is not defined for English'),
                warning('CW255', 9, 'Localisation key c is not defined for English'),
            ];
            const result = foldLocalisationWarnings(diags, uri, false);
            expect(result).to.have.lengthOf(1);
            const merged = at(result, 0);
            expect(merged.code).to.equal('CW255');
            expect(merged.message).to.include('3').and.to.include('CW255');
            expect(merged.range).to.equal(at(diags, 0).range);
            const related = merged.relatedInformation ?? [];
            expect(related).to.have.lengthOf(3);
            expect(at(related, 1).message).to.equal(at(diags, 1).message);
            expect(at(related, 1).location.range).to.equal(at(diags, 1).range);
            expect(at(related, 1).location.uri).to.equal(uri);
        });

        it('folds per code and keeps original ordering of first occurrences', () => {
            const diags = [
                warning('CW255', 2, 'a'),
                warning('CW102', 3, 'unknown trigger has_pop used.'),
                warning('CW258', 4, 'b'),
                warning('CW255', 5, 'c'),
                warning('CW258', 6, 'd'),
            ];
            const result = foldLocalisationWarnings(diags, uri, false);
            expect(result).to.have.lengthOf(3);
            expect(at(result, 0).code).to.equal('CW255');
            expect(at(result, 0).relatedInformation ?? []).to.have.lengthOf(2);
            expect(at(result, 1)).to.equal(at(diags, 1));
            expect(at(result, 2).code).to.equal('CW258');
            expect(at(result, 2).relatedInformation ?? []).to.have.lengthOf(2);
        });

        it('never folds errors, even localisation-coded ones', () => {
            const diags: TestDiagnostic[] = [
                { message: 'e1', code: 'CW100', severity: ERROR, range: rangeAt(1) },
                { message: 'e2', code: 'CW100', severity: ERROR, range: rangeAt(2) },
            ];
            const result = foldLocalisationWarnings(diags, uri, false);
            expect(result).to.have.lengthOf(2);
            expect(at(result, 0)).to.equal(at(diags, 0));
            expect(at(result, 1)).to.equal(at(diags, 1));
        });

        it('leaves single occurrences and non-localisation codes untouched', () => {
            const diags = [
                warning('CW255', 2, 'only one'),
                warning('CW102', 3, 'unknown trigger has_pop used.'),
                warning('CW102', 4, 'unknown effect set_pop used.'),
            ];
            const result = foldLocalisationWarnings(diags, uri, false);
            expect(result).to.deep.equal(diags);
        });

        it('keeps the first occurrence payload so quick fixes still target it', () => {
            const diags = [
                warning('CW266', 2, 'first', 'payload-1'),
                warning('CW266', 5, 'second', 'payload-2'),
            ];
            const result = foldLocalisationWarnings(diags, uri, true);
            expect(result).to.have.lengthOf(1);
            expect(at(result, 0).data).to.equal('payload-1');
            expect(at(result, 0).message).to.include('2').and.to.include('本地化');
        });
    });

    describe('foldRelatedCallSiteInformation', () => {
        interface TestDiagnostic extends FoldableDiagnostic {
            data?: string;
        }
        const INFORMATION = 2;
        const WARNING = 1;
        const uri = { fsPath: '/mod/common/scripted_effects/test.txt' };
        const rangeAt = (line: number) => ({
            start: { line, character: 4 },
            end: { line, character: 10 },
        });
        const relatedAt = (line: number, message = 'Call site of test_effect') => ({
            location: { uri, range: rangeAt(line) },
            message,
        });
        const information = (
            line: number,
            callLine: number,
            message = "scripted effect 'test_effect' results in an error when expanded at a call site",
            data?: string,
        ): TestDiagnostic => ({
            message,
            code: 'CW274D',
            severity: INFORMATION,
            range: rangeAt(line),
            relatedInformation: [relatedAt(callLine)],
            data,
        });

        it('folds repeated definition hints and preserves their call-site locations', () => {
            const diags = [
                information(10, 30, undefined, 'payload-1'),
                information(10, 50, undefined, 'payload-2'),
                information(10, 70, undefined, 'payload-3'),
            ];
            const result = foldRelatedCallSiteInformation(diags, false);
            expect(result).to.have.lengthOf(1);
            const merged = result[0];
            expect(merged).to.not.equal(undefined);
            expect(merged?.data).to.equal('payload-1');
            expect(merged?.message).to.include('3 call sites');
            expect(merged?.relatedInformation?.map(item => item.location.range.start.line))
                .to.deep.equal([30, 50, 70]);
        });

        it('keeps different definitions in separate groups', () => {
            const diags = [
                information(10, 30),
                information(10, 50),
                information(20, 60, "scripted effect 'other_effect' results in an error when expanded at a call site"),
                information(20, 80, "scripted effect 'other_effect' results in an error when expanded at a call site"),
            ];
            const result = foldRelatedCallSiteInformation(diags, true);
            expect(result).to.have.lengthOf(2);
            expect(result[0]?.message).to.include('2 个调用点');
            expect(result[1]?.message).to.include('2 个调用点');
            expect(result[0]?.range.start.line).to.equal(10);
            expect(result[1]?.range.start.line).to.equal(20);
        });

        it('leaves single, non-information, and non-CW274D diagnostics untouched', () => {
            const single = information(10, 30);
            const warning = { ...information(20, 40), severity: WARNING };
            const other = { ...information(30, 50), code: 'CW274' };
            const diags = [single, warning, other];
            expect(foldRelatedCallSiteInformation(diags, false)).to.deep.equal(diags);
        });
    });
});
