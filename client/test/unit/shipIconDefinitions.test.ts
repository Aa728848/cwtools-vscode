import { expect } from 'chai';
import {
    loadShipIconCatalog,
    pickSectionForSlot,
    resolveShipIcons,
    type ResolvedShipIcon,
    type ShipIconCatalog,
    type ShipIconDataSource,
    type ShipIconResolveOptions,
    type ShipSizeInfo,
} from '../../extension/shipIcon/shipIconDefinitions';

// ── In-memory data source ────────────────────────────────────────────────────

type ListingMode = 'nested' | 'nested-reversed' | 'flat';

class MemorySource implements ShipIconDataSource {
    private readonly files = new Map<string, string>();
    private readonly directories = new Set<string>();
    private readonly mode: ListingMode;

    constructor(files: Record<string, string>, mode: ListingMode = 'nested') {
        this.mode = mode;
        for (const [path, content] of Object.entries(files)) {
            this.files.set(path, content);
            const segments = path.split('/');
            for (let i = 1; i < segments.length; i++) {
                this.directories.add(segments.slice(0, i).join('/'));
            }
        }
    }

    async readText(relativePath: string): Promise<string | undefined> {
        return this.files.get(relativePath);
    }

    async listFiles(relativeDirectory: string): Promise<string[]> {
        const prefix = relativeDirectory.endsWith('/') ? relativeDirectory : `${relativeDirectory}/`;
        if (this.mode === 'flat') {
            return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
        }
        const direct: string[] = [];
        const seen = new Set<string>();
        for (const path of [...this.files.keys(), ...this.directories]) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length);
            if (rest === '' || rest.includes('/')) continue;
            if (seen.has(path)) continue;
            seen.add(path);
            direct.push(path);
        }
        direct.sort();
        return this.mode === 'nested-reversed' ? direct.reverse() : direct;
    }
}

class ThrowingSource implements ShipIconDataSource {
    async readText(): Promise<string | undefined> {
        throw new Error('no data');
    }

