import * as vs from 'vscode';
import { localize } from './panelI18n';
import type { AIService } from './ai/aiService';
import { getEffectiveEndpoint, getEffectiveModel } from './ai/providers';
import type { AIUserConfig, ChatMessage } from './ai/types';

const MAX_TRANSLATION_BATCH_CHARS = 12_000;
const MAX_DOCUMENT_COMMENT_CHARS = 60_000;
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';
const CACHE_LIMIT = 200;

interface CommentTranslationSnippet {
	relativePath: string;
	startLine: number;
	endLine: number;
	languageId: string;
	text: string;
}

export interface ExtractedCommentLine {
	line: number;
	startCharacter: number;
	endCharacter: number;
	text: string;
}

export interface ProtectedToken {
	placeholder: string;
	value: string;
}

export interface ProtectedText {
	text: string;
	tokens: ProtectedToken[];
}

export interface RestoreResult {
	text: string;
	ok: boolean;
	missing: string[];
}

interface TranslationCacheEntry {
	key: string;
	translation: string;
	provider: string;
	model: string;
}

interface TranslationPreviewSettings {
	provider: string;
	model: string;
	endpoint: string;
}

interface TranslatedCommentLine {
	comment: ExtractedCommentLine;
	translation: string;
	provider: string;
	model: string;
}

interface StoredTranslationPreview {
	version: number;
	decorations: vs.DecorationOptions[];
}

const translationCache = new Map<string, TranslationCacheEntry>();



function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function rememberCache(entry: TranslationCacheEntry): void {
	if (translationCache.has(entry.key)) {
		translationCache.delete(entry.key);
	}
	translationCache.set(entry.key, entry);
	while (translationCache.size > CACHE_LIMIT) {
		const oldest = translationCache.keys().next().value;
		if (!oldest) break;
		translationCache.delete(oldest);
	}
}

function readCache(key: string): TranslationCacheEntry | undefined {
	const entry = translationCache.get(key);
	if (!entry) return undefined;
	translationCache.delete(key);
	translationCache.set(key, entry);
	return entry;
}

function protectPattern(input: string, pattern: RegExp, tokens: ProtectedToken[]): string {
	return input.replace(pattern, value => {
		const placeholder = `__CWTP_${tokens.length}__`;
		tokens.push({ placeholder, value });
		return placeholder;
	});
}

export function protectPdxTokens(input: string): ProtectedText {
	const tokens: ProtectedToken[] = [];
	let text = input;
	text = protectPattern(text, /\\(?:n|r|t|"|'|\\)/g, tokens);
	text = protectPattern(text, /\$[A-Za-z0-9_.:-]+(?:\|[A-Za-z0-9!%+-]+)?\$/g, tokens);
	text = protectPattern(text, /\[[A-Za-z0-9_.:\-|]+(?:\.[A-Za-z0-9_.:\-|]+)*\]/g, tokens);
	text = protectPattern(text, /£[A-Za-z0-9_.:-]+£/g, tokens);
	text = protectPattern(text, /§[A-Za-z0-9!%+-]/g, tokens);
	return { text, tokens };
}

export function restorePdxTokens(input: string, tokens: readonly ProtectedToken[]): RestoreResult {
	let text = input;
	const missing: string[] = [];
	for (const token of tokens) {
		if (!text.includes(token.placeholder)) {
			missing.push(token.placeholder);
			continue;
		}
		text = text.split(token.placeholder).join(token.value);
	}
	return {
		text,
		ok: missing.length === 0 && !/__CWTP_\d+__/.test(text),
		missing,
	};
}

export function stripMarkdownFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
	return (match?.[1] ?? trimmed).trim();
}

function findCommentStart(line: string): number {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (ch === '\\') {
				escaped = true;
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '#') return i;
	}
	return -1;
}

export function extractCommentLines(text: string): ExtractedCommentLine[] {
	const comments: ExtractedCommentLine[] = [];
	const lines = text.split(/\r\n|\r|\n/);
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = lines[lineNumber]!;
		const start = findCommentStart(line);
		if (start < 0) continue;
		const end = line.trimEnd().length;
		const comment = line.slice(start, end);
		if (comment.slice(1).trim().length === 0) continue;
		comments.push({
			line: lineNumber,
			startCharacter: start,
			endCharacter: end,
			text: comment,
		});
	}
	return comments;
}

