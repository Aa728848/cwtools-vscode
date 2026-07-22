/**
 * Localization Enhancement Module
 * - Highlights Paradox localisation color ranges in .yml files
 * - Highlights rich localisation constructs such as icons and references
 * - Provides hover preview and Go to Definition for $REF$ references
 */
import * as vs from 'vscode';
import type { IndexService, LocEntry } from './indexing/indexService';
import {
	LOCALISATION_COLOR_MAP,
	parseLocalisationLine,
	parseLocFile,
	stripLocalisationColorMarkers,
	tokenizeLocalisationRichText,
} from './indexing/locParser';
import {
	getLocalisationCompletionContext,
	LOCALISATION_COLOR_COMPLETIONS,
	LOCALISATION_COMMAND_COMPLETIONS,
	LOCALISATION_ICON_COMPLETIONS,
	type LocalisationCommandCandidate,
	type LocalisationCompletionCandidate,
	type LocalisationCompletionContext,
} from './localisationCompletions';
import { matchesExt } from './fileExtensions';
import {
	getPreferredLocalisationLanguageTags,
	localisationLanguageRank,
	normaliseLocalisationLanguageTag,
	sortLocalisationEntriesByLanguagePreference,
} from './localisationLanguagePreference';

const colorDecorationTypes = new Map<string, vs.TextEditorDecorationType>();

for (const [code, color] of Object.entries(LOCALISATION_COLOR_MAP)) {
	colorDecorationTypes.set(code, vs.window.createTextEditorDecorationType({
		color,
		before: undefined,
	}));
}

const markerDecorationType = vs.window.createTextEditorDecorationType({
	opacity: '0.5',
	fontStyle: 'italic',
});

const iconDecorationType = vs.window.createTextEditorDecorationType({
	color: '#5C8AE6',
});

const parameterDecorationType = vs.window.createTextEditorDecorationType({
	color: '#4A86E8',
});

const scriptedVariableDecorationType = vs.window.createTextEditorDecorationType({
	color: new vs.ThemeColor('editorBracketHighlight.foreground2'),
	fontStyle: 'italic',
});

const commandDecorationType = vs.window.createTextEditorDecorationType({
	color: new vs.ThemeColor('textLink.foreground'),
});

const conceptDecorationType = vs.window.createTextEditorDecorationType({
	color: '#008080',
	fontWeight: '600',
});

type LocLookupEntry = { key: string; value: string; uri: vs.Uri; line: number; language?: string };
type LocLookupCandidate = { entry: LocLookupEntry; sourceRank: number; order: number };

const openDocumentLocCache = new Map<string, Map<string, LocLookupEntry>>();
const LOCALISATION_REF_RE = /\$[A-Za-z_][A-Za-z0-9_.:-]*(?:\|[A-Za-z0-9_.:+%-]+)?\$/;

function isYmlDocument(document: vs.TextDocument): boolean {
	return document.uri.scheme === 'file' && matchesExt(document.fileName, '.yml');
}

function cacheOpenDocumentLocalisation(document: vs.TextDocument): void {
	if (!isYmlDocument(document)) return;

	const entries = parseLocFile(document.getText(), document.uri.fsPath);
	const fileLocs = new Map<string, LocLookupEntry>();
	for (const entry of entries) {
		fileLocs.set(entry.key, {
			key: entry.key,
			value: entry.value,
			uri: document.uri,
			line: Math.max(0, entry.line - 1),
			language: entry.language,
		});
	}
	openDocumentLocCache.set(document.uri.toString(), fileLocs);
}

function fromIndexedEntry(entry: LocEntry): LocLookupEntry {
	return {
		key: entry.key,
		value: entry.value,
		uri: vs.Uri.file(entry.file),
		line: Math.max(0, entry.line - 1),
		language: entry.language,
	};
}

function configuredLocalisationLanguageTags(): string[] {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	return getPreferredLocalisationLanguageTags(config.get<string[]>('localisation.languages', ['English']));
}

