import { expect } from 'chai';
import {
    addSymbolsToIndex,
    parseWorkspaceSymbols,
    populateWorkspaceSymbolReferences,
    queryWorkspaceSymbolIndex,
    rebuildWorkspaceSymbolReferences,
    removeFileFromSymbolIndex,
    type WorkspaceSymbolEntry,
} from '../../extension/indexing/workspaceSymbolParser';
import type { PdxDefinitionType } from '../../shared/pdxSemanticCatalog';

const definitionTypes: PdxDefinitionType[] = [
    { name: 'event', paths: ['events'], nameField: 'id', typeKeyFilters: ['country_event'] },
    { name: 'scripted_trigger', paths: ['common/scripted_triggers'], typeKeyFilters: [] },
    { name: 'scripted_effect', paths: ['common/scripted_effects'], typeKeyFilters: [] },
    { name: 'technology', paths: ['common/technology'], typeKeyFilters: [] },
    { name: 'special_project', paths: ['common/special_projects'], typeKeyFilters: [] },
    { name: 'event_chain', paths: ['common/event_chains'], typeKeyFilters: [] },
    { name: 'tradition', paths: ['common/traditions'], typeKeyFilters: [] },
    { name: 'section_template', paths: ['common/section_templates'], typeKeyFilters: [] },
    { name: 'particle', paths: ['gfx'], nameField: 'name', typeKeyFilters: ['pdxparticle'] },
    { name: 'light', paths: ['gfx/lights'], nameField: 'name', typeKeyFilters: ['light'] },
    { name: 'model_entity', paths: ['gfx'], nameField: 'name', typeKeyFilters: ['entity'] },
];

function parseScript(content: string, filePath: string, options: Parameters<typeof parseWorkspaceSymbols>[2] = {}) {
    return parseWorkspaceSymbols(content, filePath, { ...options, definitionTypes });
}