function commentLineMarker(index: number): string {
	return `__CWTL_${index}__`;
}

export function buildMarkedCommentBatch(comments: readonly string[]): string {
	return comments.map((comment, index) => `${commentLineMarker(index)} ${comment}`).join('\n');
}

export function parseMarkedCommentTranslations(text: string, expectedCount: number): string[] | undefined {
	const translations: Array<string | undefined> = new Array(expectedCount);
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (!line.trim()) continue;
		const match = line.match(/^__CWTL_(\d+)__\s*(.*)$/);
		if (!match) return undefined;
		const index = Number(match[1]);
		const translation = match[2]?.trim();
		if (!Number.isInteger(index) || index < 0 || index >= expectedCount || !translation || translations[index] !== undefined) {
			return undefined;
		}
		translations[index] = translation;
	}
	if (translations.filter(translation => translation !== undefined).length !== expectedCount) return undefined;
	return translations.map(translation => translation!);
}

export function buildTranslationMessages(snippet: CommentTranslationSnippet, protectedText: string, targetLanguage: string): ChatMessage[] {
	return [
		{
			role: 'system',
			content: [
				'You are a precise translation engine for Paradox/CWTools modding text.',
				`Target language: ${targetLanguage}. The translated prose must be written in ${targetLanguage}.`,
				'Return only the translated text. Do not add explanations, headings, notes, or Markdown fences.',
				'The input contains only # comments extracted from the active document.',
				'Translate only human-readable prose inside comments.',
				'For Simplified Chinese, use Simplified Chinese characters and Chinese wording for English prose.',
				'Each input line starts with a marker like __CWTL_0__. Preserve every line marker exactly and return exactly one output line for each marker.',
				'Preserve leading # comment markers, whitespace, quoting style, and protected placeholders.',
				'Preserve placeholders like __CWTP_0__ exactly. Never translate or rewrite them.',
				'Do not reconstruct, copy, or add the code that originally surrounded these comments.',
				'Preserve code identifiers only when they are standalone technical references, not ordinary prose.',
				'Do not leave English prose unchanged just because it touches #, ##, punctuation, or comment markers.',
				"Example for Simplified Chinese: '# #First is set to default' -> '# #第一个设置为默认值'.",
			].join('\n'),
		},
		{
			role: 'user',
			content: [
				`File: ${snippet.relativePath}:${snippet.startLine}-${snippet.endLine}`,
				`Language ID: ${snippet.languageId}`,
				'Comments to translate:',
				protectedText,
			].join('\n'),
		},
	];
}

function responseText(response: Awaited<ReturnType<AIService['chatCompletion']>>): string {
	const content = response.choices[0]?.message?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(part => part.type === 'text' ? part.text : '').join('');
	}
	return '';
}

function estimateMaxTokens(text: string): number {
	return Math.min(6000, Math.max(512, Math.ceil(text.length / 2) + 256));
}

async function pickTargetLanguage(): Promise<string | undefined> {
	const other = localize('Other...', '其他...');
	const picked = await vs.window.showQuickPick(
		[
			{ label: localize('Simplified Chinese', '简体中文'), value: DEFAULT_TARGET_LANGUAGE },
			{ label: localize('English', '英文'), value: 'English' },
			{ label: localize('Japanese', '日文'), value: 'Japanese' },
			{ label: localize('Korean', '韩文'), value: 'Korean' },
			{ label: localize('Russian', '俄文'), value: 'Russian' },
			{ label: localize('German', '德文'), value: 'German' },
			{ label: localize('French', '法文'), value: 'French' },
			{ label: other, value: 'other' },
		],
		{ placeHolder: localize('Target translation language', '目标翻译语言') }
	);
	if (!picked) return undefined;
	if (picked.value !== 'other') return picked.value;
	const input = await vs.window.showInputBox({
		prompt: localize('Target language', '目标语言'),
		placeHolder: 'e.g. Spanish, Polish, Brazilian Portuguese',
	});
	return input?.trim() || undefined;
}