function compareLocLookupCandidate(
	a: LocLookupCandidate,
	b: LocLookupCandidate,
	preferredTags: readonly string[],
): number {
	const languageDelta = localisationLanguageRank(a.entry.language, preferredTags)
		- localisationLanguageRank(b.entry.language, preferredTags);
	if (languageDelta !== 0) return languageDelta;

	const aLanguage = normaliseLocalisationLanguageTag(a.entry.language) ?? '';
	const bLanguage = normaliseLocalisationLanguageTag(b.entry.language) ?? '';
	return aLanguage.localeCompare(bLanguage)
		|| a.sourceRank - b.sourceRank
		|| a.order - b.order;
}

function findLocEntry(
	key: string,
	preferredDocument: vs.TextDocument,
	indexService?: IndexService,
): LocLookupEntry | undefined {
	const preferredTags = configuredLocalisationLanguageTags();
	const candidates: LocLookupCandidate[] = [];
	let order = 0;

	const preferredDocumentKey = preferredDocument.uri.toString();
	const preferred = openDocumentLocCache.get(preferredDocumentKey)?.get(key);
	if (preferred) candidates.push({ entry: preferred, sourceRank: 0, order: order++ });

	for (const [documentKey, fileLocs] of openDocumentLocCache.entries()) {
		if (documentKey === preferredDocumentKey) continue;
		const entry = fileLocs.get(key);
		if (entry) candidates.push({ entry, sourceRank: 1, order: order++ });
	}

	for (const indexedEntry of indexService?.queryLocalisation({ key, limit: 500 }) ?? []) {
		candidates.push({ entry: fromIndexedEntry(indexedEntry), sourceRank: 2, order: order++ });
	}

	candidates.sort((a, b) => compareLocLookupCandidate(a, b, preferredTags));
	return candidates[0]?.entry;
}

function locReferenceName(tokenText: string): string {
	const body = tokenText.replace(/^\$|\$$/g, '');
	return body.split('|')[0] ?? body;
}

function completionRange(position: vs.Position, context: LocalisationCompletionContext): vs.Range {
	return new vs.Range(
		position.line,
		context.replaceStart,
		position.line,
		context.replaceEnd,
	);
}

function completionMarkdown(text: string | undefined): vs.MarkdownString | undefined {
	if (!text) return undefined;
	return new vs.MarkdownString(text);
}

function candidateMatches(prefix: string, candidate: LocalisationCompletionCandidate): boolean {
	if (!prefix) return true;
	const needle = prefix.toLowerCase();
	return candidate.label.toLowerCase().includes(needle)
		|| candidate.insertText.toLowerCase().startsWith(needle);
}

function makeColorCompletionItems(context: LocalisationCompletionContext, position: vs.Position): vs.CompletionItem[] {
	const range = completionRange(position, context);
	return LOCALISATION_COLOR_COMPLETIONS
		.filter(candidate => candidateMatches(context.prefix, candidate))
		.map((candidate, index) => {
			const item = new vs.CompletionItem(candidate.label, vs.CompletionItemKind.Color);
			item.range = range;
			item.insertText = context.kind === 'colorArgument'
				? candidate.insertText
				: `\u00a7${candidate.insertText}`;
			item.filterText = item.insertText;
			item.detail = context.kind === 'colorArgument' ? 'Localisation argument color' : candidate.detail;
			item.documentation = completionMarkdown(candidate.documentation);
			item.sortText = `0_${index.toString().padStart(3, '0')}`;
			return item;
		});
}