    async listFiles(): Promise<string[]> {
        throw new Error('no data');
    }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES: Record<string, string> = {
    'common/ship_sizes/00_ship_sizes.txt': [
        '# Top-level key form.',
        'corvette = {',
        '\ticon = ship_size_military_1',
        '\tsection_slots = {',
        '\t\t"mid" = { locator = "part1" }',
        '\t\t"bow" = { locator = "part2" }',
        '\t}',
        '}',
        '',
        '# ship_size wrapper form.',
        'ship_size = {',
        '\tname = destroyer',
        '\ticon = ship_size_military_2',
        '\tclass = shipclass_military',
        '\tsection_slots = { "mid" = { locator = "part1" } }',
        '}',
        '',
        'frigate = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgraphical_culture = { "humanoid_01" "molluscoid_01" }',
        '}',
        '',
        'escort = {',
        '\ticon = ship_size_military_2',
        '\tentity = escort_frame_entity',
        '}',
        '',
        'ghost = {',
        '\ticon = ship_size_military_3',
        '\tentity = ghost_entity',
        '}',
        '',
        'phantom = {',
        '\ticon = ship_size_military_3',
        '\tentity = phantom_entity',
        '}',
        '',
        '# Has markers but no icon: not a ship size.',
        'not_a_ship_size = {',
        '\tclass = shipclass_military',
        '\tis_space_station = yes',
        '}',
        '',
        '# Has an icon but no marker: not a ship size.',
        'icon_without_markers = {',
        '\ticon = ship_size_military_1',
        '}',
    ].join('\n'),

    'common/section_templates/ancient.txt': [
        'ship_section_template = {',
        '\tkey = "DESTROYER_MID_ANCIENT"',
        '\tship_size = destroyer',
        '\tfits_on_slot = mid',
        '\tentity = "ancient_destroyer_mid_entity"',
        '}',
    ].join('\n'),

    'common/section_templates/corvette.txt': [
        'ship_section_template = {',
        '\tkey = "CORVETTE_MID_A"',
        '\tship_size = corvette',
        '\tfits_on_slot = mid',
        '\tshould_draw_components = yes',
        '\tentity = "corvette_M1S1_entity"',
        '\tai_tags = { screen explosive }',
        '}',
        '',
        'ship_section_template = {',
        '\tkey = "CORVETTE_MID_B"',
        '\tship_size = corvette',
        '\tfits_on_slot = mid',
        '\tentity = "corvette_S3_entity"',
        '}',
        '',
        'ship_section_template = {',
        '\tkey = "CORVETTE_BOW_A"',
        '\tship_size = corvette',
        '\tfits_on_slot = bow',
        '\tentity = "corvette_bow_entity"',
        '}',
        '',
        '# Repeats ship_size: registered under destroyer and corvette.',
        'ship_section_template = {',
        '\tkey = "DESTROYER_MID_A"',
        '\tship_size = destroyer',
        '\tship_size = corvette',
        '\tfits_on_slot = mid',
        '\tentity = "destroyer_mid_entity"',
        '}',
        '',
        '# No entity: unusable, reported as a warning.',
        'ship_section_template = {',
        '\tkey = "BROKEN_NO_ENTITY"',
        '\tship_size = corvette',
        '\tfits_on_slot = mid',
        '}',
    ].join('\n'),

    'gfx/models/ships/_ships.asset': [
        'entity = { name = "corvette_M1S1_entity" pdxmesh = "corvette_frame_mesh" }',
        'entity = { name = "corvette_S3_entity" pdxmesh = "corvette_S3_mesh" }',
        'entity = { name = "corvette_bow_entity" pdxmesh = "corvette_bow_mesh" }',
        'entity = { name = "destroyer_mid_entity" pdxmesh = "destroyer_frame_mesh" }',
        'entity = { name = "ancient_destroyer_mid_entity" pdxmesh = "ancient_destroyer_mesh" }',
        'entity = { name = "corvette_frame_entity" pdxmesh = "corvette_frame_mesh" }',
        'entity = { name = "escort_frame_entity" pdxmesh = "escort_frame_mesh" }',
        'entity = { name = "ghost_entity" scale = 1 }',
        'entity = { name = "phantom_entity" pdxmesh = "phantom_mesh" }',
    ].join('\n'),

    'gfx/models/ships/humanoid_01/_humanoid_01_ships.asset': [
        'entity = { name = "humanoid_01_corvette_frame_entity" pdxmesh = "humanoid_corvette_frame_mesh" }',
    ].join('\n'),

    'gfx/models/ships/molluscoid_01/_molluscoid_01_ships.asset': [
        'entity = { name = "molluscoid_01_other_entity" pdxmesh = "molluscoid_corvette_frame_mesh" }',
    ].join('\n'),

    'gfx/models/ships/corvette_ships.gfx': [
        'pdxmesh = { name = "corvette_frame_mesh" file = "gfx/models/ships/corvette_frame.mesh" }',
        'pdxmesh = { name = "corvette_S3_mesh" file = "gfx/models/ships/corvette_S3.mesh" }',
        'pdxmesh = { name = "corvette_bow_mesh" file = "gfx/models/ships/corvette_bow.mesh" }',
        'pdxmesh = { name = "destroyer_frame_mesh" file = "gfx/models/ships/destroyer_frame.mesh" }',
        'pdxmesh = { name = "ancient_destroyer_mesh" file = "gfx/models/ships/ancient_destroyer.mesh" }',
        'pdxmesh = { name = "escort_frame_mesh" file = "gfx/models/ships/escort_frame.mesh" }',
        'pdxmesh = { name = "humanoid_corvette_frame_mesh" file = "gfx/models/ships/humanoid_01/corvette_frame.mesh" }',
        'pdxmesh = { name = "molluscoid_corvette_frame_mesh" file = "gfx/models/ships/molluscoid_01/corvette_frame.mesh" }',
    ].join('\n'),

    // Sprite defined under gfx/ rather than interface/: it is missing default_frame.
    'gfx/models/ships/sprites.gfx': [
        'spriteType = {',
        '\tname = "GFX_ship_size_military_3_top"',
        '\tsprite_sheet_sprite_type = "GFX_ship_sizes_top"',
        '}',
    ].join('\n'),

    // Vanilla wraps its icon sprites in a `spriteTypes = { ... }` container.
    'interface/icons.gfx': [
        'spriteTypes = {',
        '\tspriteType = {',
        '\tname = "GFX_ship_sizes_top"',
        '\ttextureFile = "gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds"',
        '\tnoOfFrames = 34',
        '}',
        'spriteType = {',
        '\tname = "GFX_ship_sizes_top_damaged"',
        '\ttextureFile = "gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top_damaged.dds"',
        '\tnoOfFrames = 34',
        '}',
        'spriteType = {',
        '\tname = "GFX_ship_size_military_1_top"',
        '\tsprite_sheet_sprite_type = "GFX_ship_sizes_top"',
        '\tdefault_frame = 3',
        '}',
        'spriteType = {',
        '\tname = "GFX_ship_size_military_1_top_damaged"',
        '\tsprite_sheet_sprite_type = "GFX_ship_sizes_top_damaged"',
        '\tdefault_frame = 5',
        '}',
        'spriteType = {',
        '\tname = "GFX_ship_size_military_2_top"',
        '\tsprite_sheet_sprite_type = "GFX_ship_sizes_top"',
        '\tdefault_frame = 7',
        '}',
        '}',
    ].join('\n'),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sizeInfo(catalog: ShipIconCatalog, name: string): ShipSizeInfo {
    const info = catalog.shipSizes.get(name);
    if (info === undefined) throw new Error(`fixture is missing ship size '${name}'`);
    return info;
}

function sectionKeys(catalog: ShipIconCatalog, name: string): string[] {
    const sections = catalog.sectionsByShipSize.get(name);
    return sections === undefined ? [] : sections.map((section) => section.key);
}

function named(result: readonly ResolvedShipIcon[], shipSize: string): ResolvedShipIcon {
    const found = result.find((entry) => entry.shipSize === shipSize);
    if (found === undefined) throw new Error(`fixture is missing resolved icon '${shipSize}'`);
    return found;
}

function options(overrides?: Record<string, string>, damaged?: boolean): ShipIconResolveOptions {
    return {
        graphicalCulture: 'humanoid_01',
        shipSizes: ['corvette', 'destroyer', 'frigate', 'escort', 'ghost', 'phantom'],
        sectionOverrides: overrides,
        damaged,
    };
}

function snapshot(catalog: ShipIconCatalog): string {
    return JSON.stringify({
        sizes: [...catalog.shipSizes.entries()],
        sections: [...catalog.sectionsByShipSize.entries()],
        entities: [...catalog.entityToPdxMesh.entries()],
        meshes: [...catalog.pdxMeshToFile.entries()],
        frames: [...catalog.spriteFrameByIcon.entries()],
        sheetFrames: [...catalog.spriteSheetFrames.entries()],
        iconSheets: [...catalog.spriteIconSheet.entries()],
        cultures: catalog.graphicalCultures,
        warnings: catalog.warnings,
        resolved: resolveShipIcons(catalog, options()),
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ship icon definitions', () => {
    it('parses both ship_size forms, slot order and graphical culture lists', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        expect([...catalog.shipSizes.keys()]).to.deep.equal([
            'corvette', 'destroyer', 'frigate', 'escort', 'ghost', 'phantom',
        ]);
        expect(sizeInfo(catalog, 'corvette').icon).to.equal('ship_size_military_1');
        expect(sizeInfo(catalog, 'corvette').sectionSlots).to.deep.equal([
            { slot: 'mid', locator: 'part1' },
            { slot: 'bow', locator: 'part2' },
        ]);
        expect(sizeInfo(catalog, 'destroyer').icon).to.equal('ship_size_military_2');
        expect(sizeInfo(catalog, 'destroyer').sectionSlots).to.deep.equal([{ slot: 'mid', locator: 'part1' }]);
        expect(sizeInfo(catalog, 'frigate').entity).to.equal('corvette_frame_entity');
        expect(sizeInfo(catalog, 'frigate').graphicalCultures).to.deep.equal(['humanoid_01', 'molluscoid_01']);
        expect(sizeInfo(catalog, 'corvette').graphicalCultures).to.deep.equal([]);
    });

    it('parses section templates in path then definition order', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        // ancient.txt sorts before corvette.txt, so its destroyer candidate comes first.
        expect(sectionKeys(catalog, 'destroyer')).to.deep.equal(['DESTROYER_MID_ANCIENT', 'DESTROYER_MID_A']);
        // The repeated ship_size registers the template under corvette too, after the local ones.
        expect(sectionKeys(catalog, 'corvette')).to.deep.equal([
            'CORVETTE_MID_A', 'CORVETTE_MID_B', 'CORVETTE_BOW_A', 'DESTROYER_MID_A',
        ]);
        // The template without an entity is unusable and only produces a warning.
        expect(catalog.warnings).to.have.length(1);
        expect(catalog.warnings[0]).to.contain('missing one of');
        expect(catalog.warnings[0]).to.contain('corvette.txt');
    });

    it('joins entities, pdxmesh files and sprite frames', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        expect(catalog.graphicalCultures).to.deep.equal(['humanoid_01', 'molluscoid_01']);
        expect(catalog.entityToPdxMesh.size).to.equal(11);
        expect(catalog.entityToPdxMesh.get('ghost_entity')).to.equal(undefined);
        expect(catalog.entityToPdxMesh.get('corvette_S3_entity')).to.equal('corvette_S3_mesh');
        expect(catalog.pdxMeshToFile.size).to.equal(8);
        expect(catalog.pdxMeshToFile.get('humanoid_corvette_frame_mesh'))
            .to.equal('gfx/models/ships/humanoid_01/corvette_frame.mesh');
        expect([...catalog.spriteFrameByIcon.entries()]).to.deep.equal([
            ['GFX_ship_size_military_1_top', 3],
            ['GFX_ship_size_military_1_top_damaged', 5],
            ['GFX_ship_size_military_2_top', 7],
        ]);
        expect([...catalog.spriteSheetFrames.entries()]).to.deep.equal([
            ['GFX_ship_sizes_top', 34],
            ['GFX_ship_sizes_top_damaged', 34],
        ]);
        expect(catalog.spriteIconSheet.get('GFX_ship_size_military_3_top')).to.equal('GFX_ship_sizes_top');
    });

    it('picks the first section candidate and resolves frames and meshes', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const result = resolveShipIcons(catalog, options());

        expect(result.map((entry) => entry.shipSize))
            .to.deep.equal(['corvette', 'destroyer', 'frigate', 'escort', 'ghost', 'phantom']);

        const corvette = named(result, 'corvette');
        expect(corvette.frame).to.equal(3);
        expect(corvette.sheetFrames).to.equal(34);
        expect(corvette.meshFiles).to.deep.equal([
            'gfx/models/ships/corvette_frame.mesh',
            'gfx/models/ships/corvette_bow.mesh',
        ]);
        expect(corvette.warnings).to.deep.equal([]);

        const destroyer = named(result, 'destroyer');
        expect(destroyer.frame).to.equal(7);
        expect(destroyer.sheetFrames).to.equal(34);
        expect(destroyer.meshFiles).to.deep.equal(['gfx/models/ships/ancient_destroyer.mesh']);
    });

