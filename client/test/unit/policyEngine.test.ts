import { expect } from 'chai';
import * as path from 'path';
import {
    buildProfile,
    buildProtectedPathRules,
    clampWriteScopeToRoots,
    matchPathGlob,
    resolvePolicy,
    tokenizeCommand,
    type PermissionProfile,
    type PolicyCallDescriptor,
    type PolicyLayer,
    type PolicyRule,
} from '../../extension/ai/runner/policyEngine';

const WS = path.resolve(__dirname, 'fake-ws');

function descriptor(overrides: Partial<PolicyCallDescriptor>): PolicyCallDescriptor {
    return {
        toolName: 'edit_file',
        subject: 'edit',
        riskLevel: 2,
        workspaceRoot: WS,
        targetPaths: [path.join(WS, 'events', 'a.txt')],
        ...overrides,
    };
}

function profile(overrides: Partial<PermissionProfile> = {}): PermissionProfile {
    return { ...buildProfile('workspace-auto', WS), ...overrides };
}

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'subject' | 'action'>): PolicyRule {
    return overrides as PolicyRule;
}

describe('policyEngine path glob matching', () => {
    it('keeps * within one segment and lets ** cross directories', () => {
        expect(matchPathGlob('events/*.txt', 'events/a.txt')).to.equal(true);
        expect(matchPathGlob('events/*.txt', 'events/sub/a.txt')).to.equal(false);
        expect(matchPathGlob('events/**/*.txt', 'events/sub/deep/a.txt')).to.equal(true);
        expect(matchPathGlob('**/*.pem', 'keys/server.pem')).to.equal(true);
        expect(matchPathGlob('.env', '.env')).to.equal(true);
        expect(matchPathGlob('.env', 'sub/.env')).to.equal(false);
    });

    it('escapes regex metacharacters literally', () => {
        expect(matchPathGlob('a.b/c.txt', 'a.b/c.txt')).to.equal(true);
        expect(matchPathGlob('a.b/c.txt', 'aXb/c.txt')).to.equal(false);
    });
});

describe('policyEngine command tokenization', () => {
    it('splits on whitespace and respects quotes', () => {
        expect(tokenizeCommand('npm test -- --watch')).to.deep.equal(['npm', 'test', '--', '--watch']);
        expect(tokenizeCommand('node "my script.js" arg')).to.deep.equal(['node', 'my script.js', 'arg']);
    });
});

describe('policyEngine approval policy semantics', () => {
    const read = descriptor({ toolName: 'read_file', subject: 'read', riskLevel: 0, targetPaths: [path.join(WS, 'a.txt')] });

    it('on-request: risk 0 allows, risk 2 asks, risk 3 denies', () => {
        expect(resolvePolicy(read, profile()).action).to.equal('allow');
        expect(resolvePolicy(descriptor({ riskLevel: 2 }), profile()).action).to.equal('ask');
        expect(resolvePolicy(descriptor({ riskLevel: 3 }), profile()).action).to.equal('deny');
    });

    it('never: would-be approvals fail closed with a denial, never silently allow', () => {
        const p = profile({ approvalPolicy: 'never' });
        const decision = resolvePolicy(descriptor({ riskLevel: 2 }), p);
        expect(decision.action).to.equal('deny');
        expect(decision.denial).to.not.equal(undefined);
        expect(resolvePolicy(read, p).action).to.equal('allow');
    });

    it('untrusted: write-like subjects deny unless an explicit rule allows', () => {
        const p = profile({ approvalPolicy: 'untrusted' });
        expect(resolvePolicy(descriptor({}), p).action).to.equal('deny');
        const allowed = profile({
            approvalPolicy: 'untrusted',
            rules: [rule({ id: 'r1', subject: 'edit', pathGlob: 'events/**', action: 'allow' })],
        });
        expect(resolvePolicy(descriptor({}), allowed).action).to.equal('allow');
    });

    it('granular: missing rules deny, allow rules run, ask rules ask', () => {
        const p = profile({ approvalPolicy: 'granular' });
        expect(resolvePolicy(read, p).action).to.equal('deny');
        const withRules = profile({
            approvalPolicy: 'granular',
            rules: [
                rule({ id: 'allow-events', subject: 'edit', pathGlob: 'events/**', action: 'allow' }),
                rule({ id: 'ask-common', subject: 'edit', pathGlob: 'common/**', action: 'ask' }),
            ],
        });
        expect(resolvePolicy(descriptor({}), withRules).action).to.equal('allow');
        expect(resolvePolicy(descriptor({ targetPaths: [path.join(WS, 'common', 'x.txt')] }), withRules).action).to.equal('ask');
    });

    it('read-only sandbox denies write-like subjects regardless of rules in tighten-only layers', () => {
        const p = profile({ sandboxMode: 'read-only' });
        expect(resolvePolicy(descriptor({}), p).action).to.equal('deny');
        expect(resolvePolicy(read, p).action).to.equal('allow');
    });
});

