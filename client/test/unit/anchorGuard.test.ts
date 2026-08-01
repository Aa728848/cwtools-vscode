import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Anchor-aware repeated write-failure guard (P0 design 1).
 * Uses real temp workspaces; ReadTracker is absent in this harness (no
 * context.agentRunner), so the write gate does not interfere.
 */

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
        workspaceFolders: [],
    },
    Uri: {
        file: (f: string) => ({ fsPath: f, scheme: 'file', path: f, toString: () => `file://${f}` }),
    },
    languages: {
        getDiagnostics: () => [],
    },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, [request, ...args]);
};

const { FileToolHandler } = require('../../extension/ai/tools/fileTools') as typeof import('../../extension/ai/tools/fileTools');
const { previewMatch, fuzzyReplace } = require('../../extension/ai/tools/replacerSuite') as typeof import('../../extension/ai/tools/replacerSuite');
const { ReplacerError } = require('../../extension/ai/tools/editFailure') as typeof import('../../extension/ai/tools/editFailure');

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-anchor-guard-tests');

function makeWorkspace(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'ws-'));
}

function makeContext(scopeId?: string): any {
    // domain: 'general' 走无 LSP 的诊断分支，避免测试环境依赖语言服务器。
    return { runnerOptions: { topicId: 'topic-a', domain: 'general' }, scopeId };
}

