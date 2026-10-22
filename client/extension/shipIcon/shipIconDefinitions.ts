/**
 * Ship icon definition resolution.
 *
 * Answers, from game script data alone: which frame of `GFX_<icon>_top` draws a
 * ship size, and which .mesh files compose that ship. A hull's geometry may sit on
 * the entity itself or on the entities it attaches, so both are followed. Every
 * file read goes through ShipIconDataSource, so the module never touches vscode
 * or fs.
 */
import { TokenType, tokenize, type Token } from '../pdxTokenizer';
import { parseAssetFile, parseGfxFile } from '../entityAssetParser';

// ── Contract ─────────────────────────────────────────────────────────────────

export interface ShipIconDataSource {
    /** Reads UTF-8 game text; a missing file resolves to undefined. Paths are forward-slashed, relative to the game root. */
    readText(relativePath: string): Promise<string | undefined>;
    /** Lists entries under a directory prefix, relative to the game root; a missing directory yields an empty array. */
    listFiles(relativeDirectory: string): Promise<string[]>;
}

export interface ShipSectionSlot { slot: string; locator: string; }

export interface ShipSizeInfo {
    name: string;
    icon?: string;                 // e.g. ship_size_military_2
    entity?: string;               // single-section ships name their entity directly
    shipClass?: string;            // class = shipclass_xxx; undefined when the field is missing
    sectionSlots: ShipSectionSlot[];
    graphicalCultures: string[];   // empty = not restricted
}

export interface ShipSectionTemplateInfo {
    key: string;
    shipSize: string;
    slot: string;                  // fits_on_slot
    entity: string;
}

export interface ShipIconCatalog {
    shipSizes: Map<string, ShipSizeInfo>;
    sectionsByShipSize: Map<string, ShipSectionTemplateInfo[]>;
    entityToPdxMesh: Map<string, string | undefined>;
    pdxMeshToFile: Map<string, string>;
    spriteFrameByIcon: Map<string, number>;
    spriteSheetFrames: Map<string, number>;
    spriteIconSheet: Map<string, string>;
    graphicalCultures: string[];
    warnings: string[];
}

export interface ShipIconResolveOptions {
    graphicalCulture: string;
    shipSizes: readonly string[];
    /** Overrides the default section pick; keys are "${shipSize}:${slot}". */
    sectionOverrides?: Readonly<Record<string, string>>;
    /**
     * Manual replacement per ship size: entity names or .mesh paths relative to
     * the game root, used in order instead of section_slots / entity.
     */
    overrides?: Readonly<Record<string, readonly string[]>>;
    damaged?: boolean;
}

