import { expect } from 'chai';

/**
 * 跨平台保守只读判定（采纳评审 #2）：externalTools.isReadOnlyRunCommand 是 run_command
 * auto-approve 的真门。验证无歧义只读 POSIX 命令被放行，而 sed -i / find -delete /
 * find -exec / awk 写 / rm -rf / mkdir / chmod / tee / 重定向 一律不被判为只读。
 */
describe('ExternalToolHandler.isReadOnlyRunCommand (POSIX 跨平台)', () => {
    function isReadOnly(cmd: string): boolean {
        const { ExternalToolHandler } = loadExternalToolsModule();
        // isReadOnlyRunCommand 不使用 this，可直接经原型调用
        return (ExternalToolHandler.prototype as any).isReadOnlyRunCommand.call(null, cmd);
    }

    it('放行无歧义只读命令（含新增 POSIX）', () => {
        for (const cmd of [
            'git status', 'stat foo.txt', 'printenv PATH', 'cut -d, -f1 a.csv',
            'realpath .', 'tree src', 'cat a | tr a-z A-Z', 'basename /x/y',
        ]) {
            expect(isReadOnly(cmd), cmd).to.equal(true);
        }
    });

    it('不把隐藏写/执行命令判为只读', () => {
        for (const cmd of [
            'sed -i s/a/b/ f.txt',
            'find . -name "*.tmp" -delete',
            'find . -type f -exec rm {} +',
            'awk \'{print > "out"}\' in',
            'rm -rf build',
            'rm -fr build',
            'mkdir newdir',
            'chmod +x run.sh',
            'chown me f',
            'ln -s a b',
            'tee out.txt',
            'echo hi > f.txt',
        ]) {
            expect(isReadOnly(cmd), cmd).to.equal(false);
        }
    });
});

function loadExternalToolsModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/tools/externalTools') as typeof import('../../extension/ai/tools/externalTools');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
};
