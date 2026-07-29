import type { GameProfile } from './gameProfiles';
import type { PdxDirectoryPath } from '../shared/pdxSemanticCatalog';

export type DirectorySuggestionSource = 'cwt' | 'profile' | 'vanilla';
export type DirectorySuggestionConfidence = 'authoritative' | 'conventional' | 'observed';
export type DirectorySuggestionKind =
    | 'script'
    | 'event'
    | 'localisation'
    | 'gui'
    | 'graphics'
    | 'sound'
    | 'map'
    | 'history'
    | 'other';

export interface DirectorySuggestion {
    segment: string;
    relativePath: string;
    sources: DirectorySuggestionSource[];
    confidence: DirectorySuggestionConfidence;
    kinds: DirectorySuggestionKind[];
    entityTypes: string[];
}

export interface ExistingDirectoryEntry {
    name: string;
    type: 'directory' | 'file';
}

export interface AggregateDirectorySuggestionsInput {
    parentRelativePath: string;
    gameId: string;
    cwtPaths: readonly PdxDirectoryPath[];
    profile?: GameProfile;
    vanillaChildNames: readonly string[];
    existingEntries: readonly ExistingDirectoryEntry[];
    caseInsensitive: boolean;
}

export type RelativeDirectoryValidation =
    | { ok: true; path: string; segments: string[] }
    | { ok: false; reason: 'empty' | 'absolute' | 'unsafe_segment' | 'invalid_name' };

export interface UriPathIdentity {
    scheme: string;
    authority: string;
    path: string;
}

const SOURCE_ORDER: Readonly<Record<DirectorySuggestionSource, number>> = {
    cwt: 0,
    profile: 1,
    vanilla: 2,
};
const CONFIDENCE_ORDER: Readonly<Record<DirectorySuggestionConfidence, number>> = {
    authoritative: 0,
    conventional: 1,
    observed: 2,
};
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_INVALID_NAME_PATTERN = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DEPRECATED_LOCALISATION_DIRECTORY = 'localisation_synced';

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedKey(value: string, caseInsensitive: boolean): string {
    return caseInsensitive ? value.toLowerCase() : value;
}

export function validateRelativeDirectoryPath(value: string, windowsNames: boolean): RelativeDirectoryValidation {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if (trimmed.startsWith('/') || trimmed.startsWith('\\') || URI_SCHEME_PATTERN.test(trimmed)) {
        return { ok: false, reason: 'absolute' };
    }
    const slashPath = trimmed.replace(/\\/g, '/');
    const segments = slashPath.split('/');
    if (segments.length === 0 || segments.some(segment =>
        !segment || segment === '.' || segment === '..'
        || segment.includes('\0') || URI_SCHEME_PATTERN.test(segment))) {
        return { ok: false, reason: 'unsafe_segment' };
    }
    if (windowsNames && segments.some(segment =>
        WINDOWS_INVALID_NAME_PATTERN.test(segment)
        || /[. ]$/.test(segment)
        || WINDOWS_RESERVED_NAME_PATTERN.test(segment))) {
        return { ok: false, reason: 'invalid_name' };
    }
    return { ok: true, path: segments.join('/'), segments };
}

export function normalizeWorkspaceRelativePath(value: string): string | undefined {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) return '';
    const validation = validateRelativeDirectoryPath(normalized, false);
    return validation.ok ? validation.path : undefined;
}

export function isUriPathWithin(
    root: UriPathIdentity,
    target: UriPathIdentity,
    caseInsensitive: boolean,
): boolean {
    if (root.scheme !== target.scheme || root.authority !== target.authority) return false;
    const normalize = (value: string) => {
        const path = value.replace(/\/+$/, '') || '/';
        return caseInsensitive ? path.toLowerCase() : path;
    };
    const rootPath = normalize(root.path);
    const targetPath = normalize(target.path);
    return targetPath === rootPath || targetPath.startsWith(rootPath === '/' ? '/' : `${rootPath}/`);
}

