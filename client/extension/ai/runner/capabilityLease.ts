import * as nodePath from 'path';
import type { ToolEffect } from '../tools/registry';

export interface CapabilityLease {
    id: string;
    tool?: string;
    paths?: string[];
    effectCeiling: ToolEffect;
    approvedBy: 'user' | 'policy' | 'auto_review';
    expiresAtTurnEnd?: boolean;
    remainingInvocations?: number;
}

const EFFECT_RANK: Record<ToolEffect, number> = {
    none: 0, memory: 0, workspace_read: 1, network: 2,
    workspace_write: 3, shell: 4, git: 4, media: 4, mcp: 4, process: 4,
};

function withinLeasePath(target: string, allowed: string, workspaceRoot: string): boolean {
    const targetPath = nodePath.resolve(workspaceRoot, target);
    const allowedPath = nodePath.resolve(workspaceRoot, allowed);
    const relative = nodePath.relative(allowedPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

/** Select and consume one host-issued lease. Static mode/domain/tool policy still runs separately. */
export function consumeCapabilityLease(
    leases: readonly CapabilityLease[] | undefined,
    invocation: { tool: string; effect: ToolEffect; targetPaths: readonly string[]; workspaceRoot: string },
): CapabilityLease | undefined {
    if (!leases?.length) return undefined;
    const lease = leases.find(candidate => {
        if (candidate.remainingInvocations !== undefined && candidate.remainingInvocations <= 0) return false;
        if (candidate.tool && candidate.tool !== invocation.tool) return false;
        if (EFFECT_RANK[invocation.effect] > EFFECT_RANK[candidate.effectCeiling]) return false;
        return !candidate.paths?.length || invocation.targetPaths.every(target =>
            candidate.paths!.some(allowed => withinLeasePath(target, allowed, invocation.workspaceRoot)));
    });
    if (lease?.remainingInvocations !== undefined) lease.remainingInvocations--;
    return lease;
}
