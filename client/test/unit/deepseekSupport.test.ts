/**
 * Regression tests for the DeepSeek-support improvements:
 *  - programmable run_code Code Mode (isolation, SDK, policy, concurrency)
 *  - dispatch_agents per-task model/provider/reasoningEffort validation
 *  - per-model compaction ratios and tool-result archive limits
 *  - per-provider model supplement selection
 *  - run_code registry classification (domain isolation invariants)
 */

import { expect } from 'chai';
import {
    RUN_CODE_BLOCKED_TOOLS,
    buildRunCodePromptAdditions,
    buildRunCodeSdk,
    createRunCodeCapabilitySnapshot,
    executeRunCodeProgram,
    validateRunCodeProgram,
} from '../../extension/ai/tools/runCode';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { validateToolCapability } from '../../extension/ai/tools/permissions';
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
// ─── run_code: programmable Code Mode ────────────────────────────────────────

describe('run_code registry classification', () => {
    const entry = TOOL_REGISTRY.get('run_code');

    it('is an authority-neutral shared transport', () => {
        expect(entry).to.exist;
        expect(entry!.domain).to.equal('shared');
        expect(entry!.effect).to.equal('none');
        expect(entry!.riskLevel).to.equal(0);
        expect(entry!.concurrencyClass).to.equal('parallel');
        expect(entry!.isWrite).to.be.false;
    });

    it('is admitted to writer and read-only modes with child authority inherited from nested tools', () => {
        expect(entry!.allowedModes.has('build')).to.be.true;
        expect(entry!.allowedModes.has('utility')).to.be.true;
        expect(entry!.allowedModes.has('plan')).to.be.true;
        expect(entry!.allowSubAgent).to.be.true;
        expect(validateToolCapability('run_code', { mode: 'explore', domain: 'paradox', isSubAgent: true, profileName: 'explore' }).allowed).to.be.true;
        expect(validateToolCapability('run_command', { mode: 'build', domain: 'paradox', isSubAgent: true, profileName: 'paradox-coder' }).allowed).to.be.false;
        expect(validateToolCapability('run_command', { mode: 'utility', domain: 'general', isSubAgent: true, profileName: 'general-coder' }).allowed).to.be.true;
    });
});

describe('run_code capability snapshot and SDK', () => {
    const def = (name: string, parameters: Record<string, unknown> = {}) => ({
        type: 'function' as const,
        function: { name, description: `${name} test`, parameters },
    });
    const definitions = [
        def('read_file', { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }),
        def('dispatch_agents'),
        def('edit_file'),
    ];

    it('sorts capabilities and excludes nested/interactive orchestration', () => {
        const snapshot = createRunCodeCapabilitySnapshot(definitions);
        expect(snapshot.tools.map(tool => tool.name)).to.deep.equal(['edit_file', 'read_file']);
        expect(snapshot.names.has('dispatch_agents')).to.be.false;
        expect(RUN_CODE_BLOCKED_TOOLS.has('run_code')).to.be.true;
    });

    it('generates deterministic typed arguments from the current schema', () => {
        const sdk = buildRunCodeSdk(definitions);
        expect(sdk).to.include('"read_file": {');
        expect(sdk).to.include('file: string;');
        expect(sdk).to.include('Promise<{ content: string;');
        expect(sdk.indexOf('"edit_file"')).to.be.lessThan(sdk.indexOf('"read_file"'));
        expect(sdk).not.to.include('dispatch_agents');
    });

    it('generates a compact SDK addition for dynamically disclosed tools', () => {
        const additions = buildRunCodePromptAdditions([
            def('read_file', { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }),
        ]);
        expect(additions).to.include('SDK additions');
        expect(additions).to.include('"read_file"');
        expect(additions).to.include('file: string;');
        expect(additions).not.to.include('isolated QuickJS/WASM guest');
    });
});

describe('validateRunCodeProgram', () => {
    it('accepts code plus a concise description', () => {
        expect(validateRunCodeProgram({ code: 'return { ok: true };', description: 'Return a value' }).ok).to.be.true;
    });

    it('rejects missing or oversized program fields', () => {
        expect(validateRunCodeProgram({ description: 'missing code' }).ok).to.be.false;
        expect(validateRunCodeProgram({ code: 'return 1' }).ok).to.be.false;
        expect(validateRunCodeProgram({ code: 'x'.repeat(65_000), description: 'too large' }).ok).to.be.false;
        expect(validateRunCodeProgram({ code: 'return 1', description: 'x'.repeat(241) }).ok).to.be.false;
    });
});

