import * as vs from 'vscode';
import { localize } from './panelI18n';
import {
	adjustParadoxCsvColumnCount,
	analyzeParadoxCsvRows,
	blankParadoxCsvRow,
	columnIndexAtCharacter,
	countParadoxCsvColumns,
	insertParadoxCsvColumn,
	isParadoxCsvDataLine,
	removeParadoxCsvColumn,
} from './paradoxCsv';

const LANGUAGE_ID = 'paradox-csv';



function isCsvDocument(document: vs.TextDocument): boolean {
	return document.languageId === LANGUAGE_ID || document.fileName.toLowerCase().endsWith('.csv');
}

function lineText(document: vs.TextDocument, line: number): string {
	return document.lineAt(line).text;
}

function nearestDataLine(document: vs.TextDocument, startLine: number): number | undefined {
	for (let offset = 0; offset < document.lineCount; offset++) {
		const before = startLine - offset;
		if (before >= 0 && isParadoxCsvDataLine(lineText(document, before))) return before;

		const after = startLine + offset;
		if (offset > 0 && after < document.lineCount && isParadoxCsvDataLine(lineText(document, after))) return after;
	}
	return undefined;
}

function activeColumnIndex(editor: vs.TextEditor): number {
	const { document, selection } = editor;
	const activeLine = selection.active.line;
	const text = lineText(document, activeLine);
	if (isParadoxCsvDataLine(text)) {
		return columnIndexAtCharacter(text, selection.active.character);
	}
	return 0;
}

function rowColumnCount(editor: vs.TextEditor): number {
	const dataLine = nearestDataLine(editor.document, editor.selection.active.line);
	if (dataLine === undefined) return 1;
	return countParadoxCsvColumns(lineText(editor.document, dataLine));
}

function eol(document: vs.TextDocument): string {
	return document.eol === vs.EndOfLine.CRLF ? '\r\n' : '\n';
}

function documentLines(document: vs.TextDocument): string[] {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) {
		lines.push(document.lineAt(i).text);
	}
	return lines;
}

function fullDocumentRange(document: vs.TextDocument): vs.Range {
	const lastLine = document.lineAt(document.lineCount - 1);
	return new vs.Range(new vs.Position(0, 0), lastLine.range.end);
}

function updateCsvDiagnostics(collection: vs.DiagnosticCollection, document: vs.TextDocument): void {
	if (!isCsvDocument(document)) {
		collection.delete(document.uri);
		return;
	}

	const diagnostics = analyzeParadoxCsvRows(document.getText()).map(issue => {
		const line = Math.min(issue.line, document.lineCount - 1);
		const lineRange = document.lineAt(line).range;
		const diagnostic = new vs.Diagnostic(
			lineRange,
			issue.code === 'columnCount'
				? localize(
					`CSV row has ${issue.actualColumns} columns; expected ${issue.expectedColumns}.`,
					`CSV 行有 ${issue.actualColumns} 列；预期为 ${issue.expectedColumns} 列。`,
				)
				: localize(
					'CSV row has an unterminated quoted cell.',
					'CSV 行包含未闭合的引号单元格。',
				),
			vs.DiagnosticSeverity.Warning,
		) as vs.Diagnostic & { expectedColumns?: number };
		diagnostic.source = 'Paradox CSV';
		diagnostic.code = issue.code === 'columnCount'
			? 'paradoxCsv.columnCount'
			: 'paradoxCsv.unterminatedQuote';
		diagnostic.expectedColumns = issue.expectedColumns;
		return diagnostic;
	});

	collection.set(document.uri, diagnostics);
}

class ParadoxCsvCodeActionProvider implements vs.CodeActionProvider {
	static readonly metadata: vs.CodeActionProviderMetadata = {
		providedCodeActionKinds: [vs.CodeActionKind.QuickFix],
	};

	provideCodeActions(document: vs.TextDocument, _range: vs.Range, context: vs.CodeActionContext): vs.CodeAction[] {
		if (!isCsvDocument(document)) return [];

		const actions: vs.CodeAction[] = [];
		for (const diagnostic of context.diagnostics) {
			if (diagnostic.code !== 'paradoxCsv.columnCount') continue;
			const expectedColumns = (diagnostic as vs.Diagnostic & { expectedColumns?: number }).expectedColumns;
			if (!expectedColumns) continue;

			const line = diagnostic.range.start.line;
			const original = document.lineAt(line).text;
			const fixed = adjustParadoxCsvColumnCount(original, expectedColumns);
			if (fixed === original) continue;

			const action = new vs.CodeAction(
				localize(
					`Match row to ${expectedColumns} CSV columns`,
					`调整为 ${expectedColumns} 列 CSV 行`,
				),
				vs.CodeActionKind.QuickFix,
			);
			action.diagnostics = [diagnostic];
			action.isPreferred = true;
			action.edit = new vs.WorkspaceEdit();
			action.edit.replace(document.uri, document.lineAt(line).range, fixed);
			actions.push(action);
		}
		return actions;
	}
}

