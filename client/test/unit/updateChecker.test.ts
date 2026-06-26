import { expect } from 'chai';

const commandCalls: Array<{ command: string; argument: unknown }> = [];
const cliCalls: Array<{ command: string; args: string[] }> = [];

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
        getExtension: () => ({ extensionPath: 'C:\\Users\\A\\.vscode\\extensions\\eddy.eddy-stellaris-cwt-2.6.7' }),
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
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    delete require.cache[require.resolve('../../extension/updateChecker')];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        if (request === 'child_process') return childProcessStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/updateChecker') as typeof import('../../extension/updateChecker');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { installDownloadedUpdate } = loadUpdateChecker();

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

    it('reinstalls a same-version VSIX through the external CLI', async () => {
        await installDownloadedUpdate('C:\\Temp\\cwtools-update.vsix', 'eddy.eddy-stellaris-cwt', true);

        expect(commandCalls).to.deep.equal([]);
        expect(cliCalls).to.have.length(2);
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).to.include('--uninstall-extension');
        expect(`${cliCalls[0]!.command} ${cliCalls[0]!.args.join(' ')}`).to.include('eddy.eddy-stellaris-cwt');
        expect(`${cliCalls[1]!.command} ${cliCalls[1]!.args.join(' ')}`).to.include('--install-extension');
        expect(`${cliCalls[1]!.command} ${cliCalls[1]!.args.join(' ')}`).to.include('C:\\Temp\\cwtools-update.vsix');
        expect(`${cliCalls[1]!.command} ${cliCalls[1]!.args.join(' ')}`).to.include('--force');
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