function collectDocumentIconCandidates(document: vs.TextDocument, prefix: string, seen: Set<string>): LocalisationCompletionCandidate[] {
	const results: LocalisationCompletionCandidate[] = [];
	if (prefix.length < 1) return results;

	const iconRe = /\u00a3([A-Za-z0-9_.-]+)(?:\|[^\u00a3\s[\]"]+)?\u00a3?/g;
	const text = document.getText();
	let match: RegExpExecArray | null;
	while ((match = iconRe.exec(text)) !== null && results.length < 40) {
		const name = match[1];
		if (!name || seen.has(name) || !name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
		seen.add(name);
		results.push({
			label: `\u00a3${name}\u00a3`,
			insertText: `\u00a3${name}\u00a3`,
			detail: 'Local document icon',
		});
	}
	return results;
}

function makeIconCompletionItems(document: vs.TextDocument, context: LocalisationCompletionContext, position: vs.Position): vs.CompletionItem[] {
	const range = completionRange(position, context);
	const seen = new Set<string>();
	const candidates = [
		...LOCALISATION_ICON_COMPLETIONS.filter(candidate => {
			const name = candidate.insertText.replace(/^\u00a3|\u00a3$/g, '');
			if (seen.has(name)) return false;
			seen.add(name);
			return candidateMatches(context.prefix, candidate);
		}),
		...collectDocumentIconCandidates(document, context.prefix, seen),
	];

	return candidates.map((candidate, index) => {
		const item = new vs.CompletionItem(candidate.label, vs.CompletionItemKind.EnumMember);
		item.range = range;
		item.insertText = candidate.insertText;
		item.filterText = candidate.insertText;
		item.detail = candidate.detail;
		item.documentation = completionMarkdown(candidate.documentation);
		item.sortText = `1_${index.toString().padStart(3, '0')}`;
		return item;
	});
}

function commandExpression(candidate: LocalisationCommandCandidate): string {
	return candidate.label.replace(/^\[|\]$/g, '');
}

function collectDocumentCommandCandidates(document: vs.TextDocument, prefix: string, seen: Set<string>): LocalisationCommandCandidate[] {
	const results: LocalisationCommandCandidate[] = [];
	if (prefix.length < 1) return results;

	const commandRe = /\[([A-Za-z_][A-Za-z0-9_.:-]*(?:\.[A-Za-z_][A-Za-z0-9_:-]*)+)\]/g;
	const text = document.getText();
	let match: RegExpExecArray | null;
	while ((match = commandRe.exec(text)) !== null && results.length < 40) {
		const expression = match[1];
		if (!expression || seen.has(expression) || !expression.toLowerCase().startsWith(prefix.toLowerCase())) continue;
		seen.add(expression);
		results.push({
			label: `[${expression}]`,
			insertText: `[${expression}]`,
			detail: 'Local document command',
		});
	}
	return results;
}

function makeCommandCompletionItems(document: vs.TextDocument, context: LocalisationCompletionContext, position: vs.Position): vs.CompletionItem[] {
	const range = completionRange(position, context);
	const seen = new Set<string>();
	const candidates = [
		...LOCALISATION_COMMAND_COMPLETIONS.filter(candidate => {
			const expression = commandExpression(candidate);
			if (seen.has(expression)) return false;
			seen.add(expression);
			return !context.prefix || expression.toLowerCase().startsWith(context.prefix.toLowerCase());
		}),
		...collectDocumentCommandCandidates(document, context.prefix, seen),
	];

	return candidates.map((candidate, index) => {
		const item = new vs.CompletionItem(candidate.label, vs.CompletionItemKind.Function);
		item.range = range;
		item.insertText = candidate.snippet ? new vs.SnippetString(candidate.insertText) : candidate.insertText;
		item.filterText = candidate.label;
		item.detail = candidate.detail;
		item.documentation = completionMarkdown(candidate.documentation);
		item.sortText = `2_${index.toString().padStart(3, '0')}`;
		return item;
	});
}

function makeReferenceCompletionItems(
	document: vs.TextDocument,
	context: LocalisationCompletionContext,
	position: vs.Position,
	indexService: IndexService,
): vs.CompletionItem[] {
	if (context.prefix.length < 1) return [];

	const range = completionRange(position, context);
	const seen = new Set<string>();
	const preferredTags = configuredLocalisationLanguageTags();
	const entries = sortLocalisationEntriesByLanguagePreference([
		...parseLocFile(document.getText(), document.uri.fsPath).filter(entry => entry.key.toLowerCase().startsWith(context.prefix.toLowerCase())),
		...indexService.queryLocalisation({ key: context.prefix, prefix: true, limit: 500 }),
	], preferredTags);
	const items: vs.CompletionItem[] = [];

	for (const entry of entries) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		const item = new vs.CompletionItem(`$${entry.key}$`, vs.CompletionItemKind.Reference);
		item.range = range;
		item.insertText = `$${entry.key}$`;
		item.filterText = `$${entry.key}$`;
		item.detail = entry.language ? `Localisation reference (${entry.language})` : 'Localisation reference';
		item.documentation = completionMarkdown(`${stripLocalisationColorMarkers(entry.value)}\n\n${vs.workspace.asRelativePath(entry.file)}:${entry.line}`);
		item.sortText = `3_${items.length.toString().padStart(3, '0')}`;
		items.push(item);
		if (items.length >= 80) break;
	}

	return items;
}

class LocalisationCompletionProvider implements vs.CompletionItemProvider {
	constructor(private readonly indexService: IndexService) {}

	provideCompletionItems(document: vs.TextDocument, position: vs.Position): vs.ProviderResult<vs.CompletionItem[]> {
		const line = document.lineAt(position.line).text;
		const context = getLocalisationCompletionContext(line, position.character);
		if (!context) return undefined;

		if (context.kind === 'colorMarker' || context.kind === 'colorArgument') {
			return makeColorCompletionItems(context, position);
		}
		if (context.kind === 'icon') {
			return makeIconCompletionItems(document, context, position);
		}
		if (context.kind === 'command') {
			return makeCommandCompletionItems(document, context, position);
		}
		if (context.kind === 'reference') {
			return makeReferenceCompletionItems(document, context, position, this.indexService);
		}

		return undefined;
	}
}

/**
 * Apply rich localisation decorations to a .yml editor.
 */
function updateColorDecorations(editor: vs.TextEditor): void {
	if (!matchesExt(editor.document.fileName, '.yml')) return;

	const text = editor.document.getText();
	const markerRanges: vs.DecorationOptions[] = [];
	const iconRanges: vs.DecorationOptions[] = [];
	const parameterRanges: vs.DecorationOptions[] = [];
	const scriptedVariableRanges: vs.DecorationOptions[] = [];
	const commandRanges: vs.DecorationOptions[] = [];
	const conceptRanges: vs.DecorationOptions[] = [];

	const colorRanges = new Map<string, vs.DecorationOptions[]>();
	for (const code of colorDecorationTypes.keys()) {
		colorRanges.set(code, []);
	}

	const lines = text.split('\n');
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx]!.replace(/\r$/, '');
		const parsed = parseLocalisationLine(line);
		if (!parsed) continue;

		for (const token of tokenizeLocalisationRichText(parsed.rawValue, parsed.valueStart)) {
			const range = new vs.Range(lineIdx, token.start, lineIdx, token.end);
			if (token.type === 'colorMarker') {
				markerRanges.push({ range });
			} else if (token.type === 'colorRange' && token.colorCode) {
				const ranges = colorRanges.get(token.colorCode);
				if (ranges) ranges.push({ range });
			} else if (token.type === 'icon') {
				iconRanges.push({ range });
			} else if (token.type === 'parameter') {
				parameterRanges.push({ range });
			} else if (token.type === 'scriptedVariable') {
				scriptedVariableRanges.push({ range });
			} else if (token.type === 'concept') {
				conceptRanges.push({ range });
			} else if (token.type === 'scopeExpression' || token.type === 'command') {
				commandRanges.push({ range });
			}
		}
	}

	editor.setDecorations(markerDecorationType, markerRanges);
	editor.setDecorations(iconDecorationType, iconRanges);
	editor.setDecorations(parameterDecorationType, parameterRanges);
	editor.setDecorations(scriptedVariableDecorationType, scriptedVariableRanges);
	editor.setDecorations(commandDecorationType, commandRanges);
	editor.setDecorations(conceptDecorationType, conceptRanges);
	for (const [code, decorationType] of colorDecorationTypes) {
		editor.setDecorations(decorationType, colorRanges.get(code) ?? []);
	}
}

