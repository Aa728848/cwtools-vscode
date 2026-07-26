import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { CwtoolsExtensionApi } from '../../extension/extension';
import { activate } from '../utils';

interface SemanticTokensResponse {
    data: number[];
    resultId?: string;
}

interface SemanticTokensDeltaResponse {
    resultId: string;
    edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
}

function applySemanticDelta(previous: number[], delta: SemanticTokensDeltaResponse): number[] {
    const next = [...previous];
    for (const edit of [...delta.edits].sort((left, right) => right.start - left.start)) {
        next.splice(edit.start, edit.deleteCount, ...(edit.data ?? []));
    }
    return next;
}

const shaderRulesConfigurationReady = (async () => {
    const rulesFolder = process.env.CWTOOLS_SHADER_TEST_RULES_FOLDER;
    assert.ok(rulesFolder, 'the Shader Extension Host test must provide a rules folder');
    const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
    await config.update('rules_folder', rulesFolder, vscode.ConfigurationTarget.Global);
    await config.update('rules_version', 'manual', vscode.ConfigurationTarget.Global);
})();

suite('Paradox Shader LSP contract', function () {
    this.timeout(120_000);

    let fixturePath: string;
    let document: vscode.TextDocument;
    let client: LanguageClient;

    setup(async () => {
        await shaderRulesConfigurationReady;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, 'the Shader test workspace must be open');
        fixturePath = path.join(workspaceFolder.uri.fsPath, 'gfx', 'FX', 'shader_contract.fxh');
        const api = await activate() as CwtoolsExtensionApi | undefined;
        const languageClient = api?.getLanguageClient();
        assert.ok(languageClient, 'the extension must expose its live language client');
        client = languageClient;
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath));
        await vscode.window.showTextDocument(document);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('uses real file URIs for references, rename, signature, folding and selection', async () => {
        const uri = document.uri.toString();
        const callOffset = document.getText().lastIndexOf('ShaderContractHelper');
        const callPosition = document.positionAt(callOffset);

        const references = await client.sendRequest<Array<{ uri: string }>>(
            'textDocument/references',
            { textDocument: { uri }, position: callPosition, context: { includeDeclaration: true } },
        );
        assert.strictEqual(references.length, 2);
        assert.ok(references.every(reference => vscode.Uri.parse(reference.uri).fsPath === document.uri.fsPath));

        const prepared = await client.sendRequest<{ placeholder: string } | null>(
            'textDocument/prepareRename',
            { textDocument: { uri }, position: callPosition },
        );
        assert.strictEqual(prepared?.placeholder, 'ShaderContractHelper');

        const rename = await client.sendRequest<{ changes?: Record<string, unknown[]> }>(
            'textDocument/rename',
            { textDocument: { uri }, position: callPosition, newName: 'RenamedHelper' },
        );
        const renameEdits = Object.entries(rename.changes ?? {})
            .find(([changeUri]) => vscode.Uri.parse(changeUri).fsPath === document.uri.fsPath)?.[1];
        assert.strictEqual(renameEdits?.length, 2);

        const signaturePosition = document.positionAt(document.getText().lastIndexOf('0.5') + 3);
        const signature = await client.sendRequest<{ activeParameter?: number; signatures: unknown[] } | null>(
            'textDocument/signatureHelp',
            { textDocument: { uri }, position: signaturePosition },
        );
        assert.strictEqual(signature?.activeParameter, 1);
        assert.ok((signature?.signatures.length ?? 0) > 0);

        const folds = await client.sendRequest<unknown[]>('textDocument/foldingRange', { textDocument: { uri } });
        const selections = await client.sendRequest<unknown[]>('textDocument/selectionRange', {
            textDocument: { uri },
            positions: [callPosition],
        });
        assert.ok(folds.length >= 3);
        assert.strictEqual(selections.length, 1);
    });

    test('semantic-token delta reconstructs the exact current document version', async () => {
        const uri = document.uri.toString();
        const full = await client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
        );
        assert.ok(full.resultId);
        assert.strictEqual(full.data.length % 5, 0);

        const oldText = document.getText();
        const weightOffset = oldText.indexOf('float weight');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(weightOffset), document.positionAt(weightOffset + 5)), 'half ');
        assert.ok(await vscode.workspace.applyEdit(edit));

        const delta = await client.sendRequest<SemanticTokensDeltaResponse | SemanticTokensResponse>(
            'textDocument/semanticTokens/full/delta',
            { textDocument: { uri }, previousResultId: full.resultId },
        );
        const current = await client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
        );
        const reconstructed = 'edits' in delta ? applySemanticDelta(full.data, delta) : delta.data;
        assert.deepStrictEqual(reconstructed, current.data);

        const restore = new vscode.WorkspaceEdit();
        const currentText = document.getText();
        const halfOffset = currentText.indexOf('half  weight');
        restore.replace(document.uri, new vscode.Range(document.positionAt(halfOffset), document.positionAt(halfOffset + 6)), 'float');
        assert.ok(await vscode.workspace.applyEdit(restore));
    });

    test('a cancelled semantic-token request rejects as cancellation and leaves later requests usable', async () => {
        const uri = document.uri.toString();
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();
        const pending = client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
            cancellation.token,
        );
        await assert.rejects(pending, error => /cancel/i.test(String(error)));
        cancellation.dispose();

        const retry = await client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
        );
        assert.strictEqual(retry.data.length % 5, 0);
    });
});
