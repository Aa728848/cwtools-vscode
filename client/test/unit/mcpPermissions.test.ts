import { expect } from 'chai';
import {
    parseMcpToolName,
    evaluateMcpPermission,
    validateToolAccess,
} from '../../extension/ai/tools/permissions';
import { isMcpServerAllowedForDomain } from '../../extension/ai/mcpCapability';

describe('mcp tool name parsing', () => {
    it('parses dynamic mcp_<server>_<tool> names', () => {
        expect(parseMcpToolName('mcp_filesystem_read_file')).to.deep.equal({ server: 'filesystem', tool: 'read_file' });
        expect(parseMcpToolName('mcp_github_create_issue')).to.deep.equal({ server: 'github', tool: 'create_issue' });
    });

    it('does not treat mcp_call or malformed names as dynamic MCP tools', () => {
        expect(parseMcpToolName('mcp_call')).to.equal(undefined);
        expect(parseMcpToolName('mcp_solo')).to.equal(undefined);
        expect(parseMcpToolName('read_file')).to.equal(undefined);
    });
});

describe('dynamic MCP access validation', () => {
    it('governs dynamic MCP names by the mcp_call registry policy', () => {
        const generalAccess = validateToolAccess('mcp_filesystem_read_file', {
            mode: 'utility',
            domain: 'general',
        });
        expect(generalAccess.allowed).to.equal(true);

        const paradoxAccess = validateToolAccess('mcp_filesystem_read_file', {
            mode: 'build',
            domain: 'paradox',
        });
        expect(paradoxAccess.allowed).to.equal(true);
    });

    it('allows Paradox top-level modes and rejects modes outside the MCP surface', () => {
        for (const mode of ['build', 'plan', 'explore', 'review', 'orchestrator', 'script'] as const) {
            const access = validateToolAccess('mcp_filesystem_read_file', { mode, domain: 'paradox' });
            expect(access.allowed, `mode ${mode}`).to.equal(true);
        }

        const specialist = validateToolAccess('mcp_filesystem_read_file', {
            mode: 'loc_writer',
            domain: 'paradox',
        });
        expect(specialist.allowed).to.equal(false);
        expect(specialist.reason).to.include('mcp_call');
        expect(specialist.reason).to.include('Allowed modes:');
    });

    it('still reports truly unknown tools as unknown', () => {
        const access = validateToolAccess('made_up_tool', { mode: 'general' });
        expect(access.allowed).to.equal(false);
        expect(access.reason).to.include('Unknown tool');
    });
});

describe('MCP capability domains', () => {
    it('keeps legacy servers Paradox-only and requires an explicit General declaration', () => {
        expect(isMcpServerAllowedForDomain(undefined, 'paradox')).to.equal(true);
        expect(isMcpServerAllowedForDomain(undefined, 'general')).to.equal(false);
        expect(isMcpServerAllowedForDomain({ capabilityDomain: 'general' }, 'general')).to.equal(true);
        expect(isMcpServerAllowedForDomain({ capabilityDomain: 'general' }, 'paradox')).to.equal(false);
        expect(isMcpServerAllowedForDomain({ capabilityDomain: 'both' }, 'general')).to.equal(true);
        expect(isMcpServerAllowedForDomain({ capabilityDomain: 'both' }, 'paradox')).to.equal(true);
    });
});

describe('evaluateMcpPermission', () => {
    it('keeps main-agent calls allowed by default when no rules are configured', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', { isSubAgent: false });
        expect(decision.allowed).to.equal(true);
        expect(decision.action).to.equal('allow');
    });

    it('denies sub-agent calls by default with an actionable reason', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', { isSubAgent: true });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('deny');
        expect(decision.reason).to.include('stellarisLanguageServices.ai.permissions');
        expect(decision.reason).to.include('filesystem_read_file');
    });

    it('lets an explicit allow pattern grant sub-agent access', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', {
            isSubAgent: true,
            rules: { 'filesystem_read_*': 'allow' },
        });
        expect(decision.allowed).to.equal(true);
        expect(decision.matchedPattern).to.equal('filesystem_read_*');
    });

    it('does not let an ask pattern grant sub-agent access', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', {
            isSubAgent: true,
            rules: { 'filesystem_*': 'ask' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('ask');
    });

    it('denies main-agent calls matching a deny pattern', () => {
        const decision = evaluateMcpPermission('github', 'delete_repo', {
            isSubAgent: false,
            rules: { 'github_delete_*': 'deny', '*': 'allow' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('deny');
        expect(decision.matchedPattern).to.equal('github_delete_*');
        expect(decision.reason).to.include('Do not retry');
    });

    it('routes ask patterns for the main agent to the interactive approval flow', () => {
        const decision = evaluateMcpPermission('github', 'create_issue', {
            isSubAgent: false,
            rules: { 'github_create_*': 'ask' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('ask');
        expect(decision.reason).to.include('requires approval');
    });

    it('prefers more specific patterns: fewer wildcards win', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', {
            isSubAgent: false,
            rules: { '*': 'deny', 'filesystem_read_file': 'allow' },
        });
        expect(decision.allowed).to.equal(true);
        expect(decision.matchedPattern).to.equal('filesystem_read_file');
    });

    it('prefers longer patterns at equal wildcard count', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', {
            isSubAgent: false,
            rules: { 'filesystem_*': 'allow', 'filesystem_read_*': 'deny' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.matchedPattern).to.equal('filesystem_read_*');
    });

    it('breaks full ties toward the more restrictive action', () => {
        const decision = evaluateMcpPermission('svc', 'op', {
            isSubAgent: false,
            rules: { 'svc_o*': 'allow', 'svc_*p': 'deny' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('deny');
    });

    it('normalizes unknown rule actions to ask (never silently allow)', () => {
        const decision = evaluateMcpPermission('filesystem', 'read_file', {
            isSubAgent: false,
            rules: { 'filesystem_read_file': 'yes-please' },
        });
        expect(decision.allowed).to.equal(false);
        expect(decision.action).to.equal('ask');
    });

    it('escapes regex metacharacters in patterns so they match literally', () => {
        const exact = evaluateMcpPermission('files', 'a.b', {
            isSubAgent: true,
            rules: { 'files_a.b': 'allow' },
        });
        expect(exact.allowed).to.equal(true);

        // '.' in the pattern must be literal: 'files_a.b' must not match 'files_aXb'.
        const widened = evaluateMcpPermission('files', 'aXb', {
            isSubAgent: true,
            rules: { 'files_a.b': 'allow' },
        });
        expect(widened.allowed).to.equal(false);
    });
});
