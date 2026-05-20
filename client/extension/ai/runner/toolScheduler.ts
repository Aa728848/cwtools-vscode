/**
 * CWTools AI Module — Runner Tool Scheduler
 * 
 * Handles write-tool locks, superseded write check, and cross-platform
 * write target file path extraction.
 */

import * as path from 'path';
import { getTopicStorageDir } from '../workspacePaths';

export const SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS = new Set<string>(['write_file']);

export function getAgentToolTargetFiles(
    toolName: string,
    args: Record<string, unknown>,
    workspaceRoot?: string,
    topicId?: string
): string[] {
    const paths: string[] = [];
    const add = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            const trimmed = value.trim();
            if (workspaceRoot) {
                const isWinAbs = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
                const isPosixAbs = trimmed.startsWith('/');
                if (isWinAbs) {
                    paths.push(process.platform === 'win32' ? path.resolve(trimmed) : trimmed.replace(/\//g, '\\'));
                } else if (isPosixAbs) {
                    paths.push(path.resolve(trimmed));
                } else {
                    paths.push(path.resolve(workspaceRoot, trimmed));
                }
            } else {
                paths.push(trimmed);
            }
        }
    };

    switch (toolName) {
        case 'write_file':
        case 'edit_pdx_block':
        case 'git_ops':
            add(args.file);
            break;
        case 'multi_replace_file_content':
            add(args.TargetFile);
            break;
        case 'replace_lines':
        case 'write_localisation':
            add(args.filePath);
            break;
        case 'deploy_mod_asset':
            if (workspaceRoot && typeof args.targetRelativePath === 'string') {
                paths.push(path.resolve(workspaceRoot, args.targetRelativePath));
            } else {
                add(args.targetRelativePath);
            }
            break;
        case 'write_design_blueprint':
            if (workspaceRoot) {
                paths.push(path.join(getTopicStorageDir(topicId || 'default', workspaceRoot), 'design_blueprint.md'));
            }
            break;
    }

    return [...new Set(paths)];
}
