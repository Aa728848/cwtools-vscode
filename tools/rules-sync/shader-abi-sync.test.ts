import { expect } from 'chai';
import { buildShaderAbiAutoMerge } from './shader-abi-sync';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_OLD_EXE = 'e'.repeat(64);

function inventory(version = '4.4.7') {
    return {
        _schema: 'cwtools/shader-abi-inventory/v1',
        game: 'stellaris',
        game_version: version,
        candidate_universe: {
            source_files: 3,
            shader_files: 2,
            fxh_files: 1,
            effect_declarations: 3,
            unique_effect_names: 3,
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
            { name: 'NewEffect', shader_file: 'gfx/FX/extra.shader', selection_start_line: 1, selection_start_column: 1 },
        ],
    };
}

function existingCatalog(version = '4.4.6') {
    return {
        _schema: 'cwtools/shader-abi-catalog/v1',
        game: 'stellaris',
        game_version: version,
        entries: [
            {
                game: 'stellaris',
                game_version: version,
                entry_kind: 'effect',
                name: 'EngineEffect',
                shader_file: 'gfx/FX/main.shader',
                evidence: 'executable_observation',
                rename_policy: 'allowed',
                notes: 'Reviewed engine entry point.',
            },
            {
                game: 'stellaris',
                game_version: version,
                entry_kind: 'effect',
                name: 'RemovedEffect',
                shader_file: 'gfx/FX/removed.shader',
                evidence: 'manual_runtime_test',
                rename_policy: 'forbidden',
            },
        ],
    };
}

function existingAudit(version = '4.4.6') {
    return {
        _schema: 'cwtools/shader-abi-audit/v1',
        game: 'stellaris',
        game_version: version,
        review_status: 'complete',
        automatic_promotion: false,
        game_identity: { executable_sha256: HASH_OLD_EXE },
        confirmed_engine_entries: [],
    };
}

function existingRendererContracts(version = '4.4.6') {
    return {
        _schema: 'cwtools/sprite-renderer-contracts v1',
        contracts: [
            {
                game: 'stellaris',
                game_version: version,
                renderer_subtype: 'normal',
                shader_file: 'gfx/FX/main.shader',
                effects: ['EngineEffect', 'OtherEffect'],
                evidence: 'official_vanilla_contract',
            },
            {
                game: 'stellaris',
                game_version: version,
                renderer_subtype: 'normal',
                shader_file: 'gfx/FX/gone.shader',
                effects: ['GhostEffect'],
                evidence: 'official_vanilla_contract',
            },
        ],
    };
}

function merge(overrides: Partial<Parameters<typeof buildShaderAbiAutoMerge>[0]> = {}) {
    return buildShaderAbiAutoMerge({
        inventory: inventory('4.4.7'),
        existingCatalog: existingCatalog('4.4.6'),
        existingAudit: existingAudit('4.4.6'),
        existingRendererContracts: existingRendererContracts('4.4.6'),
        ...overrides,
    });
}

