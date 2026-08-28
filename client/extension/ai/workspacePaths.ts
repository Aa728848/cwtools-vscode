import * as path from 'path';
import * as fs from 'fs';
import * as vs from 'vscode';

/**
 * Canonical key for file-path- keyed state (locks, failure counters, guard
 * signatures). Resolves relative paths against `base` (defaults to the
 * extension host cwd, matching path.resolve), normalizes separators, and
 * lowercases on win32 so `common/a.txt`, `./common/A.TXT` and the absolute
 * form share one lock/counter entry.
 */
export function canonicalPathKey(filePath: string, base?: string): string {
    let resolved: string;
    try {
        resolved = base && !path.isAbsolute(filePath) ? path.resolve(base, filePath) : path.resolve(filePath);
    } catch {
        resolved = filePath;
    }
    resolved = resolved.replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

let privateAgentStorageRoot = '';
let workspaceCacheStorageRoot = '';

/** Configure the extension-owned directory used for private Agent state. */
export function configurePrivateAgentStorage(storageRoot: string | undefined): void {
    privateAgentStorageRoot = storageRoot ? path.resolve(storageRoot) : '';
}

/** Configure the extension-owned directory used for per-workspace caches. */
export function configureWorkspaceCacheStorage(storageRoot: string | undefined): void {
    workspaceCacheStorageRoot = storageRoot ? path.resolve(storageRoot) : '';
}

/**
 * Per-workspace cache root (symbol index and similar regenerable caches).
 * Falls back to the canonical project directory until activation supplies
 * ExtensionContext.storageUri, which keeps unit tests deterministic.
 */
export function getWorkspaceCacheRoot(fallbackWorkspaceRoot = ''): string {
    return workspaceCacheStorageRoot || getAiStorageRoot(fallbackWorkspaceRoot);
}

/**
 * Private state falls back to the canonical project directory until activation
 * supplies ExtensionContext.storageUri. This keeps unit tests
 * deterministic without mixing new private data with project artifacts.
 */
export function getPrivateAiStorageRoot(fallbackWorkspaceRoot = ''): string {
    return privateAgentStorageRoot || getAiStorageRoot(fallbackWorkspaceRoot);
}

export function getPrivateTopicStorageDir(topicId: string | undefined, fallbackWorkspaceRoot = ''): string {
    const safeTopicId = (topicId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!privateAgentStorageRoot) return getTopicStorageDir(safeTopicId, fallbackWorkspaceRoot);
    return path.join(privateAgentStorageRoot, 'topics', safeTopicId);
}

/** The single configured private topic location. */
export function getPrivateTopicStorageDirCandidates(topicId: string | undefined, fallbackWorkspaceRoot = ''): string[] {
    const topicDir = getPrivateTopicStorageDir(topicId, fallbackWorkspaceRoot);
    return topicDir ? [topicDir] : [];
}

/** The configured directory whose children are topic IDs. */
export function getPrivateTopicRoot(fallbackWorkspaceRoot = ''): string {
    return privateAgentStorageRoot
        ? path.join(privateAgentStorageRoot, 'topics')
        : getAiStorageRoot(fallbackWorkspaceRoot);
}

export function getProjectWorkspaceRoots(): string[] {
    const folders = vs.workspace.workspaceFolders ?? [];
    return folders.filter(folder => {
        const name = path.basename(folder.uri.fsPath).toLowerCase();
        return name !== '.cwtools';
    }).map(folder => folder.uri.fsPath);
}

export function getProjectWorkspaceRoot(fallback = ''): string {
    const roots = getProjectWorkspaceRoots();
    const activePath = typeof vs.window?.activeTextEditor?.document?.uri?.fsPath === 'string'
        ? vs.window.activeTextEditor.document.uri.fsPath
        : undefined;
    if (activePath) {
        const activeRoot = roots.find(root => {
            const relative = path.relative(root, activePath);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });
        if (activeRoot) return activeRoot;
    }
    return roots[0]
        ?? vs.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? fallback;
}

/** Resolve a user/model path against an explicit multi-root folder when present. */
export function resolveProjectWorkspacePath(refPath: string, fallback = ''): string | undefined {
    const roots = getProjectWorkspaceRoots();
    const absolute = path.resolve(refPath);
    if (path.isAbsolute(refPath)) {
        return roots.some(root => {
            const relative = path.relative(root, absolute);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        }) ? absolute : undefined;
    }
    const normalized = refPath.replace(/\\/g, '/');
    const separator = normalized.indexOf('/');
    if (separator > 0) {
        const qualifier = normalized.slice(0, separator).toLowerCase();
        const matched = (vs.workspace.workspaceFolders ?? []).find(folder =>
            String(folder.name ?? path.basename(folder.uri.fsPath)).toLowerCase() === qualifier
            || path.basename(folder.uri.fsPath).toLowerCase() === qualifier);
        if (matched) {
            const resolved = path.resolve(matched.uri.fsPath, normalized.slice(separator + 1));
            const relative = path.relative(matched.uri.fsPath, resolved);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
                ? resolved
                : undefined;
        }
    }
    const root = getProjectWorkspaceRoot(fallback);
    if (!root) return undefined;
    const resolved = path.resolve(root, refPath);
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
        ? resolved
        : undefined;
}

export function getAiStorageRoot(fallbackWorkspaceRoot = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    const aiFolder = folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools');
    if (aiFolder) return aiFolder.uri.fsPath;

    for (const folder of folders) {
        const name = path.basename(folder.uri.fsPath).toLowerCase();
        if (name === '.cwtools') continue;
        const childAiRoot = path.join(folder.uri.fsPath, '.cwtools');
        if (fs.existsSync(childAiRoot)) return childAiRoot;
    }

    if (fallbackWorkspaceRoot) {
        const fallbackName = path.basename(fallbackWorkspaceRoot).toLowerCase();
        if (fallbackName === '.cwtools') return fallbackWorkspaceRoot;
    }

    const workspaceRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    return workspaceRoot ? path.join(workspaceRoot, '.cwtools') : '';
}

export function getAiStorageRootCandidates(fallbackWorkspaceRoot = ''): string[] {
    const primary = getAiStorageRoot(fallbackWorkspaceRoot);
    return primary ? [primary] : [];
}

export function getTopicStorageDir(topicId: string | undefined, fallbackWorkspaceRoot = ''): string {
    const safeTopicId = (topicId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const aiRoot = getAiStorageRoot(fallbackWorkspaceRoot);
    return aiRoot ? path.join(aiRoot, safeTopicId) : '';
}

export function getTopicStorageDirCandidates(topicId: string | undefined, fallbackWorkspaceRoot = ''): string[] {
    const safeTopicId = (topicId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return getAiStorageRootCandidates(fallbackWorkspaceRoot).map(root => path.join(root, safeTopicId));
}

export function getTopicFileCandidates(topicId: string | undefined, fileName: string, fallbackWorkspaceRoot = ''): string[] {
    return getTopicStorageDirCandidates(topicId, fallbackWorkspaceRoot).map(dir => path.join(dir, fileName));
}

/** Private topic file candidates from the single configured storage root. */
export function getPrivateTopicFileCandidates(topicId: string | undefined, fileName: string, fallbackWorkspaceRoot = ''): string[] {
    return getPrivateTopicStorageDirCandidates(topicId, fallbackWorkspaceRoot).map(dir => path.join(dir, fileName));
}

export function getExistingTopicFilePath(topicId: string | undefined, fileName: string, fallbackWorkspaceRoot = ''): string {
    const candidates = getTopicFileCandidates(topicId, fileName, fallbackWorkspaceRoot);
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0] ?? '';
}

export function getExistingPrivateTopicFilePath(topicId: string | undefined, fileName: string, fallbackWorkspaceRoot = ''): string {
    const candidates = getPrivateTopicFileCandidates(topicId, fileName, fallbackWorkspaceRoot);
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0] ?? '';
}

export function getScratchDir(fallbackWorkspaceRoot = ''): string {
    return getTopicScratchDir('default', fallbackWorkspaceRoot);
}

export function getTopicScratchDir(topicId: string | undefined, fallbackWorkspaceRoot = ''): string {
    const topicDir = getTopicStorageDir(topicId, fallbackWorkspaceRoot);
    return topicDir ? path.join(topicDir, 'scratch') : '';
}

export function getPrivateTopicScratchDir(topicId: string | undefined, fallbackWorkspaceRoot = ''): string {
    const topicDir = getPrivateTopicStorageDir(topicId, fallbackWorkspaceRoot);
    return topicDir ? path.join(topicDir, 'scratch') : '';
}
