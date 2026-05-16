import * as path from 'path';
import * as fs from 'fs';
import * as vs from 'vscode';

export function getProjectWorkspaceRoot(fallback = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    return folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() !== '.cwtools-ai')?.uri.fsPath
        ?? folders[0]?.uri.fsPath
        ?? fallback;
}

export function getAiStorageRoot(fallbackWorkspaceRoot = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    const aiFolder = folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools-ai');
    if (aiFolder) return aiFolder.uri.fsPath;

    for (const folder of folders) {
        const childAiRoot = path.join(folder.uri.fsPath, '.cwtools-ai');
        if (fs.existsSync(childAiRoot)) return childAiRoot;
    }

    if (fallbackWorkspaceRoot && path.basename(fallbackWorkspaceRoot).toLowerCase() === '.cwtools-ai') {
        return fallbackWorkspaceRoot;
    }

    const workspaceRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    return workspaceRoot ? path.join(workspaceRoot, '.cwtools-ai') : '';
}

export function getAiStorageRootCandidates(fallbackWorkspaceRoot = ''): string[] {
    const roots: string[] = [];
    const add = (value: string) => {
        if (!value) return;
        const resolved = path.resolve(value);
        if (!roots.some(root => path.resolve(root).toLowerCase() === resolved.toLowerCase())) {
            roots.push(value);
        }
    };

    const primary = getAiStorageRoot(fallbackWorkspaceRoot);
    add(primary);

    for (const folder of vs.workspace.workspaceFolders ?? []) {
        if (path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools-ai') continue;
        const childAiRoot = path.join(folder.uri.fsPath, '.cwtools-ai');
        if (fs.existsSync(childAiRoot)) {
            add(childAiRoot);
        }
    }

    const projectRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    if (projectRoot && path.basename(projectRoot).toLowerCase() !== '.cwtools-ai') {
        const legacyProjectRoot = path.join(projectRoot, '.cwtools-ai');
        if (fs.existsSync(legacyProjectRoot)) {
            add(legacyProjectRoot);
        }
    }

    return roots;
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

export function getExistingTopicFilePath(topicId: string | undefined, fileName: string, fallbackWorkspaceRoot = ''): string {
    const candidates = getTopicFileCandidates(topicId, fileName, fallbackWorkspaceRoot);
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0] ?? '';
}

export function getScratchDir(fallbackWorkspaceRoot = ''): string {
    const aiRoot = getAiStorageRoot(fallbackWorkspaceRoot);
    return aiRoot ? path.join(aiRoot, 'scratch') : '';
}
