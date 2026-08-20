/**
 * Regressions for the sub-agent approval/cancellation lifecycle:
 *
 * 1. A permission request must lose to the run's abort signal instead of hanging
 *    forever on a card nobody is watching (deny-on-abort — an abort is not consent).
 * 2. Stopping the main agent must cancel the background sub-agent graphs it owns,
 *    whose abort chain is bound to the turn that started them.
 */

import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: { executeCommand: async () => undefined },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, [request, ...args]);
};

// ── 1. Abort-aware permission requests ───────────────────────────────────────

describe('requestPermissionWithAbort', () => {
    let request: typeof import('../../extension/ai/runner/permissionRequest').requestPermissionWithAbort;

    before(() => {
        request = require('../../extension/ai/runner/permissionRequest').requestPermissionWithAbort;
    });

    const params = { id: 'p1', tool: 'run_command', description: 'do a thing' };

    it('无 abort 信号时原样透传宿主结果', async () => {
        expect(await request(async () => true, params)).to.equal(true);
        expect(await request(async () => false, params)).to.equal(false);
    });

    it('信号已中止：直接拒绝且完全不打扰宿主', async () => {
        const controller = new AbortController();
        controller.abort();
        let called = false;
        const allowed = await request(async () => { called = true; return true; }, params, controller.signal);
        expect(allowed).to.equal(false);
        expect(called).to.equal(false);
    });

    it('等待期间被中止：解析为拒绝，而不是永久挂起', async () => {
        const controller = new AbortController();
        // A card nobody clicks: the host promise never settles on its own.
        const pending = request(() => new Promise<boolean>(() => { /* never */ }), params, controller.signal);
        controller.abort();
        expect(await pending).to.equal(false);
    });

    it('中止不等于同意：批准竞速失败时结果必须是拒绝', async () => {
        const controller = new AbortController();
        let approve: ((value: boolean) => void) | undefined;
        const pending = request(
            () => new Promise<boolean>(resolve => { approve = resolve; }),
            params,
            controller.signal,
        );
        controller.abort();
        approve?.(true); // A late click must not flip the already-denied result.
        expect(await pending).to.equal(false);
    });

    it('正常批准后移除 abort 监听，不在长命信号上泄漏', async () => {
        const controller = new AbortController();
        const allowed = await request(async () => true, params, controller.signal);
        expect(allowed).to.equal(true);
        // A later abort must not throw or resolve anything a second time.
        expect(() => controller.abort()).to.not.throw();
    });

    it('把完整请求参数与上下文原样交给宿主', async () => {
        const seen: unknown[] = [];
        await request(
            async (id, tool, description, command, context) => {
                seen.push(id, tool, description, command, context);
                return true;
            },
            { id: 'p9', tool: 'write_file', description: 'why', command: 'git status', context: { marker: 1 } },
        );
        expect(seen).to.deep.equal(['p9', 'write_file', 'why', 'git status', { marker: 1 }]);
    });
});

// ── 2. Stopping the main agent stops its background graphs ────────────────────

describe('backgroundOrchestrators.cancelAllForTopic', () => {
    let registry: typeof import('../../extension/ai/orchestrator/backgroundOrchestrators').backgroundOrchestrators;

    before(() => {
        registry = require('../../extension/ai/orchestrator/backgroundOrchestrators').backgroundOrchestrators;
    });

    /** Start a graph that runs until its own signal aborts. */
    const startGraph = (graphId: string, topicId: string, aborted: string[]) => {
        let release: (() => void) | undefined;
        const stopped = new Promise<void>(resolve => { release = resolve; });
        const entry = registry.start({
            graphId,
            topicId,
            run: async signal => {
                signal.addEventListener('abort', () => {
                    aborted.push(graphId);
                    release?.();
                }, { once: true });
                await stopped;
            },
        });
        return entry;
    };

    it('按话题取消该话题的全部后台图，并放过其他话题', async () => {
        const aborted: string[] = [];
        const a = startGraph('g_a', 'topic_1', aborted);
        const b = startGraph('g_b', 'topic_1', aborted);
        const other = startGraph('g_other', 'topic_2', aborted);

        expect(registry.hasActive('g_a')).to.equal(true);
        expect(registry.hasActive('g_other')).to.equal(true);

        const cancelled = registry.cancelAllForTopic('topic_1');
        expect(cancelled).to.equal(2);

        await Promise.all([a.settled, b.settled]);
        expect(aborted.sort()).to.deep.equal(['g_a', 'g_b']);
        // Another topic's work is untouched by this topic's stop button.
        expect(registry.hasActive('g_other')).to.equal(true);

        registry.cancelAllForTopic('topic_2');
        await other.settled;
    });

    it('没有后台图时返回 0，停止按钮不需要特判', () => {
        expect(registry.cancelAllForTopic('topic_without_graphs')).to.equal(0);
    });

    it('取消后条目从注册表移除，允许同一 graphId 稍后 resume', async () => {
        const aborted: string[] = [];
        const entry = startGraph('g_resume', 'topic_3', aborted);
        registry.cancelAllForTopic('topic_3');
        await entry.settled;
        expect(registry.hasActive('g_resume')).to.equal(false);
        // Re-registering the same id would throw if the entry had leaked.
        const again = startGraph('g_resume', 'topic_3', aborted);
        registry.cancelAllForTopic('topic_3');
        await again.settled;
    });
});
