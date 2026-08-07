import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('entity preview locator drafts', () => {
    const root = path.resolve(__dirname, '../../..');
    const host = fs.readFileSync(path.join(root, 'client/extension/entityPanel.ts'), 'utf8');
    const webview = fs.readFileSync(path.join(root, 'client/webview/entityPreview.ts'), 'utf8');

    function methodSource(name: string): string {
        const start = host.indexOf(`private async ${name}`);
        expect(start, `${name} should exist`).to.be.greaterThan(-1);
        const next = host.indexOf('\n    private ', start + 1);
        return host.slice(start, next < 0 ? host.length : next);
    }

    it('keeps every locator mutation off disk until explicit save', () => {
        for (const handler of [
            '_handleUpdateLocator',
            '_handleAddLocator',
            '_handleDuplicateLocators',
            '_handleDeleteLocators',
            '_handleUpdateAttach',
            '_handleUndoRedo',
        ]) {
            expect(methodSource(handler), handler).not.to.include('.save()');
        }

        expect(methodSource('_handleSaveDocument')).to.include('document.save()');
        expect(host).to.include("case 'saveDocument'");
        expect(host).to.include('private _messageQueue: Promise<void> = Promise.resolve()');
    });

    it('defaults to preview mode and only drafts gizmo changes in edit mode', () => {
        expect(host).to.include('id="btn-preview" class="active"');
        expect(host).to.include('id="btn-edit"');
        expect(host).to.include('id="btn-save"');
        expect(webview).to.include("setWorkspaceMode('preview');");
        expect(webview).to.include('if (!isDragging && editMode && selectedLocator)');
        expect(webview).to.include('updateLocatorDraft();');
        expect(webview).not.to.include('autoSaveLocator');
        expect(webview).to.include("vscode.postMessage({ command: 'saveDocument' });");
    });

    it('keeps model locators and bones transform-read-only on both boundaries', () => {
        expect(webview).to.include("obj.userData?.source === 'script'");
        expect(webview).to.include("mesh: 'Model locator · read-only transform'");
        expect(webview).to.include("bone: 'Bone · read-only transform'");
        expect(host).to.include('const locator = parsedEntity?.locators.find');
        expect(host).to.include('Rejected transform for non-script locator');
        expect(host).to.include('Rejected transform for model locator or bone');
        expect(host).not.to.include('Inserted locator override for mesh locator');
    });
});
