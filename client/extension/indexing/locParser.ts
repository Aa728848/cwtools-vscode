/**
 * Localisation File Parser — Pure Functions
 *
 * Extracted from IndexService for testability.
 * No vscode or Node dependencies — works in any JS environment.
 */

import type { LocEntry } from './indexService';

/**
 * Parse a Paradox localisation YML file content into LocEntry items.
 *
 * Format:
 *   l_english:
 *    key:0 "value"
 *    key2: "value2"
 *
 * @param content - raw file content (may have \r\n or \n)
 * @param filePath - absolute path to the file (stored in entries)
 */
export function parseLocFile(content: string, filePath: string): LocEntry[] {
	const entries: LocEntry[] = [];
	const lines = content.split(/\r?\n/);

	// Detect language from header (e.g. "l_english:")
	let language = '';
	const headerMatch = content.match(/^\s*(l_\w+)\s*:/m);
	if (headerMatch) {
		language = headerMatch[1]!;
	}

	// Parse key-value pairs: "  key:0 \"value\""
	const kvRegex = /^\s+(\S+?):\d*\s+"(.*)"\s*$/;
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(kvRegex);
		if (!match) continue;

		entries.push({
			key: match[1]!,
			value: match[2]!,
			file: filePath,
			line: i + 1,
			language,
		});
	}

	return entries;
}

/**
 * Detect the localisation language tag from file content.
 * Returns empty string if no header is found.
 */
export function detectLocLanguage(content: string): string {
	const m = content.match(/^\s*(l_\w+)\s*:/m);
	return m ? m[1]! : '';
}

// ─── In-memory index helpers (pure, no vscode) ──────────────────────────────

/**
 * Add parsed entries to an in-memory loc index map.
 */
export function addEntriesToIndex(
	index: Map<string, LocEntry[]>,
	entries: LocEntry[],
): void {
	for (const entry of entries) {
		const existing = index.get(entry.key);
		if (existing) {
			existing.push(entry);
		} else {
			index.set(entry.key, [entry]);
		}
	}
}

/**
 * Remove all entries from a specific file from the index.
 */
export function removeFileFromIndex(
	index: Map<string, LocEntry[]>,
	filePath: string,
): void {
	for (const [key, entries] of index.entries()) {
		const filtered = entries.filter(e => e.file !== filePath);
		if (filtered.length === 0) {
			index.delete(key);
		} else {
			index.set(key, filtered);
		}
	}
}

/**
 * Query the localisation index.
 */
export function queryLocIndex(
	index: Map<string, LocEntry[]>,
	query: { key?: string; language?: string; prefix?: boolean; contains?: boolean; caseSensitive?: boolean; limit?: number },
): LocEntry[] {
	const limit = query.limit ?? 100;
	const results: LocEntry[] = [];
	const queryKey = query.key ?? '';
	const queryComparable = query.caseSensitive ? queryKey : queryKey.toLowerCase();

	if (query.key && !query.prefix && !query.contains) {
		// Exact match
		const entries = index.get(query.key) ?? [];
		for (const entry of entries) {
			if (query.language && entry.language !== query.language) continue;
			results.push(entry);
			if (results.length >= limit) break;
		}
	} else if (query.key && (query.prefix || query.contains)) {
		// Prefix / contains match
		for (const [key, entries] of index.entries()) {
			const comparable = query.caseSensitive ? key : key.toLowerCase();
			const matched = query.contains
				? comparable.includes(queryComparable)
				: comparable.startsWith(queryComparable);
			if (!matched) continue;
			for (const entry of entries) {
				if (query.language && entry.language !== query.language) continue;
				results.push(entry);
				if (results.length >= limit) return results;
			}
		}
	} else {
		// Return all (up to limit)
		for (const entries of index.values()) {
			for (const entry of entries) {
				if (query.language && entry.language !== query.language) continue;
				results.push(entry);
				if (results.length >= limit) return results;
			}
		}
	}

	return results;
}