export interface ResolvedShipIcon {
    shipSize: string;
    frame: number;        // 1-based frame number inside the sheet, i.e. default_frame
    sheetFrames: number;  // noOfFrames of the owning sheet (0 when unresolvable)
    meshFiles: string[];  // .mesh paths relative to the game root, in slot order
    warnings: string[];
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Caps recursive directory scans so a pathological tree cannot stall the load. */
const MAX_DIRECTORY_VISITS = 4000;

/** Caps clone chains so a cyclic or overly deep inheritance cannot loop. */
const MAX_CLONE_DEPTH = 8;

/** Caps attach chains so a cyclic or overly deep attachment graph cannot loop. */
const MAX_ATTACH_DEPTH = 4;

/** A block carrying an icon counts as a ship size when it has one of these. */
const SHIP_SIZE_MARKERS = ['section_slots', 'entity', 'class', 'is_space_station'];

/** How many sprite container levels are inspected below the top level. */
const SPRITE_CONTAINER_DEPTH = 2;

// ── Small helpers ────────────────────────────────────────────────────────────

/** Case-insensitive path order with a case-sensitive tie-break, so sorting never depends on the locale. */
function comparePaths(a: string, b: string): number {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    if (left !== right) return left < right ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Normalizes a path coming from the data source; rejects anything escaping the game root. */
function normalizeRelativePath(raw: string): string | undefined {
    const text = raw.replace(/\\/g, '/').trim();
    if (text === '') return undefined;
    const segments: string[] = [];
    for (const segment of text.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') return undefined;
        segments.push(segment);
    }
    return segments.length > 0 ? segments.join('/') : undefined;
}

function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
}

function normalizeKey(value: string): string {
    return unquote(value).toLowerCase();
}

/** Accepts only plain non-negative integers; anything else (floats, signs, junk) is unresolved. */
function parseCount(value: string | undefined): number | undefined {
    if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// ── Token block scanning ─────────────────────────────────────────────────────

interface ScalarField { kind: 'scalar'; text: string; }
interface BlockField { kind: 'block'; start: number; end: number; }
type FieldValue = ScalarField | BlockField;
type FieldMap = Map<string, FieldValue[]>;

interface RawBlock { rawKey: string; bodyStart: number; bodyEnd: number; }

/** Index of the '}' closing the block opened at `openIndex`, or -1 when the input is truncated. */
function findBlockEnd(tokens: readonly Token[], openIndex: number, limit: number): number {
    let depth = 0;
    const end = Math.min(limit, tokens.length);
    for (let i = openIndex; i < end; i++) {
        const token = tokens[i];
        if (token === undefined) return -1;
        if (token.value === '{') depth += 1;
        else if (token.value === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Every `key = { ... }` pair inside the token range [from, to), in file order. */
function enumerateBlocks(tokens: readonly Token[], from: number, to: number): RawBlock[] {
    const blocks: RawBlock[] = [];
    const limit = Math.min(to, tokens.length);
    let i = Math.max(0, from);
    while (i < limit) {
        const token = tokens[i];
        if (token === undefined || token.type === TokenType.EOF) break;
        const equals = tokens[i + 1];
        const value = tokens[i + 2];
        if (equals === undefined || value === undefined || equals.value !== '=') {
            i += 1;
            continue;
        }
        if (value.value !== '{') {
            i += 3;
            continue;
        }
        const end = findBlockEnd(tokens, i + 2, limit);
        if (end < 0) {
            // Truncated block: keep what is there so the caller can report it.
            blocks.push({ rawKey: unquote(token.value), bodyStart: Math.min(i + 3, limit), bodyEnd: limit });
            break;
        }
        blocks.push({ rawKey: unquote(token.value), bodyStart: i + 3, bodyEnd: end });
        i = end + 1;
    }
    return blocks;
}

/**
 * spriteType blocks, including the ones vanilla wraps in `spriteTypes = { ... }`.
 * The container depth is bounded so no layout can recurse without end.
 */
function enumerateSpriteBlocks(tokens: readonly Token[]): RawBlock[] {
    const blocks: RawBlock[] = [];
    const visit = (from: number, to: number, depth: number): void => {
        for (const block of enumerateBlocks(tokens, from, to)) {
            if (block.rawKey.toLowerCase() === 'spritetype') blocks.push(block);
            else if (depth > 0) visit(block.bodyStart, block.bodyEnd, depth - 1);
        }
    };
    visit(0, tokens.length, SPRITE_CONTAINER_DEPTH);
    return blocks;
}

function appendField(fields: FieldMap, name: string, value: FieldValue): void {
    const existing = fields.get(name);
    if (existing === undefined) fields.set(name, [value]);
    else existing.push(value);
}

/** Fields of the block body [from, to), preserving the order of repeated keys. */
function readFields(tokens: readonly Token[], from: number, to: number): FieldMap {
    const fields: FieldMap = new Map();
    const limit = Math.min(to, tokens.length);
    let i = Math.max(0, from);
    while (i < limit) {
        const keyToken = tokens[i];
        const equals = tokens[i + 1];
        const value = tokens[i + 2];
        if (keyToken === undefined) break;
        if (equals === undefined || value === undefined || equals.value !== '=') {
            i += 1;
            continue;
        }
        const name = normalizeKey(keyToken.value);
        if (value.value === '{') {
            const end = findBlockEnd(tokens, i + 2, limit);
            if (end < 0) {
                appendField(fields, name, { kind: 'block', start: Math.min(i + 3, limit), end: limit });
                break;
            }
            appendField(fields, name, { kind: 'block', start: i + 3, end });
            i = end + 1;
            continue;
        }
        appendField(fields, name, { kind: 'scalar', text: unquote(value.value) });
        i += 3;
    }
    return fields;
}

function firstScalar(fields: FieldMap, name: string): string | undefined {
    const values = fields.get(name);
    if (values === undefined) return undefined;
    for (const value of values) {
        if (value.kind === 'scalar') return value.text;
    }
    return undefined;
}

function allScalars(fields: FieldMap, name: string): string[] {
    const values = fields.get(name);
    const out: string[] = [];
    if (values === undefined) return out;
    for (const value of values) {
        if (value.kind === 'scalar') out.push(value.text);
    }
    return out;
}

function firstBlock(fields: FieldMap, name: string): BlockField | undefined {
    const values = fields.get(name);
    if (values === undefined) return undefined;
    for (const value of values) {
        if (value.kind === 'block') return value;
    }
    return undefined;
}

// ── ship_sizes / section_templates ───────────────────────────────────────────

function readSectionSlots(tokens: readonly Token[], fields: FieldMap): ShipSectionSlot[] {
    const slots: ShipSectionSlot[] = [];
    const block = firstBlock(fields, 'section_slots');
    if (block === undefined) return slots;
    const limit = Math.min(block.end, tokens.length);
    let i = block.start;
    while (i < limit) {
        const nameToken = tokens[i];
        const equals = tokens[i + 1];
        const value = tokens[i + 2];
        if (nameToken === undefined) break;
        if (equals === undefined || value === undefined || equals.value !== '=') {
            i += 1;
            continue;
        }
        const slot = unquote(nameToken.value);
        if (value.value === '{') {
            const end = findBlockEnd(tokens, i + 2, limit);
            if (end < 0) break;
            const slotFields = readFields(tokens, i + 3, end);
            if (slot !== '') slots.push({ slot, locator: firstScalar(slotFields, 'locator') ?? '' });
            i = end + 1;
            continue;
        }
        if (slot !== '') slots.push({ slot, locator: unquote(value.value) });
        i += 3;
    }
    return slots;
}

/** `graphical_culture = no` (or yes) is a bare boolean word meaning "any culture", not a culture name. */
function isCultureBooleanWord(value: string): boolean {
    const lowered = value.toLowerCase();
    return lowered === 'no' || lowered === 'yes';
}

function readGraphicalCultures(tokens: readonly Token[], fields: FieldMap): string[] {
    const cultures: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string): void => {
        const name = unquote(candidate).trim();
        if (name === '') return;
        // Vanilla writes graphical_culture = no in 148 ship sizes to mean
        // "not restricted"; storing it as a culture name excluded them all.
        if (isCultureBooleanWord(name)) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        cultures.push(name);
    };
    for (const fieldName of ['graphical_culture', 'gfx_culture']) {
        const values = fields.get(fieldName);
        if (values === undefined) continue;
        for (const value of values) {
            if (value.kind === 'scalar') {
                push(value.text);
                continue;
            }
            const limit = Math.min(value.end, tokens.length);
            for (let i = value.start; i < limit; i++) {
                const token = tokens[i];
                if (token === undefined) break;
                if (token.type === TokenType.Identifier || token.type === TokenType.String) push(token.value);
            }
        }
    }
    return cultures;
}

function parseShipSizes(content: string, filePath: string, warnings: string[]): ShipSizeInfo[] {
    const tokens = tokenize(content);
    const sizes: ShipSizeInfo[] = [];
    for (const block of enumerateBlocks(tokens, 0, tokens.length)) {
        const fields = readFields(tokens, block.bodyStart, block.bodyEnd);
        const icon = firstScalar(fields, 'icon');
        if (icon === undefined || icon === '') continue;
        if (!SHIP_SIZE_MARKERS.some((marker) => fields.has(marker))) continue;
        const name = block.rawKey.toLowerCase() === 'ship_size'
            ? firstScalar(fields, 'name') ?? ''
            : block.rawKey;
        if (name === '') {
            warnings.push(`${filePath}: ship size block without a name`);
            continue;
        }
        const entity = firstScalar(fields, 'entity');
        const shipClass = firstScalar(fields, 'class');
        sizes.push({
            name,
            icon,
            entity: entity === undefined || entity === '' ? undefined : entity,
            shipClass: shipClass === undefined || shipClass === '' ? undefined : shipClass,
            sectionSlots: readSectionSlots(tokens, fields),
            graphicalCultures: readGraphicalCultures(tokens, fields),
        });
    }
    return sizes;
}

/** A script boolean written as `yes`, which is how vanilla spells true. */
function isAffirmative(value: string | undefined): boolean {
    return value !== undefined && value.toLowerCase() === 'yes';
}

function parseSectionTemplates(content: string, filePath: string, warnings: string[]): ShipSectionTemplateInfo[] {
    const tokens = tokenize(content);
    const templates: ShipSectionTemplateInfo[] = [];
    for (const block of enumerateBlocks(tokens, 0, tokens.length)) {
        if (block.rawKey.toLowerCase() !== 'ship_section_template') continue;
        const fields = readFields(tokens, block.bodyStart, block.bodyEnd);
        const key = firstScalar(fields, 'key');
        const slot = firstScalar(fields, 'fits_on_slot');
        const entity = firstScalar(fields, 'entity');
        const shipSizes = allScalars(fields, 'ship_size').filter((value) => value !== '');
        if (key === undefined || key === '' || slot === undefined || slot === '' ||
            entity === undefined || entity === '') {
            warnings.push(`${filePath}: ship section template is missing one of key/fits_on_slot/entity`);
            continue;
        }
        if (shipSizes.length === 0) {
            // grand_archive.txt's mutation_section has no ship_size and declares
            // compatible_with_all_ship_sizes = yes instead: it fits every size.
            if (!isAffirmative(firstScalar(fields, 'compatible_with_all_ship_sizes'))) {
                warnings.push(`${filePath}: ship section template is missing one of key/ship_size/fits_on_slot/entity`);
                continue;
            }
            templates.push({ key, shipSize: '', slot, entity });
            continue;
        }
        // An explicit ship_size stays authoritative when both forms are written.
        for (const shipSize of shipSizes) templates.push({ key, shipSize, slot, entity });
    }
    return templates;
}

// ── gfx: pdxmesh and sprite frames ───────────────────────────────────────────

interface SpriteDefinition {
    name: string;
    defaultFrame?: number;
    sheet?: string;
    frameCount?: number;
}

function parseSprites(content: string): SpriteDefinition[] {
    const tokens = tokenize(content);
    const sprites: SpriteDefinition[] = [];
    for (const block of enumerateSpriteBlocks(tokens)) {
        const fields = readFields(tokens, block.bodyStart, block.bodyEnd);
        const name = firstScalar(fields, 'name');
        if (name === undefined || name === '') continue;
        const sheet = firstScalar(fields, 'sprite_sheet_sprite_type');
        sprites.push({
            name,
            defaultFrame: parseCount(firstScalar(fields, 'default_frame')),
            sheet: sheet === undefined || sheet === '' ? undefined : sheet,
            // Field names are normalized to lower case by readFields.
            frameCount: parseCount(firstScalar(fields, 'noofframes')),
        });
    }
    return sprites;
}

// ── Data source walking ──────────────────────────────────────────────────────

async function readTextSafely(source: ShipIconDataSource, path: string): Promise<string | undefined> {
    try {
        const content = await source.readText(path);
        return typeof content === 'string' ? content : undefined;
    } catch {
        // An unavailable file is not fatal: the caller reports it via warnings.
        return undefined;
    }
}

/**
 * Breadth-first directory walk. A listing entry with a wanted extension is a
 * file; an entry without any extension is a directory to descend into. That
 * keeps the walk correct for data sources that list direct children as well as
 * for ones that return every path under the prefix.
 */
class DirectoryWalker {
    private readonly visited = new Set<string>();
    private remaining = MAX_DIRECTORY_VISITS;
    private exhausted = false;

    constructor(private readonly source: ShipIconDataSource, private readonly warnings: string[]) { }

    async collect(root: string, extensions: readonly string[]): Promise<string[]> {
        const start = normalizeRelativePath(root);
        if (start === undefined) return [];
        const found: string[] = [];
        const queue: string[] = [start];
        while (queue.length > 0) {
            const directory = queue.shift();
            if (directory === undefined) break;
            if (this.remaining <= 0) {
                if (!this.exhausted) {
                    this.exhausted = true;
                    this.warnings.push(`${root}: directory scan stopped after ${MAX_DIRECTORY_VISITS} entries`);
                }
                break;
            }
            const visitKey = directory.toLowerCase();
            if (this.visited.has(visitKey)) continue;
            this.visited.add(visitKey);
            this.remaining -= 1;
            for (const entry of await this.list(directory)) {
                const path = normalizeRelativePath(entry);
                if (path === undefined || path === directory) continue;
                if (!path.startsWith(`${directory}/`)) continue;
                const name = path.slice(path.lastIndexOf('/') + 1);
                if (name === '') continue;
                const lowered = name.toLowerCase();
                if (extensions.some((extension) => lowered.endsWith(extension))) {
                    found.push(path);
                    continue;
                }
                if (name.includes('.')) continue;
                queue.push(path);
            }
        }
        found.sort(comparePaths);
        return found;
    }

    private async list(directory: string): Promise<string[]> {
        try {
            const entries = await this.source.listFiles(directory);
            if (!Array.isArray(entries)) return [];
            return entries.filter((entry): entry is string => typeof entry === 'string').sort(comparePaths);
        } catch {
            return [];
        }
    }
}

/** First-level directory names under gfx/models/ships are the graphical cultures. */
async function listGraphicalCultures(source: ShipIconDataSource, directory: string): Promise<string[]> {
    const root = normalizeRelativePath(directory);
    if (root === undefined) return [];
    let entries: string[];
    try {
        const listed = await source.listFiles(root);
        entries = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
    const cultures: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const path = normalizeRelativePath(entry);
        if (path === undefined || !path.startsWith(`${root}/`)) continue;
        const segments = path.slice(root.length + 1).split('/');
        const name = segments[0];
        if (name === undefined || name === '' || name.includes('.')) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cultures.push(name);
    }
    cultures.sort(comparePaths);
    return cultures;
}

// ── Catalog loading ──────────────────────────────────────────────────────────

function createEmptyCatalog(): ShipIconCatalog {
    return {
        shipSizes: new Map(),
        sectionsByShipSize: new Map(),
        entityToPdxMesh: new Map(),
        pdxMeshToFile: new Map(),
        spriteFrameByIcon: new Map(),
        spriteSheetFrames: new Map(),
        spriteIconSheet: new Map(),
        graphicalCultures: [],
        warnings: [],
    };
}

interface RawEntity { name: string; pdxmesh?: string; clone?: string; }

/**
 * Attached child entity names per entity, keyed by the lower-cased entity name.
 *
 * This stays outside ShipIconCatalog on purpose: the published catalog contract
 * does not change, and a catalog this module did not build simply has no attach
 * chains, which is exactly the old behaviour.
 */
const attachChainsByCatalog = new WeakMap<ShipIconCatalog, Map<string, readonly string[]>>();

/** Child entity names of a defined entity, in definition order; empty when it attaches nothing. */
function attachChildrenOf(catalog: ShipIconCatalog, entityName: string): readonly string[] {
    const index = attachChainsByCatalog.get(catalog);
    if (index === undefined) return [];
    const children = index.get(entityName.toLowerCase());
    return children === undefined ? [] : children;
}

function loadEntities(catalog: ShipIconCatalog, assetFiles: Array<{ path: string; content: string }>): void {
    const raw: RawEntity[] = [];
    const cloneByName = new Map<string, string | undefined>();
    const attachIndex = new Map<string, readonly string[]>();
    for (const file of assetFiles) {
        let parsed: ReturnType<typeof parseAssetFile>;
        try {
            parsed = parseAssetFile(file.content, file.path);
        } catch {
            catalog.warnings.push(`${file.path}: entity definitions could not be parsed`);
            continue;
        }
        for (const entity of parsed.entities) {
            if (entity.name === '') continue;
            // The first definition of a name wins, the same rule entityToPdxMesh uses.
            const attachKey = entity.name.toLowerCase();
            if (!attachIndex.has(attachKey)) {
                const children: string[] = [];
                for (const attach of entity.attaches) {
                    const child = typeof attach.entityName === 'string' ? attach.entityName.trim() : '';
                    if (child !== '') children.push(child);
                }
                if (children.length > 0) attachIndex.set(attachKey, children);
            }
            if (catalog.entityToPdxMesh.has(entity.name)) continue;
            catalog.entityToPdxMesh.set(entity.name, entity.pdxmesh);
            raw.push({ name: entity.name, pdxmesh: entity.pdxmesh, clone: entity.clone });
            cloneByName.set(entity.name, entity.clone);
        }
    }
    attachChainsByCatalog.set(catalog, attachIndex);
    // Entities that only clone a parent inherit its mesh; the depth cap breaks cycles.
    for (const entity of raw) {
        if (entity.pdxmesh !== undefined || entity.clone === undefined) continue;
        let current: string | undefined = entity.clone;
        for (let depth = 0; depth < MAX_CLONE_DEPTH && current !== undefined; depth++) {
            const mesh = catalog.entityToPdxMesh.get(current);
            if (mesh !== undefined) {
                catalog.entityToPdxMesh.set(entity.name, mesh);
                break;
            }
            current = cloneByName.get(current);
        }
    }
}

function loadPdxMeshes(catalog: ShipIconCatalog, gfxFiles: Array<{ path: string; content: string }>): void {
    for (const file of gfxFiles) {
        let meshes: ReturnType<typeof parseGfxFile>;
        try {
            meshes = parseGfxFile(file.content);
        } catch {
            catalog.warnings.push(`${file.path}: pdxmesh definitions could not be parsed`);
            continue;
        }
        for (const mesh of meshes) {
            if (mesh.name === '' || catalog.pdxMeshToFile.has(mesh.name)) continue;
            const target = normalizeRelativePath(mesh.file);
            if (target === undefined) {
                catalog.warnings.push(`${file.path}: pdxmesh '${mesh.name}' has no usable file`);
                continue;
            }
            catalog.pdxMeshToFile.set(mesh.name, target);
        }
    }
}

function loadSprites(catalog: ShipIconCatalog, spriteFiles: Array<{ path: string; content: string }>): void {
    const sprites: SpriteDefinition[] = [];
    for (const file of spriteFiles) {
        try {
            sprites.push(...parseSprites(file.content));
        } catch {
            catalog.warnings.push(`${file.path}: sprite definitions could not be parsed`);
        }
    }
    // Only sheets that some sliced sprite points at need their frame count.
    const referencedSheets = new Set<string>();
    for (const sprite of sprites) {
        if (sprite.sheet !== undefined) referencedSheets.add(sprite.sheet.toLowerCase());
    }
    for (const sprite of sprites) {
        if (sprite.defaultFrame !== undefined && !catalog.spriteFrameByIcon.has(sprite.name)) {
            catalog.spriteFrameByIcon.set(sprite.name, sprite.defaultFrame);
        }
        if (sprite.sheet !== undefined && !catalog.spriteIconSheet.has(sprite.name)) {
            catalog.spriteIconSheet.set(sprite.name, sprite.sheet);
        }
        if (sprite.frameCount !== undefined && referencedSheets.has(sprite.name.toLowerCase()) &&
            !catalog.spriteSheetFrames.has(sprite.name)) {
            catalog.spriteSheetFrames.set(sprite.name, sprite.frameCount);
        }
    }
}

/**
 * Reads ship sizes, section templates, entities, pdxmesh files and sprite
 * frames and joins them into one catalog. Malformed input only ever produces
 * warnings; nothing here throws on bad data.
 */
export async function loadShipIconCatalog(source: ShipIconDataSource): Promise<ShipIconCatalog> {
    const catalog = createEmptyCatalog();
    const walker = new DirectoryWalker(source, catalog.warnings);

    const shipSizePaths = await walker.collect('common/ship_sizes', ['.txt']);
    const sectionPaths = await walker.collect('common/section_templates', ['.txt']);
    const gfxPaths = await walker.collect('gfx', ['.asset', '.gfx']);
    const interfacePaths = await walker.collect('interface', ['.gfx']);
    catalog.graphicalCultures = await listGraphicalCultures(source, 'gfx/models/ships');

    for (const path of shipSizePaths) {
        const content = await readTextSafely(source, path);
        if (content === undefined) continue;
        for (const info of parseShipSizes(content, path, catalog.warnings)) {
            if (catalog.shipSizes.has(info.name)) {
                catalog.warnings.push(`${path}: duplicate ship size '${info.name}' ignored`);
                continue;
            }
            catalog.shipSizes.set(info.name, info);
        }
    }

    // Templates that fit every ship size are held back and appended after all
    // size-specific candidates, so the default pick (the first candidate) of any
    // size that already resolves does not change, whatever the file order is.
    const universalTemplates: ShipSectionTemplateInfo[] = [];
    for (const path of sectionPaths) {
        const content = await readTextSafely(source, path);
        if (content === undefined) continue;
        for (const template of parseSectionTemplates(content, path, catalog.warnings)) {
            if (template.shipSize === '') {
                universalTemplates.push(template);
                continue;
            }
            const existing = catalog.sectionsByShipSize.get(template.shipSize);
            if (existing === undefined) catalog.sectionsByShipSize.set(template.shipSize, [template]);
            else existing.push(template);
        }
    }
    if (universalTemplates.length > 0) {
        // Every known size gets them, including sizes with no dedicated candidate.
        for (const shipSize of catalog.shipSizes.keys()) {
            // A template may spell ship_size in another case; appending under a
            // fresh key would shadow the candidates lookupSections already finds.
            const key = existingSectionKey(catalog, shipSize) ?? shipSize;
            const existing = catalog.sectionsByShipSize.get(key);
            if (existing === undefined) catalog.sectionsByShipSize.set(key, [...universalTemplates]);
            else existing.push(...universalTemplates);
        }
    }

    const gfxAssets: Array<{ path: string; content: string }> = [];
    const gfxFiles: Array<{ path: string; content: string }> = [];
    for (const path of gfxPaths) {
        const content = await readTextSafely(source, path);
        if (content === undefined) continue;
        if (path.toLowerCase().endsWith('.asset')) gfxAssets.push({ path, content });
        else gfxFiles.push({ path, content });
    }
    loadEntities(catalog, gfxAssets);
    loadPdxMeshes(catalog, gfxFiles);

    // Sprite definitions may live under interface/ (vanilla icons.gfx) or gfx/.
    const spritePaths = gfxPaths.filter((path) => path.toLowerCase().endsWith('.gfx')).concat(interfacePaths).sort(comparePaths);
    const spriteFiles: Array<{ path: string; content: string }> = [];
    for (const path of spritePaths) {
        const cached = gfxFiles.find((file) => file.path === path);
        const content = cached !== undefined ? cached.content : await readTextSafely(source, path);
        if (content === undefined) continue;
        spriteFiles.push({ path, content });
    }
    loadSprites(catalog, spriteFiles);

    return catalog;
}

// ── Resolution ───────────────────────────────────────────────────────────────

function lookupShipSize(catalog: ShipIconCatalog, name: string): ShipSizeInfo | undefined {
    const exact = catalog.shipSizes.get(name);
    if (exact !== undefined) return exact;
    const lowered = name.toLowerCase();
    const folded = catalog.shipSizes.get(lowered);
    if (folded !== undefined) return folded;
    for (const [key, info] of catalog.shipSizes) {
        if (key.toLowerCase() === lowered) return info;
    }
    return undefined;
}

function lookupSections(catalog: ShipIconCatalog, shipSize: string): ShipSectionTemplateInfo[] {
    const exact = catalog.sectionsByShipSize.get(shipSize);
    if (exact !== undefined) return exact;
    const lowered = shipSize.toLowerCase();
    const folded = catalog.sectionsByShipSize.get(lowered);
    if (folded !== undefined) return folded;
    for (const [key, sections] of catalog.sectionsByShipSize) {
        if (key.toLowerCase() === lowered) return sections;
    }
    return [];
}

/** The existing sectionsByShipSize key that serves this size, matched the way lookupSections matches it. */
function existingSectionKey(catalog: ShipIconCatalog, shipSize: string): string | undefined {
    if (catalog.sectionsByShipSize.has(shipSize)) return shipSize;
    const lowered = shipSize.toLowerCase();
    for (const key of catalog.sectionsByShipSize.keys()) {
        if (key.toLowerCase() === lowered) return key;
    }
    return undefined;
}

/**
 * First candidate for `slot`, or the candidate whose key matches `override`.
 *
 * A non-matching override returns undefined instead of silently falling back,
 * so the caller can report it and retry without the override.
 */
export function pickSectionForSlot(
    sections: readonly ShipSectionTemplateInfo[],
    slot: string,
    override?: string,
): ShipSectionTemplateInfo | undefined {
    const wantedSlot = slot.toLowerCase();
    const candidates = sections.filter((section) => section.slot.toLowerCase() === wantedSlot);
    if (candidates.length === 0) return undefined;
    if (override !== undefined) {
        const wantedKey = override.toLowerCase();
        return candidates.find((section) => section.key.toLowerCase() === wantedKey);
    }
    return candidates[0];
}

interface FrameResolution { frame: number; sheetFrames: number; }

function resolveFrame(catalog: ShipIconCatalog, icon: string | undefined, damaged: boolean, warnings: string[]): FrameResolution {
    const result: FrameResolution = { frame: 0, sheetFrames: 0 };
    if (icon === undefined || icon === '') {
        warnings.push('ship size has no icon, so no sprite frame could be resolved');
        return result;
    }
    const base = `GFX_${icon}_top`;
    let sprite = base;
    if (damaged) {
        const damagedSprite = `${base}_damaged`;
        if (catalog.spriteFrameByIcon.has(damagedSprite)) sprite = damagedSprite;
        else warnings.push(`damaged sprite '${damagedSprite}' is not defined; falling back to '${base}'`);
    }
    const frame = catalog.spriteFrameByIcon.get(sprite);
    if (frame === undefined) warnings.push(`sprite '${sprite}' has no default_frame`);
    else result.frame = frame;

    const sheet = catalog.spriteIconSheet.get(sprite);
    if (sheet === undefined) {
        warnings.push(`sprite '${sprite}' has no sprite sheet`);
        return result;
    }
    const frames = catalog.spriteSheetFrames.get(sheet);
    if (frames === undefined) warnings.push(`sprite sheet '${sheet}' has no noOfFrames`);
    else result.sheetFrames = frames;
    return result;
}

/** The catalog key an entity name resolves to, preferring the culture-prefixed spelling. */
function findEntityName(catalog: ShipIconCatalog, culture: string, entityName: string): string | undefined {
    if (culture !== '') {
        const prefixed = `${culture}_${entityName}`;
        if (catalog.entityToPdxMesh.has(prefixed)) return prefixed;
    }
    if (catalog.entityToPdxMesh.has(entityName)) return entityName;
    return undefined;
}

/**
 * Pre-order depth-first walk over an entity and its attach children, in definition
 * order, appending the .mesh file of every node that owns a resolvable pdxmesh.
 *
 * The entity's own geometry comes first, then each child's, then that child's
 * children; a node without a usable pdxmesh is simply descended into. `visited`
 * keeps a cyclic graph from looping and keeps one entity from being listed twice.
 */
function collectEntityMeshes(
    catalog: ShipIconCatalog,
    culture: string,
    entityName: string,
    depth: number,
    visited: Set<string>,
    out: string[],
): void {
    if (depth > MAX_ATTACH_DEPTH) return;
    const key = entityName.toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const mesh = catalog.entityToPdxMesh.get(entityName);
    if (mesh !== undefined && mesh !== '') {
        const file = catalog.pdxMeshToFile.get(mesh);
        if (file !== undefined) out.push(file);
    }
    for (const child of attachChildrenOf(catalog, entityName)) {
        const defined = findEntityName(catalog, culture, child);
        if (defined === undefined) continue;
        collectEntityMeshes(catalog, culture, defined, depth + 1, visited, out);
    }
}

/**
 * Mesh paths of an entity and of its attach chain, preferring the culture-prefixed
 * name.
 *
 * An entity that owns a pdxmesh keeps it first, but its attach children are still
 * followed: a hull that attaches its visible parts must not lose them. Attached
 * geometry is what makes an entity with no pdxmesh of its own resolvable at all.
 * When neither path yields a file the pre-attach warning semantics stay: one
 * warning naming the unresolved pdxmesh.
 */
function resolveEntityMeshes(
    catalog: ShipIconCatalog,
    culture: string,
    entityName: string,
    context: string,
    warnings: string[],
): string[] {
    const defined = findEntityName(catalog, culture, entityName);
    if (defined === undefined) {
        warnings.push(`entity '${entityName}' (${context}) is not defined for graphical culture '${culture === '' ? 'none' : culture}'`);
        return [];
    }
    const meshes: string[] = [];
    collectEntityMeshes(catalog, culture, defined, 0, new Set<string>(), meshes);
    if (meshes.length > 0) return meshes;
    const mesh = catalog.entityToPdxMesh.get(defined);
    if (mesh === undefined || mesh === '') {
        warnings.push(`entity '${defined}' (${context}) has no pdxmesh`);
    } else {
        warnings.push(`pdxmesh '${mesh}' of entity '${defined}' (${context}) has no mesh file`);
    }
    return [];
}

/** A single mesh path for one entity; manual override entries stay one entry, one mesh. */
function resolveEntityMesh(
    catalog: ShipIconCatalog,
    culture: string,
    entityName: string,
    context: string,
    warnings: string[],
): string | undefined {
    return resolveEntityMeshes(catalog, culture, entityName, context, warnings)[0];
}

/** An override entry names a .mesh file when it ends in .mesh (either slash direction). */
function isMeshPathEntry(entry: string): boolean {
    return entry.replace(/\\/g, '/').toLowerCase().endsWith('.mesh');
}

/**
 * One manual override entry to a mesh path: a .mesh path (normalized, relative
 * to the game root) or an entity name looked up culture-prefixed first.
 *
 * Entries are untrusted configuration, so anything unusable only warns.
 */
function resolveOverrideEntry(
    catalog: ShipIconCatalog,
    culture: string,
    entry: unknown,
    shipSize: string,
    warnings: string[],
): string | undefined {
    if (typeof entry !== 'string') {
        warnings.push(`override for ship size '${shipSize}' is not a string; ignored`);
        return undefined;
    }
    const text = entry.trim();
    if (text === '') {
        warnings.push(`override for ship size '${shipSize}' is empty; ignored`);
        return undefined;
    }
    if (isMeshPathEntry(text)) {
        // normalizeRelativePath also drops a leading './' and rejects any '..'.
        const path = normalizeRelativePath(text);
        if (path === undefined) {
            warnings.push(`override path '${text}' for ship size '${shipSize}' is not a usable path; ignored`);
            return undefined;
        }
        return path;
    }
    return resolveEntityMesh(catalog, culture, text, `ship size '${shipSize}' override`, warnings);
}

/** Own-property lookup so an inherited name such as 'constructor' cannot match. */
function lookupOverrideValue(overrides: Readonly<Record<string, unknown>>, shipSize: string): unknown {
    if (Object.prototype.hasOwnProperty.call(overrides, shipSize)) return overrides[shipSize];
    const lowered = shipSize.toLowerCase();
    for (const key of Object.keys(overrides)) {
        if (key.toLowerCase() === lowered) return overrides[key];
    }
    return undefined;
}

/** The non-empty override list of a size, or undefined to resolve it normally. */
function readOverrideEntries(
    options: ShipIconResolveOptions,
    shipSize: string,
    warnings: string[],
): readonly unknown[] | undefined {
    if (options.overrides === undefined) return undefined;
    const raw: unknown = lookupOverrideValue(options.overrides, shipSize);
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
        warnings.push(`overrides for ship size '${shipSize}' is not a list; ignored`);
        return undefined;
    }
    const entries: readonly unknown[] = raw;
    return entries.length > 0 ? entries : undefined;
}

function resolveSizeIcon(catalog: ShipIconCatalog, options: ShipIconResolveOptions, requested: string): ResolvedShipIcon {
    const warnings: string[] = [];
    const resolved: ResolvedShipIcon = { shipSize: requested, frame: 0, sheetFrames: 0, meshFiles: [], warnings };
    const info = lookupShipSize(catalog, requested);
    if (info === undefined) {
        warnings.push(`ship size '${requested}' is not defined`);
        return resolved;
    }
    const culture = options.graphicalCulture;
    if (info.graphicalCultures.length > 0 &&
        !info.graphicalCultures.some((entry) => entry.toLowerCase() === culture.toLowerCase())) {
        warnings.push(`ship size '${info.name}' is restricted to graphical cultures [${info.graphicalCultures.join(', ')}]; requested '${culture}'`);
    }
    const frames = resolveFrame(catalog, info.icon, options.damaged === true, warnings);
    resolved.frame = frames.frame;
    resolved.sheetFrames = frames.sheetFrames;

    // Manual entries replace the whole section_slots / entity lookup for this size.
    const manualEntries = readOverrideEntries(options, info.name, warnings);
    if (manualEntries !== undefined) {
        for (const entry of manualEntries) {
            const mesh = resolveOverrideEntry(catalog, culture, entry, info.name, warnings);
            if (mesh !== undefined) resolved.meshFiles.push(mesh);
        }
        return resolved;
    }

    if (info.sectionSlots.length > 0) {
        const sections = lookupSections(catalog, info.name);
        for (const slot of info.sectionSlots) {
            const overrideKey = `${info.name}:${slot.slot}`;
            const override = options.sectionOverrides === undefined ? undefined : options.sectionOverrides[overrideKey];
            const context = `ship size '${info.name}' slot '${slot.slot}'`;
            let picked = pickSectionForSlot(sections, slot.slot, override);
            if (picked === undefined && override !== undefined) {
                warnings.push(`section override '${override}' for '${overrideKey}' is not defined; falling back to the first candidate`);
                picked = pickSectionForSlot(sections, slot.slot);
            }
            if (picked === undefined) {
                warnings.push(`no section template for ${context}`);
                continue;
            }
            resolved.meshFiles.push(...resolveEntityMeshes(catalog, culture, picked.entity, context, warnings));
        }
        return resolved;
    }

    if (info.entity !== undefined && info.entity !== '') {
        const context = `ship size '${info.name}'`;
        resolved.meshFiles.push(...resolveEntityMeshes(catalog, culture, info.entity, context, warnings));
        return resolved;
    }

    warnings.push(`ship size '${info.name}' has neither section_slots nor entity`);
    return resolved;
}

/** Path identity for de-duplication: forward slashes, case-insensitive. */
function meshPathKey(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase();
}

/** Keeps the first occurrence of every mesh path, preserving order. */
function dedupeMeshFiles(files: readonly string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const file of files) {
        const key = meshPathKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(file);
    }
    return unique;
}

/** Keeps the first occurrence of every warning text, preserving order. */
function dedupeWarnings(warnings: readonly string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const warning of warnings) {
        if (seen.has(warning)) continue;
        seen.add(warning);
        unique.push(warning);
    }
    return unique;
}

/**
 * One size's icon, with repeats collapsed: several slots of one ship size often
 * point at the same section entity, and one locator-only mesh must not be listed
 * three to five times for one silhouette.
 */
function resolveOne(catalog: ShipIconCatalog, options: ShipIconResolveOptions, requested: string): ResolvedShipIcon {
    const resolved = resolveSizeIcon(catalog, options, requested);
    resolved.meshFiles = dedupeMeshFiles(resolved.meshFiles);
    resolved.warnings = dedupeWarnings(resolved.warnings);
    return resolved;
}

/** One entry per requested size, in request order, duplicates preserved. */
export function resolveShipIcons(catalog: ShipIconCatalog, options: ShipIconResolveOptions): ResolvedShipIcon[] {
    const resolved: ResolvedShipIcon[] = [];
    for (const shipSize of options.shipSizes) resolved.push(resolveOne(catalog, options, shipSize));
    return resolved;
}