describe('Workspace Symbol Parser (indexing)', () => {
    it('parses name_field identities and namespaces from typed files', () => {
        const entries = parseScript([
            'namespace = samplemod',
            'country_event = {',
            '    id = samplemod.100',
            '    title = samplemod.100.title',
            '}',
        ].join('\n'), '/mod/events/samplemod_events.txt');

        expect(entries.map(entry => entry.name)).to.include('samplemod');
        const event = entries.find(entry => entry.name === 'samplemod.100');
        expect(event).to.deep.include({
            kind: 'event',
            line: 3,
            source: 'script',
            container: 'country_event',
            category: 'game_entity',
        });
    });

    it('infers common scripted trigger and technology symbols', () => {
        const trigger = parseScript('samplemod_is_force_user = {\n}', '/mod/common/scripted_triggers/samplemod.txt');
        const tech = parseScript('tech_samplemod_reactor = {\n}', '/mod/common/technology/samplemod.txt');

        expect(trigger[0]).to.deep.include({ name: 'samplemod_is_force_user', kind: 'scripted_trigger', category: 'game_entity' });
        expect(tech[0]).to.deep.include({ name: 'tech_samplemod_reactor', kind: 'technology', category: 'game_entity' });
    });

    it('infers additional common entity kinds', () => {
        const entries = [
            parseScript('samplemod_project = {\n}', '/mod/common/special_projects/samplemod.txt')[0],
            parseScript('samplemod_chain = {\n}', '/mod/common/event_chains/samplemod.txt')[0],
            parseScript('samplemod_tradition = {\n}', '/mod/common/traditions/samplemod.txt')[0],
            parseScript('SAMPLEMOD_SECTION = {\n}', '/mod/common/section_templates/samplemod.txt')[0],
        ];

        expect(entries.map(entry => entry?.kind)).to.deep.equal([
            'special_project',
            'event_chain',
            'tradition',
            'section_template',
        ]);
        for (const entry of entries) {
            expect(entry?.category).to.equal('game_entity');
        }
    });

    it('parses named sprite and sound assets', () => {
        const entries = parseScript([
            'spriteTypes = {',
            '    spriteType = {',
            '        name = "GFX_evt_samplemod_echo"',
            '        texturefile = "gfx/event_pictures/samplemod.dds"',
            '    }',
            '}',
            'sound = {',
            '    name = samplemod_force_echo',
            '}',
        ].join('\n'), '/mod/interface/samplemod.gfx');

        expect(entries.find(entry => entry.name === 'GFX_evt_samplemod_echo')).to.deep.include({
            kind: 'sprite',
            source: 'asset',
            container: 'spriteType',
            category: 'asset',
        });
        expect(entries.find(entry => entry.name === 'GFX_evt_samplemod_echo')?.references?.[0]?.context).to.include('texturefile');
        expect(entries.find(entry => entry.name === 'GFX_evt_samplemod_echo')?.references?.[0]).to.include({
            property: 'texturefile',
            target: 'gfx/event_pictures/samplemod.dds',
        });
        expect(entries.find(entry => entry.name === 'samplemod_force_echo')).to.deep.include({
            kind: 'sound',
            source: 'asset',
            container: 'sound',
            category: 'asset',
        });
    });

    it('parses inline named assets and classifies them from active TypeDefs', () => {
        const particle = parseScript([
            'pdxparticle = { name = "white_hole_particle" type = "black_hole_file" scale = 2.0 }',
            'entity = { name = "white_hole_entity" }',
        ].join('\n'), '/mod/gfx/models/ships/samplemod/samplemod_particles.gfx');
        const light = parseScript('light = { name = "samplemod_white_hole_light" intensity = 2.5 }', '/mod/gfx/lights/samplemod_lights.asset');
        const entity = parseScript('entity = { name = samplemod_white_hole_planet_01_entity pdxmesh = white_hole_new_mesh }', '/mod/gfx/models/planets/samplemod.asset');

        expect(particle.find(entry => entry.name === 'white_hole_particle')).to.deep.include({
            kind: 'particle',
            line: 1,
            source: 'asset',
            container: 'pdxparticle',
            category: 'asset',
        });
        expect(particle.some(entry => entry.name === 'white_hole_entity' && entry.kind === 'particle')).to.equal(false);
        expect(light.find(entry => entry.name === 'samplemod_white_hole_light')).to.deep.include({
            kind: 'light',
            line: 1,
            container: 'light',
        });
        expect(entity.find(entry => entry.name === 'samplemod_white_hole_planet_01_entity')).to.deep.include({
            kind: 'model_entity',
            line: 1,
            container: 'entity',
        });
    });

    it('attaches metadata and lightweight same-file references', () => {
        const entries = parseScript([
            'samplemod_effect = {',
            '    add_modifier = samplemod_effect',
            '}',
            'other_effect = {',
            '    samplemod_effect = yes',
            '}',
        ].join('\n'), '/mod/common/scripted_effects/samplemod.txt', {
            updatedAt: 1234,
            fileVersion: 2,
        });

        const effect = entries.find(entry => entry.name === 'samplemod_effect');
        expect(effect).to.deep.include({ updatedAt: 1234, fileVersion: 2 });
        expect(effect?.references?.map(ref => ref.line)).to.deep.equal([2, 5]);
    });

    it('queries indexed symbols by prefix, kind, source, and directory', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'samplemod.100', kind: 'event', category: 'event', source: 'script', file: '/mod/events/samplemod.txt', line: 1, references: [{ file: '/mod/events/samplemod.txt', line: 3, context: 'id = samplemod.100' }] },
            { name: 'tech_samplemod_reactor', kind: 'technology', category: 'game_entity', source: 'script', file: '/mod/common/technology/samplemod.txt', line: 2 },
            { name: 'GFX_evt_samplemod_echo', kind: 'sprite', category: 'asset', source: 'asset', origin: 'vanilla', file: '/mod/interface/samplemod.gfx', line: 3 },
        ]);

        expect(queryWorkspaceSymbolIndex(index, { name: 'samplemod', prefix: true })).to.have.lengthOf(1);
        expect(queryWorkspaceSymbolIndex(index, { name: 'samplemod.100', exact: true })[0]!.references).to.equal(undefined);
        expect(queryWorkspaceSymbolIndex(index, { name: 'samplemod.100', exact: true, includeReferences: true })[0]!.references).to.have.lengthOf(1);
        expect(queryWorkspaceSymbolIndex(index, { kind: 'sprite', source: 'asset' })[0]!.name).to.equal('GFX_evt_samplemod_echo');
        expect(queryWorkspaceSymbolIndex(index, { kind: 'sprite', source: 'asset', origin: 'workspace' })).to.have.lengthOf(0);
        expect(queryWorkspaceSymbolIndex(index, { kind: 'sprite', source: 'asset', origin: 'vanilla' })[0]!.name).to.equal('GFX_evt_samplemod_echo');
        expect(queryWorkspaceSymbolIndex(index, { category: 'game_entity' })[0]!.name).to.equal('tech_samplemod_reactor');
        expect(queryWorkspaceSymbolIndex(index, { directory: 'common/technology' })[0]!.name).to.equal('tech_samplemod_reactor');
    });

    it('uses lowercase keys for case-insensitive exact queries and sorted prefix ranges', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'Tech_SampleMod_Core', kind: 'technology', source: 'script', file: '/mod/common/technology/a.txt', line: 1 },
            { name: 'tech_samplemod_drive', kind: 'technology', source: 'script', file: '/mod/common/technology/b.txt', line: 1 },
            { name: 'unrelated', kind: 'technology', source: 'script', file: '/mod/common/technology/c.txt', line: 1 },
        ]);
        const sortedNames = Array.from(index.keys()).sort((a, b) => a.localeCompare(b));

        expect(queryWorkspaceSymbolIndex(index, { name: 'TECH_SAMPLEMOD_CORE', exact: true }, sortedNames)[0]?.name)
            .to.equal('Tech_SampleMod_Core');
        expect(queryWorkspaceSymbolIndex(index, { name: 'TECH_SAMPLEMOD_', prefix: true }, sortedNames).map(entry => entry.name))
            .to.deep.equal(['Tech_SampleMod_Core', 'tech_samplemod_drive']);
    });

    it('defers reference collection until matching files are supplied', () => {
        const entries = parseScript([
            'samplemod_effect = {',
            '    add_modifier = samplemod_effect',
            '}',
        ].join('\n'), '/mod/common/scripted_effects/samplemod.txt', { maxReferencesPerSymbol: 0 });
        expect(entries[0]?.references).to.equal(undefined);

        populateWorkspaceSymbolReferences(entries, new Map([
            ['/mod/events/samplemod.txt', 'country_event = {\n    immediate = { samplemod_effect = yes }\n}'],
        ]), 5);
        expect(entries[0]?.references?.map(reference => `${reference.file}:${reference.line}`))
            .to.deep.equal(['/mod/events/samplemod.txt:2']);
    });

    it('rebuilds bounded cross-file references for indexed content', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'samplemod_effect', kind: 'scripted_effect', source: 'script', file: '/mod/common/scripted_effects/samplemod.txt', line: 1 },
        ]);
        rebuildWorkspaceSymbolReferences(index, new Map([
            ['/mod/common/scripted_effects/samplemod.txt', 'samplemod_effect = {\n}\n'],
            ['/mod/events/samplemod.txt', 'country_event = {\n    immediate = { samplemod_effect = yes }\n}\n'],
        ]), 5);

        const entry = queryWorkspaceSymbolIndex(index, { name: 'samplemod_effect', exact: true, includeReferences: true })[0]!;
        expect(entry.references?.map(ref => `${ref.file}:${ref.line}`)).to.deep.equal(['/mod/events/samplemod.txt:2']);
    });

    it('caps large reference sets during rebuild', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'samplemod_effect', kind: 'scripted_effect', source: 'script', file: '/mod/common/scripted_effects/samplemod.txt', line: 1 },
        ]);
        const references = Array.from({ length: 500 }, () => 'samplemod_effect = yes').join('\n');
        rebuildWorkspaceSymbolReferences(index, new Map([
            ['/mod/common/scripted_effects/samplemod.txt', 'samplemod_effect = {\n}\n'],
            ['/mod/events/large.txt', references],
        ]), 25);

        const entry = queryWorkspaceSymbolIndex(index, { name: 'samplemod_effect', exact: true, includeReferences: true })[0]!;
        expect(entry.references).to.have.lengthOf(25);
    });

    it('removes stale symbols for a deleted file', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'samplemod.100', kind: 'event', source: 'script', file: '/mod/events/samplemod.txt', line: 1 },
            { name: 'samplemod.101', kind: 'event', source: 'script', file: '/mod/events/other.txt', line: 1 },
        ]);

        removeFileFromSymbolIndex(index, '/mod/events/samplemod.txt');

        expect(index.has('samplemod.100')).to.equal(false);
        expect(index.has('samplemod.101')).to.equal(true);
    });

    it('uses arbitrary active TypeDefs and does not infer a game kind without them', () => {
        const custom = parseWorkspaceSymbols('alpha = {\n    key = custom.1\n}', '/mod/common/ritual_definitions/a.txt', {
            definitionTypes: [{
                name: 'ritual_definition',
                paths: ['common/ritual_definitions'],
                nameField: 'key',
                typeKeyFilters: [],
            }],
        });
        expect(custom[0]).to.deep.include({
            name: 'custom.1',
            kind: 'ritual_definition',
            container: 'alpha',
            category: 'game_entity',
        });

        const fallback = parseWorkspaceSymbols('tech_alpha = {\n}', '/mod/common/technology/a.txt');
        expect(fallback[0]).to.deep.include({ kind: 'pdx_block', category: 'script' });
    });
});

