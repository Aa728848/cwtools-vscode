/**
 * Localisation File Parser — Pure Functions
 *
 * Extracted from IndexService for testability.
 * No vscode or Node dependencies — works in any JS environment.
 */

import type { LocEntry } from './indexService';

export interface ParsedLocalisationLine {
	key: string;
	version?: string;
	value: string;
	rawValue: string;
	valueStart: number;
	valueEnd: number;
}

export type LocalisationRichTokenType =
	| 'colorMarker'
	| 'colorRange'
	| 'icon'
	| 'parameter'
	| 'scriptedVariable'
	| 'scopeExpression'
	| 'command'
	| 'concept';

export interface LocalisationRichToken {
	type: LocalisationRichTokenType;
	start: number;
	end: number;
	text: string;
	marker?: string;
	colorCode?: string;
}

export const LOCALISATION_COLOR_MAP: Record<string, string> = {
	'\u00a7R': '#FF4444',
	'\u00a7G': '#00CC00',
	'\u00a7B': '#4488FF',
	'\u00a7Y': '#FFFF00',
	'\u00a7W': '#FFFFFF',
	'\u00a7H': '#FFD700',
	'\u00a7E': '#00CED1',
	'\u00a7T': '#BBBBBB',
	'\u00a7L': '#CCAA55',
	'\u00a7M': '#FF44FF',
	'\u00a7S': '#AADDAA',
	'\u00a7P': '#FFA4E4',
	'\u00a7r': '#9849FF',
	'\u00a7O': '#FF9D3D',
	'\u00a7C': '#42D9F5',
	'\u00a7K': '#8A8A8A',
	'\u00a7g': '#00CC00',
	'\u00a7b': '#4488FF',
	'\u00a7y': '#FFFF00',
	'\u00a7w': '#FFFFFF',
};

const COLOR_MARKER_RE = /\u00a7[A-Za-z0-9!%-]/g;

function isWhitespace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t';
}

function skipHorizontalWhitespace(text: string, offset: number): number {
	let i = offset;
	while (i < text.length && isWhitespace(text[i])) i++;
	return i;
}

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= '0' && ch <= '9';
}

function findClosingQuote(text: string, start: number, quote: string): number {
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === quote) return i;
	}
	return -1;
}

function findUnquotedValueEnd(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		if (text[i] === '#' && (i === start || isWhitespace(text[i - 1]))) {
			return i;
		}
	}
	return text.length;
}

function findUnescapedChar(text: string, needle: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === needle) return i;
	}
	return -1;
}

function isColorMarkerCode(ch: string | undefined): boolean {
	return ch !== undefined && /^[A-Za-z0-9!%-]$/.test(ch);
}

function isIconNameChar(ch: string | undefined): boolean {
	return ch !== undefined && /^[A-Za-z0-9_.-]$/.test(ch);
}

function isIconArgumentChar(ch: string | undefined): boolean {
	return ch !== undefined && !isWhitespace(ch) && ch !== '\u00a3' && ch !== '"' && ch !== '[' && ch !== ']';
}

