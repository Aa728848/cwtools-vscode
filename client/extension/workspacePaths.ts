import * as path from 'path';
import * as vs from 'vscode';
import { isPathInsideOrEqual } from './pathScope';

/** Canonical case-normalized key for workspace file locks and cache identity. */
export function canonicalPathKey(filePath: string, base?: string): string {
    let resolved: string;
    try { resolved = base && !path.isAbsolute(filePath) ? path.resolve(base, filePath) : path.resolve(filePath); }
    catch { resolved = filePath; }
    resolved = resolved.replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

let workspaceCacheStorageRoot = '';

export function configureWorkspaceCacheStorage(storageRoot: string | undefined): void {
    workspaceCacheStorageRoot = storageRoot ? path.resolve(storageRoot) : '';
}

export function getWorkspaceCacheRoot(fallbackWorkspaceRoot = ''): string {
    return workspaceCacheStorageRoot || getCwtoolsStorageRoot(fallbackWorkspaceRoot);
}

export function getProjectWorkspaceRoots(): string[] {
    return (vs.workspace.workspaceFolders ?? [])
        .filter(folder => path.basename(folder.uri.fsPath).toLowerCase() !== '.cwtools')
        .map(folder => folder.uri.fsPath);
}

export function getProjectWorkspaceRoot(fallback = ''): string {
    const roots = getProjectWorkspaceRoots();
    const activePath = vs.window?.activeTextEditor?.document?.uri?.fsPath;
    if (activePath) {
        const activeRoot = roots.find(root => isPathInsideOrEqual(activePath, root));
        if (activeRoot) return activeRoot;
    }
    return roots[0] ?? vs.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fallback;
}

export function resolveProjectWorkspacePath(refPath: string, fallback = ''): string | undefined {
    const roots = getProjectWorkspaceRoots();
    const absolute = path.resolve(refPath);
    if (path.isAbsolute(refPath)) return roots.some(root => isPathInsideOrEqual(absolute, root)) ? absolute : undefined;
    const normalized = refPath.replace(/\\/g, '/');
    const separator = normalized.indexOf('/');
    if (separator > 0) {
        const qualifier = normalized.slice(0, separator).toLowerCase();
        const matched = (vs.workspace.workspaceFolders ?? []).find(folder =>
            String(folder.name ?? path.basename(folder.uri.fsPath)).toLowerCase() === qualifier
            || path.basename(folder.uri.fsPath).toLowerCase() === qualifier);
        if (matched) {
            const resolved = path.resolve(matched.uri.fsPath, normalized.slice(separator + 1));
            return isPathInsideOrEqual(resolved, matched.uri.fsPath) ? resolved : undefined;
        }
    }
    const root = getProjectWorkspaceRoot(fallback);
    if (!root) return undefined;
    const resolved = path.resolve(root, refPath);
    return isPathInsideOrEqual(resolved, root) ? resolved : undefined;
}

/** Canonical project-owned .cwtools directory used for profiles and knowledge. */
export function getCwtoolsStorageRoot(fallbackWorkspaceRoot = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    const direct = folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools');
    if (direct) return direct.uri.fsPath;
    const workspaceRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    if (workspaceRoot) {
        return path.basename(workspaceRoot).toLowerCase() === '.cwtools' ? workspaceRoot : path.join(workspaceRoot, '.cwtools');
    }
    if (fallbackWorkspaceRoot) {
        return path.basename(fallbackWorkspaceRoot).toLowerCase() === '.cwtools'
            ? fallbackWorkspaceRoot
            : path.join(fallbackWorkspaceRoot, '.cwtools');
    }
    return '';
}
