import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { activate } from '../utils';
import { setupLSPErrorMonitoring, checkForLSPErrors, teardownLSPErrorMonitoring } from '../lspErrorMonitor';
import { expect } from 'chai';

const sampleRoot = path.resolve(__dirname, '../sample');
const testEventFile = path.join(sampleRoot, 'events', 'irm.txt');
const testNicheFile = path.join(sampleRoot, 'common', 'scripted_triggers', 'irm_scripted_triggers.txt');
const testScriptedEffectFile = path.join(sampleRoot, 'common', 'scripted_effects', 'irm_scripted_effects.txt');
const testScriptedTriggerFile = path.join(sampleRoot, 'common', 'scripted_triggers', 'irm_scripted_triggers.txt');

async function waitForLSP(uri: vscode.Uri, maxRetries = 240, delayMs = 500): Promise<void> {
    let diagnosticsReady = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Check if diagnostics are available (indicates LSP is processing files)
            const diagnostics = vscode.languages.getDiagnostics(uri);
            if (diagnostics && diagnostics.length >= 0) {
                diagnosticsReady = true;
            }

            // Try to get meaningful completions (not just any response)
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                uri,
                new vscode.Position(12, 0) // Position where we expect trigger completions
            );

            // Check if we have actual LSP completions (not just fallback).
            // A single non-Text item is not enough: while the game model is still
            // being built (Stellaris loads a large vanilla cache) the LSP returns
            // fallback items that mix in with a few real ones. Require every item
            // to be kind-typed, which only happens once the model is fully built.
            if (completions?.items?.length) {
                const textTypeCount = completions.items.filter(item => (item.kind || 0) === 0).length;

                if (textTypeCount === 0) {
                    console.log(`LSP ready after ${attempt} attempts (${attempt * delayMs}ms) - found ${completions.items.length} completions`);
                    return;
                }
            }

            // If we have diagnostics but no good completions yet, LSP is still starting up
            if (diagnosticsReady) {
                console.log(`LSP starting (attempt ${attempt}) - diagnostics available but completions not ready`);
            }

        } catch (error) {
            // LSP might not be ready yet, continue retrying
            console.log(`LSP check attempt ${attempt} failed:`, error instanceof Error ? error.message : String(error));
        }

        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    throw new Error(`LSP not ready after ${maxRetries} attempts (${maxRetries * delayMs}ms total)`);
}

async function getCompletions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CompletionList> {
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position
    );

    assert.ok(completions?.items?.length, 'No completions received');

    // Check that LSP is being used (not VS Code text completion fallback)
    const textTypeCount = completions.items.filter(item => (item.kind || 0) === 0).length;
    assert.ok(textTypeCount == 0,
        `Too many Text type completions (${textTypeCount}/${completions.items.length}) - LSP may not be working`);

    return completions;
}