    it('honours section overrides and falls back with a warning for unknown keys', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const overridden = named(resolveShipIcons(catalog, options({ 'corvette:mid': 'CORVETTE_MID_B' })), 'corvette');

        expect(overridden.meshFiles).to.deep.equal([
            'gfx/models/ships/corvette_S3.mesh',
            'gfx/models/ships/corvette_bow.mesh',
        ]);
        expect(overridden.warnings).to.deep.equal([]);

        const fallback = named(resolveShipIcons(catalog, options({ 'corvette:mid': 'NO_SUCH_KEY' })), 'corvette');
        expect(fallback.meshFiles).to.deep.equal([
            'gfx/models/ships/corvette_frame.mesh',
            'gfx/models/ships/corvette_bow.mesh',
        ]);
        expect(fallback.warnings).to.have.length(1);
        expect(fallback.warnings[0]).to.contain("section override 'NO_SUCH_KEY'");
        expect(fallback.warnings[0]).to.contain('falling back to the first candidate');
    });

    it('does not resolve an unknown override through pickSectionForSlot', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const sections = catalog.sectionsByShipSize.get('corvette') ?? [];

        expect(pickSectionForSlot(sections, 'mid')).to.equal(sections[0]);
        expect(pickSectionForSlot(sections, 'mid', 'CORVETTE_MID_B')).to.equal(sections[1]);
        expect(pickSectionForSlot(sections, 'mid', 'NO_SUCH_KEY')).to.equal(undefined);
        expect(pickSectionForSlot(sections, 'stern')).to.equal(undefined);
    });

    it('walks the culture prefix for single-entity ships and falls back to the bare name', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const result = resolveShipIcons(catalog, options());

        const frigate = named(result, 'frigate');
        expect(frigate.meshFiles).to.deep.equal(['gfx/models/ships/humanoid_01/corvette_frame.mesh']);
        expect(frigate.warnings).to.deep.equal([]);

        // No humanoid_01_escort_frame_entity: the unprefixed entity is used instead.
        const escort = named(result, 'escort');
        expect(escort.meshFiles).to.deep.equal(['gfx/models/ships/escort_frame.mesh']);
        expect(escort.warnings).to.deep.equal([]);
    });

    it('warns about a missing pdxmesh, a missing mesh file and a missing default_frame', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const result = resolveShipIcons(catalog, options());

        const ghost = named(result, 'ghost');
        expect(ghost.meshFiles).to.deep.equal([]);
        expect(ghost.warnings.some((warning) => warning.includes("entity 'ghost_entity'") && warning.includes('no pdxmesh'))).to.equal(true);
        expect(ghost.warnings.some((warning) => warning.includes('GFX_ship_size_military_3_top') && warning.includes('no default_frame'))).to.equal(true);
        // The sheet still resolves even though default_frame is missing.
        expect(ghost.frame).to.equal(0);
        expect(ghost.sheetFrames).to.equal(34);

        const phantom = named(result, 'phantom');
        expect(phantom.meshFiles).to.deep.equal([]);
        expect(phantom.warnings.some((warning) => warning.includes("pdxmesh 'phantom_mesh'") && warning.includes('no mesh file'))).to.equal(true);
    });

    it('falls back from a damaged sprite to the undamaged one with a warning', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const result = resolveShipIcons(catalog, options(undefined, true));

        const corvette = named(result, 'corvette');
        expect(corvette.frame).to.equal(5);
        expect(corvette.sheetFrames).to.equal(34);
        expect(corvette.warnings).to.deep.equal([]);

        const destroyer = named(result, 'destroyer');
        expect(destroyer.frame).to.equal(7);
        expect(destroyer.warnings).to.have.length(1);
        expect(destroyer.warnings[0]).to.contain('GFX_ship_size_military_2_top_damaged');
        expect(destroyer.warnings[0]).to.contain('falling back to');
    });

    it('warns when the ship size is unknown and keeps one result per request', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const result = resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette', 'corvette', 'nope'],
        });

        expect(result.map((entry) => entry.shipSize)).to.deep.equal(['corvette', 'corvette', 'nope']);
        expect(result[0]?.meshFiles).to.deep.equal(result[1]?.meshFiles);
        expect(result[2]?.frame).to.equal(0);
        expect(result[2]?.warnings[0]).to.contain("ship size 'nope' is not defined");
    });

    it('keeps the catalog stable across listing orders', async () => {
        const nested = await loadShipIconCatalog(new MemorySource(FIXTURES, 'nested'));
        const reversed = await loadShipIconCatalog(new MemorySource(FIXTURES, 'nested-reversed'));
        const flat = await loadShipIconCatalog(new MemorySource(FIXTURES, 'flat'));

        const expected = snapshot(nested);
        expect(snapshot(reversed)).to.equal(expected);
        expect(snapshot(flat)).to.equal(expected);
    });

    it('tolerates truncated and empty files without throwing', async () => {
        const broken: Record<string, string> = {
            'common/ship_sizes/broken.txt': 'corvette = {\n\ticon = x\n\tsection_slots = {\n\t\t"mid" = { locator = ',
            'common/ship_sizes/empty.txt': '',
            'common/section_templates/broken.txt': 'ship_section_template = { key = "A" ship_size = corvette',
            'gfx/models/ships/broken.asset': 'entity = { name = "a" pdxmesh',
            'gfx/models/ships/broken.gfx': 'pdxmesh = { name = "m" file',
            'gfx/models/ships/empty.asset': '',
            'interface/icons.gfx': 'spriteType = { name = "GFX_x_top" default_frame =',
        };
        const catalog = await loadShipIconCatalog(new MemorySource(broken));

        expect(catalog.shipSizes.has('corvette')).to.equal(true);
        expect(sizeInfo(catalog, 'corvette').sectionSlots).to.deep.equal([]);
        const resolved = resolveShipIcons(catalog, { graphicalCulture: 'humanoid_01', shipSizes: ['corvette'] });
        expect(named(resolved, 'corvette').frame).to.equal(0);
        expect(named(resolved, 'corvette').meshFiles).to.deep.equal([]);
        expect(named(resolved, 'corvette').warnings.length).to.be.greaterThan(0);
    });

    it('tolerates a data source that throws', async () => {
        const catalog = await loadShipIconCatalog(new ThrowingSource());

        expect(catalog.shipSizes.size).to.equal(0);
        expect(catalog.graphicalCultures).to.deep.equal([]);
        expect(resolveShipIcons(catalog, { graphicalCulture: 'humanoid_01', shipSizes: ['corvette'] })).to.deep.equal([{
            shipSize: 'corvette',
            frame: 0,
            sheetFrames: 0,
            meshFiles: [],
            warnings: ["ship size 'corvette' is not defined"],
        }]);
    });
});

