import { expect } from 'chai';

describe('CommandPreflight Unit Tests', () => {
    it('ranks safe commands as low risk (riskLevel <= 1)', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const result = preflightCommand('npm run compile');
        expect(result.riskLevel).to.be.at.most(1);
        expect(result.requiresEscalation).to.be.false;
    });

    it('identifies dangerous command chains and escalates to riskLevel 2 or 3', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        // Concatenation or redirection
        const resultChain = preflightCommand('npm run compile && rm -rf /');
        expect(resultChain.riskLevel).to.equal(3);
        expect(resultChain.requiresEscalation).to.be.true;

        // Interactive or destructive commands
        const resultRm = preflightCommand('rm -rf client');
        expect(resultRm.riskLevel).to.be.at.least(2);
        expect(resultRm.requiresEscalation).to.be.true;
    });

    it('correctly catches system sensitive operations', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const resultSensitive = preflightCommand('format C:');
        expect(resultSensitive.riskLevel).to.equal(3);
        expect(resultSensitive.requiresEscalation).to.be.true;
    });
});

function loadCommandPreflightModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/commandPreflight') as typeof import('../../extension/ai/runner/commandPreflight');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