describe('Stellaris Shader ABI auto merge', () => {
    it('carries still-declared entries across the version boundary with their reviewed evidence', () => {
        const result = merge();
        const entries = result.catalog.entries as Array<Record<string, unknown>>;
        const carried = entries.find(entry => entry.name === 'EngineEffect');
        expect(carried).to.deep.include({
            game_version: '4.4.7',
            evidence: 'executable_observation',
            rename_policy: 'allowed',
            notes: 'Reviewed engine entry point.',
        });
    });

    it('auto-registers every uncovered declaration with automatic_inventory evidence', () => {
        const result = merge();
        const entries = result.catalog.entries as Array<Record<string, unknown>>;
        expect(entries).to.have.length(3);
        const added = entries.filter(entry => entry.name !== 'EngineEffect');
        expect(added.map(entry => entry.name)).to.deep.equal(['NewEffect', 'OtherEffect']);
        for (const entry of added) {
            expect(entry).to.include({
                game: 'stellaris',
                game_version: '4.4.7',
                entry_kind: 'effect',
                evidence: 'automatic_inventory',
                rename_policy: 'forbidden',
            });
            expect(entry.notes).to.be.a('string').and.not.equal('');
        }
        expect(entries.map(entry => `${String(entry.name).toLowerCase()}|${String(entry.shader_file)}`))
           .to.deep.equal(['engineeffect|gfx/fx/main.shader', 'neweffect|gfx/fx/extra.shader', 'othereffect|gfx/fx/main.shader']);
    });

    it('drops entries whose declaration vanished and reports them', () => {
        const result = merge();
        const entries = result.catalog.entries as Array<Record<string, unknown>>;
        expect(entries.some(entry => entry.name === 'RemovedEffect')).to.equal(false);
        const catalog = result.mergeReport.catalog as { dropped: Array<Record<string, unknown>> };
        expect(catalog.dropped).to.have.length(1);
        expect(catalog.dropped[0]).to.deep.include({ name: 'RemovedEffect', shader_file: 'gfx/fx/removed.shader' });
        expect(String(catalog.dropped[0]!.reason)).to.contain('No matching Effect declaration');
    });

    it('writes a complete audit synchronized with the merged catalog', () => {
        const result = merge();
        expect(result.audit.review_status).to.equal('complete');
        expect(result.audit.automatic_promotion).to.equal(false);
        expect(result.audit.game_version).to.equal('4.4.7');
        expect(result.audit.confirmed_engine_entries).to.deep.equal([
            'engineeffect|gfx/fx/main.shader',
            'neweffect|gfx/fx/extra.shader',
            'othereffect|gfx/fx/main.shader',
        ]);
        const universe = result.audit.candidate_universe as Record<string, unknown>;
        expect(universe).to.include({
            effect_declarations: 3,
            unique_effect_names: 3,
            inventory_sha256: HASH_A,
            declaration_inventory_sha256: HASH_B,
        });
        const reviews = result.audit.evidence_reviews as Array<Record<string, unknown>>;
        expect(reviews.map(review => review.stage)).to.have.members([
            'vanilla_shader_inventory',
            'textual_call_sites',
            'renderer_contracts',
            'executable_or_runtime',
        ]);
        for (const review of reviews) {
            expect(['reviewed', 'no_qualifying_evidence']).to.include(review.status);
            expect(review.result).to.be.a('string').and.not.equal('');
        }
    });

    it('keeps renderer contracts whose effects still exist and drops the rest', () => {
        const result = merge();
        const contracts = result.rendererContracts!.contracts as Array<Record<string, unknown>>;
        expect(contracts).to.have.length(1);
        expect(contracts[0]).to.deep.include({
            game_version: '4.4.7',
            renderer_subtype: 'normal',
            shader_file: 'gfx/FX/main.shader',
        });
        const report = result.mergeReport.renderer_contracts as { kept: number; dropped: Array<Record<string, unknown>> };
        expect(report.kept).to.equal(1);
        expect(report.dropped).to.have.length(1);
        expect(String(report.dropped[0]!.reason)).to.contain('GhostEffect');
    });

    it('reports the version transition and executable identity change', () => {
        const result = merge();
        expect(result.mergeReport).to.include({
            _schema: 'cwtools/shader-abi-merge-report/v1',
            from_version: '4.4.6',
            to_version: '4.4.7',
            automatic_merge: true,
        });
        const identity = result.mergeReport.game_identity as Record<string, unknown>;
        expect(identity).to.deep.equal({
            previous_executable_sha256: HASH_OLD_EXE,
            executable_sha256: HASH_D,
            executable_changed: true,
        });
    });

    it('treats a missing catalog as an empty one and auto-registers everything', () => {
        const result = merge({ existingCatalog: undefined, existingAudit: undefined, existingRendererContracts: undefined });
        const entries = result.catalog.entries as Array<Record<string, unknown>>;
        expect(entries).to.have.length(3);
        expect(entries.every(entry => entry.evidence === 'automatic_inventory')).to.equal(true);
        expect(result.mergeReport.from_version).to.equal('unknown');
        expect(result.rendererContracts).to.equal(undefined);
        const contracts = result.mergeReport.renderer_contracts as { skipped: boolean };
        expect(contracts.skipped).to.equal(true);
        const identity = result.mergeReport.game_identity as Record<string, unknown>;
        expect(identity.executable_changed).to.equal(false);
    });

    it('carries a name-only entry by name match and does not duplicate its declarations', () => {
        const catalog = existingCatalog('4.4.6');
        catalog.entries = [{
            game: 'stellaris',
            game_version: '4.4.6',
            entry_kind: 'effect',
            name: 'EngineEffect',
            evidence: 'official_vanilla_contract',
            rename_policy: 'forbidden',
        }];
        const result = merge({ existingCatalog: catalog });
        const entries = result.catalog.entries as Array<Record<string, unknown>>;
        const engineEntries = entries.filter(entry => entry.name === 'EngineEffect');
        expect(engineEntries).to.have.length(1);
        expect(engineEntries[0]).to.deep.include({
            evidence: 'official_vanilla_contract',
            game_version: '4.4.7',
        });
        expect(engineEntries[0]!.shader_file).to.equal(undefined);
        expect(entries).to.have.length(3);
    });
});
