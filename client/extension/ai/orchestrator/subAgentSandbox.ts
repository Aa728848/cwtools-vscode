import * as path from 'path';
import { agentProfileCatalog } from '../runner/agentProfileCatalog';
import type { TaskNode } from './types';
import { isPlanModeCardArtifactFile } from '../planModeGuard';
import { getAgentToolTargetFiles } from '../runner/toolScheduler';
import { FILE_SCOPED_WRITE_TOOLS, MUTATING_TOOLS, TOOL_REGISTRY } from '../tools/registry';
import { isPathInsideOrEqual, foldPathCase } from '../workspaceSandbox';
import { clampWriteScopeToRoots } from '../runner/policyEngine';
import { aiText } from '../messages';
import { getConfiguredGameRoots } from '../../configuredGameRoots';

/**
 * Orchestrator 子 Agent 物理沙盒隔离规范 (Sub-Agent Sandbox)
 */
export interface SubAgentSandbox {
    agentId: string;
    profileName: string;
    allowedTools?: Set<string>;
    readScope?: string[];
    writeScope?: string[];
    /** Workspace-relative scopes that remain user-owned and cannot be written by this child. */
    deniedWriteScopes?: string[];
    plannedEntities?: string[];
    permissionPolicy: 'deny' | 'delegate_to_parent' | 'allow_readonly';
    vfsOverlay?: Map<string, string>;
    /** plannedFiles dropped because they escaped the parent writable roots. */
    rejectedScopes?: string[];
}

const TOPIC_ARTIFACT_SCOPE = '.cwtools';

/**
 * 根据 TaskNode 任务节点与项目环境动态构造子 Agent 隔离沙盒
 */
export function buildSubAgentSandbox(
    taskNode: TaskNode,
    workspaceRoot: string,
    parentWritableRoots?: string[],
    deniedWriteScopes?: string[],
): SubAgentSandbox {
    const profile = agentProfileCatalog.getRequired(taskNode.profileName);

    const sandbox: SubAgentSandbox = {
        agentId: taskNode.id,
        profileName: profile.name,
        permissionPolicy: 'delegate_to_parent',
        deniedWriteScopes: deniedWriteScopes?.length ? [...deniedWriteScopes] : undefined,
    };

    // ─── 1. 计算写入作用域 (Write Scope) ───
    // 只读 Profile 的 writeScope 为空，物理文件写入一律禁止。
    if (profile.authorizationCeiling !== 'workspace_write') {
        sandbox.writeScope = [];
    } else {
        const scopes: string[] = [];
        if (profile.name === 'localization-writer' || profile.name === 'localization-translator') {
            scopes.push('localisation'); // 仅允许包含 localisation 的目录写入
        }

        if (profile.name === 'gui-expert') {
            scopes.push('.gui'); // 仅允许以 .gui 结尾或在 gui 目录下的路径写入
        }

        // 2.3 融合 taskNode.plannedFiles 明确规划的物理变更文件路径
        // Phase 3: child write scope is the intersection with parent writable roots — escapes are dropped.
        if (taskNode.plannedFiles && taskNode.plannedFiles.length > 0) {
            const { clamped, rejected } = clampWriteScopeToRoots(
                taskNode.plannedFiles.map(f => path.normalize(f)),
                parentWritableRoots ?? [workspaceRoot],
                workspaceRoot
            );
            (clamped ?? []).forEach(f => scopes.push(f));
            if (rejected.length > 0) sandbox.rejectedScopes = rejected;
        }

        if (scopes.length > 0) {
            // Topic-local artifacts stay workspace-owned without broadening a restricted project scope.
            scopes.push(TOPIC_ARTIFACT_SCOPE);
            sandbox.writeScope = scopes;
        } else {
            // General writable workers still stay inside file-tool workspace safety checks.
            // Avoid reducing them to topic artifacts only when the plan omitted plannedFiles.
            sandbox.writeScope = undefined;
        }
    }

    // ─── 2. 设定读作用域 (Read Scope) ───
    // Game roots selected in extension settings are readable but remain outside
    // every child write scope.
    const readableRoots = [workspaceRoot, ...getConfiguredGameRoots().map(entry => entry.root)];
    const seenReadableRoots = new Set<string>();
    sandbox.readScope = readableRoots
        .map(root => path.resolve(root))
        .filter(root => {
            const key = foldPathCase(root);
            if (seenReadableRoots.has(key)) return false;
            seenReadableRoots.add(key);
            return true;
        })
        .sort((left, right) => left.localeCompare(right));

    return sandbox;
}


function targetMatchesWriteScope(targetFile: string, writeScope: string[], workspaceRoot: string): boolean {
    const absTarget = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceRoot, targetFile);
    const relTarget = foldPathCase(path.relative(workspaceRoot, absTarget).replace(/\\/g, '/'));

    for (const scope of writeScope) {
        const scopeLower = scope.toLowerCase();

        if (scope.startsWith('.') && scopeLower !== TOPIC_ARTIFACT_SCOPE) {
            if (relTarget.endsWith(foldPathCase(scope))) return true;
            continue;
        }

        if (scopeLower === TOPIC_ARTIFACT_SCOPE) {
            if (relTarget === TOPIC_ARTIFACT_SCOPE || relTarget.startsWith(`${TOPIC_ARTIFACT_SCOPE}/`)) return true;
            continue;
        }

        if (scopeLower === 'localisation') {
            if (/(?:^|\/)(?:localisation|localization)(?:\/|$)/.test(relTarget.toLowerCase())) return true;
            continue;
        }

        const absScope = path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope);
        const scopeRoot = path.extname(absScope) ? path.dirname(absScope) : absScope;
        if (isPathInsideOrEqual(absTarget, scopeRoot)) return true;
    }

    return false;
}

