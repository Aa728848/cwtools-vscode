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

    it('does not serialize or restore session-only approvals across durable resume', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        const sessionRule = store.addRule({
            tool: 'run_command',
            cwdScope: 'C:/project',
            commandPrefix: ['npm', 'run', 'deploy'],
            riskMax: 1,
            sessionOnly: true,
        });

        expect(store.serialize()).to.have.lengthOf(1);
        expect(store.serialize({ includeSessionOnly: false })).to.deep.equal([]);

        store.clear();
        expect(store.restore([sessionRule], { allowSessionOnly: false })).to.equal(0);
        expect(store.getRules()).to.deep.equal([]);
    });

    it('treats inline and data-driven executors as opaque and never learns prefixes', () => {
        const { deriveCommandPrefix, hasInlineEvalPayload } = loadPermissionPolicyModule();
        for (const command of [
            'python -c "print(1)"',
            'node -e "console.log(1)"',
            'eval echo',
            'Invoke-Expression $payload',
            'iex $payload',
            'xargs rm',
        ]) {
            expect(hasInlineEvalPayload(command), command).to.equal(true);
            expect(deriveCommandPrefix(command), command).to.deep.equal([]);
        }
        expect(hasInlineEvalPayload('python -c "print(1)"')).to.be.true;
        expect(deriveCommandPrefix('python -c "print(1)"')).to.deep.equal([]);
    });

    it('toPolicyRules converts permission rules to PolicyRule for policyEngine integration', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        store.addRule({
            tool: 'run_command',
            cwdScope: 'C:/project',
            commandPrefix: ['npm', 'test'],
            riskMax: 2,
            sessionOnly: false,
        });
        store.addRule({
            tool: 'edit_file',
            pathGlob: 'common/**',
            cwdScope: 'C:/project',
            riskMax: 2,
            sessionOnly: true,
        });

        const policyRules = store.toPolicyRules();
        expect(policyRules).to.have.lengthOf(2);
        expect(policyRules[0]!.subject).to.equal('bash');
        expect(policyRules[0]!.action).to.equal('allow');
        expect(policyRules[0]!.commandPrefix).to.deep.equal(['npm', 'test']);
        expect(policyRules[0]!.scope).to.equal('global');
        expect(policyRules[0]!.learnedFromApproval).to.be.true;

        expect(policyRules[1]!.subject).to.equal('edit');
        expect(policyRules[1]!.action).to.equal('allow');
        expect(policyRules[1]!.pathGlob).to.equal('common/**');
        expect(policyRules[1]!.scope).to.equal('session');
    });

    it('supports pathGlob file write rules and checks them in isApproved', () => {
        const { PermissionPolicyStore } = loadPermissionPolicyModule();
        const store = PermissionPolicyStore.getInstance();
        store.addRule({
            tool: 'edit_file',
            cwdScope: 'C:/project',
            pathGlob: 'events/**',
            riskMax: 1,
            sessionOnly: true,
        });

        expect(store.isApproved('edit_file', { filePath: 'events/test.txt' }, 1)).to.be.true;
        expect(store.isApproved('edit_file', { filePath: 'common/test.txt' }, 1)).to.be.false;
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