async function within<T>(promise: Thenable<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not respond within ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

suite('LSP Completion Tests', function () {
    this.timeout(120000);

    async function openAndGetTestDocument() {
        const uri = vscode.Uri.file(testEventFile);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        return document;
    }
    async function openAndGetNicheDocument() {
        const uriNiche = vscode.Uri.file(testNicheFile);
        const document = await vscode.workspace.openTextDocument(uriNiche);
        await vscode.window.showTextDocument(document);
        return document;
    }
    setup(async function () {
        setupLSPErrorMonitoring();
        await activate();

        const extension = vscode.extensions.getExtension('ForeverSkywalker.foreverskywalker-stellaris-cwtools')!;
        assert.ok(extension?.isActive, 'Extension should be active');

        const document = await openAndGetTestDocument();
        await waitForLSP(document.uri);
    });

    teardown(async function () {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        checkForLSPErrors(this.currentTest?.title || 'unknown test');
    });

    suiteTeardown(async function () {
        teardownLSPErrorMonitoring();
    });
    test('should provide completions in niche context', async function () {
        const document = await openAndGetNicheDocument();
        // Line 287 (0-based 286) of irm_scripted_triggers.txt:
        //   event_target:scp_faction_leader = { pop_faction = { has_pop_faction_flag = "sector_policy_leadership" } }
        // Cursor inside the flag quotes with an "s" prefix.
        const completions = await getCompletions(document.uri, new vscode.Position(286, 76));

        const labels = completions.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        );
        expect(labels).to.include("sector_policy_leadership");
    });

    test('should provide completions in trigger context', async function () {
        const document = await openAndGetTestDocument();
        const completions = await getCompletions(document.uri, new vscode.Position(12, 0));

        const labels = completions.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        );

        // Check for common trigger keywords
        const hasRelevantTriggers = labels.some(label =>
            label.includes('is_ai') || label.includes('limit') || label.includes('country_type')
        );

        assert.ok(hasRelevantTriggers);
        assert.ok(completions.items.length > 0, 'Should have completion items');
        // Note: Don't assert specific content as it depends on LSP implementation
    });

    test('should provide completions in effect context', async function () {
        const document = await openAndGetTestDocument();
        const completions = await getCompletions(document.uri, new vscode.Position(17, 8));

        const labels = completions.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        );

        assert.ok(labels.length > 0);
        assert.ok(completions.items.length > 0, 'Should have completion items in effect context');
    });

    test('should respond to completion requests quickly', async function () {
        const document = await openAndGetTestDocument();
        const start = Date.now();
        const completions = await getCompletions(document.uri, new vscode.Position(12, 0));
        const duration = Date.now() - start;

        assert.ok(duration < 5000, `Completion should be fast, took ${duration}ms`);
        assert.ok(completions.items.length > 0, 'Should have completion items');
    });

    test('should keep editor language features responsive immediately after save', async function () {
        const document = await openAndGetNicheDocument();
        const position = new vscode.Position(26, 41);
        const originalText = document.getText();

        // Seed the completion fallback with a real result before save-time
        // validation briefly replaces the live resource.
        await getCompletions(document.uri, position);

        const appendProbe = new vscode.WorkspaceEdit();
        appendProbe.insert(document.uri, document.positionAt(originalText.length), '\n# responsiveness probe');

        try {
            assert.ok(await vscode.workspace.applyEdit(appendProbe), 'Failed to apply save responsiveness probe');
            assert.ok(await document.save(), 'Failed to save responsiveness probe');

            const startedAt = Date.now();
            const [completions, hovers, definitions] = await Promise.all([
                within(
                    vscode.commands.executeCommand<vscode.CompletionList>(
                        'vscode.executeCompletionItemProvider',
                        document.uri,
                        position,
                    ),
                    2000,
                    'Completion after save',
                ),
                within(
                    vscode.commands.executeCommand<vscode.Hover[]>(
                        'vscode.executeHoverProvider',
                        document.uri,
                        position,
                    ),
                    2000,
                    'Hover after save',
                ),
                within(
                    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
                        'vscode.executeDefinitionProvider',
                        document.uri,
                        position,
                    ),
                    2000,
                    'Definition after save',
                ),
            ]);

            assert.ok(Date.now() - startedAt < 2000, 'Save-time validation blocked editor language features');
            assert.ok(completions?.items?.length, 'Completion after save should remain usable');
            assert.ok(Array.isArray(hovers), 'Hover after save should return a bounded response');
            assert.ok(Array.isArray(definitions), 'Definition after save should return a bounded response');
        } finally {
            const restore = new vscode.WorkspaceEdit();
            restore.replace(
                document.uri,
                new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
                originalText,
            );
            await vscode.workspace.applyEdit(restore);
            await document.save();
        }
    });

    test('should provide first-open and switched-line completions in scripted definition files', async function () {
        const cases = [
            { file: testScriptedEffectFile, needles: ['random_owned_pop_group = {', 'create_leader = {'] },
            { file: testScriptedTriggerFile, needles: ['has_trait =', 'has_modifier ='] },
        ];

        for (const testCase of cases) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(testCase.file));
            await vscode.window.showTextDocument(document);

            for (const needle of testCase.needles) {
                const line = Array.from({ length: document.lineCount }, (_, index) => index)
                    .find(index => document.lineAt(index).text.includes(needle));
                assert.ok(line !== undefined, `Missing completion test anchor '${needle}' in ${testCase.file}`);
                if (line === undefined) throw new Error(`Missing completion test anchor '${needle}'`);
                const lineText = document.lineAt(line).text;
                const character = lineText.length - lineText.trimStart().length;
                const startedAt = Date.now();
                const completions = await getCompletions(document.uri, new vscode.Position(line, character));
                const elapsed = Date.now() - startedAt;

                assert.ok(elapsed < 5000, `${path.basename(testCase.file)} completion at '${needle}' took ${elapsed}ms`);
                assert.ok(completions.items.length > 0, `Expected completions at '${needle}' in ${testCase.file}`);
            }
        }
    });

    test('should provide LSP-based completions not just text fallback', async function () {
        const document = await openAndGetTestDocument();
        const completions = await getCompletions(document.uri, new vscode.Position(12, 0));

        // The getCompletions helper already validates no Text type completions
        // This test confirms completions have LSP-specific characteristics
        const hasLSPFeatures = completions.items.some(item =>
            item.detail || item.documentation || item.sortText ||
            (item.commitCharacters && item.commitCharacters.length > 0)
        );

        assert.ok(hasLSPFeatures, 'Completions should have LSP-specific features like detail, documentation, or sortText');
    });

});
