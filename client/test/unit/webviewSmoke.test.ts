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
        expect(script).to.include('renderArtifactPanel');
        expect(script).to.include('renderTopics');
    });

    it('release bundle exists and is non-empty after compile', () => {
        const bundlePath = path.join(root, 'release/bin/client/webview/chatPanel.js');
        const stat = fs.statSync(bundlePath);

        expect(stat.size).to.be.greaterThan(1000);
    });
});
