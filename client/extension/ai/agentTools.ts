/**
 * Eddy CWTool Code Module - Agent Tools (Orchestrator)
 *
 * This file is the public API surface. It re-exports TOOL_DEFINITIONS and
 * the AgentToolExecutor class. Internally, tool implementations are split
 * across domain-specific modules under ./tools/.
 *
 * Consumers (agentRunner.ts, index.ts) import from this file - no change needed.
 */

import * as vs from 'vscode';
import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LanguageClient } from 'vscode-languageclient/node';
import type {
    AnalyzeDiagnosticErrorResult,
    DiagnosticAnalysisCategory,
    DiagnosticEntry,
    GetDiagnosticsResult,
    TodoItem,
    PdxSemanticCatalog,
} from './types';

// Re-export the canonical tool definitions (unchanged public API)
export { TOOL_DEFINITIONS } from './tools/definitions';
import { DESIGN_BLUEPRINT_DETAILED_PARAMETERS } from './tools/definitions';

// Import handler classes
import { FileToolHandler, findFiles } from './tools/fileTools';
import { LspToolHandler } from './tools/lspTools';
import { ExternalToolHandler } from './tools/externalTools';
import { MemoryToolHandler, blackboardDomainPrefix } from './tools/memoryTools';
import { searchAgentHistory } from './tools/historyTool';
import type { IndexService } from '../indexing/indexService';
import { validateToolAccess, evaluateMcpPermission } from './tools/permissions';
import { readProjectProfile, queryProjectProfile } from './projectProfile';
import { queryProjectKnowledge } from './projectKnowledge';
import { queryInterfaceKnowledge } from './interfaceKnowledge';
import { validateOffCanvasGuiPreservation } from '../guiSafety';
import { loadSkill } from './skills';
import { validateGitOpsForMode, validatePlanModeToolUse } from './planModeGuard';
import { saveProjectWorkflow } from './workflowRegistry';
import { budgetToolResult, TOOL_RESULT_BUDGET_HARD_STUB } from './contextBudget';
import { aiText, EVIDENCE_GATE_MSG } from './messages';
import { getPrivateAiStorageRoot, getPrivateTopicStorageDirCandidates } from './workspacePaths';
import { isPathInsideOrEqual } from '../pathScope';
import { TOOL_REGISTRY, WRITE_TOOLS } from './tools/registry';
import { runAgentHooks } from './runner/hookRunner';
import { getAgentToolTargetFiles } from './runner/toolScheduler';
import { buildProfile, resolvePolicy, subjectForEffect, type PolicyPresetId, type PolicyRule } from './runner/policyEngine';
import { preflightCommand, type ConfiguredCommandPolicyRule } from './runner/commandPreflight';
import { sessionFileWriteMode, sessionPolicyPreset } from './runner/sessionPermissions';
import type { ApiKeyManager } from './aiService';
import { normalizeLegacyWebToolCall, type WebSearchProvider } from './tools/webAccess';
import { EvidenceGate, type EvidenceCallRecord } from './evidence/evidenceGate';
import { normalizeEvidenceGateMode, type EvidenceGateDecision, type EvidenceGateMode, type EvidenceGatePhase } from './evidence/evidenceTypes';
import { isPdxScriptTarget } from './evidence/claimExtractor';
import { runLedger } from './runner/runLedger';
import { ErrorReporter } from './errorReporter';
import { mergeTokenUsageTotals } from './cacheCapability';
import { MemoryParser } from './memoryParser';
import { defaultDomainForMode } from './agentProfile';
import { isMcpServerAllowedForDomain } from './mcpCapability';
import {
    authorizationAllowsEffect,
    evaluateDispatchAdmission,
    transitionSchedulingState,
} from './runner/scheduling';
import { goalStore, type DurableGoalStatus } from './runner/goalStore';
import { goalSupervisor } from './runner/goalSupervisor';
import { agentTaskManager } from './runner/taskManager';
import { deriveUserExecutionPolicy } from './orchestrator/userExecutionPolicy';

const MAX_TOOL_RESULT_CHARS = TOOL_RESULT_BUDGET_HARD_STUB;
const FINAL_EVIDENCE_CONCURRENCY = 4;

const AUTHORITATIVE_MEMORY_EVIDENCE_TOOLS = new Set<string>([
    'read_file',
    'get_file_context',
    'query_rules',
    'query_cwt_schema',
    'query_project_profile',
    'query_project_knowledge',
    'query_scope',
    'query_types',
    'query_definition_by_name',
    'query_references',
    'verify_pdx_identifier',
    'workspace_symbols',
    'document_symbols',
    'explore_pdx_project',
    'query_inline_instantiation',
    'analyze_pdx_flow',
    'compare_definition_with_vanilla',
    'search_mod_files',
]);

function abortSignalError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error(signal.reason ? String(signal.reason) : 'Operation cancelled.');
    error.name = 'AbortError';
    return error;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortSignalError(signal);
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(abortSignalError(signal));
        signal.addEventListener('abort', listener, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (listener) signal.removeEventListener('abort', listener);
    }
}

export type PostWriteValidationVerdict = 'allow' | 'pending' | 'repair';

export interface PostWriteValidationClassification {
    verdict: PostWriteValidationVerdict;
    evidencePassed: boolean;
    diagnosticsPassed: boolean;
    diagnosticErrorCount?: number;
    diagnosticsFreshness?: 'fresh' | 'pending' | 'stale';
}

export interface FinalPdxEvidenceValidation {
    passed: boolean;
    filesChecked: string[];
    conflictFiles: string[];
    pendingFiles: string[];
    /** Pending only because bounded extraction needs a full-file fresh diagnostic pass. */
    coveragePendingFiles: string[];
    report: string;
}

/** Classify a completed PDX write without treating "not disproved" as verified. */
export function classifyPostWriteValidation(
    decision: EvidenceGateDecision | undefined,
    result: Record<string, unknown>,
    evidenceUnavailable = false,
): PostWriteValidationClassification {
    const diagnosticErrors = Array.isArray(result.diagnostics)
        ? result.diagnostics.filter(item => {
            if (!item || typeof item !== 'object') return false;
            const severity = (item as Record<string, unknown>).severity;
            return severity === 'error' || severity === 0;
        })
        : undefined;
    const freshness = result.freshness === 'fresh' || result.freshness === 'pending' || result.freshness === 'stale'
        ? result.freshness
        : undefined;
    const blockingClaims = decision?.claims.filter(claim => claim.blocking) ?? [];
    const hasConflict = blockingClaims.some(claim => claim.status === 'conflict');
    const evidencePassed = decision !== undefined
        && decision.degraded !== true
        && blockingClaims.every(claim => claim.status === 'verified');
    const diagnosticsPassed = diagnosticErrors !== undefined
        && diagnosticErrors.length === 0
        && freshness === 'fresh';
    const repair = hasConflict || (diagnosticErrors?.length ?? 0) > 0;
    const pending = evidenceUnavailable || !evidencePassed || !diagnosticsPassed;
    return {
        verdict: repair ? 'repair' : pending ? 'pending' : 'allow',
        evidencePassed,
        diagnosticsPassed,
        diagnosticErrorCount: diagnosticErrors?.length,
        diagnosticsFreshness: freshness,
    };
}

const TOOL_TIMEOUTS: Record<string, number> = {
    query_scope: 45_000,
    query_types: 45_000,
    query_localisation_index: 45_000,
    query_workspace_index: 45_000,
    explore_pdx_project: 45_000,
    query_inline_instantiation: 30_000,
    analyze_pdx_flow: 30_000,
    compare_definition_with_vanilla: 30_000,
    query_project_profile: 5_000,
    query_project_knowledge: 10_000,
    query_interface_knowledge: 5_000,
    history: 10_000,
    query_rules: 45_000,
    query_override_modes: 45_000,
    search_rule_capabilities: 45_000,
    explain_scope: 45_000,
    parse_pdx_fragment: 45_000,
    query_references: 45_000,
    get_lsp_status: 10_000,
    get_diagnostics: 45_000,
    get_file_context: 45_000,
    search_mod_files: 45_000,
    find_sprite_candidates: 45_000,
    find_sound_candidates: 45_000,
    get_completion_at: 45_000,
    document_symbols: 45_000,
    workspace_symbols: 45_000,
    verify_pdx_identifier: 45_000,
    get_pdx_block: 45_000,
    lsp_operation: 45_000,
    query_definition: 45_000,
    query_definition_by_name: 45_000,
    query_scripted_effects: 45_000,
    query_scripted_triggers: 45_000,
    query_enums: 45_000,
    get_entity_info: 45_000,
    query_static_modifiers: 45_000,
    query_variables: 45_000,
    query_shader_symbol: 45_000,
    query_shader_compile_unit: 45_000,
    query_shader_platform_variants: 45_000,
    query_shader_callers: 45_000,
    explain_shader_reachability: 45_000,
    validate_shader: 45_000,
    compare_shader_with_vanilla: 45_000,
    read_file: 30_000,
    write_file: 30_000,
    edit_file: 30_000,
    replace_lines: 30_000,
    list_directory: 30_000,
    glob_files: 30_000,
    grep: 30_000,
    web_search: 30_000,
    web_open: 20_000,
    web_find: 5_000,
    run_command: 0,
    convert_image_to_dds: 60_000,
    convert_audio: 60_000,
    deploy_mod_asset: 0,
    git_ops: 30_000,
    save_workflow: 30_000,
    todo_write: 5_000,
    run_skill: 30_000,
    // Child activity/idle guards and run budgets own orchestration lifetime.
    // A fixed tool timeout would kill healthy long-running child graphs.
    dispatch_agents: 0,
    merge_results: 30_000,
};


const WRITE_CONFIRMATION_TOOLS = new Set<string>([
    'write_file',
    'edit_file',
    'replace_lines',
    'ast_mutate',
    'write_localisation',
    'lsp_operation',
]);

const DEFAULT_TOOL_TIMEOUT = 30_000;
const LOCALISATION_YML_TOOL_GUARD = [
    'Localisation YML routing guard:',
    '- These targets are Paradox localisation .yml files. Use `write_localisation` only.',
    '- Do not use `write_file`, `edit_file`, or `replace_lines` on localisation YAML.',
    '- If the request describes a line/text replacement, convert it into exact localisation key upserts through `write_localisation`.',
].join('\n');

function isLocalisationYmlPath(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
    if (!normalized.endsWith('.yml')) return false;
    return /(?:^|\/)(localisation|localization)(?:\/|$)/.test(normalized);
}

function promptMentionsLocalisationYml(prompt: unknown): boolean {
    if (typeof prompt !== 'string') return false;
    const normalized = prompt.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('.yml') && /(localisation|localization)/.test(normalized);
}