export function relativeUriPathWithin(
    root: UriPathIdentity,
    target: UriPathIdentity,
    caseInsensitive: boolean,
): string | undefined {
    if (!isUriPathWithin(root, target, caseInsensitive)) return undefined;
    const rootPath = root.path.replace(/\/+$/, '');
    return normalizeWorkspaceRelativePath(target.path.slice(rootPath.length).replace(/^\/+/, ''));
}

function classifyDirectory(relativePath: string): DirectorySuggestionKind {
    const segments = relativePath.toLowerCase().split('/');
    const first = segments[0] ?? '';
    if (first === 'events') return 'event';
    if (first === 'localisation' || first === 'localization' || first === DEPRECATED_LOCALISATION_DIRECTORY) return 'localisation';
    if (first === 'interface' || first === 'gui') return 'gui';
    if (first === 'gfx' || first === 'graphics' || first === 'flags') return 'graphics';
    if (first === 'sound' || first === 'music') return 'sound';
    if (first === 'map' || first === 'map_data' || first === 'setup') return 'map';
    if (first === 'history') return 'history';
    if (first === 'common' || first === 'decisions' || first === 'missions'
        || first === 'prescripted_countries' || first === 'poptypes' || first === 'units') return 'script';
    return 'other';
}

function profilePaths(profile: GameProfile): Array<{ path: string; kind: DirectorySuggestionKind }> {
    const paths: Array<{ path: string; kind: DirectorySuggestionKind }> = [];
    for (const path of profile.folders.scriptDirs) paths.push({ path, kind: classifyDirectory(path) });
    for (const path of profile.folders.guiDirs) paths.push({ path, kind: 'gui' });
    for (const path of profile.folders.gfxDirs) paths.push({ path, kind: 'graphics' });
    for (const path of profile.localisation.directories) paths.push({ path, kind: 'localisation' });
    return paths;
}

function directChild(path: string, parentRelativePath: string, caseInsensitive: boolean): { segment: string; relativePath: string } | undefined {
    const pathValue = normalizeWorkspaceRelativePath(path);
    if (pathValue === undefined) return undefined;
    const pathSegments = pathValue ? pathValue.split('/') : [];
    const parentSegments = parentRelativePath ? parentRelativePath.split('/') : [];
    if (pathSegments.length <= parentSegments.length) return undefined;
    for (let index = 0; index < parentSegments.length; index++) {
        if (normalizedKey(pathSegments[index] ?? '', caseInsensitive)
            !== normalizedKey(parentSegments[index] ?? '', caseInsensitive)) return undefined;
    }
    const segment = pathSegments[parentSegments.length];
    if (!segment) return undefined;
    return {
        segment,
        relativePath: [...parentSegments, segment].join('/'),
    };
}

function isDeprecatedForSource(
    gameId: string,
    relativePath: string,
    source: DirectorySuggestionSource,
    profile: GameProfile | undefined,
): boolean {
    const finalSegment = relativePath.split('/').pop()?.toLowerCase();
    if (finalSegment && profile?.folders.deprecatedDirs
        ?.some(directory => directory.toLowerCase() === finalSegment)) return true;
    if (finalSegment !== DEPRECATED_LOCALISATION_DIRECTORY) return false;
    return gameId !== 'paradox' || source !== 'cwt';
}

