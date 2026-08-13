/**
 * Regression tests for the DeepSeek-support improvements:
 *  - run_code scripted fan-out (plan validation, blocking, aggregation)
 *  - dispatch_agents per-task model/provider/reasoningEffort validation
 *  - per-model compaction ratios and tool-result archive limits
 *  - per-provider model supplement selection
 *  - run_code registry classification (domain isolation invariants)
 */

import { expect } from 'chai';
import {
    RUN_CODE_MAX_STEPS,
    RUN_CODE_BLOCKED_STEPS,
    computeRunCodeAllowedStepNames,
    validateRunCodeStepPlan,
    executeRunCodeSteps,
    truncateRunCodeStepResult,
    runCodeStepSucceeded,
} from '../../extension/ai/tools/runCode';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import {
    validateNodeModelSelection,
    mapTaskModelSelection,
} from '../../extension/ai/orchestrator/taskGraphEngine';

// Modules whose import chain touches vscode are loaded through a stub.
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

// ─── run_code: registry classification ───────────────────────────────────────

describe('run_code registry classification', () => {
    const entry = TOOL_REGISTRY.get('run_code');

    it('is registered as a shared write-capable meta tool', () => {
        expect(entry).to.exist;
        expect(entry!.domain).to.equal('shared');
        expect(entry!.effect).to.equal('workspace_write');
        expect(entry!.riskLevel).to.equal(2);
        expect(entry!.concurrencyClass).to.equal('global-exclusive');
    });

    it('is admitted only to writer modes and never to slim sub-agents', () => {
        expect(entry!.allowedModes.has('build')).to.be.true;
        expect(entry!.allowedModes.has('utility')).to.be.true;
        expect(entry!.allowedModes.has('plan')).to.be.false;
        expect(entry!.allowedModes.has('explore')).to.be.false;
        expect(entry!.allowSubAgent).to.be.false;
    });
});

// ─── run_code: step plan validation ───────────────────────────────────────────

describe('validateRunCodeStepPlan', () => {
    const allowed = new Set<string>(['read_file', 'edit_file', 'grep', 'get_diagnostics']);

    it('accepts a valid plan and defaults missing args to {}', () => {
        const result = validateRunCodeStepPlan(
            [{ tool: 'grep', args: { pattern: 'x' } }, { tool: 'read_file' }],
            allowed,
        );
        expect(result.ok).to.be.true;
        if (result.ok) {
            expect(result.steps).to.have.length(2);
            expect(result.steps[1]!.args).to.deep.equal({});
        }
    });

    it('rejects non-array, empty, and oversized plans', () => {
        expect(validateRunCodeStepPlan(undefined, allowed).ok).to.be.false;
        expect(validateRunCodeStepPlan([], allowed).ok).to.be.false;
        const oversized = Array.from({ length: RUN_CODE_MAX_STEPS + 1 }, () => ({ tool: 'grep', args: {} }));
        const result = validateRunCodeStepPlan(oversized, allowed);
        expect(result.ok).to.be.false;
        if (!result.ok) expect(result.error).to.include(`${RUN_CODE_MAX_STEPS}`);
    });

    it('rejects blocked tools including nested run_code', () => {
        for (const tool of ['run_code', 'dispatch_agents', 'ask_user_question', 'create_goal']) {
            expect(RUN_CODE_BLOCKED_STEPS.has(tool)).to.be.true;
            const result = validateRunCodeStepPlan([{ tool, args: {} }], new Set([...allowed, tool]));
            expect(result.ok).to.be.false;
            if (!result.ok) expect(result.error).to.include(`'${tool}'`);
        }
    });

    it('rejects tools outside the model-visible allowlist (domain isolation)', () => {
        // query_types is Paradox-only; a general-domain catalog must not admit it.
        const result = validateRunCodeStepPlan([{ tool: 'query_types', args: {} }], allowed);
        expect(result.ok).to.be.false;
        if (!result.ok) expect(result.error).to.include('query_types');
    });

    it('rejects malformed steps and non-object args', () => {
        expect(validateRunCodeStepPlan([null], allowed).ok).to.be.false;
        expect(validateRunCodeStepPlan([{ tool: 42, args: {} }], allowed).ok).to.be.false;
        expect(validateRunCodeStepPlan([{ tool: 'grep', args: 'pattern' }], allowed).ok).to.be.false;
        expect(validateRunCodeStepPlan([{ tool: 'grep', args: [] }], allowed).ok).to.be.false;
    });

    it('rejects oversized step args', () => {
        const huge = 'x'.repeat(33_000);
        const result = validateRunCodeStepPlan([{ tool: 'edit_file', args: { content: huge } }], allowed);
        expect(result.ok).to.be.false;
    });
});

