/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vs from 'vscode';
import { workspace, ExtensionContext, window, Disposable, Uri, WorkspaceEdit, TextEdit, Range, commands, env } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, NotificationType, ExecuteCommandRequest, ExecuteCommandParams, RevealOutputChannelOn } from 'vscode-languageclient/node';

import { FileExplorer, FileListItem } from './fileExplorer';
import { GuiPanel } from './guiPanel';
import { UI } from './ai/messages';
import { SolarSystemPanel } from './solarSystemPanel';
import * as exe from './executable';
import { registerLocalizationFeatures } from './locDecorations';
import { AIService, AgentToolExecutor, AgentRunner, PromptBuilder, AIChatPanelProvider, AIInlineCompletionProvider, UsageTracker } from './ai';
import { lastAISettingsWriteTime } from './ai/chatSettings';
import { checkForUpdates } from './updateChecker';

const stellarisRemote = `https://github.com/Aa728848/cwtools-stellaris-config`;
const eu4Remote = `https://github.com/cwtools/cwtools-eu4-config`;
const hoi4Remote = `https://github.com/cwtools/cwtools-hoi4-config`;
const ck2Remote = `https://github.com/cwtools/cwtools-ck2-config`;
const irRemote = `https://github.com/cwtools/cwtools-ir-config`;
const vic2Remote = `https://github.com/cwtools/cwtools-vic2-config`;
const vic3Remote = `https://github.com/cwtools/cwtools-vic3-config`;
const ck3Remote = `https://github.com/cwtools/cwtools-ck3-config`;
const eu5Remote = `https://github.com/kaiser-chris/cwtools-eu5-config`;

export let defaultClient: LanguageClient;
let fileList: FileListItem[];
let fileExplorer: FileExplorer;

const registeredCommands = new Map<string, Disposable>();
function safeRegisterCommand(context: ExtensionContext, commandId: string, handler: (...args: any[]) => any): void {
	const existing = registeredCommands.get(commandId);
	if (existing) {
		try { existing.dispose(); } catch (_) { /* ignore */ }
	}
	const disposable = commands.registerCommand(commandId, handler);
	registeredCommands.set(commandId, disposable);
	context.subscriptions.push(disposable);
}

