import { expect } from 'chai';

const commandCalls: Array<{ command: string; argument: unknown }> = [];

const vscodeStub = {
    commands: {
        executeCommand: async (command: string, argument: unknown) => {
            commandCalls.push({ command, argument });
        },
    },
    Uri: {
        file: (filePath: string) => ({ fsPath: filePath }),
    },
};

function loadUpdateChecker() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
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
    beforeEach(() => {
        commandCalls.length = 0;
    });

    it('uninstalls the current extension before installing a same-version VSIX', async () => {
        await installDownloadedUpdate('C:\\Temp\\cwtools-update.vsix', 'eddy.eddy-stellaris-cwt', true);

        expect(commandCalls).to.deep.equal([
            {
                command: 'workbench.extensions.uninstallExtension',
                argument: 'eddy.eddy-stellaris-cwt',
            },
            {
                command: 'workbench.extensions.installExtension',
                argument: { fsPath: 'C:\\Temp\\cwtools-update.vsix' },
            },
        ]);
    });

    it('installs a newer-version VSIX without uninstalling first', async () => {
        await installDownloadedUpdate('C:\\Temp\\cwtools-update.vsix', 'eddy.eddy-stellaris-cwt', false);

        expect(commandCalls).to.deep.equal([
            {
                command: 'workbench.extensions.installExtension',
                argument: { fsPath: 'C:\\Temp\\cwtools-update.vsix' },
            },
        ]);
    });
});