function ensureCsvEditor(editor: vs.TextEditor): boolean {
	if (isCsvDocument(editor.document)) return true;
	void vs.window.showWarningMessage(localize(
		'Open a Paradox CSV file before using this command.',
		'请先打开 Paradox CSV 文件再使用此命令。',
	));
	return false;
}

function insertRow(editor: vs.TextEditor, edit: vs.TextEditorEdit, placement: 'above' | 'below'): void {
	if (!ensureCsvEditor(editor)) return;

	const text = blankParadoxCsvRow(rowColumnCount(editor));
	const line = editor.selection.active.line;
	if (placement === 'above') {
		edit.insert(new vs.Position(line, 0), `${text}${eol(editor.document)}`);
	} else {
		const currentLine = editor.document.lineAt(line);
		edit.insert(currentLine.range.end, `${eol(editor.document)}${text}`);
	}
}

function rewriteColumns(editor: vs.TextEditor, edit: vs.TextEditorEdit, mutate: (line: string) => string): void {
	if (!ensureCsvEditor(editor)) return;

	let changed = false;
	const lines = documentLines(editor.document).map(line => {
		if (!isParadoxCsvDataLine(line)) return line;
		const next = mutate(line);
		if (next !== line) changed = true;
		return next;
	});

	if (!changed) {
		void vs.window.showInformationMessage(localize(
			'No CSV data rows were changed.',
			'没有 CSV 数据行被修改。',
		));
		return;
	}

	edit.replace(fullDocumentRange(editor.document), lines.join(eol(editor.document)));
}

export function registerParadoxCsvFeatures(context: vs.ExtensionContext): void {
	const diagnostics = vs.languages.createDiagnosticCollection('paradox-csv');
	context.subscriptions.push(diagnostics);

	for (const document of vs.workspace.textDocuments) {
		updateCsvDiagnostics(diagnostics, document);
	}

	context.subscriptions.push(
		vs.workspace.onDidOpenTextDocument(document => updateCsvDiagnostics(diagnostics, document)),
		vs.workspace.onDidChangeTextDocument(event => updateCsvDiagnostics(diagnostics, event.document)),
		vs.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
		vs.languages.registerCodeActionsProvider(
			[{ scheme: 'file', language: LANGUAGE_ID }, { scheme: 'file', pattern: '**/*.csv' }],
			new ParadoxCsvCodeActionProvider(),
			ParadoxCsvCodeActionProvider.metadata,
		),
		vs.commands.registerTextEditorCommand('cwtools.csv.insertRowAbove', (editor, edit) => {
			insertRow(editor, edit, 'above');
		}),
		vs.commands.registerTextEditorCommand('cwtools.csv.insertRowBelow', (editor, edit) => {
			insertRow(editor, edit, 'below');
		}),
		vs.commands.registerTextEditorCommand('cwtools.csv.insertColumnLeft', (editor, edit) => {
			const index = activeColumnIndex(editor);
			rewriteColumns(editor, edit, line => insertParadoxCsvColumn(line, index));
		}),
		vs.commands.registerTextEditorCommand('cwtools.csv.insertColumnRight', (editor, edit) => {
			const index = activeColumnIndex(editor) + 1;
			rewriteColumns(editor, edit, line => insertParadoxCsvColumn(line, index));
		}),
		vs.commands.registerTextEditorCommand('cwtools.csv.removeColumn', (editor, edit) => {
			const index = activeColumnIndex(editor);
			rewriteColumns(editor, edit, line => removeParadoxCsvColumn(line, index));
		}),
		vs.commands.registerTextEditorCommand('cwtools.csv.removeRow', (editor, edit) => {
			if (!ensureCsvEditor(editor)) return;
			const line = editor.selection.active.line;
			const range = editor.document.lineAt(line).rangeIncludingLineBreak;
			edit.delete(range);
		}),
	);
}
