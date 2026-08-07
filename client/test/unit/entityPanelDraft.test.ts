import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('entity preview locator drafts', () => {
    const root = path.resolve(__dirname, '../../..');
    const host = fs.readFileSync(path.join(root, 'client/extension/entityPanel.ts'), 'utf8');
    const webview = fs.readFileSync(path.join(root, 'client/webview/entityPreview.ts'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'client/webview/entityPreview.css'), 'utf8');

    function methodSource(name: string): string {
        const start = host.indexOf(`private async ${name}`);
        expect(start, `${name} should exist`).to.be.greaterThan(-1);
        const next = host.indexOf('\n    private ', start + 1);
        return host.slice(start, next < 0 ? host.length : next);
    }

    it('keeps every locator mutation off disk until explicit save', () => {
        for (const handler of [
            '_handleUpdateLocator',
            '_handleUpdateLocators',
            '_handleRenameLocator',
            '_handleAddLocator',
            '_handleDuplicateLocators',
            '_handleDeleteLocators',
            '_handleUpdateAttach',
            '_handleUndoRedo',
        ]) {
            expect(methodSource(handler), handler).not.to.include('.save()');
        }

        expect(methodSource('_handleSaveDocument')).to.include('document.save()');
        expect(methodSource('_handleSaveDocument')).to.include('vscode.workspace.applyEdit(edit)');
        expect(methodSource('_applyDraftEdit')).not.to.include('vscode.workspace.applyEdit');
        expect(methodSource('_applyDraftEdit')).to.include('applyDraftTextEdits');
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

    it('supports one-operation multi transforms and locator-only editing tools', () => {
        expect(host).to.include("case 'updateLocators'");
        expect(host).to.include("case 'renameLocator'");
        expect(methodSource('_handleUpdateLocators')).to.include('const edit = new vscode.WorkspaceEdit()');
        expect(webview).to.include('captureMultiTransformSnapshot();');
        expect(webview).to.include("vscode.postMessage({ command: 'updateLocators', locators });");
        expect(webview).to.include("transformCtrl.setSpace(transformSpaceSelect.value === 'local' ? 'local' : 'world')");
        expect(host).to.include('id="move-snap-step"');
        expect(host).to.include('id="rotation-snap-step"');
        expect(host).to.include('不会建立动态绑定');
    });

    it('tracks cross-file drafts, confirms save, and protects navigation', () => {
        expect(host).to.include('interface EntityDraftDocument');
        expect(host).to.include('private async _applyDraftEdit');
        expect(host).to.include('private async _confirmDraftNavigation');
        expect(host).to.include('private async _handleDiscardDrafts');
        expect(webview).to.include('External conflict');
        expect(host).to.include("case 'discardDrafts'");
        expect(host).to.include('id="draft-summary"');
        expect(host).to.include('id="btn-discard-drafts"');
        expect(webview).to.include('renderDraftSummary');
    });

    it('provides attach management and explicit semantic diagnostics', () => {
        expect(host).to.include("case 'openEntityDefinition'");
        expect(host).to.include('private async _postAttachDiagnostics');
        expect(host).to.include('Circular attach blocked');
        expect(host).to.include('Attached entity definition is missing');
        expect(host).to.include('Attach anchor is missing');
        expect(host).to.include('id="btn-set-attach"');
        expect(host).to.include('id="btn-clear-attach"');
        expect(host).to.include('id="btn-open-attach-entity"');
        expect(webview).to.include('data-attach-object-uuid');
    });

    it('keeps world-axis orientation visible without a model', () => {
        expect(host).to.include('id="orientation-gizmo"');
        expect(host).to.include('World axis orientation');
        expect(webview).to.include('new THREE.AxesHelper(1.5)');
        expect(webview).to.include('function updateOrientationGizmo()');
        expect(webview).to.include('updateOrientationGizmo();');
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

    it('directly selects read-only anchors and keeps local gizmos aligned', () => {
        expect(webview).to.include('currentModel?.traverse(collectHitTarget)');
        expect(webview).to.include('obj instanceof THREE.Bone && bonesToggle.checked');
        expect(webview).to.include("transformCtrl.setSpace('local')");
        expect(host).to.include('<option value="local" selected>');
        expect(css).to.include('grid-template-columns: repeat(3, minmax(0, 1fr))');
    });
});