export function aggregateDirectorySuggestions(input: AggregateDirectorySuggestionsInput): DirectorySuggestion[] {
    const parent = normalizeWorkspaceRelativePath(input.parentRelativePath);
    if (parent === undefined) return [];
    interface MutableSuggestion {
        segment: string;
        relativePath: string;
        sources: Set<DirectorySuggestionSource>;
        kinds: Set<DirectorySuggestionKind>;
        entityTypes: Set<string>;
    }
    const suggestions = new Map<string, MutableSuggestion>();
    const add = (
        path: string,
        source: DirectorySuggestionSource,
        kind: DirectorySuggestionKind,
        entityTypes: readonly string[] = [],
    ): void => {
        const child = directChild(path, parent, input.caseInsensitive);
        if (!child || isDeprecatedForSource(input.gameId, child.relativePath, source, input.profile)) return;
        const key = normalizedKey(child.relativePath, input.caseInsensitive);
        const existing = suggestions.get(key);
        if (existing) {
            existing.sources.add(source);
            existing.kinds.add(kind);
            for (const entityType of entityTypes) {
                const normalized = entityType.trim().toLowerCase();
                if (normalized) existing.entityTypes.add(normalized);
            }
            return;
        }
        suggestions.set(key, {
            segment: child.segment,
            relativePath: child.relativePath,
            sources: new Set([source]),
            kinds: new Set([kind]),
            entityTypes: new Set(entityTypes.map(value => value.trim().toLowerCase()).filter(Boolean)),
        });
    };

    for (const item of input.cwtPaths) add(item.path, 'cwt', classifyDirectory(item.path), item.entityTypes);
    if (input.profile) {
        for (const item of profilePaths(input.profile)) add(item.path, 'profile', item.kind);
    }
    for (const childName of input.vanillaChildNames) {
        const path = parent ? `${parent}/${childName}` : childName;
        add(path, 'vanilla', classifyDirectory(path));
    }

    const existing = new Set(input.existingEntries.map(entry => normalizedKey(entry.name, input.caseInsensitive)));
    const results: DirectorySuggestion[] = [];
    for (const suggestion of suggestions.values()) {
        if (existing.has(normalizedKey(suggestion.segment, input.caseInsensitive))) {
            continue;
        }
        const sources = Array.from(suggestion.sources).sort((left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right]);
        results.push({
            segment: suggestion.segment,
            relativePath: suggestion.relativePath,
            sources,
            confidence: sources.includes('cwt')
            ? 'authoritative'
            : sources.includes('profile') ? 'conventional' : 'observed',
            kinds: Array.from(suggestion.kinds).sort(compareText),
            entityTypes: Array.from(suggestion.entityTypes).sort(compareText),
        });
    }
    return results.sort((left, right) =>
        CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence]
        || Number(right.entityTypes.length > 0) - Number(left.entityTypes.length > 0)
        || compareText(normalizedKey(left.segment, input.caseInsensitive), normalizedKey(right.segment, input.caseInsensitive))
        || compareText(left.segment, right.segment));
}

export interface DirectoryCacheCancellation {
    readonly isCancellationRequested: boolean;
}

interface DirectoryCacheEntry {
    value: string[];
    readAt: number;
}

/** Bounded LRU/TTL cache for sorted, immediate vanilla child-directory names. */
export class VanillaDirectoryCache {
    private readonly entries = new Map<string, DirectoryCacheEntry>();
    private disposed = false;

    constructor(
        private readonly maxEntries = 128,
        private readonly ttlMs = 5 * 60_000,
        private readonly now: () => number = Date.now,
    ) {}

    async get(
        key: string,
        token: DirectoryCacheCancellation,
        loader: () => Promise<readonly string[]>,
    ): Promise<string[]> {
        if (this.disposed || token.isCancellationRequested) return [];
        const cached = this.entries.get(key);
        if (cached && this.now() - cached.readAt <= this.ttlMs) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return [...cached.value];
        }
        if (cached) this.entries.delete(key);
        const loaded = Array.from(new Set(await loader())).sort(compareText);
        if (this.disposed || token.isCancellationRequested) return [];
        this.entries.set(key, { value: loaded, readAt: this.now() });
        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.entries.delete(oldestKey);
        }
        return [...loaded];
    }

    clear(): void {
        this.entries.clear();
    }

    dispose(): void {
        this.disposed = true;
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

/** Monotonic request generation used by UI callers to enforce latest-wins updates. */
export class LatestDirectoryRequest {
    private generation = 0;

    begin(): number {
        this.generation += 1;
        return this.generation;
    }

    isCurrent(generation: number): boolean {
        return generation === this.generation;
    }

    cancel(): void {
        this.generation += 1;
    }
}
