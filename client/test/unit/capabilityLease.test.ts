import { expect } from 'chai';
import { consumeCapabilityLease } from '../../extension/ai/runner/capabilityLease';

describe('CapabilityLease', () => {
    it('grants one scoped invocation and then expires', () => {
        const leases = [{ id: 'once', tool: 'edit_file', paths: ['src'], effectCeiling: 'workspace_write' as const, approvedBy: 'user' as const, remainingInvocations: 1 }];
        expect(consumeCapabilityLease(leases, { tool: 'edit_file', effect: 'workspace_write', targetPaths: ['src/a.ts'], workspaceRoot: 'C:/workspace' })?.id).to.equal('once');
        expect(consumeCapabilityLease(leases, { tool: 'edit_file', effect: 'workspace_write', targetPaths: ['src/a.ts'], workspaceRoot: 'C:/workspace' })).to.equal(undefined);
    });

    it('never grants a different tool, stronger effect, or path outside scope', () => {
        const leases = [{ id: 'read', tool: 'read_file', paths: ['src'], effectCeiling: 'workspace_read' as const, approvedBy: 'policy' as const }];
        expect(consumeCapabilityLease(leases, { tool: 'edit_file', effect: 'workspace_write', targetPaths: ['src/a.ts'], workspaceRoot: 'C:/workspace' })).to.equal(undefined);
        expect(consumeCapabilityLease(leases, { tool: 'read_file', effect: 'workspace_read', targetPaths: ['test/a.ts'], workspaceRoot: 'C:/workspace' })).to.equal(undefined);
    });
});
