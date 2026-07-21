import * as path from 'path';
import { getAgentProfile } from './agentRegistry';
import type { TaskNode } from './types';
import type { AgentMode } from '../types';
import { isPlanModeCardArtifactFile } from '../planModeGuard';
import { getAgentToolTargetFiles } from '../runner/toolScheduler';
import { FILE_SCOPED_WRITE_TOOLS, MUTATING_TOOLS, SUB_AGENT_EXCLUDES } from '../tools/registry';
import { isPathInsideOrEqual, foldPathCase } from '../workspaceSandbox';
import { clampWriteScopeToRoots } from '../runner/policyEngine';
import { aiText } from '../messages';

/**
 * Orchestrator 子 Agent 物理沙盒隔离规范 (Sub-Agent Sandbox)
 */
export interface SubAgentSandbox {
    agentId: string;
    role: string;
    mode: AgentMode;
    allowedTools?: Set<string>;
    readScope?: string[];
    writeScope?: string[];
    plannedEntities?: string[];
    permissionPolicy: 'deny' | 'delegate_to_parent' | 'allow_readonly';
    vfsOverlay?: Map<string, string>;
    /** plannedFiles dropped because they escaped the parent writable roots. */
    rejectedScopes?: string[];
}

const TOPIC_ARTIFACT_SCOPE = '.cwtools';
const LEGACY_TOPIC_ARTIFACT_SCOPE = '.cwtools-ai';

/**
 * 根据 TaskNode 任务节点与项目环境动态构造子 Agent 隔离沙盒
 */
export function buildSubAgentSandbox(
    taskNode: TaskNode,
    workspaceRoot: string,
    parentWritableRoots?: string[]
): SubAgentSandbox {
    const profile = getAgentProfile(taskNode.agentType);
    const role = taskNode.agentType;

    const sandbox: SubAgentSandbox = {
        agentId: taskNode.id,
        role,
        mode: profile.mode,
        permissionPolicy: 'delegate_to_parent',
    };

    // ─── 1. 计算允许的工具集 ───
    // 默认黑名单拦截高危/交互型特权工具
    const defaultExcludes = new Set<string>(SUB_AGENT_EXCLUDES);

    // 如果是只读或者 plan 规划角色，额外禁止所有物理写入工具
    if (profile.toolBudget === 'read_only' || profile.toolBudget === 'plan') {
        MUTATING_TOOLS.forEach(t => defaultExcludes.add(t));
    }

    // 假设注册的完整工具白名单（基于可用工具过滤去重）
    // 后续在 enforce 中主要使用此黑名单做直接防御，以简化集成

    // ─── 2. 计算写入作用域 (Write Scope) ───
    // 如果是只读性质的角色，其 writeScope 直接设为空数组（绝对禁止任何写物理文件操作）
    if (profile.toolBudget === 'read_only' || profile.toolBudget === 'plan') {
        sandbox.writeScope = [];
    } else {
        const scopes: string[] = [];
        const roleStr: string = role;
        const modeStr: string = profile.mode;

        // 2.1 融合 locWriter / locTranslator 的本地化写约束
        if (roleStr === 'locWriter' || roleStr === 'locTranslator' || modeStr === 'loc_writer' || modeStr === 'loc_translator') {
            scopes.push('localisation'); // 仅允许包含 localisation 的目录写入
        }

        // 2.2 融合 guiExpert 的界面文件写入约束
        if (roleStr === 'guiExpert' || modeStr === 'gui_expert') {
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

    // ─── 3. 设定读作用域 (Read Scope) ───
    // 默认子 Agent 读操作开放，但如果声明了 readScope，可以做相应限制，默认不开启硬拦截
    sandbox.readScope = undefined;

    return sandbox;
}


function targetMatchesWriteScope(targetFile: string, writeScope: string[], workspaceRoot: string): boolean {
    const absTarget = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceRoot, targetFile);
    const relTarget = foldPathCase(path.relative(workspaceRoot, absTarget).replace(/\\/g, '/'));

    for (const scope of writeScope) {
        const scopeLower = scope.toLowerCase();

        if (scope.startsWith('.') && scopeLower !== TOPIC_ARTIFACT_SCOPE && scopeLower !== LEGACY_TOPIC_ARTIFACT_SCOPE) {
            if (relTarget.endsWith(foldPathCase(scope))) return true;
            continue;
        }

        if (scopeLower === TOPIC_ARTIFACT_SCOPE || scopeLower === LEGACY_TOPIC_ARTIFACT_SCOPE) {
            if (relTarget === TOPIC_ARTIFACT_SCOPE || relTarget.startsWith(`${TOPIC_ARTIFACT_SCOPE}/`) ||
                relTarget === LEGACY_TOPIC_ARTIFACT_SCOPE || relTarget.startsWith(`${LEGACY_TOPIC_ARTIFACT_SCOPE}/`)) return true;
            continue;
        }

        if (scopeLower === 'localisation') {
            if (relTarget.toLowerCase().includes('localisation')) return true;
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
    // W7 fix: 针对 excluded 敏感特权工具直接物理阻断
    const excludedTools = new Set<string>(SUB_AGENT_EXCLUDES);

    if (excludedTools.has(toolName)) {
        if (toolName === 'run_command') {
            return {
                allowed: false,
                reason: 'run_command is disabled for orchestrator sub-agents. Use structured edit tools for bulk file changes; if a terminal command is truly required, return BLOCKED_FOR_ORCHESTRATOR with the command and reason.'
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
                `Subtask role '${sandbox.role}' (${sandbox.mode}) is read-only and cannot call mutating tool '${toolName}'.`,
                `子任务角色 '${sandbox.role}' (${sandbox.mode}) 属于只读角色，禁止调用会修改状态的工具 '${toolName}'`,
            ),
        };
    }

    // ─── 1. 判断是否属于按文件路径写入类工具 ───
    if (FILE_SCOPED_WRITE_TOOLS.has(toolName)) {
        const targetFiles = getAgentToolTargetFiles(toolName, args || {}, workspaceRoot);
        const isPlanCardArtifactWrite = sandbox.mode === 'plan'
            && targetFiles.length > 0
            && targetFiles.every(target => isPlanModeCardArtifactFile(target, workspaceRoot));

        if (toolName === 'write_design_blueprint' && sandbox.mode === 'plan') {
            return { allowed: true };
        }
        // 如果子 Agent 本身就是只读角色（如 explorer, reviewer），直接断开拦截
        if (sandbox.writeScope && sandbox.writeScope.length === 0) {
            if (isPlanCardArtifactWrite) {
                return { allowed: true };
            }
            return {
                allowed: false,
                reason: aiText(
                    `Subtask role '${sandbox.role}' (${sandbox.mode}) is read-only and cannot call file-writing tool '${toolName}'.`,
                    `子任务角色 '${sandbox.role}' (${sandbox.mode}) 属于只读角色，禁止调用物理写入工具 '${toolName}'`,
                ),
            };
        }

        // 提取写入文件的具体路径参数
        let targetFile: string = '';
        if (targetFiles.length > 0) {
            targetFile = targetFiles[0]!;
        } else if (args && typeof args === 'object') {
            targetFile = args.TargetFile || args.filePath || args.targetRelativePath || args.file || '';
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
