/**
 * Programmable run_code transport.
 *
 * Model-authored JavaScript executes inside a QuickJS/WASM guest with no Node,
 * VS Code, filesystem, network, timer, module, or host-object authority. The
 * only host capability is a bounded tools.call(name, args) bridge. Every
 * bridged call is checked against the current model-visible snapshot and then
 * re-enters the ordinary runner policy/scheduler/write-queue pipeline.
 */

import { getQuickJS } from 'quickjs-emscripten';
import type { ToolDefinition } from '../types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const RUN_CODE_MAX_SOURCE_CHARS = 64_000;
export const RUN_CODE_MAX_CALLS = 64;
export const RUN_CODE_MAX_IN_FLIGHT = 4;
export const RUN_CODE_MAX_ARGS_CHARS = 32_000;
export const RUN_CODE_MAX_RESULT_CHARS = 64_000;
export const RUN_CODE_MAX_OUTPUT_CHARS = 32_000;
export const RUN_CODE_MAX_LOG_ENTRIES = 64;
/** Maximum uninterrupted guest CPU slice on the Extension Host thread. */
export const RUN_CODE_MAX_COMPUTE_SLICE_MS = 2_000;
export const RUN_CODE_QUIESCE_TIMEOUT_MS = 250;
export const RUN_CODE_MAX_JSON_DEPTH = 32;
export const RUN_CODE_MAX_JSON_KEYS = 10_000;
export const RUN_CODE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const RUN_CODE_STACK_LIMIT_BYTES = 512 * 1024;
export const RUN_CODE_FANOUT_TIMEOUT_MS = 300_000;

/** Turn-driven or streaming capabilities cannot safely execute inside one tool call. */
export const RUN_CODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
    'run_code',
    'ask_user_question',
    'select_tools',
    'run_skill',
    'dispatch_agents',
    'merge_results',
    'query_blackboard',
    'cancel_dispatch',
    'save_workflow',
    'manage_goal',
    'write_design_blueprint',
    'history',
    'web_open',
    'web_find',
    'manage_process',
    'convert_image_to_dds',
    'convert_audio',
    'deploy_mod_asset',
]);

export interface RunCodeCapability {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface RunCodeCapabilitySnapshot {
    tools: RunCodeCapability[];
    names: ReadonlySet<string>;
}

export interface RunCodeProgramRequest {
    code: string;
    description: string;
}

export interface RunCodeProgramResult {
    success: boolean;
    callsExecuted: number;
    logs: JsonValue[];
    value?: JsonValue;
    error?: string;
    aborted?: boolean;
    outputTruncated?: boolean;
}

export class ToolCallError extends Error {
    readonly name = 'ToolCallError';
    constructor(readonly toolName: string, message: string) {
        super(message);
    }
}

export type RunCodeProgramValidation =
    | { ok: true; request: RunCodeProgramRequest }
    | { ok: false; error: string };

export function validateRunCodeProgram(args: Record<string, unknown>): RunCodeProgramValidation {
    if (typeof args.code !== 'string' || args.code.trim().length === 0) {
        return { ok: false, error: 'run_code requires a non-empty code string.' };
    }
    if (args.code.length > RUN_CODE_MAX_SOURCE_CHARS) {
        return { ok: false, error: `run_code code exceeds the ${RUN_CODE_MAX_SOURCE_CHARS} character bound.` };
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        return { ok: false, error: 'run_code requires a concise description.' };
    }
    if (args.description.length > 240) {
        return { ok: false, error: 'run_code description must be 240 characters or fewer.' };
    }
    return { ok: true, request: { code: args.code, description: args.description.trim() } };
}

export function createRunCodeCapabilitySnapshot(tools: readonly ToolDefinition[]): RunCodeCapabilitySnapshot {
    const unique = new Map<string, RunCodeCapability>();
    for (const tool of tools) {
        const name = tool.function.name;
        if (!name || RUN_CODE_BLOCKED_TOOLS.has(name)) continue;
        unique.set(name, {
            name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        });
    }
    const capabilities = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
    return { tools: capabilities, names: new Set(capabilities.map(tool => tool.name)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toLosslessJson(value: unknown, label: string): JsonValue {
    let keyCount = 0;
    const seen = new Set<object>();
    const visit = (current: unknown, depth: number): JsonValue => {
        if (depth > RUN_CODE_MAX_JSON_DEPTH) throw new Error(`${label} exceeds the maximum JSON depth.`);
        if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number.`);
            return current;
        }
        if (typeof current !== 'object') throw new Error(`${label} must be lossless JSON (undefined, bigint, functions, and symbols are rejected).`);
        if (seen.has(current)) throw new Error(`${label} contains a cycle.`);
        seen.add(current);
        try {
            if (Array.isArray(current)) return current.map(item => visit(item, depth + 1));
            const proto = Object.getPrototypeOf(current);
            if (proto !== Object.prototype && proto !== null) throw new Error(`${label} contains an unsupported object prototype.`);
            const result = Object.create(null) as { [key: string]: JsonValue };
            for (const key of Object.keys(current)) {
                keyCount++;
                if (keyCount > RUN_CODE_MAX_JSON_KEYS) throw new Error(`${label} contains too many object keys.`);
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${label} contains an accessor property.`);
                Object.defineProperty(result, key, {
                    value: visit(descriptor.value, depth + 1),
                    enumerable: true,
                    configurable: false,
                    writable: false,
                });
            }
            return result;
        } finally {
            seen.delete(current);
        }
    };
    return visit(value, 0);
}

function serializedLength(value: JsonValue): number {
    return JSON.stringify(value).length;
}

function truncateOutput(value: JsonValue, maxChars = RUN_CODE_MAX_OUTPUT_CHARS): { value: JsonValue; truncated: boolean } {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return { value, truncated: false };
    return {
        value: `${serialized.slice(0, maxChars)}\n...[run_code output truncated ${serialized.length - maxChars} chars]`,
        truncated: true,
    };
}

function safeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 2_000);
}

