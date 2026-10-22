/**
 * Ship icon selection: class-based categories and manual mesh override values.
 *
 * Pure logic only. This module must stay free of vscode and fs so the QuickPick
 * flow in shipIconCommand.ts can be tested through the values it derives here.
 */

// ── Categories ───────────────────────────────────────────────────────────────

export type ShipIconCategoryId =
    | 'military'
    | 'militaryStation'
    | 'militarySpecial'
    | 'starbase'
    | 'constructor'
    | 'colonizer'
    | 'scienceShip'
    | 'transport'
    | 'station'
    | 'other';

export interface ShipIconCategory {
    id: ShipIconCategoryId;
    labelEn: string;
    labelZh: string;
    /** Ship sizes of this category, in the order they were given. */
    shipSizes: string[];
}

/** One candidate size: the catalog name plus the raw `class` value, when it has one. */
export interface ShipSizeCandidate {
    shipSize: string;
    shipClass?: string;
}

/** The fixed presentation order; 'other' is always last. */
export const SHIP_ICON_CATEGORY_IDS: readonly ShipIconCategoryId[] = [
    'military',
    'militaryStation',
    'militarySpecial',
    'starbase',
    'constructor',
    'colonizer',
    'scienceShip',
    'transport',
    'station',
    'other',
];

const CATEGORY_LABELS: Readonly<Record<ShipIconCategoryId, { labelEn: string; labelZh: string }>> = {
    military: { labelEn: 'Military ships', labelZh: '军舰' },
    militaryStation: { labelEn: 'Military stations', labelZh: '军用空间站' },
    militarySpecial: { labelEn: 'Special military ships', labelZh: '特殊军舰' },
    starbase: { labelEn: 'Starbases', labelZh: '星港与基地' },
    constructor: { labelEn: 'Construction ships', labelZh: '工程船' },
    colonizer: { labelEn: 'Colony ships', labelZh: '殖民船' },
    scienceShip: { labelEn: 'Science ships', labelZh: '科研船' },
    transport: { labelEn: 'Transport ships', labelZh: '运输船' },
    station: { labelEn: 'Stations', labelZh: '站点' },
    other: { labelEn: 'Other', labelZh: '其他' },
};

/** `class = shipclass_xxx` to category; every unlisted or missing class falls to 'other'. */
const CATEGORY_BY_SHIP_CLASS: Readonly<Record<string, ShipIconCategoryId>> = {
    shipclass_military: 'military',
    shipclass_military_station: 'militaryStation',
    shipclass_military_special: 'militarySpecial',
    shipclass_starbase: 'starbase',
    shipclass_constructor: 'constructor',
    shipclass_colonizer: 'colonizer',
    shipclass_science_ship: 'scienceShip',
    shipclass_transport: 'transport',
    shipclass_research_station: 'station',
    shipclass_observation_station: 'station',
};

export function categoryForShipClass(shipClass: unknown): ShipIconCategoryId {
    if (typeof shipClass !== 'string') return 'other';
    const key = shipClass.trim().toLowerCase();
    if (key === '') return 'other';
    return CATEGORY_BY_SHIP_CLASS[key] ?? 'other';
}

/**
 * Groups sizes into the fixed category order, dropping empty categories.
 * Sizes keep the order they were given in and duplicates are removed, so the
 * result is deterministic for a sorted input.
 */
export function categorizeShipSizes(entries: readonly ShipSizeCandidate[]): ShipIconCategory[] {
    const buckets = new Map<ShipIconCategoryId, string[]>();
    for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const shipSize = typeof entry.shipSize === 'string' ? entry.shipSize.trim() : '';
        if (shipSize === '') continue;
        const id = categoryForShipClass(entry.shipClass);
        const bucket = buckets.get(id);
        if (bucket === undefined) {
            buckets.set(id, [shipSize]);
        } else if (!bucket.includes(shipSize)) {
            bucket.push(shipSize);
        }
    }

    const categories: ShipIconCategory[] = [];
    for (const id of SHIP_ICON_CATEGORY_IDS) {
        const shipSizes = buckets.get(id);
        if (shipSizes === undefined || shipSizes.length === 0) continue;
        const labels = CATEGORY_LABELS[id];
        categories.push({ id, labelEn: labels.labelEn, labelZh: labels.labelZh, shipSizes: [...shipSizes] });
    }
    return categories;
}

// ── Manual mesh overrides ────────────────────────────────────────────────────

/** Caps one size's override list; the setting is user-editable data, not a data source. */
const MAX_OVERRIDE_ENTRIES = 64;

/** Entries are separated by a comma or a semicolon, half or full width. */
const OVERRIDE_SEPARATOR = /[,;，；]/;

/**
 * One override value: trimmed, forward-slashed, and rejected when it is empty
 * or walks up a directory. Everything else is passed through untouched, so a
 * '.MESH' spelling and an entity name both survive.
 */
function normalizeOverrideValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().replace(/\\/g, '/');
    if (text === '') return undefined;
    if (text.includes('..')) return undefined;
    return text;
}

function pushUnique(entries: string[], candidate: unknown): void {
    if (entries.length >= MAX_OVERRIDE_ENTRIES) return;
    const value = normalizeOverrideValue(candidate);
    if (value === undefined) return;
    const folded = value.toLowerCase();
    if (entries.some((entry) => entry.toLowerCase() === folded)) return;
    entries.push(value);
}

/**
 * One comma/semicolon separated line to the values it names: trimmed, in the
 * order written, duplicates removed. Empty text means "no override".
 */
export function parseMeshOverrideEntries(text: unknown): string[] {
    if (typeof text !== 'string') return [];
    const entries: string[] = [];
    for (const part of text.split(OVERRIDE_SEPARATOR)) pushUnique(entries, part);
    return entries;
}

/**
 * The setting value to `{ shipSize: entries }`: anything unusable is dropped
 * rather than reported, and a size with no usable entry is left out entirely so
 * it keeps resolving through its own entity chain.
 */
export function normalizeMeshOverrides(value: unknown): Record<string, string[]> {
    const normalized: Record<string, string[]> = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return normalized;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (key === '') continue;
        const entries: string[] = [];
        if (typeof rawValue === 'string') {
            for (const entry of parseMeshOverrideEntries(rawValue)) pushUnique(entries, entry);
        } else if (Array.isArray(rawValue)) {
            for (const entry of rawValue) pushUnique(entries, entry);
        }
        if (entries.length === 0) continue;
        normalized[key] = entries;
    }
    return normalized;
}

/**
 * The entries configured for one size, matched the way the resolver matches them
 * (own key first, then case-insensitively); undefined when it has no override.
 */
export function overrideEntriesFor(
    overrides: Readonly<Record<string, readonly string[]>>,
    shipSize: string,
): string[] | undefined {
    if (Object.prototype.hasOwnProperty.call(overrides, shipSize)) {
        const exact = overrides[shipSize];
        return exact !== undefined && exact.length > 0 ? [...exact] : undefined;
    }
    const lowered = shipSize.toLowerCase();
    for (const key of Object.keys(overrides)) {
        if (key.toLowerCase() !== lowered) continue;
        const value = overrides[key];
        return value !== undefined && value.length > 0 ? [...value] : undefined;
    }
    return undefined;
}