// ── Fixtures for culture flags, universal sections and manual overrides ──────

const CULTURE_FLAG_FIXTURES: Record<string, string> = {
    ...FIXTURES,
    'common/ship_sizes/50_culture_flags.txt': [
        '# Vanilla writes this in 148 ship sizes to mean "any culture".',
        'no_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgraphical_culture = no',
        '}',
        '',
        'yes_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgraphical_culture = yes',
        '}',
        '',
        '# A bare word inside a real list is dropped, the real culture survives.',
        'mixed_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgraphical_culture = { no "molluscoid_01" }',
        '}',
        '',
        'listed_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgraphical_culture = { "biogenesis_01" "biogenesis_02" }',
        '}',
        '',
        'gfx_no_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgfx_culture = no',
        '}',
        '',
        'gfx_list_culture = {',
        '\ticon = ship_size_military_1',
        '\tentity = corvette_frame_entity',
        '\tgfx_culture = { "biogenesis_01" "biogenesis_02" }',
        '}',
    ].join('\n'),
};

const UNIVERSAL_SECTION_FIXTURES: Record<string, string> = {
    ...FIXTURES,
    // Sorted after 00_ship_sizes.txt, before corvette.txt: file order must not
    // decide where the universal candidate lands.
    'common/section_templates/aaa_universal.txt': [
        'ship_section_template = {',
        '\tkey = "UNIVERSAL_MID"',
        '\tfits_on_slot = mid',
        '\tentity = "universal_entity"',
        '\tcompatible_with_all_ship_sizes = yes',
        '}',
        '',
        '# Not compatible with every size and has no ship_size: unusable.',
        'ship_section_template = {',
        '\tkey = "BROKEN_NO_SIZE"',
        '\tfits_on_slot = mid',
        '\tentity = "universal_entity"',
        '}',
        '',
        '# Compatible with every size but has no entity: unusable.',
        'ship_section_template = {',
        '\tkey = "BROKEN_UNIVERSAL_NO_ENTITY"',
        '\tfits_on_slot = mid',
        '\tcompatible_with_all_ship_sizes = yes',
        '}',
    ].join('\n'),

    // A size that no template names, so only the universal one can serve it.
    'common/ship_sizes/60_orphan.txt': [
        'orphan = {',
        '\ticon = ship_size_military_2',
        '\tsection_slots = { "mid" = { locator = "part1" } }',
        '}',
    ].join('\n'),

    'gfx/models/ships/_universal.asset': [
        'entity = { name = "universal_entity" pdxmesh = "universal_mesh" }',
    ].join('\n'),

    'gfx/models/ships/universal.gfx': [
        'pdxmesh = { name = "universal_mesh" file = "gfx/models/ships/universal_section.mesh" }',
    ].join('\n'),
};

