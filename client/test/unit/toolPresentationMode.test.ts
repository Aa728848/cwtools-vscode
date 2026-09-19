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
        it('masks string literals containing escaped quotes without breaking', () => {
            const input = 'const cmd = "grep \\"some: string\\" file.txt"; const x: number = 42;';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('const cmd = "grep \\"some: string\\" file.txt";');
            expect(output).to.include('const x = 42;');
        });

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
            const input = 'enum ActionKind { Read = "read", Write = "write" }';
            const output = stripTypeScriptTypes(input);
            expect(output).to.include('enum_ActionKind["Read"] = "read";');
            expect(output).to.include('enum_ActionKind["Write"] = "write";');
        });

        it('lowers numeric enum members to TypeScript auto-increment values', () => {
            // TypeScript: enum E { A, B, C } is { A: 0, B: 1, C: 2 } and a
            // numeric initializer resumes the counter after it. Returning the
            // member's *name* here would be a silent wrong value, not an error.
            const auto = stripTypeScriptTypes('enum E { A, B, C }');
            expect(auto).to.include('enum_E["A"] = 0;');
            expect(auto).to.include('enum_E["B"] = 1;');
            expect(auto).to.include('enum_E["C"] = 2;');
            const mixed = stripTypeScriptTypes('enum M { A, B = 5, C }');
            expect(mixed).to.include('enum_M["B"] = 5;');
            expect(mixed).to.include('enum_M["C"] = 6;');
            const jumps = stripTypeScriptTypes('enum Z { A = 1, B, C = 10, D }');
            expect(jumps).to.include('enum_Z["D"] = 11;');
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

        it('allows host tools to mutate arguments in-place without read-only property errors', async () => {
            const definitionsWithCommand: ToolDefinition[] = [
                {
                    type: 'function',
                    function: {
                        name: 'run_command',
                        description: 'Run command',
                        parameters: { type: 'object', properties: { command: { type: 'string' } } },
                    },
                },
            ];
            const snapshot = createRunCodeCapabilitySnapshot(definitionsWithCommand);
            const tsCode = `
const res = await tools.run_command({ command: "echo original" });
return res;
`;
            // Simulate externalTools.ts mutating args.command in-place
            const mutatingRunTool = async (_tool: string, args: Record<string, unknown>) => {
                args.command = (args.command as string) + ' normalized';
                return { output: args.command, success: true };
            };
            const controller = new AbortController();
            const result = await executeRunCodeProgram(
                { code: tsCode, description: 'Mutating tool test' },
                snapshot,
                mutatingRunTool,
                controller.signal,
            );

            expect(result.success).to.be.true;
            expect(result.error).to.be.undefined;
            expect(result.value).to.deep.equal({ output: 'echo original normalized', success: true });
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

    describe('type erasure must never rewrite runtime JavaScript values', () => {
        // Regression: a regex-based pass could not tell an object literal's
        // `key: value` from a type annotation. It rewrote
        // `{ query: "dynamic", isRegex: false }` into `{ query, isRegex }`,
        // which then threw "ReferenceError: isRegex is not defined" inside the
        // QuickJS guest and made PTC mode effectively unusable.
        it('preserves boolean, string, and number object-literal values in tool arguments', () => {
            const input = 'const r = await tools.grep({ query: "dynamic", caseSensitive: false, isRegex: true, limit: 40 });';
            expect(stripTypeScriptTypes(input)).to.equal(input);
        });

        it('preserves every value shape in a nested object argument', () => {
            const input = [
                'const r = await tools.dispatch_agents({',
                '  tasks: [{ id: "a", objective: "x", deps: [], enabled: true, weight: 1.5 }],',
                '  parallel: false,',
                '});',
            ].join('\n');
            expect(stripTypeScriptTypes(input)).to.equal(input);
        });

        it('preserves object literals inside template substitutions and catch blocks', () => {
            const input = 'try { await tools.grep({ query: "a", limit: 1 }); } catch (e) { return { err: String(e), isRegex: false }; }';
            expect(stripTypeScriptTypes(input)).to.equal(input);
        });

        it('keeps comparison, ternary, and division intact', () => {
            for (const input of [
                'const ok = a < b && c > d;',
                'const label = count > 0 ? "found" : "empty";',
                'const ratio = total / count;',
                'const r = x < y ? z : w;',
            ]) {
                expect(stripTypeScriptTypes(input), input).to.equal(input);
            }
        });

        it('leaves string, template, regex, and comment contents untouched', () => {
            const input = [
                'const sql = "SELECT id as userId FROM users WHERE type = \'admin\'";',
                'const note = \'interface Fake { name: string } as const\';',
                'const tpl = `value: ${ obj.a }:${ x } as string`;',
                'const re = /isRegex: false/g;',
                '// const x: string = "a"',
                '/* interface Foo { a: string } */',
            ].join('\n');
            expect(stripTypeScriptTypes(input)).to.equal(input);
        });

        it('erases the TypeScript that does appear in an otherwise ordinary program', () => {
            const output = stripTypeScriptTypes([
                'interface Row<T> { id: T }',
                'type Ids = string[];',
                'enum Kind { Read = "read", Default }',
                'const rows: Row<string>[] = [];',
                'async function load<T>(p: string): Promise<T> {',
                '  const res = await tools.read_file<{ content: string }>({ file_path: p });',
                '  return res.content as unknown as T;',
                '}',
            ].join('\n'));
            expect(output).not.to.include('interface Row');
            expect(output).not.to.include('type Ids');
            expect(output).to.include('enum_Kind["Read"] = "read";');
            expect(output).to.include('const rows = [];');
            expect(output).to.include('async function load(p)');
            expect(output).to.include('tools.read_file({ file_path: p })');
        });

        it('produces guest-evaluable JavaScript for the argument shapes seen in practice', () => {
            const programs = [
                'const [a, b] = await Promise.all([\n' +
                '  tools.grep({ query: "dynamic", searchContext: "workspace", isRegex: false, limit: 40 }),\n' +
                '  tools.grep({ query: "exe_dynamic", caseSensitive: false, limit: 60 }),\n' +
                ']);\nreturn { a: a.totalMatches, b: b.totalMatches };',
                'const f: string = "a";\nconst o = { pattern: "*.txt", depth: 3 };\nreturn { f, o };',
            ];
            for (const program of programs) {
                const code = stripTypeScriptTypes(program);
                expect(() => new Function('tools', 'return (async () => {' + code + '})'), program).to.not.throw();
            }
        });
    });

    describe('end-to-end: the captured PTC failure now executes', () => {
        it('runs the exact program that previously threw "isRegex is not defined"', async () => {
            const definitions: ToolDefinition[] = [
                {
                    type: 'function',
                    function: {
                        name: 'grep',
                        description: 'Search the workspace',
                        parameters: {
                            type: 'object',
                            properties: {
                                query: { type: 'string' },
                                searchContext: { type: 'string' },
                                caseSensitive: { type: 'boolean' },
                                isRegex: { type: 'boolean' },
                                limit: { type: 'number' },
                            },
                        },
                    },
                },
            ];
            const snapshot = createRunCodeCapabilitySnapshot(definitions);
            const seen: Array<Record<string, unknown>> = [];
            const runTool = async (_tool: string, args: Record<string, unknown>) => {
                seen.push({ ...args });
                return { matches: [], totalMatches: 0 };
            };
            // Captured verbatim from a real conversation that failed in the guest.
            const code = [
                'const [dongxiu, dyna] = await Promise.all([',
                '  tools.grep({ query: "动修", searchContext: "workspace", isRegex: false, limit: 40 }),',
                '  tools.grep({ query: "dynamic", caseSensitive: false, limit: 60 }),',
                ']);',
                'return { a: dongxiu.totalMatches, b: dyna.totalMatches };',
            ].join('\n');
            const controller = new AbortController();
            const result = await executeRunCodeProgram(
                { code, description: 'Replay the captured PTC failure' },
                snapshot,
                runTool,
                controller.signal,
            );
            expect(result.error, String(result.error)).to.be.undefined;
            expect(result.success).to.be.true;
            expect(result.value).to.deep.equal({ a: 0, b: 0 });
            expect(seen).to.deep.equal([
                { query: '动修', searchContext: 'workspace', isRegex: false, limit: 40 },
                { query: 'dynamic', caseSensitive: false, limit: 60 },
            ]);
        });
    });

    describe('TypeScript constructs that appear in real programs are erased completely', () => {
        // Every case below is real TypeScript a model can plausibly emit in a
        // run_code program. A partially erased program is worse than an
        // unerased one: the guest reports a syntax error that looks like the
        // model's mistake rather than a host limitation.
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const parse = (code: string): void => {
            const out = erased(code);
            expect(() => new Function('tools', 'return (async () => {' + out + '})'), out).to.not.throw();
        };

        it('erases a non-null assertion at the end of an expression', () => {
            const out = erased('const m = new Map<string, number>();\nreturn m.get("a")!;');
            expect(out).to.include('return m.get("a");');
        });

        it('erases a definite-assignment assertion on a class field', () => {
            const out = erased('class C { x!: number; constructor() { this.x = 4; } }');
            // The `!` and its annotation are type-only, and a field with no
            // initializer emits nothing, matching TypeScript.
            expect(out).to.include('class C { constructor() { this.x = 4; } }');
        });

        it('erases a TypeScript this parameter', () => {
            const out = erased('function f(this: void, a: number = 2): number { return a; }');
            expect(out.replace(/\s+/g, ' ')).to.include('function f( a = 2) { return a; }');
        });

        it('erases a generic class and its instantiation', () => {
            const out = erased('class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }\nreturn new Box<number>(9).get();');
            // `value: T;` declares the shape only, so TypeScript emits nothing for
            // it; the constructor assignment is the real runtime code.
            expect(out).to.include('class Box { constructor(v) { this.value = v; } get() { return this.value; } }');
            expect(out).to.include('new Box(9).get()');
        });

        it('erases abstract classes, abstract members, and implements clauses', () => {
            parse('abstract class Base { abstract run(): number; }\nclass Impl extends Base implements Runnable { run(): number { return 5; } }\nreturn new Impl().run();');
            const out = erased('abstract class Base { abstract run(): number; }\nclass Impl extends Base implements Runnable { run(): number { return 5; } }');
            expect(out).to.include('class Impl extends Base { run() { return 5; } }');
        });

        it('erases generic arrow functions and conditional type aliases', () => {
            const out = erased('const f = <T extends number>(x: T): T => x;\ntype C<T> = T extends string ? string : number;\nconst y: C<string> = "s";\nreturn [f(2), y];');
            expect(out).not.to.include('type C');
            expect(out).to.include('const y = "s";');
            parse('const f = <T extends number>(x: T): T => x;\ntype C<T> = T extends string ? string : number;\nconst y: C<string> = "s";\nreturn [f(2), y];');
        });

        it('erases the inline type modifier from an import specifier list', () => {
            expect(erased('import { type Foo, bar } from "m";').replace(/\s+/g, ' ').trim()).to.equal('import { bar } from "m";');
            expect(erased('import { bar, type Foo } from "m";').replace(/\s+/g, ' ').trim()).to.equal('import { bar } from "m";');
            expect(erased('import { type Foo as F, bar } from "m";').replace(/\s+/g, ' ').trim()).to.equal('import { bar } from "m";');
        });

        it('erases a constructor parameter property but keeps the parameter', () => {
            const out = erased('class A { constructor(private readonly name: string) {} }');
            expect(out.replace(/\s+/g, ' ')).to.include('constructor( name)');
        });

        it('erases an annotated array destructuring declaration', () => {
            const out = erased('const [x, y]: number[] = arr;');
            expect(out).to.include('const [x, y] = arr;');
        });

        it('keeps generic parameter defaults erasable', () => {
            const out = erased('function f<T = string>(x: T): T { return x; }');
            expect(out).to.include('function f(x) { return x; }');
        });


        it('erases class generics, implements clauses, abstract classes and accessor modifiers', () => {
            const out = erased('class Box<T> { v: T; get(): T { return this.v; } }\nclass Impl extends Base implements Runnable { }\nabstract class A { abstract m(): void; }\nclass B { accessor x = 1; }');
            expect(out).to.include('class Box { get() { return this.v; } }');
            expect(out).to.include('class Impl extends Base { }');
            expect(out).not.to.include('abstract');
            expect(out).not.to.include('accessor');
            expect(out).to.include('class B { x = 1; }');
        });

        it('erases namespace declarations and a trailing non-null assertion in any position', () => {
            const out = erased('namespace N { export const a = 1; }\nconst m = new Map();\nreturn [m.get("k")!, 2];');
            expect(out).not.to.include('namespace');
            expect(out).to.include('return [m.get("k"), 2];');
        });

        it('lowers constructor parameter properties to field assignments', () => {
            const out = erased('class A { constructor(private readonly x: number) {} }');
            expect(out).to.include('this.x = x;');
            expect(out.replace(/\s+/g, ' ')).to.include('constructor( x)');
        });

        it('places parameter-property assignments after super() in a derived class', () => {
            // Replacing the super() semicolon with the assignment text emitted
            // "super()super();", and assigning before super() throws
            // "this is not initialized". Both must hold.
            const source = 'class Sq extends Shape { constructor(private s: number) { super(); } area(): number { return this.s; } }';
            const out = erased(source);
            expect(out).to.include('super(); this.s = s;');
            expect(out).not.to.include('super()super()');
            parse(source + '\nreturn 1;');
        });

        it('erases arrow return types in object-property, array, and ternary positions', () => {
            parse('const o = { m: (x: number): string => "v" + x }; return o.m(1);');
            parse('const a = [(x: number): number => x + 1]; return a[0](1);');
            parse('const f = 1 ? (x: number): number => x : (x: number): number => -x; return f(2);');
        });

        it('handles generic parameter lists on functions and arrow return types in object literals', () => {
            expect(erased('const o = { m: (x: number): string => (x ? "a" : "b") };')).to.include('const o = { m: (x) => (x ? "a" : "b") };');
        });
    });

    describe('Adversarial programs from independent verification', () => {
        // Each case is a verbatim input that an independent adversarial review
        // found broken. The assertions are on OBSERVABLE behavior: the program
        // must reach QuickJS and produce the value the TypeScript compiler would.
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const parse = (code: string): string => {
            const out = erased(code);
            expect(() => new Function('tools', 'return (async () => {' + out + '})'), out).to.not.throw();
            return out;
        };

        it('terminates on a type alias that follows another statement', () => {
            // A terminator before the declaration made the pass fail to advance
            // and hang the Extension Host; the eraser must always return.
            expect(erased('const a = 1;\ntype T = number;\nreturn a;')).to.include('return a;');
            expect(erased('const o = { a: 1 };\ntype K = keyof typeof o;\nreturn 1;')).to.include('const o = { a: 1 };');
        });

        it('keeps object keys and method names that look like type keywords', () => {
            const out = erased('const o = { declare: 1, interface: 2, implements: 3, abstract: 4 };\nreturn o;');
            expect(out).to.include('declare: 1');
            expect(out).to.include('interface: 2');
            expect(out).to.include('implements: 3');
            expect(out).to.include('abstract: 4');
            const method = erased('class C { abstract() { return 5; } implements() { return 6; } }');
            expect(method).to.include('abstract()');
            expect(method).to.include('implements()');
        });

        it('preserves prefix logical negation', () => {
            expect(erased('let b = true;\nif (!b) { b = false; }\nreturn b;')).to.include('if (!b)');
            expect(erased('const a = 1, b = 2;\nreturn !(a === b);')).to.include('return !(a === b);');
        });

        it('erases a non-null assertion in arithmetic, comparison and nullish positions', () => {
            expect(parse('const o: { a: number } = { a: 1 };\nreturn o.a! + 1;')).to.include('o.a + 1');
            expect(parse('const o: { a: number | null } = { a: 1 };\nreturn o.a! ?? 2;')).to.include('o.a ?? 2');
            expect(parse('const o: { a: number } = { a: 1 };\nreturn o.a! === 1;')).to.include('o.a === 1');
        });

        it('erases nested function-type return annotations', () => {
            const out = parse('const f = (a: number): ((b: number) => number) => (b: number): number => a + b;\nreturn f(2)(3);');
            expect(out).not.to.include(': ((');
            expect(parse('const o = { m: (x: number): ((z: number) => number) => (z: number): number => x * z };')).not.to.include(': ((');
        });

        it('erases class-expression generics and heritage type arguments', () => {
            expect(parse('const C = class<T> { v: T; constructor(v: T) { this.v = v; } };\nreturn new C(1).v;')).to.not.include('class<T>');
            expect(parse('class Base<T> { constructor(public v: T) {} }\nclass Impl extends Base<number> { }\nreturn new Impl(2).v;')).to.include('extends Base {');
        });

        it('erases type predicates, overloads, optional methods and index signatures', () => {
            const predicate = parse('function isS(x: unknown): x is string { return typeof x === "string"; }\nreturn isS("a");');
            expect(predicate).not.to.include('is string');
            expect(parse('function f(x: number): number;\nfunction f(x: number) { return x + 1; }\nreturn f(1);')).to.not.include('): number;');
            expect(parse('class A { m?(): void; }\nreturn 1;')).to.include('class A { }');
            expect(parse('class A { [k: string]: number; }\nreturn 1;')).to.include('class A { }');
        });

        it('lowers enums with constant expressions, negatives and member references', () => {
            expect(erased('enum E { A = 1 + 2, B }')).to.include('enum_E["A"] = 3;');
            expect(erased('enum E { A = (1 + 2), B }')).to.include('enum_E["A"] = 3;');
            expect(erased('enum E { A = 1_0, B }')).to.include('enum_E["A"] = 10;');
            expect(erased('enum Neg { A = -1, B }')).to.include('enum_Neg["A"] = -1;');
            expect(erased('enum Sh { A = 1 << 2, B }')).to.include('enum_Sh["A"] = 4;');
            // A member may reference an earlier member: reading it from the
            // enclosing scope would be a ReferenceError.
            expect(erased('enum R { A = 1, B = A + 1 }')).to.include('enum_R["B"] = enum_R["A"] + 1;');
            expect(parse('const K = 5;\nenum E { A = K, B }\nreturn [E.A, E.B];')).to.include('enum_E["A"] = K;');
        });

        it('lowers const enums and preserves runtime namespaces', () => {
            // The `const` modifier must be gone; `const enum_CE` is the lowered
            // object binding and is fine.
            expect(parse('const enum CE { A = 1, B }\nreturn CE.B;')).not.to.include('const enum CE');
            // Erasing a namespace deletes its exported values outright, so it is
            // lowered to an IIFE that keeps the bindings addressable.
            const ns = erased('namespace N { export const a = 1; export function f(): number { return 2; } }\nreturn N.a + N.f();');
            expect(ns).not.to.include('namespace');
            // Exported bindings become properties of the namespace object, so
            // `N.a` and `N.f()` keep working instead of throwing.
            expect(ns).to.include('N.a = 1');
            expect(ns).to.include('N.f =');
        });

        it('does not swallow the statement after a brace-shaped or ambient type', () => {
            expect(erased('type O = { a: number }\nconst q: O = { a: 1 }\nreturn q.a')).to.include('return q.a');
            expect(erased('declare global { interface W { x: number } }\nconst q: number = 1\nreturn q')).to.include('const q = 1');
            expect(erased('declare module "pkg" { export const x: number; }\nconst y: number = 2;\nreturn y;')).to.include('const y = 2;');
        });

        it('preserves statement labels and object-literal member syntax', () => {
            expect(erased('loop: for (let i = 0; i < 2; i++) { if (i === 1) break loop; }\nreturn 1;')).to.include('loop: for (');
            const out = erased('const o = { declare: 1, interface: 2 };\nreturn o;');
            expect(out).to.include('declare: 1');
        });
    });

    describe('Second adversarial pass: silent corruption and statement boundaries', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const parse = (code: string): string => {
            const out = erased(code);
            expect(() => new Function('tools', 'return (async () => {' + out + '})'), out).to.not.throw();
            return out;
        };

        it('continues enum auto-increment after a computed member', () => {
            // A computed initializer is unknown at erase time, so the counter has
            // to read the previous member at runtime; a literal 0 here would be a
            // silent wrong value.
            const outer = erased('const K = 4;\nenum E { A = K, B }');
            expect(outer).to.include('enum_E["B"] = enum_E["A"] + 1;');
            const call = erased('function two(){return 2}\nenum E { A = two(), B }');
            expect(call).to.include('enum_E["B"] = enum_E["A"] + 1;');
            // A pure numeric member still folds, so the output stays readable.
            expect(erased('enum E { A = 1, B }')).to.include('enum_E["B"] = 2;');
        });

        it('does not swallow a statement joined by automatic semicolon insertion', () => {
            // `type T = number` followed by a line starting with `[` used to be
            // read as the indexed-access type `number[...]`, deleting the rest.
            const out = erased('let total = 0;\ntype T = number\n[1, 2].forEach(function (x) { total += x; })\nreturn total;');
            expect(out).to.include('.forEach(');
            expect(out).to.include('return total;');
            expect(erased('let n = 0;\ndeclare const g: number\n[1].forEach(function (x) { n += x; })\nreturn n;')).to.include('.forEach(');
        });

        it('erases a class field that has no initializer', () => {
            // TypeScript emits nothing for a shape-only field; leaving `a;` makes
            // it a real own property and changes Object.keys output.
            expect(erased('class C { a: number; }')).to.include('class C { }');
            expect(erased('class C { a?: number; }')).to.include('class C { }');
            // An initializer IS runtime code and must stay.
            expect(erased('class C { a: number = 1; }')).to.include('a = 1;');
            expect(erased('class C { implements = 5; }')).to.include('implements = 5;');
        });

        it('erases annotations on destructuring parameters and computed keys', () => {
            expect(parse('function f({ a, b }: { a: number; b: number }): number { return a + b; }\nreturn f({ a: 1, b: 2 });')).to.include('function f({ a, b })');
            expect(parse('function g([x, y]: number[]) { return x + y; }\nreturn g([1, 2]);')).to.include('function g([x, y])');
            expect(parse('const k = "f";\nclass C { [k]: number = 1; }\nreturn new C()[k];')).to.include('[k] = 1;');
        });

        it('keeps abstract and implements as member names in every position', () => {
            expect(erased('const o = { abstract: 41 };\nreturn o.abstract;')).to.include('o.abstract;');
            expect(erased('class C { abstract = 5; }')).to.include('abstract = 5;');
            expect(erased('class C { implements = 5; }')).to.include('implements = 5;');
            // Real modifiers are still erased.
            expect(erased('abstract class A { abstract run(): number; }')).not.to.include('abstract');
            expect(erased('class C implements A, B { }')).to.include('class C { }');
        });

        it('erases a generic type argument that is itself a function type', () => {
            expect(parse('function id<T>(x: T): T { return x; }\nreturn id<(n: number) => number>((n) => n + 1)(2);')).to.include('id((n) => n + 1)(2)');
        });
    });

    describe('Lowering must emit statement separators that ASI cannot join', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const parse = (code: string): string => {
            const out = erased(code);
            expect(() => new Function('tools', 'return (async () => {' + out + '\n})'), out).to.not.throw();
            return out;
        };

        it('separates a lowered namespace from a preceding member ending in a brace', () => {
            // The namespace tail is written where the closing brace was; without
            // a separator `}` + `return` is a syntax error under ASI.
            const out = parse('namespace N { export const a = 1; export function f(): number { return 2; } }\nreturn N.a + N.f();');
            // TypeScript's own shape, so a merged namespace stays legal and the
            // declaration is separated from the next statement.
            expect(out).to.include('(function (N) {');
            expect(out).to.include('N.a = 1');
            expect(out).to.include('N.f =');
            expect(out).to.include('N || (N = {})');
        });

        it('separates a lowered enum from a preceding declaration', () => {
            expect(parse('const K = 1;\nenum E { A = K, B }\nreturn E.B;')).to.include('return Object.freeze(');
        });

        it('separates parameter-property assignments from super()', () => {
            const out = parse('class B { constructor(){} }\nclass C extends B { constructor(private s: number) { super(); } }\nreturn new C(3).s;');
            expect(out).to.include('super(); this.s = s;');
            expect(out).not.to.include('super()super()');
        });
    });

    describe('Plain JavaScript must survive erasure byte-for-byte', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);

        it('keeps the double negation after a block-closing brace', () => {
            // A '}' closing a BLOCK ends the statement, so the following '!' is
            // prefix negation, not a non-null assertion.
            const out = erased('function f(a, b) { if (d) { return } !!(a.d = b); }');
            expect(out).to.include('} !!(a.d = b)');
            const stmt = erased('if (d) { return } !y;');
            expect(stmt).to.include('} !y;');
        });

        it('keeps a binding named as or satisfies', () => {
            expect(erased('_.Pb = function as() { return 1; };')).to.include('function as()');
            expect(erased('const f = function as() { return 1; };')).to.include('function as()');
            expect(erased('class satisfies { }')).to.include('class satisfies');
            // A real assertion is still erased.
            expect(erased('x = a as b;')).to.include('x = a;');
        });

        it('keeps a loop binding named like a modifier', () => {
            expect(erased('for (const override of overrides) { x(); }')).to.include('const override of');
            expect(erased('for (const readonly in o) { x(); }')).to.include('const readonly in');
        });

        it('keeps a regex containing a quote inside a template substitution', () => {
            // The quote inside /\"/g used to open a bogus string in the template
            // skipper, desynchronising every later token.
            const src = 'const t = `a${v.replace(/\\/g, \'\\\\\').replace(/\"/g, \'\\"\')} as b`;';
            expect(erased(src)).to.equal(src);
        });

        it('keeps statement separation when lowering a namespace', () => {
            const out = erased('namespace N { export const a = 1; export function f(): number { return 2; } }');
            expect(out).to.include('var N;');
            expect(out.trim().endsWith(';')).to.equal(true);
            expect(out).to.include('N || (N = {})');
        });

        it('removes an ambient declaration whole instead of only the keyword', () => {
            // The guest prelude itself is `declare class ...` + `declare const ...`,
            // so a partial erase turns valid input into a syntax error.
            expect(erased('declare function g(): number;\nreturn 1;')).to.not.include('g()');
            expect(erased('declare const RATE: number;\nreturn 1;')).to.not.include('RATE');
            const prelude = erased('declare class ToolCallError extends Error { constructor(m){ super(m); } }\ndeclare const tools: { call: (n: string) => Promise<unknown> };\nreturn 1;');
            expect(prelude).to.not.include('ToolCallError');
            expect(prelude).to.include('return 1;');
        });
    });

    describe('Byte identity on plain JavaScript and object-shape safety', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const parse = (code: string): string => {
            const out = erased(code);
            expect(() => new Function('tools', 'return (async () => {' + out + '\n})'), out).to.not.throw();
            return out;
        };

        it('does not treat an object key named class as a class body', () => {
            // The mermaid.min.js corruption: `class:{useMaxWidth:!0,...}` lost the
            // initializer because the value looked like a class body.
            expect(erased('const o = { class: { a: 1 } };')).to.equal('const o = { class: { a: 1 } };');
            expect(erased('const o = { class: { useMaxWidth: !0, titleTopMargin: 25 } };'))
                .to.equal('const o = { class: { useMaxWidth: !0, titleTopMargin: 25 } };');
            expect(erased('var o = {}; o.class = { a: 1 };')).to.equal('var o = {}; o.class = { a: 1 };');
        });

        it('keeps a class field whose initializer is a call', () => {
            for (const source of ['class F { static x = loadConfig(); }', 'class F { x = new Foo(); }',
                'class F { x = a.b(); }', 'class F { env = String((true)); }']) {
                expect(erased(source), source).to.equal(source);
            }
        });

        it('honours automatic semicolon insertion before a prefix bang', () => {
            // `!0` is idiomatic minified JavaScript and starts a new statement.
            expect(erased('var a = String("x")\n!0;')).to.equal('var a = String("x")\n!0;');
            expect(erased('const f = (z) => z\n!0;')).to.equal('const f = (z) => z\n!0;');
        });

        it('keeps an identifier named as or satisfies in expression position', () => {
            expect(parse('function as() { return 1; }\nreturn as();')).to.include('return as();');
            expect(parse('const as = () => 3;\nreturn as();')).to.include('return as();');
            expect(erased('for (const as of [1, 2]) { n += as; }')).to.include('const as of');
            // A real assertion is still erased.
            expect(erased('const x = a as b;')).to.include('const x = a;');
            expect(erased('const x = a satisfies T;')).to.include('const x = a;');
        });

        it('keeps a prefix bang after a class body or a labelled block', () => {
            expect(erased('class C {}\n!x;')).to.include('}\n!x;');
            expect(erased('l: { }\n!x;')).to.include('}\n!x;');
        });

        it('does not let a for-head binding run into the next statement', () => {
            // The declarator scan used to continue past `of` into the following
            // statement and erase a label's colon.
            const source = 'for (const key of tests) {\n  if (a[key] < b[key]) {\n  }\n}\nouter: for (const bestKey of tests) { }';
            expect(erased(source)).to.include('outer: for (');
        });

        it('keeps a regex containing a quote inside a template substitution', () => {
            const source = 'const t = `a${v.replace(/\\/g, \'x\').replace(/\"/g, \'y\')} as b`;';
            expect(erased(source)).to.equal(source);
        });

        it('keeps braces inside a template substitution', () => {
            // An arrow body's `}` used to close the `${` early, so the rest of
            // the template was tokenised as code.
            const source = 'const s = `a ${xs.map((d) => {\n  return d;\n}).join()}`;\nconst t = q ? ` (e: ${f(e.k)})` : "";';
            const out = erased(source);
            expect(out).to.include('(e: ${f(e.k)})');
            expect(out).to.include('xs.map((d) => {');
        });
    });

    describe('Namespace lowering keeps exported bindings addressable', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const run = async (code: string): Promise<unknown> => {
            const out = erased(code);
            // `return (async () => {...})` yields the function itself, so the
            // wrapper has to be invoked to run the program body.
            const fn = new Function('tools', 'return (async () => {' + out + '\n})()') as () => Promise<unknown>;
            return await fn();
        };

        it('publishes a reference to an exported sibling', async () => {
            expect(await run('namespace N { export const a = 1; export const b = a + 1; }\nreturn N.b;')).to.equal(2);
        });

        it('keeps a non-exported local local', async () => {
            expect(await run('namespace N { const a = 1; export const b = a + 1; }\nreturn N.b;')).to.equal(2);
        });

        it('lowers an exported function and class with their annotations', async () => {
            expect(await run('namespace N { export function f(): number { return 2; } }\nreturn N.f();')).to.equal(2);
            expect(await run('namespace N { export class C { m(): number { return 3; } } }\nreturn new N.C().m();')).to.equal(3);
        });

        it('resolves an exported sibling referenced inside a function body', async () => {
            expect(await run('namespace N { export const a = 1; export function g(): number { return a + 1; } }\nreturn N.g();')).to.equal(2);
        });
    });

    describe('Fourth adversarial pass: labels, ternaries, private fields, generics', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const run = async (code: string): Promise<unknown> => {
            const out = erased(code);
            const fn = new Function('tools', 'return (async () => {' + out + '\n})()') as () => Promise<unknown>;
            return await fn();
        };

        it('keeps a modifier-named member access inside a ternary', () => {
            // 's.readonly[0]' is an index expression, not a computed member key.
            const source = 'var c = true; var s = { readonly: [9] }; return c ? s.readonly[0] : 1;';
            expect(erased(source)).to.equal(source);
            const field = 'class C { p = c ? s.readonly[0] : 1; }';
            expect(erased(field)).to.equal(field);
        });

        it('keeps a label on a bare expression statement', () => {
            const label = 'var r = []; L: /]/;';
            expect(erased(label)).to.equal(label);
            expect(erased('L: a.b;')).to.equal('L: a.b;');
        });

        it('keeps a relational comparison that looks like type arguments', () => {
            const source = 'var f = 2, g = function () { return 3; }; var r = (f < f) > (g()); return r;';
            expect(erased(source)).to.equal(source);
        });

        it('strips an annotation from a private field with an initializer', async () => {
            const field = "class C { #q: string = \"z\"; }";
            expect(erased(field)).to.equal("class C { #q = \"z\"; }");
            const program = "class C { #q: string = \"z\"; m() { return this.#q; } } return new C().m();";
            expect(await run(program)).to.equal("z");
        });

        it('strips only the annotation from a field with an initializer', () => {
            expect(erased('class C { a: number = 1; }')).to.equal('class C { a = 1; }');
            const computed = "const k = \"f\"; class C { [k]: number = 1; }";
            expect(erased(computed)).to.include("[k] = 1;");
        });
    });

    describe('Third adversarial pass: member names, private fields, namespaces', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const run = async (code: string): Promise<unknown> => {
            const out = erased(code);
            const fn = new Function('tools', 'return (async () => {' + out + '\n})()') as () => Promise<unknown>;
            return await fn();
        };

        it('keeps interface as an object member name', () => {
            // '{ interface() {} }' and '{ interface: 1 }' use the word as a KEY.
            const method = 'const o = { interface() { return 1; } };';
            expect(erased(method)).to.equal(method);
            const property = 'const o = { interface: 1 };';
            expect(erased(property)).to.equal(property);
            const loop = 'for (x in { interface() {}, a: 1 }) { }';
            expect(erased(loop)).to.equal(loop);
        });

        it('does not read an array literal in an initializer as an index signature', () => {
            const a = 'class C { p = c ? [] : n.x; }';
            expect(erased(a)).to.equal(a);
            const b = 'class C { p = c ? [1] : 2; }';
            expect(erased(b)).to.equal(b);
            // A real index signature is still erased.
            expect(erased('class A { [k: string]: number; }')).to.include('class A { }');
        });

        it('keeps a private field declaration and strips only its annotation', () => {
            expect(erased('class C { #p!: number; }')).to.include('#p;');
            expect(erased('class C { #p: number; }')).to.include('#p;');
        });

        it('merges repeated namespace declarations', async () => {
            expect(await run('namespace M { export const a = 1; } namespace M { export const b = 2; } return M.a + M.b;')).to.equal(3);
        });

        it('keeps a modifier name in a member access', () => {
            const source = 'const v = (x.readonly[0]);';
            expect(erased(source)).to.equal(source);
        });
    });

    describe('Fifth adversarial pass: modifier names in expressions', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);

        it('keeps a ternary whose consequent indexes an object literal', () => {
            // 'c ? {}[k] : alt' - the bracket indexes an object literal
            // and the ':' belongs to the ternary.
            const sources = [
                '(0?{}[e]: [2,2[null]]);',
                '(e?{}[\"\"] : 2).v;',
                '(l?{}[k] : o(0)[false << -1]) / [false | -1,\"\"];',
            ];
            for (const source of sources) expect(erased(source), source).to.equal(source);
        });

        it('keeps keyword-named variables used as expressions', () => {
            for (const word of ['readonly', 'private', 'static', 'public', 'declare', 'abstract', 'override']) {
                const indexed = 'class C { e = ' + word + '[0]; }';
                expect(erased(indexed), indexed).to.equal(indexed);
            }
        });

        it('still lowers a real computed class member', () => {
            expect(erased('class C { [k]: number = 1; }')).to.include('[k] = 1;');
            expect(erased('class C { m() {} [k]: number; }')).to.include('m() {}');
            expect(erased('class A { [k: string]: number; }')).to.equal('class A { }');
        });

        it('keeps a keyword-named function that is called', () => {
            const source = 'function interface() { return 1; } return interface();';
            expect(erased(source)).to.equal(source);
        });


        it('keeps a modifier-named variable as an instanceof operand', () => {
            for (const word of ['readonly', 'abstract', 'private', 'static', 'public', 'declare', 'override']) {
                const source = 'var ' + word + ' = 1; var x = (' + word + ' instanceof Object);';
                expect(erased(source), source).to.equal(source);
            }
        });

        it('keeps a label after a property access that looks like a modifier', () => {
            // 'a.abstract' is a property access, so the following 'M:' is a label.
            const source = 'var a = { abstract: 1 };\na.abstract\nM: c.d;';
            expect(erased(source)).to.equal(source);
        });

        it('still lowers a parameter property with a modifier chain', () => {
            expect(erased('class C { constructor(private readonly name: string) { } }'))
                .to.include('constructor( name)');
            expect(erased('class C { constructor(private readonly name: string) { } }'))
                .to.include('this.name = name;');
        });
        it('treats a line break before as as ending the expression statement', () => {
            // TypeScript uses scanner.hasPrecedingLineBreak() here; without it
            // plain JavaScript of this shape was silently rewritten.
            const brace = 'var x = {};\nas[0]; return 1;';
            expect(erased(brace)).to.equal(brace);
            const literal = '1\nas[0];';
            expect(erased(literal)).to.equal(literal);
            // On one line the word is still an assertion.
            expect(erased('const x = v as number;')).to.include('const x = v;');
        });
    });

    describe('Sixth adversarial pass: line terminators, implements, abstract, ternaries', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);

        it('counts every ECMAScript line terminator as a line break', () => {
            // LF, CR, U+2028 and U+2029 all force ASI; only LF was counted, so the
            // as/satisfies guard was blind to the other three.
            for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
                const source = 'var x = {}' + terminator + 'as[0]; return 1;';
                expect(erased(source), JSON.stringify(terminator)).to.equal(source);
            }
            expect(erased('var b = 1\r!b; return 1;')).to.equal('var b = 1\r!b; return 1;');
        });

        it('erases implements only in a class heritage clause', () => {
            // The word is a legal sloppy-mode identifier; erasing it in a for-head
            // silently truncated the program.
            for (const source of [
                'for (var implements in { a: 1 }) { } return 1;',
                'for (implements in { a: 1 }) { } return 1;',
                'var implements = 1; var x = implements in { a: 1 }; return 1;',
            ]) {
                expect(erased(source), source).to.equal(source);
            }
            expect(erased('class C implements I { }')).to.include('class C { }');
        });

        it('keeps abstract used as an ordinary variable', () => {
            // The member scan used to delete the whole statement, which was a
            // SILENT wrong answer rather than a syntax error.
            expect(erased('var abstract = 1; abstract++; return abstract;')).to.equal('var abstract = 1; abstract++; return abstract;');
            expect(erased('var abstract = { n: 0 }; abstract.n = 42; return abstract.n;'))
                .to.equal('var abstract = { n: 0 }; abstract.n = 42; return abstract.n;');
            // A real abstract member is still removed.
            expect(erased('abstract class B { abstract m(): void; }')).to.include('class B { }');
        });

        it('keeps a ternary whose alternative is a class expression', () => {
            const source = 'var v = 1; var r = v ? (1) : class {}; return 1;';
            expect(erased(source)).to.equal(source);
            expect(erased('var r = v ? f(1) : class {};')).to.equal('var r = v ? f(1) : class {};');
        });

        it('keeps a relational comparison that looks like type arguments', () => {
            const source = 'var a = 1, b = 2, c = 3, d = 4, e = 5; return (a < (b + c) > (d, e));';
            expect(erased(source)).to.equal(source);
        });

        it('keeps a bare identifier in a class heritage clause', () => {
            // 'class D extends as {}' names the base class through a variable
            // that happens to be called as; erasing it left `class D extends`.
            for (const source of [
                'var as = Object; class D extends as {} return 1;',
                'class D extends as {} return 1;',
                'var satisfies = Object; class D extends satisfies {} return 1;',
                'var as = Object; var C = class extends as {}; return 1;',
            ]) {
                expect(erased(source), source).to.equal(source);
            }
            expect(erased('class D extends Object {}')).to.equal('class D extends Object {}');
        });

        it('counts a comment line break as a line break before an assertion', () => {
            // hasPrecedingLineBreak must look at the SOURCE between the tokens, not
            // compare token line numbers, so a multiline template or block comment
            // cannot hide the break.
            const blockComment = 'var x = 1 /*' + '\n' + '*/ as number;';
            expect(erased(blockComment)).to.equal(blockComment);
        });
    });

    describe('Seventh adversarial pass: TypeScript-only shapes', () => {
        const erased = (code: string): string => stripTypeScriptTypes(code);
        const run = async (code: string): Promise<unknown> => {
            const out = erased(code);
            const fn = new Function('tools', 'return (async () => {' + out + '\n})()') as () => Promise<unknown>;
            return await fn();
        };

        it('walks a full modifier chain in a parameter property', async () => {
            // The scan only knew the four parameter-property modifiers, so
            // 'public override x' emitted 'this.override = override'.
            expect(erased('class C extends B { constructor(public override x: number) { super(x); } }'))
                .to.include('this.x = x;');
            const program = "class C { constructor(private readonly name: string) { } } return new C('q').name;";
            expect(await run(program)).to.equal('q');
        });

        it('erases an implements clause whose type name is a keyword', () => {
            expect(erased('class D implements readonly {}')).to.equal('class D {}');
            expect(erased('class D implements keyof {}')).to.equal('class D {}');
            expect(erased('class D implements Q, readonly {}')).to.equal('class D {}');
        });

        it('erases an assertion whose type is parenthesized', () => {
            expect(erased('var v = 1; var r = v as (number)[];')).to.include('var r = v;');
            expect(erased('const v = 1; const r = v satisfies (number);')).to.include('const r = v;');
            // A call to an identifier named as must survive.
            expect(erased('function as(x) { return x; } return as(1);'))
                .to.include('return as(1);');
        });

        it('resolves an exported sibling across merged namespace blocks', async () => {
            const program = 'namespace N { export const x = 1; } namespace N { export function f() { return x + 1; } } return N.f();';
            expect(erased(program)).to.include('return N.x + 1;');
            expect(await run(program)).to.equal(2);
        });
    });
});