/**
 * Hover provider for $REF$ references in .yml files.
 */
class LocRefHoverProvider implements vs.HoverProvider {
	constructor(private readonly indexService: IndexService) {}

	async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | null> {
		const range = document.getWordRangeAtPosition(position, LOCALISATION_REF_RE);
		if (!range) return null;

		const word = document.getText(range);
		const refName = locReferenceName(word);

		const entry = findLocEntry(refName, document, this.indexService);
		if (!entry) return null;

		const cleanValue = stripLocalisationColorMarkers(entry.value);

		const md = new vs.MarkdownString();
		md.appendMarkdown(`**${refName}**\n\n`);
		md.appendMarkdown(`> ${cleanValue}\n\n`);
		md.appendMarkdown(`*Source: ${vs.workspace.asRelativePath(entry.uri)}:${entry.line + 1}*`);

		return new vs.Hover(md, range);
	}
}

/**
 * Definition provider for $REF$ references in .yml files.
 */
class LocRefDefinitionProvider implements vs.DefinitionProvider {
	constructor(private readonly indexService: IndexService) {}

	async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
		const range = document.getWordRangeAtPosition(position, LOCALISATION_REF_RE);
		if (!range) return null;

		const word = document.getText(range);
		const refName = locReferenceName(word);

		const entry = findLocEntry(refName, document, this.indexService);
		if (!entry) return null;

