import { expect } from 'chai';
import {
    buildShipIconGfxSnippet,
    type ShipIconSnippetEntry,
    type ShipIconSnippetInput,
} from '../../extension/shipIcon/shipIconGfxSnippet';

function entry(
    shipSize: string,
    icon: string,
    frame: number,
    damagedFrame: number,
): ShipIconSnippetEntry {
    return { shipSize, icon, frame, damagedFrame };
}

/** Field maps of every emitted spriteType block, so assertions can target one sprite. */
function parseBlocks(text: string): Array<Record<string, string>> {
    const blocks: Array<Record<string, string>> = [];
    for (const chunk of text.split('spriteType = {').slice(1)) {
        const body = chunk.split('}')[0] ?? '';
        const fields: Record<string, string> = {};
        for (const line of body.split('\n')) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
            if (match === null) continue;
            fields[match[1] as string] = (match[2] ?? '').replace(/^"/, '').replace(/"$/, '');
        }
        blocks.push(fields);
    }
    return blocks;
}

function blockFor(snippet: string, name: string): Record<string, string> {
    const found = parseBlocks(snippet).find((block) => block['name'] === name);
    expect(found, `spriteType ${name} is emitted`).to.not.equal(undefined);
    return found as Record<string, string>;
}

/** Every spriteType name in the snippet, in emission order. */
function spriteNames(snippet: string): string[] {
    return parseBlocks(snippet).map((block) => block['name'] ?? '');
}

interface IconListLine { shipSize: string; icon: string; current: string; }

/** The pastable icon list at the end of the snippet. */
function iconList(snippet: string): IconListLine[] {
    const lines: IconListLine[] = [];
    for (const line of snippet.split('\n')) {
        const match = /^#\s+(.+?): icon = (\S+)\s+\(currently icon = (.+?)\)$/.exec(line);
        if (match === null) continue;
        lines.push({ shipSize: match[1] as string, icon: match[2] as string, current: match[3] as string });
    }
    return lines;
}

/** Every ship size of the real Aggressor mod, which shares four icon keys between them. */
const SHARED_ICON_SIZES = [
    'Aggressor', 'Annihilator', 'Cavelry', 'Drift_Battleship', 'Drift_Crusier', 'Drift_Flagship',
    'eternal_battleship', 'eternal_flagship', 'Gladiator', 'high_Imperial_star_destroyer', 'horrizone',
    'Infinite_battleship', 'Infinite_crusier', 'Infinite_Mothership', 'Kandosii', 'knight_hammer_executor',
    'kuat_compellor', 'kuat_eclipse', 'kuat_impellor', 'kuat_legator', 'kuat_sector', 'Kuat_Xyston',
    'Spt_Battleship', 'Spt_Crusier', 'Spt_Flagship', 'swfo_resurgent', 'Venator_modifier',
    'Venator_modifier_II', 'Venator_modifier_III', 'Vengeance', 'X308_Balletor', 'X308_Titan', 'X308_Tyrant',
];

const SHARED_ICONS = [
    'kuat_ship_size_military_2',
    'kuat_ship_size_military_3',
    'kuat_ship_size_military_4',
    'kuat_ship_size_military_5',
];

/** 33 placed sizes spread over four icons, the way the real mod resolves. */
function sharedIconEntries(): ShipIconSnippetEntry[] {
    return SHARED_ICON_SIZES.map((shipSize, index) => entry(
        shipSize,
        SHARED_ICONS[index % SHARED_ICONS.length] as string,
        index + 1,
        index + 1,
    ));
}

const BASE: ShipIconSnippetInput = {
    sheetSpriteName: 'GFX_ship_sizes_top',
    damagedSheetSpriteName: 'GFX_ship_sizes_top_damaged',
    frameCount: 4,
    entries: [
        entry('kuat_compellor', 'ship_size_military_2', 1, 1),
        entry('kuat_eclipse', 'ship_size_military_3', 2, 3),
    ],
    alignment: { aligned: 1, packed: 1, widened: 0 },
};