describe('policyEngine layer merge and tighten-only', () => {
    it('user layer can loosen the profile default', () => {
        const p = profile({
            rules: [rule({ id: 'u1', subject: 'bash', commandPrefix: ['npm', 'test'], action: 'allow', riskMax: 2 })],
        });
        const d = descriptor({ toolName: 'run_command', subject: 'bash', riskLevel: 2, command: 'npm test -- --watch', targetPaths: [] });
        expect(resolvePolicy(d, p).action).to.equal('allow');
    });

    it('task-scoped policy cannot override a user deny', () => {
        const p = profile({
            rules: [rule({ id: 'u-deny', subject: 'edit', pathGlob: 'common/**', action: 'deny' })],
        });
        const taskLayer: PolicyLayer = {
            id: 'task',
            rules: [rule({ id: 't-allow', subject: 'edit', pathGlob: 'common/**', action: 'allow' })],
        };
        const d = descriptor({ targetPaths: [path.join(WS, 'common', 'x.txt')] });
        const decision = resolvePolicy(d, p, [taskLayer]);
        expect(decision.action).to.equal('deny');
        expect(decision.matchedRules).to.include('u-deny');
    });

    it('tighten-only layers can change allow to deny', () => {
        const modeLayer: PolicyLayer = {
            id: 'mode',
            rules: [rule({ id: 'm-deny', subject: 'read', pathGlob: 'secrets/**', action: 'deny' })],
        };
        const d = descriptor({ toolName: 'read_file', subject: 'read', riskLevel: 0, targetPaths: [path.join(WS, 'secrets', 'x.txt')] });
        expect(resolvePolicy(d, profile(), [modeLayer]).action).to.equal('deny');
    });

    it('approvals layer (user-granted) can loosen mode-layer asks', () => {
        const approvals: PolicyLayer = {
            id: 'approvals',
            rules: [rule({ id: 'a1', subject: 'edit', pathGlob: 'events/**', action: 'allow', learnedFromApproval: true })],
        };
        expect(resolvePolicy(descriptor({}), profile(), [approvals]).action).to.equal('allow');
    });
});

describe('policyEngine specificity', () => {
    it('longer command prefixes beat shorter ones', () => {
        const p = profile({
            rules: [
                rule({ id: 'broad', subject: 'bash', commandPrefix: ['npm'], action: 'deny' }),
                rule({ id: 'narrow', subject: 'bash', commandPrefix: ['npm', 'test'], action: 'allow', riskMax: 2 }),
            ],
        });
        const d = descriptor({ toolName: 'run_command', subject: 'bash', command: 'npm test', targetPaths: [] });
        const decision = resolvePolicy(d, p);
        expect(decision.action).to.equal('allow');
        expect(decision.matchedRules).to.include('narrow');
    });

    it('word-exact prefixes: npm does not match npm-test', () => {
        const p = profile({
            rules: [rule({ id: 'npm', subject: 'bash', commandPrefix: ['npm'], action: 'allow', riskMax: 2 })],
        });
        const d = descriptor({ toolName: 'run_command', subject: 'bash', command: 'npm-test run', targetPaths: [] });
        expect(resolvePolicy(d, p).action).to.equal('ask');
    });

    it('deeper path globs beat shallower ones; deny wins full ties', () => {
        const p = profile({
            rules: [
                rule({ id: 'shallow-allow', subject: 'edit', pathGlob: 'events/**', action: 'allow' }),
                rule({ id: 'deep-deny', subject: 'edit', pathGlob: 'events/core/**', action: 'deny' }),
            ],
        });
        const deep = descriptor({ targetPaths: [path.join(WS, 'events', 'core', 'x.txt')] });
        expect(resolvePolicy(deep, p).action).to.equal('deny');
        const shallow = descriptor({ targetPaths: [path.join(WS, 'events', 'x.txt')] });
        expect(resolvePolicy(shallow, p).action).to.equal('allow');
    });

    it('riskMax caps allow rules but never disables deny rules', () => {
        const p = profile({
            rules: [rule({ id: 'low-only', subject: 'bash', commandPrefix: ['node'], action: 'allow', riskMax: 1 })],
        });
        const d = descriptor({ toolName: 'run_command', subject: 'bash', riskLevel: 2, command: 'node x.js', targetPaths: [] });
        expect(resolvePolicy(d, p).action).to.equal('ask');
    });
});