function resolveTranslationPreviewSettings(aiService: AIService, config: AIUserConfig): TranslationPreviewSettings {
	const translationConfig = config.translationPreview;
	const dedicatedProvider = translationConfig.provider.trim();
	const provider = dedicatedProvider || config.provider;
	const model = dedicatedProvider
		? getEffectiveModel(provider, translationConfig.model)
		: config.model;
	return {
		provider,
		model,
		endpoint: getEffectiveEndpoint(provider, aiService.getEndpointForProvider(provider)),
	};
}

async function ensureAiEnabled(aiService: AIService): Promise<boolean> {
	const config = aiService.getConfig();
	if (config.enabled) return true;
	const configure = localize('Configure AI', '配置 AI');
	const choice = await vs.window.showWarningMessage(
		localize(
			'CWTools AI is disabled. Configure and enable AI before previewing a translation.',
			'CWTools AI 当前未启用。请先配置并启用 AI，然后再预览翻译。'
		),
		configure
	);
	if (choice === configure) {
		await vs.commands.executeCommand('cwtools.ai.configure');
	}
	return false;
}

async function translateComments(snippet: CommentTranslationSnippet, settings: TranslationPreviewSettings, targetLanguage: string, aiService: AIService): Promise<TranslationCacheEntry> {
	const protectedInput = protectPdxTokens(snippet.text);
	const cacheKey = [
		targetLanguage,
		settings.provider,
		settings.model,
		settings.endpoint,
		snippet.languageId,
		hashString(protectedInput.text),
		hashString(protectedInput.tokens.map(t => t.value).join('\u001f')),
	].join(':');
	const cached = readCache(cacheKey);
	if (cached) return cached;

	const response = await aiService.chatCompletion(
		buildTranslationMessages(snippet, protectedInput.text, targetLanguage),
		{
			providerId: settings.provider,
			model: settings.model || undefined,
			endpoint: settings.endpoint,
			temperature: 0.2,
			maxTokens: estimateMaxTokens(protectedInput.text),
			disableThinking: true,
		}
	);
	const raw = stripMarkdownFence(responseText(response));
	if (!raw.trim()) {
		throw new Error(localize('The AI provider returned an empty translation.', 'AI 提供商返回了空翻译。'));
	}
	const restored = restorePdxTokens(raw, protectedInput.tokens);
	if (!restored.ok) {
		throw new Error(localize(
			'The AI translation changed protected Paradox tokens, so the preview was discarded. Please retry or use a smaller selection.',
			'AI 翻译改动了受保护的 Paradox 标记，因此已丢弃本次预览。请重试或选择更小的片段。'
		));
	}

	const entry: TranslationCacheEntry = {
		key: cacheKey,
		translation: restored.text,
		provider: settings.provider,
		model: settings.model,
	};
	rememberCache(entry);
	return entry;
}

