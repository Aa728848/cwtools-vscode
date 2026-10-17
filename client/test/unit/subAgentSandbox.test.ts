/**
 * Orchestrator 子 Agent 物理沙盒隔离组件 - 单元测试 (Phase 5)
 */

import { expect } from 'chai';
import * as path from 'path';

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadSandboxModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        const sandboxModule = require('../../extension/ai/orchestrator/subAgentSandbox') as typeof import('../../extension/ai/orchestrator/subAgentSandbox');
        const workspaceSandboxModule = require('../../extension/ai/workspaceSandbox') as typeof import('../../extension/ai/workspaceSandbox');
        return {
            buildSubAgentSandbox: sandboxModule.buildSubAgentSandbox,
            enforceSubAgentSafety: sandboxModule.enforceSubAgentSafety,
            formatReadablePathForTool: workspaceSandboxModule.formatReadablePathForTool,
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('SubAgentSandbox', () => {
    let buildSubAgentSandbox: typeof import('../../extension/ai/orchestrator/subAgentSandbox').buildSubAgentSandbox;
    let enforceSubAgentSafety: typeof import('../../extension/ai/orchestrator/subAgentSandbox').enforceSubAgentSafety;
    let formatReadablePathForTool: typeof import('../../extension/ai/workspaceSandbox').formatReadablePathForTool;
    type TaskNode = import('../../extension/ai/orchestrator/types').TaskNode;

    before(() => {
        // The sandbox module reaches vscode transitively (planModeGuard -> toolScheduler
        // -> workspacePaths/configuredGameRoots), so a unit run needs the same stub the
        // other Extension Host unit suites use.
        const loaded = loadSandboxModules();
        buildSubAgentSandbox = loaded.buildSubAgentSandbox;
        enforceSubAgentSafety = loaded.enforceSubAgentSafety;
        formatReadablePathForTool = loaded.formatReadablePathForTool;
    });

    // ── 1. 沙盒构建生成校验 ──
    describe('buildSubAgentSandbox', () => {
        it('explore (只读 Profile) — 应该生成空的 writeScope', () => {
            const mockNode: TaskNode = {
                id: 'explore_task',
                profileName: 'explore',
                prompt: 'scan project',
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());
            expect(sandbox.writeScope).to.exist;
            expect(sandbox.writeScope).to.have.length(0); // 必须是空数组，代表物理只读
            expect(sandbox.readScope).to.include(path.resolve(process.cwd()));
        });

        it('preserves external game files as absolute readable tool paths', () => {
            const workspaceRoot = path.join(process.cwd(), 'workspace');
            const workspaceFile = path.join(workspaceRoot, 'common', 'rules.txt');
            const vanillaFile = path.resolve(workspaceRoot, '..', 'Stellaris', 'common', 'game_rules', '00_rules.txt');

            expect(formatReadablePathForTool(workspaceFile, workspaceRoot)).to.equal('common/rules.txt');
            expect(formatReadablePathForTool(vanillaFile, workspaceRoot)).to.equal(vanillaFile.replace(/\\/g, '/'));
        });

        it('reviewer (只读 Profile) — 应该生成空的 writeScope', () => {
            const mockNode: TaskNode = {
                id: 'review_task',
                profileName: 'reviewer',
                prompt: 'verify diagnostics',
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());
            expect(sandbox.writeScope).to.exist;
            expect(sandbox.writeScope).to.have.length(0);
        });

        it('localization-writer — 应该将 writeScope 限制为 localisation', () => {
            const mockNode: TaskNode = {
                id: 'loc_task',
                profileName: 'localization-writer',
                prompt: 'translate keys',
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());
            expect(sandbox.writeScope).to.include('localisation');
        });

        it('gui-expert — 应该将 writeScope 限制为 .gui', () => {
            const mockNode: TaskNode = {
                id: 'gui_task',
                profileName: 'gui-expert',
                prompt: 'layout interfaces',
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());
            expect(sandbox.writeScope).to.include('.gui');
        });

        it('plannedFiles 驱动 — 应该将指定的计划文件映射到 writeScope', () => {
            const mockNode: TaskNode = {
                id: 'builder_task',
                profileName: 'paradox-coder',
                prompt: 'implement events',
                plannedFiles: ['common/events/test_event.txt', 'interface/gfx.gui'],
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());
            const normalizedPaths = sandbox.writeScope!.map(p => p.toLowerCase());
            expect(normalizedPaths).to.include(path.normalize('common/events/test_event.txt').toLowerCase());
            expect(normalizedPaths).to.include(path.normalize('interface/gfx.gui').toLowerCase());
            expect(normalizedPaths).to.include('.cwtools');
        });

        it('lets general build workers write workspace files when plannedFiles are omitted', () => {
            const mockNode: TaskNode = {
                id: 'unplanned_builder_task',
                profileName: 'paradox-coder',
                prompt: 'implement script values',
                dependencies: [],
                priority: 'normal',
                status: 'pending',
                retryCount: 0,
                maxRetries: 1
            };
            const sandbox = buildSubAgentSandbox(mockNode, process.cwd());

            expect(sandbox.writeScope).to.equal(undefined);
            expect(enforceSubAgentSafety(
                sandbox,
                'replace_lines',
                { filePath: 'common/script_values/exe_samplemod_value.txt' },
                process.cwd()
            ).allowed).to.equal(true);
        });
    });

    // ── 2. 沙盒物理拦截逻辑校验 ──
    describe('enforceSubAgentSafety', () => {
        it('blocks localisation paths that the user retained, regardless of writable profile', () => {
            const sandbox = {
                agentId: 'user_owned_localisation',
                profileName: 'paradox-coder',
                deniedWriteScopes: ['localisation'],
                permissionPolicy: 'delegate_to_parent' as const,
            };

            const britishSpelling = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: 'localisation/english/demo_l_english.yml' },
                process.cwd(),
            );
            const americanSpelling = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: 'localization/english/demo_l_english.yml' },
                process.cwd(),
            );
            const unrelatedWrite = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: 'events/demo_events.txt' },
                process.cwd(),
            );

            expect(britishSpelling.allowed).to.equal(false);
            expect(americanSpelling.allowed).to.equal(false);
            expect(britishSpelling.reason).to.include('user-owned scope');
            expect(unrelatedWrite.allowed).to.equal(true);
        });

        it('只读沙盒调用写入类工具时应该直接被物理拦截', () => {
            const sandbox = {
                agentId: 'explorer_test',
                profileName: 'explore',
                writeScope: [], // 空数组
                permissionPolicy: 'deny' as const
            };

            const result = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/events.txt' }, process.cwd());
            expect(result.allowed).to.be.false;
            expect(result.reason).to.include('is read-only and cannot call file-writing tool');
        });

        it('localization-writer 沙盒写入越权路径应该被拦截，写入本地化文件顺利放行', () => {
            const sandbox = {
                agentId: 'loc_test',
                profileName: 'localization-writer',
                writeScope: ['localisation'],
                permissionPolicy: 'deny' as const
            };

            // 1) 尝试写入非本地化（非 localisation）文件，应该被拦截
            const badResult = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/events.txt' }, process.cwd());
            expect(badResult.allowed).to.be.false;
            expect(badResult.reason).to.include('blocked the write');

            // 2) 写入本地化文件，应该允许
            const goodResult = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'localisation/simp_chinese.yml' }, process.cwd());
            expect(goodResult.allowed).to.be.true;
        });

        it('gui-expert 沙盒写入非 gui 后缀文件应该被拦截，写入 gui 界面文件顺利放行', () => {
            const sandbox = {
                agentId: 'gui_test',
                profileName: 'gui-expert',
                writeScope: ['.gui'],
                permissionPolicy: 'deny' as const
            };

            // 1) 尝试写入 txt 文件，拦截
            const badResult = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/events.txt' }, process.cwd());
            expect(badResult.allowed).to.be.false;

            // 2) 写入 .gui 文件，放行
            const goodResult = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'interface/main_menu.gui' }, process.cwd());
            expect(goodResult.allowed).to.be.true;
        });

        it('keeps command and parent-owned tools blocked for sub-agents without the command capability', () => {
            const sandbox = {
                agentId: 'super_builder',
                profileName: 'gui-expert',
                writeScope: ['*'], // 全放通写入
                permissionPolicy: 'deny' as const
            };

            const cmdResult = enforceSubAgentSafety(sandbox, 'run_command', { CommandLine: 'rm -rf /' }, process.cwd());
            expect(cmdResult.allowed).to.be.false;
            expect(cmdResult.reason).to.include('run_command is disabled');
            expect(cmdResult.reason).to.include('BLOCKED_FOR_ORCHESTRATOR');

            const gitResult = enforceSubAgentSafety(sandbox, 'git_ops', { operation: 'reset' }, process.cwd());
            expect(gitResult.allowed).to.be.false;
        });

        // ── 命令能力按 Profile 目录声明放行（回归：paradox-coder 声明了 command 能力，物理层不再拦死）──
        it('lets profiles that declare the command capability run commands', () => {
            const commandSandbox = (profileName: string) => ({
                agentId: `command_${profileName}`,
                profileName,
                permissionPolicy: 'deny' as const,
            });

            // 1) paradox-coder 在目录中声明 subagentCapabilities.command → 物理层放行
            const paradoxResult = enforceSubAgentSafety(
                commandSandbox('paradox-coder'),
                'run_command',
                { CommandLine: 'echo hello' },
                process.cwd(),
            );
            expect(paradoxResult.allowed).to.equal(true);
            expect(paradoxResult.reason).to.equal(undefined);

            // 2) general-coder 的历史豁免不得回退
            const generalResult = enforceSubAgentSafety(
                commandSandbox('general-coder'),
                'run_command',
                { CommandLine: 'echo hello' },
                process.cwd(),
            );
            expect(generalResult.allowed).to.equal(true);
        });

        it('keeps run_command blocked for profiles without the command capability', () => {
            const restrictedProfiles = [
                'localization-writer',
                'localization-translator',
                'gui-expert',
                'explore',
                'planner',
                'reviewer',
            ];

            for (const profileName of restrictedProfiles) {
                const result = enforceSubAgentSafety(
                    {
                        agentId: `no_command_${profileName}`,
                        profileName,
                        permissionPolicy: 'delegate_to_parent' as const,
                    },
                    'run_command',
                    { CommandLine: 'echo hello' },
                    process.cwd(),
                );
                expect(result.allowed, profileName).to.equal(false);
                expect(result.reason, profileName).to.include('run_command is disabled for orchestrator sub-agents');
                expect(result.reason, profileName).to.include('BLOCKED_FOR_ORCHESTRATOR');
            }
        });

        it('keeps unknown profiles and non-command privileged tools blocked', () => {
            const unknownProfile = enforceSubAgentSafety(
                {
                    agentId: 'unknown_profile_child',
                    profileName: 'custom-user-profile',
                    permissionPolicy: 'delegate_to_parent' as const,
                },
                'run_command',
                { CommandLine: 'echo hello' },
                process.cwd(),
            );
            expect(unknownProfile.allowed).to.equal(false);
            expect(unknownProfile.reason).to.include('run_command is disabled for orchestrator sub-agents');

            // 命令能力只对 run_command 生效：声明了 command 的 profile 仍不能调度进程
            for (const profileName of ['paradox-coder', 'general-coder']) {
                const processResult = enforceSubAgentSafety(
                    {
                        agentId: `process_${profileName}`,
                        profileName,
                        permissionPolicy: 'delegate_to_parent' as const,
                    },
                    'manage_process',
                    { action: 'list' },
                    process.cwd(),
                );
                expect(processResult.allowed, profileName).to.equal(false);
                expect(processResult.reason, profileName).to.include('manage_process');
            }

            // web / git / orchestration 特权工具未放松
            const gitResult = enforceSubAgentSafety(
                {
                    agentId: 'git_paradox_coder',
                    profileName: 'paradox-coder',
                    permissionPolicy: 'delegate_to_parent' as const,
                },
                'git_ops',
                { operation: 'reset' },
                process.cwd(),
            );
            expect(gitResult.allowed).to.equal(false);
        });

        it('blocks non-file-scoped mutating tools in read-only sub-agent sandboxes', () => {
            const sandbox = {
                agentId: 'readonly_state_tool',
                profileName: 'explore',
                writeScope: [],
                permissionPolicy: 'deny' as const
            };

            const result = enforceSubAgentSafety(
                sandbox,
                'remove_ignored_diagnostic',
                { diagnosticKey: 'bad_key', reason: 'test' },
                process.cwd()
            );

            expect(result.allowed).to.equal(false);
            expect(result.reason).to.include('remove_ignored_diagnostic');
        });

        it('allows writable workers to store topic walkthrough artifacts', () => {
            const sandbox = {
                agentId: 'builder_topic_artifact',
                profileName: 'paradox-coder',
                writeScope: ['common/buildings/samplemod_buildings.txt', '.cwtools'],
                permissionPolicy: 'delegate_to_parent' as const
            };

            const result = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: '.cwtools/topic_123/walkthrough.md' },
                process.cwd()
            );

            expect(result.allowed).to.be.true;
        });

        // ── 跨平台与作用域边界（采纳评审 #3：directory-scope-from-file / 子串逃逸 / 前缀边界 / 大小写）──
        it('directory-scope-from-file：放行同目录兄弟文件写入', () => {
            const sandbox = {
                agentId: 'builder_sibling',
                profileName: 'paradox-coder',
                writeScope: ['common/buildings/samplemod_buildings.txt', '.cwtools'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            // 同目录的另一个文件（由文件推导出目录作用域）→ 放行
            const sibling = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/buildings/sol_buildings.txt' }, process.cwd());
            expect(sibling.allowed).to.be.true;
            // 同目录更深一层 → 仍在目录内 → 放行
            const deeper = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/buildings/sub/extra.txt' }, process.cwd());
            expect(deeper.allowed).to.be.true;
        });

        it('子串逃逸：拒绝 common/buildings_evil（防前缀截断绕过）', () => {
            const sandbox = {
                agentId: 'builder_escape',
                profileName: 'paradox-coder',
                writeScope: ['common/buildings/samplemod_buildings.txt'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            const escape = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/buildings_evil/backdoor.txt' }, process.cwd());
            expect(escape.allowed).to.be.false;
            expect(escape.reason).to.include('blocked the write');
        });

        it('.cwtools 前缀边界：拒绝相似目录，仅精确或 / 前缀放行', () => {
            const sandbox = {
                agentId: 'builder_topic_boundary',
                profileName: 'paradox-coder',
                writeScope: ['.cwtools'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            const evil = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: '.cwtools-evil/x.md' }, process.cwd());
            expect(evil.allowed).to.be.false;
            const ok = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: '.cwtools/topic/walkthrough.md' }, process.cwd());
            expect(ok.allowed).to.be.true;
        });

        it('平台条件折叠：Windows 大小写无关、Linux 区分大小写', () => {
            const sandbox = {
                agentId: 'builder_case',
                profileName: 'paradox-coder',
                writeScope: ['common/buildings/samplemod_buildings.txt'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            // 大小写不同的目录：Windows（大小写不敏感）放行，Linux（大小写敏感）拦截
            const caseVariant = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/Buildings/Other.txt' }, process.cwd());
            if (process.platform === 'win32') {
                expect(caseVariant.allowed).to.be.true;
            } else {
                expect(caseVariant.allowed).to.be.false;
            }
        });

        it('非写入且无害的工具，应该在默认沙盒下放行', () => {
            const sandbox = {
                agentId: 'builder_read',
                profileName: 'paradox-coder',
                writeScope: ['common/events.txt'],
                permissionPolicy: 'deny' as const
            };

            const result = enforceSubAgentSafety(sandbox, 'read_file', { TargetFile: 'common/events.txt' }, process.cwd());
            expect(result.allowed).to.be.true;
        });

        it('allows plan-mode artifact edits without allowing project file edits', () => {
            const workspaceRoot = process.cwd();
            const sandbox = {
                agentId: 'plan_card_editor',
                profileName: 'planner',
                writeScope: [],
                permissionPolicy: 'deny' as const
            };

            const artifactResult = enforceSubAgentSafety(
                sandbox,
                'edit_file',
                { filePath: path.join(workspaceRoot, '.cwtools', 'topic-123', 'annotations.md') },
                workspaceRoot
            );
            expect(artifactResult.allowed).to.equal(true);

            const projectResult = enforceSubAgentSafety(
                sandbox,
                'edit_file',
                { filePath: path.join(workspaceRoot, 'common', 'events', 'test.txt') },
                workspaceRoot
            );
            expect(projectResult.allowed).to.equal(false);
        });
    });
});
