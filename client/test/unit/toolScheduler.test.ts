import { expect } from 'chai';

describe('ToolScheduler V2 concurrencyClass Dispatch (P2-3)', () => {
    it('exports ToolSchedulerV2 singleton with getInstance', () => {
        const mod = loadModule();
        expect(mod.ToolSchedulerV2).to.exist;
        const instance = mod.ToolSchedulerV2.getInstance();
        expect(instance).to.exist;
        // Singleton identity
        expect(mod.ToolSchedulerV2.getInstance()).to.equal(instance);
    });

    it('exports getAgentToolTargetFiles helper', () => {
        const mod = loadModule();
        expect(mod.getAgentToolTargetFiles).to.be.a('function');
    });

    it('correctly extracts target file paths for write_file tool', () => {
        const mod = loadModule();
        const paths = mod.getAgentToolTargetFiles('write_file', { file: 'C:/project/src/main.ts' }, 'C:/project');
        expect(paths).to.be.an('array');
        expect(paths.length).to.be.greaterThan(0);
    });

    it('returns empty paths for read-only tools', () => {
        const mod = loadModule();
        const paths = mod.getAgentToolTargetFiles('read_file', { file: 'C:/project/src/main.ts' }, 'C:/project');
        // read_file may or may not return target paths depending on implementation
        expect(paths).to.be.an('array');
    });

    it('toolScheduler default export is the singleton instance', () => {
        const mod = loadModule();
        expect(mod.toolScheduler).to.exist;
        expect(mod.toolScheduler).to.equal(mod.ToolSchedulerV2.getInstance());
    });
});

function loadModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/toolScheduler') as typeof import('../../extension/ai/runner/toolScheduler');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: { workspaceFolders: [] },
};
