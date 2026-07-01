import * as vs from 'vscode';
import type { IndexService, LocEntry } from './indexing/indexService';

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/;

interface LocPick extends vs.QuickPickItem {
	entry: LocEntry;
}

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

export function extractRelatedResourceToken(document: vs.TextDocument, selection: vs.Selection): string | undefined {
	const selected = document.getText(selection).trim().replace(/^["'$]+|["'$]+$/g, '');
	if (IDENTIFIER_RE.test(selected)) return selected.match(IDENTIFIER_RE)![0];

	const range = document.getWordRangeAtPosition(selection.active, IDENTIFIER_RE);
	if (!range) return undefined;
	return document.getText(range);
}

function dedupeLocEntries(entries: LocEntry[]): LocEntry[] {
	const seen = new Set<string>();
	const result: LocEntry[] = [];
	for (const entry of entries) {
		const key = `${entry.key}\0${entry.language}\0${entry.file}\0${entry.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

async function queryRelatedLocalisations(indexService: IndexService, token: string): Promise<LocEntry[]> {
	const exact = await indexService.queryLocalisationAsync({ key: token, limit: 100 });
	const prefix = await indexService.queryLocalisationAsync({ key: token, prefix: true, limit: 100 });
	return dedupeLocEntries([...exact, ...prefix]).slice(0, 100);
}

async function openLocEntry(entry: LocEntry): Promise<void> {
	const uri = vs.Uri.file(entry.file);
	const document = await vs.workspace.openTextDocument(uri);
	const position = new vs.Position(Math.max(0, entry.line - 1), 0);
	const editor = await vs.window.showTextDocument(document, { preview: true });
	editor.selection = new vs.Selection(position, position);
	editor.revealRange(new vs.Range(position, position), vs.TextEditorRevealType.InCenterIfOutsideViewport);
}

function locPick(entry: LocEntry): LocPick {
	return {
		label: entry.key,
		description: entry.language || undefined,
		detail: `${vs.workspace.asRelativePath(entry.file)}:${entry.line} - ${entry.value.slice(0, 120)}`,
		entry,
	};
}

async function goToRelatedLocalisations(indexService: IndexService): Promise<void> {
	const editor = vs.window.activeTextEditor;
	const token = editor ? extractRelatedResourceToken(editor.document, editor.selection) : undefined;
	const query = token ?? await vs.window.showInputBox({
		prompt: localize(
			'Localisation key or prefix',
			'\u672c\u5730\u5316\u952e\u6216\u524d\u7f00',
		),
	});

	const normalized = query?.trim();
	if (!normalized) return;

	const entries = await queryRelatedLocalisations(indexService, normalized);
	if (entries.length === 0) {
		void vs.window.showInformationMessage(localize(
			`No related localisation keys found for "${normalized}".`,
			`\u672a\u627e\u5230\u4e0e "${normalized}" \u76f8\u5173\u7684\u672c\u5730\u5316\u952e\u3002`,
		));
		return;
	}

	if (entries.length === 1) {
		await openLocEntry(entries[0]!);
		return;
	}

	const picked = await vs.window.showQuickPick(entries.map(locPick), {
		placeHolder: localize(
			`Related localisation keys for "${normalized}"`,
			`"${normalized}" \u7684\u76f8\u5173\u672c\u5730\u5316\u952e`,
		),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (picked) await openLocEntry(picked.entry);
}

export function registerRelatedResourceFeatures(context: vs.ExtensionContext, indexService: IndexService): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.goToRelatedLocalisations', () => goToRelatedLocalisations(indexService)),
	);
}

