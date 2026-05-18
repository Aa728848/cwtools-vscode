import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('webview smoke checks', () => {
    const root = path.resolve(__dirname, '../../..');

    it('chat webview source exposes expected bootstrap controls', () => {
        const html = fs.readFileSync(path.join(root, 'client/extension/ai/chatHtml.ts'), 'utf8');
        const script = fs.readFileSync(path.join(root, 'client/webview/chatPanel.ts'), 'utf8');

        expect(html).to.include('id="chatArea"');
        expect(html).to.include('id="modeSel"');
        expect(html).to.include('id="composerAddBtn"');
        expect(html).to.include('id="quickModelTrigger"');
        expect(html).to.include('id="btnWorkspace"');
        expect(html).to.include('data-composer-action="workflows"');
        expect(html).to.include('id="artifactDrawer"');
        expect(script).to.include("case 'workflowList'");
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
            '.md-codeblock',
        ]) {
            expect(css).to.include(selector);
        }
        for (const id of ['chatArea', 'input', 'sendBtn', 'slashPopup', 'artifactDrawer', 'topicsPanel', 'btnWorkspace']) {
            expect(html).to.include(`id="${id}"`);
        }
        expect(script).to.include('IntersectionObserver');
        expect(script).to.include('enhanceCodeBlocks');
        expect(script).to.include('enhanceTaskLists');
    });

    it('release bundle exists and is non-empty after compile', () => {
        const bundlePath = path.join(root, 'release/bin/client/webview/chatPanel.js');
        const stat = fs.statSync(bundlePath);

        expect(stat.size).to.be.greaterThan(1000);
    });

    it('agent manager shell wiring exists', () => {
        const managerHtml = fs.readFileSync(path.join(root, 'client/extension/ai/agentManagerHtml.ts'), 'utf8');
        const managerCss = fs.readFileSync(path.join(root, 'client/webview/agentManager.css'), 'utf8');
        const managerEntry = fs.readFileSync(path.join(root, 'client/webview/agentManager.ts'), 'utf8');
        const host = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');

        expect(managerHtml).to.include("bodyClass: 'chat-empty agent-manager-shell'");
        expect(managerHtml).to.include("scriptName: 'agentManager.js'");
        expect(managerCss).to.include('body.agent-manager-shell');
        expect(managerCss).to.include('.manager-overview');
        expect(managerCss).to.include('.manager-inspector-tabs');
        expect(managerCss).to.include('.topics-panel');
        expect(managerCss).to.include('.artifact-drawer');
        expect(managerEntry).to.not.include("import './chatPanel'");
        expect(managerEntry).to.include("import type { ManagerSnapshotMessage");
        expect(managerEntry).to.include("type: 'requestManagerSnapshot'");
        expect(managerEntry).to.include("case 'managerSnapshot'");
        expect(managerEntry).to.include("case 'orchestratorProgress'");
        expect(host).to.include("case 'requestManagerSnapshot'");
        expect(host).to.include("type: 'managerSnapshot'");
        expect(host).to.include("case 'pinTopic'");
        expect(host).to.include("case 'setTopicWorkspace'");
    });

    it('agent manager release bundle exists and is non-empty after compile', () => {
        const bundlePath = path.join(root, 'release/bin/client/webview/agentManager.js');
        const stat = fs.statSync(bundlePath);

        expect(stat.size).to.be.greaterThan(1000);
    });
});