describe('shipIconGfxSnippet', () => {
    it('declares both sheet sprites with the texture path and the produced frame count', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            textureFile: 'gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds',
            damagedTextureFile: 'gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top_damaged.dds',
        });

        expect(snippet).to.contain('spriteTypes = {');
        expect(blockFor(snippet, 'GFX_ship_sizes_top')).to.deep.equal({
            name: 'GFX_ship_sizes_top',
            textureFile: 'gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds',
            noOfFrames: '4',
        });
        expect(blockFor(snippet, 'GFX_ship_sizes_top_damaged')).to.deep.equal({
            name: 'GFX_ship_sizes_top_damaged',
            textureFile: 'gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top_damaged.dds',
            noOfFrames: '4',
        });
    });

    it('emits a normal and a damaged sprite per size, named after the size and on its own frame', () => {
        const snippet = buildShipIconGfxSnippet(BASE);
        // Two sheet sprites plus two sprites per entry.
        expect(parseBlocks(snippet)).to.have.length(6);

        expect(blockFor(snippet, 'GFX_kuat_compellor_top')).to.deep.equal({
            name: 'GFX_kuat_compellor_top',
            sprite_sheet_sprite_type: 'GFX_ship_sizes_top',
            default_frame: '1',
        });
        expect(blockFor(snippet, 'GFX_kuat_compellor_top_damaged')).to.deep.equal({
            name: 'GFX_kuat_compellor_top_damaged',
            sprite_sheet_sprite_type: 'GFX_ship_sizes_top_damaged',
            default_frame: '1',
        });
        // The damaged sheet may lay the size out on a different frame; it must be used.
        expect(blockFor(snippet, 'GFX_kuat_eclipse_top')).to.deep.equal({
            name: 'GFX_kuat_eclipse_top',
            sprite_sheet_sprite_type: 'GFX_ship_sizes_top',
            default_frame: '2',
        });
        expect(blockFor(snippet, 'GFX_kuat_eclipse_top_damaged')).to.deep.equal({
            name: 'GFX_kuat_eclipse_top_damaged',
            sprite_sheet_sprite_type: 'GFX_ship_sizes_top_damaged',
            default_frame: '3',
        });
    });

    it('normalizes characters a sprite name cannot carry', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            entries: [
                entry('Venator modifier-II', 'ship_size_military_2', 1, 1),
                entry('Spt Cruiser/Flagship', 'ship_size_military_2', 2, 2),
            ],
        });

        expect(spriteNames(snippet)).to.deep.equal([
            'GFX_ship_sizes_top',
            'GFX_ship_sizes_top_damaged',
            'GFX_Venator_modifier_II_top',
            'GFX_Venator_modifier_II_top_damaged',
            'GFX_Spt_Cruiser_Flagship_top',
            'GFX_Spt_Cruiser_Flagship_top_damaged',
        ]);
        // The pasted icon has to match the normalized sprite name, not the raw size.
        expect(snippet).to.contain('#   Venator modifier-II: icon = Venator_modifier_II');
    });

    it('keeps a size name that is already usable untouched', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            entries: [entry('Venator_modifier_II', 'kuat_ship_size_military_2', 1, 1)],
        });

        expect(spriteNames(snippet)).to.deep.equal([
            'GFX_ship_sizes_top',
            'GFX_ship_sizes_top_damaged',
            'GFX_Venator_modifier_II_top',
            'GFX_Venator_modifier_II_top_damaged',
        ]);
        expect(snippet).to.contain('#   Venator_modifier_II: icon = Venator_modifier_II');
    });

    it('suffixes a name that repeats case-insensitively, on both halves of the pair', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            entries: [
                entry('Aggressor', 'ship_size_military_2', 1, 1),
                entry('aggressor', 'ship_size_military_2', 2, 2),
                entry('AGGRESSOR', 'ship_size_military_2', 3, 3),
            ],
        });

        expect(spriteNames(snippet)).to.deep.equal([
            'GFX_ship_sizes_top',
            'GFX_ship_sizes_top_damaged',
            'GFX_Aggressor_top',
            'GFX_Aggressor_top_damaged',
            'GFX_aggressor_2_top',
            'GFX_aggressor_2_top_damaged',
            'GFX_AGGRESSOR_3_top',
            'GFX_AGGRESSOR_3_top_damaged',
        ]);
    });

    it('keeps every size addressable when 33 of them share four icons', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            frameCount: 33,
            entries: sharedIconEntries(),
        });

        const names = spriteNames(snippet);
        expect(names).to.have.length(2 + SHARED_ICON_SIZES.length * 2);
        // No name may be declared twice, whatever the case.
        for (const name of names) {
            const occurrences = snippet.split(`name = "${name}"`).length - 1;
            expect(occurrences, `${name} is declared once`).to.equal(1);
        }
        expect(new Set(names.map((name) => name.toLowerCase())).size).to.equal(names.length);
        expect(SHARED_ICON_SIZES.filter((size) => !names.includes(`GFX_${size}_top`))).to.deep.equal([]);
    });

    it('ends with the pastable icon list, one line per size carrying the original icon', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            frameCount: 33,
            entries: sharedIconEntries(),
        });

        const listed = iconList(snippet);
        expect(listed).to.have.length(SHARED_ICON_SIZES.length);
        expect(listed.map((line) => line.shipSize)).to.deep.equal(SHARED_ICON_SIZES);
        expect(listed.map((line) => line.icon)).to.deep.equal(SHARED_ICON_SIZES);
        expect(listed[0]?.current).to.equal('kuat_ship_size_military_2');
        expect(listed[1]?.current).to.equal('kuat_ship_size_military_3');
        expect(snippet).to.contain('# ---- pastable ship_size icon list ----');
        expect(snippet).to.contain('A size left on its original icon keeps sharing that icon');
    });

    it('writes only the two sheet sprites plus the note when no size was placed', () => {
        const snippet = buildShipIconGfxSnippet({ ...BASE, entries: [] });

        expect(parseBlocks(snippet)).to.have.length(2);
        expect(snippet).to.not.contain('default_frame');
        expect(blockFor(snippet, 'GFX_ship_sizes_top')['noOfFrames']).to.equal('4');
        expect(snippet).to.contain('# No ship size was placed');
        expect(snippet).to.not.contain('pastable');
    });

    it('reports the packed and widened counts in the header comment', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            alignment: { aligned: 27, packed: 4, widened: 1 },
        });

        expect(snippet).to.contain('# Layout: 27 aligned, 4 packed, 1 widened');
        expect(snippet).to.contain('replace it instead of adding a second copy');
        expect(snippet).to.contain('Sprite names are derived from the ship size');
        // The comment must sit in the header, before the first spriteType block.
        expect(snippet.indexOf('# Layout:')).to.be.lessThan(snippet.indexOf('spriteType = {'));
    });

    it('derives the texture path from the sheet name when none is given', () => {
        const snippet = buildShipIconGfxSnippet(BASE);

        expect(blockFor(snippet, 'GFX_ship_sizes_top')['textureFile'])
            .to.equal('gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds');
        expect(blockFor(snippet, 'GFX_ship_sizes_top_damaged')['textureFile'])
            .to.equal('gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top_damaged.dds');
    });

    it('gives sizes that share one icon a sprite each', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            entries: [
                entry('kuat_compellor', 'ship_size_military_2', 1, 1),
                entry('kuat_impellor', 'ship_size_military_2', 2, 2),
            ],
        });

        // Two sheet sprites and one normal/damaged pair per size, not per icon.
        expect(parseBlocks(snippet)).to.have.length(6);
        expect(blockFor(snippet, 'GFX_kuat_compellor_top')['default_frame']).to.equal('1');
        expect(blockFor(snippet, 'GFX_kuat_impellor_top')['default_frame']).to.equal('2');
    });

    it('skips an entry that has no usable frame', () => {
        const snippet = buildShipIconGfxSnippet({
            ...BASE,
            entries: [entry('kuat_compellor', 'ship_size_military_2', 0, 0)],
        });

        expect(parseBlocks(snippet)).to.have.length(2);
    });

    it('is deterministic', () => {
        const input = { ...BASE, frameCount: 33, entries: sharedIconEntries() };

        expect(buildShipIconGfxSnippet(input)).to.equal(buildShipIconGfxSnippet(input));
    });
});
