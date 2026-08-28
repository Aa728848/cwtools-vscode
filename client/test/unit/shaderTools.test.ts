import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { getGameKnowledge } from '../../extension/ai/gameKnowledge';
import { PARADOX_WRITE } from './schedulingFixtures';

const SHADER_TOOLS = [
    'query_shader_symbol',
    'query_shader_compile_unit',
    'query_shader_platform_variants',
    'query_shader_callers',
    'explain_shader_reachability',
    'validate_shader',
    'compare_shader_with_vanilla',
] as const;

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        isTrusted: true,
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    languages: {
        getDiagnostics: () => [],
    },
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3,
    },
    commands: {
        executeCommand: async () => undefined,
    },
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath.replace(/\\/g, '/')}`,
        }),
    },
    CancellationTokenSource: class {
        token = {};
        cancel(): void { /* stub */ }
        dispose(): void { /* stub */ }
    },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadAgentTools() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const cachedBefore = new Set(Object.keys(require.cache));
    const agentToolsPath = require.resolve('../../extension/ai/agentTools');
    delete require.cache[agentToolsPath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
    } finally {
        moduleLoader._load = originalLoad;
        // AgentToolExecutor imports several VS Code-bound helpers. Keep the loaded
        // class for this suite, but remove every module introduced by this stubbed
        // load so later suites can bind their own VS Code test state. Without this,
        // test results depend on file/argument ordering.
        for (const modulePath of Object.keys(require.cache)) {
            if (!cachedBefore.has(modulePath)) delete require.cache[modulePath];
        }
    }
}

const { AgentToolExecutor } = loadAgentTools();

interface RecordedCall {
    command: string;
    args: unknown[];
}

function createExecutor(workspaceRoot: string, handler: (command: string, args: unknown[]) => unknown) {
    const calls: RecordedCall[] = [];
    const client = {
        onNotification: () => undefined,
        sendNotification: () => undefined,
        sendRequest: async (_method: string, params: { command: string; arguments: unknown[] }) => {
            calls.push({ command: params.command, args: params.arguments });
            return handler(params.command, params.arguments);
        },
    } as any;
    const executor = new AgentToolExecutor(client, workspaceRoot);
    return { executor, calls };
}

const buildContext = {
    runnerOptions: { schedulingState: PARADOX_WRITE },
    onPermissionRequest: async () => true,
} as any;

describe('shader knowledge tools', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-shader-tools-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('registers all seven shader tools as read-only paradox LSP tools', () => {
        for (const name of SHADER_TOOLS) {
            const definition = TOOL_DEFINITIONS.find(def => def.function.name === name);
            expect(definition, `missing definition for ${name}`).to.not.equal(undefined);
            const entry = TOOL_REGISTRY.get(name);
            expect(entry, `missing registry entry for ${name}`).to.not.equal(undefined);
            expect(entry!.isReadOnly, name).to.equal(true);
            expect(entry!.isWrite, name).to.equal(false);
            expect(entry!.effect, name).to.equal('workspace_read');
            expect(entry!.riskLevel, name).to.equal(0);
            expect(entry!.concurrencyClass, name).to.equal('lsp-limited');
            expect(entry!.domain, name).to.equal('paradox');
            expect(entry!.mutating, name).to.not.equal(true);
            expect(entry!.allowedModes.has('plan'), name).to.equal(true);
            expect(entry!.allowedModes.has('build'), name).to.equal(true);
        }
    });

    it('routes query_shader_symbol to cwtools.ai.shader.symbols with a single record', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, totalCount: 0, returnedCount: 0, nextCursor: null, symbols: [] }));
        const result = await executor.execute('query_shader_symbol', { filter: 'pdx', kind: 'effect', limit: 50, cursor: 100 }, buildContext) as any;

        expect(result.ok).to.equal(true);
        expect(calls).to.have.length(1);
        expect(calls[0]!.command).to.equal('cwtools.ai.shader.symbols');
        expect(calls[0]!.args).to.deep.equal([{ filter: 'pdx', kind: 'effect', limit: 50, cursor: 100 }]);
    });

    it('omits unset optional fields from the shader record', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, symbols: [] }));
        await executor.execute('query_shader_symbol', {}, buildContext);

        expect(calls[0]!.args).to.deep.equal([{}]);
    });

    it('normalizes a workspace-relative path to a file URI for compile units', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, root: {}, members: [], problems: [], includedBy: [] }));
        await executor.execute('query_shader_compile_unit', { file: 'gfx/FX/test.shader' }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.compileUnit');
        const record = calls[0]!.args[0] as Record<string, unknown>;
        expect(String(record.uri)).to.match(/^file:\/\//);
        expect(String(record.uri)).to.include('/gfx/FX/test.shader');
    });

    it('passes an existing file URI through unchanged', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, file: '', count: 0, diagnostics: [] }));
        await executor.execute('validate_shader', { file: 'file:///vanilla/gfx/FX/a.shader' }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.validate');
        expect((calls[0]!.args[0] as Record<string, unknown>).uri).to.equal('file:///vanilla/gfx/FX/a.shader');
    });

    it('routes query_shader_platform_variants with a normalized file URI', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, platforms: [], conditions: [], macros: [] }));
        await executor.execute('query_shader_platform_variants', { file: 'gfx/FX/test.shader' }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.variants');
        expect(String((calls[0]!.args[0] as Record<string, unknown>).uri)).to.include('/gfx/FX/test.shader');
    });

    it('routes query_shader_callers with effectName and limit', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true, effectName: 'my_effect', totalCount: 0, returnedCount: 0, callers: [] }));
        await executor.execute('query_shader_callers', { effectName: 'my_effect', limit: 10 }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.callers');
        expect(calls[0]!.args).to.deep.equal([{ effectName: 'my_effect', limit: 10 }]);
    });

    it('routes explain_shader_reachability by effect name and by file', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true }));
        await executor.execute('explain_shader_reachability', { effectName: 'my_effect' }, buildContext);
        await executor.execute('explain_shader_reachability', { file: 'gfx/FX/test.shader', limit: 25 }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.reachability');
        expect(calls[0]!.args).to.deep.equal([{ effectName: 'my_effect' }]);
        expect(calls[1]!.command).to.equal('cwtools.ai.shader.reachability');
        const record = calls[1]!.args[0] as Record<string, unknown>;
        expect(String(record.uri)).to.include('/gfx/FX/test.shader');
        expect(record.limit).to.equal(25);
    });

    it('routes compare_shader_with_vanilla by effect name and by file', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true }));
        await executor.execute('compare_shader_with_vanilla', { effectName: 'my_effect' }, buildContext);
        await executor.execute('compare_shader_with_vanilla', { file: 'gfx/FX/test.shader' }, buildContext);

        expect(calls[0]!.command).to.equal('cwtools.ai.shader.compareVanilla');
        expect(calls[0]!.args).to.deep.equal([{ effectName: 'my_effect' }]);
        expect(calls[1]!.command).to.equal('cwtools.ai.shader.compareVanilla');
        expect(String((calls[1]!.args[0] as Record<string, unknown>).uri)).to.include('/gfx/FX/test.shader');
    });

    it('rejects missing file/effectName arguments without calling the LSP', async () => {
        const { executor, calls } = createExecutor(workspaceRoot, () => ({ ok: true }));

        const compileUnit = await executor.execute('query_shader_compile_unit', {}, buildContext) as any;
        expect(compileUnit.ok).to.equal(false);
        expect(compileUnit.operation).to.equal('cwtools.ai.shader.compileUnit');

        const variants = await executor.execute('query_shader_platform_variants', {}, buildContext) as any;
        expect(variants.ok).to.equal(false);
        expect(variants.operation).to.equal('cwtools.ai.shader.variants');

        const callers = await executor.execute('query_shader_callers', {}, buildContext) as any;
        expect(callers.ok).to.equal(false);
        expect(callers.operation).to.equal('cwtools.ai.shader.callers');

        const reachability = await executor.execute('explain_shader_reachability', {}, buildContext) as any;
        expect(reachability.ok).to.equal(false);

        const compare = await executor.execute('compare_shader_with_vanilla', {}, buildContext) as any;
        expect(compare.ok).to.equal(false);

        expect(calls).to.have.length(0);
    });

    it('passes structured server errors through unchanged', async () => {
        const serverError = {
            ok: false,
            status: 'error',
            operation: 'cwtools.ai.shader.validate',
            target: 'file:///x/a.txt',
            error: 'uri must reference a .shader or .fxh file.',
        };
        const { executor } = createExecutor(workspaceRoot, () => serverError);
        const result = await executor.execute('validate_shader', { file: 'a.txt' }, buildContext) as any;

        expect(result).to.deep.equal(serverError);
    });

    it('reports transport failures with operation and target context', async () => {
        const { executor } = createExecutor(workspaceRoot, () => { throw new Error('connection closed'); });
        const result = await executor.execute('query_shader_callers', { effectName: 'my_effect' }, buildContext) as any;

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal('error');
        expect(result.operation).to.equal('cwtools.ai.shader.callers');
        expect(result.target).to.equal('my_effect');
        expect(result.error).to.include('connection closed');
    });
});

describe('shader safety gate prompt', () => {
    it('states the version-independent shader principles in the knowledge header', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('Shader safety gate');
        expect(knowledge).to.include('explain_shader_reachability');
        expect(knowledge).to.include('query_shader_callers');
        expect(knowledge).to.include('query_shader_compile_unit');
        expect(knowledge).to.include('validate_shader');
        expect(knowledge).to.include('engine_or_unreferenced');
        expect(knowledge).to.include('not dead code');
        expect(knowledge).to.include('interface/*.gfx');
        expect(knowledge).to.include('effect_file_convention_candidate');
        expect(knowledge).to.include('Up/Down/Over/Disable/Text*');
        expect(knowledge).to.include('interfaceSprite');
        expect(knowledge).to.include('rendererSubtype');
        expect(knowledge).to.include('.gui -> GFX_* -> shader file');
    });
});

describe('mandatory shader write safety gate', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-shader-write-gate-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('fails closed before writing when authoritative shader preflight is unavailable', async () => {
        const target = path.join(workspaceRoot, 'gfx', 'FX', 'blocked.shader');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'Effect old_effect { }');
        const { executor, calls } = createExecutor(workspaceRoot, command => {
            if (command === 'cwtools.ai.shader.preflightEdit') {
                return { ok: false, status: 'error', error: 'shader model unavailable' };
            }
            throw new Error(`unexpected command ${command}`);
        });
        executor.fileWriteMode = 'auto';

        const result = await executor.execute('write_file', {
            file: target,
            content: 'Effect replacement { }',
        }, buildContext) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('fail closed');
        expect(fs.readFileSync(target, 'utf8')).to.equal('Effect old_effect { }');
        expect(calls.map(call => call.command)).to.deep.equal(['cwtools.ai.shader.preflightEdit']);
    });

    it('passes exact before/after text and validates every affected compile root after writing', async () => {
        const target = path.join(workspaceRoot, 'gfx', 'FX', 'shared.fxh');
        const rootA = path.join(workspaceRoot, 'gfx', 'FX', 'a.shader');
        const rootB = path.join(workspaceRoot, 'gfx', 'FX', 'b.shader');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'float old_value;');
        fs.writeFileSync(rootA, 'Includes = { "shared.fxh" }');
        fs.writeFileSync(rootB, 'Includes = { "shared.fxh" }');
        const { executor, calls } = createExecutor(workspaceRoot, command => {
            if (command === 'cwtools.ai.shader.preflightEdit') {
                return { ok: true, allowed: true, issues: [], diagnostics: [] };
            }
            if (command === 'cwtools.ai.shader.compileUnit') {
                return { ok: true, root: { path: target }, includedBy: [rootB, rootA] };
            }
            if (command === 'cwtools.ai.shader.validate') {
                return { ok: true, diagnostics: [] };
            }
            throw new Error(`unexpected command ${command}`);
        });
        executor.fileWriteMode = 'auto';

        const result = await executor.execute('write_file', {
            file: target,
            content: 'float new_value;',
        }, buildContext) as any;

        expect(result.success).to.equal(true);
        const preflight = calls.find(call => call.command === 'cwtools.ai.shader.preflightEdit');
        expect(preflight).to.not.equal(undefined);
        expect(preflight!.args[0]).to.include({ previousText: 'float old_value;', text: 'float new_value;' });
        const validations = calls.filter(call => call.command === 'cwtools.ai.shader.validate');
        expect(validations).to.have.length(3);
        expect(result.shaderPostWriteValidation.passed).to.equal(true);
        expect(result.shaderPostWriteValidation.affectedRoots).to.deep.equal([rootA, rootB, target].sort());
        expect(fs.readFileSync(target, 'utf8')).to.equal('float new_value;');
    });

    it('marks a completed write for repair when an affected compile unit has an error', async () => {
        const target = path.join(workspaceRoot, 'gfx', 'FX', 'broken.shader');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'Effect safe { }');
        const { executor } = createExecutor(workspaceRoot, command => {
            if (command === 'cwtools.ai.shader.preflightEdit') return { ok: true, allowed: true, issues: [] };
            if (command === 'cwtools.ai.shader.compileUnit') return { ok: true, root: { path: target }, includedBy: [] };
            if (command === 'cwtools.ai.shader.validate') {
                return { ok: true, diagnostics: [{ severity: 'error', code: 'CWFX999', message: 'broken' }] };
            }
            return { ok: true };
        });
        executor.fileWriteMode = 'auto';

        const result = await executor.execute('write_file', { file: target, content: 'Effect safe { }\n' }, buildContext) as any;

        expect(result.success).to.equal(true);
        expect(result.requiresRepair).to.equal(true);
        expect(result.shaderPostWriteValidation.status).to.equal('errors');
    });

    it('routes interface effectFile changes through the shader gate before generic PDX evidence', async () => {
        const target = path.join(workspaceRoot, 'interface', 'sprites.gfx');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'spriteType = { effectFile = "gfx/FX/old.shader" }');
        const { executor, calls } = createExecutor(workspaceRoot, command => {
            if (command === 'cwtools.ai.shader.preflightEdit') {
                return { ok: true, allowed: false, issues: ['renderer contract is unknown'] };
            }
            throw new Error(`unexpected command ${command}`);
        });
        executor.fileWriteMode = 'auto';

        const result = await executor.execute('write_file', {
            file: target,
            content: 'spriteType = { effectFile = "gfx/FX/new.shader" }',
        }, buildContext) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('renderer contract is unknown');
        expect(fs.readFileSync(target, 'utf8')).to.include('old.shader');
        expect(calls.map(call => call.command)).to.deep.equal(['cwtools.ai.shader.preflightEdit']);
    });
});
