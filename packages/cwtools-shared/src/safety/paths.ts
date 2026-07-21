import * as path from 'path';

export interface WorkspacePathResolution {
  ok: boolean;
  input: string;
  workspaceRoot: string;
  resolvedPath?: string;
  relativePath?: string;
  reason?: 'empty_path' | 'outside_workspace';
}

export interface LocalisationPathValidation {
  ok: boolean;
  resolvedPath?: string;
  relativePath?: string;
  reason?: 'outside_workspace' | 'not_yml' | 'not_localisation_directory' | 'scratch_path';
  message?: string;
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

export function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): WorkspacePathResolution {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return { ok: false, input: inputPath, workspaceRoot: root, reason: 'empty_path' };
  }

  const resolved = path.resolve(root, trimmed);
  if (!isPathInsideOrEqual(root, resolved)) {
    return { ok: false, input: inputPath, workspaceRoot: root, reason: 'outside_workspace' };
  }

  return {
    ok: true,
    input: inputPath,
    workspaceRoot: root,
    resolvedPath: resolved,
    relativePath: path.relative(root, resolved).replace(/\\/g, '/'),
  };
}

export function isLocalisationRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('localisation/')
    || normalized.startsWith('localisation_synced/')
    || normalized.startsWith('localization/');
}

export function isScratchRelativePath(relativePath: string): boolean {
  const parts = relativePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/');
  return parts.includes('.cwtools') || parts.includes('.cwtools-ai');
}

export function validateLocalisationPath(workspaceRoot: string, inputPath: string): LocalisationPathValidation {
  const resolution = resolveWorkspacePath(workspaceRoot, inputPath);
  if (!resolution.ok || !resolution.resolvedPath || !resolution.relativePath) {
    return {
      ok: false,
      reason: 'outside_workspace',
      message: `Path '${inputPath}' is outside the workspace root.`,
    };
  }

  if (path.extname(resolution.resolvedPath).toLowerCase() !== '.yml') {
    return {
      ok: false,
      reason: 'not_yml',
      resolvedPath: resolution.resolvedPath,
      relativePath: resolution.relativePath,
      message: 'write_localisation only works with .yml files.',
    };
  }

  if (isScratchRelativePath(resolution.relativePath)) {
    return {
      ok: false,
      reason: 'scratch_path',
      resolvedPath: resolution.resolvedPath,
      relativePath: resolution.relativePath,
      message: 'Localisation files must not be written under .cwtools scratch or topic folders.',
    };
  }

  if (!isLocalisationRelativePath(resolution.relativePath)) {
    return {
      ok: false,
      reason: 'not_localisation_directory',
      resolvedPath: resolution.resolvedPath,
      relativePath: resolution.relativePath,
      message: 'Localisation files must be written under localisation/, localisation_synced/, or localization/.',
    };
  }

  return {
    ok: true,
    resolvedPath: resolution.resolvedPath,
    relativePath: resolution.relativePath,
  };
}
