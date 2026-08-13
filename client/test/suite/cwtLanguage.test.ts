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
        lastGame?: string;
        lastError?: string | null;
    };
}

function workspaceFile(relative: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The CWT fixture workspace should be open');
    return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
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

async function waitForServerReady(client: LanguageClient, timeoutMs = 90_000): Promise<ValidationStatusResponse> {
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
        if (lastStatus?.ok === true && loading?.inProgress === false && loading.phase === 'ready') return lastStatus;
        if (loading?.phase === 'load_project_error') {
            throw new Error(`CWTools language server failed to load the CWT fixture: ${loading.lastError ?? 'unknown error'}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
        `CWTools language server was not ready after ${timeoutMs}ms; `
        + `lastStatus=${JSON.stringify(lastStatus)} lastError=${String(lastError ?? '')}`,
    );
}

function getClient(extension: CwtoolsExtensionApi | undefined): LanguageClient {
    const client = extension?.getLanguageClient();
    assert.ok(client, 'Extension should expose a language client');
    return client!;
}

async function diagnosticsFor(uri: vscode.Uri): Promise<vscode.Diagnostic[]> {
    return vscode.languages.getDiagnostics(uri);
}

function diagnosticCodeValue(code: vscode.Diagnostic['code']): string {
    // The extension enriches codes with CodeDescription links; the value
    // is what the server actually published.
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
    return code?.value != null ? String(code.value) : '';
}

async function waitForNonEmptyDiagnostics(uri: vscode.Uri, timeoutMs = 60_000): Promise<vscode.Diagnostic[]> {
    const deadline = Date.now() + timeoutMs;
    let last = await diagnosticsFor(uri);
    while (last.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        last = await diagnosticsFor(uri);
    }
    return last;
}

async function waitForEmptyDiagnostics(uri: vscode.Uri, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const diagnostics = await diagnosticsFor(uri);
        if (diagnostics.length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Expected diagnostics for ${uri.toString()} to clear within ${timeoutMs}ms`);
}

suite('CWT-only language support', function () {
    this.timeout(3 * 60 * 1000);

    const brokenUri = workspaceFile('config/broken.cwt');
    const sampleUri = workspaceFile('config/sample.cwt');

    test('starts the server in CWT-only mode without a game model', async function () {
        const extension = await activate();
        const client = getClient(extension as CwtoolsExtensionApi);
        const status = await waitForServerReady(client);
        // The server reports the CWT profile, not a game, and must not have
        // loaded any game entities.
        assert.strictEqual(status.loading?.lastGame, 'CWT');
    });

    test('publishes CWT001-family parser diagnostics for a broken rule file', async function () {
        const doc = await vscode.workspace.openTextDocument(brokenUri);
        await vscode.window.showTextDocument(doc);
        const diagnostics = await waitForNonEmptyDiagnostics(brokenUri);
        const codes = diagnostics.map(diagnostic => diagnosticCodeValue(diagnostic.code));
        assert.ok(
            codes.some(code => code.startsWith('CWT001')),
            `expected a CWT001-family diagnostic, got ${JSON.stringify(codes)}`,
        );
    });

    test('reports no diagnostics for a valid rule file', async function () {
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);
        // Give the server a moment to publish; the diagnostics must stay empty.
        await new Promise(resolve => setTimeout(resolve, 2_000));
        const diagnostics = await diagnosticsFor(sampleUri);
        const cwtDiagnostics = diagnostics.filter(diagnostic =>
            diagnosticCodeValue(diagnostic.code).startsWith('CWT'),
        );
        assert.deepStrictEqual(cwtDiagnostics, []);
    });

    test('clears diagnostics once the syntax error is fixed', async function () {
        const doc = await vscode.workspace.openTextDocument(brokenUri);
        await vscode.window.showTextDocument(doc);
        await waitForNonEmptyDiagnostics(brokenUri);

        // Close the open `types` block: the file becomes valid.
        const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
        const text = doc.getText();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(brokenUri, fullRange, `${text}\n}\n`);
        await vscode.workspace.applyEdit(edit);
        await waitForEmptyDiagnostics(brokenUri);
    });

    test('publishes CWT2xx semantic diagnostics for an illegal field expression', async function () {
        const uri = workspaceFile('config/semantic-error.cwt');
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const diagnostics = await waitForNonEmptyDiagnostics(uri);
        const codes = diagnostics.map(diagnostic => diagnosticCodeValue(diagnostic.code));
        assert.ok(
            codes.some(code => code.startsWith('CWT2')),
            `expected a CWT2xx semantic diagnostic, got ${JSON.stringify(codes)}`,
        );
    });

    test('serves completion via the LSP protocol directly', async function () {
        const extension = await activate();
        const client = getClient(extension as CwtoolsExtensionApi);
        await waitForServerReady(client);
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        assert.strictEqual(doc.languageId, 'cwt', `sample.cwt resolved to language '${doc.languageId}'`);
        const result = await client.sendRequest<{ items?: Array<{ label?: string }> }>('textDocument/completion', {
            textDocument: { uri: sampleUri.toString() },
            position: { line: 12, character: 0 },
        });
        const labels = result?.items?.map(item => item.label) ?? [];
        assert.ok(
            labels.includes('on_actions'),
            `expected LSP completion from the CWT service, got ${JSON.stringify(labels.slice(0, 10))}`,
        );
    });

    test('completes root blocks, directives and field expressions without a game model', async function () {
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);        // Probe: verify VS Code invokes completion providers for this doc at all.
        let probeFired = false;
        const probe = vscode.languages.registerCompletionItemProvider({ language: 'cwt' }, {
            provideCompletionItems: () => { probeFired = true; return []; },
        });
        try {
            await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                sampleUri,
                new vscode.Position(12, 0),
            );
            assert.ok(probeFired, 'VS Code did not invoke any completion provider for sample.cwt');
        } finally {
            probe.dispose();
        }
        // Root blocks at the end of the file (after the types block, line 13
        // 0-based is the blank line at depth 0). `on_actions` never appears in
        // the fixture text, so word-fallback suggestions cannot fake it.
        const rootItems = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            sampleUri,
            new vscode.Position(12, 0),
        );
        const rootLabels = rootItems?.items.map(item => item.label) ?? [];
        // `on_actions` is a meta-model root block that never appears in the
        // fixture text, so word-fallback suggestions cannot fake it.
        assert.ok(
            rootLabels.some(label => typeof label === 'string' && label === 'on_actions'),
            `expected root-block completion, got ${JSON.stringify(rootLabels.slice(0, 10))}`,
        );
        // Field expressions on the right side of `=` inside the types block
        // (line 6 0-based: `type[planet_class] = {`).
        const fieldItems = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            sampleUri,
            new vscode.Position(5, 22),
        );
        const fieldLabels = fieldItems?.items.map(item => item.label) ?? [];
        assert.ok(
            fieldLabels.some(label => label === 'value_field' || label === 'bool'),
            `expected field-expression completion, got ${JSON.stringify(fieldLabels.slice(0, 10))}`,
        );
    });

    test('stays connected when rapid edits supersede pending CWT index rebuilds', async function () {
        const extension = await activate();
        const client = getClient(extension as CwtoolsExtensionApi);
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);
        const original = doc.getText();

        try {
            for (let i = 0; i < 20; i += 1) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(sampleUri, new vscode.Range(0, 0, doc.lineCount, 0), `${original}\n# rebuild ${i}\n`);
                assert.ok(await vscode.workspace.applyEdit(edit), `failed to apply rebuild edit ${i}`);
            }
        } finally {
            const restore = new vscode.WorkspaceEdit();
            restore.replace(sampleUri, new vscode.Range(0, 0, doc.lineCount, 0), original);
            assert.ok(await vscode.workspace.applyEdit(restore), 'failed to restore the CWT fixture');
        }

        // Let the debounce window close, then use a direct protocol request so
        // an exited server cannot be masked by VS Code word suggestions.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const result = await client.sendRequest<{ items?: Array<{ label?: string }> }>('textDocument/completion', {
            textDocument: { uri: sampleUri.toString() },
            position: { line: 12, character: 0 },
        });
        const labels = result?.items?.map(item => item.label) ?? [];
        assert.ok(labels.includes('on_actions'), 'language server stopped responding after rebuild cancellation');
    });

    test('serves cross-file completion and navigation through the project index', async function () {
        const defsUri = workspaceFile('config/defs.cwt');
        // Opening defs.cwt triggers a project-index rebuild.
        const defsDoc = await vscode.workspace.openTextDocument(defsUri);
        await vscode.window.showTextDocument(defsDoc);

        // Cross-file completion: `type[ga` in sample.cwt offers type[gadget]
        // defined in defs.cwt. Wait until the index has been rebuilt.
        const sampleDoc = await vscode.workspace.openTextDocument(sampleUri);
        let sawGadget = false;
        const completionDeadline = Date.now() + 60_000;
        while (!sawGadget && Date.now() < completionDeadline) {
            const items = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                sampleUri,
                new vscode.Position(21, 6),
            );
            sawGadget = (items?.items.map(item => item.label) ?? []).some(label => label === 'gadget');
            if (!sawGadget) await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(sawGadget, 'cross-file completion did not offer type[gadget] from defs.cwt');

        const errorDoc = await vscode.workspace.openTextDocument(semanticErrorUri());
        await vscode.window.showTextDocument(errorDoc);
        const gadgetLine = errorDoc.getText().split('\n').findIndex(line => line.includes('working = <gadget>'));
        assert.ok(gadgetLine >= 0, 'semantic-error.cwt should reference <gadget>');

        // Reference completion uses the concrete declaration, not the
        // meta-schema placeholder `<type>`.
        const gadgetLineText = errorDoc.lineAt(gadgetLine).text;
        const partialTypeEnd = gadgetLineText.indexOf('<gadget>') + '<ga'.length;
        const typeReferenceItems = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            errorDoc.uri,
            new vscode.Position(gadgetLine, partialTypeEnd),
        );
        const typeReferenceLabels = typeReferenceItems?.items.map(item => item.label) ?? [];
        assert.ok(
            typeReferenceLabels.some(label => label === '<gadget>'),
            `expected concrete <gadget> reference completion, got ${JSON.stringify(typeReferenceLabels.slice(0, 10))}`,
        );

        // Definition navigation: `<gadget>` in semantic-error.cwt jumps to
        // the type[gadget] declaration in defs.cwt.
        const navigationDeadline = Date.now() + 60_000;
        let locations: vscode.Location[] | undefined;
        while (Date.now() < navigationDeadline) {
            locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                errorDoc.uri,
                new vscode.Position(gadgetLine, 14),
            );
            if (locations && locations.length >= 1) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(locations && locations.length >= 1, 'definition navigation returned no locations');
        const defsPath = defsUri.fsPath.replace(/\\/g, '/').toLowerCase();
        assert.ok(
            locations!.some(location => location.uri.fsPath.replace(/\\/g, '/').toLowerCase() === defsPath),
            `definition did not jump to defs.cwt: ${locations?.map(l => l.uri.fsPath).join(', ')}`,
        );
    });

    test('publishes CWT301 undefined-reference diagnostics from the project index', async function () {
        const uri = semanticErrorUri();
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        // The index must be ready; poll for CWT301 (index rebuild is
        // debounced and asynchronous).
        const diagnosticDeadline = Date.now() + 60_000;
        let codes: string[] = [];
        while (Date.now() < diagnosticDeadline) {
            codes = (await diagnosticsFor(uri)).map(d => diagnosticCodeValue(d.code));
            if (codes.some(code => code === 'CWT301')) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(
            codes.some(code => code === 'CWT301'),
            `expected CWT301 undefined-reference diagnostic, got ${JSON.stringify(codes)}`,
        );
    });
});

function semanticErrorUri(): vscode.Uri {
    return workspaceFile('config/semantic-error.cwt');
}
