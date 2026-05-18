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
});
