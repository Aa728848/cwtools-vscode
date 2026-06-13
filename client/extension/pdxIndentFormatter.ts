import * as vscode from 'vscode';
import { braceDeltaOf, reindentLines } from './pdxIndent';

/** 应用本缩进适配的 PDX 语言 ID（pdx-shader 不在此列）。 */
const PDX_LANGUAGE_IDS = [
	'stellaris', 'hoi4', 'eu4', 'ck2', 'ck3', 'vic2', 'vic3', 'imperator', 'eu5', 'paradox',
];

class PdxIndentFormatter implements vscode.DocumentRangeFormattingEditProvider {
	provideDocumentRangeFormattingEdits(
		document: vscode.TextDocument,
		range: vscode.Range,
		options: vscode.FormattingOptions,
	): vscode.TextEdit[] {
		const enabled = vscode.workspace
			.getConfiguration('cwtools', document.uri)
			.get<boolean>('editor.formatIndentOnPaste', true);
		if (!enabled) return [];

		const indentUnit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';

		const prefixRange = new vscode.Range(0, 0, range.start.line, 0);
		const baseDepth = Math.max(0, braceDeltaOf(document.getText(prefixRange)));

		const firstLineText = document.lineAt(range.start.line).text;
		const firstLineLeadingWs = firstLineText.length - firstLineText.replace(/^[ \t]+/, '').length;
		const skipFirstLine = range.start.character > firstLineLeadingWs;

		const startLine = skipFirstLine ? range.start.line + 1 : range.start.line;
		const endLine = range.end.line;
		if (startLine > endLine) return [];

		const originals: string[] = [];
		for (let l = startLine; l <= endLine; l++) {
			originals.push(document.lineAt(l).text);
		}

		// 若跳过了首行，其括号也要计入后续行的起始深度。
		const effectiveBase = skipFirstLine
			? Math.max(0, baseDepth + braceDeltaOf(firstLineText))
			: baseDepth;

		const reindented = reindentLines(originals, effectiveBase, indentUnit);

		const edits: vscode.TextEdit[] = [];
		for (let idx = 0; idx < originals.length; idx++) {
			const lineNo = startLine + idx;
			const original = originals[idx]!;
			const next = reindented[idx]!;
			if (original === next) continue;
			const fullLineRange = new vscode.Range(lineNo, 0, lineNo, original.length);
			edits.push(vscode.TextEdit.replace(fullLineRange, next));
		}
		return edits;
	}
}

/** 为所有 PDX 语言注册缩进适配 range 格式化器。 */
export function registerPdxIndentFormatter(context: vscode.ExtensionContext): void {
	const provider = new PdxIndentFormatter();
	for (const languageId of PDX_LANGUAGE_IDS) {
		context.subscriptions.push(
			vscode.languages.registerDocumentRangeFormattingEditProvider(
				{ scheme: 'file', language: languageId },
				provider,
			),
		);
	}
}
