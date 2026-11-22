import { expect } from 'chai';
import type { GuiVisualCaptureRequestMessage, GuiVisualEvidence } from '../../shared/guiVisualVerification';

const png = 'data:image/png;base64,AA==';

describe('Manager GUI visual review state machine', () => {
    it('caps automatic reviews at two and cleans up the run', async () => {
        const { ManagerGuiPreviewController } = loadControllerModule();
        const injected: GuiVisualEvidence[] = [];
        const webview = {
            postMessage: (message: GuiVisualCaptureRequestMessage) => {
                queueMicrotask(() => {
                    if (message.round === 0) {
                        controller.handleVisualCaptureResponse({
                            type: 'guiVisualCaptureResponse', requestId: message.requestId, runId: message.runId,
                            capture: { dataUrl: png, width: 960, height: 720, frame: { x: 0, y: 0, width: 100, height: 100 } },
                        });
                        return;
                    }
                    const before = message.before;
                    const evidence: GuiVisualEvidence = {
                        requestId: message.requestId, runId: message.runId, file: message.file, round: message.round,
                        status: before ? 'ready' : 'after_only',
                        ...(before ? { before: before.dataUrl, diff: png, metrics: { changedPixels: 1, totalPixels: 10, changeRatio: 0.1 } } : {}),
                        after: png,
                        frame: { x: 0, y: 0, width: 100, height: 100 }, createdAt: Date.now(),
                    };
                    controller.handleVisualCaptureResponse({ type: 'guiVisualCaptureResponse', requestId: message.requestId, runId: message.runId, evidence });
                });
                return Promise.resolve(true);
            },
            asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'file://' + uri.fsPath }),
        };
        const controller = new ManagerGuiPreviewController(
            '/tmp/extension',
            () => undefined,
            () => undefined,
            () => undefined,
            (_runId, evidence) => { injected.push(evidence); },
            () => undefined,
        );
        const internal = controller as any;
        internal.webview = webview;
        internal.loadCurrent = async () => undefined;
        internal.scheduleRefresh = () => undefined;
        internal.postVisualArtifacts = async () => undefined;
        internal.currentFile = 'C:/workspace/interface/test.gui';
        await controller.prepareVisualReview('run-1', undefined, 'topic-1');
        expect((internal.visualRuns.get('run-1') as any).baseline.dataUrl).to.equal(png);

        controller.notifyAgentWrite('run-1', internal.currentFile);
        await wait(520);
        expect(injected).to.have.length(1);
        expect(injected[0]?.status).to.equal('ready');
        expect(injected[0]?.round).to.equal(1);

        controller.notifyAgentWrite('run-1', internal.currentFile);
        await wait(520);
        expect(injected).to.have.length(2);
        expect(injected[1]?.round).to.equal(2);

        controller.notifyAgentWrite('run-1', internal.currentFile);
        await wait(520);
        expect(injected).to.have.length(2);
        controller.finishRun('run-1');
        expect(internal.visualRuns.has('run-1')).to.equal(false);
        controller.handleVisualCaptureResponse({ type: 'guiVisualCaptureResponse', requestId: 'stale', runId: 'run-1' });
        controller.dispose();
    });
});

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function loadControllerModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return {
            window: { onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }) },
            workspace: {
                workspaceFolders: [],
                textDocuments: [],
                onDidChangeTextDocument: () => ({ dispose: () => undefined }),
                onDidSaveTextDocument: () => ({ dispose: () => undefined }),
                asRelativePath: (value: string) => value,
                getConfiguration: () => ({ get: () => undefined }),
            },
            Uri: { file: (value: string) => ({ fsPath: value, scheme: 'file' }) },
        };
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/managerGuiPreview') as typeof import('../../extension/ai/managerGuiPreview');
    } finally {
        moduleLoader._load = originalLoad;
    }
}
