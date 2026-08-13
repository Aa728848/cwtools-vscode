import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { CwtoolsExtensionApi } from '../../extension/extension';
import { activate } from '../utils';

interface ValidationStatusResponse {
    ok?: boolean;
    loading?: {
        inProgress?: boolean;
        phase?: string;
        lastError?: string | null;
    };
    modelEpoch?: { game: number; rules: number; types: number; localisation: number };
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

async function waitForServerReady(client: LanguageClient, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const status = await requestValidationStatus(client);
            const loading = status?.loading;
            if (status?.ok === true && loading?.inProgress === false && loading.phase === 'ready') return;
        } catch {
            // server still starting
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('CWTools language server was not ready in time');
}

async function rulesEpoch(client: LanguageClient): Promise<number> {
    const status = await requestValidationStatus(client);
    return status?.modelEpoch?.rules ?? -1;
}

async function waitForRulesEpochAbove(client: LanguageClient, value: number, timeoutMs = 60_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const current = await rulesEpoch(client);
        if (current > value) return current;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`rules epoch did not advance above ${value}`);
}

function getClient(extension: CwtoolsExtensionApi | undefined): LanguageClient {
    const client = extension?.getLanguageClient();
    assert.ok(client, 'Extension should expose a language client');
    return client!;
}

function diagnosticCodeValue(code: vscode.Diagnostic['code']): string {
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
    return code?.value != null ? String(code.value) : '';
}

function workspaceFile(relative: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The cwt-game workspace should be open');
    return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
}

suite('CWT rule activation', function () {
    this.timeout(5 * 60 * 1000);

    const rulesUri = workspaceFile('config/rules.cwt');
    let originalRulesText = '';

    suiteSetup(async function () {
        originalRulesText = Buffer.from(await vscode.workspace.fs.readFile(rulesUri)).toString('utf8');
    });

    suiteTeardown(async function () {
        const rulesDoc = await vscode.workspace.openTextDocument(rulesUri);
        const restore = new vscode.WorkspaceEdit();
        restore.replace(rulesUri, new vscode.Range(0, 0, rulesDoc.lineCount, 0), originalRulesText);
        await vscode.workspace.applyEdit(restore);
        await rulesDoc.save();
    });

    test('valid rule edits activate and advance the rules epoch', async function () {
        const ext = vscode.extensions.getExtension('ForeverSkywalker.foreverskywalker-stellaris-cwtools')!;
        await Promise.race([
            ext.activate(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('extension activate timed out')), 60_000)),
        ]);
        const client = getClient(ext.exports as CwtoolsExtensionApi);
        await waitForServerReady(client);

        const baseline = await rulesEpoch(client);
        assert.ok(baseline >= 0, 'rules epoch should be available');

        // Edit the rules file (valid change) and save: the candidate snapshot
        // activates and bumps the rules epoch.
        const rulesDoc = await vscode.workspace.openTextDocument(rulesUri);
        const rulesText = rulesDoc.getText();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            rulesUri,
            new vscode.Range(0, 0, rulesDoc.lineCount, 0),
            rulesText.replace('\t\tA\n', '\t\tA\n\t\tB\n'),
        );
        await vscode.workspace.applyEdit(edit);
        await rulesDoc.save();

        await waitForRulesEpochAbove(client, baseline);
    });

    test('invalid candidate keeps last-known-good; repair upgrades', async function () {
        const ext = vscode.extensions.getExtension('ForeverSkywalker.foreverskywalker-stellaris-cwtools')!;
        await ext.activate();
        const client = getClient(ext.exports as CwtoolsExtensionApi);
        await waitForServerReady(client);

        const beforeBroken = await rulesEpoch(client);

        // Break the rules file: activation must be rejected, epoch unchanged.
        const rulesDoc = await vscode.workspace.openTextDocument(rulesUri);
        const brokenText = rulesDoc.getText() + '\ncount = int[0..banana]\n';
        const edit = new vscode.WorkspaceEdit();
        edit.replace(rulesUri, new vscode.Range(0, 0, rulesDoc.lineCount, 0), brokenText);
        await vscode.workspace.applyEdit(edit);
        await rulesDoc.save();

        // The blocking CWT201 diagnostic appears on the rules file.
        const diagnosticDeadline = Date.now() + 60_000;
        let codes: string[] = [];
        while (Date.now() < diagnosticDeadline) {
            codes = vscode.languages.getDiagnostics(rulesUri).map(d => diagnosticCodeValue(d.code));
            if (codes.includes('CWT201')) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(codes.includes('CWT201'), `expected CWT201 on the broken rules, got ${JSON.stringify(codes)}`);

        // Give any (wrong) activation a chance to land, then verify it did not.
        await new Promise(resolve => setTimeout(resolve, 3_000));
        const afterBroken = await rulesEpoch(client);
        assert.strictEqual(afterBroken, beforeBroken, 'invalid candidate must not advance the rules epoch');

        // Repair: fix the expression and add C. The repaired candidate upgrades.
        const repairedText = brokenText
            .replace('count = int[0..banana]\n', '')
            .replace('\t\tA\n', '\t\tA\n\t\tC\n');
        const repairEdit = new vscode.WorkspaceEdit();
        repairEdit.replace(rulesUri, new vscode.Range(0, 0, rulesDoc.lineCount, 0), repairedText);
        await vscode.workspace.applyEdit(repairEdit);
        await rulesDoc.save();

        await waitForRulesEpochAbove(client, beforeBroken);
    });
});
