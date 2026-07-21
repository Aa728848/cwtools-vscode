import * as path from 'path';
import * as fs from 'fs';
import * as vs from 'vscode';

let privateAgentStorageRoot = '';

export interface AiStorageMigrationResult {
    legacyRoot: string;
    primaryRoot: string;
    migrated: boolean;
    movedEntries: number;
    resolvedConflicts: number;
}

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
        '.cwtools-ai-memory.md', '.cwtools-memory.md', 'memory.json',
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

function resolveAiStorageRoots(fallbackWorkspaceRoot = ''): { legacyRoot: string; primaryRoot: string } | undefined {
    const workspaceRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    if (!workspaceRoot) return undefined;
    const name = path.basename(workspaceRoot).toLowerCase();
    if (name === '.cwtools') {
        return {
            primaryRoot: workspaceRoot,
            legacyRoot: path.join(path.dirname(workspaceRoot), '.cwtools-ai'),
        };
    }
    if (name === '.cwtools-ai') {
        return {
            primaryRoot: path.join(path.dirname(workspaceRoot), '.cwtools'),
            legacyRoot: workspaceRoot,
        };
    }
    return {
        primaryRoot: path.join(workspaceRoot, '.cwtools'),
        legacyRoot: path.join(workspaceRoot, '.cwtools-ai'),
    };
}

function mergeLegacyStorageEntry(
    source: string,
    target: string,
    primaryRoot: string,
    result: { movedEntries: number; resolvedConflicts: number },
): void {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
        result.movedEntries++;
        return;
    }

    const sourceStat = fs.lstatSync(source);
    const targetStat = fs.lstatSync(target);
    if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()
        && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
        const entries = fs.readdirSync(source, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            mergeLegacyStorageEntry(path.join(source, entry.name), path.join(target, entry.name), primaryRoot, result);
        }
        fs.rmdirSync(source);
        return;
    }

    // The current .cwtools copy is authoritative, but preserve the legacy conflict.
    const relativeTarget = path.relative(primaryRoot, target);
    const archiveBase = path.join(primaryRoot, 'migration-conflicts', 'cwtools-ai', relativeTarget);
    let archiveTarget = archiveBase;
    let suffix = 1;
    while (fs.existsSync(archiveTarget)) {
        archiveTarget = `${archiveBase}.${suffix++}`;
    }
    fs.mkdirSync(path.dirname(archiveTarget), { recursive: true });
    fs.renameSync(source, archiveTarget);
    result.resolvedConflicts++;
}

/** Merge the old project storage root into .cwtools and remove .cwtools-ai. */
export function migrateLegacyAiStorageRoot(fallbackWorkspaceRoot = ''): AiStorageMigrationResult {
    const roots = resolveAiStorageRoots(fallbackWorkspaceRoot);
    if (!roots) {
        return { legacyRoot: '', primaryRoot: '', migrated: false, movedEntries: 0, resolvedConflicts: 0 };
    }
    const result: AiStorageMigrationResult = {
        ...roots,
        migrated: false,
        movedEntries: 0,
        resolvedConflicts: 0,
    };
    if (!fs.existsSync(roots.legacyRoot)) return result;

    if (!fs.existsSync(roots.primaryRoot)) {
        fs.mkdirSync(path.dirname(roots.primaryRoot), { recursive: true });
        fs.renameSync(roots.legacyRoot, roots.primaryRoot);
        result.migrated = true;
        result.movedEntries = 1;
        return result;
    }

    const entries = fs.readdirSync(roots.legacyRoot, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        mergeLegacyStorageEntry(
            path.join(roots.legacyRoot, entry.name),
            path.join(roots.primaryRoot, entry.name),
            roots.primaryRoot,
            result,
        );
    }
    fs.rmdirSync(roots.legacyRoot);
    result.migrated = true;
    return result;
}

export function getProjectWorkspaceRoot(fallback = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    return folders.find(folder => {
        const name = path.basename(folder.uri.fsPath).toLowerCase();
        return name !== '.cwtools' && name !== '.cwtools-ai';
    })?.uri.fsPath
        ?? folders[0]?.uri.fsPath
        ?? fallback;
}

export function getAiStorageRoot(fallbackWorkspaceRoot = ''): string {
    const folders = vs.workspace.workspaceFolders ?? [];
    const aiFolder = folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools');
    if (aiFolder) return aiFolder.uri.fsPath;

    for (const folder of folders) {
        const name = path.basename(folder.uri.fsPath).toLowerCase();
        if (name === '.cwtools' || name === '.cwtools-ai') continue;
        const childAiRoot = path.join(folder.uri.fsPath, '.cwtools');
        if (fs.existsSync(childAiRoot)) return childAiRoot;
    }

    const legacyAiFolder = folders.find(folder => path.basename(folder.uri.fsPath).toLowerCase() === '.cwtools-ai');
    if (legacyAiFolder) return path.join(path.dirname(legacyAiFolder.uri.fsPath), '.cwtools');

    if (fallbackWorkspaceRoot) {
        const fallbackName = path.basename(fallbackWorkspaceRoot).toLowerCase();
        if (fallbackName === '.cwtools') return fallbackWorkspaceRoot;
        if (fallbackName === '.cwtools-ai') return path.join(path.dirname(fallbackWorkspaceRoot), '.cwtools');
    }

    const workspaceRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    if (path.basename(workspaceRoot).toLowerCase() === '.cwtools-ai') {
        return path.join(path.dirname(workspaceRoot), '.cwtools');
    }
    return workspaceRoot ? path.join(workspaceRoot, '.cwtools') : '';
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
        const name = path.basename(folder.uri.fsPath).toLowerCase();
        if (name === '.cwtools' || name === '.cwtools-ai') {
            add(folder.uri.fsPath);
            continue;
        }
        const childAiRoot = path.join(folder.uri.fsPath, '.cwtools');
        if (fs.existsSync(childAiRoot)) {
            add(childAiRoot);
        }
        const legacyAiRoot = path.join(folder.uri.fsPath, '.cwtools-ai');
        if (fs.existsSync(legacyAiRoot)) {
            add(legacyAiRoot);
        }
    }

    const projectRoot = getProjectWorkspaceRoot(fallbackWorkspaceRoot);
    if (projectRoot) {
        const name = path.basename(projectRoot).toLowerCase();
        if (name === '.cwtools' || name === '.cwtools-ai') {
            add(projectRoot);
        } else {
            const legacyProjectRoot = path.join(projectRoot, '.cwtools');
            if (fs.existsSync(legacyProjectRoot)) {
                add(legacyProjectRoot);
            }
            const legacyProjectRootAi = path.join(projectRoot, '.cwtools-ai');
            if (fs.existsSync(legacyProjectRootAi)) {
                add(legacyProjectRootAi);
            }
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
