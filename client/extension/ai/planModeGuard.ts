import * as path from 'path';
import { getAgentToolTargetFiles } from './runner/toolScheduler';
import { WRITE_TOOLS } from './tools/registry';
import type { AgentMode } from './types';

export interface PlanModeGuardResult {
    allowed: boolean;
    reason?: string;
    targetPaths?: string[];
}

const READ_ONLY_GIT_ACTIONS = new Set(['status', 'diff']);
const READ_ONLY_GIT_MODES = new Set<AgentMode>(['plan', 'explore', 'review', 'script_reviewer', 'orchestrator', 'script']);

export function isReadOnlyGitAction(action: unknown): boolean {
    return typeof action === 'string' && READ_ONLY_GIT_ACTIONS.has(action);
}

export function validateGitOpsForMode(
    mode: AgentMode,
    args: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    if (!READ_ONLY_GIT_MODES.has(mode)) {
        return { allowed: true };
    }

    if (isReadOnlyGitAction(args.action)) {
        return { allowed: true };
    }

    return {
        allowed: false,
        reason: `${mode} mode only permits read-only git_ops actions: status and diff.`,
    };
}

const PLAN_FILE_RE = /^(implementation|implement)[ _-]?plan\.md$/i;
const EXACT_HANDOFF_PLAN_FILE_RE = /^implementation_plan\.md$/i;
const CARD_ARTIFACT_FILE_RE = /^(?:(?:implementation|implement)[ _-]?plan|design_blueprint|walkthrough|task|(?:plan|blueprint|walkthrough)?[ _-]?annotations?)\.(?:md|json)$/i;

function normalize(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isImplementationPlanFile(filePath: string, workspaceRoot: string): boolean {
    if (!filePath) return false;
    const base = path.basename(filePath);
    if (!PLAN_FILE_RE.test(base)) return false;

    const resolved = path.resolve(filePath);
    const workspace = path.resolve(workspaceRoot);
    if (isInside(resolved, path.join(workspace, '.cwtools')) || isInside(resolved, path.join(workspace, '.cwtools-ai'))) return true;

    const normalized = normalize(resolved);
    if (normalized.includes('/.cwtools/') || normalized.includes('/.cwtools-ai/')) return true;

    // When the AI storage folder itself is opened as the workspace root.
    const workspaceName = path.basename(workspace).toLowerCase();
    if ((workspaceName === '.cwtools' || workspaceName === '.cwtools-ai') && isInside(resolved, workspace)) return true;

    return false;
}

function getAiRelativeSegments(filePath: string, workspaceRoot: string): string[] | undefined {
    const resolved = path.resolve(filePath);
    const workspace = path.resolve(workspaceRoot);
    const aiRoot = path.join(workspace, '.cwtools');
    const aiRootLegacy = path.join(workspace, '.cwtools-ai');

    let relative = '';
    if (isInside(resolved, aiRoot)) {
        relative = path.relative(aiRoot, resolved);
    } else if (isInside(resolved, aiRootLegacy)) {
        relative = path.relative(aiRootLegacy, resolved);
    } else {
        const workspaceName = path.basename(workspace).toLowerCase();
        if ((workspaceName === '.cwtools' || workspaceName === '.cwtools-ai') && isInside(resolved, workspace)) {
            relative = path.relative(workspace, resolved);
        } else {
            const normalized = normalize(resolved);
            let marker = '/.cwtools/';
            let idx = normalized.indexOf(marker);
            if (idx < 0) {
                marker = '/.cwtools-ai/';
                idx = normalized.indexOf(marker);
            }
            if (idx < 0) return undefined;
            relative = normalized.slice(idx + marker.length);
        }
    }

    const segments = relative.split(/[\\/]+/).filter(Boolean);
    return segments.length > 0 ? segments : undefined;
}

export function isPlanModeCardArtifactFile(filePath: string, workspaceRoot: string): boolean {
    if (!filePath) return false;
    const segments = getAiRelativeSegments(filePath, workspaceRoot);
    if (!segments) return false;

    const base = path.basename(filePath);
    if (CARD_ARTIFACT_FILE_RE.test(base)) return true;

    const lowerSegments = segments.map(s => s.toLowerCase());
    // UI cards and inline diff previews write topic-local temp files such as
    // .cwtools/<topic>/tmp/artifacts/...; these are not project mutations.
    if (lowerSegments.includes('tmp') || lowerSegments.includes('artifacts')) return true;

    return false;
}

function isCurrentTopicImplementationPlan(filePath: string, workspaceRoot: string, topicId: string | undefined): boolean {
    if (!topicId || !EXACT_HANDOFF_PLAN_FILE_RE.test(path.basename(filePath))) return false;
    const segments = getAiRelativeSegments(filePath, workspaceRoot);
    if (!segments || segments.length < 2) return false;
    const safeTopicId = topicId.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
    return segments[0]!.toLowerCase() === safeTopicId;
}

export function validatePlanModeToolUse(
    toolName: string,
    args: Record<string, unknown>,
    workspaceRoot: string,
    topicId?: string,
    precomputedTargets?: string[],
    mode: 'plan' | 'orchestrator' | 'script' = 'plan',
): PlanModeGuardResult {
    if (!WRITE_TOOLS.has(toolName)) {
        return { allowed: true };
    }

    if (toolName === 'write_design_blueprint') {
        return { allowed: true };
    }

    if (toolName === 'save_workflow') {
        return { allowed: true };
    }

    if (toolName === 'git_ops') {
        return validateGitOpsForMode(mode, args);
    }

    const targets = precomputedTargets && precomputedTargets.length > 0
        ? precomputedTargets
        : getAgentToolTargetFiles(toolName, args, workspaceRoot, topicId);

    const planFileWriteTools = new Set(['write_file', 'edit_file', 'replace_lines']);
    const allowedArtifactTargets = mode === 'plan'
        ? targets.every(target => isPlanModeCardArtifactFile(target, workspaceRoot))
        : toolName === 'write_file'
            && targets.every(target => isCurrentTopicImplementationPlan(target, workspaceRoot, topicId));
    if (planFileWriteTools.has(toolName) && targets.length > 0 && allowedArtifactTargets) {
        return { allowed: true, targetPaths: targets };
    }

    const targetList = targets.length > 0 ? ` Targets: ${targets.join(', ')}` : '';
    return {
        allowed: false,
        targetPaths: targets,
        reason: `${mode} mode blocks direct workspace mutation except its explicitly permitted topic-scoped plan/card artifacts.${targetList}`,
    };
}
