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

    it('permission cards expose scoped decisions, critical risk, and accessible state', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');
        expect(script).to.include("3: { text: tr('Critical / destructive'");
        expect(script).to.include("setAttribute('role', 'alertdialog')");
        expect(script).to.include("finish('acceptForSession'");
        expect(script).to.include("case 'permissionResolved'");
        expect(script).to.include('fullAccessArmedUntil = Date.now() + 10_000');
        const host = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        expect(host).to.include('availableDecisions.includes(decision)');
        expect(css).to.include('var(--vscode-errorForeground)');
        expect(css).to.include('.permission-scope-row');
    });

    it('chat webview source exposes expected bootstrap controls', () => {
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(html).to.include('id="chatArea"');
        expect(html).to.include('id="modeSel"');
        expect(html).to.include('id="composerAddBtn"');
        expect(html).to.include('id="quickModeTrigger"');
        expect(html).to.include('id="quickModelTrigger"');
        expect(html).to.include('id="quickReasoningEffort"');
        expect(html).to.include('id="quickWriteModeTrigger"');
        expect(html).to.include('role="listbox"');
        expect(html).to.include('id="btnWorkspace"');
        expect(html).to.include('data-composer-action="workflows"');
        expect(html).to.include('id="artifactDrawer"');
        expect(html).to.include("'mermaid.min.js'");
        expect(script).to.include("case 'workflowList'");
        expect(script).to.include("case 'slashCommandList'");
        expect(script).to.include("case 'slashCommandResult'");
        expect(script).to.include('handleSlashPopupKeydown');
        expect(script).to.include('slashHasAttachments');
        expect(script).to.include('renderComposerChips');
        expect(script).to.include('renderArtifactPanel');
        expect(script).to.include('renderTopics');
        expect(script).to.include('renderArtifactDrawer');
        expect(script).to.include('showResponsiveWorkspacePanel');
        expect(script).to.include('renderTopicsView');
        expect(script).to.include('buildSettingsOverviewModel');
    });

    it('chat webview modules expose split UI contracts', () => {
        const modules = [
            'artifactDrawer.ts',
            'topicViews.ts',
            'settingsOverview.ts',
            'liveSteps.ts',
            'markdown.ts',
            'mermaidRenderer.ts',
            'annotations.ts',
            'contextMentions.ts',
            'i18n.ts',
            'modes.ts',
            'slashCommands.ts',
        ];

        for (const moduleName of modules) {
            const source = fs.readFileSync(path.join(root, 'client/webview/chat', moduleName), 'utf8');
            expect(source).to.match(/export (function|interface|type|const)/);
        }
    });

    it('chat webview keeps visual shell contracts for browser regression coverage', () => {
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const mermaidRenderer = fs.readFileSync(path.join(root, 'client/webview/chat/mermaidRenderer.ts'), 'utf8');

        for (const selector of [
            '.message.assistant',
            '.msg-bubble',
            '.input-wrapper',
            '.composer-menu',
            '.model-menu',
            '.slash-popup',
            '.artifact-drawer',
            '.workspace-toggle',
            '.topics-panel',
            '.subagent-fullscreen-view',
            '.annotatable-plan',
            '.md-table-wrap',
            '.md-codeblock',
            '.md-mermaid',
            '.context-compaction-card',
        ]) {
            expect(css).to.include(selector);
        }
        expect(css).to.include('overflow-x:auto');
        expect(css).to.include('width:max-content');
        expect(css).to.include('.artifact-file-status');
        expect(css).to.include('.artifact-file-additions');
        expect(css).to.include('.artifact-file-deletions');
        expect(css).to.include('.ds-file-status');
        expect(css).to.include('.side-diff-file-status');
        expect(css).to.include('.aw-count');
        for (const id of ['chatArea', 'input', 'sendBtn', 'slashPopup', 'artifactDrawer', 'topicsPanel', 'btnWorkspace']) {
            expect(html).to.include(`id="${id}"`);
        }
        expect(script).to.include('IntersectionObserver');
        expect(script).to.include('enhanceCodeBlocks');
        expect(script).to.include('enhanceTaskLists');
        expect(script).to.include('applyLiveCompactionStep');
        expect(script).to.include("case 'contextCompactionStatus'");
        expect(css).to.include('context-compact-flow');
        expect(css).to.include('prefers-reduced-motion');
        expect(css).to.include('--mermaid-node-bg');
        expect(css).to.include('.md-mermaid-output svg text');
        expect(css).to.include('.md-mermaid-output svg .node rect');
        expect(css).to.include('.md-mermaid-output svg .flowchart-link');
        expect(css).to.include('.ap-section-text .md-mermaid-toolbar { pointer-events: auto; }');
        expect(mermaidRenderer).to.include('htmlLabels: false');
        expect(mermaidRenderer).to.include('nodeTextColor');
        expect(mermaidRenderer).to.include('edgeLabelBackground');
        const annotations = fs.readFileSync(path.join(root, 'client/webview/chat/annotations.ts'), 'utf8');
        expect(annotations).to.include("target?.closest('button, textarea, input, select, a')");
    });

    it('chat sidebar reserves composer height for bottom confirmation cards', () => {
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(css).to.include('--chat-scroll-bottom-pad: calc(var(--composer-stack-height)');
        expect(css).to.include('padding: 12px 12px var(--chat-scroll-bottom-pad)');
        expect(css).to.include('scroll-padding-bottom: var(--chat-scroll-bottom-pad)');
        expect(css).to.include('bottom: calc(var(--composer-popup-bottom) + 2px)');
        expect(css).to.include('@media (max-height: 620px)');
        expect(css).to.include('.floating-card-area { max-height: calc(100vh - var(--composer-popup-bottom) - 48px); overflow-y: auto; }');
        expect(script).to.include('function scheduleComposerScrollSync()');
        expect(script).to.include('let scrollBottomPending = false;');
        expect(script).to.include('let subagentScrollPending = false;');
    });

    it('chat clear resets stale topic workspace panels', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(script).to.include('function clearTopicWorkspaceState()');
        expect(script).to.include('sideDiffEntries.length = 0;');
        expect(script).to.include('activeResponsiveWorkspace = null;');
        expect(script).to.include("case 'clearChat':");
        expect(script).to.include('clearActiveSubagentViews();');
        expect(script).to.include('clearTopicWorkspaceState();');
    });

    it('annotation panel reuse resets stale approval state for new plans', () => {
        const annotations = fs.readFileSync(path.join(root, 'client/webview/chat/annotations.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(annotations).to.include('let currentOptions = options;');
        expect(annotations).to.include('annotations.length = 0;');
        expect(annotations).to.include('approveBtn.disabled = false;');
        expect(annotations).to.include('submitBtn.disabled = true;');
        expect(script).to.not.include('wasApproved');
        expect(script).to.not.include('approvedButtonHtml');
    });

    it('question cards batch answers before resuming the agent', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');

        expect(script).to.include('function buildQuestionAnswersMessage');
        expect(script).to.include("vscode.postMessage({ type: 'sendMessage', text });");
        expect(script).to.include("c.style.display = 'block';");
        expect(script).to.include('question-submit-btn');
        expect(css).to.include('.question-wizard-list');
        expect(css).to.include('.question-other-input');
    });

    it('mention replacement can resolve pasted text split across DOM nodes', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(script).to.include('function getComposerTextBeforeRange');
        expect(script).to.include('function domPointForComposerTextOffset');
        expect(script).to.include('textFromComposerNode(before.cloneContents())');
        expect(script).to.include('triggerRange.setStart(start.node, start.offset);');
    });

    it('release bundle exists and is non-empty after compile', () => {
        const bundlePath = path.join(root, 'release/bin/client/webview/chatPanel.js');
        const stat = fs.statSync(bundlePath);

        expect(stat.size).to.be.greaterThan(1000);
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
        expect(css).to.include('var(--vscode-editor-background)');
        expect(css).to.include('#side-panel #layers-panel,');
        expect(css).to.include('body.overlay-focus');
        expect(css).to.include('@media (prefers-reduced-motion: reduce)');
    });

    it('solar-system preview exposes the redesigned editor shell and bounded rendering', () => {
        const host = fs.readFileSync(path.join(root, 'client/extension/solarSystemPanel.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/solarSystemPreview.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/solarSystemPreview.css'), 'utf8');

        for (const control of [
            'id="btn-preview"',
            'id="btn-edit"',
            'id="btn-add-body"',
            'id="btn-delete-body"',
            'id="btn-fit-all"',
            'id="btn-focus"',
            'id="inspector-resizer"',
        ]) {
            expect(host).to.include(control);
        }
        expect(host).to.include("command: 'documentState'");
        expect(host).to.include("iconNames.add(`${icon}_big`)");
        expect(script).to.include('function scheduleRender(): void');
        expect(script).not.to.include('requestAnimationFrame(render);');
        expect(script).to.include('function collectBodyFitBounds(');
        expect(script).to.include('addOrbitEnvelope(bounds, 0, 0, outerRadius);');
        expect(script).not.to.include('parentRadius + orbitToRenderRadius(body.resolvedOrbitRadius)');
        expect(script).to.include('function resolveBodyIcon');
        expect(script).to.include('const severeUpscale =');
        expect(script).to.include("setWorkspaceMode('preview')");
        expect(css).to.include('var(--vscode-editor-background)');
        expect(css).to.include('@media (prefers-reduced-motion: reduce)');
        expect(css).to.include('body:not(.is-edit-mode) .edit-only');
    });

    it('agent manager shell wiring exists', () => {
        const managerHtml = fs.readFileSync(path.join(root, 'client/extension/ai/agentManagerHtml.ts'), 'utf8');
        const managerCss = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');
        const managerEntry = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const chatHtml = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const chatScript = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const codexRows = fs.readFileSync(path.join(root, 'client/webview/chat/codexToolRows.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');

        expect(managerHtml).to.include("bodyClass: 'chat-empty agent-manager-shell'");
        expect(managerHtml).to.include("scriptName: 'agentManager.js'");
        expect(chatHtml).to.include('const stylesheetUris = [cssUri.toString(), ...(options?.extraStylesheets ?? [])];');
        expect(managerCss).to.include('body.agent-manager-shell');
        expect(managerCss).to.include('.manager-overview');
        expect(managerCss).to.include('.manager-inspector-tabs');
        expect(managerCss).to.include('.topics-panel');
        expect(managerCss).to.include('.artifact-drawer');
        expect(managerEntry).to.include("import './chatPanel'");
        expect(chatScript).to.include("subagentBody.innerHTML = `<div class=\"codex-live-host\">${renderAssistantTurnCodex('', []");
        expect(chatScript).to.include('isSubagentView: true');
        expect(chatScript).to.include('removeDuplicateDiffSummaryFiles');
        expect(chatScript).to.include('data-auto-write-path');
        expect(codexRows).to.include('data-codex-activity-row-toggle');
        expect(codexRows).to.include('codex-activity-row-details');
        expect(managerEntry).to.include("import type { ManagerSnapshotMessage");
        expect(managerEntry).to.include("case 'managerSnapshot'");
        expect(managerEntry).to.include("case 'orchestratorProgress'");
        expect(hostBridge).to.include("case 'requestManagerSnapshot'");
        expect(hostPanel).to.include("type: 'managerSnapshot'");
        expect(hostBridge).to.include("case 'pinTopic'");
        expect(hostBridge).to.include("case 'setTopicWorkspace'");
    });

    it('agent manager release bundle exists and is non-empty after compile', () => {
        const bundlePath = path.join(root, 'release/bin/client/webview/agentManager.js');
        const stat = fs.statSync(bundlePath);

        expect(stat.size).to.be.greaterThan(1000);
    });
});
