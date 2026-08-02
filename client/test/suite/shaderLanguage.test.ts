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

interface ValidationStatusResponse {
    ok?: boolean;
    loading?: {
        inProgress?: boolean;
        phase?: string;
        lastError?: string | null;
    };
}

function applySemanticDelta(previous: number[], delta: SemanticTokensDeltaResponse): number[] {
    const next = [...previous];
    for (const edit of [...delta.edits].sort((left, right) => right.start - left.start)) {
        next.splice(edit.start, edit.deleteCount, ...(edit.data ?? []));
    }
    return next;
}

function requestValidationStatus(client: LanguageClient, timeoutMs = 2_000): Promise<ValidationStatusResponse | null> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`validation status request timed out after ${timeoutMs}ms`)),
            timeoutMs,
        );
        client.sendRequest<ValidationStatusResponse | null>('workspace/executeCommand', {
            command: 'cwtools.ai.getValidationStatus',
            arguments: [],
        }).then(
            status => {
                clearTimeout(timer);
                resolve(status);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function waitForServerReady(client: LanguageClient, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus: ValidationStatusResponse | null | undefined;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            lastStatus = await requestValidationStatus(client);
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
        }
        const loading = lastStatus?.loading;
        if (lastStatus?.ok === true && loading?.inProgress === false && loading.phase === 'ready') return;
        if (loading?.phase === 'load_project_error') {
            throw new Error(`CWTools language server failed to load the Shader fixture: ${loading.lastError ?? 'unknown error'}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
        `CWTools language server was not ready after ${timeoutMs}ms; `
        + `lastStatus=${JSON.stringify(lastStatus)} lastError=${String(lastError ?? '')}`,
    );
}

function assertShaderRulesConfiguration(): void {
    const rulesFolder = process.env.CWTOOLS_SHADER_TEST_RULES_FOLDER;
    assert.ok(rulesFolder, 'the Shader Extension Host test must provide a rules folder');
    const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
    assert.strictEqual(config.get('rules_folder'), rulesFolder, 'Shader rules must be configured before extension activation');
    assert.strictEqual(config.get('rules_version'), 'manual', 'Shader tests must not start the remote rules updater');
}

suite('Paradox Shader LSP contract', function () {
    this.timeout(120_000);

    let fixturePath: string;
    let document: vscode.TextDocument;
    let client: LanguageClient;

    setup(async () => {
        assertShaderRulesConfiguration();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, 'the Shader test workspace must be open');
        fixturePath = path.join(workspaceFolder.uri.fsPath, 'gfx', 'FX', 'shader_contract.fxh');
        const api = await activate() as CwtoolsExtensionApi | undefined;
        const languageClient = api?.getLanguageClient();
        assert.ok(languageClient, 'the extension must expose its live language client');
        client = languageClient;
        await waitForServerReady(client);
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

    test('a semantic-token cancellation race terminates cleanly and leaves later requests usable', async () => {
        const uri = document.uri.toString();
        const cancellation = new vscode.CancellationTokenSource();
        const pending = client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
            cancellation.token,
        );
        cancellation.cancel();
        try {
            const completed = await pending;
            assert.strictEqual(completed.data.length % 5, 0);
        } catch (error) {
            assert.match(String(error), /cancel/i);
        } finally {
            cancellation.dispose();
        }

        const retry = await client.sendRequest<SemanticTokensResponse>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
        );
        assert.strictEqual(retry.data.length % 5, 0);
    });

    test('returns event-field suggestions for a partially typed key', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder);
        const emptyEventPath = path.join(workspaceFolder.uri.fsPath, 'events', 'completion_empty.txt');
        const emptyEventDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(emptyEventPath));
        await vscode.languages.setTextDocumentLanguage(emptyEventDocument, 'stellaris');
        await vscode.window.showTextDocument(emptyEventDocument);
        const emptyCompletion = await client.sendRequest<{ items: Array<{ label: string }> } | null>(
            'textDocument/completion',
            {
                textDocument: { uri: emptyEventDocument.uri.toString() },
                position: { line: 3, character: emptyEventDocument.lineAt(3).text.length },
                context: { triggerKind: 1 },
            },
        );
        const emptyLabels = emptyCompletion?.items.map(item => item.label) ?? [];
        assert.ok(emptyLabels.includes('id'), `empty event completion must contain id; received: ${emptyLabels.slice(0, 40).join(', ')}`);

        const eventPath = path.join(workspaceFolder.uri.fsPath, 'events', 'completion_contract.txt');
        const eventDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(eventPath));
        await vscode.languages.setTextDocumentLanguage(eventDocument, 'stellaris');
        await vscode.window.showTextDocument(eventDocument);

        const line = eventDocument.lineAt(3);
        const completion = await client.sendRequest<{ items: Array<{ label: string }> } | null>(
            'textDocument/completion',
            {
                textDocument: { uri: eventDocument.uri.toString() },
                position: { line: 3, character: line.text.length },
                context: { triggerKind: 1 },
            },
        );

        assert.ok(completion, 'the LSP must return a completion list');
        const labels = completion.items.map(item => item.label);
        assert.ok(labels.includes('id'), `event completion must contain id; received: ${labels.slice(0, 40).join(', ')}`);
    });
});
