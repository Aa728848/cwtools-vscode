export type WorkspaceSymbolSource = 'script' | 'asset' | 'gui';
export type WorkspaceSymbolOrigin = 'workspace' | 'vanilla';

export interface WorkspaceSymbolEntry {
    name: string;
    kind: string;
    file: string;
    line: number;
    source: WorkspaceSymbolSource;
    container?: string;
    category?: string;
    origin?: WorkspaceSymbolOrigin;
    references?: WorkspaceSymbolReference[];
    updatedAt?: number;
    fileVersion?: number;
}

export interface WorkspaceSymbolReference {
    file: string;
    line: number;
    context: string;
}

export interface WorkspaceSymbolQuery {
    name?: string;
    kind?: string;
    category?: string;
    source?: WorkspaceSymbolSource;
    origin?: WorkspaceSymbolOrigin | 'both';
    directory?: string;
    prefix?: boolean;
    exact?: boolean;
    includeReferences?: boolean;
    limit?: number;
}

export interface WorkspaceSymbolParseOptions {
    updatedAt?: number;
    fileVersion?: number;
    origin?: WorkspaceSymbolOrigin;
    maxReferencesPerSymbol?: number;
}

interface OpenBlock {
    name: string;
    kind: string;
    source: WorkspaceSymbolSource;
    references?: WorkspaceSymbolReference[];
    entry?: WorkspaceSymbolEntry;
}

const SCRIPT_EXTENSIONS = new Set(['.txt']);
const NAMED_BLOCK_EXTENSIONS = new Set(['.gfx', '.asset', '.gui']);

export function isWorkspaceSymbolFile(filePath: string): boolean {
    const ext = getExtension(filePath);
    return SCRIPT_EXTENSIONS.has(ext) || NAMED_BLOCK_EXTENSIONS.has(ext);
}

export function parseWorkspaceSymbols(
    content: string,
    filePath: string,
    options: WorkspaceSymbolParseOptions = {}
): WorkspaceSymbolEntry[] {
    const ext = getExtension(filePath);
    let entries: WorkspaceSymbolEntry[];
    if (SCRIPT_EXTENSIONS.has(ext)) {
        entries = parseScriptSymbols(content, filePath);
    } else if (NAMED_BLOCK_EXTENSIONS.has(ext)) {
        entries = parseNamedBlockSymbols(
            content,
            filePath,
            ext === '.gui' ? 'gui' : 'asset',
            options.maxReferencesPerSymbol !== 0,
        );
    } else {
        return [];
    }
    applyEntryMetadata(entries, options);
    if (options.maxReferencesPerSymbol === 0) {
        for (const entry of entries) entry.references = undefined;
    } else {
        attachReferences(entries, content, filePath, options.maxReferencesPerSymbol ?? 20);
    }
    return entries;
}

export function addSymbolsToIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    entries: WorkspaceSymbolEntry[]
): void {
    for (const entry of entries) {
        const key = entry.name.toLowerCase();
        const bucket = index.get(key) ?? [];
        bucket.push(entry);
        index.set(key, bucket);
    }
}

export function sortedWorkspaceSymbolNames(index: Map<string, WorkspaceSymbolEntry[]>): string[] {
    return Array.from(index.keys()).sort((a, b) => a.localeCompare(b));
}

export function removeFileFromSymbolIndex(index: Map<string, WorkspaceSymbolEntry[]>, filePath: string): void {
    const normalizedFile = normalizePath(filePath);
    for (const [name, entries] of index.entries()) {
        const remaining = entries.filter(entry => normalizePath(entry.file) !== normalizedFile);
        if (remaining.length > 0) {
            index.set(name, remaining);
        } else {
            index.delete(name);
        }
    }
}

export function queryWorkspaceSymbolIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    query: WorkspaceSymbolQuery,
    sortedNames?: readonly string[],
): WorkspaceSymbolEntry[] {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, 200));
    const name = (query.name ?? '').trim();
    const kind = (query.kind ?? '').trim().toLowerCase();
    const category = (query.category ?? '').trim().toLowerCase();
    const source = query.source;
    const origin = query.origin && query.origin !== 'both' ? query.origin : undefined;
    const directory = query.directory ? normalizePath(query.directory).toLowerCase().replace(/^\/+|\/+$/g, '') : '';

    const nameLower = name.toLowerCase();
    const results: WorkspaceSymbolEntry[] = [];

    let buckets: Iterable<WorkspaceSymbolEntry[]>;
    if (name && query.exact) {
        buckets = [index.get(nameLower) ?? []];
    } else if (nameLower && query.prefix) {
        const names = sortedNames ?? sortedWorkspaceSymbolNames(index);
        const start = lowerBound(names, nameLower);
        const prefixBuckets: WorkspaceSymbolEntry[][] = [];
        for (let i = start; i < names.length; i++) {
            const key = names[i]!;
            if (!key.startsWith(nameLower)) break;
            const bucket = index.get(key);
            if (bucket) prefixBuckets.push(bucket);
        }
        buckets = prefixBuckets;
    } else {
        buckets = index.values();
    }

    for (const entries of buckets) {
        for (const entry of entries) {
            if (nameLower) {
                const entryName = entry.name.toLowerCase();
                if (query.exact && entryName !== nameLower) continue;
                if (query.prefix && !entryName.startsWith(nameLower)) continue;
                if (!query.exact && !query.prefix && !entryName.includes(nameLower)) continue;
            }
            if (kind && entry.kind.toLowerCase() !== kind) continue;
            if (category && (entry.category ?? '').toLowerCase() !== category) continue;
            if (source && entry.source !== source) continue;
            if (origin && (entry.origin ?? 'workspace') !== origin) continue;
            if (directory && !normalizePath(entry.file).toLowerCase().includes(`/${directory}/`)) continue;
            results.push(query.includeReferences ? entry : { ...entry, references: undefined });
            if (results.length >= limit) return results;
        }
    }

    return results;
}

export function populateWorkspaceSymbolReferences(
    entries: WorkspaceSymbolEntry[],
    fileContents: Map<string, string>,
    maxReferencesPerSymbol = 20,
): void {
    if (maxReferencesPerSymbol <= 0 || entries.length === 0 || fileContents.size === 0) return;
    for (const entry of entries) {
        entry.references = mergeReferences(
            entry.references,
            collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol),
            maxReferencesPerSymbol,
        );
    }
}

function applyEntryMetadata(entries: WorkspaceSymbolEntry[], options: WorkspaceSymbolParseOptions): void {
    if (options.updatedAt === undefined && options.fileVersion === undefined && options.origin === undefined) return;
    for (const entry of entries) {
        if (options.updatedAt !== undefined) entry.updatedAt = options.updatedAt;
        if (options.fileVersion !== undefined) entry.fileVersion = options.fileVersion;
        if (options.origin !== undefined) entry.origin = options.origin;
    }
}

export function rebuildWorkspaceSymbolReferences(
    index: Map<string, WorkspaceSymbolEntry[]>,
    fileContents: Map<string, string>,
    maxReferencesPerSymbol = 20
): void {
    if (maxReferencesPerSymbol <= 0) return;
    for (const entries of index.values()) {
        for (const entry of entries) {
            entry.references = mergeReferences(
                entry.references,
                collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol),
                maxReferencesPerSymbol
            );
        }
    }
}

function attachReferences(
    entries: WorkspaceSymbolEntry[],
    content: string,
    filePath: string,
    maxReferencesPerSymbol: number
): void {
    if (entries.length === 0 || maxReferencesPerSymbol <= 0) return;
    const fileContents = new Map<string, string>([[filePath, content]]);
    for (const entry of entries) {
        const refs = collectReferencesForEntry(entry, fileContents, maxReferencesPerSymbol);
        entry.references = mergeReferences(entry.references, refs, maxReferencesPerSymbol);
    }
}