export function enforceSubAgentSafety(
    sandbox: SubAgentSandbox,
    toolName: string,
    args: any,
    workspaceRoot: string
): { allowed: boolean; reason?: string } {
    const registryEntry = TOOL_REGISTRY.get(toolName as import('../tools/registry').AgentToolName);
    const profileException = toolName === 'run_command' && sandbox.profileName === 'general-coder';
    if (registryEntry && !registryEntry.allowSubAgent && !profileException) {
        if (toolName === 'run_command') {
            return {
                allowed: false,
                reason: 'run_command is disabled for orchestrator sub-agents. Use structured edit tools; if a terminal command is truly required, return BLOCKED_FOR_ORCHESTRATOR with the command and reason.',
            };
        }
        return {
            allowed: false,
            reason: aiText(
                `The sub-agent sandbox rejected privileged tool '${toolName}'.`,
                `子 Agent 沙盒已拒绝执行敏感特权工具 '${toolName}'`,
            ),
        };
    }

    if (sandbox.writeScope && sandbox.writeScope.length === 0 && MUTATING_TOOLS.has(toolName) && !FILE_SCOPED_WRITE_TOOLS.has(toolName)) {
        return {
            allowed: false,
            reason: aiText(
                `Subtask profile '${sandbox.profileName}' is read-only and cannot call mutating tool '${toolName}'.`,
                `子任务 Profile '${sandbox.profileName}' 为只读，禁止调用会修改状态的工具 '${toolName}'`,
            ),
        };
    }

    // ─── 1. 判断是否属于按文件路径写入类工具 ───
    if (FILE_SCOPED_WRITE_TOOLS.has(toolName)) {
        const targetFiles = getAgentToolTargetFiles(toolName, args || {}, workspaceRoot);
        let targetFile = '';
        if (targetFiles.length > 0) {
            targetFile = targetFiles[0]!;
        } else if (args && typeof args === 'object') {
            const fallbackTarget = args.TargetFile || args.filePath || args.targetRelativePath || args.file;
            targetFile = typeof fallbackTarget === 'string' ? fallbackTarget : '';
        }
        if (sandbox.deniedWriteScopes?.length) {
            const targetsToCheck = targetFiles.length > 0 ? targetFiles : targetFile ? [targetFile] : [];
            const deniedTarget = targetsToCheck.find(target =>
                targetMatchesWriteScope(target, sandbox.deniedWriteScopes!, workspaceRoot));
            if (deniedTarget) {
                return {
                    allowed: false,
                    reason: aiText(
                        `Sub-agent sandbox blocked the write because '${deniedTarget}' belongs to a user-owned scope [${sandbox.deniedWriteScopes.join(', ')}].`,
                        `子 Agent 沙盒已阻止写入：'${deniedTarget}' 属于用户自行处理的范围 [${sandbox.deniedWriteScopes.join(', ')}]。`,
                    ),
                };
            }
        }
        const isPlanCardArtifactWrite = sandbox.profileName === 'planner'
            && targetFiles.length > 0
            && targetFiles.every(target => isPlanModeCardArtifactFile(target, workspaceRoot));

        if (toolName === 'write_design_blueprint' && sandbox.profileName === 'planner') {
            return { allowed: true };
        }
        // 如果子 Agent Profile 本身只读（如 explore、reviewer），直接拦截写入。
        if (sandbox.writeScope && sandbox.writeScope.length === 0) {
            if (isPlanCardArtifactWrite) {
                return { allowed: true };
            }
            return {
                allowed: false,
                reason: aiText(
                    `Subtask profile '${sandbox.profileName}' is read-only and cannot call file-writing tool '${toolName}'.`,
                    `子任务 Profile '${sandbox.profileName}' 为只读，禁止调用物理写入工具 '${toolName}'`,
                ),
            };
        }

        if (!targetFile) {
            return { allowed: true }; // 参数为空时不作硬路径拦截，防止报错
        }

        if (sandbox.writeScope && sandbox.writeScope.length > 0 && targetFiles.length > 1) {
            const invalidTarget = targetFiles.find(target => !targetMatchesWriteScope(target, sandbox.writeScope!, workspaceRoot));
            if (invalidTarget) {
                return {
                    allowed: false,
                    reason: aiText(
                        `Sub-agent sandbox blocked the multi-file write: target '${invalidTarget}' is outside the allowed write scopes [${sandbox.writeScope.join(', ')}].`,
                        `子 Agent 沙盒物理拦截：多文件写入目标 '${invalidTarget}' 不在许可的作用域范围 [${sandbox.writeScope.join(', ')}] 内，拒绝操作。`,
                    ),
                };
            }
        }

        // 单文件写入校验：复用 targetMatchesWriteScope 作为唯一权威实现，避免双份逻辑漂移
        if (sandbox.writeScope && sandbox.writeScope.length > 0) {
            if (!targetMatchesWriteScope(targetFile, sandbox.writeScope, workspaceRoot)) {
                return {
                    allowed: false,
                    reason: aiText(
                        `Sub-agent sandbox blocked the write: target file '${targetFile}' is outside the allowed write scopes [${sandbox.writeScope.join(', ')}].`,
                        `子 Agent 沙盒物理拦截：写入目标文件路径 '${targetFile}' 不在许可的作用域范围 [${sandbox.writeScope.join(', ')}] 内，拒绝操作。`,
                    ),
                };
            }
        }
    }

    return { allowed: true };
}
