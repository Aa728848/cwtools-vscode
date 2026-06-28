import { expect } from 'chai';
import { createRequire } from 'module';
import * as path from 'path';

const commandCalls: Array<{ command: string; argument: unknown }> = [];
const cliCalls: Array<{ command: string; args: string[] }> = [];
const testRequire = createRequire(path.join(process.cwd(), 'client/test/unit/updateChecker.test.ts'));

const vscodeStub = {
    commands: {
        executeCommand: async (command: string, argument: unknown) => {
            commandCalls.push({ command, argument });
        },
    },
    env: {
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
    },
    extensions: {
        getExtension: () => ({ extensionPath: 'C:\\Users\\A\\.vscode\\extensions\\eddy.eddy-stellaris-cwt-2.7.0' }),
    },
    Uri: {
        file: (filePath: string) => ({ fsPath: filePath }),
    },
};

const childProcessStub = {
    execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        cliCalls.push({ command, args });
        callback(null, 'ok', '');
    },
};

function loadUpdateChecker() {
    const moduleLoader = testRequire('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const updateCheckerPath = testRequire.resolve('../../extension/updateChecker');
    delete testRequire.cache[updateCheckerPath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        if (request === 'child_process') return childProcessStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return testRequire('../../extension/updateChecker') as typeof import('../../extension/updateChecker');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { installDownloadedUpdate, extractVsixVersion, selectReleaseVsixAsset } = loadUpdateChecker();

describe('Update checker release metadata', () => {
    it('uses the VSIX asset version when the release tag is stale', () => {
        const selected = selectReleaseVsixAsset({
            tag_name: '2.7.0',
            published_at: '2026-06-28T04:07:05Z',
            assets: [
                {
                    name: 'eddy-stellaris-cwt-2.7.1.vsix',
                    updated_at: '2026-06-28T14:21:37Z',
                    browser_download_url: 'https://example.test/eddy-stellaris-cwt-2.7.1.vsix',
                },
            ],
        });

        expect(selected).to.deep.equal({
            name: 'eddy-stellaris-cwt-2.7.1.vsix',
            version: '2.7.1',
            downloadUrl: 'https://example.test/eddy-stellaris-cwt-2.7.1.vsix',
            updatedAt: '2026-06-28T14:21:37Z',
        });
    });

    it('selects the newest VSIX asset by parsed package version', () => {
        const selected = selectReleaseVsixAsset({
            tag_name: '2.7.0',
            assets: [
                {
                    name: 'eddy-stellaris-cwt-2.7.1.vsix',
                    updated_at: '2026-06-28T14:21:37Z',
                    browser_download_url: 'https://example.test/2.7.1.vsix',
                },
                {
                    name: 'eddy-stellaris-cwt-2.7.2.vsix',
                    updated_at: '2026-06-28T14:22:37Z',
                    browser_download_url: 'https://example.test/2.7.2.vsix',
                },
            ],
        });

        expect(selected?.version).to.equal('2.7.2');
        expect(selected?.downloadUrl).to.equal('https://example.test/2.7.2.vsix');
    });

    it('falls back to the release tag for unversioned VSIX asset names', () => {
        const selected = selectReleaseVsixAsset({
            tag_name: 'v2.7.0',
            published_at: '2026-06-28T04:07:05Z',
            assets: [
                {
                    name: 'eddy-stellaris-cwt.vsix',
                    browser_download_url: 'https://example.test/eddy-stellaris-cwt.vsix',
                },
            ],
        });

        expect(selected?.version).to.equal('2.7.0');
        expect(selected?.updatedAt).to.equal('2026-06-28T04:07:05Z');
    });

    it('extracts the rightmost semver from VSIX asset names', () => {
        expect(extractVsixVersion('eddy-stellaris-cwt-2.7.1.vsix')).to.equal('2.7.1');
        expect(extractVsixVersion('eddy-1.0.0-stellaris-cwt-2.7.1.vsix')).to.equal('2.7.1');
        expect(extractVsixVersion('eddy-stellaris-cwt.zip')).to.equal(undefined);
    });
});

describe('Update checker installation', () => {
    const originalVsCodeCli = process.env.VSCODE_CLI;

    beforeEach(() => {
        commandCalls.length = 0;
        cliCalls.length = 0;
        process.env.VSCODE_CLI = 'code';
    });

    after(() => {
        if (originalVsCodeCli === undefined) {
            delete process.env.VSCODE_CLI;
        } else {
            process.env.VSCODE_CLI = originalVsCodeCli;
        }
    });

    it('reinstalls a same-version VSIX through one forced external CLI install', async () => {
        await installDownloadedUpdate('C:\\Temp\\cwtools-update.vsix', 'eddy.eddy-stellaris-cwt', true);

        expect(commandCalls).to.deep.equal([]);
        expect(cliCalls).to.have.length(1);
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).to.include('--install-extension');
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).to.include('C:\\Temp\\cwtools-update.vsix');
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).to.include('--force');
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).not.to.include('--uninstall-extension');
    });

    it('installs a newer-version VSIX without uninstalling first', async () => {
        await installDownloadedUpdate('C:\\Temp\\cwtools-update.vsix', 'eddy.eddy-stellaris-cwt', false);

        expect(commandCalls).to.deep.equal([
            {
                command: 'workbench.extensions.installExtension',
                argument: { fsPath: 'C:\\Temp\\cwtools-update.vsix' },
            },
        ]);
        expect(cliCalls).to.deep.equal([]);
    });
});
