import * as assert from 'assert';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';
import { activate, wait } from '../utils';

interface OverlayFileResult {
    ok: boolean;
    uri: string;
    validationLevel?: string;
    contentHash?: string;
    status?: string;
    diagnostics?: Array<{ code?: string; severity?: string; message?: string }>;
}

interface OverlayResponse {
    ok: boolean;
    validationLevel?: string;
    files: OverlayFileResult[];
}

suite('Detached candidate overlay E2E', function () {
    this.timeout(3 * 60 * 1000);

    async function validate(files: Array<{ uri: string; content: string; baseHash?: string }>): Promise<OverlayResponse> {
        await activate();
        let response: OverlayResponse | undefined;
        for (let attempt = 0; attempt < 60; attempt++) {
            try {
                response = await vscode.commands.executeCommand<OverlayResponse>('cwtools.ai.validateOverlay', { files });
                if (response && Array.isArray(response.files)) return response;
            } catch { /* language server can still be loading */ }
            await wait(500);
        }
        assert.fail('validateOverlay did not become available');
    }

    test('reports real parser errors and never materializes candidate text', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Fixture workspace is required');
        const uri = vscode.Uri.joinPath(folder.uri, 'events', 'overlay_candidate_invalid.txt');
        const content = 'country_event = { id = overlay_test.invalid\n';
        const response = await validate([{ uri: uri.toString(), content }]);
        assert.strictEqual(response.ok, true, 'accepted requests report diagnostics per file');
        assert.strictEqual(response.files.length, 1);
        assert.strictEqual(response.files[0]!.validationLevel, 'parser');
        assert.ok(response.files[0]!.diagnostics?.some(item => item.code === 'CW001' && item.severity === 'error'), 'real parser diagnostic required');
        assert.strictEqual(response.files[0]!.contentHash, createHash('sha256').update(content, 'utf8').digest('hex'));
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri)), (error: unknown) => error instanceof vscode.FileSystemError, 'detached validation must not create the candidate file');
    });

    test('resolves scripted definitions across candidate files without touching the live catalog', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Fixture workspace is required');
        const effectUri = vscode.Uri.joinPath(folder.uri, 'common', 'scripted_effects', 'overlay_batch.txt');
        const eventUri = vscode.Uri.joinPath(folder.uri, 'events', 'overlay_batch.txt');
        const effect = 'e2e_overlay_effect = { set_country_flag = e2e_overlay_flag }\n';
        const event = 'namespace = e2e_overlay\ncountry_event = { id = e2e_overlay.1 is_triggered_only = yes immediate = { e2e_overlay_effect = yes } }\n';
        const response = await validate([{ uri: effectUri.toString(), content: effect }, { uri: eventUri.toString(), content: event }]);
        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.validationLevel, 'catalog-overlay-batch');
        assert.ok(response.files.every(file => file.ok && file.validationLevel === 'catalog-overlay-batch'));
        assert.ok(!response.files.flatMap(file => file.diagnostics ?? []).some(diagnostic => diagnostic.severity === 'error' && diagnostic.message?.includes('e2e_overlay_effect')));
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(effectUri)));
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(eventUri)));
    });

    test('checks base hashes against disk and leaves the file unchanged', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Fixture workspace is required');
        const uri = vscode.Uri.joinPath(folder.uri, 'events', 'irm.txt');
        const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const staleHash = '0'.repeat(64);
        const response = await validate([{ uri: uri.toString(), content: before + '\n# overlay only', baseHash: staleHash }]);
        assert.strictEqual(response.ok, false);
        assert.strictEqual(response.files[0]!.ok, false);
        assert.strictEqual(response.files[0]!.status, 'base_hash_mismatch');
        const after = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        assert.strictEqual(after, before, 'base-hash rejection must not write candidate content');
    });

    test('accepts matching base hash without persisting candidate content', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'Fixture workspace is required');
        const uri = vscode.Uri.joinPath(folder.uri, 'events', 'irm.txt');
        const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const baseHash = createHash('sha256').update(before, 'utf8').digest('hex');
        const candidate = before + '\n# detached overlay acceptance';
        const response = await validate([{ uri: uri.toString(), content: candidate, baseHash }]);
        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.files[0]!.ok, true);
        assert.strictEqual(response.files[0]!.contentHash, createHash('sha256').update(candidate, 'utf8').digest('hex'));
        const after = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        assert.strictEqual(after, before, 'successful detached validation must not write candidate content');
    });
});
