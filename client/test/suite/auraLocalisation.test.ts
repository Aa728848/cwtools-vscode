import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { CwtoolsExtensionApi } from '../../extension/extension';
import type { AuraLocalisationPayload } from '../../extension/auraLocalisation';

interface ValidationStatusResponse {
	ok?: boolean;
	loading?: { inProgress?: boolean; phase?: string };
}

const FIXTURE = path.join('game', 'common', 'component_templates', 'auras.txt');

const EXPECTED_FRIENDLY_LINE =
	'SRA_Aura_5_1:0 "§Y防御性光环§!\\n对盟友舰船效果：'
	+ '\\n $MOD_SHIP_SHIELD_DAMAGE_MULT$：§G+50%§!'
	+ '\\n $MOD_SHIP_ARMOR_DAMAGE_MULT$：§G+50%§!'
	+ '\\n $MOD_SHIP_HULL_DAMAGE_MULT$：§G+50%§!"';

function workspaceFile(relative: string): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder, 'The cwt-game workspace should be open');
	return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
}

function getClient(extension: CwtoolsExtensionApi | undefined): LanguageClient {
	const client = extension?.getLanguageClient();
	assert.ok(client, 'Extension should expose a language client');
	return client!;
}

async function waitForServerReady(client: LanguageClient, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const status = await client.sendRequest<ValidationStatusResponse | null>('workspace/executeCommand', {
				command: 'cwtools.ai.getValidationStatus',
				arguments: [],
			});
			const loading = status?.loading;
			if (status?.ok === true && loading?.inProgress === false && loading.phase === 'ready') return;
		} catch {
			// server still starting
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error('CWTools language server was not ready in time');
}

async function openFixture(): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument(workspaceFile(FIXTURE));
	return vscode.window.showTextDocument(document);
}

async function generate(command: string): Promise<AuraLocalisationPayload> {
	const payload = await vscode.commands.executeCommand<AuraLocalisationPayload | undefined>(command);
	assert.ok(payload, `${command} should return a payload`);
	return payload!;
}

function positionOf(editor: vscode.TextEditor, needle: string): vscode.Position {
	for (let line = 0; line < editor.document.lineCount; line++) {
		const index = editor.document.lineAt(line).text.indexOf(needle);
		if (index >= 0) return new vscode.Position(line, index + 1);
	}
	throw new Error(`fixture does not contain ${needle}`);
}

const VIRTUAL_AURA_URI = 'cwtools://auraloc';

/** `executeCodeActionProvider` returns server actions either as `CodeAction`
 * instances or as plain `Command` objects, depending on literal support. */
function resolveCodeActionCommand(
	action: vscode.CodeAction | vscode.Command,
): { id: string; args: readonly unknown[] | undefined } | undefined {
	if (action instanceof vscode.CodeAction) {
		return action.command ? { id: action.command.command, args: action.command.arguments } : undefined;
	}
	return { id: action.command, args: action.arguments };
}

async function waitForVirtualAuraText(expected: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let text = '';
	while (Date.now() < deadline) {
		text = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === VIRTUAL_AURA_URI)?.getText() ?? '';
		if (text === expected) return text;
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	return text;
}

