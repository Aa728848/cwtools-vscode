import * as vs from 'vscode';
import type { AIService } from './ai/aiService';
import { getEffectiveEndpoint } from './ai/providers';
import type { AIUserConfig, ChatMessage } from './ai/types';

const MAX_SELECTION_CHARS = 12_000;
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';
const CACHE_LIMIT = 200;

interface SelectionTranslationSnippet {
	relativePath: string;
	startLine: number;
	endLine: number;
	languageId: string;
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

const translationCache = new Map<string, TranslationCacheEntry>();

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

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

function selectedSnippet(editor: vs.TextEditor): SelectionTranslationSnippet | undefined {
	const selections = editor.selections
		.filter(selection => !selection.isEmpty)
		.sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
	if (selections.length === 0) return undefined;

	const text = selections
		.map(selection => editor.document.getText(selection))
		.join('\n\n');
	if (!text.trim()) return undefined;

	return {
		relativePath: vs.workspace.asRelativePath(editor.document.uri),
		startLine: selections[0]!.start.line + 1,
		endLine: selections[selections.length - 1]!.end.line + 1,
		languageId: editor.document.languageId,
		text,
	};
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
	text = protectPattern(text, /\$[A-Za-z0-9_.:-]+(?:\|[A-Za-z0-9!%+\-]+)?\$/g, tokens);
	text = protectPattern(text, /\[[A-Za-z0-9_.:\-|]+(?:\.[A-Za-z0-9_.:\-|]+)*\]/g, tokens);
	text = protectPattern(text, /£[A-Za-z0-9_.:-]+£/g, tokens);
	text = protectPattern(text, /§[A-Za-z0-9!%+\-]/g, tokens);
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

export function extractSelectedComments(text: string): string {
	const comments: string[] = [];
	for (const line of text.split(/\r\n|\r|\n/)) {
		const start = findCommentStart(line);
		if (start < 0) continue;
		const comment = line.slice(start).trimEnd();
		if (comment.slice(1).trim().length === 0) continue;
		comments.push(comment);
	}
	return comments.join('\n');
}

export function buildTranslationMessages(snippet: SelectionTranslationSnippet, protectedText: string, targetLanguage: string): ChatMessage[] {
	return [
		{
			role: 'system',
			content: [
				'You are a precise translation engine for Paradox/CWTools modding text.',
				`Translate selected source-code comments into ${targetLanguage}.`,
				'Return only the translated text. Do not add explanations, headings, notes, or Markdown fences.',
				'The input contains only # comments extracted from a source selection.',
				'Translate only human-readable prose inside comments.',
				'Preserve line breaks, # comment markers, quoting style, and protected placeholders.',
				'Preserve placeholders like __CWTP_0__ exactly. Never translate or rewrite them.',
				'Do not reconstruct, copy, or add the code that originally surrounded these comments.',
				'Keep IDs, keys, file paths, scope chains, commands, and code-like tokens unchanged unless they are clearly prose.',
			].join('\n'),
		},
		{
			role: 'user',
			content: [
				`File: ${snippet.relativePath}:${snippet.startLine}-${snippet.endLine}`,
				`Language ID: ${snippet.languageId}`,
				'Selected comments:',
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
	const provider = translationConfig.provider || config.provider;
	const model = translationConfig.model || config.model;
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

async function translateSelection(snippet: SelectionTranslationSnippet, settings: TranslationPreviewSettings, targetLanguage: string, aiService: AIService): Promise<TranslationCacheEntry> {
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

function previewHtml(snippet: SelectionTranslationSnippet, translation: TranslationCacheEntry, targetLanguage: string): string {
	const title = localize('AI Translation Preview', 'AI 翻译预览');
	const source = localize('Source Comments', '原文注释');
	const translated = localize('Translated Preview', '译文预览');
	const note = localize(
		'Preview only. The source file was not modified.',
		'仅预览。源文件未被修改。'
	);
	const meta = `${snippet.relativePath}:${snippet.startLine}-${snippet.endLine} | ${targetLanguage} | ${translation.provider}${translation.model ? ` / ${translation.model}` : ''}`;
	return `<!DOCTYPE html>
<html lang="${isChineseLocale() ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
	body {
		margin: 0;
		padding: 18px;
		color: var(--vscode-editor-foreground);
		background: var(--vscode-editor-background);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
	}
	header {
		margin-bottom: 14px;
		border-bottom: 1px solid var(--vscode-panel-border);
		padding-bottom: 12px;
	}
	h1 {
		margin: 0 0 6px;
		font-size: 18px;
		font-weight: 600;
	}
	.meta, .note {
		color: var(--vscode-descriptionForeground);
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 14px;
	}
	section {
		min-width: 0;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--vscode-sideBarTitle-foreground);
	}
	pre {
		box-sizing: border-box;
		min-height: 220px;
		margin: 0;
		padding: 12px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px;
		background: var(--vscode-textCodeBlock-background);
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
		line-height: 1.5;
	}
	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
</head>
<body>
	<header>
		<h1>${escapeHtml(title)}</h1>
		<div class="meta">${escapeHtml(meta)}</div>
		<div class="note">${escapeHtml(note)}</div>
	</header>
	<main class="grid">
		<section>
			<h2>${escapeHtml(source)}</h2>
			<pre>${escapeHtml(snippet.text)}</pre>
		</section>
		<section>
			<h2>${escapeHtml(translated)}</h2>
			<pre>${escapeHtml(translation.translation)}</pre>
		</section>
	</main>
</body>
</html>`;
}

function showPreview(context: vs.ExtensionContext, snippet: SelectionTranslationSnippet, translation: TranslationCacheEntry, targetLanguage: string): void {
	const panel = vs.window.createWebviewPanel(
		'cwtools.translationPreview',
		localize('AI Translation Preview', 'AI 翻译预览'),
		vs.ViewColumn.Beside,
		{ enableScripts: false, localResourceRoots: [context.extensionUri] }
	);
	panel.webview.html = previewHtml(snippet, translation, targetLanguage);
}

async function previewSelectionTranslation(context: vs.ExtensionContext, aiService: AIService): Promise<void> {
	const editor = vs.window.activeTextEditor;
	if (!editor) {
		vs.window.showWarningMessage(localize('Open a file and select text to translate first.', '请先打开文件并选中要翻译的文本。'));
		return;
	}
	const snippet = selectedSnippet(editor);
	if (!snippet) {
		vs.window.showWarningMessage(localize('Select text to translate first.', '请先选中要翻译的文本。'));
		return;
	}
	const comments = extractSelectedComments(snippet.text);
	if (!comments.trim()) {
		vs.window.showWarningMessage(localize(
			'No # comments were found in the selection to translate.',
			'选区中没有找到可翻译的 # 注释。'
		));
		return;
	}
	const commentSnippet: SelectionTranslationSnippet = { ...snippet, text: comments };
	if (commentSnippet.text.length > MAX_SELECTION_CHARS) {
		vs.window.showWarningMessage(localize(
			`The selected comments are too long for preview translation (${commentSnippet.text.length}/${MAX_SELECTION_CHARS} characters).`,
			`选中注释过长，无法预览翻译（${commentSnippet.text.length}/${MAX_SELECTION_CHARS} 字符）。`
		));
		return;
	}
	if (!(await ensureAiEnabled(aiService))) return;

	const targetLanguage = await pickTargetLanguage();
	if (!targetLanguage) return;
	const settings = resolveTranslationPreviewSettings(aiService, aiService.getConfig());

	try {
		const translation = await vs.window.withProgress(
			{
				location: vs.ProgressLocation.Notification,
				title: localize('Translating selected comments with AI...', '正在使用 AI 翻译选中注释...'),
				cancellable: false,
			},
			() => translateSelection(commentSnippet, settings, targetLanguage, aiService)
		);
		showPreview(context, commentSnippet, translation, targetLanguage);
	} catch (error) {
		vs.window.showErrorMessage(
			localize(
				`Translation preview failed: ${(error as Error)?.message ?? String(error)}`,
				`翻译预览失败：${(error as Error)?.message ?? String(error)}`
			)
		);
	}
}

export function registerTranslationPreviewCommands(context: vs.ExtensionContext, aiService: AIService): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.ai.previewSelectionTranslation', () => previewSelectionTranslation(context, aiService)),
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