const UPPERCASE_SIZE_FIXTURES: Record<string, string> = {
    'common/ship_sizes/00_uppercase.txt': [
        'corvette = {',
        '\ticon = ship_size_military_1',
        '\tsection_slots = { "mid" = { locator = "part1" } }',
        '}',
    ].join('\n'),

    'common/section_templates/aaa_universal.txt': [
        'ship_section_template = {',
        '\tkey = "UNIVERSAL_MID"',
        '\tfits_on_slot = mid',
        '\tentity = "universal_entity"',
        '\tcompatible_with_all_ship_sizes = yes',
        '}',
    ].join('\n'),

    // Spells ship_size in another case than the ship size block above.
    'common/section_templates/aab_upper.txt': [
        'ship_section_template = {',
        '\tkey = "CORVETTE_MID_UPPER"',
        '\tship_size = CORVETTE',
        '\tfits_on_slot = mid',
        '\tentity = "uppercase_corvette_entity"',
        '}',
    ].join('\n'),

    'gfx/models/ships/_uppercase.asset': [
        'entity = { name = "uppercase_corvette_entity" pdxmesh = "uppercase_corvette_mesh" }',
        'entity = { name = "universal_entity" pdxmesh = "universal_mesh" }',
    ].join('\n'),

    'gfx/models/ships/uppercase.gfx': [
        'pdxmesh = { name = "uppercase_corvette_mesh" file = "gfx/models/ships/uppercase_corvette.mesh" }',
        'pdxmesh = { name = "universal_mesh" file = "gfx/models/ships/universal_section.mesh" }',
    ].join('\n'),

    'interface/icons.gfx': [
        'spriteType = { name = "GFX_ship_sizes_top" noOfFrames = 34 }',
        'spriteType = { name = "GFX_ship_size_military_1_top" sprite_sheet_sprite_type = "GFX_ship_sizes_top" default_frame = 3 }',
    ].join('\n'),
};

function overrideOptions(
    overrides: Record<string, readonly string[]>,
    shipSizes: readonly string[] = ['corvette', 'destroyer'],
): ShipIconResolveOptions {
    return { graphicalCulture: 'humanoid_01', shipSizes, overrides };
}

function snapshotSections(catalog: ShipIconCatalog): string {
    return JSON.stringify({
        sections: [...catalog.sectionsByShipSize.entries()],
        resolved: resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette', 'orphan', 'destroyer', 'frigate'],
            overrides: {
                corvette: ['./gfx/models/ships/manual/x.mesh', 'corvette_frame_entity'],
                orphan: ['universal_entity'],
            },
        }),
    });
}

