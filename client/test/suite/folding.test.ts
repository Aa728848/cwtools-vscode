import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../utils';

const sampleRoot = path.resolve(__dirname, '../sample');
const testEventFile = path.join(sampleRoot, 'events', 'irm.txt');

async function waitForEventFold(uri: vscode.Uri): Promise<vscode.FoldingRange[]> {
    for (let attempt = 0; attempt < 40; attempt++) {
        const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
            'vscode.executeFoldingRangeProvider',
            uri,
        );
        if (ranges?.some(range => range.start === 7 && range.end >= 25)) {
            return ranges;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return [];
}

suite('LSP Folding Range Tests', function () {
    this.timeout(30000);

    setup(async function () {
        await activate();
    });

    teardown(async function () {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('should expose folding arrows for ordinary PDX script blocks', async function () {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(testEventFile));
        await vscode.window.showTextDocument(document);

        const ranges = await waitForEventFold(document.uri);
        const outerEvent = ranges.find(range => range.start === 7 && range.end >= 25);

        assert.ok(outerEvent, `Expected country_event fold at line 8, got ${JSON.stringify(ranges)}`);
        assert.ok(
            ranges.some(range => range.start === 11 && range.end >= 16),
            'Expected nested trigger block to remain foldable',
        );
    });
});
