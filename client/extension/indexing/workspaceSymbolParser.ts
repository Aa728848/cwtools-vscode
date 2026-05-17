export type WorkspaceSymbolSource = 'script' | 'asset' | 'gui';

export interface WorkspaceSymbolEntry {
    name: string;
    kind: string;
    file: string;
    line: number;
    source: WorkspaceSymbolSource;
    container?: string;
    category?: string;
}

export interface WorkspaceSymbolQuery {
    name?: string;
    kind?: string;
    category?: string;
    source?: WorkspaceSymbolSource;
    directory?: string;
    prefix?: boolean;
    exact?: boolean;
    limit?: number;
}

interface OpenBlock {
    name: string;
    kind: string;
    source: WorkspaceSymbolSource;
}

const SCRIPT_EXTENSIONS = new Set(['.txt']);
const NAMED_BLOCK_EXTENSIONS = new Set(['.gfx', '.asset', '.gui']);

export function isWorkspaceSymbolFile(filePath: string): boolean {
    const ext = getExtension(filePath);
    return SCRIPT_EXTENSIONS.has(ext) || NAMED_BLOCK_EXTENSIONS.has(ext);
}

export function parseWorkspaceSymbols(content: string, filePath: string): WorkspaceSymbolEntry[] {
    const ext = getExtension(filePath);
    if (SCRIPT_EXTENSIONS.has(ext)) {
        return parseScriptSymbols(content, filePath);
    }
    if (NAMED_BLOCK_EXTENSIONS.has(ext)) {
        return parseNamedBlockSymbols(content, filePath, ext === '.gui' ? 'gui' : 'asset');
    }
    return [];
}

export function addSymbolsToIndex(
    index: Map<string, WorkspaceSymbolEntry[]>,
    entries: WorkspaceSymbolEntry[]
): void {
    for (const entry of entries) {
        const bucket = index.get(entry.name) ?? [];
        bucket.push(entry);
        index.set(entry.name, bucket);
    }
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
    query: WorkspaceSymbolQuery
): WorkspaceSymbolEntry[] {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, 200));
    const name = (query.name ?? '').trim();
    const kind = (query.kind ?? '').trim().toLowerCase();
    const category = (query.category ?? '').trim().toLowerCase();
    const source = query.source;
    const directory = query.directory ? normalizePath(query.directory).toLowerCase().replace(/^\/+|\/+$/g, '') : '';

    const candidates = name && query.exact
        ? (index.get(name) ?? [])
        : Array.from(index.values()).flat();

    const nameLower = name.toLowerCase();
    const results: WorkspaceSymbolEntry[] = [];

    for (const entry of candidates) {
        if (nameLower) {
            const entryName = entry.name.toLowerCase();
            if (query.exact && entryName !== nameLower) continue;
            if (query.prefix && !entryName.startsWith(nameLower)) continue;
            if (!query.exact && !query.prefix && !entryName.includes(nameLower)) continue;
        }
        if (kind && entry.kind.toLowerCase() !== kind) continue;
        if (category && (entry.category ?? '').toLowerCase() !== category) continue;
        if (source && entry.source !== source) continue;
        if (directory && !normalizePath(entry.file).toLowerCase().includes(`/${directory}/`)) continue;
        results.push(entry);
        if (results.length >= limit) break;
    }

    return results;
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
    source: WorkspaceSymbolSource
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
            };
        } else if (openBlock && beforeDepth > 0) {
            const nameMatch = line.match(/^\s*name\s*=\s*"?([^"#\r\n]+)"?/);
            const rawName = nameMatch?.[1]?.trim();
            if (rawName) {
                entries.push({
                    name: rawName,
                    kind: openBlock.kind,
                    file: filePath,
                    line: i + 1,
                    source,
                    container: openBlock.name,
                    category: source === 'gui' ? 'gui' : 'asset',
                });
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