describe('anchor 级重复写失败守卫（P0 设计 1）', () => {
    let workspaceRoot: string;
    let handler: InstanceType<typeof FileToolHandler>;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        handler = new FileToolHandler({ workspaceRoot, fileWriteMode: 'auto' });
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function writeWorkspaceFile(rel: string, content: string): void {
        const abs = path.join(workspaceRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }

    function readWorkspaceFile(rel: string): string {
        return fs.readFileSync(path.join(workspaceRoot, rel), 'utf8');
    }

    it('同一 stale anchor 连续 2 次失败后，第 3 次同签名被拦截且文件未写', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\ngamma\n');
        const args = { filePath: 'a.txt', oldString: 'does not exist', newString: 'x' };

        const r1 = await handler.editFile({ ...args }, makeContext('run-1'));
        const r2 = await handler.editFile({ ...args }, makeContext('run-1'));
        expect(r1.success).to.equal(false);
        expect(r2.success).to.equal(false);
        expect(r2.message).to.not.include('BLOCKED by anchor guard');

        const r3 = await handler.editFile({ ...args }, makeContext('run-1'));
        expect(r3.success).to.equal(false);
        expect(r3.message).to.include('BLOCKED by anchor guard');
        expect(readWorkspaceFile('a.txt')).to.equal('alpha\nbeta\ngamma\n');
    });

    it('ambiguous anchor 同样被守卫', async () => {
        writeWorkspaceFile('a.txt', 'dup\ndup\nother\n');
        const args = { filePath: 'a.txt', oldString: 'dup', newString: 'x' };
        await handler.editFile({ ...args }, makeContext('run-1'));
        await handler.editFile({ ...args }, makeContext('run-1'));
        const r3 = await handler.editFile({ ...args }, makeContext('run-1'));
        expect(r3.message).to.include('BLOCKED by anchor guard');
    });

    it('错误类别变化时不沿用旧类别预算', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\n');
        const args = { filePath: 'a.txt', oldString: 'target', newString: 'x' };
        await handler.editFile({ ...args }, makeContext('run-1'));
        await handler.editFile({ ...args }, makeContext('run-1'));

        // not_found 已耗尽，但当前文件把同一 anchor 变成 ambiguous；新的
        // errorClass 应获得自己的两次预算，不能被旧 not_found 立即拦截。
        writeWorkspaceFile('a.txt', 'target\ntarget\n');
        const ambiguous1 = await handler.editFile({ ...args }, makeContext('run-1'));
        const ambiguous2 = await handler.editFile({ ...args }, makeContext('run-1'));
        expect(ambiguous1.message).to.include('Multiple matches found');
        expect(ambiguous1.message).to.not.include('BLOCKED by anchor guard');
        expect(ambiguous2.message).to.not.include('BLOCKED by anchor guard');

        const ambiguous3 = await handler.editFile({ ...args }, makeContext('run-1'));
        expect(ambiguous3.message).to.include('BLOCKED by anchor guard');
        expect(ambiguous3.message).to.include('anchor_ambiguous');
    });

    it('同文件不同 anchor（新策略）不触发拦截', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\ngamma\n');
        await handler.editFile({ filePath: 'a.txt', oldString: 'missing one', newString: 'x' }, makeContext('run-1'));
        await handler.editFile({ filePath: 'a.txt', oldString: 'missing one', newString: 'x' }, makeContext('run-1'));
        const r = await handler.editFile({ filePath: 'a.txt', oldString: 'missing two', newString: 'x' }, makeContext('run-1'));
        expect(r.success).to.equal(false);
        expect(r.message).to.not.include('BLOCKED by anchor guard');
        expect(r.message).to.include('Content not found');
    });

    it('外部修改使 anchor 成立后 preview 放行且签名清除', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\n');
        await handler.editFile({ filePath: 'a.txt', oldString: 'betaX', newString: 'y' }, makeContext('run-1'));
        await handler.editFile({ filePath: 'a.txt', oldString: 'betaX', newString: 'y' }, makeContext('run-1'));
        // 外部修改：写入 'betaX'，anchor 成立
        writeWorkspaceFile('a.txt', 'alpha\nbetaX\n');
        const r = await handler.editFile({ filePath: 'a.txt', oldString: 'betaX', newString: 'y' }, makeContext('run-1'));
        expect(r.success).to.equal(true);
        expect(readWorkspaceFile('a.txt')).to.equal('alpha\ny\n');
    });

    it('同路径成功写入不清除其他 anchor 的签名（惰性清除）', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\ngamma\n');
        // anchor A 失败两次
        await handler.editFile({ filePath: 'a.txt', oldString: 'missing A', newString: 'x' }, makeContext('run-1'));
        await handler.editFile({ filePath: 'a.txt', oldString: 'missing A', newString: 'x' }, makeContext('run-1'));
        // 同文件 anchor B 成功写入
        const ok = await handler.editFile({ filePath: 'a.txt', oldString: 'beta', newString: 'BETA' }, makeContext('run-1'));
        expect(ok.success).to.equal(true);
        // anchor A 第 3 次仍应被拦截（B 的成功没有清掉 A 的签名）
        const r = await handler.editFile({ filePath: 'a.txt', oldString: 'missing A', newString: 'x' }, makeContext('run-1'));
        expect(r.message).to.include('BLOCKED by anchor guard');
    });

    it('scopeId 隔离：两个 scope 对同一文件同一 anchor 互不计数', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\n');
        const args = { filePath: 'a.txt', oldString: 'missing', newString: 'x' };
        // 父 scope 失败两次
        await handler.editFile({ ...args }, makeContext('run-parent'));
        await handler.editFile({ ...args }, makeContext('run-parent'));
        // 子 scope 前两次不应被父 scope 的计数拦截
        const c1 = await handler.editFile({ ...args }, makeContext('run-child'));
        const c2 = await handler.editFile({ ...args }, makeContext('run-child'));
        expect(c1.message).to.not.include('BLOCKED by anchor guard');
        expect(c2.message).to.not.include('BLOCKED by anchor guard');
        // 子 scope 自己的第 3 次被拦截
        const c3 = await handler.editFile({ ...args }, makeContext('run-child'));
        expect(c3.message).to.include('BLOCKED by anchor guard');
    });

    it('路径别名（./ 前缀 vs 绝对路径）命中同一条签名', async () => {
        writeWorkspaceFile('common/alias.txt', 'one\ntwo\n');
        const abs = path.join(workspaceRoot, 'common', 'alias.txt');
        await handler.editFile({ filePath: './common/alias.txt', oldString: 'missing', newString: 'x' }, makeContext('run-1'));
        await handler.editFile({ filePath: abs, oldString: 'missing', newString: 'x' }, makeContext('run-1'));
        const r3 = await handler.editFile({ filePath: 'common/alias.txt', oldString: 'missing', newString: 'x' }, makeContext('run-1'));
        expect(r3.message).to.include('BLOCKED by anchor guard');
    });

    it('invalid_args（空 oldString / 非法行范围）重复出现也永不拦截', async () => {
        writeWorkspaceFile('a.txt', 'alpha\nbeta\n');
        for (let i = 0; i < 3; i++) {
            const r = await handler.editFile({ filePath: 'a.txt', oldString: '', newString: 'x' }, makeContext('run-1'));
            expect(r.success).to.equal(false);
            expect(r.message).to.not.include('BLOCKED by anchor guard');
        }
        for (let i = 0; i < 3; i++) {
            const r = await handler.replaceLines({ filePath: 'a.txt', startLine: 99, endLine: 100, newContent: 'x' }, makeContext('run-1'));
            expect(r.success).to.equal(false);
            expect(r.message).to.not.include('BLOCKED by anchor guard');
        }
    });

    it('replace_lines：expectedContent stale 两次后拦截；外部修复后 preview 放行', async () => {
        writeWorkspaceFile('a.txt', 'l1\nl2\nl3\n');
        const args = { filePath: 'a.txt', startLine: 1, endLine: 2, newContent: 'x\ny', expectedContent: 'OLD1\nOLD2' };
        const r1 = await handler.replaceLines({ ...args }, makeContext('run-1'));
        const r2 = await handler.replaceLines({ ...args }, makeContext('run-1'));
        expect(r1.success).to.equal(false);
        expect(r2.message).to.not.include('BLOCKED by anchor guard');

        const r3 = await handler.replaceLines({ ...args }, makeContext('run-1'));
        expect(r3.message).to.include('BLOCKED by anchor guard');
        expect(readWorkspaceFile('a.txt')).to.equal('l1\nl2\nl3\n');

        // 外部把 1-2 行改成 expectedContent → preview 通过，放行并成功
        writeWorkspaceFile('a.txt', 'OLD1\nOLD2\nl3\n');
        const r4 = await handler.replaceLines({ ...args }, makeContext('run-1'));
        expect(r4.success).to.equal(true);
        expect(readWorkspaceFile('a.txt')).to.equal('x\ny\nl3\n');
    });

    it('replace_lines：行号修正（内容未变）时 preview 放行，不误拦截', async () => {
        // 回归：守卫曾因"内容哈希未变"跳过 preview，导致模型修正行号后被误拦截。
        writeWorkspaceFile('a.txt', 'l1\nl2\nl3\nl4\n');
        // 用错误的行范围 + 自复制的 expectedContent 失败两次
        const wrong = { filePath: 'a.txt', startLine: 1, endLine: 2, newContent: 'x\ny', expectedContent: 'l3\nl4' };
        await handler.replaceLines({ ...wrong }, makeContext('run-1'));
        await handler.replaceLines({ ...wrong }, makeContext('run-1'));
        // 第三次：expectedContent 不变，行号修正为 3-4 —— preview 应通过并放行
        const fixed = { ...wrong, startLine: 3, endLine: 4 };
        const r = await handler.replaceLines({ ...fixed }, makeContext('run-1'));
        expect(r.success).to.equal(true);
        expect(readWorkspaceFile('a.txt')).to.equal('l1\nl2\nx\ny\n');
    });

    it('resetEditFailureTracking(scopeId) 只清对应 scope', async () => {
        writeWorkspaceFile('a.txt', 'alpha\n');
        const args = { filePath: 'a.txt', oldString: 'missing', newString: 'x' };
        await handler.editFile({ ...args }, makeContext('run-parent'));
        await handler.editFile({ ...args }, makeContext('run-parent'));
        handler.resetEditFailureTracking('run-parent');
        const r = await handler.editFile({ ...args }, makeContext('run-parent'));
        expect(r.message).to.not.include('BLOCKED by anchor guard');
    });
});

describe('replacerSuite previewMatch / ReplacerError', () => {
    it('previewMatch：唯一匹配 / 多匹配 / 无匹配', () => {
        expect(previewMatch('a\nb\nc', 'b')).to.equal('matched');
        expect(previewMatch('a\nb\nb', 'b')).to.equal('ambiguous');
        expect(previewMatch('a\nb\nc', 'zz')).to.equal('not_found');
    });

    it('previewMatch 复用 fuzzyReplace 的行号前缀剥离', () => {
        expect(previewMatch('alpha\nbeta', '1 | alpha')).to.equal('matched');
    });

    it('fuzzyReplace 抛出带 kind 的 ReplacerError，message 不变', () => {
        expect(() => fuzzyReplace('dup dup', 'dup', 'x', false)).to.throw(ReplacerError, /Multiple matches found/);
        try {
            fuzzyReplace('abc', 'zz', 'x', false);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).to.be.instanceOf(ReplacerError);
            expect((e as InstanceType<typeof ReplacerError>).kind).to.equal('no_match');
            expect((e as Error).message).to.include('Content not found');
        }
    });
});
