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

describe('agent manager cross-surface contracts', () => {
    const root = path.resolve(__dirname, '../../..');

    it('host contract supports manager snapshot and topic metadata actions', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');
        const topics = fs.readFileSync(path.join(root, 'client/extension/ai/chatTopics.ts'), 'utf8');

        expect(hostTypes).to.include("type: 'requestManagerSnapshot'");
        expect(hostTypes).to.include("type: 'managerSnapshot'");
        expect(hostTypes).to.include("type: 'pinTopic'");
        expect(hostTypes).to.include("type: 'setTopicWorkspace'");
        expect(hostTypes).to.include('workspaceLabel?: string');
        expect(hostTypes).to.include('pinned?: boolean');

        expect(hostBridge).to.include("case 'requestManagerSnapshot'");
        expect(hostBridge).to.include('sendManagerSnapshot()');
        expect(hostBridge).to.include("case 'pinTopic'");
        expect(hostBridge).to.include("case 'setTopicWorkspace'");

        expect(topics).to.include('setPinned(');
        expect(topics).to.include('setWorkspace(');
        expect(topics).to.include('workspaceLabel: t.workspaceLabel');
        expect(topics).to.include('pinned: t.pinned');
    });

    it('manager runtime inherits chat behavior and exposes the focused review workbench', () => {
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const contracts = fs.readFileSync(path.join(root, 'client/webview/chat/messages.manager.ts'), 'utf8');
        const topicViews = fs.readFileSync(path.join(root, 'client/webview/chat/topicViews.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');

        expect(manager).to.include("import './chatPanel'");
        expect(manager).to.include("import type { ManagerSnapshotMessage");
        expect(manager).to.include("case 'orchestratorProgress'");
        expect(manager).to.include('data-manager-tab="changes"');
        expect(manager).to.include('data-manager-tab="activity"');
        expect(manager).to.include('data-manager-main-tab="conversation"');
        expect(manager).to.include('data-manager-main-tab="trajectory"');
        expect(manager).to.include("mainViewTabs.setAttribute('role', 'tablist')");
        expect(manager).to.include("trajectoryView.id = 'managerTrajectoryView'");
        expect(manager).to.include('manager-trajectory-details');
        expect(manager).to.include('trajectoryDetailsOpen ? trajectoryEventById');
        expect(manager).to.include('trajectoryDetailsOpen = true');
        expect(manager).to.include('function updateTrajectoryDetails');
        expect(manager).to.include('stableTrajectoryEndTime(run, state.runEvents)');
        expect(manager).to.not.include('trajectoryDetailsOpen = true;\n            renderTrajectoryView()');
        expect(manager).to.include('manager-agent-task-list');
        expect(manager).to.include('childRun.parentAgentId || traceModel.rootAgentId');
        expect(manager).to.include("tabs.setAttribute('role', 'tablist')");
        expect(manager).to.include('manager-agent-lanes');
        expect(manager).to.include('renderAgentTreeHTML');
        expect(manager).to.include('renderTraceRailHTML');
        expect(manager).to.include('data-agent-path');
        expect(manager).to.include('data-trace-event-id');
        expect(manager).to.include('data-diff-expand-file');
        expect(manager).to.include('data-diff-expand-context');
        expect(manager).to.not.include('run-inspector-slider');
        expect(manager).to.not.include('function renderMessages');
        expect(topicViews).to.include("grouping?: 'date' | 'workspace'");
        expect(topicViews).to.include('groupTopicsByWorkspace');
        expect(topicViews).to.include("type: 'setTopicWorkspace'");

        expect(contracts).to.include('export type ManagerWebviewMessage');
        expect(contracts).to.include('export interface ManagerSnapshotMessage');
        expect(contracts).to.include('export interface ManagerRunSnapshotMessage');
        expect(contracts).to.include('childRuns?: ManagerChildRunView[]');
        expect(contracts).to.include('export interface OrchestratorProgressMessage');

        expect(css).to.include('.manager-inspector-tabs');
        expect(css).to.include('.manager-review-files');
        expect(css).to.include('.manager-pane-resizer');
        expect(css).to.include('.manager-diff-line-omitted');
        expect(css).to.include('.manager-agent-explorer-grid');
        expect(css).to.include('.agent-run-tree');
        expect(css).to.include('.agent-trace-lanes');
        expect(css).to.include('.manager-main-tabs');
        expect(css).to.include('.manager-trajectory-ledger');
        expect(css).to.include('.manager-trajectory-details');
        expect(css).to.include('position: absolute');
        expect(css).to.include('.manager-agent-task-list .agent-tree-node');
        expect(css).to.include('flex-direction: row');
        expect(css).to.include('.manager-agent-task-list .agent-tree-copy span');
        expect(css).to.include('.agent-run-tree ul > .agent-tree-branch::before');
        expect(css).to.include('[data-manager-main-view="trajectory"] .chat-area');
        expect(css).to.not.include('.run-inspector-slider');
        expect(css).to.include('body.agent-manager-shell.artifact-drawer-open');
        expect(css).to.not.include('workspace-toggle {\n    display: none !important;');
    });

    it('keeps task progress and changed files visible above the manager composer', () => {
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const runner = fs.readFileSync(path.join(root, 'client/extension/ai/agentRunner.ts'), 'utf8');
        const ledger = fs.readFileSync(path.join(root, 'client/extension/ai/runner/runLedger.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');

        expect(manager).to.include("runDock.id = 'managerRunDock'");
        expect(manager).to.include('data-manager-dock-action="tasks"');
        expect(manager).to.include('data-manager-dock-action="changes"');
        expect(manager).to.include('data-manager-dock-file=');
        expect(manager).to.include('focusWorkspaceFile(');
        expect(manager).to.include("if (evt?.type === 'file_change')");
        expect(manager).to.include("if (evt?.type !== 'file_change') continue");
        expect(manager).to.include("diffLines: Array.isArray(payload.diffLines) ? payload.diffLines : undefined");
        expect(manager).to.include("if (evt?.type === 'tool_call_end')");
        expect(manager).to.include("if (evt?.type === 'subagent_end')");
        expect(runner).to.include("status: 'modified', additions: diff.additions, deletions: diff.deletions");
        expect(ledger).to.include("if (type === 'file_change')");
        expect(ledger).to.include('compacted.diffLines = lines');
        expect(css).to.include('.manager-run-dock');
        expect(css).to.include('.manager-dock-popover');
        expect(css).to.include('.manager-file-status-created');
    });

    it('routes child todos to the matching subagent view instead of the root task panel', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/chatPanel.css'), 'utf8');

        expect(hostTypes).to.include('export interface TodoUpdateScope');
        expect(hostTypes).to.include("type: 'todoUpdate'; todos: TodoItem[]; agentId?: string");
        expect(hostPanel).to.include("const scopeKey = scope?.agentId ? `agent:${scope.agentId}` : 'root'");
        expect(hostPanel).to.include('if (currentScope?.agentId) return;');
        expect(webview).to.include("fullscreen.dataset.agentId = agentId");
        expect(webview).to.include('renderSubagentTodos(msg.agentId, msg.todos || [])');
        expect(webview).to.include("fullscreen.querySelector('.subagent-task-panel')?.remove()");
        expect(css).to.include('.subagent-task-panel');
    });

    it('shares runtime profiles, inspector, and canonical transcript across surfaces', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const chat = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');

        expect(hostTypes).to.include("type: 'runtimeProfiles'");
        expect(hostTypes).to.include("type: 'runtimeInspectorSnapshot'");
        expect(hostTypes).to.include("type: 'transcriptSnapshot'");
        expect(hostPanel).to.include('agentProfileCatalog.startWatching()');
        expect(hostPanel).to.include("getTranscript(currentTopicId, currentTopicId, 'block')");
        expect(chat).to.include("case 'runtimeProfiles'");
        expect(chat).to.include("case 'runtimeInspectorSnapshot'");
        expect(manager).to.include("case 'transcriptSnapshot'");
        expect(manager).to.include('Canonical transcript');
    });

    it('manager settings stay local and preserve SecretStorage-backed search tokens', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');
        const settingsHost = fs.readFileSync(path.join(root, 'client/extension/ai/chatSettings.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const manifest = fs.readFileSync(path.join(root, 'release/package.json'), 'utf8');

        expect(hostTypes).to.include("targetSurface?: 'chat' | 'manager'");
        expect(hostBridge).to.include('provider.settingsManager.openSettingsPage(sourceSurface)');
        expect(hostBridge).to.include('provider.settingsManager.saveSettings(msg.settings, sourceSurface)');
        expect(settingsHost).to.include("targetSurface?: 'chat' | 'manager'");
        expect(webview).to.include('isCurrentSurface(msg.targetSurface)');
        expect(webview).to.include('if (shouldUseSideWorkspace())');
        expect(webview).to.include("title: chatI18n.locale === 'zh-cn' ? 'AI 设置' : 'AI Settings'");
        expect(webview).to.include('document.getElementById(`webKey-${provider}`)');
        expect(webview).to.include('webAccess: {');
        expect(settingsHost).to.include("getKeyManager().setKey(`web.${provider}`");
        expect(manifest).to.not.include('stellarisLanguageServices.ai.braveSearchApiKey');
        expect(manifest).to.not.include('stellarisLanguageServices.ai.exaApiKey');
    });

    it('manager layout and composer menus adapt to the active surface geometry', () => {
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const managerCss = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');

        expect(managerCss).to.include('--manager-active-right-width: 0px;');
        expect(managerCss).to.include('--manager-active-left-width: var(--manager-left-width);');
        expect(managerCss).to.include('--manager-active-right-width: var(--manager-right-width);');
        expect(managerCss).to.include('right: calc(var(--manager-active-right-width) + 16px);');
        expect(managerCss).to.include('left: calc(var(--manager-active-left-width) + 16px);');
        expect(managerCss).to.include('width: min(calc(100vw - var(--manager-active-left-width) - var(--manager-active-right-width) - 32px), 980px);');
        expect(managerCss).to.not.include('body.agent-manager-shell .floating-card-area {\n    position: absolute;\n    left: calc(var(--manager-active-left-width) + 16px);\n    right: calc(var(--manager-active-right-width) + 16px);\n    bottom: 98px;\n    width: auto;\n    max-width: none;');
        expect(managerCss).to.include('body.agent-manager-shell.manager-topics-collapsed');
        expect(managerCss).to.include('body.agent-manager-shell .manager-overview {\n    position: relative;');
        expect(managerCss).to.include('body.agent-manager-shell .header-actions #btnTopics {\n    display: inline-flex;');
        expect(managerCss).to.include('body.agent-manager-shell .header-actions #btnAgentManager {\n    display: none;');
        expect(webview).to.include('function positionComposerMenus(): void');
        expect(webview).to.include('function updateManagerTopicsToggleState(): void');
        expect(webview).to.include("document.body.classList.toggle('manager-topics-collapsed', collapsed);");
        expect(webview).to.include("vscode.postMessage({ type: 'openAgentManager' })");
        expect(webview).to.include("window.addEventListener('resize', positionComposerMenus);");
        expect(webview).to.include('function currentViewportWidth(): number');
        expect(webview).to.include('new ResizeObserver(scheduleResponsiveWorkspaceLayoutSync)');
        expect(webview).to.include("window.addEventListener('resize', scheduleResponsiveWorkspaceLayoutSync);");
        expect(webview).to.include('menu.style.left =');
        expect(manager).to.include('taskStatusMark(');
        expect(managerCss).to.include('.manager-task-mark');
        expect(html).to.include('id="btnAgentManager"');
        expect(hostTypes).to.include("{ type: 'openAgentManager' }");
        expect(hostBridge).to.include("case 'openAgentManager'");
        expect(hostPanel).to.include("this._syncViewChromeState('manager')");
        expect(hostPanel).to.include('openManagerPanelInNewWindow');
        expect(hostPanel).to.include("workbench.action.moveEditorToNewWindow");
        expect(hostPanel).to.include('if (replayLiveSteps && this._isGenerating');
        expect(manager).to.include('__cwtoolsPostReady');
    });

    it('restored interactive cards and live replay stay idempotent', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(hostTypes).to.include("uiState?: 'pending' | 'approved'");
        expect(hostBridge).to.include('markLatestInteractiveCardApproved');
        expect(hostBridge).to.include("['plan_card', 'blueprint_card']");
        expect(hostBridge).to.include("['walkthrough_card']");
        expect(webview).to.include("pCard = steps.find((s: any) => s.type === 'plan_card' && s.uiState === 'pending')");
        expect(webview).to.include("wtCard = steps.find((s: any) => s.type === 'walkthrough_card' && s.uiState === 'pending')");
        expect(webview).to.include("bpCard = steps.find((s: any) => s.type === 'blueprint_card' && s.uiState === 'pending')");
        expect(webview).to.include('restorePendingInteractiveCardsFromSteps(r.steps);');
        expect(hostPanel).to.include('await this.renderWalkthroughUI(wtPath, topicId, uiSteps);');
        expect(webview).to.include('function removeReplayBanners(): void');
        expect(webview).to.include("window.addEventListener('focus', removeReplayBanners);");
        expect(webview).to.include('currentAssistantDiv = initLiveAssistantDiv();');
        expect(webview).to.include('for (const step of replayedSteps)');
    });

    it('sidebar restore messages do not broadcast replay state into the manager', () => {
        const broadcaster = fs.readFileSync(path.join(root, 'client/extension/ai/agentUiBroadcaster.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');

        expect(broadcaster).to.include('postMessageToSurface');
        expect(broadcaster).to.include("targetSurface === surface");
        expect(hostPanel).to.include("this._restoreViewState('chat')");
        expect(hostPanel).to.include('this.postMessageToSurface(targetSurface, msg)');
        expect(hostPanel).to.include("targetSurface })");
        expect(hostPanel).to.include("this._restoreViewState(surface, true)");
        expect(hostBridge).to.include("case 'ready'");
        expect(hostBridge).to.include('provider.restoreViewState(sourceSurface, true)');
        expect(hostPanel).to.include('this.sendWorkflowState(send)');
        expect(hostPanel).to.include('this.broadcaster.register(webview, surface)');
    });

    it('manager focus restore is non-destructive for chat DOM state', () => {
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');

        expect(hostPanel).to.include('private _syncViewChromeState');
        expect(hostPanel).to.include("if (e.webviewPanel.visible) this._syncViewChromeState('manager');");
        expect(hostBridge).to.include("provider.restoreViewState(sourceSurface, true)");
        expect(hostPanel).to.not.include("if (e.webviewPanel.visible) this._restoreViewState('manager', true);");
        expect(hostPanel).to.not.include("this.managerPanel.reveal(this.managerPanel.viewColumn ?? vs.ViewColumn.One, false);\n            this._restoreViewState('manager', true);");
    });

    it('manager side workspace shifts conversation and composer away from the workspace', () => {
        const managerCss = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');

        expect(managerCss).to.include('body.agent-manager-shell.side-workspace-open');
        expect(managerCss).to.include('--manager-active-right-width: var(--active-side-workspace-width);');
        expect(managerCss).to.include('body.agent-manager-shell.side-workspace-open .chat-area');
        expect(managerCss).to.include('body.agent-manager-shell.side-workspace-open .input-wrapper');
        expect(managerCss).to.include('margin-right: var(--active-side-workspace-width) !important;');
    });

    it('cross-surface floating cards resolve on both surfaces', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostBridge = fs.readFileSync(path.join(root, 'client/extension/ai/chat/bridge.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(hostTypes).to.include("type: 'floatingCardResolved'");
        expect(hostBridge).to.include("card: 'permission'");
        expect(hostBridge).to.include("card: 'write'");
        expect(hostBridge).to.not.include("card: 'transaction'");
        expect(hostBridge).to.not.include("case 'approveTransaction'");
        expect(hostBridge).to.include("card: 'walkthrough'");
        expect(webview).to.include("case 'floatingCardResolved'");
        expect(webview).to.include('function resolveFloatingCard');
        expect(webview).to.include("approveMessageType: 'approveWalkthrough'");
        expect(webview).to.include('scheduleResponsiveWorkspaceLayoutSync()');
        expect(webview).to.include('if (!isCurrentSurface(msg.targetSurface)) break;');
        expect(webview).to.include('if (shouldUseSideWorkspace()) {');
        expect(webview).to.include('openSideWorkspace({');
        expect(webview).to.not.include('if (!panel.content.parentNode) {\n            chatArea.appendChild(panel.content);\n        }\n\n        if (shouldUseSideWorkspace())');
    });
});