// ─── run_code: allowlist derivation ───────────────────────────────────────────

describe('computeRunCodeAllowedStepNames', () => {
    const def = (name: string) => ({
        type: 'function' as const,
        function: { name, description: 'test', parameters: {} },
    });
    const tools = [def('read_file'), def('dispatch_agents'), def('edit_file')];

    it('drops blocked tools and keeps the rest', () => {
        const names = computeRunCodeAllowedStepNames(tools);
        expect(names.has('read_file')).to.be.true;
        expect(names.has('edit_file')).to.be.true;
        expect(names.has('dispatch_agents')).to.be.false;
    });
});

// ─── write queue: lock-wait bound used by nested run_code writes ──────────────

describe('PartitionedWriteQueue wait bound', () => {
    it('rejects a waiter whose waitTimeoutMs expires before the lock is released', async () => {
        const { PartitionedWriteQueue } = require('../../extension/ai/runner/writeCoordinator') as
            typeof import('../../extension/ai/runner/writeCoordinator');
        const queue = new PartitionedWriteQueue();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const holder = queue.enqueue(['file'], async () => { await gate; });
        const waiter = queue.enqueue(['file'], async () => 'ran', {
            waitTimeoutMs: 50,
            timeoutMessage: 'run_code write queue wait timed out.',
        });
        let waiterError: unknown;
        try {
            await waiter;
        } catch (error) {
            waiterError = error;
        }
        expect(waiterError).to.be.an('error');
        expect((waiterError as Error).message).to.include('run_code write queue wait timed out.');
        release();
        await holder;
    });
});

// ─── run_code: step execution and aggregation ────────────────────────────────

describe('executeRunCodeSteps', () => {
    it('runs steps in order and aggregates results', async () => {
        const order: string[] = [];
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'grep', args: {} }, { tool: 'edit_file', args: {} }],
            async (tool) => {
                order.push(tool);
                return { success: true, tool };
            },
        );
        expect(order).to.deep.equal(['grep', 'edit_file']);
        expect(aggregate.success).to.be.true;
        expect(aggregate.stepsExecuted).to.equal(2);
        expect(aggregate.results.map(r => r.success)).to.deep.equal([true, true]);
    });

    it('keeps running after a failed step and reports per-step failures', async () => {
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'bad', args: {} }, { tool: 'read_file', args: {} }],
            async (tool) => tool === 'bad'
                ? { success: false, error: 'nope' }
                : { success: true },
        );
        expect(aggregate.success).to.be.false;
        expect(aggregate.stepsExecuted).to.equal(2);
        expect(aggregate.results[0]).to.deep.include({ index: 0, tool: 'bad', success: false });
        expect(aggregate.results[1]).to.deep.include({ index: 1, tool: 'read_file', success: true });
    });

    it('captures a throwing step without aborting the fan-out', async () => {
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'boom', args: {} }, { tool: 'grep', args: {} }],
            async (tool) => {
                if (tool === 'boom') throw new Error('kaboom');
                return { success: true };
            },
        );
        expect(aggregate.success).to.be.false;
        expect(aggregate.results[0]!.error).to.equal('kaboom');
        expect(aggregate.results[1]!.success).to.be.true;
    });

    it('truncates oversized step results with a marker', async () => {
        const long = 'x'.repeat(10_000);
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'read_file', args: {} }],
            async () => long,
        );
        expect(aggregate.success).to.be.true;
        const outcome = aggregate.results[0]!;
        expect(outcome.truncated).to.be.true;
        expect(String(outcome.result).length).to.be.lessThan(long.length);
        expect(String(outcome.result)).to.include('truncated');
    });

    it('judges a large failure object by its raw value, not its truncated string', async () => {
        const hugeFailure = { success: false, error: 'failed', content: 'x'.repeat(10_000) };
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'edit_file', args: {} }],
            async () => hugeFailure,
        );
        expect(aggregate.success).to.be.false;
        const outcome = aggregate.results[0]!;
        expect(outcome.success).to.be.false;
        expect(outcome.truncated).to.be.true;
    });

    it('returns a partial aborted aggregate when the signal fires mid-fan-out', async () => {
        const controller = new AbortController();
        const run = new Set<string>();
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'first', args: {} }, { tool: 'second', args: {} }],
            async (tool) => {
                run.add(tool);
                if (tool === 'first') controller.abort(new Error('budget'));
                return { success: true };
            },
            controller.signal,
        );
        expect(aggregate.success).to.be.false;
        expect(aggregate.aborted).to.be.true;
        expect(aggregate.stepsExecuted).to.equal(1);
        expect(run.has('first')).to.be.true;
        expect(run.has('second')).to.be.false;
    });

    it('does not start any step when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'first', args: {} }],
            async () => ({ success: true }),
            controller.signal,
        );
        expect(aggregate.success).to.be.false;
        expect(aggregate.aborted).to.be.true;
        expect(aggregate.stepsExecuted).to.equal(0);
        expect(aggregate.results).to.have.length(0);
    });

    it('marks a single failing last step as aborted when the signal caused the failure', async () => {
        const controller = new AbortController();
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'only', args: {} }],
            async () => {
                controller.abort(new Error('budget'));
                controller.signal.throwIfAborted();
                return { success: true };
            },
            controller.signal,
        );
        expect(aggregate.success).to.be.false;
        expect(aggregate.aborted).to.be.true;
        expect(aggregate.stepsExecuted).to.equal(1);
        expect(aggregate.results[0]!.error).to.equal('budget');
    });

    it('still reports aborted when the signal fires right after the last step completed', async () => {
        const controller = new AbortController();
        const aggregate = await executeRunCodeSteps(
            [{ tool: 'only', args: {} }],
            async () => {
                controller.abort(new Error('budget'));
                return { success: true };
            },
            controller.signal,
        );
        expect(aggregate.aborted).to.be.true;
        expect(aggregate.stepsExecuted).to.equal(1);
        expect(aggregate.results[0]!.success).to.be.true;
    });
});

