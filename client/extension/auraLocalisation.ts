import * as vs from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { localize } from './panelI18n';

/** Read-only LSP command declared in `src/LSP/Commands.fs` and implemented in
 * `src/Main/Program.fs`. It re-parses the buffer text, so it does not need the
 * game model to be loaded. */
const GENERATE_AURA_COMMAND = 'cwtools.localisation.generateAura';

export type AuraLocalisationScope = 'block' | 'file';

export interface AuraLocalisationEntry {
	key: string;
	kind: string;
	startLine: number;
}

export interface AuraLocalisationPayload {
	ok: boolean;
	scope: string;
	count: number;
	lines: string[];
	message: string | null;
	entries: AuraLocalisationEntry[];
}

async function runAuraLocalisation(
	client: LanguageClient | undefined,
	scope: AuraLocalisationScope,
): Promise<AuraLocalisationPayload | undefined> {
	// Messages are fire-and-forget: awaiting a notification toast would keep the
	// command and its payload pending until the user dismisses it.
	const editor = vs.window.activeTextEditor;
	if (!editor) {
		void vs.window.showWarningMessage(
			localize('Open a component template file first.', '请先打开一个 component_templates 文件。'),
		);
		return undefined;
	}
	if (!client) {
		void vs.window.showWarningMessage(
			localize('The CWTools language server is not running yet.', 'CWTools 语言服务尚未运行。'),
		);
		return undefined;
	}

	const position = editor.selection.active;
	const args: Array<string | number> = [editor.document.uri.toString(), scope];
	if (scope === 'block') {
		args.push(position.line, position.character);
	}

	let payload: AuraLocalisationPayload | null;
	try {
		payload = await client.sendRequest<AuraLocalisationPayload | null>('workspace/executeCommand', {
			command: GENERATE_AURA_COMMAND,
			arguments: args,
		});
	} catch (error) {
		void vs.window.showWarningMessage(
			localize(
				`Aura localisation generation failed: ${String(error)}`,
				`光环本地化生成失败：${String(error)}`,
			),
		);
		return undefined;
	}

	if (!payload) {
		void vs.window.showWarningMessage(
			localize('Aura localisation generation returned no result.', '光环本地化生成未返回结果。'),
		);
		return undefined;
	}

	if (!payload.ok && payload.message) {
		void vs.window.showWarningMessage(payload.message);
	}

	return payload;
}

export function registerAuraLocalisationCommands(
	context: vs.ExtensionContext,
	getClient: () => LanguageClient | undefined,
): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.localisation.generateAuraForBlock', () =>
			runAuraLocalisation(getClient(), 'block'),
		),
		vs.commands.registerCommand('cwtools.localisation.generateAuraForFile', () =>
			runAuraLocalisation(getClient(), 'file'),
		),
	);
}
