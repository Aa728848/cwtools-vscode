import { expect } from 'chai';
import { buildShaderAbiUpgrade } from './shader-abi-sync';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function inventory(version = '4.4.7') {
    return {
        _schema: 'cwtools/shader-abi-inventory/v1',
        game: 'stellaris',
        game_version: version,
        candidate_universe: {
            source_files: 2,
            shader_files: 1,
            fxh_files: 1,
            effect_declarations: 2,
            unique_effect_names: 2,
            inventory_sha256: HASH_A,
            declaration_inventory_sha256: HASH_B,
        },
        game_identity: {
            launcher_settings_sha256: HASH_C,
            executable_size: 42,
            executable_sha256: HASH_D,
        },
        executable_string_scan: {
            ascii_hits: 1,
            ascii_effect_names: ['EngineEffect'],
            utf16le_hits: 0,
            utf16le_effect_names: [],
        },
        effects: [
            { name: 'EngineEffect', shader_file: 'gfx/FX/main.shader', selection_start_line: 1, selection_start_column: 1 },
            { name: 'OtherEffect', shader_file: 'gfx/FX/main.shader', selection_start_line: 10, selection_start_column: 1 },
        ],
    };
}

function catalog(version = '4.4.6') {
    return {
        _schema: 'cwtools/shader-abi-catalog/v1',
        game: 'stellaris',
        game_version: version,
        entries: [{
            game: 'stellaris',
            game_version: version,
            entry_kind: 'effect',
            name: 'EngineEffect',
            shader_file: 'gfx/FX/main.shader',
            evidence: 'executable_observation',
            rename_policy: 'forbidden',
        }],
    };
}

function completedAudit(version = '4.4.7') {
    return {
        _schema: 'cwtools/shader-abi-audit/v1',
        game: 'stellaris',
        game_version: version,
        review_status: 'complete',
        automatic_promotion: false,
        candidate_universe: { ...inventory(version).candidate_universe },
        game_identity: { ...inventory(version).game_identity },
        confirmed_engine_entries: ['engineeffect|gfx/fx/main.shader'],
        evidence_reviews: [
            { stage: 'vanilla_shader_inventory', status: 'reviewed', result: 'Reviewed inventory.' },
            { stage: 'textual_call_sites', status: 'reviewed', result: 'Reviewed callers.' },
            { stage: 'renderer_contracts', status: 'reviewed', result: 'Reviewed renderer contracts.' },
            { stage: 'executable_or_runtime', status: 'reviewed', result: 'Reviewed executable observation.' },
        ],
    };
}

describe('Stellaris Shader ABI rules sync', () => {
    it('never carries catalog entries across an unreviewed game-version boundary', () => {
        const result = buildShaderAbiUpgrade({
            inventory: inventory('4.4.7'),
            existingCatalog: catalog('4.4.6'),
            existingAudit: completedAudit('4.4.6'),
        });

        expect(result.draftCatalog.entries).to.deep.equal([]);
        expect(result.draftAudit.review_status).to.equal('in_progress');
        expect(result.draftAudit.automatic_promotion).to.equal(false);
        expect(result.report).to.include({
            from_version: '4.4.6',
            to_version: '4.4.7',
            entry_source: 'empty_upgrade_draft',
            entries_requiring_review: 1,
        });
    });

    it('retains reviewed entries only when version, corpus, declarations, and EXE are unchanged', () => {
        const sameVersionAudit = completedAudit('4.4.7');
        const result = buildShaderAbiUpgrade({
            inventory: inventory('4.4.7'),
            existingCatalog: catalog('4.4.7'),
            existingAudit: sameVersionAudit,
        });

        expect(result.report).to.include({ snapshot_current: true, entry_source: 'unchanged_snapshot' });
        expect(result.draftAudit.review_status).to.equal('complete');
        expect(result.draftCatalog.entries).to.have.length(1);
    });

    it('accepts apply-ready artifacts only after all evidence stages and identities are reviewed', () => {
        const reviewedCatalog = catalog('4.4.7');
        const valid = buildShaderAbiUpgrade({
            inventory: inventory('4.4.7'),
            existingCatalog: catalog('4.4.6'),
            existingAudit: completedAudit('4.4.6'),
            reviewedCatalog,
            reviewedAudit: completedAudit('4.4.7'),
        });
        expect(valid.draftAudit.review_status).to.equal('complete');
        expect(valid.draftAudit.confirmed_engine_entries).to.deep.equal(['engineeffect|gfx/fx/main.shader']);

        const incomplete = completedAudit('4.4.7');
        incomplete.evidence_reviews[3]!.status = 'needs_review';
        expect(() => buildShaderAbiUpgrade({
            inventory: inventory('4.4.7'),
            existingCatalog: catalog('4.4.6'),
            reviewedCatalog,
            reviewedAudit: incomplete,
        })).to.throw('executable_or_runtime is not complete');
    });

    it('rejects guessed catalog evidence even when the Effect exists', () => {
        const unsafe = catalog('4.4.7');
        unsafe.entries[0]!.evidence = 'guessed_from_no_callers';
        expect(() => buildShaderAbiUpgrade({
            inventory: inventory('4.4.7'),
            existingCatalog: catalog('4.4.6'),
            reviewedCatalog: unsafe,
        })).to.throw('evidence is not reviewed evidence');
    });
});
