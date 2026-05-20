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
            expect(result.reason).to.include('属于只读角色，禁止调用物理写入工具');
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
            expect(badResult.reason).to.include('写入目标文件路径');

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

        it('高危敏感特权工具无视角色属性，必须被直接物理拦截阻断', () => {
            const sandbox = {
                agentId: 'super_builder',
                role: 'builder',
                mode: 'build' as any,
                writeScope: ['*'], // 全放通写入
                permissionPolicy: 'deny' as const
            };

            // 1) 敏感终端工具，被拦截
            const cmdResult = enforceSubAgentSafety(sandbox, 'run_command', { CommandLine: 'rm -rf /' }, process.cwd());
            expect(cmdResult.allowed).to.be.false;
            expect(cmdResult.reason).to.include('敏感特权工具');

            // 2) 敏感 git 工具，被拦截
            const gitResult = enforceSubAgentSafety(sandbox, 'git_ops', { operation: 'reset' }, process.cwd());
            expect(gitResult.allowed).to.be.false;
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
    });
});
