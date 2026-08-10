import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('entity preview locator drafts', () => {
    const root = path.resolve(__dirname, '../../..');
    const host = fs.readFileSync(path.join(root, 'client/extension/entityPanel.ts'), 'utf8');
    const extension = fs.readFileSync(path.join(root, 'client/extension/extension.ts'), 'utf8');
    const webview = fs.readFileSync(path.join(root, 'client/webview/entityPreview.ts'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'client/webview/entityPreview.css'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/package.json'), 'utf8')) as {
        contributes?: { keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }> };
    };

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
        expect(methodSource('_handleUpdateLocators').match(/_applyDraftEdit/g)).to.have.length(1);
        expect(webview).to.include('captureMultiTransformSnapshot();');
        expect(webview).to.include("vscode.postMessage({ command: 'updateLocators', locators });");
        expect(webview).to.include('applySelfRotationDeltaToLocalTransform');
        expect(webview).to.include("transformCtrl.setSpace(transformSpaceSelect.value === 'local' ? 'local' : 'world')");
        expect(host).to.include('id="sel-multi-rotation-mode"');
        expect(host).to.include('<option value="individual" selected>');
        expect(host).to.include('<option value="center">');
        expect(host).to.include('id="move-snap-step"');
        expect(host).to.include('id="rotation-snap-step"');
        expect(host).to.include('不会建立动态绑定');
    });

    it('writes a newly created locator and its attach in the same draft edit', () => {
        const addLocator = methodSource('_handleAddLocator');
        expect(addLocator).to.include('locator = { name = "${msg.locatorName}"');
        expect(addLocator).to.include('attach = { "${msg.locatorName}" = "${msg.attachEntity}" }');
        expect(addLocator.match(/_applyDraftEdit/g)).to.have.length(1);
        expect(addLocator).to.include('this._currentModelAnchorNames.has(msg.locatorName.toLowerCase())');
        expect(addLocator).not.to.include('.includes(Buffer.from');
    });

    it('routes undo and redo through focused edit-mode keybindings', () => {
        expect(extension).to.include('safeRegisterCommand(context, "cwtools.entityPreview.undo"');
        expect(extension).to.include('safeRegisterCommand(context, "cwtools.entityPreview.redo"');
        expect(host).to.include("'cwtools.entityPreview.editing'");
        expect(host).to.include("case 'setEditMode'");
        expect(webview).to.include("vscode.postMessage({ command: 'setEditMode', editMode });");

        const keybindings = manifest.contributes?.keybindings ?? [];
        expect(keybindings).to.deep.include({
            command: 'cwtools.entityPreview.undo',
            key: 'ctrl+z',
            mac: 'cmd+z',
            when: 'cwtools.entityPreview.editing',
        });
        expect(keybindings).to.deep.include({
            command: 'cwtools.entityPreview.redo',
            key: 'ctrl+shift+z',
            mac: 'cmd+shift+z',
            when: 'cwtools.entityPreview.editing',
        });
        expect(webview).not.to.include("vscode.postMessage({ command: e.shiftKey ? 'redo' : 'undo' });");
    });

    it('uses the same compact panel layout for properties and special duplicate', () => {
        expect(host).to.include('<div id="special-duplicate-panel" class="hidden">');
        expect(host).to.include('<div class="props-row"><label>Position <span class="axis-x">X</span>');
        expect(host).to.include('<div class="props-row"><label>Rotation <span class="axis-z">Z</span>');
        expect(host).to.include('<div class="props-actions duplicate-actions">');
        expect(css).to.include('#special-duplicate-panel {\n    width: min(240px, calc(100% - 24px));');
        expect(css).to.include('grid-template-columns: repeat(2, minmax(0, 1fr));');
        expect(css).not.to.include('.duplicate-vector-row');
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

    it('documents the non-default view controls inside the preview', () => {
        expect(host).to.include('id="view-controls-help"');
        expect(host).to.include('<kbd>Alt</kbd> +');
        expect(host).to.include("'左键拖动' : 'left drag'");
        expect(host).to.include("'中键拖动' : 'Middle drag'");
        expect(host).to.include("'滚轮' : 'Mouse wheel'");
        expect(css).to.include('#view-controls-help');
    });

    it('preserves the selected entity by name when a saved asset reloads', () => {
        expect(host).to.include(
            'await this._loadAndRender(savedDoc, this._currentEntityIndex, this._currentEntityName);',
        );
        expect(host).to.include('resolveEntitySelectionIndex(');
    });

    it('keeps model locators and bones transform-read-only on both boundaries', () => {
        expect(webview).to.include("obj.userData?.source === 'script'");
        expect(webview).to.include("mesh: 'Model locator · read-only transform'");
        expect(webview).to.include("bone: 'Bone · read-only transform'");
        expect(host).to.include('const locator = parsedEntity?.locators.find');
        expect(host).to.include('Rejected transform for non-script locator');
        expect(host).to.include('Rejected transform for model locator or bone');
        expect(host).to.include('normalizedPdxMeshAnchorNames');
        expect(host).not.to.match(/\.includes\(Buffer\.from\([^)]*(?:locator|anchor|name)/);
        expect(host).not.to.include('Inserted locator override for mesh locator');
    });

    it('keeps attach editing independent from read-only transforms', () => {
        expect(webview).to.include('const canEditAttach = editMode;');
        expect(webview).to.include('propAttachEntity.disabled = !canEditAttach;');
        expect(webview).to.include('setAttachButton.disabled = !canEditAttach;');
        expect(webview).not.to.include('propAttachEntity.disabled = !selectedLocatorEditable');
        expect(host).to.include('模型 Locator/Bone 的变换只读；切换到编辑模式后仍可设置 Attach');
    });

    it('restricts viewport picking to editable locators and keeps local gizmos aligned', () => {
        expect(webview).to.include('Viewport picking is intentionally limited to editable .asset locators');
        expect(webview).to.include('isLocatorObjectEditable(obj.parent)');
        expect(webview).not.to.include('currentModel?.traverse(collectHitTarget)');
        expect(webview).not.to.include('obj instanceof THREE.Bone && bonesToggle.checked');
        expect(webview).to.include("transformCtrl.setSpace('local')");
        expect(host).to.include('<option value="local" selected>');
        expect(css).to.include('grid-template-columns: repeat(3, minmax(0, 1fr))');
    });
});
