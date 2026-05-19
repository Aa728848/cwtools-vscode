import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('agent manager cross-surface contracts', () => {
    const root = path.resolve(__dirname, '../../..');

    it('host contract supports manager snapshot and topic metadata actions', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const topics = fs.readFileSync(path.join(root, 'client/extension/ai/chatTopics.ts'), 'utf8');

        expect(hostTypes).to.include("type: 'requestManagerSnapshot'");
        expect(hostTypes).to.include("type: 'managerSnapshot'");
        expect(hostTypes).to.include("type: 'pinTopic'");
        expect(hostTypes).to.include("type: 'setTopicWorkspace'");
        expect(hostTypes).to.include('workspaceLabel?: string');
        expect(hostTypes).to.include('pinned?: boolean');

        expect(hostPanel).to.include("case 'requestManagerSnapshot'");
        expect(hostPanel).to.include('sendManagerSnapshot()');
        expect(hostPanel).to.include("case 'pinTopic'");
        expect(hostPanel).to.include("case 'setTopicWorkspace'");

        expect(topics).to.include('setPinned(');
        expect(topics).to.include('setWorkspace(');
        expect(topics).to.include('workspaceLabel: t.workspaceLabel');
        expect(topics).to.include('pinned: t.pinned');
    });

    it('manager runtime inherits chat behavior and adds inspector tabs', () => {
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const contracts = fs.readFileSync(path.join(root, 'client/webview/chat/messages.manager.ts'), 'utf8');
        const topicViews = fs.readFileSync(path.join(root, 'client/webview/chat/topicViews.ts'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');

        expect(manager).to.include("import './chatPanel'");
        expect(manager).to.include("import type { ManagerSnapshotMessage");
        expect(manager).to.include("case 'orchestratorProgress'");
        expect(manager).to.include('data-manager-tab="agents"');
        expect(manager).to.include('data-manager-tab="artifacts"');
        expect(manager).to.include('data-manager-tab="tasks"');
        expect(manager).to.not.include('function renderMessages');
        expect(topicViews).to.include("grouping?: 'date' | 'workspace'");
        expect(topicViews).to.include('groupTopicsByWorkspace');
        expect(topicViews).to.include("type: 'setTopicWorkspace'");

        expect(contracts).to.include('export type ManagerWebviewMessage');
        expect(contracts).to.include('export interface ManagerSnapshotMessage');
        expect(contracts).to.include('export interface OrchestratorProgressMessage');

        expect(css).to.include('.manager-inspector-tabs');
        expect(css).to.include('body.agent-manager-shell.artifact-drawer-open');
        expect(css).to.not.include('workspace-toggle {\n    display: none !important;');
    });

    it('manager settings stay local and preserve search tokens', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const settingsHost = fs.readFileSync(path.join(root, 'client/extension/ai/chatSettings.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(hostTypes).to.include("targetSurface?: 'chat' | 'manager'");
        expect(hostPanel).to.include('this.settingsManager.openSettingsPage(sourceSurface)');
        expect(hostPanel).to.include('this.settingsManager.saveSettings(msg.settings, sourceSurface)');
        expect(settingsHost).to.include("targetSurface?: 'chat' | 'manager'");
        expect(webview).to.include('isCurrentSurface(msg.targetSurface)');
        expect(webview).to.include('&& !isManagerShell()');
        expect(webview).to.include("document.getElementById('exaApiKey')");
        expect(webview).to.include('exaApiKey: ((document.getElementById');
    });

    it('manager layout and composer menus adapt to the active surface geometry', () => {
        const manager = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const managerCss = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');

        expect(managerCss).to.include('--manager-active-right-width: 0px;');
        expect(managerCss).to.include('--manager-active-left-width: var(--manager-left-width);');
        expect(managerCss).to.include('--manager-active-right-width: var(--manager-right-width);');
        expect(managerCss).to.include('right: calc(var(--manager-active-right-width) + 16px);');
        expect(managerCss).to.include('left: calc(var(--manager-active-left-width) + 16px);');
        expect(managerCss).to.include('body.agent-manager-shell.manager-topics-collapsed');
        expect(managerCss).to.include('body.agent-manager-shell .manager-overview {\n    display: none;');
        expect(managerCss).to.include('body.agent-manager-shell .header-actions #btnTopics {\n    display: inline-flex;');
        expect(managerCss).to.include('body.agent-manager-shell .header-actions #btnAgentManager {\n    display: none;');
        expect(webview).to.include('function positionComposerMenus(): void');
        expect(webview).to.include('function updateManagerTopicsToggleState(): void');
        expect(webview).to.include("document.body.classList.toggle('manager-topics-collapsed', collapsed);");
        expect(webview).to.include("vscode.postMessage({ type: 'openAgentManager' })");
        expect(webview).to.include("window.addEventListener('resize', positionComposerMenus);");
        expect(webview).to.include('menu.style.left =');
        expect(manager).to.include('taskStatusMark(');
        expect(managerCss).to.include('.manager-task-mark');
        expect(html).to.include('id="btnAgentManager"');
        expect(hostTypes).to.include("{ type: 'openAgentManager' }");
        expect(hostPanel).to.include("case 'openAgentManager'");
        expect(hostPanel).to.include("this._restoreViewState('manager', true)");
        expect(hostPanel).to.include('openManagerPanelInNewWindow');
        expect(hostPanel).to.include("workbench.action.moveEditorToNewWindow");
        expect(hostPanel).to.include('if (replayLiveSteps && this._isGenerating');
        expect(manager).to.include('__cwtoolsPostReady');
    });

    it('restored interactive cards and live replay stay idempotent', () => {
        const hostTypes = fs.readFileSync(path.join(root, 'client/extension/ai/types.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(hostTypes).to.include("uiState?: 'pending' | 'approved'");
        expect(hostPanel).to.include('markLatestInteractiveCardApproved');
        expect(hostPanel).to.include("['plan_card', 'blueprint_card']");
        expect(hostPanel).to.include("['walkthrough_card']");
        expect(webview).to.include("pCard.uiState !== 'approved'");
        expect(webview).to.include("wtCard.uiState !== 'approved'");
        expect(webview).to.include("bpCard.uiState !== 'approved'");
        expect(webview).to.include('function removeReplayBanners(): void');
        expect(webview).to.include("window.addEventListener('focus', removeReplayBanners);");
        expect(webview).to.include('currentAssistantDiv = initLiveAssistantDiv();');
        expect(webview).to.include('for (const step of replayedSteps)');
    });

    it('sidebar restore messages do not broadcast replay state into the manager', () => {
        const broadcaster = fs.readFileSync(path.join(root, 'client/extension/ai/agentUiBroadcaster.ts'), 'utf8');
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');

        expect(broadcaster).to.include('postMessageToSurface');
        expect(broadcaster).to.include("targetSurface === surface");
        expect(hostPanel).to.include("this._restoreViewState('chat')");
        expect(hostPanel).to.include('this.postMessageToSurface(targetSurface, msg)');
        expect(hostPanel).to.include("targetSurface })");
        expect(hostPanel).to.include("this._restoreViewState(surface, true)");
        expect(hostPanel).to.include("case 'ready'");
        expect(hostPanel).to.include('this._restoreViewState(sourceSurface, true)');
        expect(hostPanel).to.include('this.sendWorkflowState(send)');
        expect(hostPanel).to.include('this.broadcaster.register(webview, surface)');
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
        const hostPanel = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(hostTypes).to.include("type: 'floatingCardResolved'");
        expect(hostPanel).to.include("card: 'permission'");
        expect(hostPanel).to.include("card: 'write'");
        expect(hostPanel).to.include("card: 'transaction'");
        expect(hostPanel).to.include("card: 'walkthrough'");
        expect(webview).to.include("case 'floatingCardResolved'");
        expect(webview).to.include('function resolveFloatingCard');
        expect(webview).to.include("approveMessageType: 'approveWalkthrough'");
        expect(webview).to.include('scheduleResponsiveWorkspaceLayoutSync()');
        expect(webview).to.include('if (!isCurrentSurface(msg.targetSurface)) break;');
    });
});
