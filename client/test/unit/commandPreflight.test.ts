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

    // ── 跨平台 POSIX 分类（采纳评审 #2：保守、不扩大自动执行面）──
    it('classifies unambiguous read-only POSIX utilities as low risk', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['stat foo.txt', 'cut -d, -f1 data.csv', 'realpath .', 'tree src', 'printenv PATH']) {
            const r = preflightCommand(cmd);
            expect(r.requiresPermission, cmd).to.be.false;
            expect(r.requiresEscalation, cmd).to.be.false;
        }
    });

    it('treats sed -i (in-place edit) as a write, not read-only', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const r = preflightCommand('sed -i s/a/b/ file.txt');
        expect(r.segments[0]!.classification).to.equal('write');
        expect(r.requiresPermission).to.be.true;
    });

    it('escalates find -delete and find -exec to destructive', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const del = preflightCommand('find . -name "*.tmp" -delete');
        expect(del.riskLevel).to.equal(3);
        expect(del.requiresEscalation).to.be.true;

        const exec = preflightCommand('find . -type f -exec rm {} +');
        expect(exec.riskLevel).to.equal(3);
        expect(exec.requiresEscalation).to.be.true;
    });

    it('catches force+recursive rm in any flag order', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['rm -fr build', 'rm -r -f build', 'rm --recursive --force build']) {
            const r = preflightCommand(cmd);
            expect(r.riskLevel, cmd).to.equal(3);
            expect(r.requiresEscalation, cmd).to.be.true;
        }
    });

    it('treats plain rm of a single file as write (permission) but not hard-escalation', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const r = preflightCommand('rm stale.txt');
        expect(r.requiresPermission).to.be.true;
        expect(r.requiresEscalation).to.be.false;
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
