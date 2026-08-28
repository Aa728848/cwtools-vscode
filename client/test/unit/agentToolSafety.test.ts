import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { DESIGN_BLUEPRINT_DETAILED_PARAMETERS } from '../../extension/ai/tools/definitions';

let diagnosticPairs: Array<[any, any[]]> = [];
let ignoredDiagnostics: string[] = [];
let permissionsConfig: any;
let stubConfigOverrides: Record<string, any> = {};

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        isTrusted: true,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in stubConfigOverrides) return stubConfigOverrides[key] as T;
                if (key === 'ignoredDiagnostics') return ignoredDiagnostics as T;
                if (key === 'permissions') return permissionsConfig as T;
                return defaultValue;
            },
        }),
    },
    languages: {
        getDiagnostics: () => diagnosticPairs,
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

function loadToolModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            fileTools: require('../../extension/ai/tools/fileTools') as typeof import('../../extension/ai/tools/fileTools'),
            externalTools: require('../../extension/ai/tools/externalTools') as typeof import('../../extension/ai/tools/externalTools'),
            agentTools: require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools'),
            agentRunner: require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner'),
            permissionPolicy: require('../../extension/ai/runner/permissionPolicy') as typeof import('../../extension/ai/runner/permissionPolicy'),
            processRegistry: require('../../extension/ai/runner/processRegistry') as typeof import('../../extension/ai/runner/processRegistry'),
            workspacePaths: require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { fileTools, externalTools, agentTools, agentRunner, permissionPolicy, processRegistry: processRegistryModule, workspacePaths } = loadToolModules();
const { FileToolHandler } = fileTools;
const { ExternalToolHandler, HeadTailTextBuffer } = externalTools;
const { AgentToolExecutor, TOOL_DEFINITIONS } = agentTools;
const { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } = agentRunner;
const { PermissionPolicyStore } = permissionPolicy;
const { processRegistry } = processRegistryModule;
const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

describe('enforced central tool policy', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        stubConfigOverrides = {};
    });

    afterEach(() => {
        stubConfigOverrides = {};
        cleanupWorkspace(workspaceRoot);
    });

    it('routes structured user questions through the host callback and preserves answers', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        let received: any;
        const result = await executor.execute('ask_user_question', {
            questions: [{
                id: 'scope',
                header: 'Scope',
                question: 'Which scope should be changed?',
                options: [
                    { label: 'Workspace (Recommended)', description: 'Apply the change consistently.' },
                    { label: 'Active file', description: 'Keep the change narrowly scoped.' },
                ],
            }],
        }, {
            runnerOptions: { mode: 'build', threadId: 'thread-1', turnId: 'turn-1' },
            scopeId: 'run-1',
            onUserQuestion: async (request: any, context: any) => {
                received = { request, context };
                return { success: true, answers: { scope: 'Workspace (Recommended)' } };
            },
        } as any) as any;

        expect(received.request.questions).to.have.length(1);
        expect(received.context).to.deep.equal({ runId: 'run-1', threadId: 'thread-1', turnId: 'turn-1' });
        expect(result).to.deep.equal({ success: true, answers: { scope: 'Workspace (Recommended)' } });
    });

    it('rejects malformed structured questions before invoking the host', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        let callbackCalled = false;
        const result = await executor.execute('ask_user_question', {
            questions: [{
                id: 'scope',
                question: 'Which scope?',
                options: [
                    { label: 'Same', description: 'First.' },
                    { label: 'Same', description: 'Duplicate.' },
                ],
            }],
        }, {
            runnerOptions: { mode: 'build' },
            onUserQuestion: async () => {
                callbackCalled = true;
                return { success: true, answers: {} };
            },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('uniquely identified');
        expect(callbackCalled).to.equal(false);
    });

    it('blocks workspace writes when the effective policy preset is read-only', async () => {
        stubConfigOverrides['policy.preset'] = 'read-only';
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        executor.fileWriteMode = 'auto';
        const target = path.join(workspaceRoot, 'blocked.txt');
        const result = await executor.execute('write_file', { file: target, content: 'nope' }, { runnerOptions: { mode: 'build', topicId: 'policy-test' } } as any) as any;
        expect(result.policyDenied).to.equal(true);
        expect(fs.existsSync(target)).to.equal(false);
    });

    it('validates staged typed PDX candidates through the detached LSP command before commit', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'events.txt');
        const source = 'country_event = {\n\tid = test.1\n}\n';
        fs.writeFileSync(target, source);
        let overlayCalls = 0;
        const client = {
            sendRequest: async (_method: string, request: any) => {
                if (request.command === 'cwtools.ai.validateOverlay') {
                    overlayCalls++;
                    const file = request.arguments[0].files[0];
                    return {
                        ok: true,
                        validationLevel: 'catalog-overlay-batch',
                        limitations: ['global_and_localisation_checks_omitted'],
                        files: [{
                            ok: true,
                            uri: file.uri,
                            validationLevel: 'catalog-overlay-batch',
                            contentHash: require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex'),
                            diagnostics: [],
                        }],
                    };
                }
                return { ok: true };
            },
        };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        const staged = await executor.execute('typed_pdx_write', {
            filePath: target,
            mode: 'stage',
            transactionId: begin.transactionId,
            operation: { operation: 'clone_definition', source: 'test.1', newSymbol: 'test.2' },
        }, context) as any;
        expect(staged.success).to.equal(true);
        expect(fs.readFileSync(target, 'utf8')).to.equal(source);
        const validated = await executor.execute('candidate_transaction', {
            action: 'validate',
            transactionId: begin.transactionId,
        }, context) as any;
        expect(validated.success).to.equal(true);
        expect(validated.overlayValidation.validationLevel).to.equal('catalog-overlay-batch');
        expect(overlayCalls).to.equal(1);
    });

    it('preserves an existing UTF-8 BOM through typed stage, validation, and commit', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'bom-events.txt');
        fs.writeFileSync(target, Buffer.from('\uFEFFroot = {}\n', 'utf8'));
        let epoch = 0;
        const client = { sendRequest: async (_method: string, request: any) => {
            if (request.command === 'cwtools.ai.validateOverlay') {
                const file = request.arguments[0].files[0];
                return { ok: true, validationLevel: 'catalog-overlay-batch', files: [{ ok: true, uri: file.uri, validationLevel: 'catalog-overlay-batch', contentHash: require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex'), diagnostics: [] }] };
            }
            epoch++; return { ok: true };
        } };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        (executor as any).lspHandler.getDiagnostics = async () => ({ diagnostics: [], freshness: 'fresh', truncated: false, lastEpoch: ++epoch });
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', { filePath: target, mode: 'stage', transactionId: begin.transactionId, operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy' } }, context);
        const validated = await executor.execute('candidate_transaction', { action: 'validate', transactionId: begin.transactionId }, context) as any;
        expect(validated.success).to.equal(true);
        const committed = await executor.execute('candidate_transaction', { action: 'commit', transactionId: begin.transactionId }, context) as any;
        expect(committed.success).to.equal(true);
        expect(fs.readFileSync(target).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).to.equal(true);
    });

    it('rejects incomplete overlay validation responses instead of validating uncovered files', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'events.txt');
        fs.writeFileSync(target, 'root = {}\n');
        const client = { sendRequest: async () => ({ ok: true, files: [] }) };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', {
            filePath: target, mode: 'stage', transactionId: begin.transactionId,
            operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy' },
        }, context);
        const validated = await executor.execute('candidate_transaction', { action: 'validate', transactionId: begin.transactionId }, context) as any;
        expect(validated.success).to.equal(false);
        expect(validated.error).to.include('file result');
    });

    it('rejects malformed overlay diagnostics instead of dropping them', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'events.txt');
        fs.writeFileSync(target, 'root = {}\n');
        const client = { sendRequest: async (_method: string, request: any) => {
            const file = request.arguments[0].files[0];
            return { ok: true, files: [{ ok: true, uri: file.uri, contentHash: require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex'), diagnostics: [{ severity: 1, message: 'numeric severity' }] }] };
        } };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', { filePath: target, mode: 'stage', transactionId: begin.transactionId, operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy' } }, context);
        const validated = await executor.execute('candidate_transaction', { action: 'validate', transactionId: begin.transactionId }, context) as any;
        expect(validated.success).to.equal(false);
        expect(validated.error).to.include('severity');
    });

    it('keeps a candidate transaction uncommittable when overlay diagnostics contain an error', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'events.txt');
        fs.writeFileSync(target, 'root = {}\n');
        const client = {
            sendRequest: async (_method: string, request: any) => {
                if (request.command === 'cwtools.ai.validateOverlay') {
                    const file = request.arguments[0].files[0];
                    return {
                        ok: true,
                        files: [{
                            ok: true,
                            uri: file.uri,
                            contentHash: require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex'),
                            diagnostics: [{ code: 'CW999', severity: 'error', message: 'bad candidate', line: 0, column: 0 }],
                        }],
                    };
                }
                return { ok: true };
            },
        };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', {
            filePath: target,
            mode: 'stage',
            transactionId: begin.transactionId,
            operation: { operation: 'clone_definition', source: 'root', newSymbol: 'root_copy' },
        }, context);
        const validated = await executor.execute('candidate_transaction', {
            action: 'validate',
            transactionId: begin.transactionId,
        }, context) as any;
        expect(validated.success).to.equal(false);
        const committed = await executor.execute('candidate_transaction', {
            action: 'commit',
            transactionId: begin.transactionId,
        }, context) as any;
        expect(committed.success).to.equal(false);
        expect(fs.readFileSync(target, 'utf8')).to.equal('root = {}\n');
    });

    it('fails candidate rollback when fresh diagnostics do not restore the baseline multiset', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'rollback-diagnostics.txt');
        const source = 'root = {}\n';
        fs.writeFileSync(target, source);
        const client = { sendRequest: async (_method: string, request: any) => {
            if (request.command === 'cwtools.ai.validateOverlay') {
                const file = request.arguments[0].files[0];
                return { ok: true, files: [{ ok: true, uri: file.uri, contentHash: require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex'), diagnostics: [] }] };
            }
            return { ok: true };
        } };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        let diagnosticsCall = 0;
        (executor as any).lspHandler.getDiagnostics = async () => {
            diagnosticsCall++;
            const baselineDiagnostic = { code: 'CW100', severity: 'warning', message: 'baseline warning', line: 1, column: 1 };
            const diagnostics = diagnosticsCall === 1 ? [baselineDiagnostic, baselineDiagnostic]
                : diagnosticsCall === 2 ? [{ code: 'CW999', severity: 'error', message: 'reject candidate', line: 1, column: 1 }]
                    : [baselineDiagnostic];
            return { diagnostics, freshness: 'fresh', truncated: false, lastEpoch: diagnosticsCall };
        };
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', { filePath: target, mode: 'stage', transactionId: begin.transactionId, operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy' } }, context);
        await executor.execute('candidate_transaction', { action: 'validate', transactionId: begin.transactionId }, context);
        const committed = await executor.execute('candidate_transaction', { action: 'commit', transactionId: begin.transactionId }, context) as any;
        expect(committed.success).to.equal(false);
        expect(committed.commit.rollback.succeeded).to.equal(false);
        expect(committed.commit.rollback.errors[0].error).to.include('diagnostics did not match baseline');
        expect(committed.state).to.equal('active');
        expect(fs.readFileSync(target, 'utf8')).to.equal(source);

        const overlay = executor.parentRunnerOptions?.vfsOverlay;
        expect(overlay?.has(target)).to.equal(true);
        expect(overlay?.get(target)).to.include('copy');
        const status = await executor.execute('candidate_transaction', { action: 'status', transactionId: begin.transactionId }, context) as any;
        expect(status.success).to.equal(true);
        expect(status.state).to.equal('active');
        expect(status.files).to.deep.equal([target]);
        const discarded = await executor.execute('candidate_transaction', { action: 'discard', transactionId: begin.transactionId }, context) as any;
        expect(discarded.success).to.equal(true);
        expect(discarded.state).to.equal('discarded');
        expect(overlay?.size).to.equal(0);
    });

    it('fails candidate rollback when server content hash does not match the restored base', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const target = path.join(workspaceRoot, 'rollback-server-hash.txt');
        const source = 'root = {}\n';
        fs.writeFileSync(target, source);
        let overlayCalls = 0;
        let rollbackBaseHash: string | undefined;
        const client = { sendRequest: async (_method: string, request: any) => {
            if (request.command === 'cwtools.ai.validateOverlay') {
                overlayCalls++;
                const file = request.arguments[0].files[0];
                if (overlayCalls === 2) rollbackBaseHash = file.baseHash;
                const contentHash = overlayCalls === 1
                    ? require('crypto').createHash('sha256').update(file.content, 'utf8').digest('hex')
                    : '0'.repeat(64);
                return { ok: true, files: [{ ok: true, uri: file.uri, contentHash, diagnostics: [] }] };
            }
            return { ok: true };
        } };
        const executor = new AgentToolExecutor(client as any, workspaceRoot);
        executor.parentRunnerOptions = { mode: 'build' } as any;
        const context = { runnerOptions: { mode: 'build' }, scopeId: 'candidate-run' } as any;
        let diagnosticsCall = 0;
        (executor as any).lspHandler.getDiagnostics = async () => ({
            diagnostics: diagnosticsCall++ === 1 ? [{ code: 'CW999', severity: 'error', message: 'reject candidate', line: 1, column: 1 }] : [],
            freshness: 'fresh', truncated: false, lastEpoch: diagnosticsCall,
        });
        const begin = await executor.execute('candidate_transaction', { action: 'begin' }, context) as any;
        await executor.execute('typed_pdx_write', { filePath: target, mode: 'stage', transactionId: begin.transactionId, operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy' } }, context);
        await executor.execute('candidate_transaction', { action: 'validate', transactionId: begin.transactionId }, context);
        const committed = await executor.execute('candidate_transaction', { action: 'commit', transactionId: begin.transactionId }, context) as any;
        expect(committed.success).to.equal(false);
        expect(committed.commit.rollback.succeeded).to.equal(false);
        expect(committed.commit.rollback.errors[0].error).to.include('server content did not match baseline');
        expect(overlayCalls).to.equal(2);
        expect(rollbackBaseHash).to.equal(require('crypto').createHash('sha256').update(source, 'utf8').digest('hex'));
        expect(fs.readFileSync(target, 'utf8')).to.equal(source);
    });

    it('emits a non-shadow policy decision before a safe read', async () => {
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const target = path.join(workspaceRoot, 'read.txt');
        fs.writeFileSync(target, 'ok');
        const events: any[] = [];
        const result = await executor.execute('read_file', { file: target }, {
            runnerOptions: { mode: 'build', topicId: 'policy-test' },
            runEventSink: { appendSoon: (type: string, payload: any) => events.push({ type, payload }) },
        } as any) as any;
        expect(result.content).to.include('ok');
        expect(events.some(event => event.type === 'policy_resolved' && event.payload.shadow === false && event.payload.action === 'allow')).to.equal(true);
    });

    it('enforces a loaded skill allowed-tools policy for the current run', async () => {
        const skillDir = path.join(workspaceRoot, '.agents', 'skills', 'read-only-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
            '---',
            'name: read-only-skill',
            'description: read only',
            'allowed-tools: read_file',
            '---',
            'Read the requested file.',
        ].join('\n'), 'utf8');
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const context = {
            runnerOptions: { mode: 'build', domain: 'general', topicId: 'skill-policy', runRecord: { runId: 'skill-run' } },
        } as any;

        const loaded = await executor.execute('run_skill', { name: 'read-only-skill' }, context) as any;
        expect(loaded.success).to.equal(true);
        expect(loaded.policyEnforced).to.equal(true);
        const denied = await executor.execute('get_diagnostics', {}, context) as any;
        expect(denied.skillPolicyDenied).to.equal(true);
        expect(denied.allowedTools).to.deep.equal(['read_file']);
    });

    it('only narrows skill tool policies and clears them at run completion', async () => {
        const skills = [
            { name: 'broad-skill', allowedTools: 'read_file, get_diagnostics' },
            { name: 'narrow-skill', allowedTools: 'read_file' },
            { name: 'unrestricted-skill', allowedTools: undefined },
        ];
        for (const skill of skills) {
            const skillDir = path.join(workspaceRoot, '.agents', 'skills', skill.name);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
                '---',
                `name: ${skill.name}`,
                `description: ${skill.name}`,
                ...(skill.allowedTools ? [`allowed-tools: ${skill.allowedTools}`] : []),
                '---',
                'Follow the skill.',
            ].join('\n'), 'utf8');
        }

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const context = {
            runnerOptions: { mode: 'build', domain: 'general', topicId: 'skill-policy', runRecord: { runId: 'monotonic-skill-run' } },
        } as any;
        const broad = await executor.execute('run_skill', { name: 'broad-skill' }, context) as any;
        expect(broad.effectiveAllowedTools).to.deep.equal(['get_diagnostics', 'read_file']);
        const narrow = await executor.execute('run_skill', { name: 'narrow-skill' }, context) as any;
        expect(narrow.effectiveAllowedTools).to.deep.equal(['read_file']);
        const unrestricted = await executor.execute('run_skill', { name: 'unrestricted-skill' }, context) as any;
        expect(unrestricted.policyEnforced).to.equal(true);
        expect(unrestricted.effectiveAllowedTools).to.deep.equal(['read_file']);

        const denied = await executor.execute('get_diagnostics', {}, context) as any;
        expect(denied.skillPolicyDenied).to.equal(true);
        executor.clearSkillPolicyForRun('monotonic-skill-run');
        const afterCleanup = await executor.execute('get_diagnostics', {}, context) as any;
        expect(afterCleanup.skillPolicyDenied).to.equal(undefined);
    });

    it('enforces the General Coding domain even for unadvertised direct tool calls', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const context = {
            runnerOptions: {
                mode: 'utility',
                domain: 'general',
                abortSignal: new AbortController().signal,
            },
        } as any;

        const semanticCall = await executor.execute('query_cwt_schema', { query: 'anything' }, context) as any;
        expect(semanticCall.success).to.equal(false);
        expect(semanticCall.error).to.include('Paradox-only capability');

        const mcpCall = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, context) as any;
        expect(mcpCall.success).to.equal(false);
        expect(mcpCall.error).to.include('not found in configuration');

        const memoryCall = await executor.execute('set_memory', { key: 'secret', value: 'value' }, context) as any;
        expect(memoryCall.success).to.equal(true);
        const generalMemory = await executor.execute('query_blackboard', { key: 'secret' }, context) as any;
        expect(generalMemory.found).to.equal(true);
        expect(generalMemory.entry.value).to.equal('value');
        const paradoxMemory = await executor.execute('query_blackboard', { key: 'secret' }, {
            runnerOptions: { mode: 'build', domain: 'paradox' },
        } as any) as any;
        expect(paradoxMemory).to.deep.equal({ found: false });

        executor.blackboard.write('domain:paradox:topic:session:secret', 'paradox value', 'free_text', 'test');
        const generalBlackboard = await executor.execute('query_blackboard', { key: 'secret' }, {
            runnerOptions: { mode: 'orchestrator', domain: 'general' },
        } as any) as any;
        expect(generalBlackboard.found).to.equal(true);
        expect(generalBlackboard.entry.value).to.equal('value');
        const paradoxBlackboard = await executor.execute('query_blackboard', { key: 'secret' }, {
            runnerOptions: { mode: 'script', domain: 'paradox' },
        } as any) as any;
        expect(paradoxBlackboard.found).to.equal(true);
        expect(paradoxBlackboard.entry.value).to.equal('paradox value');
        const otherTopicBlackboard = await executor.execute('query_blackboard', { key: 'secret' }, {
            runnerOptions: { mode: 'script', domain: 'paradox', topicId: 'other-topic' },
        } as any) as any;
        expect(otherTopicBlackboard).to.deep.equal({ found: false });

        const workflowCall = await executor.execute('save_workflow', {
            title: 'bad domain switch',
            description: 'should not save',
            mode: 'build',
            promptSupplement: 'do work',
        }, context) as any;
        expect(workflowCall.success).to.equal(false);
        expect(workflowCall.error).to.include("domain-specific mode 'build'");
    });

    it('limits coordinator write_file calls to the current plan artifact', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        executor.fileWriteMode = 'auto';
        const context = { runnerOptions: { mode: 'orchestrator', domain: 'general', topicId: 'policy-test' } } as any;
        const projectTarget = path.join(workspaceRoot, 'client', 'blocked.ts');

        const blocked = await executor.execute('write_file', {
            file: projectTarget,
            content: 'blocked',
        }, context) as any;
        expect(blocked.success).to.equal(false);
        expect(blocked.planModeBlocked).to.equal(true);
        expect(fs.existsSync(projectTarget)).to.equal(false);

        const artifactTarget = path.join(workspaceRoot, '.cwtools', 'policy-test', 'Implementation_Plan.md');
        const allowed = await executor.execute('write_file', {
            file: artifactTarget,
            content: '# Complete plan',
        }, context) as any;
        expect(allowed.success).to.equal(true);
        expect(fs.readFileSync(artifactTarget, 'utf8')).to.equal('# Complete plan');
    });

    it('allows only current-topic plan artifacts in private extension storage', async () => {
        const privateRoot = path.join(TEMP_BASE, 'private-agent-storage');
        workspacePaths.configurePrivateAgentStorage(privateRoot);
        try {
            stubConfigOverrides['policy.preset'] = 'workspace-auto';
            const executor = new AgentToolExecutor({} as any, workspaceRoot);
            executor.fileWriteMode = 'auto';
            const context = { runnerOptions: { mode: 'plan', domain: 'paradox', topicId: 'private-topic' } } as any;
            const planPath = path.join(privateRoot, 'topics', 'private-topic', 'Implementation_Plan.md');

            const planResult = await executor.execute('write_file', {
                file: planPath,
                content: '# Complete plan',
            }, context) as any;
            expect(planResult.success).to.equal(true);
            expect(fs.readFileSync(planPath, 'utf8')).to.equal('# Complete plan');
            const readBack = await executor.execute('read_file', { file: planPath }, {
                runnerOptions: { mode: 'build', domain: 'paradox', topicId: 'private-topic' },
            } as any) as any;
            expect(readBack.content).to.include('# Complete plan');

            const walkthroughPath = path.join(privateRoot, 'topics', 'private-topic', 'walkthrough.md');
            const walkthroughResult = await executor.execute('write_file', {
                file: walkthroughPath,
                content: '# Walkthrough',
            }, {
                runnerOptions: { mode: 'build', domain: 'paradox', topicId: 'private-topic' },
            } as any) as any;
            expect(walkthroughResult.success).to.equal(true);
            expect(fs.readFileSync(walkthroughPath, 'utf8')).to.equal('# Walkthrough');
            const otherWalkthrough = path.join(privateRoot, 'topics', 'other-topic', 'walkthrough.md');
            const blockedWalkthrough = await executor.execute('write_file', {
                file: otherWalkthrough,
                content: '# Wrong walkthrough',
            }, {
                runnerOptions: { mode: 'build', domain: 'paradox', topicId: 'private-topic' },
            } as any) as any;
            expect(blockedWalkthrough.policyDenied).to.equal(true);
            expect(fs.existsSync(otherWalkthrough)).to.equal(false);

            const blueprintResult = await executor.execute('write_design_blueprint', {
                blueprint: { title: 'Incomplete blueprint' },
            }, context) as any;
            expect(blueprintResult.policyDenied).to.equal(undefined);
            expect(blueprintResult.message).to.include('missing required planning section');

            const otherTopic = path.join(privateRoot, 'topics', 'other-topic', 'Implementation_Plan.md');
            const blocked = await executor.execute('write_file', {
                file: otherTopic,
                content: '# Wrong topic',
            }, context) as any;
            expect(blocked.planModeBlocked).to.equal(true);
            expect(fs.existsSync(otherTopic)).to.equal(false);
        } finally {
            workspacePaths.configurePrivateAgentStorage(undefined);
            fs.rmSync(privateRoot, { recursive: true, force: true });
        }
    });
});