export async function activate(context: ExtensionContext) {

	// 后台检查扩展更新
	await checkForUpdates(context).catch(console.error);

	// Register localization enhancements (§ color highlighting, $REF$ hover/goto)
	registerLocalizationFeatures(context);

	// Client-side Rename Provider — uses VSCode's built-in reference finding
	// Fix #8: shared game language list (was duplicated as gameLanguages and gameLanguages2)
	const gameLanguages = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'vic3', 'ck3', 'eu5', 'paradox'];
	const docSelector = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));

	context.subscriptions.push(
		vs.languages.registerRenameProvider(docSelector, {
			async provideRenameEdits(document, position, newName, _token) {
				const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_@$]+/);
				const oldName = wordRange ? document.getText(wordRange) : '';
				if (!oldName) {
					throw new Error('No symbol found at cursor');
				}

				const edit = new WorkspaceEdit();
				const editMeta: vs.WorkspaceEditEntryMetadata = {
					needsConfirmation: true,
					label: 'Rename Symbol'
				};

				// First try LSP references (works for type definitions)
				const refs: vs.Location[] = await vs.commands.executeCommand(
					'vscode.executeReferenceProvider', document.uri, position
				) || [];

				if (refs.length > 0) {
					for (const ref of refs) {
						const refDoc = await vs.workspace.openTextDocument(ref.uri);
						const refText = refDoc.getText(ref.range);
						if (refText === oldName) {
							edit.replace(ref.uri, ref.range, newName, editMeta);
						} else {
							const lineText = refDoc.lineAt(ref.range.start.line).text;
							const idx = lineText.indexOf(oldName, ref.range.start.character);
							if (idx >= 0) {
								edit.replace(ref.uri, new vs.Range(
									ref.range.start.line, idx,
									ref.range.start.line, idx + oldName.length
								), newName, editMeta);
							}
						}
					}
				} else {
					// Fallback: search all .txt files in workspace for exact word match
					const files = await vs.workspace.findFiles('**/*.txt', '**/.*/**');
					const wordBoundary = new RegExp(`(?<![A-Za-z0-9_])${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
					for (const fileUri of files.slice(0, 2000)) {
						let text: string;
						try { const buf = await vs.workspace.fs.readFile(fileUri); text = new TextDecoder('utf-8').decode(buf); } catch { continue; }
						// L4 Fix: avoid openTextDocument (never freed — memory leak)
						const offs: number[] = [0];
						for (let j = 0; j < text.length; j++) { if (text[j] === '\n') { offs.push(j + 1); } }
						const posAt = (o: number): vs.Position => {
							let lv = 0, hv = offs.length - 1;
							while (lv < hv) { const mid = Math.ceil((lv + hv) / 2); // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
 if (offs[mid]! <= o) { lv = mid; } else { hv = mid - 1; } }
							// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
							return new vs.Position(lv, o - offs[lv]!);
						};
						wordBoundary.lastIndex = 0;
						let match: RegExpExecArray | null;
						while ((match = wordBoundary.exec(text)) !== null) {
							edit.replace(fileUri, new vs.Range(posAt(match.index), posAt(match.index + oldName.length)), newName, editMeta);
						}
					}
				}

				if (edit.size === 0) {
					throw new Error('No occurrences found for rename');
				}
				return edit;
			},
			async prepareRename(document, position, _token) {
				const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_@$]+/);
				if (!wordRange) {
					throw new Error('Cannot rename this element');
				}
				return { range: wordRange, placeholder: document.getText(wordRange) };
			}
		})
	);

	// CodeLens click command — properly converts JSON args to VSCode types
	safeRegisterCommand(context, 'cwtools.showReferences', async (uriStr: string, pos: any, locs: any[]) => {
		const uri = vs.Uri.parse(uriStr);
		const position = new vs.Position(pos.line || 0, pos.character || 0);
		const locations = (locs || []).map((loc: any) => {
			const locUri = vs.Uri.parse(loc.uri);
			const range = new vs.Range(
				new vs.Position(loc.range?.start?.line || 0, loc.range?.start?.character || 0),
				new vs.Position(loc.range?.end?.line || 0, loc.range?.end?.character || 0)
			);
			return new vs.Location(locUri, range);
		});
		await vs.commands.executeCommand('editor.action.showReferences', uri, position, locations);
	});


	class CwtoolsProvider implements vs.TextDocumentContentProvider {
		private disposables: Disposable[] = [];

		constructor() {
			// Fix #7: capture registration Disposable instead of dropping it
			this.disposables.push(
				workspace.registerTextDocumentContentProvider("cwtools", this)
			);
		}
		async provideTextDocumentContent() {
			return '';
		}

		dispose(): void {
			this.disposables.forEach(d => d.dispose());
		}
	}

	const isDevDir = context.extensionMode === vs.ExtensionMode.Development
	// M4 Fix: context.globalStorageUri is a Uri object, not a string.
	// Concatenating it with '/' calls toString() which produces "file:///..."— not a valid fs path.
	// Use .fsPath and path.join() to get a proper filesystem path.
	const cacheDir = isDevDir
		? path.join(context.globalStorageUri.fsPath, '.cwtools')
		: path.join(context.extensionPath, '.cwtools')

	// ─── AI Module Integration (registered at top-level so panel works immediately) ──
	const aiService = new AIService(context);
	const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	// AgentToolExecutor gets a lazy getter so it can be registered before client starts
	const toolExecutor = new AgentToolExecutor(() => defaultClient, workspaceRoot);
	const promptBuilder = new PromptBuilder(workspaceRoot);
	const agentRunner = new AgentRunner(aiService, toolExecutor, promptBuilder);
	const usageTracker = new UsageTracker(context);
	const chatPanelProvider = new AIChatPanelProvider(
		context.extensionUri,
		agentRunner,
		aiService,
		usageTracker,
		context.globalStorageUri
	);
	context.subscriptions.push(
		vs.window.registerWebviewViewProvider(AIChatPanelProvider.viewType, chatPanelProvider)
	);

	// ─── Wire up AgentToolExecutor callbacks ─────────────────────────────────
	// onPendingWrite: route file-write confirmations through the WebView panel
	toolExecutor.onPendingWrite = (file, newContent, messageId) =>
		chatPanelProvider.handlePendingWrite(file, newContent, messageId);
	// onAutoWritten: show a read-only notification UI for auto-applied changes
	toolExecutor.onAutoWritten = (file, isNewFile) =>
		chatPanelProvider.handleAutoWritten(file, isNewFile);
	// onTodoUpdate: push todo list updates to the WebView panel
	toolExecutor.onTodoUpdate = (todos) =>
		chatPanelProvider.sendTodoUpdate(todos);
	// Sync fileWriteMode from config on startup
	toolExecutor.fileWriteMode = workspace.getConfiguration('cwtools.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm');
	// Re-sync fileWriteMode whenever config changes
	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('cwtools.ai.agentFileWriteMode')) {
			toolExecutor.fileWriteMode = workspace.getConfiguration('cwtools.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm');
		}
	}));
	// Invalidate LSP read cache on document changes so AI doesn't base decisions on stale data
	context.subscriptions.push(workspace.onDidChangeTextDocument(e => {
		toolExecutor.invalidateCacheForFile(e.document.uri.fsPath);
	}));
	// Fix #8: reuse shared gameLanguages instead of duplicate gameLanguages2
	const docSelector2 = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));
	const inlineProvider = new AIInlineCompletionProvider(aiService, promptBuilder, usageTracker);
	context.subscriptions.push(
		inlineProvider,
		chatPanelProvider,
		vs.languages.registerInlineCompletionItemProvider(docSelector2, inlineProvider)
	);
	safeRegisterCommand(context, "cwtools.ai.configure", async () => {
		await aiService.quickConfigureProvider();
	});
	safeRegisterCommand(context, "cwtools.ai.openChat", async () => {
		await vs.commands.executeCommand('cwtools.aiChat.focus');
	});
	safeRegisterCommand(context, "cwtools.ai.selectModel", async () => {
		await aiService.selectModelCommand();
	});

	// ── Quick AI commands (keyboard shortcuts / command palette) ──────────
	safeRegisterCommand(context, "cwtools.ai.reviewFile", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage(UI.NO_ACTIVE_EDITOR);
			return;
		}
		const relPath = vs.workspace.asRelativePath(editor.document.uri);
		await chatPanelProvider.sendProgrammaticMessage(
			`请审查当前文件 \`${relPath}\`，检查 scope 错误、逻辑问题和 CWTools 诊断警告。`
		);
	});

	safeRegisterCommand(context, "cwtools.ai.explainSelection", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage('没有打开的编辑器');
			return;
		}
		const selection = editor.document.getText(editor.selection);
		if (!selection.trim()) {
			vs.window.showWarningMessage(UI.SELECT_CODE_FIRST);
			return;
		}
		await chatPanelProvider.sendProgrammaticMessage(
			`请解释以下代码的作用、scope 链和逻辑：\n\`\`\`pdx\n${selection}\n\`\`\``
		);
	});

	safeRegisterCommand(context, "cwtools.ai.fixDiagnostics", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage('没有打开的编辑器');
			return;
		}
		const relPath = vs.workspace.asRelativePath(editor.document.uri);
		await chatPanelProvider.sendProgrammaticMessage(
			`请获取并修复当前文件 \`${relPath}\` 中的所有 CWTools 诊断错误。`
		);
	});

	const init = async function (language: string, isVanillaFolder: boolean) {
		vs.languages.setLanguageConfiguration(language, {
			wordPattern: /"?([^\s.]+)"?/,
			autoClosingPairs: [
				{ open: '{', close: '}' },
				{ open: '[', close: ']' },
				{ open: '(', close: ')' },
				{ open: '"', close: '"' },
				{ open: "'", close: "'" }
			]
		})
		// The server is implemented using dotnet core
		let serverExe: string;
		if (os.platform() == "win32") {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'win-x64', 'CWTools Server.exe'))
		}
		else if (os.platform() == "darwin") {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'osx-x64', 'CWTools Server'))
			fs.chmodSync(serverExe, '755');
		}
		else {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'linux-x64', 'CWTools Server'))
			fs.chmodSync(serverExe, '755');
		}
		
		async function getBestRepoPath(originalUrl: string): Promise<string> {
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const isCN = timeZone === 'Asia/Shanghai' || timeZone === 'Asia/Chongqing' || timeZone === 'Asia/Urumqi';

			if (isCN && originalUrl === stellarisRemote) {
				const giteeUrl = 'https://gitee.com/cChen2422/cwtools-stellaris-config';
				try {
					await new Promise<void>((resolve, reject) => {
						const req = require('https').request('https://gitee.com', { method: 'HEAD', timeout: 1500 }, (res: any) => {
							resolve();
						});
						req.on('error', reject);
						req.on('timeout', () => { req.destroy(); reject(); });
						req.end();
					});
					return giteeUrl;
				} catch (e) {
					// Fallback to github logic below if Gitee is completely down
				}
			}

			const customProxy = workspace.getConfiguration('cwtools').get<string>('rulesProxy', '')?.trim();
			if (customProxy) {
				if (customProxy.toLowerCase() === 'none' || customProxy.toLowerCase() === 'direct') {
					return originalUrl;
				}
				return customProxy.endsWith('/') ? customProxy + originalUrl : customProxy + '/' + originalUrl;
			}
			
			// If the user has a local proxy environment configured, assume direct connection works
			if (process.env.http_proxy || process.env.https_proxy || process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
				return originalUrl;
			}

			if (!isCN) {
				return originalUrl;
			}

			return new Promise(resolve => {
				const req = require('https').request('https://github.com', { method: 'HEAD', timeout: 1500 }, (res: any) => {
					resolve(originalUrl); // Success within time, use direct connection
				});
				
				const fallback = () => {
					const proxies = [
						`https://gh-proxy.org/${originalUrl}`,
						`https://hk.gh-proxy.org/${originalUrl}`,
						`https://cdn.gh-proxy.org/${originalUrl}`,
						`https://edgeone.gh-proxy.org/${originalUrl}`,
						originalUrl.replace('github.com', 'kkgithub.com')
					];
					if (typeof (Promise as any).any === 'function') {
						(Promise as any).any(proxies.map(p => new Promise<string>((res, rej) => {
							const preq = require('https').request(p, { method: 'HEAD', timeout: 2500 }, (pres: any) => {
								if (pres.statusCode === 200 || pres.statusCode === 301 || pres.statusCode === 302) res(p);
								else rej();
							});
							preq.on('error', rej);
							preq.on('timeout', () => { preq.destroy(); rej(); });
							preq.end();
						}))).then((res: string) => resolve(res)).catch(() => resolve(proxies[0]!));
					} else {
						resolve(proxies[0]!);
					}
				};

				req.on('error', fallback);
				req.on('timeout', () => { req.destroy(); fallback(); });
				req.end();
			});
		}

		let repoPathStr = undefined;
		switch (language) {
			case "stellaris": repoPathStr = stellarisRemote; break;
			case "eu4": repoPathStr = eu4Remote; break;
			case "hoi4": repoPathStr = hoi4Remote; break;
			case "ck2": repoPathStr = ck2Remote; break;
			case "imperator": repoPathStr = irRemote; break;
			case "vic2": repoPathStr = vic2Remote; break;
			case "vic3": repoPathStr = vic3Remote; break;
			case "ck3": repoPathStr = ck3Remote; break;
			case "eu5": repoPathStr = eu5Remote; break;
			default: repoPathStr = stellarisRemote; break;
		}
		const repoPath = await getBestRepoPath(repoPathStr);
		console.log(language + " " + repoPath);

		// If the extension is launched in debug mode then the debug server options are used
		// Otherwise the run options are used
		const serverOptions: ServerOptions = {
			run: { command: serverExe, transport: TransportKind.stdio },
			debug: { command: serverExe, transport: TransportKind.stdio }
		}

		const fileEvents = [
			workspace.createFileSystemWatcher("**/{events,common,map,map_data,prescripted_countries,flags,decisions,missions}/**/*.txt"),
			workspace.createFileSystemWatcher("**/{interface,gfx}/**/*.gui"),
			workspace.createFileSystemWatcher("**/{interface,gfx}/**/*.gfx"),
			workspace.createFileSystemWatcher("**/{interface}/**/*.sfx"),
			workspace.createFileSystemWatcher("**/{interface,gfx,fonts,music,sound}/**/*.asset"),
			workspace.createFileSystemWatcher("**/{localisation,localisation_synced,localization}/**/*.yml")
		]

		// Options to control the language client
		const clientOptions: LanguageClientOptions = {
			// Register the server for F# documents
			documentSelector: [{ scheme: 'file', language: 'paradox' }, { scheme: 'file', language: 'yaml' }, { scheme: 'file', language: 'stellaris' },
			{ scheme: 'file', language: 'hoi4' }, { scheme: 'file', language: 'eu4' }, { scheme: 'file', language: 'ck2' }, { scheme: 'file', language: 'imperator' }
				, { scheme: 'file', language: 'vic2' }, { scheme: 'file', language: 'vic3' }, { scheme: 'file', language: 'ck3' }, { scheme: 'file', language: 'eu5' }, { scheme: 'file', language: 'paradox' }],
			synchronize: {
				// Synchronize the setting section 'cwtools' to the server
				configurationSection: 'cwtools',
				// Notify the server about file changes to F# project files contain in the workspace

				fileEvents: fileEvents
			},
			middleware: {
				workspace: {
					didChangeConfiguration: async (sections: any, next: (sections: any) => Promise<void>) => {
						// Drop config changes if they were just triggered by our own AI Settings Manager
						// This prevents the F# server from resetting the workspace because of pure UI changes.
						if (Date.now() - lastAISettingsWriteTime < 1500) {
							return;
						}
						await next(sections);
					}
				}
			},
			initializationOptions: {
				language: language === 'eu5' ? 'paradox' : language,
				isVanillaFolder: isVanillaFolder,
				rulesCache: cacheDir,
				rules_version: workspace.getConfiguration('cwtools').get('rules_version'),
				repoPath: repoPath,
				diagnosticLogging: workspace.getConfiguration('cwtools').get('logging.diagnostic')
			},
			revealOutputChannelOn: RevealOutputChannelOn.Error
		}

		const client = new LanguageClient('cwtools', 'Paradox Language Server', serverOptions, clientOptions);
		const log = client.outputChannel
		defaultClient = client;
		client.registerProposedFeatures();
		interface loadingBarParams { enable: boolean; value: string; percentage?: number }
		const loadingBarNotification = new NotificationType<loadingBarParams>('loadingBar');
		interface debugStatusBarParams { enable: boolean; value: string }
		const debugStatusBarParamsNotification = new NotificationType<debugStatusBarParams>('debugBar');
		interface CreateVirtualFile { uri: string; fileContent: string }
		const createVirtualFile = new NotificationType<CreateVirtualFile>('createVirtualFile');
		const promptReload = new NotificationType<string>('promptReload')
		const forceReload = new NotificationType<string>('forceReload')
		const promptVanillaPath = new NotificationType<string>('promptVanillaPath')
		interface DidFocusFile { uri: string }
		const didFocusFile = new NotificationType<DidFocusFile>('didFocusFile')
		let status: Disposable | undefined;
		interface UpdateFileList { fileList: FileListItem[] }
		const updateFileList = new NotificationType<UpdateFileList>('updateFileList');

		async function didChangeActiveTextEditor(editor: vs.TextEditor | undefined): Promise<void> {
			if (editor) {
				const path = editor.document.uri.toString();
				if (languageId == "paradox" && editor.document.languageId == "plaintext") {
					await vs.languages.setTextDocumentLanguage(editor.document, "paradox")
				}
				if (editor.document.languageId == language) {
					await client.sendNotification(didFocusFile, { uri: path });
				}
			}
		}

		context.subscriptions.push(window.onDidChangeActiveTextEditor(didChangeActiveTextEditor));

		// 监听文档变化，当在 script_value 环境中输入 | 时自动触发补全
		let lastCursorLine = -1;
		let lastCursorChar = -1;
		context.subscriptions.push(workspace.onDidChangeTextDocument(async (e) => {
			// 只处理当前活动的文本
			if (window.activeTextEditor && e.document === window.activeTextEditor.document) {
				const doc = window.activeTextEditor.document;

				// 只处理 paradox 语言
				if (doc.languageId !== language) return;

				// 获取当前光标位置
				const cursor = window.activeTextEditor.selection.active;
				const currentLine = cursor.line;
				const currentChar = cursor.character;

				// 检查是否有变化
				if (currentLine === lastCursorLine && currentChar === lastCursorChar) return;
				lastCursorLine = currentLine;
				lastCursorChar = currentChar;

				// 获取当前行文本
				const lineText = doc.lineAt(currentLine).text;

				// 检查是否在 value:xxx| 环境中
				// 匹配模式：value:xxx| （光标在 | 之后）
				const textBeforeCursor = lineText.substring(0, currentChar);

				// 检查是否以 value:xxx| 结尾（允许空格）
				const scriptValuePattern = /value\s*:\s*\S+\|\s*$/;
				const isMatch = scriptValuePattern.test(textBeforeCursor);

				if (isMatch) {
					// 延迟 150ms 后触发补全，让文档同步完成
					setTimeout(() => {
						commands.executeCommand('editor.action.triggerSuggest');
					}, 150);
				}
			}
		}));

		if (languageId == "paradox") {
			for (const textDocument of workspace.textDocuments) {
				if (textDocument.languageId == "plaintext") {
					await vs.languages.setTextDocumentLanguage(textDocument, "paradox")
				}
			}
		}

		let resolveLoadingBar: (() => void) | undefined;
		let loadingReporter: vs.Progress<{ message?: string; increment?: number; }> | undefined;
			let lastPercentage = 0;

		client.onNotification(loadingBarNotification, (param: loadingBarParams) => {
			if (param.enable) {
				if (status !== undefined) {
					status.dispose();
					status = undefined;
				}
				status = window.setStatusBarMessage(param.value);
				context.subscriptions.push(status);

				if (!resolveLoadingBar) {
					vs.window.withProgress({
						location: vs.ProgressLocation.Notification,
						cancellable: false,
						title: "CWTools",
					}, (progress) => {
						loadingReporter = progress;
						const inc0 = param.percentage !== undefined ? Math.max(0, param.percentage - lastPercentage) : undefined;
						lastPercentage = param.percentage ?? lastPercentage;
						progress.report({ message: param.value, increment: inc0 });
						return new Promise<void>((resolve) => {
							resolveLoadingBar = resolve;
						});
					}).then(() => {
						loadingReporter = undefined;
						resolveLoadingBar = undefined;
					});
				} else {
					if (loadingReporter) {
						const inc = param.percentage !== undefined ? Math.max(0, param.percentage - lastPercentage) : undefined;
						lastPercentage = param.percentage ?? lastPercentage;
						loadingReporter.report({ message: param.value, increment: inc });
					}
				}
			} else {
				lastPercentage = 0;
				if (status !== undefined) {
					status.dispose();
					status = undefined;
				}
				if (resolveLoadingBar) {
					resolveLoadingBar();
					resolveLoadingBar = undefined;
					loadingReporter = undefined;
				}
			}
		})
		const debugStatusBar = window.createStatusBarItem(vs.StatusBarAlignment.Left);
		context.subscriptions.push(debugStatusBar);
		client.onNotification(debugStatusBarParamsNotification, (param: debugStatusBarParams) => {
			if (param.enable) {
				debugStatusBar.text = param.value;
				debugStatusBar.show();
			}
			else if (!param.enable) {
				debugStatusBar.hide();
			}
		})
		client.onNotification(createVirtualFile, async (param: CreateVirtualFile) => {
			const uri = Uri.parse(param.uri);
			const doc = await workspace.openTextDocument(uri);
			const edit = new WorkspaceEdit();
			const range = new Range(0, 0, doc.lineCount, doc.getText().length);
			edit.set(uri, [new TextEdit(range, param.fileContent)]);
			await workspace.applyEdit(edit);
			await window.showTextDocument(uri);
		})
		client.onNotification(promptReload, async (param: string) => {
			await reloadExtension(param, "Reload")
		})
		client.onNotification(forceReload, async (param: string) => {
			window.showInformationMessage(param);
			await commands.executeCommand('workbench.action.reloadWindow');
		})
		client.onNotification(promptVanillaPath, async (param: string) => {
			let gameDisplay = ""
			switch (param) {
				case "stellaris": gameDisplay = "Stellaris"; break;
				case "hoi4": gameDisplay = "Hearts of Iron IV"; break;
				case "eu4": gameDisplay = "Europa Universalis IV"; break;
				case "ck2": gameDisplay = "Crusader Kings II"; break;
				case "imperator": gameDisplay = "Imperator"; break;
				case "vic2": gameDisplay = "Victoria II"; break;
				case "vic3": gameDisplay = "Victoria 3"; break;
				case "ck3": gameDisplay = "Crusader Kings III"; break;
				case "eu5": gameDisplay = "Europa Universalis V"; break;
			}
			const result = await window.showInformationMessage("Please select the vanilla installation folder for " + gameDisplay, "Select folder");
			if (!result) {
				return;
			}
			const uri = await window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: "Select vanilla installation folder for " + gameDisplay
			});
			if (!uri) {
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const directory = uri[0]!;
			const gameFolder = path.basename(directory.fsPath)
			let dir = directory.fsPath
			let game = ""
			switch (gameFolder) {
				case "Stellaris": game = "stellaris"; break;
				case "Hearts of Iron IV": game = "hoi4"; break;
				case "Europa Universalis IV": game = "eu4"; break;
				case "Crusader Kings II": game = "ck2"; break;
				case "Crusader Kings III":
					game = "ck3";
					dir = path.join(dir, "game");
					break;
				case "Victoria II": game = "vic2"; break;
				case "Victoria 2": game = "vic2"; break;
				case "Victoria 3":
					game = "vic3";
					dir = path.join(dir, "game");
					break;
				case "ImperatorRome":
					game = "imperator";
					dir = path.join(dir, "game");
					break;
				case "Imperator":
					game = "imperator";
					dir = path.join(dir, "game");
					break;
				case "Europa Universalis V":
					game = "eu5";
					dir = path.join(dir, "game");
					break;
			}
			console.log(path.join(dir, "common"));
			if (game === "" || !(fs.existsSync(path.join(dir, "common")))) {
				await window.showErrorMessage("The selected folder does not appear to be a supported game folder")
			}
			else {
				log.appendLine("path" + dir)
				log.appendLine("log" + game)
				await workspace.getConfiguration("cwtools").update("cache." + game, dir, true)
				await reloadExtension("Reloading to generate vanilla cache", undefined, true);
			}
		})
		client.onNotification(updateFileList, (params: UpdateFileList) => {
			fileList = params.fileList;
			if (fileExplorer) {
				fileExplorer.refresh(fileList);
			}
			else {
				fileExplorer = new FileExplorer(context, fileList);
			}
		})

		if (workspace.name === undefined) {
			await window.showWarningMessage("You have opened a file directly.\n\rFor CWTools to work correctly, the mod folder should be opened using \"File, Open Folder\"")
		}


		// Create the language client and start the client.

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		context.subscriptions.push(new CwtoolsProvider());

		const toggleInlineTextFunc = async () => {
			const config = vs.workspace.getConfiguration("cwtools");
			const currentState = config.get<boolean>("showInlineText", false);
			await config.update("showInlineText", !currentState, vs.ConfigurationTarget.Global);
			if (!currentState) {
				vs.window.showInformationMessage("Inline Text is now ON");
			} else {
				vs.window.showInformationMessage("Inline Text is now OFF");
			}
		};

		// Toggle Inline Text commands for dynamic icon
		safeRegisterCommand(context, "cwtools.toggleInlineTextOn", toggleInlineTextFunc);
		safeRegisterCommand(context, "cwtools.toggleInlineTextOff", toggleInlineTextFunc);

		// GUI Preview command
		safeRegisterCommand(context, "cwtools.previewGUI", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.gui')) {
				vs.window.showWarningMessage('GUI Preview is only available for .gui files');
				return;
			}
			await GuiPanel.create(context.extensionPath, doc);
		});

		// Solar System Preview command
		safeRegisterCommand(context, "cwtools.previewSolarSystem", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.txt')) {
				vs.window.showWarningMessage('Solar System Preview is only available for .txt files');
				return;
			}
			// Check if file is in solar_system_initializers directory
			const normalizedPath = fileName.replace(/\\/g, '/');
			if (!normalizedPath.includes('solar_system_initializers')) {
				const result = await vs.window.showWarningMessage(
					'This file is not in a solar_system_initializers directory. Preview anyway?',
					'Preview', 'Cancel'
				);
				if (result !== 'Preview') return;
			}
			await SolarSystemPanel.create(context.extensionPath, doc);
		});

		safeRegisterCommand(context, "cwtools.reloadExtension", async () => {
			// Stop the language server client first
			if (defaultClient) {
				try { await defaultClient.stop(); } catch (_) { /* ignore */ }
			}
			// Dispose GUI panel if open
			if (GuiPanel.currentPanel) {
				try { GuiPanel.currentPanel.dispose(); } catch (_) { /* ignore */ }
			}
			// L7 Fix: dispose the chat panel provider before re-activating so its
			// WebView is closed and callbacks don't reference a stale agentRunner.
			try { chatPanelProvider.dispose(); } catch (_) { /* ignore */ }
			// Dispose all subscriptions
			for (const sub of context.subscriptions) {
				try {
					sub.dispose();
				} catch (e) {
					console.error(e);
				}
			}
			// Clear the array to prevent accumulation
			context.subscriptions.length = 0;
			await activate(context);
		});

		await client.start();
	}

	let languageId: string;
	const knownLanguageIds = ["stellaris", "eu4", "hoi4", "ck2", "imperator", "vic2", "vic3", "ck3", "eu5"];
	const getLanguageIdFallback = async function () {
		const markerFiles = await workspace.findFiles("**/*.txt", null, 1);
		if (markerFiles.length == 1) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			return (await workspace.openTextDocument(markerFiles[0]!)).languageId;
		}
		return null;
	}

	let guessedLanguageId: string | undefined | null = window.activeTextEditor?.document?.languageId;
	if (guessedLanguageId === undefined || !knownLanguageIds.includes(guessedLanguageId)) {
		guessedLanguageId = await getLanguageIdFallback();
	}

	switch (guessedLanguageId) {
		case "stellaris": languageId = "stellaris"; break;
		case "eu4": languageId = "eu4"; break;
		case "hoi4": languageId = "hoi4"; break;
		case "ck2": languageId = "ck2"; break;
		case "imperator": languageId = "imperator"; break;
		case "vic2": languageId = "vic2"; break;
		case "vic3": languageId = "vic3"; break;
		case "ck3": languageId = "ck3"; break;
		case "eu5": languageId = "eu5"; break;
		default: languageId = "paradox"; break;
	}
	async function findExeInFiles(gameExeName: string, binariesPrefix = false) {
		if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
			return [];
		}

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const root = workspace.workspaceFolders[0]!;
		const isWin = os.platform() === "win32";
		const ext = isWin ? "*.exe" : "*";
		const prefix = binariesPrefix ? "binaries/" : "";
		const names = [gameExeName, gameExeName.toUpperCase(), gameExeName.toLowerCase()];
		const patterns = names.map(name => new vs.RelativePattern(root, `${prefix}${name}${ext}`));

		const results = await Promise.all(patterns.map(p => workspace.findFiles(p)));
		const allFiles = results.flat();

		// Proper async filter
		const validFiles = await Promise.all(
			allFiles.map(async (v) => (await exe.existAndIsExe(v.fsPath)) ? v : null)
		).then(arr => arr.filter(Boolean));

		return validFiles;
	}
	const games = [
		{ id: "eu4", exeName: "eu4", binariesPrefix: false },
		{ id: "hoi4", exeName: "hoi4", binariesPrefix: false },
		{ id: "stellaris", exeName: "stellaris", binariesPrefix: false },
		{ id: "ck2", exeName: "CK2", binariesPrefix: false },
		{ id: "imperator", exeName: "imperator", binariesPrefix: true },
		{ id: "vic2", exeName: "v2game", binariesPrefix: false },
		{ id: "ck3", exeName: "ck3", binariesPrefix: true },
		{ id: "vic3", exeName: "victoria3", binariesPrefix: true },
		{ id: "eu5", exeName: "eu5", binariesPrefix: true },
	];

	const promises = games.map(({ exeName, binariesPrefix }) =>
		findExeInFiles(exeName, binariesPrefix)
	);

	const results = await Promise.all(promises);

	let isVanillaFolder = false;

	for (let i = 0; i < results.length; i++) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const { id } = games[i]!;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		if (results[i]!.length > 0 && (languageId === null || languageId === id)) {
			isVanillaFolder = true;
			languageId = id;
		}
	}

	if (
		workspace.workspaceFolders &&
		workspace.workspaceFolders.length > 0 &&
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		path.basename(workspace.workspaceFolders[0]!.uri.fsPath) === "game"
	) {
		isVanillaFolder = true;
	}

	await init(languageId, isVanillaFolder);
}


export async function reloadExtension(prompt: string, buttonText?: string, force?: boolean) {
	const restartAction = buttonText || "Restart";
	const actions = [restartAction];
	if (force) {
		window.showInformationMessage(prompt);
		await commands.executeCommand("cwtools.reloadExtension");
	}
	else {
		const chosenAction = prompt && await window.showInformationMessage(prompt, ...actions);
		if (!prompt || chosenAction === restartAction) {
			await commands.executeCommand("cwtools.reloadExtension");
		}
	}
}
// export default defaultClient;
