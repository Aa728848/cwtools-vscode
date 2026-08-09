import * as vs from 'vscode';
import { localize } from './panelI18n';

type SendProgrammaticMessage = (message: string) => Promise<void>;

export type LocalisationAiTask = 'translate' | 'polish';

export interface LocalisationSnippet {
	relativePath: string;
	startLine: number;
	endLine: number;
	text: string;
	languageId: string;
}

const MAX_SNIPPET_CHARS = 20000;



function trimSnippet(text: string): string {
	if (text.length <= MAX_SNIPPET_CHARS) return text;
	return `${text.slice(0, MAX_SNIPPET_CHARS)}\n...`;
}

function activeLocalisationSnippet(): LocalisationSnippet | undefined {
	const editor = vs.window.activeTextEditor;
	if (!editor) return undefined;

	const range = editor.selection.isEmpty
		? editor.document.lineAt(editor.selection.active.line).range
		: editor.selection;
	const text = editor.document.getText(range).trim();
	if (!text) return undefined;

	return {
		relativePath: vs.workspace.asRelativePath(editor.document.uri),
		startLine: range.start.line + 1,
		endLine: range.end.line + 1,
		text: trimSnippet(text),
		languageId: editor.document.languageId,
	};
}

function invariantPrompt(snippet: LocalisationSnippet): string {
	return [
		`File: \`${snippet.relativePath}:${snippet.startLine}-${snippet.endLine}\``,
		`Language ID: \`${snippet.languageId}\``,
		'Keep the project local-first and use this extension\'s own CWTools/Stellaris rules as the source of truth.',
		'Preserve localisation keys, version markers such as `:0`, indentation, comments, escape sequences, variables like `$KEY$`, scripted bracket expressions like `[Root.GetName]`, icons like `£energy£`, and colour codes like `§Y...§!`.',
		'When editing `.yml` localisation, preserve the existing language header and encoding/BOM expectations and use the localisation-safe write path.',
	].join('\n');
}

export function buildLocalisationAiPrompt(task: LocalisationAiTask, snippet: LocalisationSnippet, targetLanguage?: string): string {
	const quoted = `\`\`\`yaml\n${snippet.text}\n\`\`\``;
	if (task === 'translate') {
		return [
			`Translate the selected Stellaris localisation text into ${targetLanguage ?? 'the requested target language'}.`,
			invariantPrompt(snippet),
			'If the selected text is already in the target language, polish it lightly instead of changing terminology.',
			'Apply the change to the selected file/range when it is safe; otherwise explain the exact replacement.',
			'',
			quoted,
		].join('\n');
	}

	return [
		'Polish the selected Stellaris localisation text in its current language without changing gameplay meaning.',
		invariantPrompt(snippet),
		'Prefer clearer, consistent in-game phrasing. Do not translate identifiers or placeholders.',
		'Apply the change to the selected file/range when it is safe; otherwise explain the exact replacement.',
		'',
		quoted,
	].join('\n');
}

async function pickTargetLanguage(): Promise<string | undefined> {
	const other = localize('Other...', '其他...');
	const picked = await vs.window.showQuickPick(
		[
			{ label: localize('Simplified Chinese', '简体中文'), value: 'Simplified Chinese' },
			{ label: localize('English', '英文'), value: 'English' },
			{ label: localize('Japanese', '日文'), value: 'Japanese' },
			{ label: localize('Korean', '韩文'), value: 'Korean' },
			{ label: localize('Russian', '俄文'), value: 'Russian' },
			{ label: localize('German', '德文'), value: 'German' },
			{ label: localize('French', '法文'), value: 'French' },
			{ label: other, value: 'other' },
		],
		{ placeHolder: localize('Target localisation language', '目标本地化语言') },
	);
	if (!picked) return undefined;
	if (picked.value !== 'other') return picked.value;
	const input = await vs.window.showInputBox({
		prompt: localize('Target language', '目标语言'),
		placeHolder: 'e.g. Spanish, Polish, Brazilian Portuguese',
	});
	return input?.trim() || undefined;
}

async function runLocalisationAiTask(task: LocalisationAiTask, sendMessage: SendProgrammaticMessage): Promise<void> {
	const snippet = activeLocalisationSnippet();
	if (!snippet) {
		await vs.window.showWarningMessage(localize(
			'Select localisation text or place the cursor on a localisation line first.',
			'请先选中本地化文本，或将光标放在本地化行上。',
		));
		return;
	}

	const targetLanguage = task === 'translate' ? await pickTargetLanguage() : undefined;
	if (task === 'translate' && !targetLanguage) return;

	await sendMessage(buildLocalisationAiPrompt(task, snippet, targetLanguage));
}

export function registerLocalisationAiCommands(context: vs.ExtensionContext, sendMessage: SendProgrammaticMessage): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.localisation.translateSelection', () => runLocalisationAiTask('translate', sendMessage)),
		vs.commands.registerCommand('cwtools.localisation.polishSelection', () => runLocalisationAiTask('polish', sendMessage)),
	);
}
