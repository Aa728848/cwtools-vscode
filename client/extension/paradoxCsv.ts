export interface ParadoxCsvCell {
	raw: string;
	value: string;
	start: number;
	end: number;
	quoted: boolean;
}

export interface ParadoxCsvIssue {
	line: number;
	message: string;
	code: 'unterminatedQuote' | 'columnCount';
	actualColumns?: number;
	expectedColumns?: number;
}

export const PARADOX_CSV_DELIMITER = ';';

export function isParadoxCsvDataLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 0 && !trimmed.startsWith('#');
}

export function parseParadoxCsvLine(line: string, delimiter = PARADOX_CSV_DELIMITER): ParadoxCsvCell[] {
	const cells: ParadoxCsvCell[] = [];
	let rawStart = 0;
	let value = '';
	let quoted = false;
	let inQuotes = false;
	let atCellStart = true;

	const pushCell = (end: number) => {
		cells.push({
			raw: line.slice(rawStart, end),
			value,
			start: rawStart,
			end,
			quoted,
		});
	};

	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;

		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					value += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				value += ch;
			}
			continue;
		}

		if (ch === delimiter) {
			pushCell(i);
			rawStart = i + 1;
			value = '';
			quoted = false;
			atCellStart = true;
			continue;
		}

		if (ch === '"' && atCellStart) {
			quoted = true;
			inQuotes = true;
			atCellStart = false;
			continue;
		}

		value += ch;
		atCellStart = false;
	}

	pushCell(line.length);
	return cells;
}

export function hasUnterminatedParadoxCsvQuote(line: string): boolean {
	let inQuotes = false;
	let atCellStart = true;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					i++;
				} else {
					inQuotes = false;
					atCellStart = false;
				}
			}
			continue;
		}
		if (ch === PARADOX_CSV_DELIMITER) {
			atCellStart = true;
			continue;
		}
		if (ch === '"' && atCellStart) {
			inQuotes = true;
			atCellStart = false;
			continue;
		}
		atCellStart = false;
	}
	return inQuotes;
}

export function columnIndexAtCharacter(line: string, character: number, delimiter = PARADOX_CSV_DELIMITER): number {
	const cells = parseParadoxCsvLine(line, delimiter);
	if (cells.length === 0) return 0;

	const boundedCharacter = Math.max(0, Math.min(character, line.length));
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i]!;
		if (boundedCharacter <= cell.end) return i;
	}
	return cells.length - 1;
}

export function countParadoxCsvColumns(line: string, delimiter = PARADOX_CSV_DELIMITER): number {
	return parseParadoxCsvLine(line, delimiter).length;
}

export function serializeParadoxCsvCell(value: string, delimiter = PARADOX_CSV_DELIMITER): string {
	const needsQuotes =
		value.includes(delimiter)
		|| value.includes('"')
		|| value.includes('\n')
		|| value.includes('\r')
		|| value.startsWith('#')
		|| value !== value.trim();

	if (!needsQuotes) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

export function blankParadoxCsvRow(columnCount: number, delimiter = PARADOX_CSV_DELIMITER): string {
	const safeCount = Math.max(1, Math.floor(columnCount));
	return new Array<string>(safeCount).fill('').join(delimiter);
}

export function insertParadoxCsvColumn(
	line: string,
	columnIndex: number,
	value = '',
	delimiter = PARADOX_CSV_DELIMITER,
): string {
	const rawCells = parseParadoxCsvLine(line, delimiter).map(cell => cell.raw);
	const index = Math.max(0, Math.min(Math.floor(columnIndex), rawCells.length));
	while (rawCells.length < index) rawCells.push('');
	rawCells.splice(index, 0, serializeParadoxCsvCell(value, delimiter));
	return rawCells.join(delimiter);
}

export function removeParadoxCsvColumn(
	line: string,
	columnIndex: number,
	delimiter = PARADOX_CSV_DELIMITER,
): string {
	const rawCells = parseParadoxCsvLine(line, delimiter).map(cell => cell.raw);
	const index = Math.floor(columnIndex);
	if (index < 0 || index >= rawCells.length) return line;
	rawCells.splice(index, 1);
	return rawCells.join(delimiter);
}

export function adjustParadoxCsvColumnCount(
	line: string,
	expectedColumns: number,
	delimiter = PARADOX_CSV_DELIMITER,
): string {
	const safeExpected = Math.max(1, Math.floor(expectedColumns));
	const rawCells = parseParadoxCsvLine(line, delimiter).map(cell => cell.raw);
	while (rawCells.length < safeExpected) rawCells.push('');
	if (rawCells.length > safeExpected) rawCells.length = safeExpected;
	return rawCells.join(delimiter);
}

export function analyzeParadoxCsvRows(content: string, delimiter = PARADOX_CSV_DELIMITER): ParadoxCsvIssue[] {
	const issues: ParadoxCsvIssue[] = [];
	const lines = content.split(/\r?\n/);
	let expectedColumns: number | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!isParadoxCsvDataLine(line)) continue;

		if (hasUnterminatedParadoxCsvQuote(line)) {
			issues.push({
				line: i,
				code: 'unterminatedQuote',
				message: 'CSV row has an unterminated quoted cell.',
			});
			continue;
		}

		const actualColumns = countParadoxCsvColumns(line, delimiter);
		if (expectedColumns === undefined) {
			expectedColumns = actualColumns;
			continue;
		}

		if (actualColumns !== expectedColumns) {
			issues.push({
				line: i,
				code: 'columnCount',
				actualColumns,
				expectedColumns,
				message: `CSV row has ${actualColumns} columns; expected ${expectedColumns}.`,
			});
		}
	}

	return issues;
}