function isParameterBody(body: string): boolean {
	return body.length > 0 && !/\s/.test(body) && /^[A-Za-z0-9_@.:'|+%/-]+$/.test(body);
}

function isScriptedVariableStart(text: string, index: number): boolean {
	const next = text[index + 1];
	if (next === undefined || !/^[A-Za-z_]$/.test(next)) return false;
	const prev = text[index - 1];
	return prev === undefined || !/^[A-Za-z0-9_]$/.test(prev);
}

function readScriptedVariable(text: string, index: number): number {
	let end = index + 2;
	while (end < text.length && /^[A-Za-z0-9_.:-]$/.test(text[end]!)) end++;
	return end;
}

function readIconToken(text: string, index: number, baseOffset: number): LocalisationRichToken | undefined {
	let end = index + 1;
	if (!isIconNameChar(text[end])) return undefined;

	while (end < text.length && isIconNameChar(text[end])) end++;
	if (text[end] === '|') {
		end++;
		while (end < text.length && isIconArgumentChar(text[end])) end++;
	}
	if (text[end] === '\u00a3') end++;

	return {
		type: 'icon',
		start: baseOffset + index,
		end: baseOffset + end,
		text: text.slice(index, end),
	};
}

function tokenSort(a: LocalisationRichToken, b: LocalisationRichToken): number {
	if (a.start !== b.start) return a.start - b.start;
	if (a.end !== b.end) return a.end - b.end;
	return a.type.localeCompare(b.type);
}

/**
 * Parse one localisation entry line.
 *
 * Handles escaped quotes and comments after quoted values without treating
 * # inside a value as a line comment. The returned offsets point at the raw
 * value content, excluding surrounding quotes when present.
 */
export function parseLocalisationLine(line: string): ParsedLocalisationLine | undefined {
	const match = line.match(/^\uFEFF?\s*([^\s:#][^\s:]*)\s*:/);
	if (!match) return undefined;

	const key = match[1]!;
	let cursor = match[0].length;
	cursor = skipHorizontalWhitespace(line, cursor);

	let version: string | undefined;
	const versionStart = cursor;
	while (isDigit(line[cursor])) cursor++;
	if (cursor > versionStart && (line[cursor] === undefined || isWhitespace(line[cursor]) || line[cursor] === '"' || line[cursor] === '\'')) {
		version = line.slice(versionStart, cursor);
		cursor = skipHorizontalWhitespace(line, cursor);
	} else {
		cursor = versionStart;
	}

	if (cursor >= line.length || line[cursor] === '#') return undefined;

	const quote = line[cursor];
	if (quote === '"' || quote === '\'') {
		const valueStart = cursor + 1;
		const close = findClosingQuote(line, valueStart, quote);
		const valueEnd = close >= 0 ? close : line.length;
		const rawValue = line.slice(valueStart, valueEnd);
		return {
			key,
			version,
			value: unescapeLocalisationValue(rawValue),
			rawValue,
			valueStart,
			valueEnd,
		};
	}

	const valueStart = cursor;
	let valueEnd = findUnquotedValueEnd(line, valueStart);
	while (valueEnd > valueStart && isWhitespace(line[valueEnd - 1])) valueEnd--;
	if (valueEnd <= valueStart) return undefined;

	const rawValue = line.slice(valueStart, valueEnd);
	return {
		key,
		version,
		value: rawValue,
		rawValue,
		valueStart,
		valueEnd,
	};
}

/**
 * Unescape only the escapes that affect localisation entry boundaries.
 * Gameplay markup such as \n-like text is kept as authored.
 */
export function unescapeLocalisationValue(rawValue: string): string {
	return rawValue.replace(/\\(["'])/g, '$1');
}

export function stripLocalisationColorMarkers(value: string): string {
	return value.replace(COLOR_MARKER_RE, '');
}

/**
 * Tokenize Stellaris localisation rich text into editor-friendly spans.
 *
 * This is intentionally lightweight and VS Code-native: it recognizes common
 * Paradox inline constructs without importing another parser or changing the
 * CWTools-backed rule model.
 */
export function tokenizeLocalisationRichText(value: string, baseOffset = 0): LocalisationRichToken[] {
	const tokens: LocalisationRichToken[] = [];
	const colorMarkers: LocalisationRichToken[] = [];

	for (let i = 0; i < value.length;) {
		const ch = value[i]!;
		if (ch === '\\') {
			i += i + 1 < value.length ? 2 : 1;
			continue;
		}

		if (ch === '\u00a7' && isColorMarkerCode(value[i + 1])) {
			const text = value.slice(i, i + 2);
			const token: LocalisationRichToken = {
				type: 'colorMarker',
				start: baseOffset + i,
				end: baseOffset + i + 2,
				text,
				marker: text,
				colorCode: text,
			};
			tokens.push(token);
			colorMarkers.push(token);
			i += 2;
			continue;
		}

		if (ch === '\u00a3') {
			const token = readIconToken(value, i, baseOffset);
			if (token) {
				tokens.push(token);
				i = token.end - baseOffset;
				continue;
			}
		}

		if (ch === '$') {
			const end = findUnescapedChar(value, '$', i + 1);
			if (end > i + 1) {
				const body = value.slice(i + 1, end);
				if (isParameterBody(body)) {
					tokens.push({
						type: 'parameter',
						start: baseOffset + i,
						end: baseOffset + end + 1,
						text: value.slice(i, end + 1),
					});

					const bodyOffset = baseOffset + i + 1;
					const varPattern = /@[A-Za-z_][A-Za-z0-9_.:-]*/g;
					let match: RegExpExecArray | null;
					while ((match = varPattern.exec(body)) !== null) {
						tokens.push({
							type: 'scriptedVariable',
							start: bodyOffset + match.index,
							end: bodyOffset + match.index + match[0].length,
							text: match[0],
						});
					}

					i = end + 1;
					continue;
				}
			}
		}

		if (ch === '[') {
			const end = findUnescapedChar(value, ']', i + 1);
			if (end > i + 1) {
				const text = value.slice(i, end + 1);
				const inner = text.slice(1, -1).trim();
				if (inner.length > 0) {
					const firstPart = inner.split(/\s|\|/)[0] ?? '';
					const type: LocalisationRichTokenType = /^'[^']*'/.test(inner)
						? 'concept'
						: firstPart.includes('.')
							? 'scopeExpression'
							: 'command';
					tokens.push({
						type,
						start: baseOffset + i,
						end: baseOffset + end + 1,
						text,
					});
					i = end + 1;
					continue;
				}
			}
		}

		if (ch === '@' && isScriptedVariableStart(value, i)) {
			const end = readScriptedVariable(value, i);
			tokens.push({
				type: 'scriptedVariable',
				start: baseOffset + i,
				end: baseOffset + end,
				text: value.slice(i, end),
			});
			i = end;
			continue;
		}

		i++;
	}

	for (let i = 0; i < colorMarkers.length; i++) {
		const marker = colorMarkers[i]!;
		if (marker.colorCode === '\u00a7!') continue;
		if (!marker.colorCode || !LOCALISATION_COLOR_MAP[marker.colorCode]) continue;

		const rangeStart = marker.end;
		const rangeEnd = i + 1 < colorMarkers.length ? colorMarkers[i + 1]!.start : baseOffset + value.length;
		if (rangeStart < rangeEnd) {
			tokens.push({
				type: 'colorRange',
				start: rangeStart,
				end: rangeEnd,
				text: value.slice(rangeStart - baseOffset, rangeEnd - baseOffset),
				colorCode: marker.colorCode,
			});
		}
	}

	return tokens.sort(tokenSort);
}

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

	for (let i = 0; i < lines.length; i++) {
		const parsed = parseLocalisationLine(lines[i]!);
		if (!parsed) continue;

		entries.push({
			key: parsed.key,
			value: parsed.value,
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
