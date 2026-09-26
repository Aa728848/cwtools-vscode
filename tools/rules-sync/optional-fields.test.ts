import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    auditOptionalFields,
    documentedOptionalFields,
    isRequiredCardinality,
    parseAliasVariants,
} from './optional-fields';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STELLARIS_CONFIG = path.join(REPO_ROOT, 'submodules', 'cwtools-stellaris-config', 'config');

describe('Stellaris rules optional-field contract', () => {
    it('treats default and explicit minimum 1 as required', () => {
        expect(isRequiredCardinality(undefined)).to.equal(true);
        expect(isRequiredCardinality('1..1')).to.equal(true);
        expect(isRequiredCardinality('1..inf')).to.equal(true);
        expect(isRequiredCardinality('~1..1')).to.equal(true);
        expect(isRequiredCardinality('2..5')).to.equal(true);
        expect(isRequiredCardinality('0..1')).to.equal(false);
        expect(isRequiredCardinality('0..inf')).to.equal(false);
    });

    it('reads inline optional markers from a documentation usage block', () => {
        const body = [
            'num_pops_assigned_to_job = {',
            '\tpop_group = <target> (if not specified, check total number)',
            '\tvalue < 300',
            '}',
        ].join('\n');
        const fields = documentedOptionalFields(body);
        expect(Array.from(fields.keys())).to.deep.equal(['pop_group']);
        expect(fields.get('pop_group')).to.contain('if not specified');
    });

    it('keeps the optional marker attached to the field, not to a scope reference', () => {
        // The parenthesised marker lives inside <...>, so 'target' is not a field.
        const fields = documentedOptionalFields('has_opinion_modifier = { who = <target (optional)> modifier = x is_reverse = no }');
        expect(Array.from(fields.keys())).to.deep.equal(['who']);
    });

    it('does not treat a documented default as an optional sibling', () => {
        const fields = documentedOptionalFields('num_buildings = { type = <key/any> value > 2 disabled = <any(default)/yes(only)> }');
        expect(Array.from(fields.keys())).to.deep.equal(['disabled']);
    });

    it('ignores required fields', () => {
        const fields = documentedOptionalFields('job = { value = int_value_field }');
        expect(fields.size).to.equal(0);
    });

    it('keeps each alias variant separate so optionality is checked per variant', () => {
        const variants = parseAliasVariants([
            'alias[trigger:sample] = {',
            '\t## cardinality = 0..1',
            '\tfield_a = int',
            '\tfield_b = int',
            '}',
            'alias[trigger:sample] = {',
            '\tfield_b = int',
            '}',
        ], 'trigger');
        expect(variants).to.have.length(2);
        expect(variants[0]!.fields.get('field_a')!.cardinality).to.equal('0..1');
        expect(variants[0]!.fields.get('field_b')!.cardinality).to.equal(undefined);
    });

    it('finds documented-optional fields the rules still require', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-fields-'));
        try {
            fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'logs', 'trigger_docs.log'), [
                'sample_trigger - Checks something',
                'sample_trigger = {',
                '\tscoped = <target> (if not specified, check total number)',
                '\tvalue > 0',
                '}',
                'Supported Scopes: country',
                '',
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(tmp, 'triggers.cwt'), [
                'alias[trigger:sample_trigger] = {',
                '\tscoped = scope_group[target_country]',
                '\tvalue = int_value_field',
                '}',
                '',
            ].join('\n'), 'utf8');

            const audit = auditOptionalFields(tmp);
            expect(audit.findings).to.have.length(1);
            expect(audit.findings[0]!.rule).to.equal('sample_trigger');
            expect(audit.findings[0]!.field).to.equal('scoped');
            expect(audit.findings[0]!.declaredCardinality).to.equal('<default 1..1>');
            expect(audit.findings[0]!.line).to.equal(2);

            fs.writeFileSync(path.join(tmp, 'triggers.cwt'), [
                'alias[trigger:sample_trigger] = {',
                '\t## cardinality = 0..1',
                '\tscoped = scope_group[target_country]',
                '\tvalue = int_value_field',
                '}',
                '',
            ].join('\n'), 'utf8');
            expect(auditOptionalFields(tmp).findings).to.have.length(0);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('keeps the maintained Stellaris rules free of documented-optional drift', () => {
        // Regression for the reported false positive: the documentation marks
        // pop_group optional ("if not specified, check total number"), so
        // requiring it reported CW242 for num_pops_assigned_to_job = { value > 0 }.
        const audit = auditOptionalFields(STELLARIS_CONFIG);
        const report = audit.findings
            .map(finding => finding.kind + ':' + finding.rule + '.' + finding.field + ' (' + finding.declaredCardinality + ')')
            .join(', ');
        expect(report, 'add "## cardinality = 0..1" above the listed field').to.equal('');
    });

    it('keeps pop_group optional on num_pops_assigned_to_job', () => {
        const rules = fs.readFileSync(path.join(STELLARIS_CONFIG, 'triggers.cwt'), 'utf8');
        const block = /alias\[trigger:num_pops_assigned_to_job\] = \{([\s\S]*?)\n}/.exec(rules);
        expect(block, 'num_pops_assigned_to_job rule should exist').to.not.equal(null);
        expect(block![1]).to.contain('## cardinality = 0..1\n\tpop_group');
        expect(block![1]).to.contain('value = int_value_field');
    });
});
