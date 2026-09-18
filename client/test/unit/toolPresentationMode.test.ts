/**
 * Tests for Tool Presentation Mode (PTC vs Native vs Hybrid)
 * and TypeScript type-stripping resilience in QuickJS.
 */

import { expect } from 'chai';

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
    env: { language: 'en' },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, [request, ...args]);
};

import { normalizeToolPresentationMode } from '../../extension/ai/aiService';
import { projectModelFacingTools } from '../../extension/ai/agentRunner';
import {
    stripTypeScriptTypes,
    PTC_ONLY_INSTRUCTION,
    executeRunCodeProgram,
    createRunCodeCapabilitySnapshot,
} from '../../extension/ai/tools/runCode';
import type { ToolDefinition, ToolPresentationMode } from '../../extension/ai/types';
import { ToolDisclosureService } from '../../extension/ai/runner/toolDisclosure';
import { filterToolDefinitionsForMode } from '../../extension/ai/runnerPolicy';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';

describe('ToolPresentationMode and PTC/NATIVE routing', () => {
    describe('normalizeToolPresentationMode', () => {
        it('normalizes valid modes', () => {
            expect(normalizeToolPresentationMode('ptc')).to.equal('ptc');
            expect(normalizeToolPresentationMode('native')).to.equal('native');
            expect(normalizeToolPresentationMode('hybrid')).to.equal('hybrid');
        });

        it('defaults unknown or undefined values to ptc', () => {
            expect(normalizeToolPresentationMode(undefined)).to.equal('ptc');
            expect(normalizeToolPresentationMode(null)).to.equal('ptc');
            expect(normalizeToolPresentationMode('invalid')).to.equal('ptc');
            expect(normalizeToolPresentationMode(123)).to.equal('ptc');
        });
    });

    describe('projectModelFacingTools', () => {
        const sampleTools: ToolDefinition[] = [
            {
                type: 'function',
                function: { name: 'read_file', description: 'Read a file', parameters: {} },
            },
            {
                type: 'function',
                function: { name: 'edit_file', description: 'Edit a file', parameters: {} },
            },
            {
                type: 'function',
                function: { name: 'run_code', description: 'Run code', parameters: {} },
            },
        ];

        it('projects only run_code when mode is ptc and run_code is present', () => {
            const projected = projectModelFacingTools(sampleTools, 'ptc');
            expect(projected.map(t => t.function.name)).to.deep.equal(['run_code']);
        });

        it('falls back to all tools when mode is ptc but run_code is absent', () => {
            const toolsWithoutRunCode = sampleTools.filter(t => t.function.name !== 'run_code');
            const projected = projectModelFacingTools(toolsWithoutRunCode, 'ptc');
            expect(projected.map(t => t.function.name)).to.deep.equal(['read_file', 'edit_file']);
        });

        it('excludes run_code when mode is native', () => {
            const projected = projectModelFacingTools(sampleTools, 'native');
            expect(projected.map(t => t.function.name)).to.deep.equal(['read_file', 'edit_file']);
            expect(projected.some(t => t.function.name === 'run_code')).to.be.false;
        });

        it('preserves all tools when mode is hybrid', () => {
            const projected = projectModelFacingTools(sampleTools, 'hybrid');
            expect(projected.map(t => t.function.name)).to.deep.equal(['read_file', 'edit_file', 'run_code']);
        });
    });

    describe('stripTypeScriptTypes', () => {
        it('strips variable and parameter type annotations', () => {
            const input = 'const x: string = "hello";\nlet count: number = 42;';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('const x = "hello";');
            expect(output).to.include('let count = 42;');
            expect(output).not.to.include(': string');
            expect(output).not.to.include(': number');
        });

        it('strips array and generic type annotations', () => {
            const input = 'const items: string[] = ["a", "b"];\nconst map: Record<string, number> = {};';
            const output = stripTypeScriptTypes(input);
            expect(output).not.to.include(': string[]');
            expect(output).not.to.include(': Record<string, number>');
        });

        it('strips type assertions (as any, as const, as Type)', () => {
            const input = 'const a = data as any;\nconst b = config as const;\nconst c = val as string;';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('const a = data;');
            expect(output).to.include('const b = config;');
            expect(output).to.include('const c = val;');
            expect(output).not.to.include('as any');
            expect(output).not.to.include('as const');
        });

        it('strips interface and type declarations', () => {
            const input = `interface FileInfo {
    name: string;
    size: number;
}
type FileList = string[];
const done = true;`;
            const output = stripTypeScriptTypes(input);
            expect(output).not.to.include('interface FileInfo');
            expect(output).not.to.include('type FileList');
            expect(output).to.include('const done = true;');
        });

        it('preserves object literals and ternary operators', () => {
            const input = 'const obj = { pattern: "*.txt", depth: 3 };\nconst label = count > 0 ? "found" : "empty";';
            const output = stripTypeScriptTypes(input);
            expect(output).to.equal(input);
        });

        it('masks string literals to prevent corruption of embedded TS-like words', () => {
            const input = 'const sql = "SELECT id as userId, count as total FROM users WHERE type = \'admin\'";\nconst comment = \'interface Fake { name: string } as const\';';
            const output = stripTypeScriptTypes(input);
            expect(output).to.equal(input);
        });

        it('transforms enums into frozen objects', () => {
            const input = 'enum ActionKind { Read = "read", Write = "write", Default }';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('const ActionKind = Object.freeze({ Read: "read", Write: "write", Default: "Default" });');
        });

        it('strips generic parameters and non-null assertions', () => {
            const input = 'async function fetchFile<T>(p: string): Promise<T> { const r = await tools.read_file<T>({ file_path: p }); return r!.data as unknown as T; }';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('async function fetchFile(p)');
            expect(output).to.include('tools.read_file({ file_path: p })');
            expect(output).to.include('r.data');
            expect(output).not.to.include('<T>');
            expect(output).not.to.include('as unknown as T');
        });
    });

    describe('executeRunCodeProgram with TypeScript type stripping in QuickJS', () => {
        const definitions: ToolDefinition[] = [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read file',
                    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
                },
            },
        ];

        it('executes model code containing TypeScript annotations without syntax errors', async () => {
            const snapshot = createRunCodeCapabilitySnapshot(definitions);
            const tsCode = `
interface ResultData {
    content: string;
}
const path: string = "test.txt";
const file: any = await tools.read_file({ file_path: path });
const typed = file as ResultData;
return { ok: true, text: typed.content };
`;
            const dummyRunTool = async (_tool: string, args: Record<string, unknown>) => {
                return { content: 'sample content from ' + args.file_path };
            };
            const controller = new AbortController();
            const result = await executeRunCodeProgram(
                { code: tsCode, description: 'TypeScript stripping test' },
                snapshot,
                dummyRunTool,
                controller.signal,
            );

            expect(result.success).to.be.true;
            expect(result.error).to.be.undefined;
            expect(result.value).to.deep.equal({ ok: true, text: 'sample content from test.txt' });
        });

        it('executes model code using enums and generic calls seamlessly', async () => {
            const snapshot = createRunCodeCapabilitySnapshot(definitions);
            const tsCode = `
enum Action { Read = "read", Default = "default" }
const current: Action = Action.Read;
async function doFetch<T>(p: string): Promise<T> {
    const res = await tools.read_file<T>({ file_path: p });
    return res!.content as unknown as T;
}
const text = await doFetch("enums.txt");
return { action: current, text };
`;
            const dummyRunTool = async (_tool: string, args: Record<string, unknown>) => {
                return { content: 'sample content from ' + args.file_path };
            };
            const controller = new AbortController();
            const result = await executeRunCodeProgram(
                { code: tsCode, description: 'Enum and generic test' },
                snapshot,
                dummyRunTool,
                controller.signal,
            );

            expect(result.success).to.be.true;
            expect(result.value).to.deep.equal({ action: 'read', text: 'sample content from enums.txt' });
        });
    });

    describe('PTC_ONLY_INSTRUCTION', () => {
        it('contains the directive that only run_code can be called directly', () => {
            expect(PTC_ONLY_INSTRUCTION).to.include('run_code');
            expect(PTC_ONLY_INSTRUCTION).to.include('only tool you can call directly');
        });
    });

    describe('End-to-End Disclosure and Projection Pipeline (Turn 1 Integration)', () => {
        it('ensures run_code is always included in initialTools under default dynamic tool disclosure', () => {
            const disclosureService = new ToolDisclosureService();
            const eligibleTools = filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build', { domain: 'paradox' });
            const initialTools = disclosureService.initialTools(eligibleTools, {
                mode: 'build',
                domain: 'paradox',
                dynamicSupported: true,
                loaded: new Set(),
            });

            // run_code must be in initialTools from turn 1
            const hasRunCode = initialTools.some(t => t.function.name === 'run_code');
            expect(hasRunCode).to.be.true;

            // In PTC mode, projectModelFacingTools must project ONLY run_code
            const ptcModelFacing = projectModelFacingTools(initialTools, 'ptc');
            expect(ptcModelFacing.map(t => t.function.name)).to.deep.equal(['run_code']);

            // In NATIVE mode, projectModelFacingTools must exclude run_code
            const nativeModelFacing = projectModelFacingTools(initialTools, 'native');
            expect(nativeModelFacing.some(t => t.function.name === 'run_code')).to.be.false;
            expect(nativeModelFacing.length).to.be.greaterThan(1);
        });

        it('PTC rejection logic produces failed result for direct tool calls', () => {
            const effectivePresentationMode: ToolPresentationMode = 'ptc';
            const toolName: string = 'read_file';
            const ci = { invocationId: 'inv_test_123', toolName, toolArgs: { file_path: 'foo.txt' } };
            const steps: any[] = [];
            const emitStep = (s: any) => steps.push(s);

            let toolResult: any;
            if (effectivePresentationMode === 'ptc' && toolName !== 'run_code') {
                const reason = `Tool '${toolName}' cannot be called directly in PTC mode. In PTC mode, only 'run_code' is available — write a program to call tools via await tools.${toolName}(...). ${PTC_ONLY_INSTRUCTION}`;
                emitStep({
                    type: 'validation',
                    content: reason,
                    timestamp: Date.now(),
                    invocationId: ci.invocationId,
                });
                toolResult = { success: false, error: reason };
            }

            expect(toolResult).to.deep.equal({
                success: false,
                error: "Tool 'read_file' cannot be called directly in PTC mode. In PTC mode, only 'run_code' is available — write a program to call tools via await tools.read_file(...). " + PTC_ONLY_INSTRUCTION,
            });
            expect(steps.map(s => s.type)).to.deep.equal(['validation']);
            expect(steps[0].invocationId).to.equal('inv_test_123');
        });
    });
});
