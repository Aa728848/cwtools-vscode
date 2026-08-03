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
        const host = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');

        expect(html).to.include('id="chatArea"');
        expect(html).to.include('id="modeSel"');
        expect(html).to.include('id="composerAddBtn"');
        expect(html).to.include('id="quickModeTrigger"');
        expect(html).not.to.include('data-profile-domain="auto"');
        expect(html).to.include('data-profile-domain="paradox"');
        expect(html).to.include('data-profile-domain="general"');
        expect(html).to.include('<span id="quickModeLabel">Paradox</span>');
        expect(html).not.to.include('data-profile-intent=');
        expect(html).not.to.include('data-profile-strategy=');
        expect(script).to.include("let agentProfile: AgentProfileSelection = { domain: 'paradox', intent: 'auto', strategy: 'auto' };");
        expect(script).to.include("agentProfile = { domain, intent: 'auto', strategy: 'auto' }");
        expect(script).to.include('updateAgentDomain(domain);\n                setModeMenuOpen(false);');
        expect(css).not.to.include('.composer-write-mode-trigger.write-mode-elevated {');
        expect(css).not.to.include('.write-mode-item-danger.active { border-color: var(--error); }');
        expect(css).to.include('.composer-write-mode-trigger:focus-visible');
        expect(css).to.include('border: 0 !important;');
        expect(css).to.include('outline: none !important;');
        expect(css).to.include('box-shadow: none !important;');
        expect(css).not.to.include('#quickWriteModeTrigger:focus-visible');
        expect(css).not.to.include('#quickWriteModeTrigger.write-mode-danger {\n    background: transparent !important;\n    color: var(--error);');
        expect(css).to.include('#quickWriteModeTrigger.write-mode-danger { color: var(--warning); }');
        expect(css).to.include('.write-mode-menu .write-mode-item-danger span:first-child { color: var(--warning); }');
        expect(css).not.to.include('.sandbox-backend-unavailable');
        expect(script).not.to.include("classList.toggle('sandbox-backend-unavailable'");
        expect(css).to.include('.write-mode-menu .write-mode-item-danger:focus-visible { outline: none; box-shadow: none; }');
        expect(script).to.include('setWriteModeMenuOpen(false);\n                input.focus();');
        expect(html).to.include('id="quickModelTrigger"');
        expect(html).to.include('id="quickReasoningEffort"');
        expect(html).to.include('id="quickReasoningTrigger"');
        expect(html).to.include('id="reasoningMenu"');
        expect(html).to.include('id="reasoningMenuList"');
        expect(script).to.include('settingsReasoningCapabilities');
        expect(script).to.include('populateReasoningSelect');
        expect(html).to.include('id="quickWriteModeTrigger"');
        expect(html).to.include('role="listbox"');
        expect(html).to.include('id="btnWorkspace"');
        expect(html).to.include('data-composer-action="workflows"');
        expect(html).to.include('data-composer-action="plan"');
        expect(html).to.include('data-composer-action="goal"');
        expect(html).not.to.include('id="runtimeProfileMenuList"');
        expect(script).to.include("switchMode('plan', /* fromUI */ true);");
        expect(script).to.include("setInputText('/goal ');");
        expect(script).not.to.include('function renderRuntimeProfiles()');
        expect(host).to.include('profileForUserDomain(normalizedStoredProfile.domain)');
        expect(html).to.include('id="artifactDrawer"');
        expect(html).to.include("'mermaid.min.js'");
        expect(script).to.include("case 'workflowList'");
        expect(script).to.include("case 'slashCommandList'");
        expect(script).to.include("case 'slashCommandResult'");
        expect(script).to.include('handleSlashPopupKeydown');
        expect(script).to.include('slashHasAttachments');
        expect(script).to.include('renderComposerChips');
        expect(script).to.include('setReasoningMenuOpen');
        expect(script).to.include('renderQuickReasoningMenu');
        expect(script).to.include('renderArtifactPanel');
        expect(script).to.include('renderTopics');
        expect(script).to.include('renderArtifactDrawer');
        expect(script).to.include('showResponsiveWorkspacePanel');
        expect(script).to.include('renderTopicsView');
        expect(script).to.include('buildSettingsOverviewModel');
        expect(script).to.include('cachedSettingsData');
        expect(script).to.include("input.dataset.apDropdownBound === 'true'");
        expect(script).to.include('provSel.onchange =');
    });

    it('shows and restores the automatic routing decision on its user turn', () => {
        const host = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const bridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');
        const types = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');

        expect(host).to.include('resolvedAgentProfile: resolvedProfile');
        expect(types).to.include('resolvedAgentProfile?: ResolvedAgentProfile');
        expect(script).to.include('parseResolvedAgentProfileView(resolvedAgentProfile)');
        expect(script).to.include("tr('Multi-Agent', '多 Agent')");
        expect(script).to.include("case 'agentRoutingStatus'");
        expect(script).to.include("tr('Decision summary', '判断摘要')");
        expect(script).to.include("tr('Awaiting your decision', '等待用户敲定')");
        expect(script).to.include('m.resolvedAgentProfile');
        expect(css).to.include('.agent-routing-status');
        expect(css).to.include('.agent-routing-live');
        expect(host).to.include("public getApprovedPlanExecutionMode(): 'orchestrator' | 'script'");
        expect(host).to.include('mode: approvalMode');
        expect(bridge).to.include('const executionMode = provider.getApprovedPlanExecutionMode();');
        expect(bridge).to.include('provider.switchMode(executionMode, false, false);');
    });

    it('usage panel exposes request-level cache metrics and every required grouping', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(script).to.include("tr('Cache requests', '缓存请求')");
        expect(script).to.include("tr('cached input tokens', '缓存输入 token')");
        expect(script).to.include("tr('token hit rate', 'token 命中率')");
        expect(script).to.include("tr('saved tokens', '节省 token')");
        expect(script).to.include('cache.totalCachedTokens');
        expect(script).to.include("tr('saved about', '约节省')");
        expect(script).to.include("renderCacheDimension(tr('Provider', '供应商'), cache.byProvider)");
        expect(script).to.include("renderCacheDimension(tr('Model', '模型'), cache.byModel)");
        expect(script).to.include("renderCacheDimension(tr('Agent mode', 'Agent 模式'), cache.byAgentMode)");
        expect(script).to.include("renderCacheDimension(tr('Tool stage', '工具阶段'), cache.byToolStage)");
        expect(script).to.include("renderCacheDimension(tr('Prompt variants', '提示词版本'), cache.byPromptFingerprint, true)");
        expect(script).to.include("tr('Zero-hit reasons', '零命中原因')");
        expect(script).to.include('class="usage-cache-overview"');
        expect(script).to.include('class="usage-cache-chip"');
        expect(script).to.include("`${key.slice(0, 8)}…${key.slice(-6)}`");
        expect(script).to.include('class="usage-cache-advanced"');
    });

    it('chat webview modules expose split UI contracts', () => {
        const modules = [
            'artifactDrawer.ts',
            'topicViews.ts',
            'settingsOverview.ts',
            'liveSteps.ts',
            'markdown.ts',
            'mermaidRenderer.ts',
            'messageSelectionActions.ts',
            'userMessagePresentation.ts',
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

    it('renders long user input as an expandable summary card on both chat surfaces', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');

        expect(script).to.include('buildUserMessagePresentation(text)');
        expect(script).to.include("card.className = 'long-user-input-card'");
        expect(script).to.include("tr('Expand', '展开全文')");
        expect(script).to.include("tr('Collapse', '收起')");
        expect(css).to.include('.long-user-input-card[open] .long-user-input-full');
        expect(manager).to.include("import './chatPanel'");
    });

    it('chat webview keeps visual shell contracts for browser regression coverage', () => {
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const mermaidRenderer = fs.readFileSync(path.join(root, 'client/webview/chat/mermaidRenderer.ts'), 'utf8');
        const selectionActions = fs.readFileSync(path.join(root, 'client/webview/chat/messageSelectionActions.ts'), 'utf8');

        for (const selector of [
            '.message.assistant',
            '.msg-bubble',
            '.input-wrapper',
            '.composer-menu',
            '.model-menu',
            '.reasoning-menu',
            '.slash-popup',
            '.artifact-drawer',
            '.workspace-toggle',
            '.topics-panel',
            '.subagent-fullscreen-view',
            '.annotatable-plan',
            '.md-table-wrap',
            '.md-codeblock',
            '.md-mermaid',
            '.message-selection-toolbar',
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
        expect(css).to.include('.ap-section-text .md-mermaid-toolbar,');
        expect(css).to.include('border-radius: 20px; overflow: visible;');
        expect(css).to.include('.composer-menu-item.active::after, .model-menu-item.active::after');
        expect(css).to.include('.reasoning-menu { width: max-content; min-width: max-content;');
        expect(css).to.include('.send-btn, body.plan-mode .send-btn');
        expect(css).to.include('border-radius: 13px; z-index: 240;');
        expect(css).to.include('.ds-review-btn');
        expect(script).to.include("el.className = 'slash-popup mention-popup'");
        expect(script).to.include("card.querySelector<HTMLButtonElement>('.ds-review-btn')");
        expect(script).to.include("positionMenu(reasoningMenu, quickReasoningTrigger, 'end')");
        expect(mermaidRenderer).to.include('htmlLabels: false');
        expect(mermaidRenderer).to.include('wrappingWidth: MERMAID_FLOWCHART_WRAP_WIDTH');
        expect(mermaidRenderer).to.include('--mermaid-natural-width');
        expect(mermaidRenderer).to.include('--mermaid-preview-width');
        expect(css).to.include('max-height: min(70vh, 800px)');
        expect(mermaidRenderer).to.include('nodeTextColor');
        expect(mermaidRenderer).to.include('edgeLabelBackground');
        expect(script).to.include('startMessageSelectionActions({');
        expect(script).to.include("tr('Add to task', '添加到任务')");
        expect(selectionActions).to.include("start.closest('.message')");
        expect(selectionActions).to.include('window.getSelection()?.removeAllRanges()');
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

    it('handles live Codex collapsibles before streaming DOM replacement can cancel clicks', () => {
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(script).to.include("chatArea.addEventListener('pointerdown'");
        expect(script).to.include("control?.closest('.codex-live-host')");
        expect(script).to.include('toggleCodexActivityControl(control)');
        expect(script).to.include('suppressLiveCodexClickUntil');
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
