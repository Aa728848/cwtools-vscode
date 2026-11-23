import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    auditStaleFields,
    extractCwtCommonTypeFields,
    extractExecutableIdentifiers,
} from './stale-fields';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STELLARIS_CONFIG = path.join(REPO_ROOT, 'submodules', 'cwtools-stellaris-config', 'config');

describe('Stellaris rules stale / removed CWT field audit', () => {
    it('extracts top-level fields, tracks error_if_only_match annotations, and skips type_per_file types', () => {
        const cwt = [
            'types = {',
            '\ttype[sample_district] = {',
            '\t\tpath = "game/common/districts"',
            '\t}',
            '\ttype[file_table] = {',
            '\t\tpath = "game/common/diplo_phrases"',
            '\t\ttype_per_file = yes',
            '\t}',
            '}',
            'sample_district = {',
            '\tis_uncapped = { alias_name[trigger] = alias_match_left[trigger] }',
            '\t## cardinality = 0..1',
            '\t## severity = warning',
            '\t## error_if_only_match = "Deprecated: use is_uncapped"',
            '\tis_capped_by_modifier = bool',
            '\t## cardinality = 0..1',
            '\t## error_if_only_match = "Old form"',
            '\toverloaded_field = int',
            '\toverloaded_field = { value = int }',
            '}',
            'file_table = {',
            '\tgreetings = {}',
            '}',
        ].join('\n');

        const fields = extractCwtCommonTypeFields(cwt, 'common/districts.cwt');
        const byName = new Map(fields.map(f => [f.field, f]));
        expect(Array.from(byName.keys()).sort()).to.deep.equal([
            'is_capped_by_modifier',
            'is_uncapped',
            'overloaded_field',
        ]);
        expect(byName.get('is_uncapped')!.kind).to.equal('block');
        expect(byName.get('is_uncapped')!.deprecated).to.equal(false);
        expect(byName.get('is_capped_by_modifier')!.kind).to.equal('leaf');
        expect(byName.get('is_capped_by_modifier')!.deprecated).to.equal(true);
        // Only fully deprecated fields count as annotatedDeprecated.
        expect(byName.get('overloaded_field')!.deprecated).to.equal(false);
    });

    it('extracts adjacent NUL-separated and dot-prefixed engine identifiers without skipping neighbors', () => {
        const buf = Buffer.from('\x00auto_opens\x00no_diff\x00.set.custom_portraits\x00is_uncapped\x00', 'ascii');
        const idents = extractExecutableIdentifiers(buf);
        expect(idents.has('auto_opens')).to.equal(true);
        expect(idents.has('no_diff')).to.equal(true);
        expect(idents.has('custom_portraits')).to.equal(true);
        expect(idents.has('is_uncapped')).to.equal(true);
        expect(idents.has('removed_field')).to.equal(false);
    });

    it('classifies removed_from_engine vs unused_in_vanilla and respects README, inline_scripts, and deprecation annotations', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-fields-'));
        try {
            const configDir = path.join(tmp, 'config');
            const commonDir = path.join(tmp, 'game', 'common');
            const fakeExe = path.join(tmp, 'game', 'stellaris.exe');
            fs.mkdirSync(path.join(configDir, 'common'), { recursive: true });
            fs.mkdirSync(path.join(commonDir, 'districts'), { recursive: true });
            fs.mkdirSync(path.join(commonDir, 'inline_scripts'), { recursive: true });

            fs.writeFileSync(path.join(configDir, 'common', 'districts.cwt'), [
                'types = {',
                '\ttype[district] = { path = "game/common/districts" }',
                '}',
                'district = {',
                '\tis_uncapped = {}',
                '\tdoc_only_field = bool',
                '\tinline_only_field = int',
                '\tcross_system_unused = bool',
                '\tdead_engine_field = bool',
                '\t## severity = warning',
                '\t## error_if_only_match = "Deprecated"',
                '\tannotated_dead_field = bool',
                '}',
            ].join('\n'), 'utf8');

            fs.writeFileSync(path.join(commonDir, 'districts', '00_districts.txt'), 'd_test = { is_uncapped = { always = no } }\n', 'utf8');
            fs.writeFileSync(path.join(commonDir, 'districts', '00_DOCUMENTATION.txt'), '# doc_only_field = yes\n', 'utf8');
            fs.writeFileSync(path.join(commonDir, 'inline_scripts', 'shared.txt'), 'inline_only_field = 1\n', 'utf8');
            fs.writeFileSync(fakeExe, Buffer.from('\x00is_uncapped\x00cross_system_unused\x00', 'ascii'));

            const report = auditStaleFields(commonDir, configDir, path.join(tmp, 'game'));
            expect(report.summary.executableScanned).to.equal(true);
            expect(report.summary.annotatedDeprecated).to.equal(1);
            expect(report.summary.removedFromEngine).to.equal(1);
            expect(report.summary.unusedInVanilla).to.equal(1);
            expect(report.findings.map(f => `${f.field}:${f.status}`)).to.deep.equal([
                'dead_engine_field:removed_from_engine',
                'cross_system_unused:unused_in_vanilla',
            ]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('marks known deprecated Stellaris 4.x fields in maintained rules with error_if_only_match', () => {
        const districts = extractCwtCommonTypeFields(
            fs.readFileSync(path.join(STELLARIS_CONFIG, 'common', 'districts.cwt'), 'utf8'),
            'common/districts.cwt',
        );
        const byDistrictField = new Map(districts.map(f => [f.field, f]));
        expect(byDistrictField.get('is_capped_by_modifier')?.deprecated).to.equal(true);
        expect(byDistrictField.get('inherits_capped_modifiers_from')?.deprecated).to.equal(true);
        expect(byDistrictField.get('base_cap_amount')?.deprecated).to.equal(true);
        expect(byDistrictField.get('is_uncapped')?.deprecated).to.equal(false);

        const zones = extractCwtCommonTypeFields(
            fs.readFileSync(path.join(STELLARIS_CONFIG, 'common', 'zones.cwt'), 'utf8'),
            'common/zones.cwt',
        );
        const byZoneField = new Map(zones.filter(f => f.typeName === 'zones').map(f => [f.field, f]));
        expect(byZoneField.get('include')?.deprecated).to.equal(true);
        expect(byZoneField.get('exclude')?.deprecated).to.equal(true);
        expect(byZoneField.get('included_buildings')?.deprecated).to.equal(false);
    });
});
