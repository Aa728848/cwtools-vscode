import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GuiEvidenceHost } from '../../extension/guiEvidence';
import type { GuiPanel } from '../../extension/guiPanel';
import type { GuiVisualEvidence } from '../../shared/guiVisualVerification';

const PNG = 'data:image/png;base64,' + Buffer.from('png-fixture').toString('base64');

describe('GUI evidence host', () => {
    let root = '';
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-gui-evidence-')); });
    afterEach(() => {
        for (const entry of fs.readdirSync(root)) {
            for (const name of ['before.png', 'after.png', 'diff.png', 'metadata.json']) {
                try { fs.rmSync(path.join(root, entry, name), { force: true }); } catch { /* ignored */ }
            }
            try { fs.rmdirSync(path.join(root, entry)); } catch { /* ignored */ }
        }
        try { fs.rmdirSync(root); } catch { /* ignored */ }
    });

    it('stores bounded After-only and Before/After/Diff artifacts', async () => {
        const host = new GuiEvidenceHost(root);
        let evidence: GuiVisualEvidence = {
            requestId: 'one', runId: 'mcp', file: 'test.gui', round: 0,
            status: 'after_only', after: PNG, frame: { x: 0, y: 0, width: 10, height: 10 }, createdAt: 1,
        };
        const panel = { captureVisual: async () => evidence } as unknown as GuiPanel;
        const first = await host.capture(panel, path.join(root, 'test.gui'));
        expect(first.status).to.equal('after_only');
        expect(fs.existsSync((first.artifacts as Record<string, string>).after!)).to.equal(true);

        evidence = {
            ...evidence,
            status: 'ready', before: PNG, diff: PNG,
            metrics: { changedPixels: 1, totalPixels: 1, changeRatio: 1 },
        };
        const second = await host.capture(panel, path.join(root, 'test.gui'), String(first.artifactId));
        expect(second.status).to.equal('ready');
        expect(fs.existsSync((second.artifacts as Record<string, string>).before!)).to.equal(true);
        expect(fs.existsSync((second.artifacts as Record<string, string>).diff!)).to.equal(true);
        let rejection: unknown;
        try { await host.capture(panel, path.join(root, 'other.gui'), String(first.artifactId)); }
        catch (error) { rejection = error; }
        expect(rejection).to.be.instanceOf(Error);
        expect(String(rejection)).to.include('another GUI file');
    });
});