function normalizeDispatchTaskForLocalisationYml<T extends {
    agentType: string;
    prompt: string;
    contextFiles?: string[];
    plannedFiles?: string[];
}>(task: T): T {
    const plannedFiles = Array.isArray(task.plannedFiles) ? task.plannedFiles : [];
    const contextFiles = Array.isArray(task.contextFiles) ? task.contextFiles : [];
    const localisationTargets = [...plannedFiles, ...contextFiles].filter(isLocalisationYmlPath);
    const hasLocalisationYml = localisationTargets.length > 0 || promptMentionsLocalisationYml(task.prompt);
    if (!hasLocalisationYml) return task;

    const hasOnlyLocalisationPlannedFiles = plannedFiles.length > 0 && plannedFiles.every(isLocalisationYmlPath);
    const nextTask = { ...task };
    if (hasOnlyLocalisationPlannedFiles && nextTask.agentType !== 'loc_writer') {
        nextTask.agentType = 'loc_writer';
    }

    if (!nextTask.prompt.includes('write_localisation')) {
        const targetLine = localisationTargets.length > 0
            ? `\nTargets: ${Array.from(new Set(localisationTargets)).map(file => `\`${file}\``).join(', ')}`
            : '';
        nextTask.prompt = `${nextTask.prompt.trim()}\n\n${LOCALISATION_YML_TOOL_GUARD}${targetLine}`;
    }
    return nextTask;
}

function stripInternalTruncationMarker(text: string): string {
    return text
        .replace(/\n?\s*\.{3}\s*\[truncated, full length:\s*\d+\]\s*$/i, '')
        .replace(/\s*\.{3}\(truncated, full length:\s*\d+\)\s*$/i, '')
        .trimEnd();
}

function trimIncompleteMarkdownTail(text: string): string {
    let next = text.trimEnd();
    while (/(^|\n)\s*(?:[-*+]\s*|\d+[.)]\s*)$/.test(next)) {
        next = next.replace(/(^|\n)\s*(?:[-*+]\s*|\d+[.)]\s*)$/, '').trimEnd();
    }
    return next;
}

function compactAgentOutputForReport(output: unknown, maxLength = 1600): string | undefined {
    const text = stripInternalTruncationMarker(String(output ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim());
    if (!text) return undefined;
    if (text.length <= maxLength) return text;
    if (maxLength < 80) {
        return `_Output omitted because the combined summary budget was exhausted. Original length: ${text.length} characters._`;
    }
    let preview = text.slice(0, maxLength).trimEnd();
    const paragraphBreak = preview.lastIndexOf('\n\n');
    const lineBreak = preview.lastIndexOf('\n');
    if (paragraphBreak > maxLength * 0.55) {
        preview = preview.slice(0, paragraphBreak).trimEnd();
    } else if (lineBreak > maxLength * 0.75) {
        preview = preview.slice(0, lineBreak).trimEnd();
    }
    preview = trimIncompleteMarkdownTail(preview);
    return `${preview}\n\n${aiText(
        `_Content was long and has been compacted automatically: showing the first ${preview.length} / ${text.length} characters._`,
        `_内容较长，已自动压缩：显示前 ${preview.length} / ${text.length} 字符。_`,
    )}`;
}

/**
 * Executes Agent tools by communicating with the CWTools Language Server
 * and directly reading workspace files.
 *
 * This is the orchestrator: it owns shared state and dispatches each tool
 * call to the appropriate domain handler (file, LSP, or external).
 */
export class AgentToolExecutor {
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: import('./types').TodoUpdateCallback;
    /** Callback when a file write needs user confirmation (confirm mode). */
    public onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /** Callback when a file is automatically written (auto mode). */
    public onAutoWritten?: (file: string, isNewFile: boolean) => void;
    /** Callback when a project workflow is saved. */
    public onWorkflowSaved?: () => void;
    /**
     * Callback fired BEFORE any file is written or created.
     * Used by the retract system to snapshot file state for later restoration.
     */
    public onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    /** Agent file write mode from config */
    public fileWriteMode: 'confirm' | 'auto' = 'confirm';

    /** Parent AgentRunner options (used for sub-agent dispatch to inherit provider/model/abort) */
    public parentRunnerOptions?: import('./agentRunner').AgentRunnerOptions;
    /** Parent AgentRunner instance (used for Orchestrator to spawn sub-agents) */
    public parentAgentRunner?: import('./agentRunner').AgentRunner;
    /** Parent token accumulator (used for sub-agent dispatch to merge costs) */
    public parentTokenAccumulator?: import('./types').TokenUsage;
    /** Permission request callback for run_command */
    public onPermissionRequest?: (
        id: string,
        tool: string,
        description: string,
        command?: string
    ) => Promise<boolean>;
    /** Step callback for real-time UI progress (subtask events) */
    public onStep?: (step: import('./types').AgentStep) => void;

    // - Domain handlers -
    private fileHandler: FileToolHandler;
    private lspHandler: LspToolHandler;
    private externalHandler: ExternalToolHandler;
    private memoryHandler: MemoryToolHandler;
    private readonly diagnosticAnalysisCounts = new Map<string, { count: number; lastSeen: number }>();
    private readonly activeSkillPolicies = new Map<string, { skillNames: string[]; allowedTools: Set<string> }>();
    private readonly impactEvidenceCalls = new Map<string, EvidenceCallRecord[]>();
    private readonly postWriteAffectedFiles = new Map<string, string[]>();
    private static readonly ACTIVE_SKILL_POLICY_LIMIT = 64;
    /** Lazily constructed semantic evidence gate (plan §4 P0). */
    private evidenceGate?: EvidenceGate;

    private readonly clientGetter: () => LanguageClient;
    public readonly workspaceRoot: string;
    public readonly globalStoragePath?: string;
    public readonly extensionPath?: string;
    public readonly indexService?: IndexService;
    private readonly apiKeyManager?: ApiKeyManager;

    constructor(
        clientOrGetter: LanguageClient | (() => LanguageClient),
        workspaceRoot: string,
        indexService?: IndexService,
        globalStoragePath?: string,
        extensionPath?: string,
        apiKeyManager?: ApiKeyManager,
    ) {
        this.workspaceRoot = workspaceRoot;
        this.globalStoragePath = globalStoragePath;
        this.extensionPath = extensionPath;
        this.indexService = indexService;
        this.apiKeyManager = apiKeyManager;
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;

        // Create domain handlers - each receives `this` as context so they
        // can read mutable properties (fileWriteMode, callbacks, etc.) at call time.
        this.fileHandler = new FileToolHandler(this);
        this.lspHandler = new LspToolHandler(this, this.clientGetter, findFiles);
        this.externalHandler = new ExternalToolHandler(this);
        this.memoryHandler = new MemoryToolHandler(this);

        // Initialize the enhanced blackboard (replacing the old sharedMemory)
         
        const { Blackboard } = require('./orchestrator/blackboard') as typeof import('./orchestrator/blackboard');
        this.blackboard = new Blackboard();

        // Listen for LSP server-ready notification
        vs.commands.executeCommand('setContext', 'cwtools.lspReady', false);
        const tryRegisterNotif = () => {
            try {
                const c = this.clientGetter();
                if (c) {
                    try {
                        c.onNotification('cwtools/serverReady', (_params: any) => {
                            vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                        });
                    } catch {
                        (c as any).onReady?.().then?.(() => {
                            c.onNotification('cwtools/serverReady', (_params: any) => {
                                vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                            });
                        });
                    }
                }
            } catch { /* ignore, clientGetter not ready yet */ }
        };
        tryRegisterNotif();
        setTimeout(tryRegisterNotif, 2000);
        setTimeout(tryRegisterNotif, 5000);
    }

    get client(): LanguageClient {
        return this.clientGetter();
    }

    async getWebSearchApiKey(provider: Exclude<WebSearchProvider, 'auto' | 'duckduckgo' | 'searxng'>): Promise<string | undefined> {
        const secretId = provider === 'openai' ? 'openai' : `web.${provider}`;
        const stored = await this.apiKeyManager?.getKey(secretId);
        const legacyName = provider === 'brave' ? 'braveSearchApiKey' : provider === 'exa' ? 'exaApiKey' : undefined;
        if (!legacyName) return stored;
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const legacy = cfg.get<string>(legacyName, '').trim();
        if (legacy) {
            if (!stored) await this.apiKeyManager?.setKey(secretId, legacy);
            for (const target of [vs.ConfigurationTarget.Global, vs.ConfigurationTarget.Workspace, vs.ConfigurationTarget.WorkspaceFolder]) {
                try { await cfg.update(legacyName, undefined, target); } catch { /* scope may not exist */ }
            }
        }
        return stored || legacy || undefined;
    }

    private async queryLocalisationIndex(args: import('./types').QueryLocalisationIndexArgs): Promise<import('./types').QueryLocalisationIndexResult> {
        return this.lspHandler.queryLocalisationIndex(args);
    }

    private async queryWorkspaceIndex(args: import('./types').QueryWorkspaceIndexArgs): Promise<import('./types').QueryWorkspaceIndexResult> {
        return this.lspHandler.queryWorkspaceIndex(args);
    }

    private async queryInterfaceKnowledgeWithProject(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        const guidance = queryInterfaceKnowledge(args);
        const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
        const identifier = /^[A-Za-z_][A-Za-z0-9_.:@-]*$/.test(rawQuery) ? rawQuery : undefined;
        try {
            const indexed = await this.queryWorkspaceIndex({
                name: identifier,
                source: 'gui',
                origin: 'both',
                includeReferences: true,
                includeAssetChain: true,
                limit: 100,
            });
            const projectEntries = indexed.entries.filter(entry => entry.origin !== 'vanilla');
            const vanillaEntries = indexed.entries.filter(entry => entry.origin === 'vanilla');
            return {
                ...guidance,
                projectGraph: {
                    available: indexed.status === 'ready' || indexed.status === 'partial',
                    status: indexed.status,
                    entries: projectEntries,
                    facts: {
                        guiElements: projectEntries.length,
                        references: projectEntries.reduce((count, entry) => count + (entry.references?.length ?? 0), 0),
                        offCanvasControls: projectEntries.filter(entry => entry.guiFacts?.offCanvas).map(entry => ({ name: entry.name, file: entry.file, line: entry.line, position: entry.guiFacts?.position })),
                        localisationKeys: Array.from(new Set(projectEntries.flatMap(entry => entry.guiFacts?.localisationKeys ?? []))).sort(),
                        customGuiReferences: Array.from(new Set(projectEntries.flatMap(entry => entry.guiFacts?.customGuiReferences ?? []))).sort(),
                        effectReferences: Array.from(new Set(projectEntries.flatMap(entry => entry.guiFacts?.effectReferences ?? []))).sort(),
                        spriteReferences: Array.from(new Set(projectEntries.flatMap(entry => entry.guiFacts?.spriteReferences ?? []))).sort(),
                        assetChains: indexed.assetChain ?? [],
                    },
                },
                vanillaContract: {
                    available: indexed.status === 'ready' || indexed.status === 'partial',
                    entries: vanillaEntries,
                },
                coverage: {
                    filesConsidered: indexed.coverage?.filesConsidered ?? new Set(indexed.entries.map(entry => entry.file)).size,
                    filesIndexed: indexed.coverage?.filesIndexed ?? new Set(indexed.entries.map(entry => entry.file)).size,
                    symbolsConsidered: indexed.coverage?.symbolsConsidered ?? indexed.indexedSymbolNames ?? indexed.totalCount,
                    symbolsIndexed: indexed.coverage?.symbolsIndexed ?? indexed.entries.length,
                    truncated: indexed.coverage?.truncated ?? indexed.entries.length >= 100,
                    staleReasons: indexed.coverage?.staleReasons ?? (indexed.status === 'ready' ? [] : [`index_${indexed.status}`]),
                    unsupportedConstructs: indexed.coverage?.unsupportedConstructs ?? [],
                },
            };
        } catch (error) {
            return {
                ...guidance,
                projectGraph: { available: false, error: error instanceof Error ? error.message : String(error) },
            };
        }
    }

    suspendLsp = (): void => {
        try { void this.client.sendNotification('cwtools/suspendIndexing'); } catch { /* ignore */ }
    }

    resumeLsp = (): void => {
        try { void this.client.sendNotification('cwtools/resumeIndexing'); } catch { /* ignore */ }
    }

    /** Enhanced Blackboard - Shared knowledge storage between multiple Agents. 
* Replaces the old sharedMemory Map and provides typed entries, CAS optimistic locking, and prefix subscriptions. 
* Compatibility layer legacySet/Get/Search ensures existing set_memory/get_memory/search_memory tools work seamlessly. */
    public blackboard!: import('./orchestrator/blackboard').Blackboard;

    invalidateCacheForFile(filePath: string): void {
        this.lspHandler.invalidateCacheForFile(filePath);
    }

    /** Host-only CWT semantic catalog used by the evidence and quality gates. */
    getPdxSemanticCatalog(targetFiles: readonly string[], ruleNames: readonly string[] = []): Promise<PdxSemanticCatalog> {
        return this.lspHandler.getPdxSemanticCatalog(targetFiles, ruleNames);
    }

    private extractResultWrittenFiles(result: unknown): string[] {
        if (!result || typeof result !== 'object') return [];
        const record = result as Record<string, unknown>;
        const rawValues = [
            record.writtenFiles,
            record.changedFiles,
            record.filesChanged,
            record.filesWritten,
        ];
        const files: string[] = [];
        const add = (value: unknown) => {
            if (typeof value === 'string' && value.trim()) {
                files.push(value.trim());
            } else if (Array.isArray(value)) {
                for (const item of value) add(item);
            }
        };
        for (const value of rawValues) add(value);
        return Array.from(new Set(files.map(file => {
            const isWinAbs = /^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('\\\\');
            const isPosixAbs = file.startsWith('/');
            return (isWinAbs || isPosixAbs) ? path.resolve(file) : path.resolve(this.workspaceRoot, file);
        })));
    }

    private isDiagnosticRelevantFile(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        return ['.txt', '.gui', '.yml', '.gfx', '.asset', '.cwt', '.entity', '.shader', '.fxh'].includes(ext);
    }

    private async requestRevalidateFiles(files: string[]): Promise<Record<string, unknown> | undefined> {
        const targets = Array.from(new Set(files.filter(file => this.isDiagnosticRelevantFile(file)))).slice(0, 200);
        if (targets.length === 0) return undefined;
        try {
            const client = this.client;
            if (!client || typeof (client as any).sendRequest !== 'function') {
                return { ok: false, requested: targets.length, error: 'LSP client unavailable' };
            }
            const request = client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.revalidateFiles',
                arguments: [targets.map(file => vs.Uri.file(file).toString())],
            }) as Promise<Record<string, unknown>>;
            const timeout = new Promise<Record<string, unknown>>(resolve => {
                setTimeout(() => resolve({
                    ok: false,
                    requested: targets.length,
                    error: 'Timed out requesting CWTools revalidation',
                }), 2000);
            });
            const response = await Promise.race([request, timeout]);
            return {
                ok: response?.ok === true,
                requested: targets.length,
                response,
            };
        } catch (error) {
            return {
                ok: false,
                requested: targets.length,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Reset per-file edit failure counters; called at the start of each agent run. */
    resetEditFailureTracking(): void {
        this.fileHandler.resetEditFailureTracking();
    }

    get vfsOverlay(): Map<string, string> | undefined {
        return this.parentRunnerOptions?.vfsOverlay;
    }

    /** Expose the external handler so AgentRunner can auto-complete todos on task finish. */
    getExternalToolHandler(): ExternalToolHandler {
        return this.externalHandler;
    }

    private async extractNetworkHosts(toolName: string, args: Record<string, unknown>): Promise<string[]> {
        const values: string[] = [];
        for (const [key, value] of Object.entries(args)) {
            if (typeof value !== 'string') continue;
            if (/url|endpoint|host/i.test(key) || key === 'command') values.push(value);
        }
        const hosts = new Set<string>();
        for (const value of values) {
            for (const match of value.matchAll(/https?:\/\/([^\s/'"`<>]+)/gi)) {
                try { hosts.add(new URL(`https://${match[1]}`).hostname.toLowerCase()); } catch { /* malformed URL stays unscoped */ }
            }
        }
        if (toolName === 'web_open' && typeof args.ref === 'string') {
            try { hosts.add(new URL(this.externalHandler.resolveWebReference(args.ref)).hostname.toLowerCase()); } catch { /* source may no longer be cached */ }
        }
        if (toolName === 'web_search') {
            const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web');
            const selected = cfg.get<WebSearchProvider>('provider', 'auto');
            const fallback = cfg.get<WebSearchProvider[]>('fallbackProviders', []);
            const candidates = selected === 'auto'
                ? [...fallback, 'brave', 'exa', 'tavily', 'serper', 'serpapi', 'searxng', 'duckduckgo'] as const
                : [selected, ...fallback];
            const providerHosts: Partial<Record<WebSearchProvider, string>> = {
                openai: 'api.openai.com',
                brave: 'api.search.brave.com',
                exa: 'api.exa.ai',
                tavily: 'api.tavily.com',
                serper: 'google.serper.dev',
                serpapi: 'serpapi.com',
                duckduckgo: 'html.duckduckgo.com',
            };
            for (const provider of Array.from(new Set(candidates))) {
                if (provider === 'auto') continue;
                if (provider === 'searxng') {
                    const endpoint = cfg.get<string>('searxngEndpoint', '').trim();
                    if (endpoint) try { hosts.add(new URL(endpoint).hostname.toLowerCase()); } catch { /* validated by the web client */ }
                    continue;
                }
                if (selected === 'auto' && provider !== 'duckduckgo') {
                    const key = await this.getWebSearchApiKey(provider);
                    if (!key) continue;
                }
                const host = providerHosts[provider];
                if (host) hosts.add(host);
            }
        }
        return [...hosts];
    }

    /** The single enforced policy boundary for every model-visible tool call. */
    private async enforcePolicy(
        toolName: string,
        args: Record<string, unknown>,
        mode: import('./types').AgentMode,
        context?: import('./types').AgentToolContext,
    ): Promise<{ allowed: boolean; error?: string }> {
        const entry = TOOL_REGISTRY.get(toolName as any)
            ?? (toolName.startsWith('mcp_') ? TOOL_REGISTRY.get('mcp_call') : undefined);
        if (!entry) return { allowed: false, error: `Unknown tool: ${toolName}` };
        const subject = subjectForEffect(entry.effect);
        if (!subject) return { allowed: true };

        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const sessionPreset = sessionPolicyPreset(this.workspaceRoot);
        const persistentFullAccess = vs.workspace.getConfiguration('stellarisLanguageServices.ai.developer')
            .get<boolean>('disableSecuritySandbox') === true;
        const preset = sessionPreset
            ?? (persistentFullAccess ? 'full-access' : cfg.get<PolicyPresetId>('policy.preset', 'workspace-auto'));
        const effectiveWriteMode = sessionFileWriteMode(this.workspaceRoot) ?? this.fileWriteMode;
        this.fileWriteMode = effectiveWriteMode;
        const profileRules: PolicyRule[] = [];
        if (subject === 'edit' && effectiveWriteMode === 'auto' && preset !== 'read-only') {
            profileRules.push({ id: 'effective-auto-write', subject: 'edit', pathGlob: '**', action: 'allow', riskMax: 2, scope: 'session' });
        }
        const profile = buildProfile(preset, this.workspaceRoot, profileRules);
        const targets = getAgentToolTargetFiles(toolName, args, this.workspaceRoot, context?.runnerOptions?.topicId);
        const command = typeof args.command === 'string' ? args.command : undefined;
        const commandRules = cfg.get<ConfiguredCommandPolicyRule[]>('shell.commandRules', []);
        const commandPreflight = command ? preflightCommand(command, commandRules) : undefined;
        const gitAction = toolName === 'git_ops' && typeof args.action === 'string' ? args.action : undefined;
        const riskLevel = commandPreflight
            ? (commandPreflight.decision === 'allow' ? 0 : commandPreflight.riskLevel)
            : (gitAction === 'status' || gitAction === 'diff' ? 0 : gitAction === 'checkout' ? 3 : entry.riskLevel);
        const mcpServer = typeof args.server === 'string' ? args.server : undefined;
        const mcpTool = typeof args.tool === 'string' ? args.tool : undefined;
        const networkHosts = await this.extractNetworkHosts(toolName, args);
        const decision = resolvePolicy({
            toolName,
            subject,
            riskLevel,
            workspaceRoot: this.workspaceRoot,
            command,
            cwd: typeof args.cwd === 'string' ? args.cwd : this.workspaceRoot,
            targetPaths: targets,
            networkHosts,
            mcpServer,
            mcpTool,
            taskRole: mode,
        }, profile);
        context?.runEventSink?.appendSoon('policy_resolved', {
            tool: toolName,
            subject,
            riskLevel,
            action: decision.action,
            matchedRules: decision.matchedRules,
            profileId: profile.id,
            shadow: false,
        });
        // Rich command/file/media/MCP handlers request approval with their full
        // domain-specific context. Other subjects use the shared card here.
        const selfManaged = entry.effect === 'shell' || entry.effect === 'workspace_write'
            || entry.effect === 'media' || entry.effect === 'mcp';
        if (decision.action === 'deny' && !decision.denial?.approvalPath) {
            return { allowed: false, error: decision.denial?.whyDenied ?? `Policy '${profile.id}' denied ${toolName}.` };
        }
        if (decision.action === 'allow') return { allowed: true };
        if (selfManaged) return { allowed: true };
        const requestPermission = context?.onPermissionRequest;
        if (!requestPermission) return { allowed: false, error: `Policy requires approval for ${toolName}, but no permission handler is available.` };
        const id = `policy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const allowed = await requestPermission(
            id,
            toolName,
            aiText(`AI requests permission to use ${toolName}`, `AI 请求使用 ${toolName}`),
            command,
            {
                ...context,
                preflight: {
                    riskLevel,
                    classification: [subject],
                    cwd: this.workspaceRoot,
                    reasons: [`Policy profile: ${profile.id}`],
                    networkAccess: subject === 'network',
                    networkHosts,
                    sandboxMode: profile.sandboxMode,
                    targetPaths: targets,
                    mcpServer,
                    mcpTool,
                },
            },
        );
        return allowed ? { allowed: true } : { allowed: false, error: `Permission denied for ${toolName}.` };
    }

    // - Semantic evidence gate (plan §4 P0) -

    private evidenceGateMode(): EvidenceGateMode {
        const raw = vs.workspace.getConfiguration('stellarisLanguageServices.ai.evidenceGate').get<string>('mode', 'enforce');
        return normalizeEvidenceGateMode(raw);
    }

    /** LSP executeCommand sender for the gate, with its own timeout guard. */
    private async evidenceLspRequest(command: string, cmdArgs: unknown[], timeoutMs = 3_000): Promise<unknown> {
        const client = this.clientGetter();
        if (!client) throw new Error('LSP client is not available.');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const promise = client.sendRequest('workspace/executeCommand', { command, arguments: cmdArgs });
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`LSP request "${command}" timed out after ${timeoutMs / 1000}s`)), timeoutMs);
            });
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** Candidate CWT rules roots for the gate's rules-revision fingerprint (mirrors LspToolHandler.resolveCwtConfigPaths). */
    private evidenceRulesRoots(game: string): string[] {
        const roots: string[] = [];
        const add = (candidate: string | undefined) => {
            if (!candidate?.trim()) return;
            const resolved = path.resolve(candidate);
            if (!roots.some(r => r.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
        };
        const addRoot = (candidate: string | undefined) => {
            add(candidate);
            if (candidate?.trim()) add(path.join(candidate, 'config'));
        };
        const cwtoolsConfig = vs.workspace.getConfiguration('stellarisLanguageServices');
        const rulesVersion = cwtoolsConfig.get<string>('rules_version', 'latest');
        const customRulesFolder = cwtoolsConfig.get<string>('rules_folder');
        if (rulesVersion === 'manual' && customRulesFolder) addRoot(customRulesFolder);
        addRoot(this.globalStoragePath ? path.join(this.globalStoragePath, '.cwtools', game) : undefined);
        addRoot(this.extensionPath ? path.join(this.extensionPath, '.cwtools', game) : undefined);
        if (game === 'stellaris') add(this.extensionPath ? path.join(this.extensionPath, 'config') : undefined);
        addRoot(path.join(this.workspaceRoot, '.cwtools', game));
        addRoot(path.join(this.workspaceRoot, 'release', 'rules', game));
        addRoot(path.join(this.workspaceRoot, 'submodules', `cwtools-${game}-config`));
        if (game === 'stellaris') add(path.join(this.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'));
        return roots;
    }

    private getEvidenceGate(): EvidenceGate {
        if (!this.evidenceGate) {
            const profileGame = readProjectProfile(this.workspaceRoot)?.game?.id;
            const gameProfile = profileGame && profileGame !== 'unknown' ? profileGame.toLowerCase() : 'stellaris';
            this.evidenceGate = new EvidenceGate({
                workspaceRoot: this.workspaceRoot,
                gameProfile,
                sendLspCommand: (command, cmdArgs, timeoutMs) => this.evidenceLspRequest(command, cmdArgs, timeoutMs),
                queryRules: async (category, name) => {
                    const result = await this.lspHandler.queryRules({ category, name });
                    return result.rules.map(rule => ({
                        name: rule.name,
                        scopes: Array.isArray(rule.scopes) ? rule.scopes.filter((s): s is string => typeof s === 'string') : [],
                        pushScope: rule.hardFacts?.pushScope,
                    }));
                },
                indexLookup: async (name) => {
                    const index = this.indexService;
                    if (!index) return undefined;
                    try {
                        const readiness = index.ensureWorkspaceSymbolsReady?.({ includeVanilla: true });
                        if (readiness !== undefined) {
                            await Promise.race([
                                readiness.catch(() => undefined),
                                new Promise<void>(resolve => setTimeout(resolve, 2_000)),
                            ]);
                        }
                        const entries = index.queryWorkspaceSymbols({ name, exact: true, limit: 3 });
                        if (entries.length === 0 && index.workspaceSymbolStatus !== 'ready') {
                            // A partial index can prove presence, but it cannot
                            // prove absence. Keep the reference pending until a
                            // complete index or the LSP can make that claim.
                            return undefined;
                        }
                        return {
                            found: entries.length > 0,
                            fileVersion: entries[0]?.fileVersion,
                            indexUpdatedAt: index.workspaceSymbolUpdatedAt,
                        };
                    } catch {
                        return undefined;
                    }
                },
                queryReferences: async (name) => {
                    const result = await this.lspHandler.queryReferences({ identifier: name });
                    return result.references.map(reference => ({
                        file: reference.file,
                        line: reference.line,
                        context: reference.context,
                    }));
                },
                querySemanticCatalog: (targetFiles, ruleNames) => this.getPdxSemanticCatalog(targetFiles, ruleNames),
                getIndexRevision: () => {
                    const index = this.indexService;
                    return index
                        ? `${index.workspaceSymbolUpdatedAt ?? 'unbuilt'}:${index.workspaceSymbolCount}:${index.workspaceSymbolStatus}`
                        : 'unavailable';
                },
                rulesRoots: this.evidenceRulesRoots(gameProfile),
            });
        }
        return this.evidenceGate;
    }

    /** Persist the full decision as a ledger artifact and append the summary run event. */
    private async recordEvidenceGateDecision(
        decision: EvidenceGateDecision,
        context?: import('./types').AgentToolContext,
    ): Promise<Record<string, unknown>> {
        const counts = { verified: 0, unknown: 0, conflict: 0, stale: 0 };
        for (const claim of decision.claims) counts[claim.status]++;
        const advisoryEvidence = decision.missingEvidence
            .filter(item => item.status === 'unknown' || item.status === 'stale')
            .slice(0, 5);
        const summary: Record<string, unknown> = {
            decisionId: decision.decisionId,
            verdict: decision.verdict,
            mode: decision.mode,
            phase: decision.phase,
            degraded: decision.degraded === true,
            counts,
            durationMs: decision.durationMs,
        };
        if (advisoryEvidence.length > 0) summary.advisoryEvidence = advisoryEvidence;
        const sink = context?.runEventSink;
        if (!sink) return summary;

        let artifactRef: string | undefined;
        try {
            // The full decision (claims + sources) goes to an artifact; the run
            // event only carries the aggregate summary, never the written text.
            const artifact = await runLedger.writeJsonArtifact(sink.runId, `evidence/${decision.decisionId}.json`, decision);
            artifactRef = artifact?.ref;
        } catch (error) {
            ErrorReporter.warn('AgentTools', `Failed to persist evidence gate artifact for ${decision.decisionId}`, error);
        }
        sink.appendSoon('evidence_gate_decision', {
            decisionId: decision.decisionId,
            tool: decision.tool,
            target: decision.target,
            mode: decision.mode,
            phase: decision.phase,
            verdict: decision.verdict,
            degraded: decision.degraded === true,
            fromCache: decision.fromCache === true,
            counts,
            blockingClaims: decision.claims
                .filter(c => c.blocking)
                .slice(0, 20)
                .map(c => ({ kind: c.kind, claim: c.claim.slice(0, 200), status: c.status })),
            missingEvidence: decision.missingEvidence.slice(0, 10),
            durationMs: decision.durationMs,
            artifactRef,
        });
        return summary;
    }

    private buildEvidenceGateBlockResult(decision: EvidenceGateDecision, prefixMessage: string | undefined): Record<string, unknown> {
        const targetRel = path.isAbsolute(decision.target)
            ? (path.relative(this.workspaceRoot, decision.target) || decision.target)
            : decision.target;
        const conflicts = decision.missingEvidence.filter(item => item.status === 'conflict' || item.status === 'unknown' || item.status === 'stale');
        const header = EVIDENCE_GATE_MSG.BLOCKED_HEADER(conflicts.length, targetRel);
        return {
            success: false,
            error: [prefixMessage, header, EVIDENCE_GATE_MSG.RETRY_HINT].filter(Boolean).join(' '),
            evidenceGateBlocked: true,
            evidenceGate: {
                decisionId: decision.decisionId,
                verdict: decision.verdict,
                mode: decision.mode,
                phase: decision.phase,
                degraded: decision.degraded === true,
                missingEvidence: conflicts,
                suggestedQueries: [...new Set(conflicts.flatMap(item => item.suggestedQueries))],
            },
        };
    }

    /**
     * Run the semantic evidence gate for a write tool call. Returns a result
     * summary to attach to the tool result, or an errorResult when enforce
     * mode blocks the write. Runs strictly after the policy engine, plan-mode
     * and trust checks — it adds a layer and never bypasses existing ones.
     */
    private async evaluateEvidenceGate(
        toolName: string,
        targetFile: string,
        text: string,
        previousText: string,
        context?: import('./types').AgentToolContext,
    ): Promise<{ summary?: Record<string, unknown>; errorResult?: Record<string, unknown> } | undefined> {
        const mode = this.evidenceGateMode();
        if (mode === 'off') return undefined;
        const resolvedTargetFile = path.isAbsolute(targetFile)
            ? targetFile
            : path.resolve(this.workspaceRoot, targetFile);
        let decision: EvidenceGateDecision;
        try {
            decision = await this.getEvidenceGate().evaluate({
                toolName,
                targetFile: resolvedTargetFile,
                text,
                previousText,
                mode,
                evidenceCalls: this.impactEvidenceCalls.get(this.getImpactEvidenceKey(context)),
            });
        } catch (error) {
            // Ordinary local repairs remain available during an LSP/index
            // outage, but high-impact semantic edits fail closed because their
            // indirect callers/winners/assets cannot be reconstructed safely.
            ErrorReporter.warn('AgentTools', `Evidence gate evaluation failed for ${toolName} on ${resolvedTargetFile}`, error);
            if (mode === 'enforce' && this.isHighRiskPdxWrite(toolName, resolvedTargetFile)) {
                const message = `High-risk ${toolName} was blocked because semantic impact evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`;
                return {
                    summary: {
                        verdict: 'block', mode, phase: 'pre_write', degraded: true,
                        evidenceUnavailable: true, warning: message,
                    },
                    errorResult: {
                        success: false,
                        error: message,
                        evidenceGateBlocked: true,
                        evidenceUnavailable: true,
                        suggestedQueries: ['Wait for the CWTools LSP/project index to become ready, then rerun the exact impact query.'],
                    },
                };
            }
            return {
                summary: {
                    verdict: 'allow',
                    mode,
                    phase: 'pre_write',
                    degraded: true,
                    evidenceUnavailable: true,
                    warning: `${EVIDENCE_GATE_MSG.UNAVAILABLE} (${error instanceof Error ? error.message : String(error)})`,
                },
            };
        }

        const summary = await this.recordEvidenceGateDecision(decision, context);
        if (mode === 'shadow' || decision.verdict === 'allow') {
            return { summary };
        }

        // Manual override (plan §3.6/§4.3): only the user can approve, via the
        // shared approval channel. Tool args are never consulted for an
        // override flag, so the model cannot self-authorize.
        const requestPermission = context?.onPermissionRequest;
        if (requestPermission) {
            const targetRel = path.relative(this.workspaceRoot, resolvedTargetFile) || resolvedTargetFile;
            const claimLines = decision.missingEvidence
                .filter(item => item.status === 'conflict' || item.status === 'unknown' || item.status === 'stale')
                .slice(0, 5)
                .map(m => EVIDENCE_GATE_MSG.CLAIM_LINE(m.kind, m.status, m.claim));
            try {
                const approved = await requestPermission(
                    `evidence_gate_${decision.decisionId}`,
                    toolName,
                    EVIDENCE_GATE_MSG.OVERRIDE_REQUEST(targetRel, claimLines.join('\n')),
                    undefined,
                    context,
                );
                if (approved) {
                    decision.verdict = 'override';
                    const overrideSummary = await this.recordEvidenceGateDecision(decision, context);
                    return { summary: overrideSummary };
                }
                return { summary, errorResult: this.buildEvidenceGateBlockResult(decision, EVIDENCE_GATE_MSG.OVERRIDE_DENIED) };
            } catch (error) {
                ErrorReporter.warn('AgentTools', `Evidence gate override approval failed for ${decision.decisionId}`, error);
            }
        }
        return { summary, errorResult: this.buildEvidenceGateBlockResult(decision, undefined) };
    }

    private async evaluatePostWriteEvidence(
        request: { toolName: string; filePath: string; content: string },
        context?: import('./types').AgentToolContext,
        phase: Extract<EvidenceGatePhase, 'post_write' | 'final'> = 'post_write',
    ): Promise<{ decision?: EvidenceGateDecision; summary: Record<string, unknown>; unavailable?: boolean } | undefined> {
        const mode = this.evidenceGateMode();
        if (mode === 'off') return undefined;
        try {
            await this.refreshImpactEvidenceAfterWrite(context);
            const decision = await this.getEvidenceGate().evaluate({
                toolName: request.toolName,
                targetFile: request.filePath,
                text: request.content,
                previousText: '',
                mode,
                phase,
                evidenceCalls: this.impactEvidenceCalls.get(this.getImpactEvidenceKey(context)),
            });
            const summary = await this.recordEvidenceGateDecision(decision, context);
            return { decision, summary };
        } catch (error) {
            ErrorReporter.warn('AgentTools', `Evidence verification (${phase}) failed for ${request.filePath}`, error);
            return {
                unavailable: true,
                summary: {
                    verdict: 'allow',
                    mode,
                    phase,
                    degraded: true,
                    evidenceUnavailable: true,
                    warning: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }

    /** Re-run the exact authoritative reads used by preflight so post-write
     * evidence is bound to the current model/database revision, not merely to
     * the fact that a tool with the right name ran earlier. */
    private extractIndirectEvidenceFiles(result: unknown): string[] {
        const files = new Set<string>();
        const visit = (value: unknown, key = '', depth = 0): void => {
            if (depth > 8 || files.size >= 200 || value === null || value === undefined) return;
            if (typeof value === 'string') {
                if (/^(?:file|sourceFile|callerFile|invocationFile|templateFile)$/i.test(key)
                    && this.isDiagnosticRelevantFile(value)) {
                    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.workspaceRoot, value);
                    const relative = path.relative(this.workspaceRoot, resolved);
                    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) files.add(resolved);
                }
                return;
            }
            if (Array.isArray(value)) {
                for (const item of value) visit(item, key, depth + 1);
                return;
            }
            if (typeof value === 'object') {
                for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey, depth + 1);
            }
        };
        visit(result);
        return [...files].sort((a, b) => a.localeCompare(b));
    }

    private async refreshImpactEvidenceAfterWrite(context?: import('./types').AgentToolContext): Promise<void> {
        const key = this.getImpactEvidenceKey(context);
        const existing = this.impactEvidenceCalls.get(key);
        if (!existing?.length) return;
        const refreshed: EvidenceCallRecord[] = [];
        const affectedFiles = new Set<string>();
        const abortSignal = context?.runnerOptions?.abortSignal;
        const deadline = Date.now() + 10_000;
        for (const call of existing.slice(-8)) {
            if (abortSignal?.aborted) throw abortSignalError(abortSignal);
            if (Date.now() >= deadline) {
                ErrorReporter.warn('AgentTools', 'Post-write impact revalidation reached its 10 second bound.');
                break;
            }
            try {
                let result: unknown;
                switch (call.tool) {
                    case 'query_inline_instantiation':
                        result = await this.lspHandler.queryInlineInstantiation(call.args); break;
                    case 'explore_pdx_project':
                        result = await this.lspHandler.explorePdxProject(call.args); break;
                    case 'query_workspace_index':
                        result = await this.queryWorkspaceIndex(call.args); break;
                    case 'query_localisation_index':
                        result = await this.queryLocalisationIndex(call.args); break;
                    case 'query_project_knowledge':
                        result = await queryProjectKnowledge(this.workspaceRoot, call.args); break;
                    case 'compare_definition_with_vanilla':
                        result = await this.lspHandler.compareDefinitionWithVanilla(call.args); break;
                    case 'query_override_modes':
                        result = await this.lspHandler.queryOverrideModes(call.args); break;
                    default:
                        continue;
                }
                const record = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Record<string, unknown>
                    : {};
                if (record.ok === false || record.success === false || record.status === 'error' || record.status === 'unavailable') continue;
                for (const file of this.extractIndirectEvidenceFiles(result)) affectedFiles.add(file);
                const revision = nodeCrypto.createHash('sha256').update(JSON.stringify(result ?? null)).digest('hex');
                refreshed.push({ ...call, revision: `sha256:${revision}`, observedAt: new Date().toISOString() });
            } catch (error) {
                ErrorReporter.warn('AgentTools', `Post-write impact revalidation failed for ${call.tool}`, error);
            }
        }
        this.impactEvidenceCalls.set(key, refreshed);
        this.postWriteAffectedFiles.set(key, [...affectedFiles].sort((a, b) => a.localeCompare(b)).slice(0, 200));
    }

    private isShaderTarget(filePath: string): boolean {
        const extension = path.extname(filePath).toLowerCase();
        return extension === '.shader' || extension === '.fxh';
    }

    private requiresShaderInterfacePreflight(filePath: string, previousContent: string, content: string): boolean {
        return path.extname(filePath).toLowerCase() === '.gfx'
            && (/\beffectFile\s*=/i.test(previousContent) || /\beffectFile\s*=/i.test(content));
    }

    private async evaluateShaderWritePreflight(request: {
        filePath: string;
        previousContent: string;
        content: string;
    }): Promise<{ allowed: boolean; message?: string; summary: Record<string, unknown> }> {
        const raw = await this.lspHandler.preflightShaderEdit({
            file: request.filePath,
            previousContent: request.previousContent,
            content: request.content,
        });
        const result = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : {};
        const issues = Array.isArray(result.issues)
            ? result.issues.filter((item): item is string => typeof item === 'string')
            : [];
        if (result.ok !== true) {
            const detail = typeof result.error === 'string' ? result.error : 'Shader preflight returned no authoritative result.';
            return {
                allowed: false,
                message: `Shader semantic preflight unavailable; write blocked (fail closed): ${detail}`,
                summary: { ...result, allowed: false, degraded: true },
            };
        }
        if (result.allowed !== true) {
            return {
                allowed: false,
                message: issues.length > 0
                    ? `Shader semantic preflight blocked the write:\n- ${issues.join('\n- ')}`
                    : 'Shader semantic preflight blocked the write because safety could not be proven.',
                summary: result,
            };
        }
        return { allowed: true, summary: result };
    }

    private async validateAffectedShaderUnits(filePath: string): Promise<Record<string, unknown>> {
        const compileRaw = await this.lspHandler.queryShaderCompileUnitFresh(filePath);
        const compileUnit = compileRaw && typeof compileRaw === 'object' && !Array.isArray(compileRaw)
            ? compileRaw as Record<string, unknown>
            : {};
        if (compileUnit.ok !== true) {
            return {
                passed: false,
                status: 'unavailable',
                affectedRoots: [],
                validations: [],
                error: typeof compileUnit.error === 'string'
                    ? compileUnit.error
                    : 'Compile-unit lookup returned no authoritative result.',
            };
        }

        const root = compileUnit.root && typeof compileUnit.root === 'object' && !Array.isArray(compileUnit.root)
            ? compileUnit.root as Record<string, unknown>
            : {};
        const candidates = [
            filePath,
            typeof root.path === 'string' ? root.path : undefined,
            ...(Array.isArray(compileUnit.includedBy) ? compileUnit.includedBy : []),
        ].filter((item): item is string => typeof item === 'string' && item.length > 0);
        const affectedRoots = [...new Set(candidates.map(item => path.resolve(item)))].sort((a, b) => a.localeCompare(b));
        if (affectedRoots.length > 128) {
            return {
                passed: false,
                status: 'unavailable',
                affectedRoots: affectedRoots.slice(0, 128),
                validations: [],
                error: `Shader write affects ${affectedRoots.length} compile roots, above the bounded validation limit of 128.`,
            };
        }

        const validations: Record<string, unknown>[] = [];
        let unavailable = false;
        let errorCount = 0;
        for (const target of affectedRoots) {
            const raw = await this.lspHandler.validateShaderFresh(target);
            const validation = raw && typeof raw === 'object' && !Array.isArray(raw)
                ? raw as Record<string, unknown>
                : {};
            const diagnostics = Array.isArray(validation.diagnostics)
                ? validation.diagnostics.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
                : [];
            const errors = diagnostics.filter(item => item.severity === 'error');
            errorCount += errors.length;
            if (validation.ok !== true) unavailable = true;
            validations.push({ file: target, ok: validation.ok === true, errorCount: errors.length, diagnostics });
        }
        return {
            passed: !unavailable && errorCount === 0,
            status: unavailable ? 'unavailable' : errorCount > 0 ? 'errors' : 'validated',
            affectedRoots,
            validations,
            errorCount,
        };
    }

    private isHighRiskPdxWrite(toolName: string, targetFile: string): boolean {
        if (toolName === 'rename_symbol') return true;
        const relative = path.relative(this.workspaceRoot, targetFile).replace(/\\/g, '/').toLowerCase();
        return relative.startsWith('common/inline_scripts/')
            || relative.startsWith('common/on_actions/')
            || relative.startsWith('common/button_effects/')
            || relative.startsWith('events/')
            || relative.startsWith('interface/')
            || relative.startsWith('gfx/');
    }

    /** Re-run evidence against integrated on-disk files after all child writes merge. */
    public async finalizePdxEvidence(
        writtenFiles: readonly string[],
        context?: import('./types').AgentToolContext,
    ): Promise<FinalPdxEvidenceValidation> {
        const mode = this.evidenceGateMode();
        if (mode === 'off') {
            return { passed: true, filesChecked: [], conflictFiles: [], pendingFiles: [], coveragePendingFiles: [], report: '' };
        }
        const targets = [...new Set([...new Set(writtenFiles)]
            .map(file => path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.workspaceRoot, file)))]
            .filter(isPdxScriptTarget)
            .sort((a, b) => a.localeCompare(b));
        const abortSignal = context?.runnerOptions?.abortSignal;
        type TargetOutcome = {
            target: string;
            checked: boolean;
            status: 'verified' | 'conflict' | 'pending';
            coveragePending?: boolean;
            detail: string;
        };
        const outcomes = new Array<TargetOutcome>(targets.length);
        let cursor = 0;
        const validateTarget = async (target: string): Promise<TargetOutcome> => {
            if (abortSignal?.aborted) throw abortSignalError(abortSignal);
            const relative = path.relative(this.workspaceRoot, target);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return {
                    target,
                    checked: false,
                    status: 'pending',
                    detail: `- pending: ${target} is outside the workspace evidence boundary.`,
                };
            }
            try {
                const content = await awaitWithAbort(fs.promises.readFile(target, 'utf8'), abortSignal);
                const outcome = await awaitWithAbort(
                    this.evaluatePostWriteEvidence(
                        { toolName: 'write_file', filePath: target, content },
                        context,
                        'final',
                    ),
                    abortSignal,
                );
                const blocking = outcome?.decision?.claims.filter(claim => claim.blocking) ?? [];
                if (blocking.some(claim => claim.status === 'conflict')) {
                    return { target, checked: true, status: 'conflict', detail: `- conflict: ${target}` };
                } else if (outcome?.unavailable === true
                    || outcome?.decision?.degraded === true
                    || outcome?.decision === undefined
                    || blocking.some(claim => claim.status !== 'verified')) {
                    const unresolved = blocking.filter(claim => claim.status !== 'verified');
                    const coverageOnly = unresolved.length > 0 && unresolved.every(claim =>
                        claim.claim === 'semantic evidence extraction covers the complete written file');
                    return {
                        target,
                        checked: true,
                        status: 'pending',
                        coveragePending: coverageOnly || undefined,
                        detail: `- ${coverageOnly ? 'coverage-pending' : 'pending'}: ${target}`,
                    };
                } else {
                    return { target, checked: true, status: 'verified', detail: `- verified: ${target}` };
                }
            } catch (error) {
                if (abortSignal?.aborted) throw abortSignalError(abortSignal);
                return {
                    target,
                    checked: false,
                    status: 'pending',
                    detail: `- pending: ${target} (${error instanceof Error ? error.message : String(error)})`,
                };
            }
        };
        const worker = async () => {
            while (true) {
                if (abortSignal?.aborted) throw abortSignalError(abortSignal);
                const index = cursor++;
                if (index >= targets.length) return;
                outcomes[index] = await validateTarget(targets[index]!);
            }
        };
        await Promise.all(Array.from(
            { length: Math.min(FINAL_EVIDENCE_CONCURRENCY, targets.length) },
            () => worker(),
        ));

        const filesChecked = outcomes.filter(outcome => outcome.checked).map(outcome => outcome.target);
        const conflictFiles = outcomes.filter(outcome => outcome.status === 'conflict').map(outcome => outcome.target);
        const pendingFiles = outcomes.filter(outcome => outcome.status === 'pending').map(outcome => outcome.target);
        const coveragePendingFiles = outcomes.filter(outcome => outcome.coveragePending).map(outcome => outcome.target);
        const details = outcomes.map(outcome => outcome.detail);

        const enforcedConflictFiles = mode === 'shadow' ? [] : conflictFiles;
        const enforcedPendingFiles = mode === 'shadow' ? [] : pendingFiles;
        const enforcedCoveragePendingFiles = mode === 'shadow' ? [] : coveragePendingFiles;
        return {
            passed: enforcedConflictFiles.length === 0 && enforcedPendingFiles.length === 0,
            filesChecked,
            conflictFiles: enforcedConflictFiles,
            pendingFiles: enforcedPendingFiles,
            coveragePendingFiles: enforcedCoveragePendingFiles,
            report: targets.length > 0
                ? [`## Final PDX Evidence Revalidation${mode === 'shadow' ? ' (shadow)' : ''}`, ...details].join('\n')
                : '',
        };
    }

    async execute(toolName: string, args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        // Persisted histories may still contain the pre-unification tool names.
        ({ toolName, args } = normalizeLegacyWebToolCall(toolName, args));
        if (toolName === 'web_search' || toolName === 'web_open' || toolName === 'web_find') {
            const webMode = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web')
                .get<'disabled' | 'indexed' | 'live'>('mode', 'indexed');
            if (webMode === 'disabled' || (webMode === 'indexed' && toolName !== 'web_search')) {
                return {
                    success: false,
                    error: aiText(
                        webMode === 'disabled' ? 'Web access is disabled in Agent settings.' : `${toolName} requires live Web access mode.`,
                        webMode === 'disabled' ? 'Agent 设置中已禁用网页访问。' : `${toolName} 需要“实时”网页访问模式。`,
                    ),
                };
            }
        }
        // Redirect the retired AST mutation tool instead of failing without guidance.
        if (toolName === 'ast_mutate') {
            return {
                success: false,
                message: `${toolName} has been retired. Use get_pdx_block to obtain exact context, then edit_file(filePath, oldString, newString) for the smallest text replacement or replace_lines(filePath, startLine, endLine, newContent, expectedContent) for guarded line-range edits. Use write_file only for new or intentional whole-file writes, and write_localisation for .yml localisation files.`,
            };
        }
        const readTracker = (context?.agentRunner as any)?.readTracker;
        const isSubAgent = !!context?.runnerOptions?.useSlimPrompt;
        if (isSubAgent && toolName === 'git_ops') {
            return {
                success: false,
                message: 'git_ops is disabled for orchestrator sub-agents. Report the issue to the main agent instead of running git commands.',
            };
        }
        const runtimeDomain = context?.runnerOptions?.domain;
        const generalUtilityCommand = runtimeDomain === 'general'
            && context?.runnerOptions?.mode === 'utility'
            && toolName === 'run_command';
        if (isSubAgent && toolName === 'run_command' && !generalUtilityCommand) {
            return {
                success: false,
                message: 'run_command is disabled for orchestrator sub-agents. Do not create or run helper scripts for it. Use structured edit tools for bulk file changes; if a terminal command is truly required, return BLOCKED_FOR_ORCHESTRATOR with the command and reason.',
            };
        }
        const mode = context?.runnerOptions?.mode ?? 
            ((['dispatch_agents', 'merge_results', 'query_blackboard'].includes(toolName)) ? 'orchestrator' : 'build');
        const access = validateToolAccess(toolName, { mode, domain: runtimeDomain, isSubAgent });
        if (!access.allowed) {
            return {
                success: false,
                error: access.reason
            };
        }
        const skillPolicyKey = this.getSkillPolicyKey(context);
        const skillPolicy = skillPolicyKey ? this.activeSkillPolicies.get(skillPolicyKey) : undefined;
        if (skillPolicy && toolName !== 'run_skill' && !skillPolicy.allowedTools.has(toolName)) {
            return {
                success: false,
                error: `Active skills '${skillPolicy.skillNames.join("', '")}' do not allow tool '${toolName}'. Use one of the effective allowed-tools.`,
                skillPolicyDenied: true,
                allowedTools: [...skillPolicy.allowedTools].sort(),
            };
        }
        if (runtimeDomain === 'general' && toolName === 'save_workflow') {
            const workflowMode = typeof args.mode === 'string' ? args.mode : 'utility';
            const generalWorkflowModes = new Set(['plan', 'explore', 'utility', 'review', 'orchestrator']);
            if (!generalWorkflowModes.has(workflowMode)) {
                return {
                    success: false,
                    error: `General Coding cannot save a workflow for domain-specific mode '${workflowMode}'.`,
                };
            }
            const requestedTools = [args.allowedTools, args.blockedTools]
                .flatMap(value => Array.isArray(value) ? value : [])
                .filter((value): value is string => typeof value === 'string');
            const domainSpecificTool = requestedTools.find(name =>
                TOOL_REGISTRY.get(name as import('./types').AgentToolName)?.domain === 'paradox');
            if (domainSpecificTool) {
                return {
                    success: false,
                    error: `General Coding cannot save a workflow containing domain-specific tool '${domainSpecificTool}'.`,
                };
            }
        }

        const registryEntry = TOOL_REGISTRY.get(toolName as any);
        const authorization = context?.runnerOptions?.schedulingState?.authorization;
        if (registryEntry && authorization
            && !authorizationAllowsEffect(authorization, registryEntry.effect, registryEntry.mutating ?? false)) {
            return {
                success: false,
                error: `Scheduling authorization '${authorization}' blocks tool '${toolName}' (${registryEntry.effect}).`,
                authorizationBlocked: true,
            };
        }
        if (vs.workspace.isTrusted === false && registryEntry) {
            const blockedEffects = new Set(['workspace_write', 'network', 'shell', 'git', 'media', 'mcp']);
            if (blockedEffects.has(registryEntry.effect) || registryEntry.mutating) {
                return {
                    success: false,
                    error: aiText(
                        `Tool '${toolName}' is unavailable while this workspace is in Restricted Mode. Trust the workspace to enable commands, network access, and mutations.`,
                        `工作区处于受限模式，工具“${toolName}”不可用。请先信任工作区，再启用命令、网络访问和修改操作。`,
                    ),
                    workspaceTrustRequired: true,
                };
            }
        }

        const runtimePlanPhase = context?.runnerOptions?.schedulingState?.phase === 'plan';
        if (runtimePlanPhase
            || mode === 'plan'
            || ((mode === 'orchestrator' || mode === 'script') && toolName === 'write_file')) {
            const guard = validatePlanModeToolUse(
                toolName,
                args,
                this.workspaceRoot,
                context?.runnerOptions?.topicId,
                undefined,
                runtimePlanPhase ? 'plan' : mode as 'plan' | 'orchestrator' | 'script',
            );
            if (!guard.allowed) {
                return {
                    success: false,
                    error: guard.reason,
                    planModeBlocked: true,
                };
            }
        }
        if (toolName === 'git_ops') {
            const guard = validateGitOpsForMode(runtimePlanPhase ? 'plan' : mode, args);
            if (!guard.allowed) {
                return {
                    success: false,
                    error: guard.reason,
                };
            }
        }

        const policy = await this.enforcePolicy(toolName, args, mode, context);
        if (!policy.allowed) {
            return { success: false, error: policy.error, policyDenied: true };
        }

        const replaySession = (context?.runnerOptions as any)?.replaySession;
        if (replaySession) {
            const { maybeServeFromReplay } = require('./runner/runReplay') as typeof import('./runner/runReplay');
            const replayHit = maybeServeFromReplay(replaySession, toolName, args);
            if (replayHit.hit) {
                return replayHit.result;
            }
            // Miss is recorded inside the session; live execution continues below
            // so the replay doesn't completely fail when the model diverges.
        }

        let timeout = TOOL_TIMEOUTS[toolName];
        if (timeout === undefined) {
            if (toolName.startsWith('mcp_') || toolName === 'mcp_call') {
                timeout = 120_000; // MCP tools can involve network calls or complex processing
            } else {
                timeout = DEFAULT_TOOL_TIMEOUT;
            }
        }
        if (
            timeout > 0
            && WRITE_CONFIRMATION_TOOLS.has(toolName)
            && this.fileWriteMode === 'confirm'
            && (args as Record<string, unknown>)?._autoApply !== true
            && context?.runnerOptions?.forceAutoApplyWrites !== true
            && context?.runnerOptions?.useSlimPrompt !== true
        ) {
            timeout = 0;
        }
        try {
            const parentAbortSignal = context?.runnerOptions?.abortSignal;
            if (parentAbortSignal?.aborted) {
                const err = new Error('AbortError');
                err.name = 'AbortError';
                throw err;
            }

            const toolAbortController = new AbortController();
            const abortSignal = toolAbortController.signal;
            const onParentAbort = () => toolAbortController.abort(parentAbortSignal?.reason);
            if (parentAbortSignal) {
                parentAbortSignal.addEventListener('abort', onParentAbort);
            }

            const startedAt = Date.now();
            let heartbeatId: ReturnType<typeof setInterval> | undefined;
            if (context?.onStep) {
                heartbeatId = setInterval(() => {
                    if (abortSignal.aborted) return;
                    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                    context.onStep?.({
                        type: 'orchestrator_progress',
                        content: `Tool ${toolName} has been running for ${elapsedSec}s and is still waiting for a response...`,
                        toolName,
                        timestamp: Date.now(),
                    });
                }, 15_000);
            }

            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            if (timeout > 0) {
                timeoutId = setTimeout(() => {
                    if (abortSignal.aborted) return;
                    const err = new Error(`Tool ${toolName} timed out after ${timeout / 1000}s`);
                    err.name = 'TimeoutError';
                    toolAbortController.abort(err);
                }, timeout);
            }

            let abortListener: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
                abortListener = () => {
                    const reason = abortSignal.reason;
                    if (reason instanceof Error) {
                        reject(reason);
                        return;
                    }
                    const err = new Error(reason ? String(reason) : 'AbortError');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (abortSignal.aborted) {
                    abortListener();
                    return;
                }
                abortSignal.addEventListener('abort', abortListener, { once: true });
            });

            let gateOutcome: { summary?: Record<string, unknown>; errorResult?: Record<string, unknown> } | undefined;
            let completedPdxWrite: { toolName: string; filePath: string; content: string } | undefined;
            let completedShaderWrite: { filePath: string } | undefined;
            let shaderPreflightSummary: Record<string, unknown> | undefined;
            let guiSafetySummary: Record<string, unknown> | undefined;
            const inheritedPdxPreflight = context?.onBeforePdxWrite;
            const toolContext: import('./types').AgentToolContext = {
                ...(context ?? {}),
                runnerOptions: {
                    ...(context?.runnerOptions ?? {}),
                    abortSignal,
                },
            };
            if (toolContext.runnerOptions?.domain !== 'general') toolContext.onBeforePdxWrite = async request => {
                if (inheritedPdxPreflight) {
                    const inherited = await inheritedPdxPreflight(request);
                    if (!inherited.allowed) return inherited;
                }
                if (path.extname(request.filePath).toLowerCase() === '.gui') {
                    const guiSafety = validateOffCanvasGuiPreservation(request.previousContent, request.content);
                    guiSafetySummary = {
                        allowed: guiSafety.allowed,
                        protectedCount: guiSafety.protectedControls.length,
                        preservedCount: guiSafety.preservedCount,
                        missingControls: guiSafety.missingControls.map(control => ({
                            type: control.type,
                            name: control.name,
                            parentPath: control.parentPath,
                            line: control.line,
                            position: { x: control.x, y: control.y },
                        })),
                        parseError: guiSafety.parseError,
                    };
                    if (!guiSafety.allowed) {
                        const missing = guiSafety.missingControls
                            .map(control => `${control.type} "${control.name}" at line ${control.line}`)
                            .join(', ');
                        const reason = guiSafety.parseError
                            ? `Unable to verify preserved off-canvas GUI controls: ${guiSafety.parseError}`
                            : `The edit removes, renames, or reparents engine-bound off-canvas GUI controls: ${missing}. Preserve each block and hide it with its large coordinates instead of deleting it.`;
                        gateOutcome = {
                            summary: { guiSafetyGate: guiSafetySummary },
                            errorResult: {
                                success: false,
                                error: aiText(
                                    reason,
                                    guiSafety.parseError
                                        ? `无法验证离屏 GUI 控件是否保留：${guiSafety.parseError}`
                                        : `此修改删除、重命名或改变了引擎绑定离屏 GUI 控件的层级：${missing}。请保留控件块，并继续使用大坐标将其移出画布。`,
                                ),
                                guiSafetyGate: guiSafetySummary,
                            },
                        };
                        return { allowed: false, message: reason };
                    }
                }
                const shaderTarget = this.isShaderTarget(request.filePath);
                if (shaderTarget || this.requiresShaderInterfacePreflight(request.filePath, request.previousContent, request.content)) {
                    const shaderGate = await this.evaluateShaderWritePreflight(request);
                    shaderPreflightSummary = shaderGate.summary;
                    if (!shaderGate.allowed) {
                        gateOutcome = {
                            summary: shaderGate.summary,
                            errorResult: {
                                success: false,
                                error: shaderGate.message ?? 'Shader semantic preflight blocked the write.',
                                shaderSafetyGate: shaderGate.summary,
                            },
                        };
                        return { allowed: false, message: shaderGate.message };
                    }
                    if (shaderTarget) {
                        completedShaderWrite = { filePath: request.filePath };
                        gateOutcome = { summary: { shaderSafetyGate: shaderGate.summary } };
                        return { allowed: true };
                    }
                }
                gateOutcome = await this.evaluateEvidenceGate(
                    request.toolName,
                    request.filePath,
                    request.content,
                    request.previousContent,
                    toolContext,
                );
                if (guiSafetySummary && !gateOutcome?.errorResult) {
                    gateOutcome = {
                        ...gateOutcome,
                        summary: {
                            ...(gateOutcome?.summary ?? {}),
                            guiSafetyGate: guiSafetySummary,
                        },
                    };
                }
                const error = gateOutcome?.errorResult?.error;
                if (!gateOutcome?.errorResult) {
                    completedPdxWrite = {
                        toolName: request.toolName,
                        filePath: request.filePath,
                        content: request.content,
                    };
                }
                return gateOutcome?.errorResult
                    ? { allowed: false, message: typeof error === 'string' ? error : EVIDENCE_GATE_MSG.UNAVAILABLE }
                    : { allowed: true };
            };

            const preToolHook = await runAgentHooks('preToolUse', {
                toolName,
                args,
                runId: context?.runnerOptions?.runRecord?.runId,
                threadId: context?.runnerOptions?.threadId,
            });
            if (!preToolHook.allowed) {
                return {
                    success: false,
                    error: preToolHook.reason ?? `Tool ${toolName} was rejected by an Agent hook.`,
                    hookBlocked: true,
                };
            }

            // Semantic evidence gate (plan §4): semantic PDX writes must carry
            // FileToolHandler invokes the async preflight after it has resolved
            // the path and built the exact final content. This keeps policy and
            // path gates outside it while preventing fragment-only validation.
            const racePromises: Promise<unknown>[] = [
                this.executeInternal(toolName, args, toolContext),
                abortPromise,
            ];

            try {
                const result = await Promise.race(racePromises);
                const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Record<string, unknown>
                    : undefined;
                const writeSucceeded = resultRecord?.success !== false
                    && resultRecord?.applied !== false
                    && !gateOutcome?.errorResult;
                if (context && WRITE_TOOLS.has(toolName) && writeSucceeded) {
                    // A prior read no longer proves the post-mutation workspace
                    // revision. Require another authoritative read before a stale
                    // project fact can be revalidated.
                    context.authoritativeProjectRevision = undefined;
                }
                if (context
                    && AUTHORITATIVE_MEMORY_EVIDENCE_TOOLS.has(toolName)
                    && resultRecord?.success !== false
                    && resultRecord?.error === undefined) {
                    context.authoritativeProjectRevision = MemoryParser.getWorkspaceProjectRevision(this.workspaceRoot);
                }
                const postWriteEvidence = completedPdxWrite && writeSucceeded
                    ? await this.evaluatePostWriteEvidence(completedPdxWrite, toolContext)
                    : undefined;
                const postWriteShader = completedShaderWrite && writeSucceeded
                    ? await this.validateAffectedShaderUnits(completedShaderWrite.filePath)
                    : undefined;
                await runAgentHooks('postToolUse', {
                    toolName,
                    success: !(result && typeof result === 'object' && ('error' in result || (result as any).success === false)),
                    runId: context?.runnerOptions?.runRecord?.runId,
                    threadId: context?.runnerOptions?.threadId,
                });
                // Attach the evidence gate decision id so the model and the UI
                // can correlate the write with its evidence (plan §4.2 step 7
                // stays with the existing post-write diagnostics revalidation).
                if (resultRecord) {
                    if (gateOutcome?.errorResult) {
                        Object.assign(resultRecord, gateOutcome.errorResult);
                    }
                    if (gateOutcome?.summary && !gateOutcome.errorResult) {
                        resultRecord.evidenceGate = gateOutcome.summary;
                    }
                    if (shaderPreflightSummary) {
                        resultRecord.shaderSafetyGate = shaderPreflightSummary;
                    }
                    if (postWriteShader) {
                        resultRecord.shaderPostWriteValidation = postWriteShader;
                        if (postWriteShader.passed !== true) {
                            if (postWriteShader.status === 'errors') resultRecord.requiresRepair = true;
                            else resultRecord.requiresValidation = true;
                        }
                    }
                    if (postWriteEvidence) {
                        const validation = classifyPostWriteValidation(
                            postWriteEvidence.decision,
                            resultRecord,
                            postWriteEvidence.unavailable === true,
                        );
                        resultRecord.postWriteEvidence = {
                            ...postWriteEvidence.summary,
                            missingEvidence: postWriteEvidence.decision?.missingEvidence ?? [],
                        };
                        resultRecord.postWriteValidation = {
                            ...validation,
                            evidenceDecisionId: postWriteEvidence.decision?.decisionId,
                        };
                        resultRecord.postWriteValidationPassed = validation.verdict === 'allow';
                        if (validation.verdict === 'repair') {
                            resultRecord.requiresRepair = true;
                        } else if (validation.verdict === 'pending') {
                            resultRecord.requiresValidation = true;
                        }
                    }
                }
                const writtenFiles = this.extractResultWrittenFiles(result);

                // ReadTracker read/write synchronization and Blackboard invalidation cascade (T2.2 & B3)
                if (readTracker) {
                    for (const file of writtenFiles) {
                        readTracker.invalidate(file);
                    }
                    // Multi-agent cascade invalidation (B3)
                    if (toolName === 'merge_results' && result && typeof result === 'object') {
                        const writtenFiles = (result as any).writtenFiles;
                        if (Array.isArray(writtenFiles)) {
                            for (const file of writtenFiles) {
                                readTracker.invalidate(path.resolve(this.workspaceRoot, file));
                            }
                        }
                    }
                }
                if (writtenFiles.length > 0) {
                    for (const file of writtenFiles) {
                        this.invalidateCacheForFile(file);
                    }
                    if (result && typeof result === 'object') {
                        const indirectFiles = this.postWriteAffectedFiles.get(this.getImpactEvidenceKey(context)) ?? [];
                        const revalidationTargets = Array.from(new Set([...writtenFiles, ...indirectFiles])).slice(0, 200);
                        const revalidation = await this.requestRevalidateFiles(revalidationTargets);
                        if (revalidation) {
                            (result as Record<string, unknown>).revalidation = revalidation;
                            (result as Record<string, unknown>).indirectRevalidationFiles = indirectFiles
                                .filter(file => !writtenFiles.includes(file));
                        }
                    }
                }
                return this.truncateResult(result);
            } finally {
                if (heartbeatId) clearInterval(heartbeatId);
                if (timeoutId) clearTimeout(timeoutId);
                if (abortListener) {
                    abortSignal.removeEventListener('abort', abortListener);
                }
                if (parentAbortSignal) {
                    parentAbortSignal.removeEventListener('abort', onParentAbort);
                }
            }
        } catch (e) {
            if (e instanceof Error && (e.name === 'TimeoutError' || e.message.includes('timed out'))) {
                return { error: e.message, hint: 'Retry or use a narrower operation scope.' };
            }
            throw e;
        }
    }

    /** Internal tool dispatch - the actual switch statement, called within a timeout wrapper. */
    private async executeInternal(toolName: string, args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        let result: unknown;
        switch (toolName as any) {
            // - LSP / CWTools query tools -
            case 'query_scope':
                result = await this.lspHandler.queryScope(args as any); break;
            case 'query_types':
                result = await this.lspHandler.queryTypes(args as any); break;
            case 'query_localisation_index':
                result = await this.queryLocalisationIndex(args as any); break;
            case 'query_workspace_index':
                result = await this.queryWorkspaceIndex(args as any); break;
            case 'explore_pdx_project':
                result = await this.lspHandler.explorePdxProject(args as any); break;
            case 'query_inline_instantiation':
                result = await this.lspHandler.queryInlineInstantiation(args as any); break;
            case 'compare_definition_with_vanilla':
                result = await this.lspHandler.compareDefinitionWithVanilla(args as any); break;
            case 'analyze_pdx_flow':
                result = await this.lspHandler.analyzePdxFlow(args as any); break;
            case 'query_project_profile':
                result = queryProjectProfile(this.workspaceRoot, args as any); break;
            case 'query_project_knowledge':
                result = await queryProjectKnowledge(this.workspaceRoot, args as any); break;
            case 'query_interface_knowledge':
                result = await this.queryInterfaceKnowledgeWithProject(args); break;
            case 'run_skill':
                result = this.runSkill(args, context); break;
            case 'query_rules':
                result = await this.lspHandler.queryRules(args as any); break;
            case 'query_cwt_schema':
                result = await this.lspHandler.queryCwtSchema(args as any); break;
            case 'query_override_modes':
                result = await this.lspHandler.queryOverrideModes(args as any); break;
            case 'search_rule_capabilities':
                result = await this.lspHandler.searchRuleCapabilities(args as any); break;
            case 'explain_scope':
                result = await this.lspHandler.explainScope(args as any); break;
            case 'parse_pdx_fragment':
                result = await this.lspHandler.parsePdxFragment(args as any); break;
            case 'query_references':
                result = await this.lspHandler.queryReferences(args as any); break;
            // validate_code - REMOVED: replaced by get_diagnostics + edit_file inline diagnostics
            case 'get_lsp_status':
                result = await this.lspHandler.getLspStatus(args as any); break;
            case 'get_diagnostics':
                result = await this.lspHandler.getDiagnostics(args as any, context); break;
            case 'get_file_context':
                result = await this.lspHandler.getFileContext(args as any, context); break;
            case 'search_mod_files':
                result = await this.lspHandler.searchModFiles(args as any); break;
            case 'find_sprite_candidates':
                result = await this.lspHandler.findSpriteCandidates(args as any); break;
            case 'find_sound_candidates':
                result = await this.lspHandler.findSoundCandidates(args as any); break;
            case 'grep':
                result = await this.lspHandler.grep(args as any, context); break;
            case 'get_completion_at':
                result = await this.lspHandler.getCompletionAt(args as any, context); break;
            case 'document_symbols':
                result = await this.lspHandler.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.lspHandler.workspaceSymbols(args as any, context); break;
            case 'go_to_definition':
                result = await this.lspHandler.goToDefinition(args as any); break;
            case 'find_references':
                result = await this.lspHandler.findReferencesAt(args as any); break;
            case 'hover_symbol':
                result = await this.lspHandler.hoverSymbol(args as any); break;
            case 'rename_symbol':
                result = await this.lspHandler.renameSymbol(args as any, context); break;
            case 'verify_pdx_identifier':
                result = await this.lspHandler.verifyPdxIdentifier(args as any); break;
            case 'get_pdx_block':
                result = await this.lspHandler.getPdxBlock(args as any, context); break;
            case 'lsp_operation':
                result = await this.lspHandler.lspOperation(args as any, context); break;
            case 'query_definition':
                result = await this.lspHandler.queryDefinition(args as any); break;
            case 'query_definition_by_name':
                result = await this.lspHandler.queryDefinitionByName(args as any); break;
            case 'query_scripted_effects':
                result = await this.lspHandler.queryScriptedEffects(args as any); break;
            case 'query_scripted_triggers':
                result = await this.lspHandler.queryScriptedTriggers(args as any); break;
            case 'query_enums':
                result = await this.lspHandler.queryEnums(args as any); break;
            case 'get_entity_info':
                result = await this.lspHandler.getEntityInfo(args as any); break;
            case 'query_static_modifiers':
                result = await this.lspHandler.queryStaticModifiers(args as any); break;
            case 'query_variables':
                result = await this.lspHandler.queryVariables(args as any); break;
            case 'query_shader_symbol':
                result = await this.lspHandler.queryShaderSymbol(args as any); break;
            case 'query_shader_compile_unit':
                result = await this.lspHandler.queryShaderCompileUnit(args as any); break;
            case 'query_shader_platform_variants':
                result = await this.lspHandler.queryShaderPlatformVariants(args as any); break;
            case 'query_shader_callers':
                result = await this.lspHandler.queryShaderCallers(args as any); break;
            case 'explain_shader_reachability':
                result = await this.lspHandler.explainShaderReachability(args as any); break;
            case 'validate_shader':
                result = await this.lspHandler.validateShader(args as any); break;
            case 'compare_shader_with_vanilla':
                result = await this.lspHandler.compareShaderWithVanilla(args as any); break;

            // - File tools -
            case 'read_file':
                result = await this.fileHandler.readFile(args as any, context); break;
            case 'write_file':
                result = await this.fileHandler.writeFile(args as any, context); break;
            case 'edit_file':
                result = await this.fileHandler.editFile(args as any, context); break;
            case 'replace_lines':
                result = await this.fileHandler.replaceLines(args as any, context); break;
            case 'list_directory':
                result = await this.fileHandler.listDirectory(args as any, context); break;
            case 'glob_files':
                result = await this.fileHandler.globFiles(args as any); break;
            case 'write_localisation':
                result = await this.fileHandler.writeLocalisation(args as any, context); break;
            case 'write_design_blueprint':
                result = await this.fileHandler.writeDesignBlueprint(args as any, context); break;
            case 'get_design_blueprint_contract':
                result = {
                    success: true,
                    schemaVersion: 2,
                    usage: 'Pass a complete object conforming to parameters as write_design_blueprint({ blueprint: <object> }).',
                    parameters: DESIGN_BLUEPRINT_DETAILED_PARAMETERS,
                }; break;
            case 'save_workflow':
                result = this.saveWorkflow(args); break;
            case 'git_ops':
                result = await this.fileHandler.gitOps(args as any); break; // git ops uses workspace wide state mostly

            // - External / agent tools -
            case 'web_open':
                result = await this.externalHandler.webOpen(args as any, context); break;
            case 'run_command':
                result = await this.externalHandler.runCommand(args as any, context); break;
            case 'list_processes':
                result = this.externalHandler.listProcesses(args as any, context); break;
            case 'read_process':
                result = this.externalHandler.readProcess(args as any, context); break;
            case 'write_process_stdin':
                result = this.externalHandler.writeProcessStdin(args as any, context); break;
            case 'terminate_process':
                result = this.externalHandler.terminateProcess(args as any, context); break;
            case 'web_search':
                result = await this.externalHandler.webSearch(args as any, context); break;
            case 'web_find':
                result = this.externalHandler.webFind(args as any); break;
            case 'todo_write':
                result = await this.externalHandler.todoWrite(args as any, context); break;
            case 'select_tools':
                result = args._selectionResult && typeof args._selectionResult === 'object'
                    ? {
                        success: true,
                        ...args._selectionResult as Record<string, unknown>,
                        message: 'Loaded schemas remain subject to mode, domain, stage, policy, and permission checks at execution time.',
                    }
                    : {
                        success: false,
                        error: 'select_tools must be evaluated by the active Agent runner.',
                    };
                break;
            case 'get_goal': {
                const topicId = context?.runnerOptions?.topicId ?? 'default';
                const threadId = context?.runnerOptions?.threadId ?? topicId;
                result = { success: true, goal: await goalStore.getGoal(topicId, threadId) ?? null };
                break;
            }
            case 'create_goal': {
                if (context?.runnerOptions?.useSlimPrompt) {
                    result = { success: false, error: 'Sub-agents cannot create parent goals.' };
                    break;
                }
                if (context?.runnerOptions?.goalCreationAuthorized !== true) {
                    result = { success: false, error: 'Goal creation requires explicit long-running user intent.' };
                    break;
                }
                const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
                if (!objective) {
                    result = { success: false, error: 'objective is required.' };
                    break;
                }
                const topicId = context?.runnerOptions?.topicId ?? 'default';
                const threadId = context?.runnerOptions?.threadId ?? topicId;
                const criteria = Array.isArray(args.completionCriterion)
                    ? args.completionCriterion.filter((item): item is string => typeof item === 'string')
                    : [];
                const tokenBudget = typeof args.tokenBudget === 'number' ? args.tokenBudget : undefined;
                result = { success: true, goal: await goalStore.setGoal(topicId, threadId, objective, tokenBudget, criteria) };
                break;
            }
            case 'update_goal': {
                const status = args.status as DurableGoalStatus;
                const validStatuses: DurableGoalStatus[] = ['active', 'paused', 'blocked', 'complete', 'cancelled'];
                if (!validStatuses.includes(status)) {
                    result = { success: false, error: 'Invalid goal status.' };
                    break;
                }
                const reason = typeof args.reason === 'string' ? args.reason.trim() : undefined;
                const evidence = Array.isArray(args.evidence)
                    ? args.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
                    : [];
                if (status === 'complete' && (context?.runnerOptions?.useSlimPrompt || evidence.length === 0)) {
                    result = { success: false, error: 'Completing a goal requires parent-agent completion evidence.' };
                    break;
                }
                if (status === 'complete') {
                    const incompleteTodos = context?.agentRunner?.toolExecutor.getTodos(context?.runnerOptions?.agentId)
                        .filter(todo => todo.status !== 'done') ?? [];
                    const topicId = context?.runnerOptions?.topicId ?? 'default';
                    agentTaskManager.configure(topicId);
                    const activeTasks = agentTaskManager.list().filter(task =>
                        task.status === 'queued' || task.status === 'running' || task.status === 'detached');
                    if (incompleteTodos.length > 0 || activeTasks.length > 0
                        || context?.runnerOptions?.schedulingState?.phase !== 'finalize') {
                        result = {
                            success: false,
                            error: `Goal completion rejected: ${incompleteTodos.length} incomplete todo(s), ${activeTasks.length} active task(s), phase ${context?.runnerOptions?.schedulingState?.phase ?? 'unknown'}.`,
                        };
                        break;
                    }
                }
                if (status === 'blocked' && !reason) {
                    result = { success: false, error: 'Blocking a goal requires a concrete reason.' };
                    break;
                }
                const topicId = context?.runnerOptions?.topicId ?? 'default';
                const threadId = context?.runnerOptions?.threadId ?? topicId;
                const transitioned = await goalSupervisor.transition(topicId, threadId, status, reason);
                if (transitioned) {
                    context?.runEventSink?.appendSoon('goal_transitioned', {
                        goalId: transitioned.goalId,
                        status: transitioned.status,
                        reason,
                        evidenceCount: evidence.length,
                    }, { status: transitioned.status === 'blocked' ? 'failed' : 'done' });
                }
                result = transitioned
                    ? { success: true, goal: transitioned }
                    : { success: false, error: 'No durable goal exists for this thread.' };
                break;
            }
            case 'set_goal_budget': {
                if (context?.runnerOptions?.useSlimPrompt) {
                    result = { success: false, error: 'Sub-agents cannot change parent goal budgets.' };
                    break;
                }
                const topicId = context?.runnerOptions?.topicId ?? 'default';
                const threadId = context?.runnerOptions?.threadId ?? topicId;
                result = {
                    success: true,
                    goal: await goalStore.setBudget(topicId, threadId, {
                        tokens: typeof args.tokens === 'number' ? args.tokens : undefined,
                        turns: typeof args.turns === 'number' ? args.turns : undefined,
                        wallClockMs: typeof args.wallClockMs === 'number' ? args.wallClockMs : undefined,
                    }),
                };
                break;
            }
            // ignore_validation_error - REMOVED: AI must fix errors, not suppress them
            case 'remove_ignored_diagnostic':
                result = await this.externalHandler.removeIgnoredDiagnostic(args as any, context); break;
            case 'get_ignored_diagnostics':
                result = await this.externalHandler.getIgnoredDiagnostics(); break;











            // - Media Asset Conversion tools -
            case 'convert_image_to_dds':
                result = await this.externalHandler.convertImageToDds(args as any, context); break;
            case 'convert_audio':
                result = await this.externalHandler.convertAudio(args as any, context); break;
            case 'deploy_mod_asset':
                result = await this.externalHandler.deployModAsset(args as any, context); break;

            case 'analyze_diagnostic_error':
                result = await this.analyzeDiagnosticError(args); break;
            case 'set_memory':
                result = await this.memoryHandler.setMemory(args as any, context); break;
            case 'set_memory_disabled': break;
            case 'get_memory':
                result = await this.memoryHandler.getMemory(args as any, context); break;
            case 'get_memory_disabled': break;
            case 'search_memory':
                result = this.memoryHandler.searchMemory(args as any, context); break;
            case 'search_memory_disabled': break;
            case 'history': {
                result = searchAgentHistory(this.workspaceRoot, args as any, {
                    topicId: context?.runnerOptions?.topicId,
                    domain: context?.runnerOptions?.domain,
                });
                const count = typeof result === 'object' && result !== null
                    && 'results' in result && Array.isArray(result.results) ? result.results.length : 0;
                context?.runEventSink?.appendSoon('blackboard_read', {
                    source: 'history',
                    queryLength: typeof args.query === 'string' ? args.query.length : 0,
                    scope: args.scope === 'topic' ? 'topic' : 'workspace',
                    resultCount: count,
                }, { status: 'done' });
                break;
            }

            // - Persistent memory (cross-session, written to the topic-scoped .cwtools-memory.md) -
            case 'save_memory':
                result = await this.memoryHandler.saveMemory(args as any, context); break;
            case 'save_memory_disabled': break;
            case 'forget_memory':
                result = await this.memoryHandler.forgetMemory(args as any, context); break;
            case 'memory_recall_trace':
                result = await this.memoryHandler.getRecallTrace(context); break;

            // - MCP tool call -
            case 'mcp_call':
                result = await this.executeMcpTool(args as any, context); break;

            // - Orchestrator tools -
            case 'dispatch_agents': {
                result = await this.executeDispatchAgents(args, context);
                break;
            }
            case 'query_blackboard':
                result = await this.memoryHandler.queryBlackboard(args as any, context); break;
            case 'query_blackboard_disabled': break;
            case 'merge_results': {
                result = this.executeMergeResults(args, context);
                break;
            }

            default:
                // Check if this is a dynamically registered MCP tool (mcp_<server>_<tool>)
                if (toolName.startsWith('mcp_')) {
                    result = await this.executeMcpTool({ ...args, _toolName: toolName } as any, context);
                } else {
                    throw new Error(`Unknown tool: ${toolName}`);
                }
        }
        const authoritativeImpactTools = new Set([
            'query_inline_instantiation', 'explore_pdx_project', 'query_workspace_index',
            'query_project_knowledge', 'compare_definition_with_vanilla', 'query_override_modes',
            'query_localisation_index',
        ]);
        const failed = !!result && typeof result === 'object' && (
            (result as Record<string, unknown>).success === false
            || (result as Record<string, unknown>).ok === false
            || ['error', 'unavailable'].includes(String((result as Record<string, unknown>).status ?? ''))
        );
        if (!failed && authoritativeImpactTools.has(toolName)) {
            const key = this.getImpactEvidenceKey(context);
            const calls = this.impactEvidenceCalls.get(key) ?? [];
            const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
                ? result as Record<string, unknown>
                : {};
            const revisionParts = [
                resultRecord.graphVersion,
                resultRecord.schemaVersion,
                resultRecord.version,
                resultRecord.indexUpdatedAt,
                resultRecord.generatedAt,
                resultRecord.status,
            ].filter(value => typeof value === 'string' || typeof value === 'number');
            calls.push({
                tool: toolName,
                args: { ...args },
                target: JSON.stringify(args).slice(0, 1_000),
                revision: revisionParts.length > 0
                    ? revisionParts.join(':')
                    : `sha256:${nodeCrypto.createHash('sha256').update(JSON.stringify(result ?? null)).digest('hex')}`,
                observedAt: new Date().toISOString(),
            });
            this.impactEvidenceCalls.delete(key);
            this.postWriteAffectedFiles.delete(key);
            this.impactEvidenceCalls.set(key, calls.slice(-100));
            while (this.impactEvidenceCalls.size > 64) {
                const oldest = this.impactEvidenceCalls.keys().next().value as string | undefined;
                if (!oldest) break;
                this.impactEvidenceCalls.delete(oldest);
                this.postWriteAffectedFiles.delete(oldest);
            }
        }
        return result;
    }

    private runSkill(args: Record<string, unknown>, context?: import('./types').AgentToolContext): unknown {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) {
            return {
                success: false,
                error: 'run_skill requires a non-empty name.',
            };
        }

        const loaded = loadSkill(name, {
            workspaceRoot: this.workspaceRoot,
            globalStoragePath: this.globalStoragePath,
            extensionPath: this.extensionPath,
        }, context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build'));
        if (!loaded.success) return loaded;

        const declaredTools = loaded.skill.allowedTools;
        if (declaredTools?.length) {
            const unknownTool = declaredTools.find(tool => !TOOL_REGISTRY.has(tool as import('./types').AgentToolName));
            if (unknownTool) {
                return {
                    success: false,
                    error: `Skill '${loaded.skill.name}' declares unknown allowed-tool '${unknownTool}'. Fix its SKILL.md frontmatter before use.`,
                };
            }
            const policyKey = this.getSkillPolicyKey(context);
            if (policyKey) {
                const previous = this.activeSkillPolicies.get(policyKey);
                const declared = new Set(declaredTools);
                const effectiveAllowedTools = previous
                    ? new Set([...previous.allowedTools].filter(tool => declared.has(tool)))
                    : declared;
                this.activeSkillPolicies.delete(policyKey);
                this.activeSkillPolicies.set(policyKey, {
                    skillNames: previous?.skillNames.includes(loaded.skill.name)
                        ? previous.skillNames
                        : [...(previous?.skillNames ?? []), loaded.skill.name],
                    allowedTools: effectiveAllowedTools,
                });
                while (this.activeSkillPolicies.size > AgentToolExecutor.ACTIVE_SKILL_POLICY_LIMIT) {
                    const oldest = this.activeSkillPolicies.keys().next().value as string | undefined;
                    if (oldest === undefined) break;
                    this.activeSkillPolicies.delete(oldest);
                }
            }
        }

        const policyKey = this.getSkillPolicyKey(context);
        const effectivePolicy = policyKey ? this.activeSkillPolicies.get(policyKey) : undefined;
        const argumentSummary = args.arguments === undefined
            ? ''
            : `\n\n<skill-arguments>\n${JSON.stringify(args.arguments, null, 2)}\n</skill-arguments>`;
        return {
            success: true,
            name: loaded.skill.name,
            source: loaded.skill.source,
            runAs: loaded.skill.runAs,
            allowedTools: loaded.skill.allowedTools,
            truncated: loaded.truncated,
            content: `<skill name="${loaded.skill.name}">\n${loaded.content}\n</skill>${argumentSummary}`,
            guidance: 'Follow this SKILL.md for the current task. If runAs says subagent, use dispatch_agents only when orchestration is already appropriate and available.',
            policyEnforced: !!effectivePolicy,
            activeSkills: effectivePolicy?.skillNames,
            effectiveAllowedTools: effectivePolicy ? [...effectivePolicy.allowedTools].sort() : undefined,
        };
    }

    public clearSkillPolicyForRun(runId: string): void {
        if (runId) {
            this.activeSkillPolicies.delete(`run:${runId}`);
            this.impactEvidenceCalls.delete(`run:${runId}`);
            this.postWriteAffectedFiles.delete(`run:${runId}`);
        }
    }

    private getImpactEvidenceKey(context?: import('./types').AgentToolContext): string {
        const runId = context?.runnerOptions?.runRecord?.runId;
        if (runId) return `run:${runId}`;
        const threadId = context?.runnerOptions?.threadId;
        if (threadId) return `thread:${threadId}`;
        return `topic:${context?.runnerOptions?.topicId ?? 'default'}`;
    }

    private getSkillPolicyKey(context?: import('./types').AgentToolContext): string | undefined {
        const runId = context?.runnerOptions?.runRecord?.runId;
        if (runId) return `run:${runId}`;
        const threadId = context?.runnerOptions?.threadId;
        return threadId ? `thread:${threadId}` : undefined;
    }

    private saveWorkflow(args: Record<string, unknown>): unknown {
        const result = saveProjectWorkflow(
            args as any,
            this.workspaceRoot,
            (filePath, previousContent) => this.onBeforeFileWrite?.(filePath, previousContent)
        );
        if (result.success) {
            this.onWorkflowSaved?.();
        }
        return result;
    }

    private async analyzeDiagnosticError(args: Record<string, unknown>): Promise<AnalyzeDiagnosticErrorResult> {
        const snapshot = args.diagnosticsSnapshot ?? args.toolResult ?? args.diagnostics;
        let source: AnalyzeDiagnosticErrorResult['source'] = snapshot === undefined ? 'message' : 'snapshot';
        let diagnostics = snapshot === undefined ? [] : this.extractDiagnostics(snapshot);
        let freshness = this.extractFreshness(snapshot);
        let pendingGlobalKinds = this.extractPendingGlobalKinds(snapshot);

        const file = this.asString(args.file);
        if (diagnostics.length === 0 && file) {
            try {
                const queried = await this.lspHandler.getDiagnostics({
                    file,
                    severity: 'error',
                    limit: 20,
                }) as GetDiagnosticsResult;
                diagnostics = this.extractDiagnostics(queried);
                freshness = queried.freshness ?? freshness;
                pendingGlobalKinds = queried.pendingGlobalKinds ?? pendingGlobalKinds;
                source = 'get_diagnostics';
            } catch {
                source = 'message';
            }
        }

        if (diagnostics.length === 0) {
            const fallbackMessage = [
                this.asString(args.errorCode),
                this.asString(args.message),
                this.asString(args.previousAttempt),
                this.asString(args.reflection),
            ].filter(Boolean).join('\n');
            if (fallbackMessage) {
                diagnostics = [{
                    file,
                    logicalPath: file,
                    severity: 'error',
                    message: fallbackMessage,
                    line: 0,
                    column: 0,
                    code: this.asString(args.errorCode),
                }];
                source = 'message';
            }
        }

        const analysisText = [
            this.asString(args.toolName),
            this.asString(args.errorCode),
            this.asString(args.message),
            this.asString(args.previousAttempt),
            this.asString(args.reflection),
            ...diagnostics.map(d => `${d.code ?? ''} ${d.file ?? ''} ${d.message}`),
        ].filter(Boolean).join('\n');

        const category = this.classifyDiagnosticText(analysisText, diagnostics, freshness);
        const suspectedStaleCache = freshness === 'pending'
            || freshness === 'stale'
            || /stale|cache|pending global|validation\s+pending/i.test(analysisText);
        const requiredFreshRead = category === 'read_tracker_stale'
            || /readtracker|fresh read|was not read|modified externally|get_file_context/i.test(analysisText);
        const referenceCandidates = this.extractDiagnosticReferenceCandidates(analysisText);
        const referenceVerificationRequired = this.shouldVerifyDiagnosticReferences(category, referenceCandidates);
        const verificationInstruction = referenceVerificationRequired
            ? this.buildReferenceVerificationInstruction(category, referenceCandidates)
            : undefined;
        const diagnosticHash = this.hashText(JSON.stringify({
            category,
            references: referenceCandidates.slice(0, 5),
            diagnostics: diagnostics.slice(0, 10).map(d => ({
                file: d.logicalPath || d.file,
                code: d.code,
                message: d.message,
            })),
            toolName: this.asString(args.toolName),
        }));
        const repeatCount = this.recordDiagnosticAnalysis(diagnosticHash);
        const route = this.buildDiagnosticRoute(category, suspectedStaleCache, requiredFreshRead, referenceVerificationRequired);
        const stopReason = repeatCount >= 3
            ? `Same diagnostic route seen ${repeatCount} times. Stop blind retries; broaden context or report the blocker with the diagnostic details.`
            : undefined;
        const nextInstruction = [
            route.nextInstruction,
            verificationInstruction,
            stopReason,
        ].filter(Boolean).join(' ');

        return {
            success: true,
            acknowledged: true,
            message: `Diagnostic classified as ${category}; follow recommendedTools before retrying writes.`,
            category,
            confidence: this.diagnosticConfidence(category, diagnostics.length, source),
            source,
            diagnosticHash,
            repeatCount,
            diagnosticsAnalyzed: diagnostics.length,
            freshness,
            pendingGlobalKinds,
            suspectedStaleCache,
            requiredFreshRead,
            referenceCandidates,
            referenceVerificationRequired,
            verificationInstruction,
            recommendedTools: Array.from(new Set(route.recommendedTools)),
            avoidTools: Array.from(new Set(route.avoidTools)),
            nextInstruction,
            stopReason,
            diagnostics: diagnostics.slice(0, 5),
        };
    }

    private extractDiagnostics(value: unknown, inheritedFile = '', out: DiagnosticEntry[] = []): DiagnosticEntry[] {
        if (out.length >= 30 || value === null || value === undefined) return out;
        if (typeof value === 'string') {
            const message = value.trim();
            if (message) {
                out.push({ file: inheritedFile, logicalPath: inheritedFile, severity: 'error', message, line: 0, column: 0 });
            }
            return out;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                this.extractDiagnostics(item, inheritedFile, out);
                if (out.length >= 30) break;
            }
            return out;
        }
        if (typeof value !== 'object') return out;

        const obj = value as Record<string, unknown>;
        const file = this.asString(obj.file) || this.asString(obj.filePath) || this.asString(obj.TargetFile) || inheritedFile;
        const message = this.asString(obj.message) || this.asString(obj.error) || this.asString(obj.reason);
        const looksLikeDiagnostic = !!message && (
            obj.severity !== undefined
            || obj.code !== undefined
            || obj.currentVersion !== undefined
            || obj.validatedVersion !== undefined
            || obj.line !== undefined
            || obj.column !== undefined
            || obj.logicalPath !== undefined
            || obj.file !== undefined
            || obj.filePath !== undefined
            || obj.category !== undefined
            || obj.repairHint !== undefined
            || obj.expectedType !== undefined
            || obj.actualType !== undefined
            || obj.scope !== undefined
            || obj.symbol !== undefined
            || obj.confidence !== undefined
            || obj.metadataSource !== undefined
            || obj.data !== undefined
        );
        if (looksLikeDiagnostic) {
            out.push({
                file,
                logicalPath: this.asString(obj.logicalPath) || file,
                severity: this.normalizeSeverity(obj.severity),
                message,
                line: this.asNumber(obj.line),
                column: this.asNumber(obj.column),
                code: this.asString(obj.code) || undefined,
                currentVersion: Number.isFinite(Number(obj.currentVersion)) ? Number(obj.currentVersion) : undefined,
                validatedVersion: Number.isFinite(Number(obj.validatedVersion)) ? Number(obj.validatedVersion) : undefined,
                category: this.normalizeDiagnosticCategory(obj.category),
                repairHint: this.asString(obj.repairHint) || undefined,
                expectedType: this.asString(obj.expectedType) || undefined,
                actualType: this.asString(obj.actualType) || undefined,
                scope: this.asString(obj.scope) || undefined,
                symbol: this.asString(obj.symbol) || undefined,
                confidence: this.asString(obj.confidence) || undefined,
                metadataSource: this.asString(obj.metadataSource) || undefined,
                data: obj.data,
            });
        }

        for (const key of ['diagnostics', 'errors', 'validationErrors', 'items', 'results']) {
            if (obj[key] !== undefined) {
                this.extractDiagnostics(obj[key], file, out);
            }
        }
        return out;
    }

    private extractFreshness(value: unknown): AnalyzeDiagnosticErrorResult['freshness'] | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const obj = value as Record<string, unknown>;
        const freshness = this.asString(obj.freshness);
        if (freshness === 'fresh' || freshness === 'pending' || freshness === 'stale') return freshness;
        for (const key of ['diagnostics', 'items', 'results']) {
            const nested = this.extractFreshness(obj[key]);
            if (nested) return nested;
        }
        return undefined;
    }

    private extractPendingGlobalKinds(value: unknown): string[] | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const obj = value as Record<string, unknown>;
        if (Array.isArray(obj.pendingGlobalKinds)) {
            return obj.pendingGlobalKinds.map(v => String(v));
        }
        for (const key of ['diagnostics', 'items', 'results']) {
            const nested = this.extractPendingGlobalKinds(obj[key]);
            if (nested) return nested;
        }
        return undefined;
    }

    private classifyDiagnosticText(
        text: string,
        diagnostics: DiagnosticEntry[],
        freshness?: AnalyzeDiagnosticErrorResult['freshness'],
    ): DiagnosticAnalysisCategory {
        const structured = diagnostics.find(d => d.category && d.category !== 'unknown')?.category;
        if (structured) return structured;

        const lower = text.toLowerCase();
        if (/validation_degraded_lsp_no_feedback|diagnostics?_unavailable|lsp.*no feedback|did not provide fresh diagnostics|diagnostic service:\s*(timeout|error|unavailable)/.test(lower)) return 'lsp_no_feedback';
        if (/readtracker|was not read|modified externally|fresh read|get_file_context/.test(lower)) return 'read_tracker_stale';
        if (/json parse|tool argument|targetcontent|target content|replacementchunks|output length limit|same massive file|truncated/.test(lower)) return 'tool_argument_error';
        if (/cw001|syntax|unexpected token|unexpected end|unbalanced|missing closing|brace|parse error/.test(lower)) return 'brace_or_syntax_error';
        if (/expected value of type sprite|spritetype|gfx_|picture\s*=|sprite/.test(lower)) return 'unknown_sprite';
        if (/show_sound|expected value of type sound|type sound|sound\s*=|music|\.asset/.test(lower)) return 'unknown_sound';
        if (/missing localisation|missing localization|localisation key|localization key|not localised|not localized/.test(lower)) return 'missing_localisation';
        if (/invalid scope|scope mismatch|expected scope|not valid in this scope|current scope|root scope/.test(lower)) return 'scope_mismatch';
        if (/duplicate|already defined|redeclared/.test(lower)) return 'duplicate_definition';
        if (/expected value of type|invalid value|not a valid value|wrong type/.test(lower)) return 'invalid_value_type';
        if (/unknown (trigger|effect)|invalid (trigger|effect)|not a valid (trigger|effect)|trigger_docs|effects\.cwt/.test(lower)) return 'unknown_trigger_effect';
        if (/unknown|not found|could not find|does not exist|unresolved/.test(lower)) return 'missing_definition';
        if ((freshness === 'pending' || freshness === 'stale') && diagnostics.length === 0) return 'stale_lsp_cache';
        return 'unknown';
    }

    private extractDiagnosticReferenceCandidates(text: string): string[] {
        const candidates: string[] = [];
        const add = (value: string | undefined) => {
            if (!value) return;
            const cleaned = value.trim().replace(/[.,;:)]+$/g, '');
            if (!/^[A-Za-z0-9_:.@-]{3,}$/.test(cleaned)) return;
            if (/^(error|warning|info|hint|line|column|fresh|pending|stale|validation|diagnostic|expected|unknown|invalid|type|value)$/i.test(cleaned)) return;
            candidates.push(cleaned);
        };

        for (const match of text.matchAll(/['"`]([A-Za-z0-9_:.@-]{3,})['"`]/g)) {
            add(match[1]);
        }
        for (const match of text.matchAll(/\bGFX_[A-Za-z0-9_:.@-]+\b/g)) {
            add(match[0]);
        }
        for (const match of text.matchAll(/\b(?:picture|icon|sprite|show_sound|sound|music|localisation|localization|id)\s*=\s*([A-Za-z0-9_:.@-]+)/gi)) {
            add(match[1]);
        }
        for (const match of text.matchAll(/\b(?:unknown|invalid|missing|unrecognized|unrecognised|not a valid)\s+(?:trigger|effect|value|identifier|localisation|localization|sprite|sound|type|key)?\s*[:=]?\s*([A-Za-z0-9_:.@-]+)/gi)) {
            add(match[1]);
        }

        return Array.from(new Set(candidates)).slice(0, 8);
    }

    private shouldVerifyDiagnosticReferences(
        category: DiagnosticAnalysisCategory,
        referenceCandidates: string[],
    ): boolean {
        if (referenceCandidates.length === 0) return false;
        return category === 'unknown_trigger_effect'
            || category === 'unknown_sprite'
            || category === 'unknown_sound'
            || category === 'missing_localisation'
            || category === 'invalid_value_type'
            || category === 'missing_definition'
            || category === 'stale_lsp_cache'
            || category === 'unknown';
    }

    private buildReferenceVerificationInstruction(
        category: DiagnosticAnalysisCategory,
        referenceCandidates: string[],
    ): string {
        const refs = referenceCandidates.slice(0, 5).join(', ');
        if (category === 'unknown_sprite') {
            return `Before editing again, verify the concrete sprite reference(s) [${refs}] with find_sprite_candidates(searchContext="both") and only then use a guarded line edit.`;
        }
        if (category === 'unknown_sound') {
            return `Before editing again, verify the concrete sound reference(s) [${refs}] with find_sound_candidates(searchContext="both") and only then use a guarded line edit.`;
        }
        if (category === 'missing_localisation') {
            return `Before creating localisation, verify key(s) [${refs}] with query_localisation_index and search_mod_files(searchContext="both"); only use write_localisation if absent.`;
        }
        if (category === 'invalid_value_type') {
            return `Before replacing value(s) [${refs}], query the field rule/scope and verify type-correct candidates through local indexes.`;
        }
        if (category === 'missing_definition') {
            return `Before creating definition(s) [${refs}], verify workspace and vanilla definitions with query_definition_by_name, workspace_symbols, and search_mod_files(searchContext="both").`;
        }
        return `Before editing or creating definitions again, verify reference(s) [${refs}] through query_rules/query_definition_by_name/workspace_symbols, then search_mod_files(searchContext="both") or verify_pdx_identifier(includeVanilla=true) if still unresolved.`;
    }

    private buildDiagnosticRoute(
        category: DiagnosticAnalysisCategory,
        suspectedStaleCache: boolean,
        requiredFreshRead: boolean,
        referenceVerificationRequired: boolean,
    ): Pick<AnalyzeDiagnosticErrorResult, 'recommendedTools' | 'avoidTools' | 'nextInstruction'> {
        const staleHint = suspectedStaleCache
            ? ' If freshness is pending/stale, treat zero diagnostics cautiously and avoid duplicating already-created references.'
            : '';
        const referenceTools = referenceVerificationRequired
            ? ['query_definition_by_name', 'workspace_symbols', 'search_mod_files', 'verify_pdx_identifier']
            : [];
        switch (category) {
            case 'read_tracker_stale':
                return {
                    recommendedTools: ['read_file', 'get_file_context'],
                    avoidTools: ['write_file', 'replace_lines'],
                    nextInstruction: 'Refresh the target file with read_file or get_file_context, then retry the smallest guarded edit.',
                };
            case 'tool_argument_error':
                return {
                    recommendedTools: ['read_file', 'get_file_context', 'replace_lines'],
                    avoidTools: ['write_file with a large whole-file payload'],
                    nextInstruction: 'Do not retry the same malformed arguments. Re-read exact current text or switch to line-based replacement with anchors.',
                };
            case 'brace_or_syntax_error':
                return {
                    recommendedTools: ['get_file_context', 'document_symbols', 'query_rules', 'get_diagnostics'],
                    avoidTools: ['large write_file rewrites'],
                    nextInstruction: `Inspect the local syntax context and fix the smallest malformed block before re-running diagnostics.${staleHint}`,
                };
            case 'unknown_sprite':
                return {
                    recommendedTools: ['find_sprite_candidates', 'search_mod_files', 'replace_lines', 'get_diagnostics'],
                    avoidTools: ['inventing GFX_* names', 'raw .dds paths in sprite fields'],
                    nextInstruction: 'Resolve the sprite through verified project or vanilla .gfx candidates before editing the offending line.',
                };
            case 'unknown_sound':
                return {
                    recommendedTools: ['find_sound_candidates', 'search_mod_files', 'replace_lines', 'get_diagnostics'],
                    avoidTools: ['inventing sound names', 'raw audio paths where an asset name is expected'],
                    nextInstruction: 'Resolve the sound/music asset through verified .asset candidates before editing the offending line.',
                };
            case 'missing_localisation':
                return {
                    recommendedTools: ['query_localisation_index', 'search_mod_files', 'write_localisation', 'get_diagnostics'],
                    avoidTools: ['write_file on .yml localisation files', 'duplicating keys without searching first'],
                    nextInstruction: `Search for the key first; if absent, use write_localisation on a real localisation path, then verify diagnostics.${staleHint}`,
                };
            case 'scope_mismatch':
                return {
                    recommendedTools: ['query_scope', 'query_rules', 'get_file_context', 'document_symbols'],
                    avoidTools: ['guessing scope transitions'],
                    nextInstruction: 'Use CWTools scope/rule queries to verify the legal scope chain before changing triggers or effects.',
                };
            case 'invalid_value_type':
                return {
                    recommendedTools: ['query_rules', 'query_scope', 'get_file_context', 'verify_pdx_identifier', ...referenceTools],
                    avoidTools: ['guessing enum/type values', 'copying unrelated vanilla values without scope/rule evidence'],
                    nextInstruction: 'Read the exact field rule and current scope, then replace only the invalid value with a verified type-correct candidate.',
                };
            case 'missing_definition':
                return {
                    recommendedTools: ['query_definition_by_name', 'workspace_symbols', 'search_mod_files', 'verify_pdx_identifier', ...referenceTools],
                    avoidTools: ['creating duplicate definitions before checking vanilla/project sources'],
                    nextInstruction: 'Verify whether the referenced ID exists in workspace or vanilla before creating or renaming anything.',
                };
            case 'duplicate_definition':
                return {
                    recommendedTools: ['query_definition_by_name', 'workspace_symbols', 'document_symbols', 'get_file_context'],
                    avoidTools: ['deleting definitions without checking references', 'renaming both copies blindly'],
                    nextInstruction: 'Locate both definitions and references, then remove or rename only the unintended duplicate.',
                };
            case 'unknown_trigger_effect':
                return {
                    recommendedTools: ['query_rules', 'query_scripted_triggers', 'query_scripted_effects', 'query_definition_by_name', 'workspace_symbols', ...referenceTools],
                    avoidTools: ['web_search as first step', 'renaming identifiers by guesswork'],
                    nextInstruction: 'Check local CWT rules and workspace/project/vanilla definitions first, then edit only the invalid trigger/effect reference.',
                };
            case 'stale_lsp_cache':
                return {
                    recommendedTools: ['get_diagnostics', 'query_definition_by_name', 'workspace_symbols', ...referenceTools],
                    avoidTools: ['duplicate localisation/entity creation', 'blind retries'],
                    nextInstruction: referenceVerificationRequired
                        ? 'Verify whether the concrete referenced entity/key already exists before writing again; wait for fresh diagnostics if global checks are pending.'
                        : 'No concrete reference was found. Do not search project/vanilla blindly; wait for fresh diagnostics or report degraded validation.',
                };
            case 'lsp_no_feedback':
                return {
                    recommendedTools: ['get_diagnostics'],
                    avoidTools: ['search_mod_files without a concrete identifier', 'duplicate entity/localisation creation', 'blind retries'],
                    nextInstruction: 'The LSP feedback path did not confirm semantic diagnostics. Do not search project/vanilla without a concrete diagnostic identifier; use the degraded validation warning as a caveat or retry get_diagnostics later.',
                };
            default:
                return {
                    recommendedTools: requiredFreshRead
                        ? ['read_file', 'get_file_context', 'get_diagnostics']
                        : ['get_file_context', 'query_rules', 'get_diagnostics', ...referenceTools],
                    avoidTools: ['blind write retries'],
                    nextInstruction: `Gather narrower file context and rule data, then choose the smallest safe edit.${staleHint}`,
                };
        }
    }

    private diagnosticConfidence(
        category: DiagnosticAnalysisCategory,
        diagnosticCount: number,
        source: AnalyzeDiagnosticErrorResult['source'],
    ): number {
        if (category === 'unknown') return diagnosticCount > 0 ? 0.45 : 0.3;
        if (source === 'snapshot') return 0.9;
        if (source === 'get_diagnostics') return 0.85;
        return 0.65;
    }

    private recordDiagnosticAnalysis(hash: string): number {
        const now = Date.now();
        for (const [key, entry] of Array.from(this.diagnosticAnalysisCounts.entries())) {
            if (now - entry.lastSeen > 30 * 60_000) {
                this.diagnosticAnalysisCounts.delete(key);
            }
        }
        const current = this.diagnosticAnalysisCounts.get(hash);
        const next = { count: (current?.count ?? 0) + 1, lastSeen: now };
        this.diagnosticAnalysisCounts.set(hash, next);
        return next.count;
    }

    private hashText(text: string): string {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    private asString(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private asNumber(value: unknown): number {
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    private normalizeSeverity(value: unknown): DiagnosticEntry['severity'] {
        const severity = String(value ?? 'error').toLowerCase();
        if (severity === 'warning' || severity === 'info' || severity === 'hint') return severity;
        return 'error';
    }

    private normalizeDiagnosticCategory(value: unknown): DiagnosticEntry['category'] {
        const category = String(value ?? '').toLowerCase();
        if ([
            'stale_lsp_cache',
            'missing_localisation',
            'unknown_sprite',
            'unknown_sound',
            'scope_mismatch',
            'unknown_trigger_effect',
            'brace_or_syntax_error',
            'invalid_value_type',
            'missing_definition',
            'duplicate_definition',
            'read_tracker_stale',
            'tool_argument_error',
            'lsp_no_feedback',
            'unknown',
        ].includes(category)) {
            return category as DiagnosticEntry['category'];
        }
        return undefined;
    }

    // - MCP Connection Pool -

    /** Per-server MCP connection pool.  Avoids re-connecting on every tool call
     *  during a reasoning loop (connect + initialize handshake can take 500ms+). */
    private mcpPool = new Map<string, { client: import('./mcpClient').MCPClient; lastUsed: number; timer: ReturnType<typeof setTimeout> }>();
    /** Idle timeout before an MCP connection is automatically disconnected (ms). */
    private static readonly MCP_IDLE_TIMEOUT_MS = 60_000;

    /** Get or create a pooled MCP client for the given server. */
    private async getMcpClient(serverName: string, abortSignal?: AbortSignal): Promise<import('./mcpClient').MCPClient> {
        const cached = this.mcpPool.get(serverName);
        if (cached) {
            cached.lastUsed = Date.now();
            // Reset idle timer
            clearTimeout(cached.timer);
            cached.timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
            return cached.client;
        }

        // Create new connection
        const { MCPClient } = await import('./mcpClient');
        const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const servers = config.get<any[]>('mcp.servers') || [];
        const serverConfig = servers.find((s: any) => s.name === serverName);
        if (!serverConfig) throw new Error(`MCP server "${serverName}" not found in configuration`);

        const client = new MCPClient({
            name: serverConfig.name,
            type: serverConfig.type,
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
            url: serverConfig.url,
        });
        await client.connect(abortSignal);

        const timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
        this.mcpPool.set(serverName, { client, lastUsed: Date.now(), timer });
        return client;
    }

    /** Disconnect and remove a pooled MCP client. */
    private evictMcpClient(serverName: string): void {
        const entry = this.mcpPool.get(serverName);
        if (entry) {
            clearTimeout(entry.timer);
            try { entry.client.disconnect(); } catch { /* ignore */ }
            this.mcpPool.delete(serverName);
        }
    }

    /** Disconnect all pooled MCP clients (call on extension deactivate). */
    disposeMcpPool(): void {
        for (const [name] of this.mcpPool) {
            this.evictMcpClient(name);
        }
    }

    private dynamicMcpToolCache?: {
        domain: import('./types').AgentRuntimeDomain;
        at: number;
        defs: import('./types').ToolDefinition[];
    };
    /** Reverse map for registered dynamic names — avoids ambiguous parsing when server names contain '_'. */
    private dynamicMcpToolNames = new Map<string, { server: string; tool: string }>();
    private static readonly MCP_TOOL_CACHE_TTL_MS = 300_000;

    /** List configured MCP servers' tools as mcp_<server>_<tool> definitions. Opt-in; metadata is untrusted. */
    async getDynamicMcpToolDefinitions(
        mode: import('./types').AgentMode,
        domain?: import('./types').AgentRuntimeDomain,
    ): Promise<import('./types').ToolDefinition[]> {
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        if (cfg.get<boolean>('mcp.registerDynamicTools', false) !== true) return [];
        const { isToolAllowedForMode } = require('./tools/permissions') as typeof import('./tools/permissions');
        if (!isToolAllowedForMode('mcp_call', mode, domain)) return [];

        const runtimeDomain = domain ?? defaultDomainForMode(mode);
        if (this.dynamicMcpToolCache
            && this.dynamicMcpToolCache.domain === runtimeDomain
            && Date.now() - this.dynamicMcpToolCache.at < AgentToolExecutor.MCP_TOOL_CACHE_TTL_MS) {
            return this.dynamicMcpToolCache.defs;
        }
        const servers = cfg.get<import('./types').MCPServerConfig[]>('mcp.servers') || [];
        const defs: import('./types').ToolDefinition[] = [];
        const nameMap = new Map<string, { server: string; tool: string }>();
        for (const server of servers) {
            const serverName = server?.name;
            if (!serverName || (server as { enabled?: boolean }).enabled === false
                || !isMcpServerAllowedForDomain(server, runtimeDomain)) continue;
            try {
                const client = await this.getMcpClient(serverName);
                const listed = await Promise.race([
                    client.listTools(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 8000)),
                ]) as any;
                for (const tool of listed?.tools ?? []) {
                    if (!tool?.name) continue;
                    const description = String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 300);
                    const dynamicName = `mcp_${serverName}_${tool.name}`;
                    nameMap.set(dynamicName, { server: serverName, tool: tool.name });
                    defs.push({
                        type: 'function',
                        function: {
                            name: dynamicName,
                            description: `[MCP:${serverName}] ${description}`,
                            parameters: (tool.inputSchema && typeof tool.inputSchema === 'object')
                                ? tool.inputSchema
                                : { type: 'object', properties: {} },
                        },
                    } as import('./types').ToolDefinition);
                }
            } catch (e) {
                const { ErrorReporter } = require('./errorReporter') as typeof import('./errorReporter');
                ErrorReporter.debug('mcp', `Dynamic tool listing failed for server '${serverName}'`, e);
            }
        }
        this.dynamicMcpToolNames = nameMap;
        this.dynamicMcpToolCache = { domain: runtimeDomain, at: Date.now(), defs };
        return defs;
    }

    // - MCP Tool Execution -

    /**
     * Execute a tool call via MCP (Model Context Protocol).
     * Uses a per-server connection pool to avoid reconnect overhead.
     * Supports both generic mcp_call (with server + tool in args) and
     * named mcp_<server>_<tool> patterns.
     */
    private async executeMcpTool(args: {
        server?: string;
        tool?: string;
        arguments?: Record<string, unknown>;
        _toolName?: string;
        [key: string]: unknown;
    }, context?: import('./types').AgentToolContext): Promise<{ success: boolean; result?: unknown; error?: string }> {
        let serverName = args.server;
        let toolName = args.tool;
        let isDynamicNameCall = false;

        // Resolve mcp_<server>_<tool>: registered map first, regex as fallback.
        if (!serverName && args._toolName) {
            isDynamicNameCall = true;
            const mapped = this.dynamicMcpToolNames.get(args._toolName);
            if (mapped) {
                serverName = mapped.server;
                toolName = mapped.tool;
            } else {
                const match = args._toolName.match(/^mcp_(.+?)_(.+)$/);
                if (match) {
                    serverName = match[1];
                    toolName = match[2];
                }
            }
        }

        if (!serverName || !toolName) {
            return { success: false, error: 'Missing server or tool name. Use mcp_call with server and tool args.' };
        }

        // Dynamic-name calls carry MCP arguments at the top level; mcp_call nests them under `arguments`.
        let callArgs: Record<string, unknown> = (args.arguments && typeof args.arguments === 'object')
            ? args.arguments as Record<string, unknown>
            : {};
        if (isDynamicNameCall && (!args.arguments || typeof args.arguments !== 'object')) {
            const { _toolName: _t, server: _s, tool: _tl, arguments: _a, ...rest } = args;
            callArgs = rest as Record<string, unknown>;
        }

        // Single policy chokepoint for both generic mcp_call and dynamic mcp_* names.
        // Sub-agents are denied by default unless an explicit allow pattern matches.
        const isSubAgent = !!context?.runnerOptions?.useSlimPrompt;
        let mcpRules: Record<string, string> | undefined;
        try {
            mcpRules = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<{ mcp?: Record<string, string> }>('permissions')?.mcp;
        } catch { /* configuration unavailable (tests) — fall back to defaults */ }
        const permission = evaluateMcpPermission(serverName, toolName, { isSubAgent, rules: mcpRules });
        if (!permission.allowed) {
            if (!isSubAgent && permission.action === 'ask' && context?.onPermissionRequest) {
                const permissionId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                const approved = await context.onPermissionRequest(
                    permissionId,
                    'mcp_call',
                    aiText(`AI requests to call MCP tool ${serverName}/${toolName}`, `AI 请求调用 MCP 工具 ${serverName}/${toolName}`),
                    undefined,
                    {
                        ...context,
                        preflight: {
                            riskLevel: 2,
                            classification: ['mcp'],
                            reasons: [permission.reason ?? `Matched MCP permission rule ${permission.matchedPattern ?? ''}`],
                            sandboxMode: 'mcp-server',
                            mcpServer: serverName,
                            mcpTool: toolName,
                        },
                    },
                );
                if (!approved) return { success: false, error: `User denied MCP tool ${serverName}/${toolName}.` };
            } else {
                return { success: false, error: permission.reason };
            }
        }

        const runtimeDomain = context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
        const configuredServers = vs.workspace.getConfiguration('stellarisLanguageServices.ai')
            .get<import('./types').MCPServerConfig[]>('mcp.servers', []);
        const configuredServer = configuredServers.find(server => server.name === serverName);
        if (!configuredServer) {
            return { success: false, error: `MCP server '${serverName}' not found in configuration.` };
        }
        if (!isMcpServerAllowedForDomain(configuredServer, runtimeDomain)) {
            return {
                success: false,
                error: `MCP server '${serverName}' is not explicitly enabled for the '${runtimeDomain}' capability domain.`,
            };
        }

        const CONNECTION_ERRORS = /ECONNREFUSED|EPIPE|disconnect|not connected|ECONNRESET/i;
        const abortSignal = context?.runnerOptions?.abortSignal;

        try {
            const client = await this.getMcpClient(serverName!, abortSignal);
            const result = await client.callTool(toolName!, callArgs, abortSignal);
            return { success: true, result };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            // Connection crash: evict dead client from pool, reconnect once, and retry
            if (CONNECTION_ERRORS.test(errMsg)) {
                this.evictMcpClient(serverName!);
                try {
                    const client = await this.getMcpClient(serverName!, abortSignal);
                    const result = await client.callTool(toolName!, callArgs, abortSignal);
                    return { success: true, result };
                } catch (retryErr) {
                    return { success: false, error: `MCP tool call failed after reconnect: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` };
                }
            }
            return { success: false, error: `MCP tool call failed: ${errMsg}` };
        }
    }

    /** Truncate large tool results to avoid overloading context window.
     * This is a safety-net for extreme cases - the smarter budgetToolResult
     * in agentRunner.ts handles normal-sized results with dedup/segmentation.
     */
    private truncateResult(result: unknown): unknown {
        const json = JSON.stringify(result);
        if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
        // For objects, extract known array fields and truncate them
        // rather than producing broken JSON
        if (typeof result === 'object' && result !== null) {
            return {
                _truncated: true,
                _originalLength: json.length,
                preview: budgetToolResult(result, 18000),
                _note: `Result exceeded ${MAX_TOOL_RESULT_CHARS} chars safety limit. Use targeted queries (add filter, limit, or file parameters) for smaller results.`,
            };
        }
        return result;
    }

    //- Orchestrator scheduling implementation -

    /**
     * Controllers for in-flight orchestrator dispatches.
     *
     * AgentToolExecutor is shared by top-level runs, so a single global
     * controller would let an unrelated retry/resume cancel another run's
     * sub-agents. Each dispatch instead follows only its own parent signal.
     */
    private readonly _activeDispatchAbortControllers = new Set<AbortController>();

    /** The latest coordinator execution result (read by merge_results) */
    private _lastOrchestratorResult?: import('./orchestrator/types').OrchestratorResult;
    private _lastOrchestratorGraph?: import('./orchestrator/types').TaskGraph;
    private _lastOrchestratorDomain?: import('./types').AgentRuntimeDomain;
    private _lastOrchestratorTopicId?: string;
    private readonly _orchestratorValidationByRun = new Map<string, {
        success: boolean;
        summary: string;
        pendingOnly?: boolean;
    }>();

    /** 
* Execute the dispatch_agents tool: convert the task array built by AI into TaskGraph, 
* Then trigger true multi-Agent parallel execution through Orchestrator.execute(). 
*/
    private async executeDispatchAgents(args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        let tasks = args.tasks as Array<{
            id: string;
            agentType: string;
            prompt: string;
            contextFiles?: string[];
            plannedFiles?: string[];
            plannedEntities?: string[];
            produces?: import('./orchestrator/types').TaskEntityContract[];
            consumes?: import('./orchestrator/types').TaskEntityContract[];
            acceptanceChecks?: import('./orchestrator/types').AcceptanceCheck[];
            dependencies?: string[];
            maxIterations?: number;
            modelOverride?: string;
            providerOverride?: string;
        }> | undefined;

        const runnerOptsForLimits = context?.runnerOptions ?? this.parentRunnerOptions;
        const originalUserMessage = runnerOptsForLimits?.originalUserMessage
            ?? (typeof args.userPrompt === 'string' ? args.userPrompt : undefined);
        const userExecutionPolicy = deriveUserExecutionPolicy(
            originalUserMessage,
            args.userConstraints,
        );
        const runtimeDomain = runnerOptsForLimits?.domain
            ?? (runnerOptsForLimits?.mode === 'orchestrator' ? 'general' : 'paradox');
        const isScriptMode = runtimeDomain === 'paradox' && runnerOptsForLimits?.mode === 'script';
        const requiresStructuredWriteContract = isScriptMode;
        let featureManifest = args.featureManifest as import('./types').FeatureManifest | undefined;
        const blueprintFile = typeof args.blueprintFile === 'string' ? args.blueprintFile.trim() : '';
        if ((runnerOptsForLimits?.mode === 'explore' || runnerOptsForLimits?.mode === 'plan') && blueprintFile) {
            return {
                success: false,
                error: `${runnerOptsForLimits.mode === 'explore' ? 'Explore' : 'Plan'} mode fan-out is read-only and cannot execute a blueprintFile task graph. Dispatch at most four bounded evidence tasks directly.`,
            };
        }
        if (runtimeDomain === 'general' && blueprintFile) {
            return { success: false, error: 'General Multi-Agent does not accept domain-specific design blueprints.' };
        }
        const maxTasksPerDispatch = blueprintFile ? 64 : isScriptMode ? 8 : 4;
        if (blueprintFile) {
            const resolvedBlueprint = path.isAbsolute(blueprintFile)
                ? path.resolve(blueprintFile)
                : path.resolve(this.workspaceRoot, blueprintFile);
            const relativeBlueprint = path.relative(this.workspaceRoot, resolvedBlueprint);
            const insideWorkspace = relativeBlueprint
                && !relativeBlueprint.startsWith('..')
                && !path.isAbsolute(relativeBlueprint);
            const normalizedRelative = relativeBlueprint.replace(/\\/g, '/').toLowerCase();
            const insideLegacyAiStorage = !!insideWorkspace
                && (normalizedRelative.includes('/.cwtools/') || normalizedRelative.startsWith('.cwtools/')
                    || normalizedRelative.includes('/.cwtools-ai/') || normalizedRelative.startsWith('.cwtools-ai/'));
            const privateStorageRoot = getPrivateAiStorageRoot(this.workspaceRoot);
            const insidePrivateStorage = !!privateStorageRoot && isPathInsideOrEqual(resolvedBlueprint, path.resolve(privateStorageRoot));
            if (!insideLegacyAiStorage && !insidePrivateStorage) {
                return { success: false, error: 'blueprintFile must be a topic-scoped design_blueprint.json inside the agent storage directory.' };
            }
            if (path.basename(resolvedBlueprint).toLowerCase() !== 'design_blueprint.json') {
                return { success: false, error: 'blueprintFile must point to design_blueprint.json.' };
            }
            const approvedTopicId = runnerOptsForLimits?.topicId;
            if (approvedTopicId) {
                const topicDirs = getPrivateTopicStorageDirCandidates(approvedTopicId, this.workspaceRoot)
                    .map(dir => path.resolve(dir));
                if (!topicDirs.some(dir => isPathInsideOrEqual(resolvedBlueprint, dir))) {
                    return { success: false, error: 'blueprintFile must belong to the current approved topic.' };
                }
            }
            try {
                const stat = fs.statSync(resolvedBlueprint);
                if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
                    return { success: false, error: 'Approved blueprint data is missing or exceeds the 2 MiB safety limit.' };
                }
                const approvedBlueprint = JSON.parse(fs.readFileSync(resolvedBlueprint, 'utf8')) as {
                    schemaVersion?: number;
                    featureManifest?: import('./types').FeatureManifest;
                    taskPlan?: typeof tasks;
                };
                if (approvedBlueprint.schemaVersion !== 2 || !approvedBlueprint.featureManifest || !Array.isArray(approvedBlueprint.taskPlan)) {
                    return { success: false, error: 'Approved blueprint data is not a valid schemaVersion 2 executable contract.' };
                }
                featureManifest = approvedBlueprint.featureManifest;
                tasks = approvedBlueprint.taskPlan;
            } catch (error) {
                return { success: false, error: `Failed to load approved blueprint contract: ${error instanceof Error ? error.message : String(error)}` };
            }
        }

        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            return { success: false, error: 'Provide tasks or blueprintFile. Each task must include id, agentType, and prompt.' };
        }

        if (tasks.length > maxTasksPerDispatch) {
            return {
                success: false,
                error: `Concurrency guard: attempted to dispatch ${tasks.length} tasks at once, above the current mode limit of ${maxTasksPerDispatch}. Long task lists can cause model timeout or truncation; split the work into smaller waves.`
            };
        }
        const normalizedTasks = tasks.map(task => normalizeDispatchTaskForLocalisationYml(task));
        if (userExecutionPolicy.localisationOwnership === 'user') {
            const localisationWriter = normalizedTasks.find(task =>
                task.agentType === 'loc_writer'
                || (Array.isArray(task.plannedFiles) && task.plannedFiles.some(isLocalisationYmlPath))
                || (Array.isArray(task.produces) && task.produces.some(contract =>
                    !!contract
                    && typeof contract === 'object'
                    && (contract.operation === 'localise'
                        || (typeof contract.kind === 'string' && contract.kind.toLowerCase() === 'localisation')))));
            if (localisationWriter) {
                return {
                    success: false,
                    error: aiText(
                        `Task '${localisationWriter.id}' conflicts with the user's retained ownership of localisation. Remove localisation writes from the graph and dispatch only the work the user delegated.`,
                        `任务“${localisationWriter.id}”与用户保留的本地化所有权冲突。请从任务图中移除本地化写入，只调度用户已经委派的工作。`,
                    ),
                    userExecutionPolicy,
                };
            }
        }
        const parentMode = runnerOptsForLimits?.mode;
        const readOnlyFanoutMode = parentMode === 'plan' || parentMode === 'explore';
        const allowedAgentTypes = new Set(readOnlyFanoutMode
            ? ['explore', 'plan', 'review']
            : runtimeDomain === 'general'
            ? ['explore', 'plan', 'utility', 'review']
            : parentMode === 'script'
                ? ['explore', 'plan', 'build', 'review', 'loc_writer', 'gui_expert']
            : parentMode === 'orchestrator'
                ? ['explore', 'plan', 'utility', 'review']
                // Compatibility for host-side callers created before the mode
                // was carried in AgentToolContext. Model-visible calls always
                // arrive with an explicit coordinator mode.
                : ['explore', 'plan', 'utility', 'review', 'build', 'loc_writer', 'gui_expert']);
        const profileRoles = runnerOptsForLimits?.agentProfileAllowedSubagents;
        if (profileRoles) {
            for (const role of [...allowedAgentTypes]) {
                if (!profileRoles.includes(role)) allowedAgentTypes.delete(role);
            }
        }
        const invalidAgentType = normalizedTasks.find(task => !allowedAgentTypes.has(task.agentType));
        if (invalidAgentType) {
            return {
                success: false,
                error: `Agent type '${invalidAgentType.agentType}' is not allowed in ${parentMode === 'plan' ? 'Plan' : parentMode === 'explore' ? 'Explore' : isScriptMode ? 'Paradox Multi-Agent' : 'General Multi-Agent'} mode. Allowed roles: ${[...allowedAgentTypes].join(', ')}.`,
            };
        }
        if (parentMode === 'explore') {
            const taskWithWriteIntent = normalizedTasks.find(task => (task.plannedFiles?.length ?? 0) > 0);
            if (taskWithWriteIntent) {
                return {
                    success: false,
                    error: `Explore mode fan-out is read-only. Task '${taskWithWriteIntent.id}' must not declare plannedFiles or any write intent.`,
                };
            }
        }
        const hasWriteTasks = normalizedTasks.some(task =>
            ['build', 'loc_writer', 'gui_expert', 'utility'].includes(task.agentType)
            || (task.plannedFiles?.length ?? 0) > 0
        );
        const evaluatedDispatchAdmission = evaluateDispatchAdmission(
            normalizedTasks.map(task => ({
                id: task.id,
                objective: task.prompt,
                dependencies: task.dependencies,
                expectedWrites: task.plannedFiles,
                acceptanceCriteria: task.acceptanceChecks?.map(check => check.description),
                role: task.agentType,
            })),
            {
                explicitDelegation: runnerOptsForLimits?.schedulingState?.dispatch !== 'single'
                    || parentMode === 'orchestrator'
                    || parentMode === 'script',
                availableTokenBudget: runnerOptsForLimits?.tokenBudget,
            },
        );
        // Stored coordinator workflows and host-side callers historically used
        // a one-node graph for isolation. Preserve that compatibility while
        // requiring two independent nodes for the new build/utility runtime
        // dispatch path.
        const legacySingleNodeCoordinator = normalizedTasks.length === 1
            && (!parentMode || parentMode === 'orchestrator' || parentMode === 'script' || !!blueprintFile);
        const dispatchAdmission = legacySingleNodeCoordinator
            ? {
                accepted: true,
                score: 0,
                reason: 'Legacy coordinator single-node compatibility.',
                conflicts: [],
            }
            : evaluatedDispatchAdmission;
        runnerOptsForLimits?.runEventSink?.appendSoon('dispatch_evaluated', {
            accepted: dispatchAdmission.accepted,
            score: dispatchAdmission.score,
            reason: dispatchAdmission.reason,
            taskCount: normalizedTasks.length,
            conflicts: dispatchAdmission.conflicts,
        }, { status: dispatchAdmission.accepted ? 'done' : 'failed' });
        if (!dispatchAdmission.accepted) {
            return {
                success: false,
                error: `Runtime dispatch admission rejected this graph: ${dispatchAdmission.reason}`,
                dispatchAdmission,
            };
        }
        if (runnerOptsForLimits?.schedulingState?.dispatch === 'single') {
            runnerOptsForLimits.schedulingState = transitionSchedulingState(
                runnerOptsForLimits.schedulingState,
                {
                    dispatch: 'parallel',
                    reason: dispatchAdmission.reason,
                    dispatchReason: dispatchAdmission.reason,
                },
            );
        }
        if (requiresStructuredWriteContract && hasWriteTasks) {
            const invalidWriter = normalizedTasks.find(task =>
                ['build', 'loc_writer', 'gui_expert'].includes(task.agentType)
                && (task.produces?.length ?? 0) === 0
                && (task.consumes?.length ?? 0) === 0
            );
            const orphanLocWriter = normalizedTasks.find(task =>
                task.agentType === 'loc_writer'
                && task.produces?.some(contract => contract.kind === 'localisation')
                && !task.consumes?.some(contract => contract.kind !== 'localisation')
            );
            if (!featureManifest?.objective || (featureManifest.acceptanceCriteria?.length ?? 0) === 0) {
                return {
                    success: false,
                    error: aiText(
                        'Paradox Multi-Agent write waves require featureManifest with an objective and at least one acceptance criterion. Declare the required entities/edges before dispatching writers.',
                        'Paradox 多 Agent 写入批次必须提供 featureManifest，其中包含目标和至少一条验收条件。请先声明所需实体与关联边。',
                    ),
                };
            }
            if (invalidWriter) {
                return {
                    success: false,
                    error: aiText(
                        `Paradox Multi-Agent writer '${invalidWriter.id}' must declare produces and/or consumes entity contracts.`,
                        `Paradox 多 Agent 写入节点“${invalidWriter.id}”必须声明 produces 和/或 consumes 实体契约。`,
                    ),
                };
            }
            if (orphanLocWriter) {
                return {
                    success: false,
                    error: aiText(
                        `Localisation writer '${orphanLocWriter.id}' must consume its owning event/object entity so dependency ordering and orphan checks can be enforced.`,
                        `本地化写入节点“${orphanLocWriter.id}”必须通过 consumes 声明其所属事件或对象，系统才能强制依赖顺序并检查孤立本地化。`,
                    ),
                };
            }
            featureManifest = { ...featureManifest, expectsFileChanges: featureManifest.expectsFileChanges ?? true };
        }

        // Phase 3: reject over-privileged child tasks at dispatch time.
        {
            const { clampWriteScopeToRoots } = require('./runner/policyEngine') as typeof import('./runner/policyEngine');
            for (const task of normalizedTasks) {
                if (!Array.isArray(task.plannedFiles) || task.plannedFiles.length === 0) continue;
                const { rejected } = clampWriteScopeToRoots(task.plannedFiles, [this.workspaceRoot], this.workspaceRoot);
                if (rejected.length > 0) {
                    return {
                        success: false,
                        error: `Task '${task.id}' plans writes outside the workspace sandbox: ${rejected.join(', ')}. Sub-agents cannot exceed the parent's writable roots — re-plan those files inside the workspace, or drop them from plannedFiles.`,
                    };
                }
            }
        }

        // Make sure there is a parentAgentRunner (the Orchestrator needs it to schedule child Agents)
        if (!this.parentAgentRunner) {
            return { success: false, error: 'Orchestrator is not ready: missing AgentRunner instance. Run in a coordinator-capable mode.' };
        }

        const localAbort = new AbortController();
        this._activeDispatchAbortControllers.add(localAbort);
        const globalSignal = runnerOptsForLimits?.abortSignal;
        const onGlobalAbort = () => localAbort.abort(globalSignal?.reason);
        if (globalSignal?.aborted) {
            onGlobalAbort();
        } else {
            globalSignal?.addEventListener('abort', onGlobalAbort, { once: true });
        }

        try {
            //Dynamic import avoids circular dependencies
            const { Orchestrator } = await import('./orchestrator/orchestrator');
            const { TaskGraphEngine } = await import('./orchestrator/taskGraphEngine');
            const { applyUserModelOverrides } = await import('./orchestrator/agentRegistry');
            //Apply user's child Agent model configuration (read from VS Code settings)
            const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
            const agentModels = cfg.get<Record<string, { provider: string; model: string }>>('orchestrator.agentModels');
            if (agentModels) {
                applyUserModelOverrides(agentModels);
            }

            // Build TaskGraph
            const userPrompt = originalUserMessage || featureManifest?.objective || 'Multi-agent collaboration task';
            const graph = TaskGraphEngine.createGraph(userPrompt, featureManifest);
            graph.metadata.userExecutionPolicy = userExecutionPolicy;

            for (const task of normalizedTasks) {
                TaskGraphEngine.addNode(
                    graph,
                    task.id,
                    task.agentType as import('./types').AgentMode,
                    task.prompt,
                    {
                        contextFiles: task.contextFiles,
                        plannedFiles: task.plannedFiles,
                        plannedEntities: task.plannedEntities,
                        produces: task.produces,
                        consumes: task.consumes,
                        acceptanceChecks: task.acceptanceChecks,
                        dependencies: task.dependencies || [],
                        maxIterations: task.maxIterations,
                        modelOverride: task.modelOverride,
                        providerOverride: task.providerOverride,
                    },
                );
            }
            TaskGraphEngine.linkEntityDependencies(graph);

            // Instantiate Orchestrator
            const orchestrator = new Orchestrator(this.parentAgentRunner, {
                maxConcurrency: isScriptMode ? Math.min(8, Math.max(1, normalizedTasks.length)) : undefined,
            });
            const parentRunPromise = context?.agentRunner?.getActiveRunRecordPromise?.()
                ?? this.parentAgentRunner.getActiveRunRecordPromise?.();
            const parentRun = runnerOptsForLimits?.runRecord
                ?? await parentRunPromise?.catch(() => undefined);

            // Build execution options (read first from AgentToolContext, fallback to old instance fields)
            const runnerOpts = runnerOptsForLimits;
            const parentRunSink = context?.runEventSink ?? runnerOpts?.runEventSink;
            this.blackboard.setEventSink(parentRunSink);

            const onBeforeFileWrite =
                context?.onBeforeFileWrite
                ?? runnerOpts?.onBeforeFileWrite
                ?? this.onBeforeFileWrite;

            const options: import('./orchestrator/types').OrchestratorOptions = {
                domain: runnerOpts?.domain ?? (parentMode === 'orchestrator' ? 'general' : 'paradox'),
                providerId: runnerOpts?.providerId,
                model: runnerOpts?.model,
                reasoningEffort: runnerOpts?.reasoningEffort,
                abortSignal: localAbort.signal,
                topicId: runnerOpts?.topicId,
                parentRunId: parentRun?.runId ?? parentRunSink?.runId,
                durableGoal: runnerOpts?.durableGoal,
                readOnlyFanout: parentMode === 'explore',
                originalUserMessage,
                userExecutionPolicy,
                runEventSink: parentRunSink,
                onStep: context?.onStep,
                onBeforeFileWrite,
                onTodoUpdate: context?.onTodoUpdate || runnerOpts?.onTodoUpdate,
                onPermissionRequest: context?.onPermissionRequest
                    ?? runnerOpts?.onPermissionRequest
                    ?? this.onPermissionRequest,
            };

            // Push initial progress
            options.onStep?.({
                type: 'thinking',
                content: `Coordinator started: dispatching ${normalizedTasks.length} sub-agent task(s).`,
                timestamp: Date.now(),
            });
            if (parentRunSink) {
                for (const task of normalizedTasks) {
                    await parentRunSink.append(
                        'subagent_start',
                        {
                            taskNodeId: task.id,
                            agentType: task.agentType,
                            plannedFiles: task.plannedFiles ?? [],
                            plannedEntities: task.plannedEntities ?? [],
                            dependencies: task.dependencies ?? [],
                        },
                        { agentId: task.id, status: 'running' }
                    ).catch(() => {});
                }
            }

            // A later dispatch may belong to another top-level run and must
            // not replace or cancel this graph.
            const result = await orchestrator.execute(graph, options);
            mergeTokenUsageTotals(context?.tokenAccumulator, result.totalTokenUsage);

            // Cache results for use by merge_results
            this._lastOrchestratorResult = result;
            this._lastOrchestratorGraph = graph;
            this._lastOrchestratorDomain = runtimeDomain;
            this._lastOrchestratorTopicId = runnerOpts?.topicId;
            const validationRunId = parentRun?.runId ?? parentRunSink?.runId;
            if (validationRunId && (hasWriteTasks || result.qualityGate !== undefined)) {
                this._orchestratorValidationByRun.set(validationRunId, {
                    // A later quality-gated repair wave supersedes an earlier failed write wave.
                    // Read-only fanout waves do not overwrite this validation state.
                    success: result.success,
                    summary: result.summary,
                    pendingOnly: !!result.qualityGate
                        && (result.qualityGate.validationPending ?? 0) > 0
                        && result.qualityGate.operationalFailure !== true
                        && result.qualityGate.diagnosticErrors === 0
                        && (result.qualityGate.evidenceConflicts ?? 0) === 0
                        && result.qualityGate.semanticIssues === 0
                        && result.qualityGate.logicIssues === 0
                        && result.qualityGate.acceptanceFailures.length === 0,
                });
                while (this._orchestratorValidationByRun.size > 100) {
                    const oldest = this._orchestratorValidationByRun.keys().next().value as string | undefined;
                    if (!oldest) break;
                    this._orchestratorValidationByRun.delete(oldest);
                }
            }

            //Write execution results to Blackboard for subsequent query
            this.blackboard.write(
                `${blackboardDomainPrefix(context)}orchestrator:lastResult`,
                JSON.stringify({
                    success: result.success,
                    summary: result.summary,
                    totalTokenUsage: result.totalTokenUsage,
                    failedNodes: result.failedNodes,
                    cancelledNodes: result.cancelledNodes,
                }),
                'free_text',
                '__orchestrator__',
            );

            // Keep the parent Agent context compact while preserving enough detail for the final global walkthrough.
            const agentSummaries: Array<{
                id: string;
                agentType?: string;
                prompt?: string;
                dependencies?: string[];
                plannedFiles?: string[];
                plannedEntities?: string[];
                produces?: import('./orchestrator/types').TaskEntityContract[];
                consumes?: import('./orchestrator/types').TaskEntityContract[];
                success: boolean;
                filesWritten: string[];
                tokenUsed: number;
                stepCount?: number;
                outputSummary?: string;
                verification?: string[];
                unresolved?: string[];
                error?: string;
                needsClarification?: boolean;
                clarification?: string;
            }> = [];
            const clarifications: Array<{ id: string; clarification: string }> = [];
            for (const [id, agentResult] of result.agentResults) {
                if (agentResult.needsClarification && agentResult.clarification) {
                    clarifications.push({ id, clarification: agentResult.clarification.slice(0, 4000) });
                }
                if (parentRunSink) {
                    await parentRunSink.append(
                        'subagent_end',
                        {
                            taskNodeId: id,
                            success: agentResult.success,
                            filesWritten: agentResult.writtenFiles,
                            tokenUsage: agentResult.tokenUsage,
                            stepCount: agentResult.stepCount,
                            error: agentResult.error,
                            needsClarification: agentResult.needsClarification,
                            clarification: agentResult.clarification,
                            handoff: agentResult.handoff,
                        },
                        { agentId: id, status: agentResult.success ? 'done' : 'failed' }
                    ).catch(() => {});
                    for (const filePath of agentResult.writtenFiles ?? []) {
                        if (typeof filePath !== 'string' || !filePath) continue;
                        await parentRunSink.append(
                            'file_change',
                            { filePath, source: 'subagent', taskNodeId: id },
                            { agentId: id, status: agentResult.success ? 'done' : 'failed' }
                        ).catch(() => {});
                    }
                }
                const taskMeta = normalizedTasks.find(task => task.id === id);
                agentSummaries.push({
                    id,
                    agentType: taskMeta?.agentType,
                    prompt: taskMeta?.prompt,
                    dependencies: taskMeta?.dependencies ?? [],
                    plannedFiles: taskMeta?.plannedFiles ?? [],
                    plannedEntities: taskMeta?.plannedEntities ?? [],
                    produces: taskMeta?.produces ?? [],
                    consumes: taskMeta?.consumes ?? [],
                    success: agentResult.success,
                    filesWritten: [...new Set([
                        ...agentResult.writtenFiles,
                        ...(agentResult.handoff?.changedFiles ?? []),
                    ])].sort(),
                    tokenUsed: agentResult.tokenUsage.total,
                    stepCount: agentResult.stepCount,
                    outputSummary: compactAgentOutputForReport(agentResult.handoff?.summary ?? agentResult.output),
                    verification: agentResult.handoff?.verification,
                    unresolved: agentResult.handoff?.unresolved,
                    error: agentResult.error ? agentResult.error.slice(0, 1000) : undefined,
                    needsClarification: agentResult.needsClarification,
                    clarification: agentResult.clarification ? agentResult.clarification.slice(0, 2000) : undefined,
                });
            }

            return {
                success: result.success,
                summary: result.summary,
                totalTokens: result.totalTokenUsage.total,
                estimatedCostCny: result.totalTokenUsage.estimatedCostCny,
                agents: agentSummaries,
                failedNodes: result.failedNodes,
                cancelledNodes: result.cancelledNodes,
                clarifications,
                hint: clarifications.length > 0
                    ? 'One or more sub-agents escalated a decision to the parent agent. The parent agent should decide from the approved plan and available context when safe. Ask the user in the main chat only if the parent agent cannot make a safe decision, then dispatch a follow-up batch after the answer.'
                    : 'To view the detailed output of each sub-agent, use the merge_results tool.',
            };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            return { success: false, error: `Coordinator execution failed: ${errMsg}` };
        } finally {
            globalSignal?.removeEventListener('abort', onGlobalAbort);
            this._activeDispatchAbortControllers.delete(localAbort);
        }
    }

    /** 
* Execute the merge_results tool: extract a summary from the results of the most recent coordinator execution. 
*/
    private executeMergeResults(args: Record<string, unknown>, context?: import('./types').AgentToolContext): unknown {
        const requestedDomain = context?.runnerOptions?.domain
            ?? defaultDomainForMode(context?.runnerOptions?.mode ?? 'build');
        const requestedTopicId = context?.runnerOptions?.topicId;
        const cachedResultMatchesScope = !!this._lastOrchestratorResult
            && (this._lastOrchestratorDomain === undefined
                || (this._lastOrchestratorDomain === requestedDomain
                    && (this._lastOrchestratorTopicId === undefined
                        || requestedTopicId === this._lastOrchestratorTopicId)));
        if (!cachedResultMatchesScope) {
            //Try to read from Blackboard
            const stored = this.blackboard.readValue(`${blackboardDomainPrefix(context)}orchestrator:lastResult`)
                ?? (requestedDomain === 'paradox' ? this.blackboard.readValue('orchestrator:lastResult') : undefined);
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    return {
                        success: false,
                        ...parsed,
                        source: 'blackboard',
                        message: 'Detailed node outputs are no longer in memory, so the requested nodeIds cannot be merged safely. Dispatch a new verification/integration wave.',
                    };
                } catch {
                    return { success: false, message: 'Failed to find the most recent orchestrator execution result. Please use dispatch_agents first.' };
                }
            }
            return { success: false, message: 'Failed to find the most recent orchestrator execution result. Please use dispatch_agents first.' };
        }

        const r = this._lastOrchestratorResult!;
        const graph = this._lastOrchestratorGraph;
        const requestedNodeIds = Array.isArray(args.nodeIds)
            ? args.nodeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : [];
        if (requestedNodeIds.length === 0) {
            return { success: false, message: 'merge_results requires at least one nodeIds entry.' };
        }
        const unknownNodeIds = requestedNodeIds.filter(id => !r.agentResults.has(id));
        if (unknownNodeIds.length > 0) {
            return { success: false, message: `Unknown or unavailable task node IDs: ${unknownNodeIds.join(', ')}` };
        }
        const strategy = args.strategy === 'concatenate' || args.strategy === 'summary' ? args.strategy : 'structured';
        const selectedIds = [...new Set(requestedNodeIds)];
        const allWrittenFiles = new Set<string>();
        const agentOutputs: Array<{
            id: string;
            output: string;
            files: string[];
            verification?: string[];
            unresolved?: string[];
        }> = [];

        //Smart truncation: the upper limit for a single Agent is 2000 characters, and the total budget is 8000 characters
        const MAX_PER_AGENT = 2000;
        const MAX_TOTAL = 8000;
        let totalOutputLen = 0;

        for (const id of selectedIds) {
            const agentResult = r.agentResults.get(id)!;
            const files = [...new Set([
                ...agentResult.writtenFiles,
                ...(agentResult.handoff?.changedFiles ?? []),
            ])].sort();
            for (const file of files) allWrittenFiles.add(file);
            const remaining = Math.max(0, MAX_TOTAL - totalOutputLen);
            const perAgentLimit = strategy === 'concatenate' ? MAX_PER_AGENT : strategy === 'summary' ? 800 : 1200;
            const limit = Math.min(perAgentLimit, remaining);
            let output = agentResult.handoff?.summary ?? agentResult.output;
            if (output.length > limit) {
                output = compactAgentOutputForReport(output, limit) || '';
            }
            totalOutputLen += output.length;
            agentOutputs.push({
                id,
                output,
                files,
                verification: agentResult.handoff?.verification,
                unresolved: agentResult.handoff?.unresolved,
            });
        }

        const fileGroups = [...allWrittenFiles].map(file => ({
            file,
            nodeIds: selectedIds.filter(id => {
                const result = r.agentResults.get(id);
                return result?.writtenFiles.includes(file) || result?.handoff?.changedFiles.includes(file);
            }),
        }));
        const entityContracts = selectedIds.map(id => {
            const node = graph?.nodes.get(id);
            return {
                nodeId: id,
                produces: node?.produces ?? [],
                consumes: node?.consumes ?? [],
                acceptanceChecks: node?.acceptanceChecks ?? [],
                dependencies: node?.dependencies ?? [],
            };
        });
        const selectedSucceeded = selectedIds.every(id => r.agentResults.get(id)?.success === true);
        const mergedOutput = strategy === 'concatenate'
            ? agentOutputs.map(item => `## ${item.id}\n${item.output}`).join('\n\n')
            : undefined;

        return {
            success: true,
            overallSuccess: r.success && selectedSucceeded,
            strategy,
            selectedNodeIds: selectedIds,
            summary: r.summary,
            totalTokens: r.totalTokenUsage.total,
            estimatedCostCny: r.totalTokenUsage.estimatedCostCny,
            totalFilesWritten: allWrittenFiles.size,
            writtenFiles: [...allWrittenFiles],
            fileGroups,
            agentOutputs,
            mergedOutput,
            integration: {
                featureManifest: graph?.metadata.featureManifest,
                entityContracts,
                qualityGate: r.qualityGate,
            },
            failedNodes: r.failedNodes,
            cancelledNodes: r.cancelledNodes,
        };
    }

    // - Public accessors for external consumers -

    getTodos(agentId?: string): TodoItem[] { return this.externalHandler.getTodos(agentId); }
    restoreTodos(todos: readonly TodoItem[], agentId?: string): void {
        this.externalHandler.restoreTodos(todos, agentId);
        this.onTodoUpdate?.(this.externalHandler.getTodos(agentId), agentId ? { agentId } : undefined);
    }
    clearTodos(agentId?: string): void { this.externalHandler.clearTodos(agentId); }
    clearOrchestratorValidation(runId: string): void { this._orchestratorValidationByRun.delete(runId); }
    getOrchestratorValidation(runId: string): { success: boolean; summary: string; pendingOnly?: boolean } | undefined {
        return this._orchestratorValidationByRun.get(runId);
    }
}
