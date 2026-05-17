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
        expect(html).to.include('id="workflowSel"');
        expect(html).to.include('id="artifactDrawer"');
        expect(script).to.include("case 'workflowList'");
        expect(script).to.include('renderWorkflowSelector');
        expect(script).to.include('renderArtifactPanel');
        expect(script).to.include('renderTopics');
        expect(script).to.include('renderArtifactDrawer');
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
            '.slash-popup',
            '.artifact-drawer',
            '.topics-panel',
            '.subagent-fullscreen-view',
            '.annotatable-plan',
            '.md-codeblock',
        ]) {
            expect(css).to.include(selector);
        }
        for (const id of ['chatArea', 'input', 'sendBtn', 'slashPopup', 'artifactDrawer', 'topicsPanel']) {
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
});