describe('HeadTailTextBuffer', () => {
    it('keeps bounded head and tail output while recording omitted chars', () => {
        const buffer = new HeadTailTextBuffer(12, 4);
        buffer.append('abcdef');
        buffer.append('ghijklmnop');

        const output = buffer.toString();
        expect(output).to.equal('abcdefgh\n... [4 chars omitted] ...\nmnop');
    });

    it('does not add an omission marker when output fits', () => {
        const buffer = new HeadTailTextBuffer(12, 4);
        buffer.append('hello ');
        buffer.append('world');

        expect(buffer.toString()).to.equal('hello world');
    });
});

function makeWorkspace(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-agent-tools-'));
}

function cleanupWorkspace(workspaceRoot: string | undefined): void {
    if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
}

function makeContext(topicId = 'topic-a'): any {
    const abortController = new AbortController();
    return {
        runnerOptions: {
            topicId,
            abortSignal: abortController.signal,
        },
    };
}

describe('agent tool file path safety', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        diagnosticPairs = [];
        ignoredDiagnostics = [];
        cleanupWorkspace(workspaceRoot);
    });

    function createFileHandler() {
        return new FileToolHandler({ workspaceRoot, fileWriteMode: 'auto' });
    }

    it('rejects git_ops file arguments outside the workspace before invoking git', async () => {
        fs.mkdirSync(path.join(workspaceRoot, '.git'));
        const handler = createFileHandler();
        const diff = await handler.gitOps({ action: 'diff', file: '../outside.txt' });
        const checkout = await handler.gitOps({ action: 'checkout', file: '../outside.txt' });
        expect(diff.success).to.equal(false);
        expect(diff.message).to.include('inside the workspace');
        expect(checkout.success).to.equal(false);
        expect(checkout.message).to.include('inside the workspace');
    });

    it('remaps legacy .cwtools-ai/scratch writes into the current topic folder', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile(
            { file: '.cwtools-ai/scratch/notes.txt', content: 'hello topic scratch' },
            makeContext('topic-123'),
        );

        expect(result.success).to.equal(true);
        const expectedPath = path.join(workspaceRoot, '.cwtools', 'topic-123', 'scratch', 'notes.txt');
        const legacyPath = path.join(workspaceRoot, '.cwtools', 'scratch', 'notes.txt');
        expect(fs.readFileSync(expectedPath, 'utf8')).to.equal('hello topic scratch');
        expect(fs.existsSync(legacyPath)).to.equal(false);
    });

    it('remaps loose .cwtools-ai writes into the current topic folder', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile(
            { file: '.cwtools-ai/notes.md', content: 'topic note' },
            makeContext('topic-123'),
        );

        expect(result.success).to.equal(true);
        const expectedPath = path.join(workspaceRoot, '.cwtools', 'topic-123', 'notes.md');
        const loosePath = path.join(workspaceRoot, '.cwtools', 'notes.md');
        expect(fs.readFileSync(expectedPath, 'utf8')).to.equal('topic note');
        expect(fs.existsSync(loosePath)).to.equal(false);
    });

    it('bypasses ReadTracker only for exact .cwtools path segments', async () => {
        const handler = createFileHandler();
        const rejectedContext = makeContext('topic-123');
        const rejectedCanWrite = sinon.stub().returns({ ok: false, reason: 'file was not read' });
        rejectedContext.agentRunner = {
            readTracker: { canWrite: rejectedCanWrite, markWritten: sinon.spy() },
        };

        const rejected = await handler.writeFile(
            { file: '.cwtools-evil/notes.md', content: 'must be read first' },
            rejectedContext,
        );

        expect(rejected.success).to.equal(false);
        expect(rejected.message).to.include('ReadTracker Blocked');
        expect(rejectedCanWrite.calledOnce).to.equal(true);

        const allowedContext = makeContext('topic-123');
        const allowedCanWrite = sinon.stub().returns({ ok: false, reason: 'file was not read' });
        allowedContext.agentRunner = {
            readTracker: { canWrite: allowedCanWrite, markWritten: sinon.spy() },
        };
        const allowed = await handler.writeFile(
            { file: '.cwtools/topic-123/notes.md', content: 'topic artifact' },
            allowedContext,
        );

        expect(allowed.success).to.equal(true);
        expect(allowedCanWrite.called).to.equal(false);
    });

    it('rejects absolute paths that only share the workspace path prefix', async () => {
        const handler = createFileHandler();
        const siblingRoot = `${workspaceRoot}-sibling`;
        fs.mkdirSync(siblingRoot, { recursive: true });
        try {
            const result = await handler.writeFile(
                { file: path.join(siblingRoot, 'outside.txt'), content: 'outside' },
                makeContext('topic-123'),
            );

            expect(result.success).to.equal(false);
            expect(result.message).to.include('outside the workspace root');
            expect(fs.existsSync(path.join(siblingRoot, 'outside.txt'))).to.equal(false);
        } finally {
            cleanupWorkspace(siblingRoot);
        }
    });

    it('rejects .yml writes through generic write tools', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const writeResult = await handler.writeFile({ file: ymlRel, content: 'l_english:\n old_key:0 "New"\n' }, ctx);
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('write_localisation');

        const editResult = await handler.editFile({
            filePath: ymlRel,
            oldString: ' old_key:0 "Old"',
            newString: ' old_key:0 "New"',
        }, ctx) as any;
        expect(editResult.success).to.equal(false);
        expect(editResult.message).to.include('write_localisation');

        expect(fs.readFileSync(ymlAbs, 'utf8')).to.equal(original);
    });

    it('lets General Coding write ordinary YAML and text without Paradox file gates', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        ctx.runnerOptions.mode = 'utility';
        ctx.runnerOptions.domain = 'general';

        const yamlRel = '.github/workflows/verify.yml';
        const yamlResult = await handler.writeFile({
            file: yamlRel,
            content: 'name: verify\non:\n  push:\n',
        }, ctx);
        expect(yamlResult.success).to.equal(true);
        const yamlBytes = fs.readFileSync(path.join(workspaceRoot, '.github', 'workflows', 'verify.yml'));
        expect(yamlBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).to.equal(false);

        const textRel = 'fixtures/unbalanced-template.txt';
        const textResult = await handler.writeFile({
            file: textRel,
            content: 'literal template brace: {\n',
        }, ctx);
        expect(textResult.success).to.equal(true);
        expect(fs.readFileSync(path.join(workspaceRoot, 'fixtures', 'unbalanced-template.txt'), 'utf8'))
            .to.equal('literal template brace: {\n');
    });

    it('serves targeted read_file context consistently across domains', async () => {
        const eventDir = path.join(workspaceRoot, 'events');
        fs.mkdirSync(eventDir, { recursive: true });
        const target = path.join(eventDir, 'sample.txt');
        fs.writeFileSync(target, 'sample = {\n}\n');
        const executor = new AgentToolExecutor({} as any, workspaceRoot);

        const general = await executor.execute('read_file', { file: target, centerLine: 0, radius: 1 }, {
            runnerOptions: { mode: 'utility', domain: 'general' },
        } as any) as any;
        expect(general.content).to.include('sample = {');

        const paradox = await executor.execute('read_file', { file: target, centerLine: 0, radius: 1 }, {
            runnerOptions: { mode: 'build', domain: 'paradox' },
        } as any) as any;
        expect(paradox.content).to.equal(general.content);
    });

    it('applies edit_file replacements through the shared fuzzy replacer', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'notes.md');
        fs.writeFileSync(fileAbs, '  old title  \n  old body  \n', 'utf8');

        const result = await handler.editFile({
            filePath: fileAbs,
            oldString: 'old title\nold body',
            newString: 'new title\nnew body',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('new title\nnew body\n');
        expect(result.stats.linesAdded).to.equal(0);
        expect(result.stats.linesRemoved).to.equal(0);
    });

    it('replaces an explicit line range with replace_lines', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'test_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nold a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nnew a\nnew b\nline four');
    });

    it('guards replace_lines with expectedContent to avoid stale line-range edits', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'guarded_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nchanged a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedContent: 'old a\nold b',
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('safety check failed');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nchanged a\nold b\nline four');
    });

    it('allows guarded replace_lines when expected anchors still match', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'anchored_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = old.1\n\tis_triggered_only = yes\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedStartText: 'id = old.1',
            expectedEndText: 'is_triggered_only = yes',
            newContent: '\tid = new.1\n\tis_triggered_only = yes',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = new.1');
    });

    it('rejects replace_lines for .yml localisation files', async () => {
        const handler = createFileHandler();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: ymlRel,
            startLine: 2,
            endLine: 2,
            newContent: ' old_key:0 "New"',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('write_localisation');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.equal(original);
    });

    it('rejects generic PDX edits that would unbalance brace structure', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'common', 'buildings', 'guarded_buildings.txt');
        const original = 'building_guarded = {\n\tcost = { minerals = 100 }\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const writeResult = await handler.writeFile({
            file: fileAbs,
            content: 'building_guarded = {\n\tcost = { minerals = 200 }\n',
        }, makeContext()) as any;
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

        const replaceResult = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 3,
            endLine: 3,
            newContent: '',
        }, makeContext()) as any;
        expect(replaceResult.success).to.equal(false);
        expect(replaceResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

    });

    it('ignores PDX brace-like text in strings and comments during edit safety checks', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'string_braces_events.txt');
        const original = 'country_event = {\n\ttitle = "old { title }"\n\t# } comment brace\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: '\ttitle = "new } title {"\n\t# { comment brace',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('title = "new } title {"');
    });

    it('rejects write_localisation targets outside real localisation folders', async () => {
        const handler = createFileHandler();
        const result = await handler.writeLocalisation({
            filePath: '.cwtools-ai/scratch/bad_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'bad_key', value: 'Bad' }],
        }, makeContext('topic-123'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('Localisation files must be written under');
        const rejectedPath = path.join(workspaceRoot, '.cwtools', 'topic-123', 'scratch', 'bad_l_english.yml');
        expect(fs.existsSync(rejectedPath)).to.equal(false);
    });

    it('writes localisation entries into an explicit multi-file language transaction', async () => {
        const handler = createFileHandler();
        fs.mkdirSync(path.join(workspaceRoot, 'localisation', 'english'), { recursive: true });
        const base = path.join('localisation', 'english', 'samplemod_events_l_english.yml');
        const result = await handler.writeLocalisation({
            filePath: base,
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'samplemod.1.title', value: 'SampleMod Echo' }],
        }, makeContext('topic-123'));
        expect(result.success).to.equal(true);
        const englishPath = path.join(workspaceRoot, 'localisation', 'english', 'samplemod_events_l_english.yml');
        const chinesePath = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'samplemod_events_l_simp_chinese.yml');
        expect(fs.existsSync(englishPath)).to.equal(true);
        expect(fs.existsSync(chinesePath)).to.equal(true);
        expect(fs.readFileSync(englishPath, 'utf8')).to.include('samplemod.1.title');
        expect(fs.readFileSync(chinesePath, 'utf8')).to.include('samplemod.1.title');
    });

    it('rolls back every language when a multi-file localisation write fails', async () => {
        const handler = createFileHandler();
        const englishPath = path.join(workspaceRoot, 'localisation', 'english', 'rollback_l_english.yml');
        const chinesePath = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'rollback_l_simp_chinese.yml');
        fs.mkdirSync(path.dirname(englishPath), { recursive: true });
        fs.mkdirSync(path.dirname(chinesePath), { recursive: true });
        const englishOriginal = '\uFEFFl_english:\n old_key:0 "Old"\n';
        const chineseOriginal = '\uFEFFl_simp_chinese:\n old_key:0 "旧"\n';
        fs.writeFileSync(englishPath, englishOriginal, 'utf8');
        fs.writeFileSync(chinesePath, chineseOriginal, 'utf8');
        const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
        let injected = false;
        const writeStub = sinon.stub(fs.promises, 'writeFile').callsFake(async (target: any, data: any, options: any) => {
            if (!injected && path.resolve(String(target)) === path.resolve(chinesePath) && String(data).includes('new_key')) {
                injected = true;
                throw new Error('injected second-language failure');
            }
            return originalWriteFile(target, data, options as any);
        });
        try {
            const result = await handler.writeLocalisation({
                filePath: path.relative(workspaceRoot, englishPath),
                language: 'l_english',
                languages: ['l_english', 'l_simp_chinese'],
                entries: [{ key: 'new_key', value: 'New' }],
            }, makeContext('topic-rollback'));
            expect(result.success).to.equal(false);
            expect(result.message).to.include('rolled back');
            expect(fs.readFileSync(englishPath, 'utf8')).to.equal(englishOriginal);
            expect(fs.readFileSync(chinesePath, 'utf8')).to.equal(chineseOriginal);
        } finally {
            writeStub.restore();
        }
    });

    it('preserves multi-file localisation authorization failures and writes nothing', async () => {
        const handler = createFileHandler();
        const english = path.join(workspaceRoot, 'localisation', 'english', 'auth_l_english.yml');
        const chinese = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'auth_l_simp_chinese.yml');
        fs.mkdirSync(path.dirname(english), { recursive: true });
        fs.mkdirSync(path.dirname(chinese), { recursive: true });
        fs.writeFileSync(english, '\uFEFFl_english:\n key:0 \"Old\"\n', 'utf8');
        fs.writeFileSync(chinese, '\uFEFFl_simp_chinese:\n key:0 \"Old Chinese\"\n', 'utf8');
        const context = makeContext();
        context.agentRunner = {
            readTracker: {
                canWrite: sinon.stub().returns({ ok: false, reason: 'file was not read' }),
                markWritten: sinon.spy(),
            },
        };

        const result = await handler.writeLocalisation({
            filePath: english,
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'key', value: 'New' }],
        }, context);

        expect(result.success).to.equal(false);
        expect(result.message).to.include('authorization failed for l_english');
        expect(result.message).to.include('ReadTracker Blocked');
        expect(fs.readFileSync(english, 'utf8')).to.include('Old');
        expect(fs.readFileSync(chinese, 'utf8')).to.include('Old Chinese');
    });

    it('rejects a multi-file transaction when the primary file is outside localisation folders', async () => {
        const handler = createFileHandler();
        const result = await handler.writeLocalisation({
            filePath: '.cwtools-ai/scratch/samplemod_events_l_english.yml',
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'samplemod.1.title', value: 'SampleMod Echo' }],
        }, makeContext('topic-123'));
        expect(result.success).to.equal(false);
        expect(result.message).to.include('multi-file transaction rejected');
    });

    it('reports list_directory truncation metadata without claiming a full total', async () => {
        const handler = createFileHandler();
        const dirAbs = path.join(workspaceRoot, 'many-files');
        fs.mkdirSync(dirAbs, { recursive: true });
        for (let i = 0; i < 205; i++) {
            fs.writeFileSync(path.join(dirAbs, `file-${String(i).padStart(3, '0')}.txt`), 'x', 'utf8');
        }

        const result = await handler.listDirectory({ directory: dirAbs });

        expect(result.entries).to.have.length(200);
        expect(result.truncated).to.equal(true);
        expect(result.hasMore).to.equal(true);
        expect(result.returnedCount).to.equal(200);
        expect(result.limit).to.equal(200);
        expect(result).to.not.have.property('total');
    });

    it('extracts write target paths for runner scheduling without marking localisation as superseded', () => {
        expect(getAgentToolTargetFiles('write_localisation', {
            filePath: 'localisation/english/samplemod_l_english.yml',
            languages: ['l_english', 'l_simp_chinese'],
        }, workspaceRoot)).to.deep.equal([
            path.join(workspaceRoot, 'localisation', 'english', 'samplemod_l_english.yml'),
            path.join(workspaceRoot, 'localisation', 'simp_chinese', 'samplemod_l_simp_chinese.yml'),
        ]);
        expect(getAgentToolTargetFiles('replace_lines', { filePath: 'common/scripted_effects/samplemod.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'scripted_effects', 'samplemod.txt')]);
        expect(getAgentToolTargetFiles('write_file', { file: 'common/relics/samplemod.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'relics', 'samplemod.txt')]);
        expect(getAgentToolTargetFiles('write_design_blueprint', {}, workspaceRoot, 'topic-123'))
            .to.deep.equal([
                path.join(workspaceRoot, '.cwtools', 'topic-123', 'Implementation_Plan.md'),
            ]);

        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_file')).to.equal(true);
        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_localisation')).to.equal(false);
    });

    it('loads the rich blueprint contract on demand instead of every request', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'write_design_blueprint');
        const contractTool = TOOL_DEFINITIONS.find(def => def.function.name === 'get_design_blueprint_contract');
        const required = DESIGN_BLUEPRINT_DETAILED_PARAMETERS.required ?? [];

        expect(tool?.function.parameters.required).to.deep.equal(['blueprint']);
        expect(contractTool).to.not.equal(undefined);
        expect(JSON.stringify(tool).length).to.be.lessThan(1_500);
        expect(required).to.include.members([
            'title',
            'entities',
            'commonDirectoryReview',
            'subsystemPlan',
            'triggerPlan',
            'rewardPlan',
            'cleanupPlan',
            'evidence',
            'dependencyOrder',
            'featureManifest',
            'taskPlan',
        ]);
    });

    it('rejects incomplete design blueprints before writing', async () => {
        const handler = createFileHandler();
        const result = await handler.writeDesignBlueprint({
            title: 'Incomplete Chain',
            entities: [{ id: 'test.1', type: 'country_event', file: 'events/test.txt' }],
            dependencyOrder: ['events/test.txt'],
        } as any, makeContext('topic-blueprint'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('missing required planning section');
        expect(fs.existsSync(path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'Implementation_Plan.md'))).to.equal(false);
    });

    it('writes complete design blueprints with a completeness gate', async () => {
        const handler = createFileHandler();
        const result = await handler.writeDesignBlueprint({
            title: 'Native Hook Event Chain',
            entities: [{
                id: 'test.1',
                type: 'country_event',
                file: 'events/test.txt',
                triggeredBy: 'common/on_actions yearly pulse',
                fires: ['test_reward via owner country scope'],
                scopeContext: 'this=country root=country',
            }],
            commonDirectoryReview: [
                {
                    directory: 'common/on_actions',
                    role: 'entry hook',
                    candidateTypes: ['on_action'],
                    selected: true,
                    rationale: 'Native yearly hook matches the requested entry point.',
                    findings: 'CWT/LSP on_action evidence confirms country pulse hook support.',
                },
                {
                    directory: 'common/situations',
                    role: 'progression anchor',
                    candidateTypes: ['situation'],
                    selected: false,
                    rationale: 'The request does not need long-running UI progression.',
                    findings: 'list_directory("common") found situations, but archetype role is too heavy for this flow.',
                },
            ],
            subsystemPlan: [{
                layer: 'hooks',
                directories: ['common/on_actions'],
                entities: ['test_on_action'],
                rationale: 'Use the engine hook as the cascade entry.',
                requirementSource: 'user requested an event chain with native trigger.',
            }],
            triggerPlan: [{
                nodeId: 'test.1',
                mechanism: 'on_action',
                scopeBridge: 'country_event in country scope',
                timing: 'yearly pulse',
                rationale: 'Native timing avoids a pure text-only chain.',
            }],
            rewardPlan: [{
                rewardId: 'test_reward',
                directory: 'common/relics',
                entityType: 'relic',
                playerValue: 'Permanent reward with active effect.',
                implementation: 'Final event grants the relic with add_relic.',
                balanceNotes: 'Activation cooldown and cost are planned.',
            }],
            cleanupPlan: [{
                target: 'test_chain_active flag',
                lifecycle: 'Set when the first event fires.',
                cleanup: 'Removed in the resolution event.',
                owner: 'country',
            }],
            evidence: [
                {
                    sourceType: 'cwt',
                    source: 'query_rules(effect=country_event)',
                    insight: 'CWT/LSP scope evidence supports the event call.',
                },
                {
                    sourceType: 'common_inventory',
                    source: 'list_directory("common")',
                    insight: 'common/on_actions and common/situations were compared.',
                },
            ],
            dependencyOrder: ['common/on_actions/test.txt', 'events/test.txt'],
            featureManifest: {
                objective: 'Create a native-hook event with a closed flag lifecycle.',
                entities: [
                    { kind: 'event', id: 'test.1', operation: 'define' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'set' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'read' },
                ],
                requiredEdges: [
                    { from: 'test.1', relation: 'set', to: 'test_chain_active' },
                ],
                invariants: ['The flag is read after it is set and removed at closure.'],
                acceptanceCriteria: [
                    { id: 'event_exists', description: 'The event is defined.', type: 'entity_exists', subject: 'test.1' },
                    { id: 'flag_lifecycle', description: 'The flag is set and read.', type: 'flag_lifecycle', subject: 'test_chain_active' },
                ],
                expectsFileChanges: true,
            },
            taskPlan: [{
                id: 'build_event',
                agentType: 'build',
                prompt: 'Implement test.1 with the approved flag lifecycle.',
                plannedFiles: ['events/test.txt'],
                produces: [
                    { kind: 'event', id: 'test.1', operation: 'define' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'set' },
                ],
                consumes: [{ kind: 'flag', id: 'test_chain_active', operation: 'read' }],
                dependencies: [],
                acceptanceChecks: [
                    { id: 'event_exists', description: 'The event is defined.', type: 'entity_exists', subject: 'test.1' },
                    { id: 'flag_lifecycle', description: 'The flag is set and read.', type: 'flag_lifecycle', subject: 'test_chain_active' },
                ],
            }],
        }, makeContext('topic-blueprint'));

        expect(result.success).to.equal(true);
        const planPath = path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'Implementation_Plan.md');
        const content = fs.readFileSync(planPath, 'utf8');
        expect(content).to.include('# Implementation Plan: Native Hook Event Chain');
        expect(content).to.include('## Blueprint Completeness Gate');
        expect(content).to.include('Common Directory Capability Review');
        expect(content).to.include('Reward and Outcome Plan');
        expect(content).to.include('Executable Feature Relationship Contract');
        expect(content).to.include('Approved Multi-Agent Task DAG');
        expect(content).to.include('```cwtools-blueprint');
        expect(content).to.include('```cwtools-plan');
        expect(result.dataFilePath).to.equal(planPath);
        expect(result.writtenFiles).to.deep.equal([planPath]);
        expect(fs.existsSync(path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'design_blueprint.md'))).to.equal(false);
        expect(fs.existsSync(path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'design_blueprint.json'))).to.equal(false);
    });

    it('lets orchestrator sub-agents write localisation without waiting for pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });

        const result = await handler.writeLocalisation({
            filePath: 'localisation/english/samplemod_rakata_arc_epilogue_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'samplemod_rakata_arc_epilogue_title', value: 'Epilogue' }],
        }, {
            runnerOptions: {
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any);

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        const ymlAbs = path.join(workspaceRoot, 'localisation', 'english', 'samplemod_rakata_arc_epilogue_l_english.yml');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.include('samplemod_rakata_arc_epilogue_title');
    });

    it('lets orchestrator sub-agents run guarded replace_lines without pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });
        const fileAbs = path.join(workspaceRoot, 'events', 'samplemod_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = samplemod.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            expectedContent: '\tid = samplemod.1',
            newContent: '\tid = samplemod.2',
        }, {
            runnerOptions: {
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = samplemod.2');
    });

    it('accepts replace_lines expectedContent copied from numbered read_file output', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'numbered_guard_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = guard.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            expectedContent: '2 | \tid = guard.1',
            newContent: '\tid = guard.2',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = guard.2');
    });

    it('strips line-number prefixes from replace_lines newContent before writing', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'numbered_content_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = strip.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            newContent: '2 | \tid = strip.2',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        const written = fs.readFileSync(fileAbs, 'utf8');
        expect(written).to.include('\tid = strip.2');
        expect(written).to.not.include('2 | ');
    });

    it('strips line-number prefixes from write_file content copied from read output', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile({
            file: 'common/defines/numbered_defines.txt',
            content: '1 | NDefines = {\n2 | \tNGame = { something = 1 }\n3 | }',
        }, makeContext());

        expect(result.success).to.equal(true);
        const written = fs.readFileSync(path.join(workspaceRoot, 'common', 'defines', 'numbered_defines.txt'), 'utf8');
        expect(written).to.equal('NDefines = {\n\tNGame = { something = 1 }\n}');
    });
});