describe('ship icon definitions: culture flags, ship class, universal sections, manual overrides', () => {
    it('treats a bare graphical_culture / gfx_culture word as "any culture" and keeps real lists', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(CULTURE_FLAG_FIXTURES));

        expect(sizeInfo(catalog, 'no_culture').graphicalCultures).to.deep.equal([]);
        expect(sizeInfo(catalog, 'yes_culture').graphicalCultures).to.deep.equal([]);
        expect(sizeInfo(catalog, 'gfx_no_culture').graphicalCultures).to.deep.equal([]);
        // A bare word inside a list is dropped; the real culture names survive.
        expect(sizeInfo(catalog, 'mixed_culture').graphicalCultures).to.deep.equal(['molluscoid_01']);
        expect(sizeInfo(catalog, 'listed_culture').graphicalCultures).to.deep.equal(['biogenesis_01', 'biogenesis_02']);
        expect(sizeInfo(catalog, 'gfx_list_culture').graphicalCultures).to.deep.equal(['biogenesis_01', 'biogenesis_02']);
    });

    it('no longer rejects "no"-flagged sizes and still rejects other-culture sizes', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(CULTURE_FLAG_FIXTURES));
        const result = resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['no_culture', 'yes_culture', 'gfx_no_culture', 'mixed_culture', 'listed_culture'],
        });

        for (const shipSize of ['no_culture', 'yes_culture', 'gfx_no_culture']) {
            const entry = named(result, shipSize);
            expect(entry.warnings).to.deep.equal([]);
            expect(entry.meshFiles).to.deep.equal(['gfx/models/ships/humanoid_01/corvette_frame.mesh']);
        }

        const restricted = named(result, 'listed_culture');
        expect(restricted.warnings).to.have.length(1);
        expect(restricted.warnings[0]).to.contain('restricted to graphical cultures [biogenesis_01, biogenesis_02]');
    });

    it('exposes ship_size class as shipClass and leaves it undefined when missing', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        expect(sizeInfo(catalog, 'destroyer').shipClass).to.equal('shipclass_military');
        expect(sizeInfo(catalog, 'corvette').shipClass).to.equal(undefined);
        expect(sizeInfo(catalog, 'escort').shipClass).to.equal(undefined);
    });

    it('registers compatible_with_all_ship_sizes templates for every size, after the size-specific ones', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(UNIVERSAL_SECTION_FIXTURES));

        // aaa_universal.txt sorts first, yet the universal candidate is still last.
        expect(sectionKeys(catalog, 'corvette')).to.deep.equal([
            'CORVETTE_MID_A', 'CORVETTE_MID_B', 'CORVETTE_BOW_A', 'DESTROYER_MID_A', 'UNIVERSAL_MID',
        ]);
        const candidates = catalog.sectionsByShipSize.get('corvette') ?? [];
        expect(candidates[candidates.length - 1]?.shipSize).to.equal('');
        // A size no template names is registered too, from the universal one alone.
        expect(sectionKeys(catalog, 'orphan')).to.deep.equal(['UNIVERSAL_MID']);
        // No phantom '' key: universal templates never become a ship size of their own.
        expect(catalog.sectionsByShipSize.has('')).to.equal(false);
        // The three unusable templates still warn; the usable universal one does not.
        const templateWarnings = catalog.warnings.filter((warning) => warning.includes('missing one of'));
        expect(templateWarnings).to.have.length(3);
        expect(templateWarnings.some((warning) => warning.includes('BROKEN'))).to.equal(false);
        expect(templateWarnings.some((warning) => warning.includes("missing one of key/ship_size"))).to.equal(true);
    });

    it('resolves a size through a universal template without changing the default pick', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(UNIVERSAL_SECTION_FIXTURES));
        const result = resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette', 'orphan', 'destroyer'],
        });

        const corvette = named(result, 'corvette');
        expect(corvette.meshFiles).to.deep.equal([
            'gfx/models/ships/corvette_frame.mesh',
            'gfx/models/ships/corvette_bow.mesh',
        ]);
        expect(corvette.warnings).to.deep.equal([]);

        const orphan = named(result, 'orphan');
        expect(orphan.meshFiles).to.deep.equal(['gfx/models/ships/universal_section.mesh']);
        expect(orphan.frame).to.equal(7);
        expect(orphan.warnings).to.deep.equal([]);
    });

    it('replaces the section lookup with manual override entries and keeps the frame', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const corvette = named(resolveShipIcons(catalog, overrideOptions({ corvette: ['corvette_frame_entity'] })), 'corvette');

        // One entry, one mesh: section_slots and the bow slot are not consulted.
        expect(corvette.meshFiles).to.deep.equal(['gfx/models/ships/humanoid_01/corvette_frame.mesh']);
        expect(corvette.frame).to.equal(3);
        expect(corvette.sheetFrames).to.equal(34);
        expect(corvette.warnings).to.deep.equal([]);

        // The bare entity name is used when the culture-prefixed one is missing.
        const bare = named(resolveShipIcons(catalog, overrideOptions({ corvette: ['escort_frame_entity'] })), 'corvette');
        expect(bare.meshFiles).to.deep.equal(['gfx/models/ships/escort_frame.mesh']);
        expect(bare.warnings).to.deep.equal([]);
    });

    it('accepts .mesh paths with backslashes, a leading ./ and mixed entry order', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const mixed = named(resolveShipIcons(catalog, overrideOptions({
            corvette: [
                'gfx\\models\\ships\\manual\\first.mesh',
                'corvette_frame_entity',
                './gfx/models/ships/manual/Last.MESH',
            ],
        })), 'corvette');

        expect(mixed.meshFiles).to.deep.equal([
            'gfx/models/ships/manual/first.mesh',
            'gfx/models/ships/humanoid_01/corvette_frame.mesh',
            'gfx/models/ships/manual/Last.MESH',
        ]);
        expect(mixed.warnings).to.deep.equal([]);
    });

    it('warns and skips override entries that resolve to nothing', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        const unknown = named(resolveShipIcons(catalog, overrideOptions({ corvette: ['nope_entity'] })), 'corvette');
        expect(unknown.meshFiles).to.deep.equal([]);
        expect(unknown.warnings).to.have.length(1);
        expect(unknown.warnings[0]).to.contain("entity 'nope_entity'");
        expect(unknown.warnings[0]).to.contain('override');

        const noMesh = named(resolveShipIcons(catalog, overrideOptions({ corvette: ['ghost_entity'] })), 'corvette');
        expect(noMesh.meshFiles).to.deep.equal([]);
        expect(noMesh.warnings.some((warning) => warning.includes("entity 'ghost_entity'") && warning.includes('no pdxmesh'))).to.equal(true);

        const noFile = named(resolveShipIcons(catalog, overrideOptions({ corvette: ['phantom_entity'] })), 'corvette');
        expect(noFile.meshFiles).to.deep.equal([]);
        expect(noFile.warnings.some((warning) => warning.includes("pdxmesh 'phantom_mesh'") && warning.includes('no mesh file'))).to.equal(true);
    });

    it('ignores empty, escaping and non-string override entries with a warning', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));
        const raw = { corvette: ['', '../escape.mesh', 42] } as unknown as Record<string, readonly string[]>;
        const result = named(resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette'],
            overrides: raw,
        }), 'corvette');

        expect(result.meshFiles).to.deep.equal([]);
        expect(result.warnings).to.have.length(3);
        expect(result.warnings.some((warning) => warning.includes('is empty'))).to.equal(true);
        expect(result.warnings.some((warning) => warning.includes('is not a usable path') && warning.includes('../escape.mesh'))).to.equal(true);
        expect(result.warnings.some((warning) => warning.includes('is not a string'))).to.equal(true);
    });

    it('falls back to section resolution for an empty or non-list override', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(FIXTURES));

        const empty = named(resolveShipIcons(catalog, overrideOptions({ corvette: [] })), 'corvette');
        expect(empty.meshFiles).to.deep.equal([
            'gfx/models/ships/corvette_frame.mesh',
            'gfx/models/ships/corvette_bow.mesh',
        ]);
        expect(empty.warnings).to.deep.equal([]);

        const notList = named(resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette'],
            overrides: { corvette: 'oops' } as unknown as Record<string, readonly string[]>,
        }), 'corvette');
        expect(notList.meshFiles).to.have.length(2);
        expect(notList.warnings).to.have.length(1);
        expect(notList.warnings[0]).to.contain('is not a list');
    });

    it('appends universal candidates to an existing case-different key instead of shadowing it', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(UPPERCASE_SIZE_FIXTURES));

        // Both candidates live under the key the template used, so the lookup for
        // 'corvette' still finds the specific candidate instead of a universal-only key.
        expect(catalog.sectionsByShipSize.has('corvette')).to.equal(false);
        expect(sectionKeys(catalog, 'CORVETTE')).to.deep.equal(['CORVETTE_MID_UPPER', 'UNIVERSAL_MID']);

        const corvette = named(resolveShipIcons(catalog, {
            graphicalCulture: 'humanoid_01',
            shipSizes: ['corvette'],
        }), 'corvette');
        expect(corvette.meshFiles).to.deep.equal(['gfx/models/ships/uppercase_corvette.mesh']);
        expect(corvette.frame).to.equal(3);
        expect(corvette.sheetFrames).to.equal(34);
        expect(corvette.warnings).to.deep.equal([]);
    });

    it('stays deterministic across listing orders with universal templates and overrides', async () => {
        const nested = await loadShipIconCatalog(new MemorySource(UNIVERSAL_SECTION_FIXTURES, 'nested'));
        const reversed = await loadShipIconCatalog(new MemorySource(UNIVERSAL_SECTION_FIXTURES, 'nested-reversed'));
        const flat = await loadShipIconCatalog(new MemorySource(UNIVERSAL_SECTION_FIXTURES, 'flat'));

        const base = snapshotSections(nested);
        expect(snapshotSections(reversed)).to.equal(base);
        expect(snapshotSections(flat)).to.equal(base);

        const listed = snapshot(nested);
        expect(snapshot(reversed)).to.equal(listed);
        expect(snapshot(flat)).to.equal(listed);
    });
});