describe('executeRunCodeProgram', () => {
    const def = (name: string) => ({
        type: 'function' as const,
        function: { name, description: 'test', parameters: { type: 'object', properties: {} } },
    });

    it('branches on Paradox semantic results and returns selected evidence', async () => {
        const definitions = [def('query_scope'), def('query_rules')];
        const calls: string[] = [];
        const result = await executeRunCodeProgram(
            {
                description: 'Verify semantic scope',
                code: `const scope = await tools.query_scope({ file: 'events/x.txt', line: 1, column: 0 });
if (scope.certainty !== 'exact') return { status: 'unresolved' };
const rules = await tools.query_rules({ category: 'effect', scope: scope.currentScope });
return { status: 'verified', scope: scope.currentScope, count: rules.rules.length };`,
            },
            createRunCodeCapabilitySnapshot(definitions),
            async (tool) => {
                calls.push(tool);
                return tool === 'query_scope'
                    ? { certainty: 'exact', currentScope: 'country' }
                    : { rules: [{ name: 'set_country_flag' }], ignored: 'guest-local' };
            },
            new AbortController().signal,
        );
        expect(result.success).to.be.true;
        expect(calls).to.deep.equal(['query_scope', 'query_rules']);
        expect(result.value).to.deep.equal({ status: 'verified', scope: 'country', count: 1 });
    });

    it('supports Promise.all and bounds host in-flight calls', async () => {
        const definitions = [def('read_file')];
        let active = 0;
        let maxActive = 0;
        const result = await executeRunCodeProgram(
            {
                description: 'Read files concurrently',
                code: `const values = await Promise.all([0,1,2,3,4,5].map(index => tools.read_file({ file: String(index) }))); return values.map(value => value.file);`,
            },
            createRunCodeCapabilitySnapshot(definitions),
            async (_tool, args) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise(resolve => setTimeout(resolve, 5));
                active--;
                return { file: args.file };
            },
            new AbortController().signal,
        );
        expect(result.success).to.be.true;
        expect(result.callsExecuted).to.equal(6);
        expect(maxActive).to.be.at.most(4);
        expect(maxActive).to.be.greaterThan(1);
    });

    it('turns failed host results into catchable ToolCallError values', async () => {
        const definitions = [def('read_file')];
        const result = await executeRunCodeProgram(
            { description: 'Catch tool failure', code: `try { await tools.read_file({ file: 'missing' }); } catch (error) { return { name: error.name, tool: error.toolName, message: error.message }; }` },
            createRunCodeCapabilitySnapshot(definitions),
            async () => ({ success: false, error: 'not found' }),
            new AbortController().signal,
        );
        expect(result.success).to.be.true;
        expect(result.value).to.deep.equal({ name: 'ToolCallError', tool: 'read_file', message: 'not found' });
    });

    it('blocks hidden tools without dispatching them', async () => {
        const definitions = [def('read_file')];
        let dispatched = false;
        const result = await executeRunCodeProgram(
            { description: 'Attempt hidden call', code: `return { available: typeof tools.query_types };` },
            createRunCodeCapabilitySnapshot(definitions),
            async () => { dispatched = true; return {}; },
            new AbortController().signal,
        );
        expect(result.success).to.be.true;
        expect(dispatched).to.be.false;
        expect(result.value).to.deep.equal({ available: 'undefined' });
    });

    it('does not expose Node or VS Code host authority', async () => {
        const result = await executeRunCodeProgram(
            { description: 'Inspect guest globals', code: `return { process: typeof process, require: typeof require, fetch: typeof fetch, vscode: typeof vscode };` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async () => ({}),
            new AbortController().signal,
        );
        expect(result.value).to.deep.equal({ process: 'undefined', require: 'undefined', fetch: 'undefined', vscode: 'undefined' });
    });

    it('interrupts a CPU-bound guest from an absolute deadline', async () => {
        const startedAt = Date.now();
        const result = await executeRunCodeProgram(
            { description: 'Bound CPU loop', code: `while (true) {}` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async () => ({}),
            new AbortController().signal,
            Date.now() + 25,
        );
        expect(result.success).to.be.false;
        expect(result.error).to.include('exceeded');
        expect(Date.now() - startedAt).to.be.lessThan(2_000);
    });

    it('interrupts a CPU loop resumed after an awaited tool', async () => {
        const result = await executeRunCodeProgram(
            { description: 'Bound resumed CPU loop', code: `await tools.read_file({}); while (true) {}` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async () => ({}),
            new AbortController().signal,
            Date.now() + 25,
        );
        expect(result.success).to.be.false;
        expect(result.error).to.include('exceeded');
    });

    it('preserves __proto__ as inert own JSON data', async () => {
        let received: Record<string, unknown> | undefined;
        const result = await executeRunCodeProgram(
            { description: 'Copy hostile JSON safely', code: `const args = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"path":"escape"}}}'); return await tools.read_file(args);` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async (_tool, args) => { received = args; return { ok: true }; },
            new AbortController().signal,
        );
        expect(result.success).to.be.true;
        expect(received).to.exist;
        expect(Object.prototype.hasOwnProperty.call(received, '__proto__')).to.be.true;
        expect((received as { polluted?: unknown }).polluted).to.equal(undefined);
        const nested = received!.nested as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).to.be.true;
        expect((nested as { path?: unknown }).path).to.equal(undefined);
    });

    it('does not dispatch calls queued behind the semaphore after cancellation', async () => {
        const controller = new AbortController();
        const started: number[] = [];
        const run = executeRunCodeProgram(
            { description: 'Cancel queued calls', code: `await Promise.all([0,1,2,3,4,5,6,7].map(index => tools.read_file({ index })));` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async (_tool, args) => {
                started.push(args.index as number);
                await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
                return {};
            },
            controller.signal,
        );
        await new Promise(resolve => setTimeout(resolve, 15));
        controller.abort(new Error('cancel queued'));
        const result = await run;
        expect(result.success).to.be.false;
        expect(started).to.have.length.at.most(4);
    });

    it('reports cancellation while waiting for a host tool', async () => {
        const controller = new AbortController();
        const run = executeRunCodeProgram(
            { description: 'Cancel pending read', code: `await tools.read_file({ file: 'slow' }); return 'late';` },
            createRunCodeCapabilitySnapshot([def('read_file')]),
            async () => new Promise(() => undefined),
            controller.signal,
        );
        setTimeout(() => controller.abort(new Error('cancelled')), 10);
        const result = await run;
        expect(result.success).to.be.false;
        expect(result.aborted).to.be.true;
        expect(result.error).to.include('cancelled');
    });
});

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