describe('agent sprite candidate tool contract', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        diagnosticPairs = [];
        ignoredDiagnostics = [];
        cleanupWorkspace(workspaceRoot);
    });

    it('registers find_sprite_candidates as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'find_sprite_candidates');
        if (!definition) {
            throw new Error('find_sprite_candidates tool definition is missing');
        }
        expect(definition.function.description).to.include('Expected value of type sprite');
        expect(definition.function.parameters.properties).to.have.property('searchContext');
    });

    it('registers find_sound_candidates as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'find_sound_candidates');
        if (!definition) {
            throw new Error('find_sound_candidates tool definition is missing');
        }
        expect(definition.function.description).to.include('show_sound');
        expect(definition.function.parameters.properties).to.have.property('searchContext');
    });

    it('registers query_localisation_index as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_localisation_index');
        if (!definition) {
            throw new Error('query_localisation_index tool definition is missing');
        }
        expect(definition.function.description).to.include('shared incremental localisation index');
        expect(definition.function.parameters.properties).to.have.property('prefix');
    });

    it('registers query_workspace_index as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_workspace_index');
        if (!definition) {
            throw new Error('query_workspace_index tool definition is missing');
        }
        expect(definition.function.description).to.include('shared incremental workspace index');
        expect(definition.function.parameters.properties).to.have.property('kind');
        expect(definition.function.parameters.properties).to.have.property('source');
    });

    it('blocks mutating tools when VS Code opens the workspace in Restricted Mode', async () => {
        const workspaceRoot = makeWorkspace();
        vscodeStub.workspace.isTrusted = false;
        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot);
            const result = await executor.execute('write_file', {
                filePath: 'blocked.txt',
                content: 'must not be written',
            }, { runnerOptions: { mode: 'build' } } as any) as any;
            expect(result.workspaceTrustRequired).to.equal(true);
            expect(fs.existsSync(path.join(workspaceRoot, 'blocked.txt'))).to.equal(false);
        } finally {
            vscodeStub.workspace.isTrusted = true;
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('registers explore_pdx_project as the bounded semantic graph entry point', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'explore_pdx_project');
        if (!definition) {
            throw new Error('explore_pdx_project tool definition is missing');
        }
        expect(definition.function.description).to.include('Primary semantic exploration');
        const properties = definition.function.parameters.properties as Record<string, { maximum?: number }> | undefined;
        expect(properties).to.have.property('depth');
        expect(properties?.depth?.maximum).to.equal(3);
        expect(properties?.maxNodes?.maximum).to.equal(100);
        expect(properties?.maxEdges?.maximum).to.equal(300);
    });

    it('registers query_project_profile as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_project_profile');
        if (!definition) {
            throw new Error('query_project_profile tool definition is missing');
        }
        expect(definition.function.description).to.include('Agent project profile');
        expect(definition.function.parameters.properties).to.have.property('section');
        expect(definition.function.parameters.properties).to.have.property('mode');
    });

    it('registers query_cwt_schema as a first-class CWT-first read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_cwt_schema');
        if (!definition) {
            throw new Error('query_cwt_schema tool definition is missing');
        }
        expect(definition.function.description).to.include('CWT-FIRST schema lookup');
        expect(definition.function.parameters.properties).to.have.property('target');
        expect(definition.function.parameters.properties).to.have.property('name');
    });

    it('tells dispatch_agents to declare known Builder plannedFiles', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'dispatch_agents');
        if (!definition) {
            throw new Error('dispatch_agents tool definition is missing');
        }

        const taskProperties = (definition.function.parameters.properties as any).tasks.items.properties;
        expect((definition.function.parameters.properties as any).tasks.maxItems).to.equal(8);
        expect(taskProperties.plannedFiles.description).to.include('Expected project files this writer will modify');
        expect((definition.function.parameters.properties as any).userConstraints.properties)
            .to.have.keys(['localisationOwnership', 'warningHandling']);
    });

    it('queries the shared localisation index when IndexService is provided', async () => {
        const fakeIndexService = {
            status: 'ready',
            locLanguages: () => ['l_english'],
            locDuplicateGroups: () => [],
            queryLocalisation: (query: any) => [{
                key: query.key,
                value: 'Hello',
                file: path.join('localisation', 'test_l_english.yml'),
                line: 2,
                language: query.language || 'l_english',
            }],
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

        const result = await executor.execute('query_localisation_index', {
            key: 'my_key',
            language: 'l_english',
        }) as any;

        expect(result.status).to.equal('ready');
        expect(result.totalCount).to.equal(1);
        expect(result.entries[0].key).to.equal('my_key');
    });

    it('returns unavailable localisation index result without IndexService', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_localisation_index', { key: 'my_key' }) as any;

        expect(result.status).to.equal('unavailable');
        expect(result.entries).to.deep.equal([]);
    });

    it('queries the shared workspace symbol index when IndexService is provided', async () => {
        let ensureArgs: any;
        const fakeIndexService = {
            status: 'ready',
            ensureWorkspaceSymbolsReady: async (args: any) => {
                ensureArgs = args;
            },
            queryWorkspaceSymbols: (query: any) => [{
                name: query.name,
                kind: query.kind || 'event',
                category: query.category || 'event',
                file: path.join('events', 'test.txt'),
                line: 3,
                source: query.source || 'script',
                container: 'country_event',
                references: query.includeReferences ? [{ file: path.join('events', 'test.txt'), line: 8, context: 'fire_only_once = yes' }] : undefined,
                updatedAt: 1000,
                fileVersion: 7,
            }],
            workspaceSymbolCount: 42,
            workspaceSymbolUpdatedAt: 2000,
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

        const result = await executor.execute('query_workspace_index', {
            name: 'samplemod.100',
            kind: 'event',
            exact: true,
            includeReferences: true,
        }) as any;

        expect(result.status).to.equal('ready');
        expect(result.totalCount).to.equal(1);
        expect(result.entries[0].name).to.equal('samplemod.100');
        expect(result.entries[0].category).to.equal('event');
        expect(result.entries[0].references).to.have.lengthOf(1);
        expect(result.entries[0].fileVersion).to.equal(7);
        expect(result.indexedSymbolNames).to.equal(42);
        expect(result.indexUpdatedAt).to.equal(2000);
        expect(ensureArgs).to.deep.equal({ includeVanilla: true });
    });

    it('traverses GUI button effect and sprite to a concrete texture asset', async () => {
        const texturePath = path.join(workspaceRoot, 'gfx', 'interface', 'samplemod_button.dds');
        fs.mkdirSync(path.dirname(texturePath), { recursive: true });
        const dds = Buffer.alloc(128);
        dds.write('DDS ', 0, 'ascii');
        dds.writeUInt32LE(16, 12);
        dds.writeUInt32LE(64, 16);
        fs.writeFileSync(texturePath, dds);
        const symbols: Record<string, any[]> = {
            samplemod_btn: [{
                name: 'samplemod_btn', kind: 'effectButtonType', source: 'gui', origin: 'workspace',
                file: path.join(workspaceRoot, 'interface', 'samplemod.gui'), line: 3,
                guiFacts: {
                    offCanvas: false,
                    localisationKeys: ['SAMPLEMOD_BUTTON_TT'],
                    customGuiReferences: [],
                    effectReferences: ['samplemod_button_effect'],
                    spriteReferences: ['GFX_samplemod_button'],
                },
            }],
            samplemod_button_effect: [{
                name: 'samplemod_button_effect', kind: 'button_effect', source: 'script', origin: 'workspace',
                file: path.join(workspaceRoot, 'common', 'button_effects', 'samplemod.txt'), line: 1,
                scriptFacts: {
                    stateAccesses: [{ operation: 'set', subject: 'samplemod_ready', scope: 'country', line: 2 }],
                    localisationKeys: [], eventReferences: [], callCandidates: [],
                },
            }],
            gfx_samplemod_button: [{
                name: 'GFX_samplemod_button', kind: 'sprite', source: 'asset', origin: 'workspace',
                file: path.join(workspaceRoot, 'interface', 'samplemod.gfx'), line: 2,
                references: [
                    { file: 'interface/samplemod.gfx', line: 3, context: 'texturefile = "gfx/interface/samplemod_button.dds"' },
                    { file: 'interface/samplemod.gfx', line: 4, context: 'noOfFrames = 4' },
                ],
            }],
        };
        const fakeIndexService = {
            status: 'ready', workspaceSymbolStatus: 'ready', workspaceSymbolCount: 3, workspaceSymbolUpdatedAt: 1,
            ensureWorkspaceSymbolsReady: async () => undefined,
            assetSearchRoots: () => [workspaceRoot],
            queryLocalisation: (query: any) => query.key === 'SAMPLEMOD_BUTTON_TT'
                ? [{ key: query.key, file: path.join(workspaceRoot, 'localisation', 'english', 'samplemod.yml'), line: 2 }]
                : [],
            queryWorkspaceSymbols: (query: any) => symbols[String(query.name ?? '').toLowerCase()] ?? [],
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);
        const result = await executor.execute('query_workspace_index', {
            name: 'samplemod_btn', exact: true, source: 'gui', includeAssetChain: true,
        }) as any;
        const refs = result.assetChain[0].references;
        expect(refs.some((ref: any) => ref.target === 'samplemod_button_effect' && ref.exists)).to.equal(true);
        expect(refs.some((ref: any) => ref.target === 'GFX_samplemod_button' && ref.exists)).to.equal(true);
        expect(refs.some((ref: any) => ref.target.endsWith('samplemod_button.dds') && ref.exists && ref.depth === 2)).to.equal(true);
        const texture = refs.find((ref: any) => ref.target.endsWith('samplemod_button.dds'));
        expect(texture.pathCaseMatches).to.equal(true);
        expect(texture.frameLayout).to.deep.include({ noOfFrames: 4, width: 64, height: 16, status: 'consistent' });
        expect(result.interfaceGraph.edges.some((edge: any) => edge.kind === 'gui_effect')).to.equal(true);
        expect(result.interfaceGraph.edges.some((edge: any) => edge.kind === 'gui_sprite')).to.equal(true);
        expect(result.interfaceGraph.edges.some((edge: any) => edge.kind === 'gui_localisation')).to.equal(true);
        expect(result.interfaceGraph.edges.some((edge: any) => edge.kind === 'state_access' && edge.operation === 'set')).to.equal(true);
    });

    it('returns partial workspace index results after a bounded wait while vanilla indexing continues', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const fakeIndexService = {
                status: 'ready',
                workspaceSymbolStatus: 'indexing',
                ensureWorkspaceSymbolsReady: () => new Promise<void>(() => undefined),
                queryWorkspaceSymbols: () => [{
                    name: 'crisis.100',
                    kind: 'event',
                    category: 'event',
                    file: path.join('events', 'crisis.txt'),
                    line: 3,
                    source: 'script',
                    origin: 'workspace',
                }],
                workspaceSymbolCount: 1,
                workspaceSymbolUpdatedAt: 2000,
            };
            const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);
            const pending = executor.execute('query_workspace_index', {
                name: 'crisis',
                prefix: true,
                limit: 20,
            }) as Promise<any>;

            await clock.tickAsync(8_000);
            const result = await pending;

            expect(result.status).to.equal('indexing');
            expect(result.entries[0].name).to.equal('crisis.100');
            expect(result._hint).to.include('Partial indexed results');
        } finally {
            clock.restore();
        }
    });

    it('returns unavailable workspace index result without IndexService', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_workspace_index', { name: 'samplemod.100' }) as any;

        expect(result.status).to.equal('unavailable');
        expect(result.entries).to.deep.equal([]);
    });

    it('falls back to the shared index when the VS Code workspace symbol provider fails', async () => {
        const originalExecuteCommand = vscodeStub.commands.executeCommand;
        let ensureArgs: any;
        let indexQuery: any;
        vscodeStub.commands.executeCommand = async (...args: unknown[]) => {
            const command = args[0] as string;
            if (command === 'vscode.executeWorkspaceSymbolProvider') {
                throw new Error('provider timed out');
            }
            return undefined;
        };
        try {
            const fakeIndexService = {
                status: 'ready',
                workspaceSymbolStatus: 'ready',
                ensureWorkspaceSymbolsReady: async (args: any) => {
                    ensureArgs = args;
                },
                queryWorkspaceSymbols: (query: any) => {
                    indexQuery = query;
                    return [{
                        name: 'mammalian_01_habitat_phase_03_entity',
                        kind: 'model_entity',
                        category: 'asset',
                        file: path.join(workspaceRoot, 'gfx', 'models', 'ships', 'habitat.asset'),
                        line: 12,
                        source: 'asset',
                    }];
                },
            };
            const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

            const result = await executor.execute('workspace_symbols', {
                query: 'habitat_phase_03_entity',
                limit: 5,
            }) as any;

            expect(ensureArgs).to.deep.equal({ includeVanilla: true });
            expect(indexQuery).to.deep.equal({ name: 'habitat_phase_03_entity', limit: 5 });
            expect(result.symbols).to.deep.equal([{
                name: 'mammalian_01_habitat_phase_03_entity',
                kind: 'model_entity',
                file: 'gfx/models/ships/habitat.asset',
                line: 11,
            }]);
            expect(result._warning).to.include('provider timed out');
            expect(result._hint).to.include('prefixed or suffixed');
        } finally {
            vscodeStub.commands.executeCommand = originalExecuteCommand;
        }
    });

    it('counts get_diagnostics totals across the full filtered set while excluding ignored diagnostics', async () => {
        const fileA = path.join(workspaceRoot, 'events', 'a.txt');
        const fileB = path.join(workspaceRoot, 'events', 'b.txt');
        fs.mkdirSync(path.dirname(fileA), { recursive: true });
        fs.writeFileSync(fileA, 'country_event = {}', 'utf8');
        fs.writeFileSync(fileB, 'country_event = {}', 'utf8');

        ignoredDiagnostics = ['IGNORED_KEY'];
        diagnosticPairs = [
            [{ fsPath: fileA }, [
                {
                    severity: vscodeStub.DiagnosticSeverity.Error,
                    message: 'First visible error',
                    range: { start: { line: 1, character: 2 } },
                    code: 'CW001',
                },
                {
                    severity: vscodeStub.DiagnosticSeverity.Warning,
                    message: 'Suppressed IGNORED_KEY warning',
                    range: { start: { line: 2, character: 0 } },
                    code: 'CW002',
                },
            ]],
            [{ fsPath: fileB }, [
                {
                    severity: vscodeStub.DiagnosticSeverity.Error,
                    message: 'Second visible error',
                    range: { start: { line: 3, character: 4 } },
                    code: 'CW003',
                },
            ]],
        ];

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('get_diagnostics', { limit: 1 }) as any;

        expect(result.summary).to.deep.include({ errors: 2, warnings: 0 });
        expect(result.totalDiagnosticCount).to.equal(2);
        expect(result.totalFiles).to.equal(2);
        expect(result.truncated).to.equal(true);
        expect(result.diagnostics).to.have.lengthOf(1);
        expect(result.ignoredDiagnosticCount).to.equal(1);
        expect(result.ignoredDiagnosticKeys).to.deep.equal(['IGNORED_KEY']);
    });

    it('queries the /init project profile without scanning the workspace', async () => {
        const profileDir = path.join(workspaceRoot, '.cwtools', 'project');
        fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-05-24T00:00:00.000Z',
            workspaceRoot,
            workspaceKind: 'paradox_mod',
            projectName: 'SampleMod',
            game: { id: 'stellaris', displayName: 'Stellaris', confidence: 'high', evidence: ['test'] },
            keyDirectories: [{ key: 'events', path: 'events', exists: true, fileCount: 1 }],
            localisation: { roots: ['localisation'], languages: ['l_english'], encoding: 'UTF-8 with BOM', sampleFiles: [] },
            identifiers: {
                namespaces: ['samplemod'],
                variablePrefixes: ['@samplemod_'],
                scriptedTriggers: [],
                scriptedEffects: [],
                events: ['samplemod.1'],
                onActions: [],
                staticModifiers: [],
            },
            routing: {
                recommendedWorkflowByIntent: [],
                preferredReadTools: ['query_project_profile'],
                avoidPatterns: [],
            },
            validation: { lspReady: 'unknown', indexStatus: 'unknown', vanillaCache: 'unknown' },
            promptCards: { build: 'Build card' },
            efficiencyHints: ['Use profile first'],
        }), 'utf8');

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_project_profile', { section: 'summary', mode: 'build' }) as any;

        expect(result.status).to.equal('ready');
        expect(result.summary).to.include('Project: SampleMod');
        expect(result.promptCard).to.equal('Build card');
        expect(result.data.workspaceKind).to.equal('paradox_mod');
    });

    it('excludes agent transcripts and backup artifacts from project reference searches', () => {
        const { isExcludedModSearchPath } = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        expect(isExcludedModSearchPath(workspaceRoot, path.join(workspaceRoot, '.cwtools', 'topic', 'resume_transcript.json.bak'))).to.equal(true);
        expect(isExcludedModSearchPath(workspaceRoot, path.join(workspaceRoot, 'events', 'legacy.txt.bak'))).to.equal(true);
        expect(isExcludedModSearchPath(workspaceRoot, path.join(workspaceRoot, 'release', 'events', 'packed.txt'))).to.equal(true);
        expect(isExcludedModSearchPath(workspaceRoot, path.join(workspaceRoot, 'events', 'live.txt'))).to.equal(false);
    });

    it('parses project .gfx spriteType candidates and ranks event pictures', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const interfaceDir = path.join(workspaceRoot, 'interface');
        fs.mkdirSync(interfaceDir, { recursive: true });
        fs.writeFileSync(path.join(interfaceDir, 'samplemod_eventpictures.gfx'), [
            'spriteTypes = {',
            '    spriteType = {',
            '        name = "GFX_evt_samplemod_force_echo"',
            '        texturefile = "gfx/event_pictures/samplemod_force_echo.dds"',
            '    }',
            '    spriteType = {',
            '        name = "GFX_samplemod_button_icon"',
            '        texturefile = "gfx/interface/icons/samplemod_button.dds"',
            '    }',
            '}',
        ].join('\n'), 'utf8');

        const handler = new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            fileTools.findFiles,
        );
        const result = await handler.findSpriteCandidates({
            currentValue: 'GFX_evt_samplemod_missing_echo',
            query: 'samplemod force echo',
            fieldName: 'picture',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates.map(c => c.name)).to.include('GFX_evt_samplemod_force_echo');
        expect(result.candidates[0]!.name).to.equal('GFX_evt_samplemod_force_echo');
        expect(result.candidates[0]!.textureFile).to.include('event_pictures');
    });

    it('uses IndexService sprite candidates before falling back to file scans', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const handler = new lspTools.LspToolHandler(
            {
                workspaceRoot,
                indexService: {
                    queryWorkspaceSymbols: () => [{
                        name: 'GFX_evt_indexed_force_echo',
                        kind: 'sprite',
                        category: 'asset',
                        source: 'asset',
                        file: path.join(workspaceRoot, 'interface', 'indexed.gfx'),
                        line: 4,
                        container: 'spriteType',
                        references: [{ file: 'indexed.gfx', line: 5, context: 'texturefile = "gfx/event_pictures/indexed_force_echo.dds"' }],
                    }],
                },
            } as any,
            () => ({}) as any,
            () => [],
        );
        const result = await handler.findSpriteCandidates({
            query: 'indexed force echo',
            fieldName: 'picture',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates[0]!.name).to.equal('GFX_evt_indexed_force_echo');
        expect(result.candidates[0]!.matchedBy).to.include('workspace-index');
        expect(result.searchedRoots).to.include('IndexService:workspaceSymbolIndex');
    });

    it('invalidates query-only semantic graph cache entries after any project file mutation', () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const handler = new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            () => [],
        );
        const cache = (handler as any).lspReadCache as Map<string, unknown>;
        cache.set('semanticGraph:["event chain","",""]', { data: { graphVersion: 1 }, expiresAt: Date.now() + 3000 });
        cache.set('unrelated-cache-entry', { data: { value: true }, expiresAt: Date.now() + 3000 });

        handler.invalidateCacheForFile(path.join(workspaceRoot, 'events', 'changed.txt'));

        expect(cache.has('semanticGraph:["event chain","",""]')).to.equal(false);
        expect(cache.has('unrelated-cache-entry')).to.equal(true);
    });

    it('parses project .asset sound candidates for show_sound repairs', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const soundDir = path.join(workspaceRoot, 'sound');
        fs.mkdirSync(soundDir, { recursive: true });
        fs.writeFileSync(path.join(soundDir, 'samplemod_sounds.asset'), [
            'sounds = {',
            '    sound = {',
            '        name = "samplemod_force_echo_reveal"',
            '        file = "sound/event/samplemod_force_echo_reveal.wav"',
            '    }',
            '    music = {',
            '        name = "samplemod_force_theme"',
            '        file = "music/samplemod_force_theme.ogg"',
            '    }',
            '}',
        ].join('\n'), 'utf8');

        const handler = new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            fileTools.findFiles,
        );
        const result = await handler.findSoundCandidates({
            currentValue: 'samplemod_force_echo_missing',
            query: 'samplemod force echo reveal',
            fieldName: 'show_sound',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates.map(c => c.name)).to.include('samplemod_force_echo_reveal');
        expect(result.candidates[0]!.name).to.equal('samplemod_force_echo_reveal');
        expect(result.candidates[0]!.fileRef).to.include('.wav');
    });
});

