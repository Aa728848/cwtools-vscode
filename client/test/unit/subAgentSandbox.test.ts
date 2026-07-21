/**
 * Orchestrator 子 Agent 物理沙盒隔离组件 - 单元测试 (Phase 5)
 */

import { expect } from 'chai';
import * as path from 'path';

describe('SubAgentSandbox', () => {
    let buildSubAgentSandbox: typeof import('../../extension/ai/orchestrator/subAgentSandbox').buildSubAgentSandbox;
    let enforceSubAgentSafety: typeof import('../../extension/ai/orchestrator/subAgentSandbox').enforceSubAgentSafety;
    type TaskNode = import('../../extension/ai/orchestrator/types').TaskNode;

    before(() => {
        const sandboxModule = require('../../extension/ai/orchestrator/subAgentSandbox');
        buildSubAgentSandbox = sandboxModule.buildSubAgentSandbox;
        enforceSubAgentSafety = sandboxModule.enforceSubAgentSafety;
    });

    // ── 1. 沙盒构建生成校验 ──
    describe('buildSubAgentSandbox', () => {
        it('explorer (只读角色) — 应该生成空的 writeScope', () => {
            const mockNode: TaskNode = {
                id: 'explore_task',
                agentType: 'explore',
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
        });

        it('reviewer (只读角色) — 应该生成空的 writeScope', () => {
            const mockNode: TaskNode = {
                id: 'review_task',
                agentType: 'review',
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

        it('locWriter — 应该将 writeScope 限制为 localisation', () => {
            const mockNode: TaskNode = {
                id: 'loc_task',
                agentType: 'loc_writer',
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

        it('guiExpert — 应该将 writeScope 限制为 .gui', () => {
            const mockNode: TaskNode = {
                id: 'gui_task',
                agentType: 'gui_expert',
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
                agentType: 'build',
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
                agentType: 'build',
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
                { filePath: 'common/script_values/exe_kuat_value.txt' },
                process.cwd()
            ).allowed).to.equal(true);
        });
    });

    // ── 2. 沙盒物理拦截逻辑校验 ──
    describe('enforceSubAgentSafety', () => {
        it('只读沙盒调用写入类工具时应该直接被物理拦截', () => {
            const sandbox = {
                agentId: 'explorer_test',
                role: 'explore',
                mode: 'explore' as any,
                writeScope: [], // 空数组
                permissionPolicy: 'deny' as const
            };

            const result = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/events.txt' }, process.cwd());
            expect(result.allowed).to.be.false;
            expect(result.reason).to.include('is read-only and cannot call file-writing tool');
        });

        it('locWriter 沙盒写入越权路径应该被拦截，写入本地化文件顺利放行', () => {
            const sandbox = {
                agentId: 'loc_test',
                role: 'locWriter',
                mode: 'loc_writer' as any,
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

        it('guiExpert 沙盒写入非 gui 后缀文件应该被拦截，写入 gui 界面文件顺利放行', () => {
            const sandbox = {
                agentId: 'gui_test',
                role: 'guiExpert',
                mode: 'gui_expert' as any,
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

        it('keeps command and parent-owned tools blocked for sub-agents', () => {
            const sandbox = {
                agentId: 'super_builder',
                role: 'builder',
                mode: 'build' as any,
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

        it('blocks non-file-scoped mutating tools in read-only sub-agent sandboxes', () => {
            const sandbox = {
                agentId: 'readonly_state_tool',
                role: 'explore',
                mode: 'explore' as any,
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
                role: 'build',
                mode: 'build' as any,
                writeScope: ['common/buildings/kuat_buildings.txt', '.cwtools'],
                permissionPolicy: 'delegate_to_parent' as const
            };

            const result = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: '.cwtools-ai/topic_123/walkthrough.md' },
                process.cwd()
            );

            expect(result.allowed).to.be.true;
        });

        it('keeps legacy topic artifact scopes compatible with both storage directory names', () => {
            const sandbox = {
                agentId: 'legacy_builder_topic_artifact',
                role: 'build',
                mode: 'build' as any,
                writeScope: ['.cwtools-ai'],
                permissionPolicy: 'delegate_to_parent' as const
            };

            const legacyResult = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: '.cwtools-ai/topic_123/walkthrough.md' },
                process.cwd()
            );
            const primaryResult = enforceSubAgentSafety(
                sandbox,
                'write_file',
                { TargetFile: '.cwtools/topic_123/walkthrough.md' },
                process.cwd()
            );

            expect(legacyResult.allowed).to.be.true;
            expect(primaryResult.allowed).to.be.true;
        });

        // ── 跨平台与作用域边界（采纳评审 #3：directory-scope-from-file / 子串逃逸 / 前缀边界 / 大小写）──
        it('directory-scope-from-file：放行同目录兄弟文件写入', () => {
            const sandbox = {
                agentId: 'builder_sibling',
                role: 'build',
                mode: 'build' as any,
                writeScope: ['common/buildings/kuat_buildings.txt', '.cwtools'],
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
                role: 'build',
                mode: 'build' as any,
                writeScope: ['common/buildings/kuat_buildings.txt'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            const escape = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: 'common/buildings_evil/backdoor.txt' }, process.cwd());
            expect(escape.allowed).to.be.false;
            expect(escape.reason).to.include('blocked the write');
        });

        it('.cwtools-ai 前缀边界：拒绝 .cwtools-ai-evil，仅精确或 / 前缀放行', () => {
            const sandbox = {
                agentId: 'builder_topic_boundary',
                role: 'build',
                mode: 'build' as any,
                writeScope: ['.cwtools'],
                permissionPolicy: 'delegate_to_parent' as const
            };
            const evil = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: '.cwtools-ai-evil/x.md' }, process.cwd());
            expect(evil.allowed).to.be.false;
            const ok = enforceSubAgentSafety(sandbox, 'write_file', { TargetFile: '.cwtools/topic/walkthrough.md' }, process.cwd());
            expect(ok.allowed).to.be.true;
        });

        it('平台条件折叠：Windows 大小写无关、Linux 区分大小写', () => {
            const sandbox = {
                agentId: 'builder_case',
                role: 'build',
                mode: 'build' as any,
                writeScope: ['common/buildings/kuat_buildings.txt'],
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
                role: 'builder',
                mode: 'build' as any,
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
                role: 'plan',
                mode: 'plan' as any,
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
