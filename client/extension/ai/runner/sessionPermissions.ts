import * as path from 'path';

export type QuickPermissionMode = 'confirm' | 'auto' | 'auto_review' | 'full';

interface SessionPermissionState {
    mode: QuickPermissionMode;
    updatedAt: number;
}

const states = new Map<string, SessionPermissionState>();

function key(workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot || '.');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Quick permission changes are intentionally task/session scoped, never persisted globally. */
export function setSessionPermissionMode(workspaceRoot: string, mode: QuickPermissionMode): void {
    states.set(key(workspaceRoot), { mode, updatedAt: Date.now() });
}

export function getSessionPermissionMode(workspaceRoot: string): QuickPermissionMode | undefined {
    return states.get(key(workspaceRoot))?.mode;
}

export function clearSessionPermissionMode(workspaceRoot: string): void {
    states.delete(key(workspaceRoot));
}

export function sessionFileWriteMode(workspaceRoot: string): 'confirm' | 'auto' | undefined {
    const mode = getSessionPermissionMode(workspaceRoot);
    return mode ? (mode === 'confirm' ? 'confirm' : 'auto') : undefined;
}

export function sessionApprovalsReviewer(workspaceRoot: string): 'user' | 'auto_review' | undefined {
    const mode = getSessionPermissionMode(workspaceRoot);
    if (!mode) return undefined;
    return mode === 'auto_review' ? 'auto_review' : 'user';
}

export function sessionPolicyPreset(workspaceRoot: string): 'workspace-auto' | 'workspace-auto-review' | 'full-access' | undefined {
    const mode = getSessionPermissionMode(workspaceRoot);
    if (!mode) return undefined;
    if (mode === 'auto_review') return 'workspace-auto-review';
    if (mode === 'full') return 'full-access';
    return 'workspace-auto';
}

export function isSessionFullAccess(workspaceRoot: string): boolean {
    return getSessionPermissionMode(workspaceRoot) === 'full';
}

/** Opaque commands in Auto Review must reach the reviewer before learned policy rules. */
export function shouldReviewOpaqueCommandBeforePolicy(
    reviewerMode: string | undefined,
    tool: string,
    opaqueExecution: boolean,
    isEscalationRequest: boolean,
): boolean {
    return reviewerMode === 'auto_review'
        && tool === 'run_command'
        && opaqueExecution
        && !isEscalationRequest;
}
