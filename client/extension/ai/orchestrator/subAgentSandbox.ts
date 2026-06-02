import * as path from 'path';
import { getAgentProfile } from './agentRegistry';
import type { TaskNode } from './types';
import type { AgentMode } from '../types';
import { isPlanModeCardArtifactFile } from '../planModeGuard';
import { getAgentToolTargetFiles } from '../runner/toolScheduler';

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
}

const TOPIC_ARTIFACT_SCOPE = '.cwtools-ai';

/**
 * 根据 TaskNode 任务节点与项目环境动态构造子 Agent 隔离沙盒
 */
export function buildSubAgentSandbox(
    taskNode: TaskNode,
    workspaceRoot: string
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
    const defaultExcludes = new Set<string>([
        'web_fetch', 'search_web', 'codesearch',
        'run_command', 'git_ops', 'save_workflow',
        'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
    ]);

    // 如果是只读或者 plan 规划角色，额外禁止所有物理写入工具
    if (profile.toolBudget === 'read_only' || profile.toolBudget === 'plan') {
        const writeTools = ['write_file', 'replace_file_content', 'multi_replace_file_content', 'write_localisation', 'replace_lines', 'apply_patch', 'write_design_blueprint'];
        writeTools.forEach(t => defaultExcludes.add(t));
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
        if (taskNode.plannedFiles && taskNode.plannedFiles.length > 0) {
            taskNode.plannedFiles.forEach(f => {
                scopes.push(path.normalize(f).toLowerCase());
            });
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

/**
 * 在 Host 层拦截子 Agent 的工具与路径调用，执行沙盒安全强校验
 */
function targetMatchesWriteScope(targetFile: string, writeScope: string[], workspaceRoot: string): boolean {
    const absTarget = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceRoot, targetFile);
    const relTarget = path.relative(workspaceRoot, absTarget).replace(/\\/g, '/').toLowerCase();

    for (const scope of writeScope) {
        const absScope = path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope);
        const relScope = path.relative(workspaceRoot, absScope).replace(/\\/g, '/').toLowerCase();

        if (
            scope.startsWith('.') &&
            scope.toLowerCase() !== TOPIC_ARTIFACT_SCOPE &&
            relTarget.endsWith(scope.toLowerCase())
        ) {
            return true;
        }
        if (
            scope.toLowerCase() === TOPIC_ARTIFACT_SCOPE &&
            (relTarget === TOPIC_ARTIFACT_SCOPE || relTarget.startsWith(`${TOPIC_ARTIFACT_SCOPE}/`))
        ) {
            return true;
        }
        if (scope.toLowerCase() === 'localisation' && relTarget.includes('localisation')) {
            return true;
        }
        if (relTarget.includes(relScope) || relTarget === relScope) {
            return true;
        }
        if (!scope.startsWith('.') && scope.toLowerCase() !== 'localisation') {
            const ext = path.extname(relScope);
            if (ext) {
                const relScopeDir = path.dirname(relScope).replace(/\\/g, '/');
                if (relScopeDir && relScopeDir !== '.' && relScopeDir !== '/' && relScopeDir !== '') {
                    const requiredPrefix = relScopeDir.endsWith('/') ? relScopeDir : relScopeDir + '/';
                    if (relTarget.startsWith(requiredPrefix) || relTarget === relScopeDir) {
                        return true;
                    }
                }
            }
        }
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
    const excludedTools = new Set<string>([
        'web_fetch', 'search_web', 'codesearch',
        'run_command', 'git_ops', 'save_workflow',
        'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
    ]);

    if (excludedTools.has(toolName)) {
        if (toolName === 'run_command') {
            return {
                allowed: false,
                reason: 'run_command is disabled for orchestrator sub-agents. Use structured edit tools for bulk file changes; if a terminal command is truly required, return BLOCKED_FOR_ORCHESTRATOR with the command and reason.'
            };
        }
        return {
            allowed: false,
            reason: `子 Agent 沙盒已拒绝执行敏感特权工具 '${toolName}'`
        };
    }

    // ─── 1. 判断是否属于文件写入类工具 ───
    const writeTools = new Set<string>([
        'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_localisation', 'replace_lines', 'apply_patch', 'write_design_blueprint'
    ]);

    if (writeTools.has(toolName)) {
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
                reason: `子任务角色 '${sandbox.role}' (${sandbox.mode}) 属于只读角色，禁止调用物理写入工具 '${toolName}'`
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

        // 将目标物理路径规格化为统一的工作区正斜杠相对路径
        const absTarget = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceRoot, targetFile);
        const relTarget = path.relative(workspaceRoot, absTarget).replace(/\\/g, '/').toLowerCase();

        if (sandbox.writeScope && sandbox.writeScope.length > 0 && targetFiles.length > 1) {
            const invalidTarget = targetFiles.find(target => !targetMatchesWriteScope(target, sandbox.writeScope!, workspaceRoot));
            if (invalidTarget) {
                return {
                    allowed: false,
                    reason: `子 Agent 沙盒物理拦截：多文件写入目标 '${invalidTarget}' 不在许可的作用域范围 [${sandbox.writeScope.join(', ')}] 内，拒绝操作。`
                };
            }
        }

        // 如果存在具体的限制范围，验证写入是否越权越界
        if (sandbox.writeScope && sandbox.writeScope.length > 0) {
            let matchesScope = false;
            for (const scope of sandbox.writeScope) {
                // 将许可范围也规格化为统一的工作区正斜杠相对路径
                const absScope = path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope);
                const relScope = path.relative(workspaceRoot, absScope).replace(/\\/g, '/').toLowerCase();

                // 1) 后缀或子片段模糊约束 (如 '.gui' 或 'localisation')
                if (
                    scope.startsWith('.') &&
                    scope.toLowerCase() !== TOPIC_ARTIFACT_SCOPE &&
                    relTarget.endsWith(scope.toLowerCase())
                ) {
                    matchesScope = true;
                    break;
                }
                if (
                    scope.toLowerCase() === TOPIC_ARTIFACT_SCOPE &&
                    (relTarget === TOPIC_ARTIFACT_SCOPE || relTarget.startsWith(`${TOPIC_ARTIFACT_SCOPE}/`))
                ) {
                    matchesScope = true;
                    break;
                }
                if (scope.toLowerCase() === 'localisation' && relTarget.includes('localisation')) {
                    matchesScope = true;
                    break;
                }

                // 2) 物理相对路径完全或前缀匹配
                if (relTarget.includes(relScope) || relTarget === relScope) {
                    matchesScope = true;
                    break;
                }

                // 3) 允许在其父目录下进行写入（即同属于一个模块目录，如 common/buildings）
                if (!scope.startsWith('.') && scope.toLowerCase() !== 'localisation') {
                    const ext = path.extname(relScope);
                    if (ext) {
                        const relScopeDir = path.dirname(relScope).replace(/\\/g, '/');
                        if (relScopeDir && relScopeDir !== '.' && relScopeDir !== '/' && relScopeDir !== '') {
                            const requiredPrefix = relScopeDir.endsWith('/') ? relScopeDir : relScopeDir + '/';
                            if (relTarget.startsWith(requiredPrefix) || relTarget === relScopeDir) {
                                matchesScope = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (!matchesScope) {
                return {
                    allowed: false,
                    reason: `子 Agent 沙盒物理拦截：写入目标文件路径 '${targetFile}' 不在许可的作用域范围 [${sandbox.writeScope.join(', ')}] 内，拒绝操作。`
                };
            }
        }
    }

    return { allowed: true };
}