function mergeReferences(
    existing: WorkspaceSymbolReference[] | undefined,
    additions: WorkspaceSymbolReference[],
    maxReferences: number
): WorkspaceSymbolReference[] | undefined {
    const merged: WorkspaceSymbolReference[] = [];
    const seen = new Set<string>();
    for (const ref of [...(existing ?? []), ...additions]) {
        const key = `${normalizePath(ref.file)}:${ref.line}:${ref.context}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ref);
        if (merged.length >= maxReferences) break;
    }
    return merged.length > 0 ? merged : undefined;
}

function collectReferencesForEntry(
    entry: WorkspaceSymbolEntry,
    fileContents: Map<string, string>,
    maxReferencesPerSymbol: number
): WorkspaceSymbolReference[] {
    const refs: WorkspaceSymbolReference[] = [];
    if (maxReferencesPerSymbol <= 0) return refs;
    const definitionFile = normalizePath(entry.file);
    const pattern = buildIdentifierRegex(entry.name);
    for (const [filePath, content] of fileContents.entries()) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && refs.length < maxReferencesPerSymbol; i++) {
            if (normalizePath(filePath) === definitionFile && i + 1 === entry.line) continue;
            const stripped = stripComment(lines[i] ?? '');
            pattern.lastIndex = 0;
            if (!pattern.test(stripped)) continue;
            refs.push({
                file: filePath,
                line: i + 1,
                context: stripped.trim().slice(0, 240),
            });
        }
        if (refs.length >= maxReferencesPerSymbol) break;
    }
    return refs;
}

function buildIdentifierRegex(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}([^A-Za-z0-9_.:-]|$)`, 'i');
}

function lowerBound(values: readonly string[], target: string): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + ((high - low) >> 1);
        if (values[middle]!.localeCompare(target) < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

function parseScriptSymbols(content: string, filePath: string): WorkspaceSymbolEntry[] {
    const entries: WorkspaceSymbolEntry[] = [];
    const lines = content.split(/\r?\n/);
    let depth = 0;
    let openBlock: OpenBlock | undefined;
    const normalizedFile = normalizePath(filePath);

    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i] ?? '');
        const beforeDepth = depth;

        const namespaceMatch = beforeDepth === 0
            ? line.match(/^\s*namespace\s*=\s*"?([A-Za-z0-9_.:-]+)"?/)
            : null;
        if (namespaceMatch?.[1]) {
            entries.push({
                name: namespaceMatch[1],
                kind: 'namespace',
                file: filePath,
                line: i + 1,
                source: 'script',
            });
        }

        const topBlockMatch = beforeDepth === 0
            ? line.match(/^\s*([A-Za-z0-9_.:-]+)\s*=\s*\{/)
            : null;
        if (topBlockMatch?.[1]) {
            const blockName = topBlockMatch[1];
            const classification = inferScriptClassification(normalizedFile, blockName);
            const kind = classification.kind;
            openBlock = { name: blockName, kind, source: 'script' };
            if (kind !== 'event_block') {
                entries.push({
                    name: blockName,
                    kind,
                    file: filePath,
                    line: i + 1,
                    source: 'script',
                    category: classification.category,
                });
            }
        } else if (openBlock?.kind === 'event_block') {
            const eventIdMatch = line.match(/^\s*id\s*=\s*"?([A-Za-z0-9_.:-]+)"?/);
            if (eventIdMatch?.[1]) {
                entries.push({
                    name: eventIdMatch[1],
                    kind: 'event',
                    file: filePath,
                    line: i + 1,
                    source: 'script',
                    container: openBlock.name,
                    category: 'event',
                });
            }
        }

        depth += countBracesOutsideStrings(line);
        if (openBlock && depth <= 0) {
            openBlock = undefined;
            depth = Math.max(0, depth);
        }
    }

    return entries;
}

