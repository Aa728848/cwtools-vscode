/**
 * Ship Design Display-Name Localisation Resolver.
 *
 * Resolves component, section, and ship-size display names using the workspace
 * `IndexService` first and falling back to bounded, per-language cached `.yml`
 * scans, expanding nested `$KEY$` references up to a fixed round limit.
 */

import type { ShipIconDataSource } from '../shipIcon/shipIconDefinitions';
import type { IndexService, LocEntry } from '../indexing/indexService';
import { parseLocFile } from '../indexing/locParser';
import { pickPreferredLocalisationEntry } from '../localisationLanguagePreference';
import {
    collectLocalisationReferences,
    resolveLocalisationReferences,
    toDisplayLocalisationValue,
} from '../ai/targetWeightExtract';

const MAX_LOC_FILES_PER_LANGUAGE = 512;
const MAX_LOC_ENTRIES_PER_LANGUAGE = 200000;
const MAX_REFERENCE_ROUNDS = 4;
const MAX_REFERENCE_KEYS_PER_ROUND = 48;

export interface ShipDesignLocalisationCache {
    languages: Map<string, Promise<RawEntry[]>>;
}

export interface ShipDesignLocalisationOptions {
    source: ShipIconDataSource;
    ids: readonly string[];
    preferredTags: readonly string[];
    indexService?: Pick<IndexService, 'queryLocalisationAsync'>;
    cache?: ShipDesignLocalisationCache;
}

interface RawEntry {
    key: string;
    value: string;
    language?: string;
}

function displayKeys(id: string): string[] {
    return [...new Set([id, id.toUpperCase()])];
}

async function parseLanguage(
    source: ShipIconDataSource,
    tag: string,
): Promise<RawEntry[]> {
    const directory = tag.replace(/^l_/, '');
    if (!directory) return [];
    const root = 'localisation/' + directory;
    const listed = await source.listFiles(root);
    const files = listed.filter(file => file.toLowerCase().endsWith('.yml')).sort().slice(0, MAX_LOC_FILES_PER_LANGUAGE);
    const entries: RawEntry[] = [];
    for (const file of files) {
        const content = await source.readText(file);
        if (content === undefined) continue;
        for (const entry of parseLocFile(content, file)) {
            entries.push({ key: entry.key, value: entry.value, language: tag });
            if (entries.length >= MAX_LOC_ENTRIES_PER_LANGUAGE) return entries;
        }
    }
    return entries;
}

export async function resolveShipDesignDisplayNames(
    options: ShipDesignLocalisationOptions,
): Promise<Map<string, string>> {
    const ids = [...new Set(options.ids.filter(id => id.trim().length > 0))];
    const raw = new Map<string, string>();
    const languageCache = options.cache?.languages ?? new Map<string, Promise<RawEntry[]>>();

    const languageEntries = (tag: string): Promise<RawEntry[]> => {
        let cached = languageCache.get(tag);
        if (!cached) {
            cached = parseLanguage(options.source, tag).catch(() => []);
            languageCache.set(tag, cached);
        }
        return cached;
    };

    const lookupBatch = async (batch: readonly string[]): Promise<void> => {
        const remaining = new Set(batch.filter(id => !raw.has(id)));
        const keyToId = new Map<string, string>();
        for (const id of remaining) for (const key of displayKeys(id)) keyToId.set(key, id);

        if (options.indexService) {
            for (const id of [...remaining]) {
                for (const key of displayKeys(id)) {
                    let entries: LocEntry[] = [];
                    try {
                        entries = await options.indexService.queryLocalisationAsync({ key, limit: 64 });
                    } catch { /* Fall through to layered files. */ }
                    const entry = pickPreferredLocalisationEntry(entries, options.preferredTags);
                    if (entry) {
                        raw.set(id, entry.value);
                        remaining.delete(id);
                        break;
                    }
                }
            }
        }

        for (const tag of options.preferredTags) {
            if (remaining.size === 0) break;
            const entries = await languageEntries(tag);
            for (const entry of entries) {
                const id = keyToId.get(entry.key);
                if (!id || !remaining.has(id)) continue;
                raw.set(id, entry.value);
                remaining.delete(id);
                if (remaining.size === 0) break;
            }
        }
    };

    await lookupBatch(ids);
    const references = new Map<string, string>();
    for (let round = 0; round < MAX_REFERENCE_ROUNDS; round++) {
        const pending = new Set<string>();
        for (const value of raw.values()) {
            for (const reference of collectLocalisationReferences(value)) {
                if (!references.has(reference) && !raw.has(reference)) pending.add(reference);
            }
        }
        if (pending.size === 0) break;
        const batch = [...pending].slice(0, MAX_REFERENCE_KEYS_PER_ROUND);
        const before = new Map(raw);
        await lookupBatch(batch);
        for (const key of batch) {
            const value = raw.get(key);
            if (value !== undefined) references.set(key, value);
        }
        for (const [key, value] of before) if (!raw.has(key)) raw.set(key, value);
    }

    const result = new Map<string, string>();
    const lookup = (key: string): string | undefined => references.get(key) ?? raw.get(key);
    for (const id of ids) {
        const value = raw.get(id);
        const display = toDisplayLocalisationValue(value === undefined
            ? undefined
            : resolveLocalisationReferences(value, lookup));
        if (display) result.set(id, display);
    }
    return result;
}