// ─── run_code: step result helpers ────────────────────────────────────────────

describe('runCodeStepSucceeded / truncateRunCodeStepResult', () => {
    it('mirrors the runner failure convention', () => {
        expect(runCodeStepSucceeded({ success: true })).to.be.true;
        expect(runCodeStepSucceeded({ ok: true })).to.be.true;
        expect(runCodeStepSucceeded({ success: false })).to.be.false;
        expect(runCodeStepSucceeded({ ok: false })).to.be.false;
        expect(runCodeStepSucceeded({ status: 'error' })).to.be.false;
        expect(runCodeStepSucceeded({ status: 'unavailable' })).to.be.false;
        expect(runCodeStepSucceeded('plain text')).to.be.true;
    });

    it('keeps small values intact and truncates large strings', () => {
        expect(truncateRunCodeStepResult('short')).to.deep.equal({ value: 'short', truncated: false });
        const truncated = truncateRunCodeStepResult('x'.repeat(8_000));
        expect(truncated.truncated).to.be.true;
        expect(String(truncated.value)).to.include('truncated');
    });
});

// ─── dispatch_agents: per-task model selection validation ─────────────────────

describe('mapTaskModelSelection', () => {
    it('maps the model-visible schema fields onto the internal vocabulary', () => {
        expect(mapTaskModelSelection({
            model: 'deepseek-v4-flash',
            provider: 'deepseek',
            reasoningEffort: 'low',
        })).to.deep.equal({ model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'low' });
    });

    it('falls back to the legacy override names when the schema fields are absent', () => {
        expect(mapTaskModelSelection({
            modelOverride: 'legacy-model',
            providerOverride: 'openai',
        })).to.deep.equal({ model: 'legacy-model', provider: 'openai', reasoningEffort: undefined });
    });

    it('prefers the schema field when both spellings are present', () => {
        expect(mapTaskModelSelection({
            model: 'schema-model',
            modelOverride: 'legacy-model',
        }).model).to.equal('schema-model');
    });
});

