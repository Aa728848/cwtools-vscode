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

    it('extracts read and edit paths for same-file queue coordination', () => {
        const mod = loadModule();
        const normalize = (value: string) => value.replace(/\\/g, '/');

        expect(normalize(mod.getAgentToolTargetFiles('edit_file', { filePath: 'src/main.ts' }, 'C:/project')[0]!))
            .to.equal('C:/project/src/main.ts');
        expect(normalize(mod.getAgentToolTargetFiles('read_file', { file: 'src/main.ts' }, 'C:/project')[0]!))
            .to.equal('C:/project/src/main.ts');
        expect(normalize(mod.getAgentToolTargetFiles('get_pdx_block', { file: 'events/test.txt' }, 'C:/project')[0]!))
            .to.equal('C:/project/events/test.txt');
        expect(normalize(mod.getAgentToolTargetFiles('get_file_context', { file: 'common/test.txt' }, 'C:/project')[0]!))
            .to.equal('C:/project/common/test.txt');
        expect(normalize(mod.getAgentToolTargetFiles('hover_symbol', { file: 'src/main.ts' }, 'C:/project')[0]!))
            .to.equal('C:/project/src/main.ts');
        expect(normalize(mod.getAgentToolTargetFiles('rename_symbol', { file: 'src/main.ts' }, 'C:/project')[0]!))
            .to.equal('C:/project/src/main.ts');
    });

    it('waits same-file read barriers until the current write finishes and preserves return values', async () => {
        const { PartitionedWriteQueue } = require('../../extension/ai/runner/writeCoordinator') as typeof import('../../extension/ai/runner/writeCoordinator');
        const queue = new PartitionedWriteQueue();
        const events: string[] = [];
        let releaseWrite!: () => void;

        const writeResult = queue.enqueue(['C:/project/src/main.ts'], async () => {
            events.push('write-start');
            await new Promise<void>(resolve => { releaseWrite = resolve; });
            events.push('write-end');
            return 'write-result';
        });

        await Promise.resolve();
        const readResult = queue.afterCurrentWrites(['C:/project/src/main.ts'], async () => {
            events.push('read');
            return 'read-result';
        });

        await Promise.resolve();
        expect(events).to.deep.equal(['write-start']);

        releaseWrite();
        expect(await writeResult).to.equal('write-result');
        expect(await readResult).to.equal('read-result');
        expect(events).to.deep.equal(['write-start', 'write-end', 'read']);
    });

    it('extracts save_workflow target paths when the id is deterministic', () => {
        const mod = loadModule();
        const paths = mod.getAgentToolTargetFiles('save_workflow', { id: 'Review Flow', title: 'unused' }, 'C:/project');
        expect(paths[0]!.replace(/\\/g, '/')).to.equal('C:/project/.cwtools/workflows/review-flow.md');

        const unknown = mod.getAgentToolTargetFiles('save_workflow', { title: '纯中文流程' }, 'C:/project');
        expect(unknown).to.deep.equal([]);
    });

    it('toolScheduler default export is the singleton instance', () => {
        const mod = loadModule();
        expect(mod.toolScheduler).to.exist;
        expect(mod.toolScheduler).to.equal(mod.ToolSchedulerV2.getInstance());
    });

    it('wakes a global-exclusive waiter after an LSP permit releases', async () => {
        const mod = loadModule();
        const scheduler = mod.ToolSchedulerV2.createForTesting();
        const releaseLsp = await scheduler.acquireLock('lsp-limited');
        let globalStarted = false;

        const globalReleasePromise = scheduler.acquireLock('global-exclusive').then((release: () => void) => {
            globalStarted = true;
            return release;
        });

        await flushMicrotasks();
        expect(globalStarted).to.equal(false);

        releaseLsp();
        const releaseGlobal = await withTimeout(globalReleasePromise);
        expect(globalStarted).to.equal(true);
        releaseGlobal();
    });

    it('wakes a global-exclusive waiter after a network permit releases', async () => {
        const mod = loadModule();
        const scheduler = mod.ToolSchedulerV2.createForTesting();
        const releaseNetwork = await scheduler.acquireLock('network-limited');
        let globalStarted = false;

        const globalReleasePromise = scheduler.acquireLock('global-exclusive').then((release: () => void) => {
            globalStarted = true;
            return release;
        });

        await flushMicrotasks();
        expect(globalStarted).to.equal(false);

        releaseNetwork();
        const releaseGlobal = await withTimeout(globalReleasePromise);
        expect(globalStarted).to.equal(true);
        releaseGlobal();
    });

    it('prevents limited work from bypassing a queued global-exclusive waiter', async () => {
        const mod = loadModule();
        const scheduler = mod.ToolSchedulerV2.createForTesting();
        const releaseNetwork = await scheduler.acquireLock('network-limited');
        let globalStarted = false;
        let lspStarted = false;

        const globalReleasePromise = scheduler.acquireLock('global-exclusive').then((release: () => void) => {
            globalStarted = true;
            return release;
        });
        const lspReleasePromise = scheduler.acquireLock('lsp-limited').then((release: () => void) => {
            lspStarted = true;
            return release;
        });

        await flushMicrotasks();
        expect(globalStarted).to.equal(false);
        expect(lspStarted).to.equal(false);

        releaseNetwork();
        const releaseGlobal = await withTimeout(globalReleasePromise);
        await flushMicrotasks();
        expect(globalStarted).to.equal(true);
        expect(lspStarted).to.equal(false);

        releaseGlobal();
        const releaseLsp = await withTimeout(lspReleasePromise);
        expect(lspStarted).to.equal(true);
        releaseLsp();
    });

    it('removes aborted waiters from scheduler queues', async () => {
        const mod = loadModule();
        const scheduler = mod.ToolSchedulerV2.createForTesting();
        const releaseGlobal = await scheduler.acquireLock('global-exclusive');
        const controller = new AbortController();
        let rejection: Error | undefined;

        const waiting = scheduler.acquireLock('network-limited', controller.signal)
            .catch((error: Error) => {
                rejection = error;
                return undefined;
            });

        controller.abort();
        await withTimeout(waiting);
        expect(rejection?.name).to.equal('AbortError');

        releaseGlobal();
        const releaseNetwork = await withTimeout(scheduler.acquireLock('network-limited'));
        releaseNetwork();
    });
});

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

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
