import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// Override fs.readFileSync via CommonJS to support Windows CRLF normalization
const rawFs = require('fs');
const originalRead = rawFs.readFileSync;
rawFs.readFileSync = function(p: any, opts: any) {
    const res = originalRead(p, opts);
    return typeof res === 'string' ? res.replace(/\r\n/g, '\n') : res;
};

describe('webview smoke checks', () => {
    const root = path.resolve(__dirname, '../../..');

    it('release manifest no longer exposes retired provider or completion commands', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/package.json'), 'utf8'));
        const commands: Array<{ command?: string }> = manifest.contributes?.commands ?? [];
        const sections = (Array.isArray(manifest.contributes?.configuration)
            ? manifest.contributes.configuration
            : [manifest.contributes?.configuration]) as Array<{ properties?: Record<string, { enum?: string[] }> }>;
        const properties = Object.assign({}, ...sections.map(section => section?.properties ?? {}));
        const providerEnum = properties['stellarisLanguageServices.ai.provider']?.enum ?? [];
        const inlineEnum = properties['stellarisLanguageServices.ai.inlineCompletion.provider']?.enum ?? [];
        expect(commands.map(item => item.command)).not.to.include('cwtools.ai.antigravityTabJump');
        expect(providerEnum).not.to.include('antigravity');
        expect(inlineEnum).not.to.include('antigravity');
        for (const locale of ['package.nls.json', 'package.nls.zh.json', 'package.nls.zh-cn.json']) {
            const nls = JSON.parse(fs.readFileSync(path.join(root, 'release', locale), 'utf8'));
            expect(nls).not.to.have.property('commands.stellarisLanguageServices.ai.antigravityTabJump.title');
            expect(nls).not.to.have.property('configuration.stellarisLanguageServices.ai.provider.enum.antigravity');
        }
    });

    it('gui preview runtime CSS is bundled with its webview script', () => {
        const host = fs.readFileSync(path.join(root, 'client/extension/guiPanel.ts'), 'utf8');
        const rollup = fs.readFileSync(path.join(root, 'rollup.config.mjs'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/guiPreview.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/guiPreview.css'), 'utf8');

        expect(host).to.include("path.join(this._webviewRootPath, 'guiPreview.css')");
        expect(rollup).to.include("copyFile('client/webview/guiPreview.css', 'release/bin/client/webview/guiPreview.css')");
        expect(css).to.include('#toolbar');
        expect(css).to.include('#main-layout');
        expect(css).to.include('#search-bar.hidden { display: none; }');
        expect(css).to.include('body.search-open #main-layout');
        expect(script).to.include("document.body.classList.toggle('search-open', isOpen);");
        for (const control of [
            'id="btn-inspect"',
            'id="btn-fit-screen"',
            'id="btn-fit-selection"',
            'id="btn-actual-size"',
            'id="btn-save"',
            'id="inspector-resizer"',
            'id="layer-filter"',
        ]) {
            expect(host).to.include(control);
        }
        expect(script).to.include('function setWorkspaceMode(');
        expect(script).to.include('function measureViewBounds(');
        expect(script).to.include('function applyLayerFilters(');
        expect(script).to.include('function requestDocumentSave(');
        expect(script).to.include("vscode.postMessage({ command: 'saveDocument' });");
        expect(host).to.include("case 'saveDocument':");
        expect(host.match(/await doc\.save\(\);/g)).to.have.length(1);
        expect(host).to.include('id="btn-hide-off-canvas"');
        expect(host).to.include('Move off canvas');
        expect(script).to.include('function hideSelectedOffCanvas()');
        expect(script).to.include('const SAFE_HIDDEN_POSITION = -9_999;');
        expect(script).to.include("status.textContent = tr('Off-canvas', '画布外');");
        expect(script).to.not.include("command: 'deleteElement'");
        expect(css).to.include('var(--vscode-editor-background)');
        expect(css).to.include('.layer-item.off-canvas-control');
        expect(css).to.include('#side-panel #layers-panel,');
        expect(css).to.include('body.overlay-focus');
        expect(css).to.include('@media (prefers-reduced-motion: reduce)');
    });

    it('static galaxy editor HTML exposes preview/edit mode switch and document actions', () => {
        const provider = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditorProvider.ts'), 'utf8');

        expect(provider).to.include('id="btn-preview"');
        expect(provider).to.include('id="btn-edit"');
        // Preview mode is active by default with correct aria state.
        expect(provider).to.include('<button id="btn-preview" class="active" type="button" aria-pressed="true">');
        expect(provider).to.include('<button id="btn-edit" type="button" aria-pressed="false"');
        // Mode switch exposes an accessible group.
        expect(provider).to.include('id="mode-switch" class="segmented-control" role="group"');
        // Edit-only document actions exist and are gated by the edit-only class.
        expect(provider).to.include('id="btn-undo" class="icon-button edit-only"');
        expect(provider).to.include('id="btn-redo" class="icon-button edit-only"');
        expect(provider).to.include('id="btn-save" class="button-secondary edit-only"');
        expect(provider).to.include('id="edit-status" class="status-pill"');
        // Canvas, inspector, status, fit and layer controls exist.
        expect(provider).to.include('id="galaxy-canvas"');
        expect(provider).to.include('id="side-panel"');
        expect(provider).to.include('id="btn-fit"');
        expect(provider).to.include('id="btn-labels"');
        expect(provider).to.include('id="btn-ranges"');
        expect(provider).to.include('id="btn-nebulas"');
        expect(provider).to.include('id="btn-lanes"');
        expect(provider).to.include('id="scenario-select"');
        expect(provider).to.include('id="scenario-picker"');
        expect(provider).to.include('id="workshop-banner"');
        expect(provider).to.include('id="empty-state"');
        expect(provider).to.include('id="diagnostics-panel"');
        // Host messages are serialized so two edits cannot share stale spans.
        expect(provider).to.include('private _messageQueue: Promise<void> = Promise.resolve()');
        expect(provider).to.include('.then(() => this._handleMessage(message))');
        expect(provider).to.include('private _parseAllowsEdit = false');
        expect(provider).to.include('&& this._parseAllowsEdit');
        // Workshop copies use the live TextDocument, not stale disk bytes.
        expect(provider).to.include("Buffer.from(this._document.getText(), 'utf8')");
        expect(provider).to.not.include('fs.promises.copyFile');
    });

    it('static galaxy webview stays sandboxed and cleans up rendering', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.ts'), 'utf8');

        expect(script).to.not.include("from 'vscode'");
        expect(script).to.not.include("from 'fs'");
        expect(script).to.not.include("from 'path'");
        expect(script).to.not.include('require(');
        expect(script).to.not.include('child_process');
        // Rendering is on-demand: coalesced RAF, cancelled while hidden.
        expect(script).to.include('scheduleRender');
        expect(script).to.include("document.addEventListener('visibilitychange'");
        // DPR is capped at 2.
        expect(script).to.include('Math.min(2, window.devicePixelRatio || 1)');
        // Axis orientation lives in the unified inverse transforms.
        expect(script).to.include('function worldToScreen');
        expect(script).to.include('function screenToWorld');
        // Stellaris' X axis grows to the left; the flip lives in the same transforms.
        expect(script).to.include('state.viewport.cx - wx');
        // Stellaris' Y axis follows the screen, and panning uses the matching inverse sign.
        expect(script).to.include('y: (wy - state.viewport.cy) * state.viewport.scale');
        expect(script).to.include('y: state.viewport.cy + (sy - canvasHeight / 2) / state.viewport.scale');
        expect(script).to.include('state.viewport.cy -= dy / state.viewport.scale');
        // Both node kinds can be moved, Z is editable, and lane actions use semantic requests.
        expect(script).to.include("type: 'moveNebula'");
        expect(script).to.include("readAxisUpdate('z'");
        expect(script).to.include("type: 'setHyperlane'");
        expect(script).to.include("id = 'btn-add-hyperlane'");
        expect(script).to.include("id = 'btn-remove-hyperlane'");
    });

    it('static galaxy css uses theme variables and honors reduced motion', () => {
        const css = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.css'), 'utf8');

        expect(css).to.include('var(--vscode-editor-background)');
        expect(css).to.include('var(--vscode-focusBorder)');
        expect(css).to.include('prefers-reduced-motion');
        // Edit-only controls are hidden outside edit mode.
        expect(css).to.include('body:not(.is-edit-mode) .edit-only');
        // The scenario picker collapses for single-scenario files.
        expect(css).to.include('body.single-scenario #app-header');
        // Status pill states from the plan.
        expect(css).to.include('.status-pill[data-state="modified"]');
        expect(css).to.include('.status-pill[data-state="applying"]');
        expect(css).to.include('.status-pill[data-state="readonly"]');
        expect(css).to.include('.status-pill[data-state="stale"]');
        expect(css).to.include('.status-pill[data-state="error"]');
    });

    it('static galaxy bundle and css are wired into the rollup build', () => {
        const rollup = fs.readFileSync(path.join(root, 'rollup.config.mjs'), 'utf8');
        expect(rollup).to.include("./client/webview/staticGalaxyPreview.ts");
        expect(rollup).to.include('staticGalaxyPreview.js');
        expect(rollup).to.include("copyFile('client/webview/staticGalaxyPreview.css'");

        const bundle = path.join(root, 'release/bin/client/webview/staticGalaxyPreview.js');
        const cssOut = path.join(root, 'release/bin/client/webview/staticGalaxyPreview.css');
        expect(fs.statSync(bundle).size).to.be.greaterThan(1000);
        expect(fs.statSync(cssOut).size).to.be.greaterThan(500);
    });

    it('scopes the static galaxy custom editor to setup scenario files', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/package.json'), 'utf8')) as {
            contributes?: {
                customEditors?: Array<{ viewType?: string; selector?: Array<{ filenamePattern?: string }> }>;
                commands?: Array<{ command?: string; icon?: string }>;
            };
        };
        const editor = manifest.contributes?.customEditors?.find(item => item.viewType === 'cwtools.staticGalaxyEditor');
        expect(editor?.selector).to.deep.equal([{ filenamePattern: '**/map/setup_scenarios/*.txt' }]);
        const command = manifest.contributes?.commands?.find(item => item.command === 'cwtools.previewStaticGalaxy');
        expect(command?.icon).to.equal('$(map)');
    });

    it('static galaxy webview implements canvas hyperlane linking gestures', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.ts'), 'utf8');

        // Right-click arms lane drawing from a system; left-click picks the endpoint; right-click confirms.
        expect(script).to.include('state.pendingLink');
        expect(script).to.include('e.button === 2');
        expect(script).to.include('clearPendingLink');
        // Right-click on an existing lane deletes its add_hyperlane source declaration.
        expect(script).to.include('hitTestLane');
        expect(script).to.include('deleteHyperlane(lane.fromNodeKey, lane.toNodeKey)');
        // In draw mode left-click extends the endpoint chain; right-click confirms all segments in one edit.
        expect(script).to.include('pending.path.push(hit.nodeKey)');
        expect(script).to.include('submitAddLanes(pending.path)');
        expect(script).to.include("type: 'addHyperlanes'");
        // The browser context menu is suppressed on the canvas.
        expect(script).to.include("'contextmenu'");
        // Rubber-band rendering and cursor feedback exist.
        expect(script).to.include('drawPendingLink');
        expect(script).to.include("viewportEl.classList.add('linking')");
        // Coordinate inputs submit on Enter.
        expect(script).to.include("e.key === 'Enter'");

        const provider = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditorProvider.ts'), 'utf8');
        expect(provider).to.include('Right-click a system to draw lanes');

        const css = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.css'), 'utf8');
        expect(css).to.include('#viewport.linking');
    });

    it('static galaxy nebula radius editing and label LOD are wired', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.ts'), 'utf8');
        // Sidebar radius input with Enter/Apply submission.
        expect(script).to.include('renderNebulaRadiusEditor');
        expect(script).to.include('prop-radius-value');
        expect(script).to.include('submitNebulaRadius');
        expect(script).to.include("type: 'updateNebulaRadius'");
        // Coordinate + radius edits queue one after another.
        expect(script).to.include('pendingFollowUps');
        // Nebula labels are hidden at overview zoom but stay for selection/hover.
        expect(script).to.include('showNebulaLabels');

        const provider = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditorProvider.ts'), 'utf8');
        expect(provider).to.include("kind: 'nebulaRadius'");

        const builder = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditBuilder.ts'), 'utf8');
        expect(builder).to.include('buildNebulaRadiusEdit');
        expect(builder).to.include('radiusWritable');

        const parser = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyParser.ts'), 'utf8');
        expect(parser).to.include('radiusSpan');
    });

    it('static galaxy estimated lanes layer is heuristic, toggleable and gated', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.ts'), 'utf8');
        // Lazy recompute after new revisions, drawn before explicit lanes.
        expect(script).to.include('drawEstimatedLanes');
        expect(script).to.include('state.estimatedDirty = true');
        expect(script).to.include('estimateHyperlanes');
        // Only meaningful for random_hyperlanes scenarios.
        expect(script).to.include('sc.settings.randomHyperlanes');
        expect(script).to.include('updateEstimatedLanesUi');
        expect(script).to.include("classList.toggle('single-scenario'");

        const provider = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditorProvider.ts'), 'utf8');
        expect(provider).to.include('id="btn-est-lanes"');
        expect(provider).to.include('id="lanes-legend"');
        expect(provider).to.include('heuristic approximation, not the generated result');

        const estimate = fs.readFileSync(path.join(root, 'client/shared/staticGalaxyEstimate.ts'), 'utf8');
        expect(estimate).to.include('NOT Stellaris');
    });

    it('static galaxy spray/erase paint mode and initializer details are wired', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.ts'), 'utf8');
        // Paint mode toggles, stroke state machine and submissions exist.
        expect(script).to.include('setPaintMode');
        expect(script).to.include('state.paintStroke');
        expect(script).to.include('sprayAt');
        expect(script).to.include('eraseAt');
        expect(script).to.include('finishPaintStroke');
        expect(script).to.include("type: 'spraySystems'");
        expect(script).to.include("type: 'eraseSystems'");
        // Erase only targets undefined random systems.
        expect(script).to.include('isErasableSystem');
        // Shift line spray and Alt+right-drag brush sizing.
        expect(script).to.include('sampleSprayLine');
        expect(script).to.include('samplePreciseLine');
        expect(script).to.include('e.shiftKey');
        expect(script).to.include('state.radiusDrag');
        expect(script).to.include('setBrushRadius');
        // Initializer detail section and star-class coloring.
        expect(script).to.include('initializerInfo');
        expect(script).to.include('sys.visual?.color');

        const provider = fs.readFileSync(path.join(root, 'client/extension/staticGalaxyEditorProvider.ts'), 'utf8');
        expect(provider).to.include('id="btn-spray"');
        expect(provider).to.include('id="btn-erase"');
        expect(provider).to.include('id="brush-radius"');
        expect(provider).to.include('StaticGalaxyInitializerIndex');

        const css = fs.readFileSync(path.join(root, 'client/webview/staticGalaxyPreview.css'), 'utf8');
        expect(css).to.include('#viewport.painting');
    });

    it('event chain preview optimizes large graphs and exposes direct relation navigation', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/eventChainPreview.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/eventChainPreview.css'), 'utf8');

        expect(script).to.include('LARGE_GRAPH_NODE_THRESHOLD');
        expect(script).to.include("name: 'breadthfirst'");
        expect(script).to.include('hideEdgesOnViewport: true');
        expect(script).to.include('collectDirectRelationLinks');
        expect(script).to.include('data-select-node-id');
        expect(script).to.include('selectNode(relationNode, true)');
        expect(css).to.include('.details-relation-link');
        expect(css).to.include('prefers-reduced-motion');
    });
});
