import * as path from 'path';
import * as fs from 'fs';
import * as vs from 'vscode';

let privateAgentStorageRoot = '';

/** Configure the extension-owned directory used for private Agent state. */
export function configurePrivateAgentStorage(storageRoot: string | undefined): void {
    privateAgentStorageRoot = storageRoot ? path.resolve(storageRoot) : '';
}

/**
 * Private state falls back to the legacy project directory until activation
 * supplies ExtensionContext.storageUri. This keeps unit tests and migrations
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

/** Private location first, followed by project locations used by older builds. */
export function getPrivateTopicStorageDirCandidates(topicId: string | undefined, fallbackWorkspaceRoot = ''): string[] {
    const candidates: string[] = [];
    const add = (value: string) => {
        if (!value) return;
        const resolved = path.resolve(value);
        if (!candidates.some(candidate => path.resolve(candidate).toLowerCase() === resolved.toLowerCase())) {
            candidates.push(value);
        }
    };
    add(getPrivateTopicStorageDir(topicId, fallbackWorkspaceRoot));
    for (const legacy of getTopicStorageDirCandidates(topicId, fallbackWorkspaceRoot)) add(legacy);
    return candidates;
}

/** Directories whose children are topic IDs, private first then legacy. */
export function getPrivateTopicRootCandidates(fallbackWorkspaceRoot = ''): string[] {
    const roots: string[] = [];
    const add = (value: string) => {
        if (!value) return;
        const resolved = path.resolve(value);
        if (!roots.some(root => path.resolve(root).toLowerCase() === resolved.toLowerCase())) roots.push(value);
    };
    if (privateAgentStorageRoot) add(path.join(privateAgentStorageRoot, 'topics'));
    for (const legacy of getAiStorageRootCandidates(fallbackWorkspaceRoot)) add(legacy);
    return roots;
}

/** Copy legacy private runtime data without moving project-shareable artifacts. */
export function migrateLegacyPrivateAgentState(fallbackWorkspaceRoot = ''): number {
    if (!privateAgentStorageRoot) return 0;
    let copied = 0;
    const privateNames = new Set([
        'runs', 'threads', 'goals', 'resume_state.json', 'resume_state.json.bak',
        '.cwtools-ai-memory.md', 'memory.json',
    ]);
    for (const legacyRoot of getAiStorageRootCandidates(fallbackWorkspaceRoot)) {
        if (!fs.existsSync(legacyRoot)) continue;
        const topics = fs.readdirSync(legacyRoot, { withFileTypes: true });
        for (const topic of topics) {
            if (!topic.isDirectory() || ['project', 'workflows'].includes(topic.name)) continue;
            const sourceTopic = path.join(legacyRoot, topic.name);
            const targetTopic = path.join(privateAgentStorageRoot, 'topics', topic.name);
            for (const name of privateNames) {
                const source = path.join(sourceTopic, name);
                const target = path.join(targetTopic, name);
                if (!fs.existsSync(source) || fs.existsSync(target)) continue;
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.cpSync(source, target, { recursive: true, errorOnExist: false });
                copied++;
            }
        }
    }
    return copied;
}

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
    return getTopicScratchDir('default', fallbackWorkspaceRoot);
}

export function getTopicScratchDir(topicId: string | undefined, fallbackWorkspaceRoot = ''): string {
    const topicDir = getTopicStorageDir(topicId, fallbackWorkspaceRoot);
    return topicDir ? path.join(topicDir, 'scratch') : '';
}