// ── Fixtures for attach chains ───────────────────────────────────────────────

const ATTACH_FIXTURES: Record<string, string> = {
    'common/ship_sizes/00_attach_sizes.txt': [
        '# No pdxmesh: all geometry lives on the attach children.',
        'attach_only = {',
        '\ticon = ship_size_military_1',
        '\tentity = core_entity',
        '}',
        '',
        '# Own pdxmesh plus a turret attachment.',
        'own_mesh = {',
        '\ticon = ship_size_military_1',
        '\tentity = hull_with_attachments_entity',
        '}',
        '',
        '# Own pdxmesh name is declared nowhere, so the attachments must be used.',
        'unresolved_own_mesh = {',
        '\ticon = ship_size_military_1',
        '\tentity = broken_hull_entity',
        '}',
        '',
        '# Three attach levels plus a cycle back to the root.',
        'deep_chain = {',
        '\ticon = ship_size_military_1',
        '\tentity = deep_root_entity',
        '}',
        '',
        '# Attach children with and without the graphical culture prefix.',
        'mixed_prefix = {',
        '\ticon = ship_size_military_1',
        '\tentity = prefixed_root_entity',
        '}',
        '',
        '# Attach targets that are defined nowhere.',
        'missing_child = {',
        '\ticon = ship_size_military_1',
        '\tentity = missing_child_root_entity',
        '}',
        '',
        '# Empty attach block.',
        'empty_attach = {',
        '\ticon = ship_size_military_1',
        '\tentity = empty_attach_root_entity',
        '}',
        '',
        '# Children resolving to the same .mesh path with other casing.',
        'duplicate_mesh = {',
        '\ticon = ship_size_military_1',
        '\tentity = duplicate_root_entity',
        '}',
        '',
        '# The template entity has no pdxmesh of its own.',
        'section_attach = {',
        '\ticon = ship_size_military_1',
        '\tsection_slots = {',
        '\t\t"mid" = { locator = "part1" }',
        '\t}',
        '}',
        '',
        '# The same slot twice: the same warning text twice.',
        'repeated_slot = {',
        '\ticon = ship_size_military_1',
        '\tsection_slots = {',
        '\t\t"mid" = { locator = "part1" }',
        '\t\t"mid" = { locator = "part2" }',
        '\t}',
        '}',
    ].join('\n'),

    'common/section_templates/attach.txt': [
        'ship_section_template = {',
        '\tkey = "ATTACH_MID"',
        '\tship_size = section_attach',
        '\tfits_on_slot = mid',
        '\tentity = "core_entity"',
        '}',
    ].join('\n'),

    'gfx/models/ships/_attach.asset': [
        'entity = { name = "core_entity" attach = { part1 = "hull_entity" part2 = "engine_entity" } }',
        'entity = { name = "hull_entity" pdxmesh = "hull_mesh" }',
        'entity = { name = "engine_entity" pdxmesh = "engine_mesh" }',
        'entity = { name = "hull_with_attachments_entity" pdxmesh = "hull_mesh" attach = { turret = "turret_entity" } }',
        'entity = { name = "turret_entity" pdxmesh = "turret_mesh" }',
        'entity = { name = "broken_hull_entity" pdxmesh = "undeclared_mesh" attach = { part1 = "hull_entity" } }',
        'entity = { name = "deep_root_entity" pdxmesh = "deep_root_mesh" attach = { part1 = "deep_child_a_entity" } }',
        'entity = { name = "deep_child_a_entity" pdxmesh = "deep_a_mesh" attach = { part1 = "deep_child_b_entity" } }',
        'entity = { name = "deep_child_b_entity" attach = { part1 = "deep_child_c_entity" part2 = "deep_root_entity" } }',
        'entity = { name = "deep_child_c_entity" pdxmesh = "deep_mesh" }',
        'entity = { name = "prefixed_root_entity" attach = { part1 = "prefixed_hull_entity" part2 = "bare_engine_entity" } }',
        'entity = { name = "humanoid_01_prefixed_hull_entity" pdxmesh = "hull_mesh" }',
        'entity = { name = "bare_engine_entity" pdxmesh = "engine_mesh" }',
        'entity = { name = "missing_child_root_entity" attach = { part1 = "not_defined_entity" part2 = "also_not_defined_entity" } }',
        'entity = { name = "empty_attach_root_entity" attach = { } }',
        'entity = { name = "duplicate_root_entity" attach = { part1 = "duplicate_a_entity" part2 = "duplicate_b_entity" part3 = "duplicate_a_again_entity" part4 = "duplicate_c_entity" } }',
        'entity = { name = "duplicate_a_entity" pdxmesh = "duplicate_mesh_a" }',
        'entity = { name = "duplicate_b_entity" pdxmesh = "duplicate_mesh_b" }',
        'entity = { name = "duplicate_a_again_entity" pdxmesh = "duplicate_mesh_a" }',
        'entity = { name = "duplicate_c_entity" pdxmesh = "duplicate_mesh_c" }',
    ].join('\n'),

    'gfx/models/ships/_attach_meshes.gfx': [
        'pdxmesh = { name = "hull_mesh" file = "gfx/models/ships/attach/hull.mesh" }',
        'pdxmesh = { name = "engine_mesh" file = "gfx/models/ships/attach/engine.mesh" }',
        'pdxmesh = { name = "turret_mesh" file = "gfx/models/ships/attach/turret.mesh" }',
        'pdxmesh = { name = "deep_root_mesh" file = "gfx/models/ships/attach/deep_root.mesh" }',
        'pdxmesh = { name = "deep_a_mesh" file = "gfx/models/ships/attach/deep_a.mesh" }',
        'pdxmesh = { name = "deep_mesh" file = "gfx/models/ships/attach/deep.mesh" }',
        'pdxmesh = { name = "duplicate_mesh_a" file = "gfx/models/ships/attach/Duplicate.MESH" }',
        'pdxmesh = { name = "duplicate_mesh_b" file = "gfx/models/ships/attach/other.mesh" }',
        'pdxmesh = { name = "duplicate_mesh_c" file = "gfx\\models\\ships\\attach\\OTHER.MESH" }',
    ].join('\n'),

    'interface/icons.gfx': [
        'spriteType = { name = "GFX_ship_sizes_top" noOfFrames = 34 }',
        'spriteType = { name = "GFX_ship_size_military_1_top" sprite_sheet_sprite_type = "GFX_ship_sizes_top" default_frame = 3 }',
    ].join('\n'),
};

