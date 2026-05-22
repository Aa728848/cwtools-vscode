import { expect } from 'chai';

describe('PermissionPolicyStore Unit Tests', () => {
    beforeEach(() => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        PermissionPolicyStore.getInstance().clear();
    });

    it('correctly matches commands using absolute paths and path.relative topology', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        
        // Add a rule allowing command under C:/project/src
        store.addRule({
            tool: 'run_command',
            cwdScope: 'C:/project/src',
            commandPrefix: ['npm', 'run', 'compile'],
            riskMax: 1,
            sessionOnly: true
        });

        // Exact match
        expect(store.isApproved('run_command', { CommandLine: 'npm run compile', Cwd: 'C:/project/src' }, 1)).to.be.true;

        // Subdirectory match (C:/project/src/components is under C:/project/src)
        expect(store.isApproved('run_command', { CommandLine: 'npm run compile', Cwd: 'C:/project/src/components' }, 1)).to.be.true;

        // Directory boundary prefix bypass defense (C:/project/src-malicious is NOT under C:/project/src)
        expect(store.isApproved('run_command', { CommandLine: 'npm run compile', Cwd: 'C:/project/src-malicious' }, 1)).to.be.false;

        // Parent directory mismatch (C:/project is NOT under C:/project/src)
        expect(store.isApproved('run_command', { CommandLine: 'npm run compile', Cwd: 'C:/project' }, 1)).to.be.false;
    });

    it('enforces riskMax strictly to prevent unauthorized escalation', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        
        store.addRule({
            tool: 'run_command',
            cwdScope: 'C:/project',
            commandPrefix: ['npm', 'run', 'deploy'],
            riskMax: 1,
            sessionOnly: true
        });

        // Safe command within limit
        expect(store.isApproved('run_command', { CommandLine: 'npm run deploy', Cwd: 'C:/project' }, 1)).to.be.true;

        // Escalation attempt with high risk level (2 > riskMax 1) -> must reject
        expect(store.isApproved('run_command', { CommandLine: 'npm run deploy', Cwd: 'C:/project' }, 2)).to.be.false;
    });

    it('allows high-risk (riskLevel=2) commands when riskMax is configured to 2', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        
        store.addRule({
            tool: 'run_command',
            cwdScope: 'C:/project',
            commandPrefix: ['python'],
            riskMax: 2,
            sessionOnly: true
        });

        // Exact match with riskLevel=2 should pass
        expect(store.isApproved('run_command', { CommandLine: 'python build.py', Cwd: 'C:/project' }, 2)).to.be.true;

        // Command with higher riskLevel than rule's riskMax (e.g. 3) should still fail
        expect(store.isApproved('run_command', { CommandLine: 'python build.py', Cwd: 'C:/project' }, 3)).to.be.false;
    });
});

function loadPermissionPolicyModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/permissionPolicy') as typeof import('../../extension/ai/runner/permissionPolicy');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