suite('Aura localisation generation', function () {
	this.timeout(5 * 60 * 1000);

	suiteSetup(async function () {
		const extension = vscode.extensions.getExtension('ForeverSkywalker.foreverskywalker-stellaris-cwtools')!;
		await extension.activate();
		await waitForServerReady(getClient(extension.exports as CwtoolsExtensionApi));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('contributes both aura localisation commands', async function () {
		const commands = await vscode.commands.getCommands();
		assert.ok(
			commands.includes('cwtools.localisation.generateAuraForBlock'),
			'generateAuraForBlock should be registered',
		);
		assert.ok(
			commands.includes('cwtools.localisation.generateAuraForFile'),
			'generateAuraForFile should be registered',
		);
	});

	test('offers the aura code actions on an aura block', async function () {
		const editor = await openFixture();
		const position = positionOf(editor, 'hostile_aura = {');

		const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
			'vscode.executeCodeActionProvider',
			editor.document.uri,
			new vscode.Range(position, position),
		);

		const titles = (actions ?? []).map(action => action.title);
		const blockAction = (actions ?? []).find(action => action.title === 'Generate aura localisation for this aura block');
		assert.ok(blockAction, `expected the block code action, got ${JSON.stringify(titles)}`);

		const resolved = resolveCodeActionCommand(blockAction!);
		assert.strictEqual(
			resolved?.id,
			'cwtools.localisation.generateAura',
			`unexpected command for the block code action: ${JSON.stringify(resolved)}`,
		);

		const args = resolved?.args ?? [];
		assert.strictEqual(args.length, 4, `unexpected code action arguments: ${JSON.stringify(args)}`);
		// Compare paths: the server sends its own URI spelling, which may differ in
		// escaping from `Uri.toString()`.
		assert.strictEqual(
			typeof args[0] === 'string' ? vscode.Uri.parse(args[0]).fsPath.toLowerCase() : '',
			editor.document.uri.fsPath.toLowerCase(),
			`unexpected target for the block code action: ${JSON.stringify(args)}`,
		);
		assert.strictEqual(args[1], 'block');
		assert.strictEqual(args[2], position.line);
		assert.strictEqual(args[3], position.character);
		assert.ok(
			titles.includes('Generate aura localisation for all auras in this file'),
			`expected the file code action, got ${JSON.stringify(titles)}`,
		);
	});

	test('generates every aura in the file through the language server', async function () {
		await openFixture();

		const payload = await generate('cwtools.localisation.generateAuraForFile');

		assert.strictEqual(payload.ok, true, `expected ok, got message=${payload.message}`);
		assert.strictEqual(payload.scope, 'file');
		assert.strictEqual(payload.count, 2, `expected two auras, got ${JSON.stringify(payload.lines)}`);
		assert.deepStrictEqual(
			payload.entries.map(entry => [entry.key, entry.kind]),
			[['SRA_Aura_5_1', 'friendly'], ['SRA_Aura_Hostile_1', 'hostile']],
		);
		assert.strictEqual(payload.lines[0], EXPECTED_FRIENDLY_LINE);

		const hostileLine = payload.lines[1] ?? '';
		assert.ok(hostileLine.length > 0, 'expected a hostile aura line');
		assert.ok(hostileLine.startsWith('SRA_Aura_Hostile_1:0 "§Y敌对光环§!\\n对敌方舰船效果：'), hostileLine);
		assert.ok(hostileLine.includes('$MOD_SHIP_TRACKING_ADD$：§G+10§!'), hostileLine);
		assert.ok(hostileLine.includes('$MOD_SHIP_FIRE_RATE_MULT$：§G+25%§!'), hostileLine);
		assert.ok(hostileLine.includes('每日伤害：§G1-2§!'), hostileLine);
		assert.ok(hostileLine.includes('护盾伤害：§G50%§!'), hostileLine);
		assert.ok(!hostileLine.includes('$MOD_CUSTOM_TOOLTIP$'), hostileLine);

		const virtualText = await waitForVirtualAuraText(payload.lines.join('\r\n'));
		assert.strictEqual(virtualText, payload.lines.join('\r\n'), 'the read-only aura buffer should show the generated lines');
	});

	test('generates only the aura under the cursor in block scope', async function () {
		const editor = await openFixture();
		const position = positionOf(editor, 'hostile_aura = {');
		editor.selections = [new vscode.Selection(position, position)];

		const payload = await generate('cwtools.localisation.generateAuraForBlock');

		assert.strictEqual(payload.ok, true, `expected ok, got message=${payload.message}`);
		assert.strictEqual(payload.scope, 'block');
		assert.strictEqual(payload.count, 1);
		assert.deepStrictEqual(payload.entries.map(entry => entry.key), ['SRA_Aura_Hostile_1']);

		const expectedLine = payload.lines[0] ?? '';
		const virtualText = await waitForVirtualAuraText(expectedLine);
		assert.strictEqual(
			virtualText,
			expectedLine,
			'a repeated generation should replace the aura buffer with the new content',
		);
	});

	test('reports a cursor outside every aura block', async function () {
		const editor = await openFixture();
		const firstLine = new vscode.Position(0, 0);
		editor.selections = [new vscode.Selection(firstLine, firstLine)];

		const payload = await generate('cwtools.localisation.generateAuraForBlock');

		assert.strictEqual(payload.ok, false);
		assert.strictEqual(payload.count, 0);
		assert.deepStrictEqual(payload.lines, []);
		assert.strictEqual(payload.message, '光标不在 friendly_aura / hostile_aura 块内');

		const expectedText = `# ${payload.message}`;
		assert.strictEqual(
			await waitForVirtualAuraText(expectedText),
			expectedText,
			'a failure should still be visible in the read-only buffer',
		);
	});
});