describe('agent tool topic artifacts', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        externalTools.useDirectSandboxRunnerForTests(true);
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        externalTools.useDirectSandboxRunnerForTests(false);
        stubConfigOverrides = {};
        PermissionPolicyStore.getInstance().clear();
        cleanupWorkspace(workspaceRoot);
    });

    it('creates media output directories inside the current topic folder', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const dir = await (handler as any).getMediaOutputDir(makeContext('media-topic'));

        expect(dir).to.equal(path.join(workspaceRoot, '.cwtools', 'media-topic', 'media'));
        expect(fs.existsSync(dir)).to.equal(true);
    });

    it('scopes process inspection and control to the owning task thread', () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const terminate = sinon.spy();
        const record = processRegistry.register('long task', workspaceRoot, 123, undefined, undefined, {
            threadId: 'thread-owner',
            terminate,
        });
        const foreignContext = { runnerOptions: { threadId: 'thread-other' } } as any;
        const ownerContext = { runnerOptions: { threadId: 'thread-owner' } } as any;

        expect(handler.listProcesses({}, foreignContext).processes.some(item => item.processId === record.processId)).to.equal(false);
        expect(handler.readProcess({ processId: record.processId }, foreignContext).success).to.equal(false);
        expect(handler.terminateProcess({ processId: record.processId }, foreignContext).success).to.equal(false);
        expect(handler.terminateProcess({ processId: record.processId }, ownerContext).success).to.equal(true);
        expect(terminate.calledOnce).to.equal(true);
    });

    it('starts and controls a captured command in the background', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const context = makeContext('background-process');
        const result = await handler.runCommand({
            command: `node -e "process.stdin.setEncoding('utf8'); process.stdin.once('data', function(d) { console.log(d.trim()); process.exit(0); }); setTimeout(function() { process.exit(2); }, 5000)"`,
            background: true,
            timeoutMs: 10_000,
            requestEscalation: true,
        }, {
            ...context,
            onPermissionRequest: async () => true,
        } as any);

        expect(result.status).to.equal('started');
        expect(result.processId).to.be.a('string');
        expect(handler.writeProcessStdin({ processId: result.processId!, text: 'hello background' }, context).success).to.equal(true);
        // Windows sandbox/process brokers can take more than one second to attach
        // stdio even after the background start record has been published.
        for (let attempt = 0; attempt < 200; attempt++) {
            if (handler.readProcess({ processId: result.processId! }, context).process?.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const record = handler.readProcess({ processId: result.processId! }, context).process;
        expect(record?.status).to.equal('completed');
        expect(record?.outputPreview).to.include('hello background');
    });

    it('marks network host scopes as declared-only in approval metadata', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        let preflight: any;
        const result = await handler.runCommand({
            command: 'node --version',
            networkAccess: true,
            networkHosts: ['example.com'],
        }, {
            ...makeContext('network-scope'),
            onPermissionRequest: async (_id: string, _tool: string, _description: string, _command: string, context: any) => {
                preflight = context.preflight;
                return true;
            },
        } as any);

        expect(result.exitCode).to.equal(0);
        expect(preflight.networkHosts).to.deep.equal(['example.com']);
        expect(preflight.networkEnforcement).to.equal('declared-only');
    });

    it('requires approval for opaque inline code even when it runs inside the sandbox', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequests = 0;
        const result = await handler.runCommand({
            command: 'node -e "require(\'fs\').writeFileSync(\'sandboxed.txt\', \'ok\')"',
            timeoutMs: 10_000,
        }, {
            ...makeContext('sandboxed-command'),
            onPermissionRequest: async () => {
                permissionRequests++;
                return true;
            },
        } as any);

        expect(result.exitCode).to.equal(0);
        expect(permissionRequests).to.equal(1);
        expect(fs.readFileSync(path.join(workspaceRoot, 'sandboxed.txt'), 'utf8')).to.equal('ok');
    });

    it('does not let learned approval rules bypass data-driven command review', async () => {
        PermissionPolicyStore.getInstance().addRule({
            tool: 'run_command', commandPrefix: ['xargs'], cwdScope: workspaceRoot, riskMax: 3, sessionOnly: true,
        });
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequests = 0;
        const result = await handler.runCommand({ command: 'xargs echo', timeoutMs: 10_000 }, {
            ...makeContext('opaque-data-command'),
            onPermissionRequest: async (_id: string, _tool: string, _description: string, _command?: string, context?: any) => {
                permissionRequests++;
                expect(context?.preflight?.opaqueExecution).to.equal(true);
                return false;
            },
        } as any);

        expect(permissionRequests).to.equal(1);
        expect(result.exitCode).to.equal(1);
    });

    it('honors a specific configured allow rule for Git metadata without broad Git approval', async () => {
        stubConfigOverrides['shell.commandRules'] = [{ prefix: ['git', 'init'], decision: 'allow' }];
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequests = 0;
        const result = await handler.runCommand({ command: 'git init', timeoutMs: 10_000 }, {
            ...makeContext('configured-git-rule'),
            onPermissionRequest: async () => {
                permissionRequests++;
                return false;
            },
        } as any);

        expect(result.exitCode).to.equal(0);
        expect(permissionRequests).to.equal(0);
        expect(fs.existsSync(path.join(workspaceRoot, '.git'))).to.equal(true);
    });

    it('does not let learned approvals bypass a configured prompt rule', async () => {
        stubConfigOverrides['shell.commandRules'] = [{ prefix: ['node', '--version'], decision: 'prompt' }];
        PermissionPolicyStore.getInstance().addRule({
            tool: 'run_command', commandPrefix: ['node', '--version'], cwdScope: workspaceRoot, riskMax: 3, sessionOnly: true,
        });
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequested = false;
        const result = await handler.runCommand({ command: 'node --version' }, {
            ...makeContext('configured-prompt-rule'),
            onPermissionRequest: async () => {
                permissionRequested = true;
                return false;
            },
        } as any);

        expect(permissionRequested).to.equal(true);
        expect(result.exitCode).to.equal(1);
    });

    it('rejects destructive commands until an explicit escalation is requested', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const result = await handler.runCommand({ command: 'rm -rf build' }, makeContext('destructive-command'));
        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include('Prohibited destructive shell operation');
    });

    it('rejects run_command working directories outside the workspace boundary', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const result = await handler.runCommand({
            command: 'echo hi',
            cwd: `${workspaceRoot}-sibling`,
        }, makeContext('media-topic'));

        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include('Working directory must be within the workspace root');
    });

    it('requires explicit unsandboxed approval before generic shell commands mutate protected control paths', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const directPath = await handler.runCommand({ command: 'mkdir .git', requestEscalation: true }, {
            ...makeContext('media-topic'),
            onPermissionRequest: async () => true,
        } as any);
        expect(directPath.exitCode).to.equal(1);
        expect(directPath.stderr).to.include('protected Git/agent control paths');
    });

    it('grants approved Git commands only a visible one-shot .git metadata override', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        let preflight: any;
        const result = await handler.runCommand({ command: 'git init', timeoutMs: 10_000 }, {
            ...makeContext('media-topic'),
            onPermissionRequest: async (_id: string, _tool: string, _description: string, _command: string, context: any) => {
                preflight = context.preflight;
                return true;
            },
        } as any);
        expect(result.exitCode).to.equal(0);
        expect(preflight.protectedPathOverrides).to.deep.equal(['.git']);
        expect(preflight.unsandboxed).to.equal(false);
        expect(preflight.escalation).to.equal(true);
    });

    it('relativizes quoted workspace script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, '!!! WIP', 'tools');
        const scriptPath = path.join(scriptDir, 'TRTE_btn_gen.js');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(scriptPath, 'console.log("ran script");\n', 'utf8');

        const result = await handler.runCommand({
            command: `node "${scriptPath}"`,
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.exitCode).to.equal(0);
        expect(result.stdout).to.include('ran script');
    });

    it('maps legacy scratch paths into the current topic scratch directory for commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools', 'media-topic', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'helper.js');
        fs.writeFileSync(targetPath, 'console.log("ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node ".cwtools-ai/scratch/helper.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('ok');
    });

    it('keeps run_command stdout and stderr out of streamed UI steps', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'emit-output.js');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(scriptPath, [
            "console.log('VISIBLE_STDOUT_MARKER');",
            "console.error('VISIBLE_STDERR_MARKER');",
            "console.log(process.env.PYTHONIOENCODING || '');",
        ].join('\n'), 'utf8');
        const steps: any[] = [];

        const result = await handler.runCommand({
            command: 'node "tools/emit-output.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onStep: (step: any) => steps.push(step),
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('VISIBLE_STDOUT_MARKER');
        expect(result.stdout).to.include('utf-8');
        expect(result.stderr).to.include('VISIBLE_STDERR_MARKER');
        const streamed = steps.map(step => String(step.content ?? '')).join('\n');
        expect(streamed).to.not.include('VISIBLE_STDOUT_MARKER');
        expect(streamed).to.not.include('VISIBLE_STDERR_MARKER');
    });

    it('normalizes backslash-escaped quoted scratch script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools', 'media-topic', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'agent_helper.js');
        fs.writeFileSync(targetPath, 'console.log("escaped ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node \\".cwtools-ai/scratch/agent_helper.js\\"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('escaped ok');
    });

    it('normalizes one-sided escaped quoted topic scratch script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.js');
        fs.writeFileSync(targetPath, 'console.log("topic escaped ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('topic escaped ok');
    });

    if (process.platform === 'win32') it('normalizes one-sided escaped quoted topic scratch paths for PowerShell commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.txt');
        fs.writeFileSync(targetPath, 'powershell path ok\n', 'utf8');

        const result = await handler.runCommand({
            command: 'Get-Content \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.txt"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('powershell path ok');
    });

    if (process.platform === 'win32') it('uses PowerShell for normal Windows commands instead of cmd quoting', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.txt');
        fs.writeFileSync(targetPath, 'normal powershell path ok\n', 'utf8');

        const result = await handler.runCommand({
            command: 'Get-Content \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.txt"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('normal powershell path ok');
    });

    it('classifies PowerShell read-only commands as safe auto-run commands', () => {
        const handler = new ExternalToolHandler({ workspaceRoot }) as any;

        expect(handler.isReadOnlyRunCommand('Select-String -Path "common/buildings/*.txt" -Pattern "planet"')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Get-ChildItem -Path "common" -Recurse -Filter *.txt | Select-String -Pattern "trigger"')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Get-Content "common/test.txt" | Select-Object -First 20')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Select-String -Path "common/*.txt" -Pattern "planet" | Set-Content out.txt')).to.equal(false);
    });

    it('declares platform-specific run_command shells in the model-visible schema', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'run_command')!;
        const shell = (tool.function.parameters as any).properties.shell;

        expect(shell.enum).to.deep.equal(['auto', 'sh', 'bash', 'pwsh', 'powershell']);
        expect(shell.description).to.include('sh/bash are valid on macOS/Linux only');
        expect(shell.description).to.include('pwsh/powershell are valid on Windows only');
    });

    it('rejects explicit run_command shells that do not match the host platform', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const shell = process.platform === 'win32' ? 'bash' : 'pwsh';
        let permissionRequested = false;

        const result = await handler.runCommand({
            command: 'echo ok',
            shell: shell as any,
            timeoutMs: 1000,
        }, {
            onPermissionRequest: async () => {
                permissionRequested = true;
                return true;
            },
        } as any);

        expect(permissionRequested).to.equal(false);
        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include('Blocked:');
        expect(result.stderr).to.include(process.platform === 'win32' ? 'macOS/Linux' : 'Windows');
    });

    it('does not request permission for read-only run_command invocations', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequested = false;

        const result = await handler.runCommand({
            command: 'ls .',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => {
                permissionRequested = true;
                return false;
            },
        } as any);

        expect(permissionRequested).to.equal(false);
        expect(result.stderr).to.not.include('no permission handler configured');
    });

    it('does not let a low-risk permission rule bypass higher-risk complex-shell preflight', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const policy = PermissionPolicyStore.getInstance();
        policy.clear();
        policy.addRule({
            tool: 'run_command',
            commandPrefix: ['node'],
            cwdScope: workspaceRoot,
            riskMax: 1,
            sessionOnly: true,
        });

        let permissionRequested = false;
        const result = await handler.runCommand({
            command: 'node -e "console.log($(pwd))"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => {
                permissionRequested = true;
                return false;
            },
        } as any);

        expect(permissionRequested).to.equal(true);
        expect(result.exitCode).to.equal(1);
        policy.clear();
    });

    it('records project file changes made by a command for the diff panel', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'change-file.js');
        const targetPath = path.join(workspaceRoot, 'config.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(targetPath, 'before\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('config.txt', 'after\\n', 'utf8');",
            "console.log('changed');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/change-file.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(fs.readFileSync(targetPath, 'utf8')).to.equal('after\n');
        expect(snapshots).to.deep.include({ filePath: targetPath, previousContent: 'before\n' });
        expect(result.changedFiles).to.deep.include(targetPath);
        expect(result.writtenFiles).to.deep.include(targetPath);
    });

    it('returns command-written files even when no diff snapshot callback is configured', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'change-file-no-callback.js');
        const targetPath = path.join(workspaceRoot, 'events', 'scripted_change.txt');
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(targetPath, 'before\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('events/scripted_change.txt', 'after\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const result = await handler.runCommand({
            command: 'node "tools/change-file-no-callback.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.changedFiles).to.deep.include(targetPath);
        expect(result.writtenFiles).to.deep.include(targetPath);
        expect(result.recordedSnapshots).to.equal(0);
    });

    it('omits temporary helper scripts from command-recorded workspace changes', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'create-temp-and-change.js');
        const targetPath = path.join(workspaceRoot, 'config.txt');
        const helperPath = path.join(workspaceRoot, 'agent_helper.py');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(targetPath, 'before\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('config.txt', 'after\\n', 'utf8');",
            "fs.writeFileSync('agent_helper.py', 'print(\"temporary\")\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/create-temp-and-change.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(fs.existsSync(helperPath)).to.equal(true);
        expect(snapshots).to.deep.include({ filePath: targetPath, previousContent: 'before\n' });
        expect(snapshots.some(snapshot => snapshot.filePath === helperPath)).to.equal(false);
        expect(result.changedFiles).to.deep.include(targetPath);
        expect(result.changedFiles ?? []).to.not.include(helperPath);
    });

    it('still records edits to existing project scripts with helper-like names', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'modify-existing-helper.js');
        const helperPath = path.join(workspaceRoot, 'helper.py');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(helperPath, 'print("before")\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('helper.py', 'print(\"after\")\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/modify-existing-helper.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(snapshots).to.deep.include({ filePath: helperPath, previousContent: 'print("before")\n' });
    });

    it('records previous-content snapshots for .shader and .fxh files changed by commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'modify-shaders.js');
        const shaderPath = path.join(workspaceRoot, 'gfx', 'FX', 'test.shader');
        const fxhPath = path.join(workspaceRoot, 'gfx', 'FX', 'test.fxh');
        fs.mkdirSync(path.dirname(shaderPath), { recursive: true });
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(shaderPath, 'shader before\n', 'utf8');
        fs.writeFileSync(fxhPath, '#include "before"\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('gfx/FX/test.shader', 'shader after\\n', 'utf8');",
            "fs.writeFileSync('gfx/FX/test.fxh', '#include \"after\"\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/modify-shaders.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'shader-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(snapshots).to.deep.include({ filePath: shaderPath, previousContent: 'shader before\n' });
        expect(snapshots).to.deep.include({ filePath: fxhPath, previousContent: '#include "before"\n' });
        expect(result.recordedSnapshots).to.be.at.least(2);
    });

    it('returns deployed asset paths as written files for downstream refresh', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const sourcePath = path.join(workspaceRoot, '.cwtools', 'media-topic', 'media', 'generated.asset');
        const targetRelativePath = 'interface/generated.asset';
        const targetPath = path.join(workspaceRoot, targetRelativePath);
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'sound = { name = test }\n', 'utf8');

        const result = await handler.deployModAsset({
            sourcePath,
            targetRelativePath,
            overwrite: true,
        }, makeContext('media-topic'));

        expect(result.success).to.equal(true);
        expect(result.finalPath).to.equal(targetPath);
        expect(result.writtenFiles).to.deep.equal([targetPath]);
    });

    it('rejects media deployment targets outside the workspace boundary', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const sourcePath = path.join(workspaceRoot, '.cwtools', 'media-topic', 'media', 'source.png');
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'fake image', 'utf8');

        const result = await handler.deployModAsset({
            sourcePath,
            targetRelativePath: '../outside.dds',
            overwrite: true,
        }, makeContext('media-topic'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('Target path must be within the workspace');
    });
});

