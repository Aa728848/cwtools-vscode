import * as vs from 'vscode';
import { localize } from './panelI18n';
import * as path from 'path';
import type { IndexService, LocEntry, WorkspaceSymbolEntry } from './indexing/indexService';
import {
	compareLocalisationLanguagePreference,
	getPreferredLocalisationLanguageTags,
} from './localisationLanguagePreference';

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/;

interface LocPick extends vs.QuickPickItem {
	entry: LocEntry;
}

interface SymbolPick extends vs.QuickPickItem {
	entry: WorkspaceSymbolEntry;
}

interface ImagePick extends vs.QuickPickItem {
	uri: vs.Uri;
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

function configuredLocalisationLanguageTags(): string[] {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	return getPreferredLocalisationLanguageTags(config.get<string[]>('localisation.languages', ['English']));
}

function sortRelatedLocalisations(
	entries: LocEntry[],
	token: string,
	preferredTags: readonly string[],
): LocEntry[] {
	const normalizedToken = token.toLowerCase();
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const aExact = a.entry.key.toLowerCase() === normalizedToken ? 0 : 1;
			const bExact = b.entry.key.toLowerCase() === normalizedToken ? 0 : 1;
			return aExact - bExact
				|| compareLocalisationLanguagePreference(a.entry, b.entry, preferredTags)
				|| a.index - b.index;
		})
		.map(item => item.entry);
}

export async function queryRelatedLocalisations(
	indexService: IndexService,
	token: string,
	preferredTags = configuredLocalisationLanguageTags(),
): Promise<LocEntry[]> {
	const exact = await indexService.queryLocalisationAsync({ key: token, limit: 500 });
	const prefix = await indexService.queryLocalisationAsync({ key: token, prefix: true, limit: 500 });
	return sortRelatedLocalisations(dedupeLocEntries([...exact, ...prefix]), token, preferredTags).slice(0, 100);
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
			'本地化键或前缀',
		),
	});

	const normalized = query?.trim();
	if (!normalized) return;

	const entries = await queryRelatedLocalisations(indexService, normalized);
	if (entries.length === 0) {
		void vs.window.showInformationMessage(localize(
			`No related localisation keys found for "${normalized}".`,
			`未找到与 "${normalized}" 相关的本地化键。`,
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
			`"${normalized}" 的相关本地化键`,
		),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (picked) await openLocEntry(picked.entry);
}

function symbolPick(entry: WorkspaceSymbolEntry): SymbolPick {
	return {
		label: entry.name,
		description: [entry.kind, entry.category, entry.source].filter(Boolean).join(' / '),
		detail: `${vs.workspace.asRelativePath(entry.file)}:${entry.line}`,
		entry,
	};
}

async function openWorkspaceSymbol(entry: WorkspaceSymbolEntry): Promise<void> {
	const uri = vs.Uri.file(entry.file);
	const document = await vs.workspace.openTextDocument(uri);
	const position = new vs.Position(Math.max(0, entry.line - 1), 0);
	const editor = await vs.window.showTextDocument(document, { preview: true });
	editor.selection = new vs.Selection(position, position);
	editor.revealRange(new vs.Range(position, position), vs.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function goToRelatedDefinitions(indexService: IndexService): Promise<void> {
	const editor = vs.window.activeTextEditor;
	const token = editor ? extractRelatedResourceToken(editor.document, editor.selection) : undefined;
	const query = token ?? await vs.window.showInputBox({
		prompt: localize('PDX definition, sprite, sound, or GUI symbol', 'PDX 定义、sprite、sound 或 GUI 符号'),
	});
	const normalized = query?.trim();
	if (!normalized) return;

	await indexService.ensureWorkspaceSymbolsReady({ includeVanilla: false });
	const entries = [
		...indexService.queryWorkspaceSymbols({ name: normalized, exact: true, origin: 'workspace', includeReferences: true, limit: 100 }),
		...indexService.queryWorkspaceSymbols({ name: normalized, prefix: true, origin: 'workspace', includeReferences: true, limit: 100 }),
	].slice(0, 100);

	const deduped = new Map<string, WorkspaceSymbolEntry>();
	for (const entry of entries) {
		deduped.set(`${entry.name}\0${entry.kind}\0${entry.file}\0${entry.line}`, entry);
	}
	const results = Array.from(deduped.values());
	if (results.length === 0) {
		void vs.window.showInformationMessage(localize(
			`No related definitions found for "${normalized}".`,
			`未找到与 "${normalized}" 相关的定义。`,
		));
		return;
	}

	if (results.length === 1) {
		await openWorkspaceSymbol(results[0]!);
		return;
	}

	const picked = await vs.window.showQuickPick(results.map(symbolPick), {
		placeHolder: localize(
			`Related definitions for "${normalized}"`,
			`"${normalized}" 的相关定义`,
		),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (picked) await openWorkspaceSymbol(picked.entry);
}

function imageSearchTerms(token: string): string[] {
	const base = path.basename(token).replace(/\.(dds|tga|png|jpg|jpeg|bmp)$/i, '');
	const withoutPrefix = base.replace(/^GFX_/i, '');
	const compact = withoutPrefix.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return Array.from(new Set([base, withoutPrefix, compact].filter(term => term.length >= 2)));
}

async function findRelatedImages(token: string): Promise<ImagePick[]> {
	const candidates = new Map<string, vs.Uri>();
	for (const term of imageSearchTerms(token)) {
		const pattern = `**/*${term}*.{dds,tga,png,jpg,jpeg,bmp}`;
		const files = await vs.workspace.findFiles(pattern, '**/{node_modules,.git,.cwtools}/**', 80);
		for (const uri of files) candidates.set(uri.fsPath.toLowerCase(), uri);
	}
	return Array.from(candidates.values()).slice(0, 100).map(uri => ({
		label: path.basename(uri.fsPath),
		description: vs.workspace.asRelativePath(path.dirname(uri.fsPath)),
		detail: uri.fsPath,
		uri,
	}));
}

async function goToRelatedImages(): Promise<void> {
	const editor = vs.window.activeTextEditor;
	const token = editor ? extractRelatedResourceToken(editor.document, editor.selection) : undefined;
	const query = token ?? await vs.window.showInputBox({
		prompt: localize('Image path, sprite name, or filename fragment', '图片路径、sprite 名或文件名片段'),
	});
	const normalized = query?.trim();
	if (!normalized) return;

	const images = await findRelatedImages(normalized);
	if (images.length === 0) {
		void vs.window.showInformationMessage(localize(
			`No related images found for "${normalized}".`,
			`未找到与 "${normalized}" 相关的图片。`,
		));
		return;
	}

	const picked = images.length === 1
		? images[0]
		: await vs.window.showQuickPick(images, {
			placeHolder: localize(
				`Related images for "${normalized}"`,
				`"${normalized}" 的相关图片`,
			),
			matchOnDescription: true,
			matchOnDetail: true,
		});
	if (!picked) return;

	await vs.commands.executeCommand('cwtools.openTexturePreview', picked.uri);
}

export function registerRelatedResourceFeatures(context: vs.ExtensionContext, indexService: IndexService): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.goToRelatedLocalisations', () => goToRelatedLocalisations(indexService)),
		vs.commands.registerCommand('cwtools.goToRelatedDefinitions', () => goToRelatedDefinitions(indexService)),
		vs.commands.registerCommand('cwtools.goToRelatedImages', () => goToRelatedImages()),
	);
}