describe('validateNodeModelSelection', () => {
    const providers = new Set(['deepseek', 'openai', 'claude']);

    it('accepts and normalizes valid selections', () => {
        const result = validateNodeModelSelection(
            { model: '  deepseek-v4-flash ', provider: ' deepseek ', reasoningEffort: 'low' },
            providers,
        );
        expect(result.ok).to.be.true;
        if (result.ok) {
            expect(result.model).to.equal('deepseek-v4-flash');
            expect(result.provider).to.equal('deepseek');
            expect(result.reasoningEffort).to.equal('low');
        }
    });

    it('accepts empty selection (inherit coordinator)', () => {
        expect(validateNodeModelSelection({}, providers).ok).to.be.true;
    });

    it('rejects unknown providers, bad efforts, and oversized model ids', () => {
        expect(validateNodeModelSelection({ provider: 'nope' }, providers).ok).to.be.false;
        expect(validateNodeModelSelection({ reasoningEffort: 'extreme' }, providers).ok).to.be.false;
        expect(validateNodeModelSelection({ model: 'x'.repeat(121) }, providers).ok).to.be.false;
        expect(validateNodeModelSelection({ provider: 42 }, providers).ok).to.be.false;
    });
});

// ─── per-model compaction ratios and archive limits ───────────────────────────

describe('resolveCompactionRatios / resolveToolResultArchiveLimit', () => {
    let compaction: typeof import('../../extension/ai/runner/compaction');

    before(() => {
        compaction = require('../../extension/ai/runner/compaction') as typeof compaction;
    });

    it('keeps the historical defaults for non-DeepSeek models', () => {
        expect(compaction.resolveCompactionRatios('claude', 'claude-opus-4-8')).to.deep.equal({
            thresholdRatio: 0.80,
            targetRatio: 0.60,
            midLoopRatio: 0.78,
        });
    });

    it('raises the watermarks for DeepSeek providers and relay-hosted DeepSeek models', () => {
        const expected = { thresholdRatio: 0.85, targetRatio: 0.65, midLoopRatio: 0.80 };
        expect(compaction.resolveCompactionRatios('deepseek', 'deepseek-v4-pro')).to.deep.equal(expected);
        expect(compaction.resolveCompactionRatios('openrouter', 'deepseek/deepseek-v4-pro')).to.deep.equal(expected);
        expect(compaction.resolveCompactionRatios(undefined, 'siliconflow:deepseek-ai/DeepSeek-V4-Flash')).to.deep.equal(expected);
    });

    it('doubles tool-result archive limits for DeepSeek and keeps defaults elsewhere', () => {
        expect(compaction.resolveToolResultArchiveLimit('read_file', 'deepseek', 'deepseek-v4-pro')).to.equal(32_000);
        expect(compaction.resolveToolResultArchiveLimit('query_rules', 'deepseek', 'deepseek-v4-pro')).to.equal(120_000);
        expect(compaction.resolveToolResultArchiveLimit('read_file', 'claude', 'claude-opus-4-8')).to.equal(16_000);
        expect(compaction.resolveToolResultArchiveLimit('query_rules', undefined, undefined)).to.equal(60_000);
    });

    it('drives the periodic mid-loop trigger from the per-model watermark', () => {
        expect(compaction.resolveMidLoopBlockRatio('deepseek', 'deepseek-v4-pro')).to.equal(0.80);
        expect(compaction.resolveMidLoopBlockRatio('claude', 'claude-opus-4-8')).to.equal(0.78);
    });
});

// ─── per-provider model supplement ────────────────────────────────────────────

describe('modelSupplementForProvider', () => {
    let promptBuilder: typeof import('../../extension/ai/promptBuilder');

    before(() => {
        promptBuilder = require('../../extension/ai/promptBuilder') as typeof promptBuilder;
    });

    it('guides DeepSeek toward batch edits and run_code', () => {
        const supplement = promptBuilder.modelSupplementForProvider('deepseek');
        expect(supplement).to.include('run_code');
        expect(supplement).to.include('parallel edit_file');
    });

    it('keeps the provider-specific supplements and defaults intact', () => {
        expect(promptBuilder.modelSupplementForProvider('claude')).to.include('Claude');
        expect(promptBuilder.modelSupplementForProvider('google')).to.include('Gemini');
        expect(promptBuilder.modelSupplementForProvider('openai')).to.include('batch your tool calls');
        expect(promptBuilder.modelSupplementForProvider(undefined)).to.equal('');
    });
});
