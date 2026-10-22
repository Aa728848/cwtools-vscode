/**
 * .gfx snippet for a generated ship icon sheet.
 *
 * The command writes two horizontal DDS sheets; the game only sees them through
 * spriteType definitions. Those definitions have to carry the frame each size was
 * actually given, which is exactly what the layout produced, so this module turns
 * the build result into a block the user can paste into a .gfx file.
 *
 * Sprite names are derived from the ship size, never from the icon key. Mods hang
 * dozens of sizes off a handful of shared icon keys, and a name derived from the
 * icon folds every one of those sizes into one sprite, leaving all but the first
 * unaddressable in the game. The icon key is still quoted at the end of the snippet:
 * it tells the user which ship_size blocks still need their `icon =` changed to the
 * size name before the derived sprites can be reached.
 *
 * Pure: no vscode, no fs, no clock. The same input always yields the same text.
 */

export interface ShipIconSnippetEntry {
    /** Ship size the sprites belong to; the sprite names are derived from it. */
    shipSize: string;
    /** Icon key the size currently uses; quoted in the pastable icon list, never used to name a sprite. */
    icon: string;
    /** 1-based frame inside the normal sheet. */
    frame: number;
    /** 1-based frame inside the damaged sheet. */
    damagedFrame: number;
}

/** Placement counts of the sheet, quoted in the header comment. */
export interface ShipIconSnippetAlignment {
    aligned: number;
    packed: number;
    widened: number;
}

export interface ShipIconSnippetInput {
    /** Sheet sprite of the normal sheet, e.g. GFX_ship_sizes_top. */
    sheetSpriteName: string;
    /** Sheet sprite of the damaged sheet, e.g. GFX_ship_sizes_top_damaged. */
    damagedSheetSpriteName: string;
    /** Frames the sheet ended up with; becomes noOfFrames of both sheet sprites. */
    frameCount: number;
    entries: readonly ShipIconSnippetEntry[];
    /** Relative .dds path of the normal sheet; defaults to the stock directory + sheet name. */
    textureFile?: string;
    /** Relative .dds path of the damaged sheet; defaults to the stock directory + sheet name. */
    damagedTextureFile?: string;
    /** Optional: only explains the layout in the header comment. */
    alignment?: ShipIconSnippetAlignment;
}

/** Where the command saves the sheets by default, relative to the game root. */
const SHEET_DIRECTORY = 'gfx/interface/icons/ship_parts/ship_sizes';

/** A size without a frame number cannot be pointed at, so it is left out of the snippet. */
function usableFrame(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const rounded = Math.floor(value);
    return rounded > 0 ? rounded : 0;
}

function text(value: string | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** GFX_kuat_ship_sizes_top -> kuat_ship_sizes_top.dds */
function sheetFileName(sheetSpriteName: string): string {
    const bare = sheetSpriteName.replace(/^GFX_/i, '').trim();
    return bare === '' ? 'ship_icons.dds' : `${bare}.dds`;
}

function defaultTextureFile(sheetSpriteName: string): string {
    return `${SHEET_DIRECTORY}/${sheetFileName(sheetSpriteName)}`;
}

/**
 * A sprite name is only addressable when it stays inside [A-Za-z0-9_], so every
 * other character of the ship size becomes an underscore. The game matches sprite
 * names case-insensitively on a case-insensitive filesystem, hence the lower-cased
 * duplicate key used by the caller.
 */
function spriteNamePart(value: string): string {
    return value.replace(/[^A-Za-z0-9_]/g, '_');
}

function uniqueSpriteName(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base.toLowerCase())) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}_${suffix}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

function spriteBlock(spriteName: string, fields: readonly (readonly [string, string])[]): string[] {
    const lines: string[] = ['	spriteType = {', `		name = "${spriteName}"`];
    for (const [key, value] of fields) lines.push(`		${key} = ${value}`);
    lines.push('	}');
    return lines;
}

/** One emitted size: the raw name for the comments, the derived name for the sprites. */
interface EmittedSize {
    /** Ship size as authored; only used in comments. */
    shipSize: string;
    /** Normalized, de-duplicated sprite name stem, i.e. everything between GFX_ and _top. */
    base: string;
    /** Icon key the size currently uses, or '' when it has none. */
    icon: string;
    frame: number;
    damagedFrame: number;
}