describe('Workspace Symbol Parser (GUI recursion)', () => {
    it('indexes deeply nested named GUI controls', () => {
        const gui = [
            'containerType = {',
            '    name = "samplemod_root"',
            '    background = { name = "samplemod_bg" }',
            '    nested = {',
            '        name = "samplemod_inner"',
            '        deeper = { name = "samplemod_deepest" }',
            '    }',
            '}',
        ].join('\n');
        const entries = parseWorkspaceSymbols(gui, '/mod/interface/samplemod.gui', { definitionTypes: [] });
        const names = entries.map(entry => entry.name);
        expect(names).to.include('samplemod_root');
        expect(names).to.include('samplemod_inner');
        expect(names).to.include('samplemod_deepest');
    });

    it('preserves single-line nested effectButtonType name, effect and quadTextureSprite', () => {
        const gui = [
            'containerType = {',
            '    name = "samplemod_actions"',
            '    effectButtonType = { name = "samplemod_btn_1" effect = "samplemod_button_effect_1" quadTextureSprite = "GFX_samplemod_btn" }',
            '}',
        ].join('\n');
        const entries = parseWorkspaceSymbols(gui, '/mod/interface/samplemod.gui', { definitionTypes: [] });
        const button = entries.find(entry => entry.name === 'samplemod_btn_1');
        expect(button).to.not.equal(undefined);
        expect(button!.kind).to.equal('effectButtonType');
        expect(button!.references ?? []).to.satisfy((refs: Array<{ context: string }>) =>
            refs.some(ref => ref.context.includes('samplemod_button_effect_1'))
            && refs.some(ref => ref.context.includes('GFX_samplemod_btn')));
        expect(button!.references).to.deep.include({
            file: '/mod/interface/samplemod.gui', line: 3,
            context: 'effect = samplemod_button_effect_1', property: 'effect', target: 'samplemod_button_effect_1',
        });
        expect(button!.guiFacts?.spriteReferences).to.include('GFX_samplemod_btn');
    });

    it('does not treat field wrappers as named definitions', () => {
        const gui = [
            'containerType = {',
            '    name = "samplemod_root"',
            '    position = { x = 10 y = 20 }',
            '    format = { font = "medium" }',
            '}',
        ].join('\n');
        const entries = parseWorkspaceSymbols(gui, '/mod/interface/samplemod.gui', { definitionTypes: [] });
        expect(entries.map(entry => entry.name)).to.not.include('position');
        expect(entries.map(entry => entry.name)).to.not.include('format');
    });

    it('captures off-canvas, localisation, custom GUI, effect and sprite facts', () => {
        const gui = [
            'effectButtonType = {',
            '    name = "hidden_contract_button"',
            '    position = { x = -9999 y = -9999 }',
            '    text = "HIDDEN_CONTRACT_BUTTON"',
            '    tooltip = "HIDDEN_CONTRACT_BUTTON_TT"',
            '    custom_gui = "contract_window"',
            '    effect = "contract_button_effect"',
            '    sprite = "GFX_contract_button"',
            '}',
        ].join('\n');
        const entry = parseWorkspaceSymbols(gui, '/mod/interface/contract.gui', { definitionTypes: [] })
            .find(item => item.name === 'hidden_contract_button');
        expect(entry?.guiFacts?.offCanvas).to.equal(true);
        expect(entry?.guiFacts?.localisationKeys).to.include('HIDDEN_CONTRACT_BUTTON_TT');
        expect(entry?.guiFacts?.customGuiReferences).to.include('contract_window');
        expect(entry?.guiFacts?.effectReferences).to.include('contract_button_effect');
        expect(entry?.guiFacts?.spriteReferences).to.include('GFX_contract_button');
    });
});

describe('Workspace Symbol Parser (script flow facts)', () => {
    it('indexes state, event, scripted-call and localisation facts inside definitions', () => {
        const script = [
            'samplemod_button_effect = {',
            '    set_country_flag = samplemod_ready',
            '    custom_tooltip = SAMPLEMOD_READY_TT',
            '    carrier_event = { id = samplemod.200 }',
            '    samplemod_followup_effect = { }',
            '}',
        ].join('\n');
        const entry = parseWorkspaceSymbols(script, '/mod/common/button_effects/samplemod.txt')
            .find(item => item.name === 'samplemod_button_effect');

        expect(entry?.scriptFacts?.stateAccesses).to.deep.include({ operation: 'set', subject: 'samplemod_ready', scope: 'country', line: 2 });
        expect(entry?.scriptFacts?.localisationKeys).to.include('SAMPLEMOD_READY_TT');
        expect(entry?.scriptFacts?.eventReferences).to.include('samplemod.200');
        expect(entry?.scriptFacts?.callCandidates).to.include('samplemod_followup_effect');
    });
});