function parseNamedBlockSymbols(
    content: string,
    filePath: string,
    source: WorkspaceSymbolSource,
    collectPropertyReferences: boolean,
): WorkspaceSymbolEntry[] {
    const entries: WorkspaceSymbolEntry[] = [];
    const lines = content.split(/\r?\n/);
    let depth = 0;
    let openBlock: OpenBlock | undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i] ?? '');
        const beforeDepth = depth;
        const topBlockMatch = beforeDepth <= 1
            ? line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*\{/)
            : null;

        if (topBlockMatch?.[1]) {
            const blockName = topBlockMatch[1];
            openBlock = {
                name: blockName,
                kind: source === 'gui' ? inferGuiKind(blockName) : inferAssetKind(blockName),
                source,
                references: [],
            };
        } else if (openBlock && beforeDepth > 0) {
            const assetRef = collectPropertyReferences ? toAssetPropertyReference(line, filePath, i + 1) : undefined;
            if (assetRef && openBlock.references) {
                openBlock.references.push(assetRef);
                if (openBlock.entry) {
                    openBlock.entry.references = openBlock.references.slice(0, 12);
                }
            }

            const nameMatch = line.match(/^\s*name\s*=\s*"?([^"#\r\n]+)"?/);
            const rawName = nameMatch?.[1]?.trim();
            if (rawName) {
                const entry: WorkspaceSymbolEntry = {
                    name: rawName,
                    kind: openBlock.kind,
                    file: filePath,
                    line: i + 1,
                    source,
                    container: openBlock.name,
                    category: source === 'gui' ? 'gui' : 'asset',
                    references: openBlock.references?.slice(0, 12),
                };
                openBlock.entry = entry;
                entries.push(entry);
            }
        }

        depth += countBracesOutsideStrings(line);
        if (openBlock && depth <= 1 && line.includes('}')) {
            openBlock = undefined;
        }
        depth = Math.max(0, depth);
    }

    return entries;
}

function toAssetPropertyReference(line: string, filePath: string, lineNumber: number): WorkspaceSymbolReference | undefined {
    if (!/^\s*(texturefile|textureFile|file|files?)\s*=/i.test(line)) return undefined;
    return {
        file: filePath,
        line: lineNumber,
        context: line.trim().slice(0, 240),
    };
}

function inferScriptClassification(normalizedFile: string, blockName: string): { kind: string; category: string } {
    const lower = normalizedFile.toLowerCase();
    const blockLower = blockName.toLowerCase();
    if (blockLower.endsWith('_event')) return { kind: 'event_block', category: 'event' };
    if (lower.includes('/events/')) return { kind: 'event_block', category: 'event' };

    const commonMatch = lower.match(/\/common\/([^/]+)\//);
    const commonDir = commonMatch?.[1] ?? '';
    const mapped = COMMON_DIR_KIND[commonDir];
    if (mapped) return { kind: mapped, category: 'game_entity' };

    return { kind: 'pdx_block', category: 'script' };
}

const COMMON_DIR_KIND: Record<string, string> = {
    scripted_triggers: 'scripted_trigger',
    scripted_effects: 'scripted_effect',
    technology: 'technology',
    technologies: 'technology',
    buildings: 'building',
    traits: 'trait',
    static_modifiers: 'static_modifier',
    deposits: 'deposit',
    edicts: 'edict',
    decisions: 'decision',
    on_actions: 'on_action',
    situations: 'situation_type',
    relics: 'relic',
    archaeological_site_types: 'archaeological_site_type',
    special_projects: 'special_project',
    event_chains: 'event_chain',
    ascension_perks: 'ascension_perk',
    traditions: 'tradition',
    tradition_categories: 'tradition_category',
    civics: 'civic',
    governments: 'government',
    authorities: 'authority',
    ethics: 'ethic',
    species_classes: 'species_class',
    species_names: 'species_name',
    solar_system_initializers: 'solar_system_initializer',
    star_classes: 'star_class',
    planet_classes: 'planet_class',
    pop_jobs: 'pop_job',
    districts: 'district',
    ship_sizes: 'ship_size',
    component_templates: 'component_template',
    section_templates: 'section_template',
    policies: 'policy',
    agendas: 'agenda',
};

function inferAssetKind(blockName: string): string {
    switch (blockName) {
        case 'spriteType':
        case 'corneredTileSpriteType':
            return 'sprite';
        case 'sound':
        case 'music':
            return 'sound';
        case 'entity':
        case 'pdxmesh':
        case 'animation':
            return 'asset';
        default:
            return blockName;
    }
}

function inferGuiKind(blockName: string): string {
    if (blockName.endsWith('Type')) return 'gui';
    return blockName;
}

function getExtension(filePath: string): string {
    const match = filePath.toLowerCase().match(/\.[^.\\/]+$/);
    return match?.[0] ?? '';
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function stripComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') {
            inString = !inString;
        }
        if (ch === '#' && !inString) {
            return line.slice(0, i);
        }
    }
    return line;
}

function countBracesOutsideStrings(line: string): number {
    let delta = 0;
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') delta++;
        if (ch === '}') delta--;
    }
    return delta;
}