describe('policyEngine protected paths', () => {
    it('lowers protectedPaths into global-default deny rules', () => {
        const rules = buildProtectedPathRules(['.env', '.git/**']);
        expect(rules.map(r => r.id)).to.include.members(['protected_edit:.env', 'protected_read:.git/**']);
    });

    it('denies protected writes by default and lets explicit user allow override', () => {
        const d = descriptor({ targetPaths: [path.join(WS, '.env')], riskLevel: 2 });
        const decision = resolvePolicy(d, profile());
        expect(decision.action).to.equal('deny');
        expect(decision.matchedRules.join(',')).to.include('protected_edit:.env');

        const loosened = profile({
            rules: [rule({ id: 'u-env', subject: 'edit', pathGlob: '.env', action: 'allow' })],
        });
        expect(resolvePolicy(d, loosened).action).to.equal('allow');
    });

    it('denies key files at any depth', () => {
        const d = descriptor({ targetPaths: [path.join(WS, 'config', 'server.pem')] });
        expect(resolvePolicy(d, profile()).action).to.equal('deny');
    });
});

describe('policyEngine writable roots boundary', () => {
    it('denies edits outside writable roots and no rule can loosen it', () => {
        const outside = path.resolve(WS, '..', 'elsewhere', 'x.txt');
        const p = profile({
            rules: [rule({ id: 'u-all', subject: 'edit', pathGlob: '**', action: 'allow' })],
        });
        const decision = resolvePolicy(descriptor({ targetPaths: [outside] }), p);
        expect(decision.action).to.equal('deny');
        expect(decision.denial?.code).to.equal('outside_writable_roots');
        expect(decision.denial?.approvalPath).to.equal(undefined);
    });
});

describe('policyEngine actionable denials', () => {
    it('includes matched rules, reason, and approval path when escalation is possible', () => {
        const p = profile({
            rules: [rule({ id: 'u-deny', subject: 'edit', pathGlob: 'events/**', action: 'deny' })],
        });
        const decision = resolvePolicy(descriptor({}), p);
        expect(decision.denial?.matchedRules).to.include('u-deny');
        expect(decision.denial?.whyDenied).to.be.a('string').and.not.equal('');
        expect(decision.denial?.approvalPath?.reviewer).to.equal('user');
    });

    it('omits the approval path under approvalPolicy never', () => {
        const decision = resolvePolicy(descriptor({ riskLevel: 2 }), profile({ approvalPolicy: 'never' }));
        expect(decision.denial?.approvalPath).to.equal(undefined);
    });
});

describe('policyEngine MCP and network subjects', () => {
    it('matches mcp rules by server/tool globs with exact beating glob', () => {
        const p = profile({
            rules: [
                rule({ id: 'mcp-broad', subject: 'mcp', mcpServerGlob: 'github', mcpToolGlob: '*', action: 'deny' }),
                rule({ id: 'mcp-exact', subject: 'mcp', mcpServerGlob: 'github', mcpToolGlob: 'get_issue', action: 'allow', riskMax: 2 }),
            ],
        });
        const d = descriptor({ toolName: 'mcp_call', subject: 'mcp', mcpServer: 'github', mcpTool: 'get_issue', targetPaths: [] });
        expect(resolvePolicy(d, p).action).to.equal('allow');
        const other = descriptor({ toolName: 'mcp_call', subject: 'mcp', mcpServer: 'github', mcpTool: 'delete_repo', targetPaths: [] });
        expect(resolvePolicy(other, p).action).to.equal('deny');
    });

    it('matches network rules on hostnames with exact beating wildcard', () => {
        const p = profile({
            rules: [
                rule({ id: 'net-broad', subject: 'network', networkHostGlob: '*.example.com', action: 'deny' }),
                rule({ id: 'net-exact', subject: 'network', networkHostGlob: 'docs.example.com', action: 'allow', riskMax: 2 }),
            ],
        });
        const d = descriptor({ toolName: 'web_fetch', subject: 'network', riskLevel: 1, networkHosts: ['docs.example.com'], targetPaths: [] });
        expect(resolvePolicy(d, p).action).to.equal('allow');
        const blocked = descriptor({ toolName: 'web_fetch', subject: 'network', riskLevel: 1, networkHosts: ['evil.example.com'], targetPaths: [] });
        expect(resolvePolicy(blocked, p).action).to.equal('deny');
    });
});

describe('policyEngine sub-agent write scope clamping', () => {
    it('keeps scopes inside parent roots and rejects escapes', () => {
        const { clamped, rejected } = clampWriteScopeToRoots(
            ['events/a.txt', path.resolve(WS, '..', 'outside.txt'), 'localisation'],
            [WS],
            WS
        );
        expect(clamped).to.deep.equal(['events/a.txt', 'localisation']);
        expect(rejected).to.have.length(1);
    });

    it('passes through undefined scope unchanged', () => {
        expect(clampWriteScopeToRoots(undefined, [WS], WS)).to.deep.equal({ clamped: undefined, rejected: [] });
    });
});
