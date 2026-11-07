import * as path from 'path';

export type QuickPermissionMode = 'confirm' | 'auto';

interface SessionPermissionState {
    mode: QuickPermissionMode;
    updatedAt: number;
}

const states = new Map<string, SessionPermissionState>();

function key(workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot || '.');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Quick file-write mode changes are intentionally task/session scoped, never persisted globally. */
export function setSessionPermissionMode(workspaceRoot: string, mode: QuickPermissionMode): void {
    states.set(key(workspaceRoot), { mode: mode === 'confirm' ? 'confirm' : 'auto', updatedAt: Date.now() });
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