function jsonSchemaToType(schema: unknown, depth = 0): string {
    if (depth > 12 || !isRecord(schema)) return 'JsonValue';
    if (Array.isArray(schema.oneOf)) {
        const variants = schema.oneOf.map(item => jsonSchemaToType(item, depth + 1));
        return variants.length > 0 ? variants.join(' | ') : 'JsonValue';
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map(item => JSON.stringify(item)).join(' | ');
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const')) return JSON.stringify(schema.const);
    const type = schema.type;
    if (type === 'string') return 'string';
    if (type === 'number' || type === 'integer') return 'number';
    if (type === 'boolean') return 'boolean';
    if (type === 'null') return 'null';
    if (type === 'array') return `${jsonSchemaToType(schema.items, depth + 1)}[]`;
    if (type === 'object' || isRecord(schema.properties)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = new Set(Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : []);
        const fields = Object.keys(properties).sort().map(key => {
            const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
            return `  ${safeKey}${required.has(key) ? '' : '?'}: ${jsonSchemaToType(properties[key], depth + 1)};`;
        });
        if (schema.additionalProperties !== false) fields.push('  [key: string]: JsonValue | undefined;');
        return `{\n${fields.join('\n')}\n}`;
    }
    return 'JsonValue';
}


const RUN_CODE_OUTPUT_TYPE_HINTS: Readonly<Record<string, string>> = {
    query_scope: '{ currentScope: string; root: string; thisScope: string; prevChain: string[]; fromChain: string[]; scopeInference?: { kind: string; candidates: string[]; resolvedScope: string; certainty: "exact" | "union" | "unresolved"; evidence: string[] }; eventTarget?: JsonValue }',
    query_rules: '{ rules: JsonValue[]; totalCount: number; truncated: boolean; warnings?: string[] }',
    query_cwt_schema: '{ status: "ready" | "not_found"; matches: JsonValue[]; entities?: JsonValue[]; warnings?: string[] }',
    parse_pdx_fragment: '{ ok: boolean; valid: boolean; fragments: number; errors: { line: number; col: number; message: string }[] }',
    query_types: '{ typeName: string; instances: { id: string; file: string; subtypes?: string[] }[]; totalCount: number }',
    verify_pdx_identifier: '{ status: "found" | "ambiguous" | "not_found" | "inconclusive"; confidence: "high" | "medium" | "low"; canTreatAsMissing: boolean; matches: JsonValue[]; evidence: JsonValue[]; nextSteps: string[] }',
    get_diagnostics: '{ diagnostics: JsonValue[]; freshness?: string; pending?: boolean; truncated?: boolean; totalCount?: number }',
    read_file: '{ content: string; file?: string; totalLines?: number; truncated?: boolean }',
    grep: '{ matches: JsonValue[]; totalMatches?: number; truncated?: boolean }',
};

function buildRunCodeDeclarations(tools: readonly ToolDefinition[]): { args: string; methods: string } {
    const snapshot = createRunCodeCapabilitySnapshot(tools);
    return {
        args: snapshot.tools.map(tool => `  ${JSON.stringify(tool.name)}: ${jsonSchemaToType(tool.parameters)};`).join('\n'),
        methods: snapshot.tools.map(tool => {
            const outputType = RUN_CODE_OUTPUT_TYPE_HINTS[tool.name] ?? 'JsonValue';
            return `  ${JSON.stringify(tool.name)}: (args: ToolArgsMap[${JSON.stringify(tool.name)}]) => Promise<${outputType}>;`;
        }).join('\n'),
    };
}

export function buildRunCodeSdk(tools: readonly ToolDefinition[]): string {
    const { args, methods } = buildRunCodeDeclarations(tools);
    return [
        'run_code executes a JavaScript async-function body inside an isolated QuickJS/WASM guest.',
        'Only explicit console.log values and the outer return value reach model context; intermediate tool values stay inside the guest.',
        'Every tools.<name>(args) call re-enters the normal CWTools policy, permission, scheduler, and write queue. Catch ToolCallError for fallback behavior.',
        'The code field is strict JavaScript, not TypeScript: do not use type annotations, interfaces, enums, namespaces, imports, require, eval, or Function. No Node/VS Code APIs, filesystem/network globals, or host timers are available. Use only the catalog below.',
        'Independent calls may use Promise.all; host concurrency limits remain authoritative. Writes and exclusive operations remain serialized by the host.',
        '',
        'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };',
        'interface ToolArgsMap {',
        args,
        '}',
        'declare class ToolCallError extends Error { readonly name: "ToolCallError"; readonly toolName: keyof ToolArgsMap; }',
        'declare const tools: {',
        methods,
        '};',
    ].join('\n');
}

export function buildRunCodePromptBlock(tools: readonly ToolDefinition[]): string {
    const sdk = buildRunCodeSdk(tools);
    if (!sdk.includes('interface ToolArgsMap {\n  ')) return '';
    return `<system-reminder>\n# CWTools run_code Code Mode SDK\n\n\`\`\`typescript\n${sdk}\n\`\`\`\n</system-reminder>`;
}

export function buildRunCodePromptAdditions(tools: readonly ToolDefinition[]): string {
    const { args, methods } = buildRunCodeDeclarations(tools);
    if (!args || !methods) return '';
    return `<system-reminder>\n# CWTools run_code SDK additions\n\nThe following methods were dynamically disclosed and are now available in addition to the existing run_code catalog.\n\n\`\`\`typescript\ninterface ToolArgsMap {\n${args}\n}\ndeclare const tools: {\n${methods}\n};\n\`\`\`\n</system-reminder>`;
}

function makeGuestSource(code: string, toolNames: readonly string[]): string {
    return `
'use strict';
const __toolNames = ${JSON.stringify(toolNames)};
class ToolCallError extends Error {
  constructor(toolName, message) { super(message); this.name = 'ToolCallError'; this.toolName = toolName; }
}
const tools = Object.freeze(Object.fromEntries(__toolNames.map(name => [name, async args => {
  const response = await __cwtools_call(JSON.stringify({ tool: name, args: args === undefined ? {} : args }));
  const parsed = JSON.parse(response);
  if (!parsed.ok) throw new ToolCallError(name, parsed.error || 'Tool call failed.');
  return parsed.value;
}])));
const console = Object.freeze({ log: (...values) => __cwtools_log(JSON.stringify(values)) });
(async () => {
${code}
})()
`;
}

export async function executeRunCodeProgram(
    request: RunCodeProgramRequest,
    snapshot: RunCodeCapabilitySnapshot,
    runTool: (tool: string, args: Record<string, unknown>, signal: AbortSignal, waitTimeoutMs: number) => Promise<unknown>,
    signal: AbortSignal,
    deadline = Date.now() + RUN_CODE_FANOUT_TIMEOUT_MS,
): Promise<RunCodeProgramResult> {
    const quickJs = await getQuickJS();
    const runtime = quickJs.newRuntime();
    let deadlineInterrupted = false;
    let computeInterrupted = false;
    let computeDeadline = Math.min(deadline, Date.now() + RUN_CODE_MAX_COMPUTE_SLICE_MS);
    const resetComputeSlice = (): void => {
        computeDeadline = Math.min(deadline, Date.now() + RUN_CODE_MAX_COMPUTE_SLICE_MS);
    };
    runtime.setMemoryLimit(RUN_CODE_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(RUN_CODE_STACK_LIMIT_BYTES);
    runtime.setInterruptHandler(() => {
        if (signal.aborted) return true;
        const now = Date.now();
        if (now >= deadline) {
            deadlineInterrupted = true;
            return true;
        }
        if (now >= computeDeadline) {
            computeInterrupted = true;
            return true;
        }
        return false;
    });
    const context = runtime.newContext();
    const logs: JsonValue[] = [];
    const pendingGuestPromises = new Set<{ alive: boolean; dispose(): void }>();
    const hostSettlements = new Set<Promise<void>>();
    let callsExecuted = 0;
    let activeCalls = 0;
    let disposing = false;
    let mainPromiseHandle: { alive: boolean; dispose(): void } | undefined;
    interface SlotWaiter { resolve(): void; reject(error: Error): void; onAbort(): void }
    const waiters: SlotWaiter[] = [];
    const acquireCallSlot = async (): Promise<void> => {
        signal.throwIfAborted();
        if (activeCalls < RUN_CODE_MAX_IN_FLIGHT) { activeCalls++; return; }
        await new Promise<void>((resolve, reject) => {
            const waiter: SlotWaiter = {
                resolve: () => {
                    signal.removeEventListener('abort', waiter.onAbort);
                    resolve();
                },
                reject,
                onAbort: () => {
                    const index = waiters.indexOf(waiter);
                    if (index >= 0) waiters.splice(index, 1);
                    const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'run_code aborted.');
                    error.name = 'AbortError';
                    reject(error);
                },
            };
            waiters.push(waiter);
            signal.addEventListener('abort', waiter.onAbort, { once: true });
        });
        signal.throwIfAborted();
        activeCalls++;
    };
    const releaseCallSlot = (): void => {
        activeCalls = Math.max(0, activeCalls - 1);
        waiters.shift()?.resolve();
    };
    try {
        const callHandle = context.newFunction('__cwtools_call', requestHandle => {
            const deferred = context.newPromise();
            pendingGuestPromises.add(deferred);
            deferred.settled.finally(() => pendingGuestPromises.delete(deferred)).catch(() => undefined);
            const settle = async (): Promise<void> => {
                let response: JsonValue;
                try {
                    signal.throwIfAborted();
                    const requestText = context.getString(requestHandle);
                    if (requestText.length > RUN_CODE_MAX_ARGS_CHARS) throw new Error('Tool call arguments exceed the size bound.');
                    const parsed = JSON.parse(requestText) as unknown;
                    if (!isRecord(parsed) || typeof parsed.tool !== 'string') throw new Error('Malformed tool call request.');
                    if (!snapshot.names.has(parsed.tool)) {
                        throw new Error(`Tool '${parsed.tool}' is not available in the current run_code capability surface.`);
                    }
                    const argsValue = parsed.args === undefined ? {} : toLosslessJson(parsed.args, 'Tool arguments');
                    if (!isRecord(argsValue)) throw new Error('Tool arguments must be an object.');
                    if (serializedLength(argsValue) > RUN_CODE_MAX_ARGS_CHARS) throw new Error('Tool call arguments exceed the size bound.');
                    if (callsExecuted >= RUN_CODE_MAX_CALLS) throw new Error(`run_code supports at most ${RUN_CODE_MAX_CALLS} tool calls.`);
                    callsExecuted++;
                    await acquireCallSlot();
                    try {
                        signal.throwIfAborted();
                        const raw = await runTool(parsed.tool, argsValue, signal, Math.max(1, deadline - Date.now()));
                        const value = toLosslessJson(raw, `Result from ${parsed.tool}`);
                        if (serializedLength(value) > RUN_CODE_MAX_RESULT_CHARS) throw new Error(`Result from '${parsed.tool}' exceeds the guest transfer bound; narrow the tool query.`);
                        if (!runCodeToolSucceeded(value)) {
                            response = { ok: false, error: summarizeToolFailure(parsed.tool, value) };
                        } else {
                            response = { ok: true, value };
                        }
                    } finally {
                        releaseCallSlot();
                    }
                } catch (error) {
                    response = { ok: false, error: safeErrorMessage(error) };
                }
                if (!disposing && deferred.alive) {
                    deferred.resolve(context.newString(JSON.stringify(response)));
                    deferred.settled.then(() => {
                        if (!disposing) {
                            resetComputeSlice();
                            runtime.executePendingJobs();
                        }
                    }).catch(() => undefined);
                }
            };
            const settlement = settle();
            hostSettlements.add(settlement);
            settlement.finally(() => {
                hostSettlements.delete(settlement);
                if (disposing && deferred.alive) deferred.dispose();
            }).catch(() => undefined);
            return deferred.handle;
        });
        context.setProp(context.global, '__cwtools_call', callHandle);
        callHandle.dispose();

        const logHandle = context.newFunction('__cwtools_log', valueHandle => {
            if (logs.length >= RUN_CODE_MAX_LOG_ENTRIES) return;
            try {
                const raw = JSON.parse(context.getString(valueHandle)) as unknown;
                const json = toLosslessJson(raw, 'console.log');
                const bounded = truncateOutput(json, Math.min(4_000, RUN_CODE_MAX_OUTPUT_CHARS));
                logs.push(bounded.value);
            } catch (error) {
                logs.push(`[console.log rejected: ${safeErrorMessage(error)}]`);
            }
        });
        context.setProp(context.global, '__cwtools_log', logHandle);
        logHandle.dispose();

        const evaluated = context.evalCode(makeGuestSource(request.code, [...snapshot.names].sort()), 'cwtools-run-code.js', { type: 'global' });
        if (evaluated.error) {
            const dumped = safeErrorMessage(context.dump(evaluated.error));
            evaluated.error.dispose();
            const message = deadlineInterrupted
                ? `run_code exceeded the ${RUN_CODE_FANOUT_TIMEOUT_MS / 1000}s wall-clock budget.`
                : computeInterrupted
                    ? `run_code exceeded the ${RUN_CODE_MAX_COMPUTE_SLICE_MS}ms uninterrupted compute budget.`
                    : dumped;
            return { success: false, callsExecuted, logs, error: message, aborted: signal.aborted || undefined };
        }
        const promiseHandle = evaluated.value;
        mainPromiseHandle = promiseHandle;
        const resolvedPromise = context.resolvePromise(promiseHandle);
        resetComputeSlice();
        runtime.executePendingJobs();
        const abortPromise = new Promise<never>((_, reject) => {
            const rejectOnAbort = () => {
                const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'run_code aborted.');
                error.name = 'AbortError';
                reject(error);
            };
            if (signal.aborted) rejectOnAbort();
            else signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
        const resolved = await Promise.race([resolvedPromise, abortPromise]);
        promiseHandle.dispose();
        mainPromiseHandle = undefined;
        if (resolved.error) {
            const dumped = context.dump(resolved.error);
            resolved.error.dispose();
            const message = deadlineInterrupted
                ? `run_code exceeded the ${RUN_CODE_FANOUT_TIMEOUT_MS / 1000}s budget.`
                : safeErrorMessage(dumped);
            return { success: false, callsExecuted, logs, error: message, aborted: signal.aborted || undefined };
        }
        const dumped = context.dump(resolved.value);
        resolved.value.dispose();
        const value = toLosslessJson(dumped, 'run_code return value');
        const boundedValue = truncateOutput(value);
        const boundedLogs = truncateOutput(logs);
        return {
            success: true,
            callsExecuted,
            logs: Array.isArray(boundedLogs.value) ? boundedLogs.value : [boundedLogs.value],
            value: boundedValue.value,
            outputTruncated: boundedValue.truncated || boundedLogs.truncated || undefined,
        };
    } catch (error) {
        const message = deadlineInterrupted
            ? `run_code exceeded the ${RUN_CODE_FANOUT_TIMEOUT_MS / 1000}s wall-clock budget.`
            : computeInterrupted
                ? `run_code exceeded the ${RUN_CODE_MAX_COMPUTE_SLICE_MS}ms uninterrupted compute budget.`
                : safeErrorMessage(error);
        return { success: false, callsExecuted, logs, error: message, aborted: signal.aborted || undefined };
    } finally {
        disposing = true;
        for (const waiter of waiters.splice(0)) waiter.onAbort();
        // AgentToolExecutor races every nested call against this signal, so
        // started bridge operations settle promptly even when an underlying
        // implementation is still unwinding. Quiesce the bridge before the
        // guest handles disappear; late results are discarded by disposing.
        if (hostSettlements.size > 0) {
            await Promise.race([
                Promise.allSettled([...hostSettlements]),
                new Promise<void>(resolve => setTimeout(resolve, RUN_CODE_QUIESCE_TIMEOUT_MS)),
            ]);
        }
        for (const deferred of pendingGuestPromises) deferred.dispose();
        pendingGuestPromises.clear();
        if (mainPromiseHandle?.alive) mainPromiseHandle.dispose();
        mainPromiseHandle = undefined;
        context.dispose();
        runtime.dispose();
    }
}

function runCodeToolSucceeded(result: JsonValue): boolean {
    if (!isRecord(result)) return true;
    if (result.success === false || result.ok === false) return false;
    return result.status !== 'error' && result.status !== 'unavailable';
}

function summarizeToolFailure(tool: string, value: JsonValue): string {
    if (!isRecord(value)) return `Tool '${tool}' failed.`;
    for (const key of ['error', 'message', 'reason']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].slice(0, 2_000);
    }
    return `Tool '${tool}' reported failure.`;
}