function emittedSizes(entries: readonly ShipIconSnippetEntry[]): EmittedSize[] {
    const sizes: EmittedSize[] = [];
    const taken = new Set<string>();
    for (const entry of entries) {
        if (entry === undefined || typeof entry !== 'object') continue;
        const frame = usableFrame(entry.frame);
        if (frame <= 0) continue;
        const shipSize = text(entry.shipSize);
        const icon = text(entry.icon);
        // A size whose name carries no usable character falls back to its icon, which
        // is still better than dropping it; an entry with neither cannot be named.
        const base = uniqueSpriteName(spriteNamePart(shipSize) || spriteNamePart(icon), taken);
        if (base === '') continue;
        taken.add(base.toLowerCase());
        sizes.push({
            shipSize: shipSize === '' ? icon : shipSize,
            base,
            icon,
            frame,
            damagedFrame: usableFrame(entry.damagedFrame) || frame,
        });
    }
    return sizes;
}

/** The pastable block: one `icon =` line per size, in the order the sizes were placed. */
function iconListLines(sizes: readonly EmittedSize[]): string[] {
    const lines: string[] = [
        '',
        '# ---- pastable ship_size icon list ----',
        '# The game looks up GFX_<icon>_top, so a size only reaches its own sprite after',
        '# its ship_size block carries the matching icon: copy each line below into that block.',
        '# Characters outside [A-Za-z0-9_] become _; a repeated name gains _2, _3.',
        '# A size left on its original icon keeps sharing that icon, and therefore its sprite.',
    ];
    for (const size of sizes) {
        const current = size.icon === '' ? '(none)' : size.icon;
        lines.push(`#   ${size.shipSize}: icon = ${size.base}    (currently icon = ${current})`);
    }
    return lines;
}

/**
 * Pastable .gfx text: two sheet sprites first, then one normal and one damaged
 * sprite per placed ship size, named after the size. Two sizes that share one icon
 * no longer collapse into one sprite, so every placed size is addressable once the
 * ship_size icon list at the end has been applied.
 */
export function buildShipIconGfxSnippet(input: ShipIconSnippetInput): string {
    const sheetSpriteName = text(input.sheetSpriteName);
    const damagedSheetSpriteName = text(input.damagedSheetSpriteName);
    const normalTexture = text(input.textureFile) || defaultTextureFile(sheetSpriteName);
    const damagedTexture = text(input.damagedTextureFile) || defaultTextureFile(damagedSheetSpriteName);

    const entries: ShipIconSnippetEntry[] = Array.isArray(input.entries) ? input.entries : [];
    let frameCount = usableFrame(input.frameCount);
    if (frameCount <= 0) {
        for (const entry of entries) {
            if (entry === undefined || typeof entry !== 'object') continue;
            frameCount = Math.max(frameCount, usableFrame(entry.frame), usableFrame(entry.damagedFrame));
        }
    }

    const sizes = emittedSizes(entries);

    const alignment = input.alignment;
    const aligned = alignment === undefined ? 0 : Math.max(0, Math.floor(alignment.aligned));
    const packed = alignment === undefined ? 0 : Math.max(0, Math.floor(alignment.packed));
    const widened = alignment === undefined ? 0 : Math.max(0, Math.floor(alignment.widened));

    const lines: string[] = [
        '# CWTools ship icon sheet - generated .gfx snippet.',
        '# Paste this into a .gfx file: it declares the two sheets and one normal plus one damaged sprite per ship size.',
        `# Layout: ${aligned} aligned, ${packed} packed, ${widened} widened (${frameCount} frame(s) in total, ${sizes.length} ship size(s)).`,
        '# Sprite names are derived from the ship size: GFX_<ship_size>_top and GFX_<ship_size>_top_damaged,',
        '# so sizes that share one icon still get a sprite of their own.',
        '# If a spriteType with the same name already exists, replace it instead of adding a second copy.',
        '',
        'spriteTypes = {',
        ...spriteBlock(sheetSpriteName, [
            ['textureFile', `"${normalTexture}"`],
            ['noOfFrames', String(frameCount)],
        ]),
        '',
        ...spriteBlock(damagedSheetSpriteName, [
            ['textureFile', `"${damagedTexture}"`],
            ['noOfFrames', String(frameCount)],
        ]),
    ];

    for (const size of sizes) {
        lines.push('');
        lines.push(`	# ${size.shipSize}`);
        lines.push(...spriteBlock(`GFX_${size.base}_top`, [
            ['sprite_sheet_sprite_type', `"${sheetSpriteName}"`],
            ['default_frame', String(size.frame)],
        ]));
        lines.push(...spriteBlock(`GFX_${size.base}_top_damaged`, [
            ['sprite_sheet_sprite_type', `"${damagedSheetSpriteName}"`],
            ['default_frame', String(size.damagedFrame)],
        ]));
    }

    lines.push('}');

    if (sizes.length === 0) {
        lines.push('# No ship size was placed, so only the two sheet sprites are declared; nothing is sliced yet.');
    } else {
        lines.push(...iconListLines(sizes));
    }
    return `${lines.join('\n')}\n`;
}