describe('agent tool progress and aborts', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        permissionsConfig = undefined;
        stubConfigOverrides = {};
        cleanupWorkspace(workspaceRoot);
    });

    function createExecutor() {
        const client = {
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any;
        return new AgentToolExecutor(client, workspaceRoot);
    }

    it('requests CWTools revalidation for files reported by tool results', async () => {
        const changedFile = path.join(workspaceRoot, 'events', 'scripted_change.txt');
        fs.mkdirSync(path.dirname(changedFile), { recursive: true });
        fs.writeFileSync(changedFile, 'namespace = test\n', 'utf8');

        const sendRequest = sinon.stub().resolves({ ok: true, requested: 1 });
        const client = {
            onNotification: () => undefined,
            sendNotification: () => undefined,
            sendRequest,
        } as any;
        const executor = new AgentToolExecutor(client, workspaceRoot);
        sinon.stub(executor as any, 'executeInternal').resolves({
            stdout: '',
            stderr: '',
            exitCode: 0,
            writtenFiles: [changedFile],
        });
        const invalidate = sinon.spy();

        const permission = sinon.stub().resolves(true);
        const result = await executor.execute('git_ops', { action: 'checkout', file: 'events/scripted_change.txt' }, {
            runnerOptions: { mode: 'build' },
            agentRunner: { readTracker: { invalidate } },
            onPermissionRequest: permission,
        } as any) as any;

        expect(permission.calledOnce).to.equal(true);
        expect(invalidate.calledWith(changedFile)).to.equal(true);
        expect(sendRequest.calledOnce).to.equal(true);
        expect(sendRequest.firstCall.args[0]).to.equal('workspace/executeCommand');
        expect(sendRequest.firstCall.args[1].command).to.equal('cwtools.ai.revalidateFiles');
        expect(result.revalidation.ok).to.equal(true);
    });

    it('revalidates indirect inline callers discovered by post-write evidence', async () => {
        const changedFile = path.join(workspaceRoot, 'common', 'inline_scripts', 'template.txt');
        const callerFile = path.join(workspaceRoot, 'events', 'caller.txt');
        fs.mkdirSync(path.dirname(changedFile), { recursive: true });
        fs.mkdirSync(path.dirname(callerFile), { recursive: true });
        fs.writeFileSync(changedFile, 'root = {}\n', 'utf8');
        fs.writeFileSync(callerFile, 'country_event = {}\n', 'utf8');
        const sendRequest = sinon.stub().resolves({ ok: true, requested: 2 });
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
            sendRequest,
        } as any, workspaceRoot);
        sinon.stub(executor as any, 'executeInternal').resolves({ writtenFiles: [changedFile], exitCode: 0 });
        (executor as any).postWriteAffectedFiles.set('topic:default', [callerFile]);

        const result = await executor.execute('git_ops', { action: 'checkout', file: 'common/inline_scripts/template.txt' }, {
            runnerOptions: { mode: 'build' },
            agentRunner: { readTracker: { invalidate: () => undefined } },
            onPermissionRequest: sinon.stub().resolves(true),
        } as any) as any;

        const requestedUris = sendRequest.firstCall.args[1].arguments[0] as string[];
        expect(requestedUris).to.have.lengthOf(2);
        expect(result.indirectRevalidationFiles).to.deep.equal([callerFile]);
    });

    it('requests CWTools revalidation for .shader and .fxh files reported by tools', async () => {
        const shaderFile = path.join(workspaceRoot, 'gfx', 'FX', 'test.shader');
        const fxhFile = path.join(workspaceRoot, 'gfx', 'FX', 'test.fxh');
        fs.mkdirSync(path.dirname(shaderFile), { recursive: true });
        fs.writeFileSync(shaderFile, 'shader body\n', 'utf8');
        fs.writeFileSync(fxhFile, '#include "x"\n', 'utf8');

        const sendRequest = sinon.stub().resolves({ ok: true, requested: 2 });
        const client = {
            onNotification: () => undefined,
            sendNotification: () => undefined,
            sendRequest,
        } as any;
        const executor = new AgentToolExecutor(client, workspaceRoot);
        sinon.stub(executor as any, 'executeInternal').resolves({
            stdout: '',
            stderr: '',
            exitCode: 0,
            writtenFiles: [shaderFile, fxhFile],
        });
        const invalidate = sinon.spy();

        const permission = sinon.stub().resolves(true);
        const result = await executor.execute('git_ops', { action: 'checkout', file: 'gfx/FX/test.shader' }, {
            runnerOptions: { mode: 'build' },
            agentRunner: { readTracker: { invalidate } },
            onPermissionRequest: permission,
        } as any) as any;

        expect(sendRequest.calledOnce).to.equal(true);
        expect(sendRequest.firstCall.args[0]).to.equal('workspace/executeCommand');
        expect(sendRequest.firstCall.args[1].command).to.equal('cwtools.ai.revalidateFiles');
        const requestedTargets = sendRequest.firstCall.args[1].arguments[0] as string[];
        expect(requestedTargets).to.have.length(2);
        expect(requestedTargets).to.deep.include(vscodeStub.Uri.file(shaderFile).toString());
        expect(requestedTargets).to.deep.include(vscodeStub.Uri.file(fxhFile).toString());
        expect(result.revalidation.ok).to.equal(true);
    });

    it('keeps read-only git_ops status behind the registry but outside approval prompts', async () => {
        const executor = createExecutor();
        sinon.stub(executor as any, 'executeInternal').resolves({ success: true, output: '' });
        const permission = sinon.stub().resolves(true);
        const result = await executor.execute('git_ops', { action: 'status' }, {
            runnerOptions: { mode: 'build' },
            onPermissionRequest: permission,
        } as any) as any;
        expect(result.success).to.equal(true);
        expect(permission.called).to.equal(false);
    });

    it('rejects writer sub-agents when Plan mode fans out repository exploration', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            tasks: [{ id: 'writer', agentType: 'build', prompt: 'Modify a project file.' }],
        }, {
            runnerOptions: { mode: 'plan', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Agent type 'build' is not allowed in Plan mode");
        expect(result.error).to.include('explore, plan, review');
    });

    it('rejects writer sub-agents when Explore mode fans out evidence collection', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            tasks: [{ id: 'writer', agentType: 'utility', prompt: 'Modify a project file.' }],
        }, {
            runnerOptions: { mode: 'explore', domain: 'general' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Agent type 'utility' is not allowed in Explore mode");
        expect(result.error).to.include('explore, plan, review');
    });

    it('rejects planned write targets in Explore-mode fan-out', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            tasks: [{
                id: 'reader',
                agentType: 'explore',
                prompt: 'Inspect the target file.',
                plannedFiles: ['client/extension/ai/chatPanel.ts'],
            }],
        }, {
            runnerOptions: { mode: 'explore', domain: 'general' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('Explore mode fan-out is read-only');
        expect(result.error).to.include('must not declare plannedFiles');
    });

    it('rejects executable blueprints in Explore-mode fan-out', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            blueprintFile: '.cwtools/topic/design_blueprint.json',
        }, {
            runnerOptions: { mode: 'explore', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('Explore mode fan-out is read-only');
        expect(result.error).to.include('at most four bounded evidence tasks');
    });

    it('emits heartbeat progress while a tool is still running and stops after abort', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const executor = createExecutor();
            sinon.stub(executor as any, 'executeInternal').returns(new Promise(() => undefined));
            const abortController = new AbortController();
            const steps: any[] = [];
            const promise = executor.execute('dispatch_agents', {}, {
                runnerOptions: { abortSignal: abortController.signal },
                onStep: (step: any) => steps.push(step),
            } as any);

            await clock.tickAsync(15_001);
            const progress = steps.filter(step => step.type === 'orchestrator_progress');
            expect(progress.length).to.be.greaterThan(0);
            expect(String(progress[0].content)).to.include('dispatch_agents');

            let settled = false;
            void promise.then(
                () => { settled = true; },
                () => { settled = true; },
            );
            await clock.tickAsync(61 * 60_000);
            expect(settled).to.equal(false);

            const stepCountBeforeAbort = steps.length;
            abortController.abort(new Error('test abort'));
            const error = await promise.then(() => undefined, e => e);
            expect(error).to.be.instanceOf(Error);
            await clock.tickAsync(30_000);
            expect(steps.length).to.equal(stepCountBeforeAbort);
        } finally {
            clock.restore();
        }
    });

    it('allows semantic write tools to run past the short default timeout', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const executor = createExecutor();
            sinon.stub(executor as any, 'executeInternal').callsFake(async () => {
                await new Promise(resolve => setTimeout(resolve, 31_000));
                return { success: true, message: 'write finished' };
            });

            const resultPromise = executor.execute('write_file', {
                file: 'common/scripted_effects/slow_write.txt',
                content: 'effect = { }\n',
                _autoApply: true,
            }, {
                runnerOptions: { mode: 'build', domain: 'paradox' },
            } as any);

            await clock.tickAsync(31_000);
            const result = await resultPromise as any;
            expect(result).to.deep.equal({ success: true, message: 'write finished' });
        } finally {
            clock.restore();
        }
    });

    it('does not hang a write when diagnostics LSP requests stop responding', async function () {
        this.timeout(5000);
        const clock = sinon.useFakeTimers();
        try {
            const target = path.join(workspaceRoot, 'notes', 'slow-diagnostics.md');
            const client = {
                onNotification: () => undefined,
                sendNotification: () => undefined,
                sendRequest: sinon.stub().returns(new Promise(() => undefined)),
            } as any;
            const executor = new AgentToolExecutor(client, workspaceRoot);

            const resultPromise = executor.execute('write_file', {
                file: target,
                content: 'hello\n',
                _autoApply: true,
            }, {
                runnerOptions: { mode: 'build', domain: 'paradox' },
            } as any);

            await clock.tickAsync(5_000);
            const result = await resultPromise as any;
            expect(result.success).to.equal(true);
            expect(result.freshness).to.equal('pending');
            expect(client.sendRequest.callCount).to.be.greaterThan(1);
        } finally {
            clock.restore();
        }
    });

    it('aborts the derived tool signal when a tool timeout fires', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const executor = createExecutor();
            let innerSignal: AbortSignal | undefined;
            sinon.stub(executor as any, 'executeInternal').callsFake((...callArgs: unknown[]) => {
                const context = callArgs[2] as any;
                innerSignal = context.runnerOptions.abortSignal;
                return new Promise(() => undefined);
            });

            const resultPromise = executor.execute('todo_write', {}, {
                runnerOptions: {},
                onStep: () => undefined,
            } as any);

            await clock.tickAsync(5_001);
            const result = await resultPromise as any;
            expect(innerSignal?.aborted).to.equal(true);
            expect((innerSignal?.reason as Error).name).to.equal('TimeoutError');
            expect(String(result.error)).to.include('todo_write');
        } finally {
            clock.restore();
        }
    });

    it('routes dynamic MCP tool names through mcp_call mode validation', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true, routed: true });

        const blocked = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'loc_writer', domain: 'paradox' },
        } as any) as any;
        expect(blocked.success).to.equal(false);
        expect(blocked.error).to.include("not allowed in current mode 'loc_writer'");
        expect(blocked.error).to.include('mcp_call');
        expect(executeInternal.called).to.equal(false);

        const routed = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox' },
        } as any) as any;
        expect(routed).to.deep.include({ success: true, routed: true });
        expect(executeInternal.calledOnce).to.equal(true);
        expect(executeInternal.firstCall.args[0]).to.equal('mcp_filesystem_read_file');
    });

    it('denies MCP tools to orchestrator sub-agents by default at the execution chokepoint', async () => {
        const executor = createExecutor();
        const result = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox', useSlimPrompt: true },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('denied for orchestrator sub-agents');
        expect(result.error).to.include('stellarisLanguageServices.ai.permissions');
    });

    it('lets an explicit allow pattern grant sub-agent MCP access', async () => {
        permissionsConfig = { mcp: { 'filesystem_read_*': 'allow' } };
        const executor = createExecutor();
        const result = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox', useSlimPrompt: true },
        } as any) as any;

        // Permission gate passed; failure comes from the unconfigured server, not the sandbox.
        expect(result.success).to.equal(false);
        expect(result.error).to.not.include('denied for orchestrator sub-agents');
        expect(result.error).to.include('not found in configuration');
    });

    it('applies the same permission patterns to generic mcp_call and fails closed on ask', async () => {
        permissionsConfig = { mcp: { 'filesystem_*': 'ask' } };
        const executor = createExecutor();
        const result = await executor.execute('mcp_call', { server: 'filesystem', tool: 'read_file' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('requires approval');
        expect(result.error).to.include("'filesystem_*'");
    });

    it('forwards top-level dynamic MCP args to the MCP call', async () => {
        stubConfigOverrides['mcp.servers'] = [{ name: 'filesystem', capabilityDomain: 'paradox' }];
        const executor = createExecutor();
        const callTool = sinon.stub().resolves({ ok: true });
        sinon.stub(executor as any, 'getMcpClient').resolves({ callTool });

        const result = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(callTool.calledOnce).to.equal(true);
        expect(callTool.firstCall.args[0]).to.equal('read_file');
        expect(callTool.firstCall.args[1]).to.deep.equal({ path: 'README.md' });
    });

    it('keeps mcp_call nested arguments intact', async () => {
        stubConfigOverrides['mcp.servers'] = [{ name: 'filesystem', capabilityDomain: 'paradox' }];
        const executor = createExecutor();
        const callTool = sinon.stub().resolves({ ok: true });

        sinon.stub(executor as any, 'getMcpClient').resolves({ callTool });

        const result = await executor.execute('mcp_call', { server: 'filesystem', tool: 'read_file', arguments: { path: 'a.txt' } }, {
            runnerOptions: { mode: 'utility', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(callTool.firstCall.args[1]).to.deep.equal({ path: 'a.txt' });
    });

    it('resolves underscore server names through the dynamic registration map', async () => {
        stubConfigOverrides = {
            'mcp.registerDynamicTools': true,
            'mcp.servers': [{ name: 'my_server', type: 'stdio', capabilityDomain: 'paradox' }],
        };
        const executor = createExecutor();
        const callTool = sinon.stub().resolves({ ok: true });
        const getMcpClient = sinon.stub(executor as any, 'getMcpClient').resolves({
            callTool,
            listTools: async () => ({ tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object', properties: {} } }] }),
        });

        const defs = await executor.getDynamicMcpToolDefinitions('utility' as any, 'paradox');
        expect(defs.map((d: any) => d.function.name)).to.include('mcp_my_server_read_file');

        const result = await executor.execute('mcp_my_server_read_file', { path: 'x' }, {
            runnerOptions: { mode: 'utility', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(getMcpClient.lastCall.args[0]).to.equal('my_server');
        expect(callTool.firstCall.args[0]).to.equal('read_file');
        expect(callTool.firstCall.args[1]).to.deep.equal({ path: 'x' });
    });

    it('keeps generic mcp_call behind normal registry mode validation', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true });

        const result = await executor.execute('mcp_call', { server: 'filesystem', tool: 'read_file' }, {
            runnerOptions: { mode: 'loc_writer', domain: 'paradox' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Tool 'mcp_call' is not allowed in current mode 'loc_writer'");
        expect(executeInternal.called).to.equal(false);
    });

    it('keeps sub-agent git and command tools out of the runtime', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true });
        const context = {
            runnerOptions: {
                mode: 'build',
                useSlimPrompt: true,
            },
        } as any;

        const gitResult = await executor.execute('git_ops', { operation: 'status' }, context) as any;
        const commandResult = await executor.execute('run_command', { command: 'git status' }, context) as any;

        expect(gitResult.success).to.equal(false);
        expect(gitResult.message).to.include('git_ops is disabled');
        expect(commandResult.success).to.equal(false);
        expect(commandResult.message).to.include('run_command is disabled');
        expect(commandResult.message).to.include('BLOCKED_FOR_ORCHESTRATOR');
        expect(executeInternal.called).to.equal(false);
    });
});

describe('trusted host-owned AI tool contracts', () => {
    it('exposes only host-owned scope evidence and archetype artifact inputs', () => {
        const bridge = TOOL_DEFINITIONS.find(definition => definition.function.name === 'find_scope_bridge')!;
        const bridgeProperties = (bridge.function.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(bridgeProperties)).to.deep.equal(['fromScope', 'toScope', 'context']);
        expect(TOOL_DEFINITIONS.some(definition => definition.function.name === 'solve_scope_bridge')).to.equal(false);
        const extract = TOOL_DEFINITIONS.find(definition => definition.function.name === 'extract_archetype_slots')!;
        expect(extract.function.parameters.required).to.deep.equal(['filePath', 'definitionIdentity', 'definitionPath', 'placeholders']);
        expect(extract.function.parameters.properties).not.to.have.property('text');
        const instantiate = TOOL_DEFINITIONS.find(definition => definition.function.name === 'instantiate_archetype')!;
        expect(instantiate.function.parameters.required).to.deep.equal(['artifactId', 'values']);
        expect(instantiate.function.parameters.properties).not.to.have.property('archetype');
    });

    it('builds scope candidates only from the host capability API', async () => {
        const workspaceRoot = makeWorkspace();
        try {
            const executor = new AgentToolExecutor({ onNotification: () => undefined } as any, workspaceRoot);
            const response = (candidates: any[]) => ({
                status: 'ready' as const, source: 'cwtools-node-rules', totalConsidered: candidates.length, warnings: [], rulesContentHash: 'abc123', candidates,
            });
            const outgoing = { score: 10, reasons: [], rule: { name: 'owner_system', scopes: ['country'], sourceFile: 'scope.cwt', sourceLine: 7, hardFacts: { supportedScopes: ['country'], pushScope: 'system' } } };
            const middle = { score: 10, reasons: [], rule: { name: 'system_planet', scopes: ['system'], sourceFile: 'scope.cwt', sourceLine: 10, hardFacts: { supportedScopes: ['system'], pushScope: 'planet' } } };
            const incoming = { score: 10, reasons: [], rule: { name: 'planet_fleet', scopes: ['planet'], sourceFile: 'scope.cwt', sourceLine: 12, hardFacts: { supportedScopes: ['planet'], pushScope: 'fleet' } } };
            const search = sinon.stub((executor as any).lspHandler, 'searchRuleCapabilities');
            search.onFirstCall().resolves(response([outgoing]));
            search.onSecondCall().resolves(response([incoming]));
            search.onThirdCall().resolves(response([middle]));
            const result = await (executor as any).executeInternal('find_scope_bridge', {
                fromScope: 'country', toScope: 'fleet', context: 'owner transition', candidates: [{ name: 'forged' }],
            });
            expect(search.callCount).to.equal(3);
            expect(search.firstCall.args[0]).to.deep.equal({ intent: 'owner transition', category: 'scope_change', currentScope: 'country', limit: 50 });
            expect(search.secondCall.args[0]).to.deep.equal({ intent: 'owner transition scope transition bridge', category: 'scope_change', desiredPushScope: 'fleet', limit: 50 });
            expect(search.thirdCall.args[0]).to.deep.equal({ intent: 'owner transition intermediate scope transitions', category: 'scope_change', limit: 100 });
            expect(result.paths[0].steps.map((step: any) => step.name)).to.deep.equal(['owner_system', 'system_planet', 'planet_fleet']);
            expect(result.evidence).to.deep.include('cwtools-node-rules:scope.cwt:7');
            expect(result.evidence).to.deep.include('cwtools-node-rules:scope.cwt:10');
            expect(result.evidence).to.deep.include('cwtools-node-rules:scope.cwt:12');
            expect(result.evidence).to.deep.include('rules-sha256:abc123');
        } finally { cleanupWorkspace(workspaceRoot); }
    });
});