function createCommentBatches(comments: readonly ExtractedCommentLine[]): ExtractedCommentLine[][] {
	const batches: ExtractedCommentLine[][] = [];
	let current: ExtractedCommentLine[] = [];
	let currentLength = 0;

	for (const comment of comments) {
		let addition = commentLineMarker(current.length).length + 1 + comment.text.length;
		if (current.length > 0 && currentLength + 1 + addition > MAX_TRANSLATION_BATCH_CHARS) {
			batches.push(current);
			current = [];
			currentLength = 0;
			addition = commentLineMarker(0).length + 1 + comment.text.length;
		}
		if (addition > MAX_TRANSLATION_BATCH_CHARS) {
			throw new Error(localize(
				`A single comment is too long to translate (${comment.text.length}/${MAX_TRANSLATION_BATCH_CHARS} characters).`,
				`单条注释过长，无法翻译（${comment.text.length}/${MAX_TRANSLATION_BATCH_CHARS} 字符）。`
			));
		}
		current.push(comment);
		currentLength += (currentLength > 0 ? 1 : 0) + addition;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

async function translateDocumentComments(
	document: vs.TextDocument,
	comments: readonly ExtractedCommentLine[],
	settings: TranslationPreviewSettings,
	targetLanguage: string,
	aiService: AIService,
	reportProgress: (completed: number, total: number) => void
): Promise<TranslatedCommentLine[]> {
	const batches = createCommentBatches(comments);
	const translated: TranslatedCommentLine[] = [];

	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		const batch = batches[batchIndex]!;
		const snippet: CommentTranslationSnippet = {
			relativePath: vs.workspace.asRelativePath(document.uri),
			startLine: batch[0]!.line + 1,
			endLine: batch[batch.length - 1]!.line + 1,
			languageId: document.languageId,
			text: buildMarkedCommentBatch(batch.map(comment => comment.text)),
		};
		const entry = await translateComments(snippet, settings, targetLanguage, aiService);
		const translations = parseMarkedCommentTranslations(entry.translation, batch.length);
		if (!translations) {
			throw new Error(localize(
				'The AI provider changed the comment line markers, so the inline preview could not be mapped safely.',
				'AI 提供商改动了注释行标记，无法安全映射内联预览。'
			));
		}
		for (let index = 0; index < batch.length; index++) {
			translated.push({
				comment: batch[index]!,
				translation: translations[index]!,
				provider: entry.provider,
				model: entry.model,
			});
		}
		reportProgress(batchIndex + 1, batches.length);
	}
	return translated;
}

function translatedCommentText(translation: string): string {
	const commentStart = findCommentStart(translation);
	const text = (commentStart >= 0 ? translation.slice(commentStart + 1) : translation).trim();
	return text || translation.trim();
}

function createPreviewDecoration(
	item: TranslatedCommentLine,
	targetLanguage: string
): vs.DecorationOptions {
	const displayText = translatedCommentText(item.translation).replace(/\s+/g, ' ');
	const hover = new vs.MarkdownString();
	hover.appendMarkdown(`**${localize('Translated comment', '注释译文')}**\n\n`);
	hover.appendText(displayText);
	hover.appendMarkdown('\n\n---\n\n');
	hover.appendText(`${targetLanguage} · ${item.provider}${item.model ? ` / ${item.model}` : ''}`);
	return {
		range: new vs.Range(
			item.comment.line,
			item.comment.startCharacter,
			item.comment.line,
			item.comment.endCharacter
		),
		hoverMessage: hover,
		renderOptions: {
			after: {
				contentText: `  → ${displayText}`,
			},
		},
	};
}

class CommentTranslationPreviewController implements vs.Disposable {
	private readonly decorationType: vs.TextEditorDecorationType;
	private readonly previews = new Map<string, StoredTranslationPreview>();
	private readonly inFlightDocuments = new Set<string>();
	private readonly disposables: vs.Disposable[] = [];

	constructor(private readonly aiService: AIService) {
		this.decorationType = vs.window.createTextEditorDecorationType({
			rangeBehavior: vs.DecorationRangeBehavior.ClosedClosed,
			after: {
				color: new vs.ThemeColor('editorCodeLens.foreground'),
				fontStyle: 'italic',
				margin: '0 0 0 1.5em',
			},
		});
		this.disposables.push(
			this.decorationType,
			vs.workspace.onDidChangeTextDocument(event => {
				if (event.contentChanges.length > 0) this.clearDocument(event.document.uri);
			}),
			vs.workspace.onDidCloseTextDocument(document => {
				this.previews.delete(this.documentKey(document.uri));
			}),
			vs.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) this.applyPreview(editor);
			})
		);
	}

	dispose(): void {
		for (const editor of vs.window.visibleTextEditors) {
			editor.setDecorations(this.decorationType, []);
		}
		this.previews.clear();
		this.inFlightDocuments.clear();
		for (const disposable of this.disposables) disposable.dispose();
	}

	async toggle(): Promise<void> {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage(localize(
				'Open a Paradox script file to translate its comments.',
				'请先打开要翻译注释的 Paradox 脚本文件。'
			));
			return;
		}

		const document = editor.document;
		const key = this.documentKey(document.uri);
		if (this.previews.has(key)) {
			this.clearDocument(document.uri);
			return;
		}
		if (this.inFlightDocuments.has(key)) {
			vs.window.showInformationMessage(localize(
				'Comment translation is already running for this file.',
				'当前文件的注释翻译正在进行中。'
			));
			return;
		}

		const sourceVersion = document.version;
		const comments = extractCommentLines(document.getText());
		if (comments.length === 0) {
			vs.window.showWarningMessage(localize(
				'No non-empty # comments were found in the current file.',
				'当前文件中没有找到非空的 # 注释。'
			));
			return;
		}
		const totalCharacters = comments.reduce((total, comment) => total + comment.text.length, 0);
		if (totalCharacters > MAX_DOCUMENT_COMMENT_CHARS) {
			vs.window.showWarningMessage(localize(
				`The comments in this file are too long to translate safely (${totalCharacters}/${MAX_DOCUMENT_COMMENT_CHARS} characters).`,
				`当前文件的注释过长，无法安全翻译（${totalCharacters}/${MAX_DOCUMENT_COMMENT_CHARS} 字符）。`
			));
			return;
		}
		if (!(await ensureAiEnabled(this.aiService))) return;

		const targetLanguage = await pickTargetLanguage();
		if (!targetLanguage) return;
		if (document.isClosed || document.version !== sourceVersion) {
			vs.window.showWarningMessage(localize(
				'The file changed before translation started. Run comment translation again.',
				'文件在翻译开始前已发生变化，请重新启动注释翻译。'
			));
			return;
		}

		const settings = resolveTranslationPreviewSettings(this.aiService, this.aiService.getConfig());
		this.inFlightDocuments.add(key);
		try {
			const translated = await vs.window.withProgress(
				{
					location: vs.ProgressLocation.Notification,
					title: localize(
						`Translating ${comments.length} comments with AI...`,
						`正在使用 AI 翻译 ${comments.length} 条注释...`
					),
					cancellable: false,
				},
				progress => translateDocumentComments(
					document,
					comments,
					settings,
					targetLanguage,
					this.aiService,
					(completed, total) => progress.report({
						increment: 100 / total,
						message: `${completed}/${total}`,
					})
				)
			);
			if (document.isClosed || document.version !== sourceVersion) {
				vs.window.showWarningMessage(localize(
					'The file changed during translation, so the inline preview was discarded.',
					'文件在翻译期间发生变化，因此已丢弃内联预览。'
				));
				return;
			}

			this.previews.set(key, {
				version: sourceVersion,
				decorations: translated.map(item => createPreviewDecoration(item, targetLanguage)),
			});
			for (const visibleEditor of vs.window.visibleTextEditors) {
				if (this.documentKey(visibleEditor.document.uri) === key) this.applyPreview(visibleEditor);
			}
		} catch (error) {
			vs.window.showErrorMessage(localize(
				`Comment translation failed: ${(error as Error)?.message ?? String(error)}`,
				`注释翻译失败：${(error as Error)?.message ?? String(error)}`
			));
		} finally {
			this.inFlightDocuments.delete(key);
		}
	}

	private documentKey(uri: vs.Uri): string {
		return uri.toString();
	}

	private clearDocument(uri: vs.Uri): void {
		const key = this.documentKey(uri);
		if (!this.previews.delete(key)) return;
		for (const editor of vs.window.visibleTextEditors) {
			if (this.documentKey(editor.document.uri) === key) {
				editor.setDecorations(this.decorationType, []);
			}
		}
	}

	private applyPreview(editor: vs.TextEditor): void {
		const preview = this.previews.get(this.documentKey(editor.document.uri));
		if (!preview || preview.version !== editor.document.version) {
			editor.setDecorations(this.decorationType, []);
			return;
		}
		editor.setDecorations(this.decorationType, preview.decorations);
	}
}

export function registerTranslationPreviewCommands(context: vs.ExtensionContext, aiService: AIService): void {
	const controller = new CommentTranslationPreviewController(aiService);
	context.subscriptions.push(
		controller,
		vs.commands.registerCommand('cwtools.ai.previewSelectionTranslation', () => controller.toggle()),
		vs.commands.registerCommand('cwtools.ai.clearTranslationPreviewCache', () => {
			const count = translationCache.size;
			translationCache.clear();
			vs.window.showInformationMessage(localize(
				`Cleared ${count} translation preview cache entr${count === 1 ? 'y' : 'ies'}.`,
				`已清理 ${count} 条翻译预览缓存。`
			));
		})
	);
}