		return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
	}
}

/**
 * Jump to the definition of a localisation key in script files.
 *
 * Unquoted values only need a generic assignment shape. Exact membership in the
 * shared localisation index decides whether the value is actually a loc key;
 * this avoids maintaining a parallel list of game keywords or loc-bearing fields.
 */
class ScriptLocDefinitionProvider implements vs.DefinitionProvider {
	constructor(private readonly indexService: IndexService) {}

	async provideDefinition(document: vs.TextDocument, position: vs.Position): Promise<vs.Location | null> {
        let range = document.getWordRangeAtPosition(position, /"([A-Za-z_][A-Za-z0-9_.:-]+)"/);

        if (!range) {
			range = document.getWordRangeAtPosition(position, /\b([A-Za-z_][A-Za-z0-9_.:-]+)\b/);
			if (!range) return null;

            const lineText = document.lineAt(position.line).text;
            const textBefore = lineText.substring(0, range.start.character);
            if (!/\b[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*$/.test(textBefore)) return null;
		}

        const word = document.getText(range).replace(/^"|"$/g, '');

        if (/^\d+$/.test(word) || word.length < 2) return null;

        const entry = findLocEntry(word, document, this.indexService);
		if (!entry) return null;

		return new vs.Location(entry.uri, new vs.Position(entry.line, 0));
	}
}

/**
 * Register all localisation enhancements.
 */
export function registerLocalizationFeatures(context: vs.ExtensionContext, indexService: IndexService): void {
	const ymlSelector: vs.DocumentSelector = { scheme: 'file', pattern: '**/*.yml' };
	const gameLanguages = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'vic3', 'ck3', 'eu5', 'paradox'];
	const scriptSelector: vs.DocumentSelector = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));

	context.subscriptions.push(
		vs.languages.registerCompletionItemProvider(
			ymlSelector,
			new LocalisationCompletionProvider(indexService),
			'\u00a7',
			'\u00a3',
			'[',
			'$',
			'|',
			'.',
		),
		vs.languages.registerHoverProvider(ymlSelector, new LocRefHoverProvider(indexService)),
		vs.languages.registerDefinitionProvider(ymlSelector, new LocRefDefinitionProvider(indexService)),
		vs.languages.registerDefinitionProvider(scriptSelector, new ScriptLocDefinitionProvider(indexService)),
	);

	context.subscriptions.push(
		vs.window.onDidChangeActiveTextEditor(editor => {
			if (editor) updateColorDecorations(editor);
		}),
	);

	context.subscriptions.push(
		vs.workspace.onDidChangeTextDocument(event => {
			if (isYmlDocument(event.document)) {
				cacheOpenDocumentLocalisation(event.document);
			}
			const editor = vs.window.activeTextEditor;
			if (editor && event.document === editor.document) {
				updateColorDecorations(editor);
			}
		}),
		vs.workspace.onDidCloseTextDocument(document => {
			openDocumentLocCache.delete(document.uri.toString());
		}),
	);

	for (const doc of vs.workspace.textDocuments) {
		if (isYmlDocument(doc)) {
			cacheOpenDocumentLocalisation(doc);
		}
	}

	if (vs.window.activeTextEditor) {
		updateColorDecorations(vs.window.activeTextEditor);
	}
}