function attachOptions(shipSizes: readonly string[]): ShipIconResolveOptions {
    return { graphicalCulture: 'humanoid_01', shipSizes };
}

describe('ship icon definitions: attach chains', () => {
    it('collects the meshes of every attach child when the entity has no pdxmesh', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['attach_only'])), 'attach_only');

        expect(entry.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/hull.mesh',
            'gfx/models/ships/attach/engine.mesh',
        ]);
        expect(entry.warnings).to.deep.equal([]);
    });

    it('collects the own pdxmesh first and then the attach children', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const result = resolveShipIcons(catalog, attachOptions(['own_mesh', 'unresolved_own_mesh']));

        // Own hull first, the attached turret after it.
        const own = named(result, 'own_mesh');
        expect(own.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/hull.mesh',
            'gfx/models/ships/attach/turret.mesh',
        ]);
        expect(own.warnings).to.deep.equal([]);

        // A pdxmesh name no .gfx declares still yields the attached geometry.
        const unresolved = named(result, 'unresolved_own_mesh');
        expect(unresolved.meshFiles).to.deep.equal(['gfx/models/ships/attach/hull.mesh']);
        expect(unresolved.warnings).to.deep.equal([]);
    });

    it('walks a three-level attach chain, collects every level and survives a cycle', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['deep_chain'])), 'deep_chain');

        // deep_root (own mesh) -> deep_child_a (own mesh) -> deep_child_b (none) ->
        // deep_child_c; deep_child_b also attaches the root again, which is a cycle.
        expect(entry.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/deep_root.mesh',
            'gfx/models/ships/attach/deep_a.mesh',
            'gfx/models/ships/attach/deep.mesh',
        ]);
        expect(entry.warnings).to.deep.equal([]);
    });

    it('resolves attach children with and without the culture prefix', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['mixed_prefix'])), 'mixed_prefix');

        // humanoid_01_prefixed_hull_entity serves the prefixed child; the child with
        // no culture variant uses its bare name.
        expect(entry.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/hull.mesh',
            'gfx/models/ships/attach/engine.mesh',
        ]);
        expect(entry.warnings).to.deep.equal([]);
    });

    it('keeps the warning when no attach child resolves', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const result = resolveShipIcons(catalog, attachOptions(['missing_child', 'empty_attach']));

        const missing = named(result, 'missing_child');
        expect(missing.meshFiles).to.deep.equal([]);
        expect(missing.warnings).to.deep.equal([
            "entity 'missing_child_root_entity' (ship size 'missing_child') has no pdxmesh",
        ]);

        const empty = named(result, 'empty_attach');
        expect(empty.meshFiles).to.deep.equal([]);
        expect(empty.warnings).to.deep.equal([
            "entity 'empty_attach_root_entity' (ship size 'empty_attach') has no pdxmesh",
        ]);
    });

    it('applies the attach chain to a section template entity too', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['section_attach'])), 'section_attach');

        expect(entry.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/hull.mesh',
            'gfx/models/ships/attach/engine.mesh',
        ]);
        expect(entry.warnings).to.deep.equal([]);
    });

    it('drops repeated mesh paths case-insensitively and keeps the first spelling', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['duplicate_mesh'])), 'duplicate_mesh');

        // Four attach children, two distinct files: duplicate_mesh_a is used twice and
        // duplicate_mesh_c repeats duplicate_mesh_b's file with other casing and slashes.
        expect(entry.meshFiles).to.deep.equal([
            'gfx/models/ships/attach/Duplicate.MESH',
            'gfx/models/ships/attach/other.mesh',
        ]);
        expect(entry.warnings).to.deep.equal([]);
    });

    it('drops repeated warning text within one size and leaves the catalog contract intact', async () => {
        const catalog = await loadShipIconCatalog(new MemorySource(ATTACH_FIXTURES));
        const entry = named(resolveShipIcons(catalog, attachOptions(['repeated_slot'])), 'repeated_slot');

        expect(entry.meshFiles).to.deep.equal([]);
        expect(entry.warnings).to.deep.equal(["no section template for ship size 'repeated_slot' slot 'mid'"]);
        // The attach index stays module-internal: the published keys are unchanged.
        expect(Object.keys(catalog).sort()).to.deep.equal([
            'entityToPdxMesh', 'graphicalCultures', 'pdxMeshToFile', 'sectionsByShipSize',
            'shipSizes', 'spriteFrameByIcon', 'spriteIconSheet', 'spriteSheetFrames', 'warnings',
        ]);
    });
});
