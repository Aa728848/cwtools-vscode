import * as path from 'path';
import * as vs from 'vscode';
import { getAiStorageRoot, getPrivateAiStorageRoot, getPrivateTopicRoot } from './workspacePaths';
import { isPathInsideOrEqual } from '../pathScope';
import { getProjectWorkspaceRoot } from './workspacePaths';
import { getSessionPermissionMode } from './runner/sessionPermissions';
import { getConfiguredGameRoots } from '../configuredGameRoots';

export type WorkspacePathScope = 'project' | 'ai' | 'workspace' | 'outside';

export interface WorkspacePathResolution {
    input: string;
    sanitized: string;
    resolved: string;
    scope: WorkspacePathScope;
    workspaceFolder?: string;
    isTrusted: boolean;
    isWithinAnyWorkspace: boolean;
}

export interface ReadablePathResolution extends WorkspacePathResolution {
    isWithinReadableRoot: boolean;
    configuredGameRoot?: string;
}

// Path-scope helpers (foldPathCase / isPathInsideOrEqual) live in the neutral
// ../pathScope module (no vscode/fs/AI deps) so UI modules can share them too;
// re-exported here so existing AI-layer imports keep working unchanged.
export { foldPathCase } from '../pathScope';
export { isPathInsideOrEqual };

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSecuritySandboxDisabled(): boolean {
    const sessionMode = getSessionPermissionMode(getProjectWorkspaceRoot());
    if (sessionMode) return sessionMode === 'full';
    return vs.workspace.getConfiguration('stellarisLanguageServices.ai.developer').get<boolean>('disableSecuritySandbox') === true;
}

export function sanitizePathInput(inputPath: string): string {
    let value = inputPath.trim();

    const codeSpan = value.match(/`([^`]+)`/);
    if (codeSpan?.[1]) value = codeSpan[1].trim();

    const quoted = value.match(/^["']([^"']+)["']$/);
    if (quoted?.[1]) value = quoted[1].trim();

    const absolutePath = value.match(/[A-Za-z]:[\\/][^`"'\r\n]+/);
    if (absolutePath?.[0]) {
        value = absolutePath[0].trim();
    } else {
        value = value.replace(/^(?:project\s+workspace\s+root|workspace\s+root|agent\s+workspace\s+dir|agent\s+scratch\s+dir|cwd|working\s+directory)\s*[:：]\s*/i, '').trim();
    }

    return value.replace(/[.,;，。；]+$/g, '').trim();
}

// Shared artifacts (project profile, workflows) intentionally stay in the
// project .cwtools directory; topic-scoped private data lives in the private
// agent storage root.
const SHARED_AI_STORAGE_SEGMENTS = new Set(['project', 'workflows']);

function resolveAiStorageAlias(filePath: string, workspaceRoot: string): string | undefined {
    const normalized = filePath.trim().replace(/\\/g, '/');
    const match = normalized.match(/^\.cwtools(?:\/(.*))?$/i);
    if (!match) return undefined;

    const rest = (match[1] ?? '').split('/').filter(Boolean);
    if (!SHARED_AI_STORAGE_SEGMENTS.has(rest[0]?.toLowerCase() ?? '')) {
        const topicRoot = getPrivateTopicRoot(workspaceRoot);
        if (topicRoot) return path.join(topicRoot, ...rest);
    }

    const primary = getAiStorageRoot(workspaceRoot);
    return primary ? path.join(primary, ...rest) : filePath;
}

export function resolveWorkspaceFolderAlias(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;

    const aiResolved = resolveAiStorageAlias(filePath, workspaceRoot);
    if (aiResolved) return aiResolved;

    const normalized = filePath.trim().replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return filePath;

    const firstSegment = segments[0]!;
    const workspaceFolders = vs.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
        if (path.basename(folder.uri.fsPath).toLowerCase() === firstSegment.toLowerCase()) {
            return path.join(folder.uri.fsPath, ...segments.slice(1));
        }
    }

    return filePath;
}

export function resolveWorkspacePathInput(
    inputPath: string,
    workspaceRoot: string,
): WorkspacePathResolution {
    const sanitized = sanitizePathInput(inputPath);
    const workspacePath = resolveWorkspaceFolderAlias(sanitized, workspaceRoot);
    const resolved = path.resolve(path.isAbsolute(workspacePath)
        ? workspacePath
        : path.join(workspaceRoot, workspacePath));

    const aiRoot = getAiStorageRoot(workspaceRoot);
    const privateRoot = getPrivateAiStorageRoot(workspaceRoot);
    const projectMatch = !!workspaceRoot && isPathInsideOrEqual(resolved, workspaceRoot);
    const aiMatch = (!!aiRoot && isPathInsideOrEqual(resolved, aiRoot))
        || (!!privateRoot && isPathInsideOrEqual(resolved, privateRoot));

    let workspaceFolder: string | undefined;
    const workspaceMatch = (vs.workspace.workspaceFolders ?? []).some(folder => {
        if (isPathInsideOrEqual(resolved, folder.uri.fsPath)) {
            workspaceFolder = folder.uri.fsPath;
            return true;
        }
        return false;
    });

    const scope: WorkspacePathScope = projectMatch
        ? 'project'
        : aiMatch
            ? 'ai'
            : workspaceMatch
                ? 'workspace'
                : 'outside';

    return {
        input: inputPath,
        sanitized,
        resolved,
        scope,
        workspaceFolder,
        isTrusted: scope === 'project' || scope === 'ai',
        isWithinAnyWorkspace: scope === 'project' || scope === 'ai' || scope === 'workspace',
    };
}

/** Resolve a model-supplied read path against the workspace and configured game roots. */
export function resolveReadablePathInput(
    inputPath: string,
    workspaceRoot: string,
): ReadablePathResolution {
    const resolution = resolveWorkspacePathInput(inputPath, workspaceRoot);
    if (resolution.isWithinAnyWorkspace) {
        return { ...resolution, isWithinReadableRoot: true };
    }

    const configuredGameRoot = getConfiguredGameRoots()
        .map(item => item.root)
        .find(root => isPathInsideOrEqual(resolution.resolved, root));
    return {
        ...resolution,
        isWithinReadableRoot: !!configuredGameRoot,
        configuredGameRoot,
    };
}
