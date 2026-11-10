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

// Import handler classes
import { FileToolHandler, findFiles } from './tools/fileTools';
import { LspToolHandler } from './tools/lspTools';
import { ExternalToolHandler } from './tools/externalTools';
import { MemoryToolHandler } from './tools/memoryTools';
import { searchAgentHistory } from './tools/historyTool';
import type { IndexService } from '../indexing/indexService';
import { validateToolCapability, evaluateMcpPermission } from './tools/permissions';
import { shouldBypassWriteConfirmation } from './tools/writeConfirmation';
import { readProjectProfile, queryProjectProfile } from './projectProfile';
import { queryProjectKnowledge } from './projectKnowledge';
import { queryInterfaceKnowledge } from './interfaceKnowledge';
// The targeting-weight formula lives in cwtools-shared so the MCP surface, the
// agent and the analysis panel all compute identical numbers from one source.
import { executeTargetingWeightQuery } from 'cwtools-shared';
import { validateOffCanvasGuiPreservation } from '../guiSafety';
import { loadSkill } from './skills';
import { saveSkill as saveSkillFile } from './skillsWriter';
import { getExperienceProjectionPath, getExperienceStoreFilePath } from './experienceStore';
import { isPlanModeCardArtifactFile, validateGitOpsForMode, validatePlanModeToolUse } from './planModeGuard';
import { budgetToolResult, TOOL_RESULT_BUDGET_HARD_STUB } from './contextBudget';
import { aiText, EVIDENCE_GATE_MSG } from './messages';
import { getPrivateAiStorageRoot, getPrivateTopicStorageDir } from './workspacePaths';
import { isPathInsideOrEqual } from '../pathScope';
import { TOOL_REGISTRY, WRITE_TOOLS } from './tools/registry';
import { runAgentHooks } from './runner/hookRunner';
import { getAgentToolTargetFiles } from './runner/toolScheduler';
import { buildProfile, resolvePolicy, subjectForEffect, type PolicyRule } from './runner/policyEngine';
import { evaluateEffectiveToolPolicy } from './runner/effectiveToolPolicy';
import { sessionFileWriteMode } from './runner/sessionPermissions';
import type { ApiKeyManager } from './aiService';
import type { WebSearchProvider } from './tools/webAccess';
import { EvidenceGate, type EvidenceCallRecord } from './evidence/evidenceGate';
import { normalizeEvidenceGateMode, type EvidenceClaimKind, type EvidenceGateDecision, type EvidenceGateMode, type EvidenceGatePhase } from './evidence/evidenceTypes';
import { isPdxScriptTarget } from './evidence/claimExtractor';
import { runLedger } from './runner/runLedger';
import { ErrorReporter } from './errorReporter';
import { isDiagnosticRelevantFile, selectRevalidateTargets } from '../diagnosticRevalidation';
import { MemoryParser } from './memoryParser';
import { createDiagnosticSnapshot, diffDiagnosticSnapshots, hasAddedErrors, type DiagnosticDelta } from './runner/diagnosticSnapshot';
import { CandidateTransactionManager, sha256 } from './runner/candidateTransaction';
import { buildTypedPdxCandidate } from './tools/typedPdxWrite';
import { globalPartitionedWriteQueue } from './runner/writeCoordinator';
import { validateOverlayCatalog } from './runner/overlayCatalog';
import { solveScopeBridge, type ScopeBridgeCandidate } from './tools/scopeBridge';
import { HostArchetypeArtifactStore } from './tools/archetypeArtifacts';
import { canonicalPathKey } from './workspacePaths';
import { agentProfileCatalog } from './runner/agentProfileCatalog';
import { isMcpServerAllowedForDomain } from './mcpCapability';
import { getCwtoolsHomeDir } from './homeConfig';
import {
    loadMcpServerFileConfigs,
    mergeMcpServerConfigs,
    type SourcedMCPServerConfig,
} from './mcpConfig';
import {
    AUTHORITY_RANK,
    authorizationAllowsEffect,
    executionModeForSchedulingState,
    transitionSchedulingState,
} from './runner/scheduling';
import { goalStore, type DurableGoalStatus } from './runner/goalStore';
import { goalSupervisor } from './runner/goalSupervisor';
import { agentTaskManager } from './runner/taskManager';
import { configureSandboxStorage } from './workspaceSandbox';

const MAX_TOOL_RESULT_CHARS = TOOL_RESULT_BUDGET_HARD_STUB;
const FINAL_EVIDENCE_CONCURRENCY = 4;


const AUTHORITATIVE_MEMORY_EVIDENCE_TOOLS = new Set<string>([
    'read_file',
    'query_rules',
    'query_cwt_schema',
    'query_project_profile',
    'query_project_knowledge',
    'query_scope',
    'query_types',
    'go_to_definition',
    'find_references',
    'verify_pdx_identifier',
    'workspace_symbols',
    'document_symbols',
    'explore_pdx_project',
    'query_inline_instantiation',
    'analyze_pdx_flow',
    'compare_definition_with_vanilla',
    'grep',
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
    /** Fresh full-file diagnostics superseded contradictory evidence claims diagnostics can authoritatively cover. */
    diagnosticsSupersededEvidenceConflicts?: boolean;
    /** Back-compat flag for callers that only understood fragment-only syntax conflicts. */
    diagnosticsSupersededSyntaxConflict?: boolean;
    diagnosticsSupersededConflictKinds?: EvidenceClaimKind[];
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

const DIAGNOSTIC_SUPERSEDABLE_EVIDENCE_KINDS: ReadonlySet<EvidenceClaimKind> = new Set([
    'syntax_shape',
    'scope_compatibility',
    'symbol_exists',
    'reference_exists',
]);

function diagnosticsCanSupersedeEvidenceConflict(claim: EvidenceGateDecision['claims'][number]): boolean {
    return claim.status === 'conflict'
        && claim.blocking === true
        && DIAGNOSTIC_SUPERSEDABLE_EVIDENCE_KINDS.has(claim.kind);
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
    const diagnosticDelta = result.diagnosticDelta && typeof result.diagnosticDelta === 'object'
        ? result.diagnosticDelta as DiagnosticDelta
        : undefined;
    const comparableDelta = diagnosticDelta?.comparable === true;
    const introducedDiagnosticErrors = comparableDelta ? hasAddedErrors(diagnosticDelta) : undefined;
    const freshness = result.freshness === 'fresh' || result.freshness === 'pending' || result.freshness === 'stale'
        ? result.freshness
        : undefined;
    const blockingClaims = decision?.claims.filter(claim => claim.blocking) ?? [];
    const hasNoReportedDiagnosticErrors = comparableDelta
        ? introducedDiagnosticErrors === false
        : diagnosticErrors !== undefined && diagnosticErrors.length === 0;
    // A pending/stale global refresh is not itself a defect. When deterministic
    // post-write evidence passed and the latest available file diagnostics report
    // no errors, accept the write instead of re-running repair agents indefinitely.
    const diagnosticsPassed = freshness === 'fresh'
        ? hasNoReportedDiagnosticErrors
        : freshness === 'pending' || freshness === 'stale';
    const supersededConflicts = freshness === 'fresh' && diagnosticsPassed
        ? blockingClaims.filter(diagnosticsCanSupersedeEvidenceConflict)
        : [];
    const supersededConflictSet = new Set(supersededConflicts);
    const diagnosticsSupersededEvidenceConflicts = supersededConflicts.length > 0;
    const supersededConflictKinds = Array.from(new Set(supersededConflicts.map(claim => claim.kind))).sort();
    const diagnosticsSupersededSyntaxConflict = supersededConflictKinds.includes('syntax_shape');
    const hasConflict = blockingClaims.some(claim =>
        claim.status === 'conflict'
        && !supersededConflictSet.has(claim));
    const evidencePassed = decision !== undefined
        && decision.degraded !== true
        && blockingClaims.every(claim => claim.status === 'verified'
            || supersededConflictSet.has(claim));
    const repair = hasConflict || (freshness === 'fresh'
        && (comparableDelta ? introducedDiagnosticErrors === true : (diagnosticErrors?.length ?? 0) > 0));
    const pending = evidenceUnavailable || !evidencePassed || !diagnosticsPassed;
    return {
        verdict: repair ? 'repair' : pending ? 'pending' : 'allow',
        evidencePassed,
        diagnosticsPassed,
        diagnosticsSupersededEvidenceConflicts: diagnosticsSupersededEvidenceConflicts || undefined,
        diagnosticsSupersededSyntaxConflict: diagnosticsSupersededSyntaxConflict || undefined,
        diagnosticsSupersededConflictKinds: supersededConflictKinds.length > 0 ? supersededConflictKinds : undefined,
        diagnosticErrorCount: comparableDelta
            ? diagnosticDelta!.added.filter(item => item.severity === 'error').length
            : diagnosticErrors?.length,
        diagnosticsFreshness: freshness,
    };
}

const SEMANTIC_WRITE_TOOL_TIMEOUT = 120_000;

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
    query_targeting_weight: 5_000,
    history: 10_000,
    query_rules: 45_000,
    query_override_modes: 45_000,
    search_rule_capabilities: 45_000,
    explain_scope: 45_000,
    parse_pdx_fragment: 45_000,
    get_lsp_status: 10_000,
    get_diagnostics: 45_000,
    find_sprite_candidates: 45_000,
    find_sound_candidates: 45_000,
    get_completion_at: 45_000,
    document_symbols: 45_000,
    workspace_symbols: 45_000,
    verify_pdx_identifier: 45_000,
    get_pdx_block: 45_000,
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
    // PDX writes may run evidence gates plus fresh diagnostics on cold caches.
    write_file: SEMANTIC_WRITE_TOOL_TIMEOUT,
    edit_file: SEMANTIC_WRITE_TOOL_TIMEOUT,
    replace_lines: SEMANTIC_WRITE_TOOL_TIMEOUT,
    list_directory: 30_000,
    glob_files: 30_000,
    grep: 30_000,
    web_search: 30_000,
    web_open: 20_000,
    web_find: 5_000,
    convert_image_to_dds: 60_000,
    convert_audio: 60_000,
    deploy_mod_asset: 0,
    git_ops: 30_000,
    write_localisation: SEMANTIC_WRITE_TOOL_TIMEOUT,
    save_skill: 30_000,
    todo_write: 5_000,
    run_skill: 30_000,
    // Interactive questions wait indefinitely for user input from the WebView.
    ask_user_question: 0,
};


const WRITE_CONFIRMATION_TOOLS = new Set<string>([
    'write_file',
    'edit_file',
    'replace_lines',
    'write_localisation',
]);

const DEFAULT_TOOL_TIMEOUT = 30_000;

/**
 * Executes Agent tools by communicating with the CWTools Language Server
 * and directly reading workspace files.
 */
export class AgentToolExecutor {
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: import('./types').TodoUpdateCallback;
    /** Callback when a file write needs user confirmation (confirm mode). */
    public onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /** Callback when a file is automatically written (auto mode). */
    public onAutoWritten?: (file: string, isNewFile: boolean) => void;
    /** Callback when a skill is saved: the `/skill:<name>` catalog changed. */
    public onSkillSaved?: () => void;
    /** Agent file write mode from config */
    public fileWriteMode: 'confirm' | 'auto' = 'confirm';

    // - Domain handlers -
    private fileHandler: FileToolHandler;
    private readonly candidateTransactions = new CandidateTransactionManager();
    private candidateOverlay?: Map<string, string>;
    private readonly archetypeArtifacts: HostArchetypeArtifactStore;
    private candidateOwnerScope?: string;
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
    public workspaceRoot: string;
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
        if (globalStoragePath || extensionPath) {
            configureSandboxStorage({ globalStoragePath, extensionPath });
        }
        this.indexService = indexService;
        this.apiKeyManager = apiKeyManager;
        this.archetypeArtifacts = new HostArchetypeArtifactStore(workspaceRoot);
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;

        // Create domain handlers - each receives `this` as context so they
        // can read mutable properties (fileWriteMode, callbacks, etc.) at call time.
        this.fileHandler = new FileToolHandler(this);
        this.lspHandler = new LspToolHandler(this, this.clientGetter, findFiles);
        this.externalHandler = new ExternalToolHandler(this);
        this.memoryHandler = new MemoryToolHandler(this);

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

    /**
     * Re-point this executor at the project root that owns the active editor.
     * Multi-root workspaces call this once per user turn, never during a run:
     * relative paths, file locks, and approval previews must all resolve against
     * one root for the whole run. Root-scoped state derived from the previous
     * root is reset so a mod cannot inherit its session write mode or artifacts.
     */
    public setWorkspaceRoot(nextWorkspaceRoot: string): boolean {
        const next = typeof nextWorkspaceRoot === 'string' && nextWorkspaceRoot
            ? path.resolve(nextWorkspaceRoot)
            : '';
        if (!next || next === this.workspaceRoot) return false;
        this.workspaceRoot = next;
        // fileWriteMode caches the resolved session mode of the previous root.
        this.fileWriteMode = vs.workspace
            .getConfiguration('stellarisLanguageServices.ai')
            .get<'confirm' | 'auto'>('agentFileWriteMode', 'auto');
        this.archetypeArtifacts.setWorkspaceRoot(next);
        return true;
    }

    get client(): LanguageClient {
        return this.clientGetter();
    }

    async getWebSearchApiKey(provider: Exclude<WebSearchProvider, 'auto' | 'duckduckgo' | 'searxng'>): Promise<string | undefined> {
        const secretId = provider === 'openai' ? 'openai' : `web.${provider}`;
        return this.apiKeyManager?.getKey(secretId);
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

    private requireCandidateTransaction(transactionId: unknown, context?: import('./types').AgentToolContext): string {
        const requested = typeof transactionId === 'string' ? transactionId : '';
        const active = this.candidateTransactions.id;
        if (!active || requested !== active) throw new Error('Candidate transaction id is missing or stale.');
        const scope = context?.scopeId ?? 'top-level';
        if (this.candidateOwnerScope !== scope) throw new Error('Candidate transaction belongs to another run scope.');
        return active;
    }

    /**
     * Binds the active candidate transaction's overlay to the exact context a
     * nested tool executes with. Write paths read
     * `context.runnerOptions.vfsOverlay` before falling back to the handler's
     * own context, so without this every staged candidate would leak to disk.
     */
    private candidateContext(context?: import('./types').AgentToolContext): import('./types').AgentToolContext {
        const overlay = this.candidateOverlay;
        if (!overlay || !context?.runnerOptions) return context ?? {};
        return {
            ...context,
            runnerOptions: { ...context.runnerOptions, vfsOverlay: overlay },
        };
    }

    private resolveCandidateFile(filePath: string): string {
        const resolved = path.resolve(this.workspaceRoot, filePath);
        if (!isPathInsideOrEqual(resolved, this.workspaceRoot)) {
            throw new Error(`Candidate file is outside the workspace: ${filePath}`);
        }
        const realRoot = fs.realpathSync.native(this.workspaceRoot);
        let realTarget: string;
        if (fs.existsSync(resolved)) {
            realTarget = fs.realpathSync.native(resolved);
        } else {
            const existingParent = path.dirname(resolved);
            if (!fs.existsSync(existingParent)) throw new Error(`Candidate parent directory does not exist: ${existingParent}`);
            realTarget = path.join(fs.realpathSync.native(existingParent), path.basename(resolved));
        }
        if (!isPathInsideOrEqual(realTarget, realRoot)) {
            throw new Error(`Candidate file resolves outside the workspace: ${filePath}`);
        }
        return resolved;
    }

    private async executeTypedPdxWrite(
        args: import('./types').TypedPdxWriteArgs,
        context?: import('./types').AgentToolContext,
    ): Promise<import('./types').TypedPdxWriteResult> {
        const filePath = this.resolveCandidateFile(args.filePath);
        const candidate = await buildTypedPdxCandidate({ filePath, operation: args.operation, expectedHash: args.expectedHash }, async target => {
            const overlay = this.vfsOverlay;
            if (overlay?.has(target)) return overlay.get(target)!;
            return fs.readFileSync(target, 'utf8');
        });
        if ((args.mode ?? 'preview') === 'preview') {
            return { success: true, mode: 'preview', candidate };
        }
        const transactionId = this.requireCandidateTransaction(args.transactionId, context);
        if (!this.candidateTransactions.canValidate) throw new Error('Candidate transaction is not active.');
        this.candidateTransactions.stage(filePath, candidate.content, candidate.beforeHash);
        const overlay = this.vfsOverlay;
        if (!overlay) throw new Error('Candidate overlay is unavailable.');
        overlay.set(filePath, candidate.content);
        return { success: true, mode: 'stage', transactionId, candidate, message: candidate.summary };
    }

    /**
     * Runs `write_localisation` inside an active candidate transaction and
     * registers every file it touched with the transaction manager.
     *
     * Without this, the localisation path wrote only to the overlay while the
     * manager stayed empty, so `validate`/commit were unreachable for mods that
     * never use `typed_pdx_write`.
     */
    private async executeWriteLocalisation(
        args: import('./types').WriteLocalisationArgs,
        context?: import('./types').AgentToolContext,
    ): Promise<import('./types').EditFileResult> {
        const transactionContext = this.candidateContext(context);
        const result = await this.fileHandler.writeLocalisation(args, transactionContext);
        if (!result.success || !Array.isArray(result.stagedFiles) || result.stagedFiles.length === 0) return result;

        const transactionId = this.candidateTransactions.id;
        if (this.candidateTransactions.state !== 'active' || !transactionId) {
            // The overlay this result reports no longer belongs to a live
            // transaction, so the write never reached disk.
            return {
                success: false,
                message: `write_localisation staged ${result.stagedFiles.length} file(s) into a candidate overlay, but no active transaction could own them. No files were written.`,
            };
        }
        const overlay = this.vfsOverlay;
        if (!overlay) return result;
        for (const staged of result.stagedFiles) {
            const baseHash = typeof staged.baseHash === 'string' && /^[a-f0-9]{64}$/i.test(staged.baseHash)
                ? staged.baseHash
                : undefined;
            this.candidateTransactions.stage(staged.path, staged.content, baseHash);
            overlay.set(staged.path, staged.content);
        }
        return { ...result, message: `${result.message ?? ''} (staged ${result.stagedFiles.length} file(s) in transaction ${transactionId}.)`.trim() };
    }

    private async validateCandidateOverlay(
        files: readonly import('./runner/candidateTransaction').CandidateFile[] = this.candidateTransactions.files,
    ): Promise<{
        validationLevel?: string;
        limitations?: string[];
        files: Array<{ uri?: string; ok?: boolean; validationLevel?: string; contentHash?: string; diagnostics?: import('./types').ValidationError[]; error?: string; status?: string }>;
    }> {
        const client = this.client;
        if (!client || typeof (client as any).sendRequest !== 'function') {
            throw new Error('LSP client unavailable for candidate overlay validation.');
        }
        const request = client.sendRequest('workspace/executeCommand', {
            command: 'cwtools.ai.validateOverlay',
            arguments: [{
                files: files.map(file => ({
                    uri: vs.Uri.file(file.path).toString(),
                    content: file.content,
                    baseHash: file.baseHash,
                })),
            }],
        }) as Promise<Record<string, unknown>>;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Overlay validation timed out after 15 seconds.')), 15_000);
        });
        const response = await Promise.race([request, timeout]).finally(() => { if (timeoutId) clearTimeout(timeoutId); });
        if (!response || typeof response !== 'object' || response.ok !== true || !Array.isArray(response.files)) {
            throw new Error(typeof response?.error === 'string' ? response.error : 'Overlay validation returned an invalid response.');
        }
        if (response.files.length !== files.length) {
            throw new Error(`Overlay validation returned ${response.files.length} file result(s) for ${files.length} candidate(s).`);
        }
        const requestedByUri = new Map(files.map(file => [vs.Uri.file(file.path).toString(), file]));
        const returnedUris = new Set<string>();
        const normalizedFiles = response.files.map(item => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const uri = typeof record.uri === 'string' ? record.uri : undefined;
            if (!uri || !requestedByUri.has(uri) || returnedUris.has(uri)) {
                throw new Error(`Overlay validation returned an unknown, missing, or duplicate URI: ${uri ?? '<missing>'}.`);
            }
            returnedUris.add(uri);
            if (!Array.isArray(record.diagnostics)) throw new Error(`Overlay validation omitted diagnostics for ${uri}.`);
            const diagnostics = record.diagnostics.flatMap(raw => {
                    if (!raw || typeof raw !== 'object') throw new Error(`Overlay validation returned a malformed diagnostic for ${uri}.`);
                    const diagnostic = raw as Record<string, unknown>;
                    const severity = diagnostic.severity;
                    if (severity !== 'error' && severity !== 'warning' && severity !== 'info' && severity !== 'hint') {
                        throw new Error(`Overlay validation returned an unknown diagnostic severity for ${uri}.`);
                    }
                    return [{
                        code: typeof diagnostic.code === 'string' ? diagnostic.code : '',
                        severity,
                        message: typeof diagnostic.message === 'string' ? diagnostic.message : '',
                        line: typeof diagnostic.line === 'number' ? diagnostic.line : 0,
                        column: typeof diagnostic.column === 'number' ? diagnostic.column : 0,
                    } satisfies import('./types').ValidationError];
                });
            return {
                uri,
                ok: record.ok === true,
                validationLevel: typeof record.validationLevel === 'string' ? record.validationLevel : undefined,
                contentHash: typeof record.contentHash === 'string' ? record.contentHash : undefined,
                diagnostics,
                error: typeof record.error === 'string' ? record.error : undefined,
                status: typeof record.status === 'string' ? record.status : undefined,
            };
        });
        if (returnedUris.size !== requestedByUri.size) throw new Error('Overlay validation did not cover every candidate file.');
        return {
            validationLevel: typeof response.validationLevel === 'string' ? response.validationLevel : undefined,
            limitations: Array.isArray(response.limitations) ? response.limitations.filter((item): item is string => typeof item === 'string') : undefined,
            files: normalizedFiles,
        };
    }

    private async executeCandidateTransaction(
        args: import('./types').CandidateTransactionArgs,
        context?: import('./types').AgentToolContext,
    ): Promise<import('./types').CandidateTransactionResult> {
        try {
            if (args.action === 'begin') {
                if (this.candidateOverlay && this.candidateOverlay.size > 0) {
                    throw new Error('Candidate overlay already contains staged files.');
                }
                const transactionId = this.candidateTransactions.begin();
                this.candidateOwnerScope = context?.scopeId ?? 'top-level';
                this.candidateOverlay = new Map<string, string>();
                return { success: true, action: args.action, transactionId, state: 'active', files: [], bytes: 0 };
            }
            const transactionId = this.requireCandidateTransaction(args.transactionId, context);
            if (args.action === 'status') {
                return { success: true, action: args.action, transactionId, state: this.candidateTransactions.state, files: this.candidateTransactions.paths, bytes: this.candidateTransactions.bytes };
            }
            if (args.action === 'discard') {
                this.candidateTransactions.discard();
                this.candidateOverlay?.clear();
                this.candidateOverlay = undefined;
                this.candidateOwnerScope = undefined;
                return { success: true, action: args.action, transactionId, state: this.candidateTransactions.state };
            }
            if (args.action === 'validate') {
                if (!this.candidateTransactions.canValidate) throw new Error('Candidate transaction is not active.');
                let validationPassed = args.validationPassed !== false;
                let validationError: string | undefined;
                let infrastructureError: string | undefined;
                if (this.candidateTransactions.files.length === 0) {
                    // Nothing staged: validation is vacuously satisfied. Calling the
                    // detached overlay validator with an empty batch is rejected as
                    // an invalid request, which would strand the transaction.
                    this.candidateTransactions.validate(true, this.candidateTransactions.fingerprint());
                    return { success: true, action: args.action, transactionId, state: this.candidateTransactions.state, files: [], bytes: 0 };
                }
                const preflight = context?.onBeforePdxWrite;
                if (preflight) {
                    for (const file of this.candidateTransactions.files) {
                        const previousContent = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, '') : '';
                        const decision = await preflight({
                            toolName: 'typed_pdx_write',
                            filePath: file.path,
                            previousContent,
                            content: file.content,
                        });
                        if (!decision.allowed) {
                            validationPassed = false;
                            validationError = decision.message ?? `Semantic evidence blocked ${path.basename(file.path)}.`;
                            break;
                        }
                    }
                }
                let overlayValidation: import('./types').CandidateTransactionResult['overlayValidation'];
                if (validationPassed) {
                    const catalog = validateOverlayCatalog(this.candidateTransactions.files.map(file => ({ file: file.path, content: file.content })));
                    const catalogErrors = catalog.issues.filter(issue => issue.severity === 'error' && issue.code === 'overlay_duplicate_definition');
                    if (catalogErrors.length > 0) {
                        validationPassed = false;
                        validationError = catalogErrors.map(issue => issue.message).join('; ');
                    }
                }
                if (validationPassed) {
                    try {
                        overlayValidation = await this.validateCandidateOverlay();
                    } catch (error) {
                        // Transport/response failure: the candidates were never
                        // judged. Keep the transaction active and report the cause
                        // instead of leaving the caller unable to tell whether the
                        // content or the validation interface failed.
                        infrastructureError = error instanceof Error ? error.message : String(error);
                        return {
                            success: false,
                            action: args.action,
                            transactionId,
                            state: this.candidateTransactions.state,
                            files: this.candidateTransactions.paths,
                            bytes: this.candidateTransactions.bytes,
                            infrastructureError,
                            error: `Candidate overlay validation could not run: ${infrastructureError}`,
                        };
                    }
                    const invalidFile = overlayValidation.files.find(file =>
                        file.ok !== true
                        || file.contentHash !== this.candidateTransactions.files.find(candidate => vs.Uri.file(candidate.path).toString() === file.uri)?.contentHash
                        || (file.diagnostics ?? []).some(diagnostic => diagnostic.severity === 'error'));
                    if (invalidFile) {
                        validationPassed = false;
                        validationError = invalidFile.error ?? `Overlay validation rejected ${invalidFile.uri ?? 'a candidate file'}.`;
                    }
                }
                this.candidateTransactions.validate(validationPassed, this.candidateTransactions.fingerprint());
                return { success: validationPassed, action: args.action, transactionId, state: this.candidateTransactions.state, files: this.candidateTransactions.paths, bytes: this.candidateTransactions.bytes, overlayValidation, error: validationError };
            }
            const files = this.candidateTransactions.files;
            const baselineDiagnostics = new Map<string, import('./runner/diagnosticSnapshot').DiagnosticSnapshot>();
            const baselineEpochs = new Map<string, number>();
            for (const file of files) {
                const baseline = await this.lspHandler.getDiagnostics({ file: file.path, severity: 'all', limit: 2000 }, context);
                baselineEpochs.set(file.path, baseline.lastEpoch ?? 0);
                baselineDiagnostics.set(file.path, createDiagnosticSnapshot(baseline.diagnostics.map(item => ({
                    code: item.code ?? '', severity: item.severity, message: item.message, line: item.line, column: item.column, data: item.data,
                })), { status: baseline.freshness, complete: baseline.freshness === 'fresh' && baseline.truncated !== true }));
            }
            const deltas: Record<string, import('./runner/diagnosticSnapshot').DiagnosticDelta> = {};
            const lockPaths = files.map(file => canonicalPathKey(file.path, this.workspaceRoot));
            const commit = await globalPartitionedWriteQueue.enqueue(lockPaths, () => this.candidateTransactions.commit({
                readDisk: file => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(''),
                writeDisk: (file, content) => {
                    context?.onBeforeFileWrite?.(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, content, 'utf8');
                },
                deleteDisk: file => { if (fs.existsSync(file)) fs.unlinkSync(file); },
                afterRollback: async rolledBackFiles => {
                    const targets = rolledBackFiles.map(file => file.path);
                    const response = await this.requestRevalidateFiles(targets);
                    if (response?.ok !== true) return { ok: false, error: 'Rollback files could not be revalidated.' };
                    const restoredFiles = rolledBackFiles.map(file => {
                        const content = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
                        return { ...file, content, contentHash: sha256(content), bytes: Buffer.byteLength(content, 'utf8') };
                    });
                    const serverValidation = await this.validateCandidateOverlay(restoredFiles);
                    for (const file of restoredFiles) {
                        const uri = vs.Uri.file(file.path).toString();
                        const result = serverValidation.files.find(item => item.uri === uri);
                        if (result?.ok !== true || result.contentHash !== file.contentHash) {
                            return { ok: false, error: `Rollback server content did not match baseline for ${file.path}.` };
                        }
                        if (file.baseHash !== undefined && result.contentHash !== file.baseHash) {
                            return { ok: false, error: `Rollback server base hash did not match baseline for ${file.path}.` };
                        }
                    }
                    for (const file of rolledBackFiles) {
                        const baselineEpoch = baselineEpochs.get(file.path) ?? 0;
                        const deadline = Date.now() + 8_000;
                        let current = await this.lspHandler.getDiagnostics({ file: file.path, severity: 'all', limit: 2000 }, context);
                        while ((current.freshness !== 'fresh' || (current.lastEpoch ?? 0) <= baselineEpoch) && Date.now() < deadline) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                            current = await this.lspHandler.getDiagnostics({ file: file.path, severity: 'all', limit: 2000 }, context);
                        }
                        if (current.freshness !== 'fresh' || (current.lastEpoch ?? 0) <= baselineEpoch) {
                            return { ok: false, error: `Rollback diagnostics did not become fresh for ${file.path}.` };
                        }
                        const recoveredSnapshot = createDiagnosticSnapshot(current.diagnostics.map(item => ({
                            code: item.code ?? '', severity: item.severity, message: item.message, line: item.line, column: item.column, data: item.data,
                        })), { status: current.freshness, complete: current.truncated !== true });
                        const recoveryDelta = diffDiagnosticSnapshots(baselineDiagnostics.get(file.path)!, recoveredSnapshot);
                        if (!recoveryDelta.comparable || recoveryDelta.added.length > 0 || recoveryDelta.removed.length > 0) {
                            return { ok: false, error: `Rollback diagnostics did not match baseline for ${file.path}.` };
                        }
                        const originalHash = file.baseHash;
                        const restored = fs.existsSync(file.path) ? fs.readFileSync(file.path) : Buffer.from('');
                        if (originalHash !== undefined && sha256(restored) !== originalHash) {
                            return { ok: false, error: `Rollback content hash did not match baseline for ${file.path}.` };
                        }
                    }
                    return { ok: true };
                },
                validateDisk: async committedFiles => {
                    await this.requestRevalidateFiles(committedFiles.map(file => file.path));
                    let valid = true;
                    for (const file of committedFiles) {
                        let current = await this.lspHandler.getDiagnostics({ file: file.path, severity: 'all', limit: 2000 }, context);
                        const baselineEpoch = baselineEpochs.get(file.path) ?? 0;
                        const deadline = Date.now() + 8_000;
                        while ((current.freshness !== 'fresh' || (current.lastEpoch ?? 0) <= baselineEpoch) && Date.now() < deadline) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                            current = await this.lspHandler.getDiagnostics({ file: file.path, severity: 'all', limit: 2000 }, context);
                        }
                        const snapshot = createDiagnosticSnapshot(current.diagnostics.map(item => ({
                            code: item.code ?? '', severity: item.severity, message: item.message, line: item.line, column: item.column, data: item.data,
                        })), { status: current.freshness, complete: current.freshness === 'fresh' && current.truncated !== true });
                        const delta = diffDiagnosticSnapshots(baselineDiagnostics.get(file.path)!, snapshot);
                        deltas[file.path] = delta;
                        if (!delta.comparable || hasAddedErrors(delta)) valid = false;
                    }
                    return { ok: valid, error: valid ? undefined : 'Candidate commit introduced errors or diagnostics were not fresh.' };
                },
            }), { waitTimeoutMs: 30_000, timeoutMessage: 'Candidate commit timed out waiting for file locks.' });
            if (commit.state === 'committed' || commit.state === 'discarded') {
                this.candidateOverlay = undefined;
                this.candidateOwnerScope = undefined;
            }
            return { success: commit.committed, action: args.action, transactionId, state: commit.state, files: commit.files, commit, diagnosticDeltas: deltas, error: commit.error };
        } catch (error) {
            return { success: false, action: args.action, transactionId: args.transactionId, state: this.candidateTransactions.state, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private async requestRevalidateFiles(files: string[]): Promise<Record<string, unknown> | undefined> {
        const targets = selectRevalidateTargets(files);
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
        return this.candidateOverlay;
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

    private isManagedSkillOrExperienceTarget(targetPath: string): 'skill' | 'experience' | undefined {
        const resolved = path.isAbsolute(targetPath)
            ? path.resolve(targetPath)
            : path.resolve(this.workspaceRoot, targetPath);
        const normalized = resolved.replace(/\\/g, '/');

        const expStorePath = getExperienceStoreFilePath(this.workspaceRoot);
        const expProjPath = getExperienceProjectionPath(this.workspaceRoot);
        if ((expStorePath && isPathInsideOrEqual(resolved, path.dirname(path.resolve(expStorePath))))
            || (expProjPath && isPathInsideOrEqual(resolved, path.resolve(expProjPath)))
            || /\/experience\/[^/]+\/experience\.json(?:\.tmp)?$/i.test(normalized)
            || /\/\.cwtools\/experience\.md$/i.test(normalized)) {
            return 'experience';
        }

        const skillRoots = [
            this.workspaceRoot ? path.join(this.workspaceRoot, '.agents', 'skills') : '',
            this.workspaceRoot ? path.join(this.workspaceRoot, '.cwtools', 'skills') : '',
            path.join(getCwtoolsHomeDir(), 'skills'),
            this.globalStoragePath ? path.join(this.globalStoragePath, '.agents', 'skills') : '',
        ].filter(Boolean);
        if (skillRoots.some(root => isPathInsideOrEqual(resolved, path.resolve(root)))
            || /\/(?:\.agents|\.cwtools)\/skills(?:\/|$)/i.test(normalized)) {
            return 'skill';
        }
        return undefined;
    }

    /** The single enforced policy boundary for every model-visible tool call. */
    private async enforcePolicy(
        toolName: string,
        args: Record<string, unknown>,
        mode: import('./types').AgentMode,
        context?: import('./types').AgentToolContext,
    ): Promise<{ allowed: boolean; error?: string; recoverable?: boolean }> {
        const entry = TOOL_REGISTRY.get(toolName as any)
            ?? (this.dynamicMcpToolNames.has(toolName) ? TOOL_REGISTRY.get('mcp_call') : undefined);
        if (!entry) return { allowed: false, error: `Unknown tool: ${toolName}` };
        const subject = subjectForEffect(entry.effect);
        if (!subject) return { allowed: true };

        const effectiveWriteMode = sessionFileWriteMode(this.workspaceRoot) ?? this.fileWriteMode;
        this.fileWriteMode = effectiveWriteMode;
        const profileRules: PolicyRule[] = [
            { id: 'effective-workspace-write', subject: 'edit', pathGlob: '**', action: 'allow', riskMax: 2, scope: 'session' },
        ];
        const targets = toolName === 'candidate_transaction' && args.action === 'commit'
            ? this.candidateTransactions.files.map(file => file.path)
            : getAgentToolTargetFiles(toolName, args, this.workspaceRoot, context?.runnerOptions?.topicId);
        const profile = buildProfile('workspace-auto', this.workspaceRoot, profileRules);
        if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_lines')
            && targets.length > 0) {
            for (const target of targets) {
                const managedKind = this.isManagedSkillOrExperienceTarget(target);
                if (managedKind) {
                    return {
                        allowed: false,
                        recoverable: true,
                        error: managedKind === 'experience'
                            ? `Cannot write workspace experience store files directly with '${toolName}' ('${target}'). Workspace experience (experience.json / .cwtools/experience.md) is distilled and managed automatically by the host. If the user asked to preserve reusable experience as an Agent Skill, call 'save_skill' (load it via select_tools({ tools: ["save_skill"] }) if needed) with scope='project' or scope='user'.`
                            : `Cannot write Agent Skill files directly with '${toolName}' ('${target}'). Use 'save_skill' (load it via select_tools({ tools: ["save_skill"] }) if needed) with scope='project' (.agents/skills/<name>/SKILL.md) or scope='user' (~/.cwtools/skills/<name>/SKILL.md).`,
                    };
                }
            }
        }
        const topicId = context?.runnerOptions?.topicId;
        if (subject === 'edit' && topicId && targets.length > 0) {
            const topicRoot = path.resolve(getPrivateTopicStorageDir(topicId, this.workspaceRoot));
            const targetsCurrentPrivateTopic = targets.every(target => isPathInsideOrEqual(path.resolve(target), topicRoot));
            const targetsArePlanArtifacts = targets.every(target =>
                isPlanModeCardArtifactFile(target, this.workspaceRoot, topicId));
            if (targetsCurrentPrivateTopic && targetsArePlanArtifacts) {
                profile.writableRoots.push(topicRoot);
            }
        }
        const gitAction = toolName === 'git_ops' && typeof args.action === 'string' ? args.action : undefined;
        const riskLevel = gitAction === 'status' || gitAction === 'diff' ? 0 : gitAction === 'checkout' ? 2 : entry.riskLevel;
        const mcpServer = typeof args.server === 'string' ? args.server : undefined;
        const mcpTool = typeof args.tool === 'string' ? args.tool : undefined;
        const networkHosts = await this.extractNetworkHosts(toolName, args);
        const decision = resolvePolicy({
            toolName,
            subject,
            riskLevel,
            workspaceRoot: this.workspaceRoot,
            cwd: this.workspaceRoot,
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
        if (decision.action === 'deny' && !decision.denial?.approvalPath) {
            return { allowed: false, error: decision.denial?.whyDenied ?? `Policy '${profile.id}' denied ${toolName}.` };
        }
        return { allowed: true };
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
                ledgerRoot: getPrivateAiStorageRoot(this.workspaceRoot) || undefined,
                persistDecisions: vs.workspace.getConfiguration('stellarisLanguageServices.ai.evidenceGate').get<boolean>('persistLedger', true),
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
                    const result = await this.lspHandler.findReferences({ identifier: name }) as import('./types').QueryReferencesResult;
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
                riskLevel: this.pdxWriteRiskLevel(toolName, resolvedTargetFile, text, previousText),
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
                    && isDiagnosticRelevantFile(value)) {
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

    private pdxWriteRiskLevel(toolName: string, targetFile: string, text: string, previousText: string): 0 | 1 | 2 | 3 {
        if (this.isHighRiskPdxWrite(toolName, targetFile)) return 3;
        const changedSize = Math.abs(text.length - previousText.length);
        if ((toolName === 'edit_file' || toolName === 'replace_lines') && changedSize <= 160) return 1;
        if (toolName === 'write_file' && previousText.length === 0) return 2;
        return 2;
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
            if (!isPathInsideOrEqual(target, this.workspaceRoot)) {
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
        // Accept the concise SDK-style spelling emitted by some compatible models,
        // but keep one canonical registry entry so policy, scheduling, and dispatch
        // all evaluate the exact same capability.
        if (toolName === 'glob') toolName = 'glob_files';

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
        const readTracker = (context?.agentRunner as any)?.readTracker;
        const isSubAgent = !!context?.runnerOptions?.useSlimPrompt;
        const schedulingState = context?.runnerOptions?.schedulingState;
        if (!schedulingState) {
            return {
                success: false,
                error: `Tool '${toolName}' requires an active scheduler context.`,
                terminalOutcome: 'policy_denied',
            };
        }
        const runtimeDomain = schedulingState.domainProfile;
        const mode = executionModeForSchedulingState(schedulingState);
        const registeredToolName = this.dynamicMcpToolNames.has(toolName) ? 'mcp_call' : toolName;
        const access = validateToolCapability(registeredToolName, {
            mode, domain: runtimeDomain, isSubAgent,
            profileName: schedulingState.profileName,
        });
        if (!access.allowed) {
            return {
                success: false,
                error: access.reason,
                terminalOutcome: 'policy_denied',
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

        const registryEntry = TOOL_REGISTRY.get(toolName as any);
        const authorization = context?.runnerOptions?.schedulingState?.authorization;
        if (registryEntry && authorization
            && toolName !== 'save_skill'
            && !authorizationAllowsEffect(authorization, registryEntry.effect, registryEntry.mutating ?? false)) {
            return {
                success: false,
                error: `Scheduling authorization '${authorization}' blocks tool '${toolName}' (${registryEntry.effect}).`,
                authorizationBlocked: true,
                terminalOutcome: 'policy_denied',
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
                    terminalOutcome: 'policy_denied',
                };
            }
        }

        const runtimePlanPhase = context?.runnerOptions?.schedulingState?.phase === 'plan';
        if (runtimePlanPhase || mode === 'plan') {
            const guard = validatePlanModeToolUse(
                toolName,
                args,
                this.workspaceRoot,
                context?.runnerOptions?.topicId,
                undefined,
                'plan',
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
            if (policy.recoverable) {
                return { success: false, error: policy.error };
            }
            return { success: false, error: policy.error, policyDenied: true, terminalOutcome: 'policy_denied' };
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
            if (this.dynamicMcpToolNames.has(toolName) || toolName === 'mcp_call') {
                timeout = 120_000; // MCP tools can involve network calls or complex processing
            } else {
                timeout = DEFAULT_TOOL_TIMEOUT;
            }
        }
        if (
            timeout > 0
            && WRITE_CONFIRMATION_TOOLS.has(toolName)
            && !shouldBypassWriteConfirmation({
                fileWriteMode: this.fileWriteMode,
                args,
                runnerOptions: context?.runnerOptions,
            })
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
            if (context?.onStep && toolName !== 'ask_user_question') {
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
                    schedulingState,
                    abortSignal,
                },
            };
            toolContext.onBeforePdxWrite = async request => {
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

                // ReadTracker read/write synchronization (T2.2)
                if (readTracker) {
                    for (const file of writtenFiles) {
                        readTracker.invalidate(file);
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
            case 'query_targeting_weight':
                result = executeTargetingWeightQuery(args); break;
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
            // validate_code - REMOVED: replaced by get_diagnostics + edit_file inline diagnostics
            case 'get_lsp_status':
                result = await this.lspHandler.getLspStatus(args as any); break;
            case 'get_diagnostics':
                result = await this.lspHandler.getDiagnostics(args as any, context); break;
            case 'find_sprite_candidates':
                result = await this.lspHandler.findSpriteCandidates(args as any); break;
            case 'find_sound_candidates':
                result = await this.lspHandler.findSoundCandidates(args as any); break;
            case 'grep':
                result = await this.lspHandler.searchText(args as any, context); break;
            case 'get_completion_at':
                result = await this.lspHandler.getCompletionAt(args as any, context); break;
            case 'document_symbols':
                result = await this.lspHandler.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.lspHandler.workspaceSymbols(args as any, context); break;
            case 'go_to_definition':
                result = await this.lspHandler.goToDefinition(args as any); break;
            case 'find_references':
                result = await this.lspHandler.findReferences(args as any); break;
            case 'hover_symbol':
                result = await this.lspHandler.hoverSymbol(args as any); break;
            case 'rename_symbol':
                result = await this.lspHandler.renameSymbol(args as any, context); break;
            case 'verify_pdx_identifier':
                result = await this.lspHandler.verifyPdxIdentifier(args as any); break;
            case 'find_scope_bridge': {
                const input = args as unknown as import('./types').FindScopeBridgeArgs;
                // Retrieve both sides of a possible bridge: outgoing edges from the
                // source scope and edges that reach the requested destination. If both
                // queries are prefiltered by the final destination, valid intermediate
                // transitions (for example country -> system) never reach the solver.
                const outgoing = await this.lspHandler.searchRuleCapabilities({
                    intent: input.context,
                    category: 'scope_change',
                    currentScope: input.fromScope,
                    limit: 50,
                });
                const incoming = await this.lspHandler.searchRuleCapabilities({
                    intent: `${input.context} scope transition bridge`,
                    category: 'scope_change',
                    desiredPushScope: input.toScope,
                    limit: 50,
                });
                const intermediate = await this.lspHandler.searchRuleCapabilities({
                    intent: `${input.context} intermediate scope transitions`,
                    category: 'scope_change',
                    limit: 100,
                });
                const evidence = {
                    ...outgoing,
                    candidates: [...outgoing.candidates, ...intermediate.candidates, ...incoming.candidates].slice(0, 200),
                };
                const candidates: ScopeBridgeCandidate[] = evidence.candidates.flatMap(candidate => {
                    const evidenceFile = candidate.rule.sourceFile ?? candidate.rule.hardFacts?.cwtSource?.file;
                    const evidenceLine = candidate.rule.sourceLine ?? candidate.rule.hardFacts?.cwtSource?.line;
                    if (!evidenceFile || evidenceLine === undefined) return [];
                    return [{
                    name: candidate.rule.name,
                    supportedScopes: candidate.rule.hardFacts?.supportedScopes ?? candidate.rule.scopes,
                    pushScope: candidate.rule.hardFacts?.pushScope,
                    evidence: [
                        `${evidence.source}:${evidenceFile}:${evidenceLine}`,
                        ...(evidence.rulesContentHash ? [`rules-sha256:${evidence.rulesContentHash}`] : []),
                    ],
                }]; } );
                result = { ...solveScopeBridge({ fromScope: input.fromScope, toScope: input.toScope, candidates }), evidenceSource: evidence.source, rulesContentHash: evidence.rulesContentHash }; break;
            }
            case 'extract_archetype_slots': {
                const input = args as unknown as import('./types').ExtractArchetypeSlotsArgs;
                const scopeId = context?.scopeId ?? '';
                const artifact = await this.archetypeArtifacts.extract({ ...input, scopeId }, (identity, canonicalPath) => this.verifyArchetypeDefinition(identity, canonicalPath, context));
                result = { success: true, artifact }; break;
            }
            case 'instantiate_archetype': {
                const input = args as unknown as import('./types').InstantiateArchetypeArgs;
                const scopeId = context?.scopeId ?? '';
                result = { success: true, content: await this.archetypeArtifacts.instantiate(input.artifactId, input.values, scopeId) }; break;
            }
            case 'get_pdx_block':
                result = await this.lspHandler.getPdxBlock(args as any, context); break;
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
            case 'typed_pdx_write':
                result = await this.executeTypedPdxWrite(args as any, context); break;
            case 'candidate_transaction':
                result = await this.executeCandidateTransaction(args as any, context); break;
            case 'list_directory':
                result = await this.fileHandler.listDirectory(args as any, context); break;
            case 'glob_files':
                result = await this.fileHandler.globFiles(args as any, context); break;
            case 'write_localisation':
                result = await this.executeWriteLocalisation(args as any, context); break;
            case 'write_design_blueprint':
                result = await this.fileHandler.writeDesignBlueprint(args as any, context); break;
            case 'save_skill':
                result = this.saveSkill(args, context); break;
            case 'git_ops':
                result = await this.fileHandler.gitOps(args as any); break; // git ops uses workspace wide state mostly

            // - External / agent tools -
            case 'web_open':
                result = await this.externalHandler.webOpen(args as any, context); break;
            case 'web_search':
                result = await this.externalHandler.webSearch(args as any, context); break;
            case 'web_find':
                result = this.externalHandler.webFind(args as any); break;
            case 'todo_write':
                result = await this.externalHandler.todoWrite(args as any, context); break;
            case 'ask_user_question': {
                const callback = context?.onUserQuestion;
                if (!callback) {
                    result = {
                        success: false,
                        error: 'The active host does not support interactive questions. Report the blocked user-owned decision without inventing an answer.',
                        terminalOutcome: 'interaction_unavailable',
                    };
                    break;
                }
                const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
                const questions: import('./types').AskUserQuestionItem[] = [];
                const ids = new Set<string>();
                for (const raw of rawQuestions.slice(0, 3)) {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
                    const item = raw as Record<string, unknown>;
                    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : '';
                    const question = typeof item.question === 'string' ? item.question.trim().slice(0, 1_000) : '';
                    const rawOptions = Array.isArray(item.options) ? item.options : [];
                    if (rawOptions.length < 2 || rawOptions.length > 4) continue;
                    const options = rawOptions.slice(0, 4).flatMap(option => {
                        if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
                        const record = option as Record<string, unknown>;
                        const label = typeof record.label === 'string' ? record.label.trim().slice(0, 100) : '';
                        const description = typeof record.description === 'string' ? record.description.trim().slice(0, 500) : '';
                        return label && description ? [{ label, description }] : [];
                    });
                    if (!id || ids.has(id) || !question || options.length !== rawOptions.length
                        || new Set(options.map(option => option.label)).size !== options.length) continue;
                    ids.add(id);
                    questions.push({
                        id,
                        question,
                        options,
                        ...(typeof item.header === 'string' && item.header.trim()
                            ? { header: item.header.trim().slice(0, 12) }
                            : {}),
                        ...(item.multiSelect === true ? { multiSelect: true } : {}),
                    });
                }
                if (questions.length === 0 || questions.length !== rawQuestions.length) {
                    result = {
                        success: false,
                        error: 'questions must contain 1-3 valid uniquely identified items, each with a non-empty question and 2-4 labelled options with descriptions.',
                    };
                    break;
                }
                result = await callback({ questions }, {
                    runId: context?.scopeId,
                    threadId: context?.runnerOptions?.threadId,
                    turnId: context?.runnerOptions?.turnId,
                });
                break;
            }
            case 'select_tools':
                result = args._selectionResult && typeof args._selectionResult === 'object'
                    ? {
                        success: true,
                        ...args._selectionResult as Record<string, unknown>,
                        message: aiText(
                            'Loaded schemas are now visible. loaded/alreadyLoaded = usable now; unavailable = excluded by the active mode or domain policy; denied = blocked by domain or mode policy. Execution still respects mode, policy, and permission checks.',
                            '已加载的工具现在可见。loaded/alreadyLoaded = 当前即可使用；unavailable = 被当前模式或域策略排除；denied = 被域或模式策略阻止。执行时仍会遵守模式、策略与权限检查。',
                        ),
                    }
                    : {
                        success: false,
                        error: 'select_tools must be evaluated by the active Agent runner.',
                    };
                break;
            case 'manage_goal': {
                const action = args.action;
                const topicId = context?.runnerOptions?.topicId ?? 'default';
                const threadId = context?.runnerOptions?.threadId ?? topicId;
                if (action === 'get') {
                    result = { success: true, goal: await goalStore.getGoal(topicId, threadId) ?? null };
                    break;
                }
                if (action === 'create') {
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
                        result = { success: false, error: 'objective is required for action=create.' };
                        break;
                    }
                    const criteria = Array.isArray(args.completionCriterion)
                        ? args.completionCriterion.filter((item): item is string => typeof item === 'string')
                        : [];
                    const tokenBudget = typeof args.tokenBudget === 'number' ? args.tokenBudget : undefined;
                    result = { success: true, goal: await goalStore.setGoal(topicId, threadId, objective, tokenBudget, criteria) };
                    break;
                }
                if (action === 'update') {
                    const validStatuses: DurableGoalStatus[] = ['active', 'paused', 'blocked', 'complete', 'cancelled'];
                    const status = validStatuses.find(candidate => candidate === args.status);
                    if (!status) {
                        result = { success: false, error: 'A valid status is required for action=update.' };
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
                if (action === 'set_budget') {
                    if (context?.runnerOptions?.useSlimPrompt) {
                        result = { success: false, error: 'Sub-agents cannot change parent goal budgets.' };
                        break;
                    }
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
                result = { success: false, error: 'Unsupported manage_goal action.' };
                break;
            }
            // ignore_validation_error - REMOVED: AI must fix errors, not suppress them
            case 'remove_ignored_diagnostic':
                result = await this.externalHandler.removeIgnoredDiagnostic(args as any); break;
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
            case 'history': {
                result = searchAgentHistory(this.workspaceRoot, args as any, {
                    topicId: context?.runnerOptions?.topicId,
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
            case 'forget_memory':
                result = await this.memoryHandler.forgetMemory(args as any, context); break;
            case 'memory_recall_trace':
                result = await this.memoryHandler.getRecallTrace(context); break;

            // - MCP tool call -
            case 'mcp_call':
                result = await this.executeMcpTool(args as any, context); break;

            case 'enter_plan_mode': {
                result = this.executeEnterPlanMode(args, context);
                break;
            }
            case 'exit_plan_mode': {
                result = this.executeExitPlanMode(args, context);
                break;
            }
            case 'get_ide_context': {
                result = await this.executeGetIdeContext(args);
                break;
            }
            case 'open_in_visual_editor': {
                result = await this.executeOpenInVisualEditor(args);
                break;
            }

            default:
                // Check if this is a dynamically registered MCP tool (mcp_<server>_<tool>)
                if (this.dynamicMcpToolNames.has(toolName)) {
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

    /**
     * Arm one run's `allowed-tools` policy for a skill. A skill that is already
     * active on the same key intersects with the new declaration instead of
     * widening it, so the turn can never gain tools by loading a second skill.
     * Declared tools are validated against the registry and the map stays bounded
     * by evicting the oldest key, matching the previous inline `run_skill` logic.
     */
    private mergeSkillPolicy(
        policyKey: string,
        skillName: string,
        declaredTools: readonly string[],
    ): { ok: true; skillNames: string[]; allowedTools: string[] } | { ok: false; unknownTool: string } {
        const unknownTool = declaredTools.find(tool => !TOOL_REGISTRY.has(tool as import('./types').AgentToolName));
        if (unknownTool) return { ok: false, unknownTool };
        const previous = this.activeSkillPolicies.get(policyKey);
        const declared = new Set(declaredTools);
        const effectiveAllowedTools = previous
            ? new Set([...previous.allowedTools].filter(tool => declared.has(tool)))
            : declared;
        const skillNames = previous?.skillNames.includes(skillName)
            ? previous.skillNames
            : [...(previous?.skillNames ?? []), skillName];
        // Re-insert so the bounded map evicts the oldest key first under load.
        this.activeSkillPolicies.delete(policyKey);
        this.activeSkillPolicies.set(policyKey, { skillNames, allowedTools: effectiveAllowedTools });
        while (this.activeSkillPolicies.size > AgentToolExecutor.ACTIVE_SKILL_POLICY_LIMIT) {
            const oldest = this.activeSkillPolicies.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.activeSkillPolicies.delete(oldest);
        }
        return {
            ok: true,
            skillNames: [...skillNames],
            allowedTools: [...effectiveAllowedTools].sort(),
        };
    }

    /**
     * Arm the `allowed-tools` policy for a skill the Host preloaded into this
     * turn's user message (`/skill <name>`). The turn behaves as if the model had
     * called `run_skill` for the same name: identical skill lookup and matching,
     * identical registry validation of the declared tools, and the same
     * intersection rule when the run already carries a skill policy.
     *
     * The policy is keyed `run:<runId>`, which is exactly what
     * `getSkillPolicyKey` resolves for a tool call made by this run, and is
     * cleared by the existing `clearSkillPolicyForRun` cleanup.
     */
    public preloadSkillPolicy(
        runId: string,
        name: string,
        domain?: import('./types').AgentRuntimeDomain,
    ): import('./types').SkillPolicyPreloadResult {
        const skillName = name.trim();
        if (!runId || !skillName) {
            return { applied: false, reason: 'empty-request', detail: 'A run id and a skill name are required.' };
        }
        const loaded = loadSkill(skillName, {
            workspaceRoot: this.workspaceRoot,
            globalStoragePath: this.globalStoragePath,
            extensionPath: this.extensionPath,
            homeDir: getCwtoolsHomeDir(),
        }, domain);
        if (!loaded.success) {
            return { applied: false, reason: 'unknown-skill', detail: loaded.error };
        }
        const declaredTools = loaded.skill.allowedTools;
        if (!declaredTools?.length) {
            return { applied: false, reason: 'no-allowed-tools', skillName: loaded.skill.name };
        }
        const merged = this.mergeSkillPolicy(`run:${runId}`, loaded.skill.name, declaredTools);
        if (!merged.ok) {
            return {
                applied: false,
                reason: 'unknown-tool',
                skillName: loaded.skill.name,
                detail: merged.unknownTool,
            };
        }
        return {
            applied: true,
            skillName: loaded.skill.name,
            activeSkills: merged.skillNames,
            allowedTools: merged.allowedTools,
        };
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
            homeDir: getCwtoolsHomeDir(),
        }, context?.runnerOptions?.schedulingState.domainProfile);
        if (!loaded.success) return loaded;

        const declaredTools = loaded.skill.allowedTools;
        if (declaredTools?.length) {
            const policyKey = this.getSkillPolicyKey(context);
            if (policyKey) {
                const merged = this.mergeSkillPolicy(policyKey, loaded.skill.name, declaredTools);
                if (!merged.ok) {
                    return {
                        success: false,
                        error: `Skill '${loaded.skill.name}' declares unknown allowed-tool '${merged.unknownTool}'. Fix its SKILL.md frontmatter before use.`,
                    };
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
            guidance: 'Follow this SKILL.md for the current task.',
            policyEnforced: !!effectivePolicy,
            activeSkills: effectivePolicy?.skillNames,
            effectiveAllowedTools: effectivePolicy ? [...effectivePolicy.allowedTools].sort() : undefined,
        };
    }

    private async verifyArchetypeDefinition(identity: string, canonicalPath: string, context?: import('./types').AgentToolContext): Promise<{ content: string } | undefined> {
        const response = await this.lspHandler.goToDefinition({ symbolName: identity });
        const targetKey = canonicalPathKey(canonicalPath);
        const recordMatches = (value: unknown): boolean => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const record = value as Record<string, unknown>;
            const values = Object.values(record).slice(0, 200);
            const identityMatches = ['name', 'symbolName', 'identity', 'key']
                .some(key => typeof record[key] === 'string' && (record[key] as string).toLowerCase() === identity.toLowerCase());
            const pathMatches = values.some(item => {
                if (typeof item !== 'string') return false;
                const fileValue = item.startsWith('file:') ? vs.Uri.parse(item).fsPath : item;
                return path.isAbsolute(fileValue) && canonicalPathKey(path.resolve(fileValue)) === targetKey;
            });
            if (identityMatches && pathMatches) return true;
            return values.some(item => Array.isArray(item)
                ? item.slice(0, 200).some(recordMatches)
                : recordMatches(item));
        };
        if (!recordMatches(response)) return undefined;
        const block = await this.lspHandler.getPdxBlock({ file: canonicalPath, symbol: identity }, context);
        return !block.error && !block.truncated ? { content: block.content } : undefined;
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

    private saveSkill(args: Record<string, unknown>, context?: import('./types').AgentToolContext): unknown {
        const scope = args.scope === 'project' || args.scope === 'user' ? args.scope : undefined;
        if (!scope) {
            return { success: false, error: `save_skill requires scope 'project' or 'user'.` };
        }
        const capabilityDomain = args.capability_domain === 'general'
            || args.capability_domain === 'paradox'
            || args.capability_domain === 'both'
            ? args.capability_domain
            : undefined;
        const allowedTools = Array.isArray(args.allowed_tools)
            ? args.allowed_tools
                .filter((value): value is string => typeof value === 'string')
                .map(value => value.trim())
                .filter(Boolean)
            : undefined;
        const unknownTool = allowedTools?.find(tool => !TOOL_REGISTRY.has(tool as import('./types').AgentToolName));
        if (unknownTool) {
            return {
                success: false,
                error: `save_skill: unknown allowed_tools entry '${unknownTool}'. Use tool names from the registry.`,
            };
        }

        const result = saveSkillFile({
            name: typeof args.name === 'string' ? args.name : '',
            description: typeof args.description === 'string' ? args.description : '',
            body: typeof args.body === 'string' ? args.body : '',
            capabilityDomain,
            runAs: typeof args.run_as === 'string' ? args.run_as : undefined,
            allowedTools,
            scope,
            workspaceRoot: this.workspaceRoot,
            homeDir: getCwtoolsHomeDir(),
            overwrite: args.overwrite === true,
            onBeforeWrite: (filePath, previousContent) => context?.onBeforeFileWrite?.(filePath, previousContent),
        });
        if (result.success) {
            context?.onStep?.({
                type: 'thinking',
                content: aiText(
                    `Skill saved: ${result.name} (${result.scope === 'project' ? 'project' : 'user'}-level). It is now available through run_skill.`,
                    `技能已保存：${result.name}（${result.scope === 'project' ? '项目级' : '用户级'}），可用 run_skill 调用。`,
                ),
                timestamp: Date.now(),
            });
            // Saving a skill changes the `/skill:<name>` catalog; the panel must
            // resend it so an open popup sees the new command immediately.
            this.onSkillSaved?.();
        }
        return result;
    }

    private async analyzeDiagnosticError(args: Record<string, unknown>): Promise<AnalyzeDiagnosticErrorResult> {
        const snapshot = args.diagnosticsSnapshot ?? args.toolResult;
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
            ...diagnostics.map(d => `${d.code ?? ''} ${d.file ?? ''} ${d.message}`),
        ].filter(Boolean).join('\n');

        const category = this.classifyDiagnosticText(analysisText, diagnostics, freshness);
        const suspectedStaleCache = freshness === 'pending'
            || freshness === 'stale'
            || /stale|cache|pending global|validation\s+pending/i.test(analysisText);
        const requiredFreshRead = category === 'read_tracker_stale'
            || /readtracker|fresh read|was not read|modified externally/i.test(analysisText);
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
        if (/readtracker|was not read|modified externally|fresh read/.test(lower)) return 'read_tracker_stale';
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
            return `Before creating localisation, verify key(s) [${refs}] with query_localisation_index and grep(searchContext="both"); only use write_localisation if absent.`;
        }
        if (category === 'invalid_value_type') {
            return `Before replacing value(s) [${refs}], query the field rule/scope and verify type-correct candidates through local indexes.`;
        }
        if (category === 'missing_definition') {
            return `Before creating definition(s) [${refs}], verify workspace and vanilla definitions with go_to_definition(symbolName=...), workspace_symbols, and grep(searchContext="both").`;
        }
        return `Before editing or creating definitions again, verify reference(s) [${refs}] through query_rules/go_to_definition/workspace_symbols, then grep(searchContext="both") or verify_pdx_identifier(includeVanilla=true) if still unresolved.`;
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
            ? ['go_to_definition', 'workspace_symbols', 'grep', 'verify_pdx_identifier']
            : [];
        switch (category) {
            case 'read_tracker_stale':
                return {
                    recommendedTools: ['read_file'],
                    avoidTools: ['write_file', 'replace_lines'],
                    nextInstruction: 'Refresh the target file with read_file, using centerLine/radius when appropriate, then retry the smallest guarded edit.',
                };
            case 'tool_argument_error':
                return {
                    recommendedTools: ['read_file', 'replace_lines'],
                    avoidTools: ['write_file with a large whole-file payload'],
                    nextInstruction: 'Do not retry the same malformed arguments. Re-read exact current text or switch to line-based replacement with anchors.',
                };
            case 'brace_or_syntax_error':
                return {
                    recommendedTools: ['read_file', 'document_symbols', 'query_rules', 'get_diagnostics'],
                    avoidTools: ['large write_file rewrites'],
                    nextInstruction: `Inspect the local syntax context and fix the smallest malformed block before re-running diagnostics.${staleHint}`,
                };
            case 'unknown_sprite':
                return {
                    recommendedTools: ['find_sprite_candidates', 'grep', 'replace_lines', 'get_diagnostics'],
                    avoidTools: ['inventing GFX_* names', 'raw .dds paths in sprite fields'],
                    nextInstruction: 'Resolve the sprite through verified project or vanilla .gfx candidates before editing the offending line.',
                };
            case 'unknown_sound':
                return {
                    recommendedTools: ['find_sound_candidates', 'grep', 'replace_lines', 'get_diagnostics'],
                    avoidTools: ['inventing sound names', 'raw audio paths where an asset name is expected'],
                    nextInstruction: 'Resolve the sound/music asset through verified .asset candidates before editing the offending line.',
                };
            case 'missing_localisation':
                return {
                    recommendedTools: ['query_localisation_index', 'grep', 'write_localisation', 'get_diagnostics'],
                    avoidTools: ['write_file on .yml localisation files', 'duplicating keys without searching first'],
                    nextInstruction: `Search for the key first; if absent, use write_localisation on a real localisation path, then verify diagnostics.${staleHint}`,
                };
            case 'scope_mismatch':
                return {
                    recommendedTools: ['query_scope', 'query_rules', 'read_file', 'document_symbols'],
                    avoidTools: ['guessing scope transitions'],
                    nextInstruction: 'Use CWTools scope/rule queries to verify the legal scope chain before changing triggers or effects.',
                };
            case 'invalid_value_type':
                return {
                    recommendedTools: ['query_rules', 'query_scope', 'read_file', 'verify_pdx_identifier', ...referenceTools],
                    avoidTools: ['guessing enum/type values', 'copying unrelated vanilla values without scope/rule evidence'],
                    nextInstruction: 'Read the exact field rule and current scope, then replace only the invalid value with a verified type-correct candidate.',
                };
            case 'missing_definition':
                return {
                    recommendedTools: ['go_to_definition', 'workspace_symbols', 'grep', 'verify_pdx_identifier', ...referenceTools],
                    avoidTools: ['creating duplicate definitions before checking vanilla/project sources'],
                    nextInstruction: 'Verify whether the referenced ID exists in workspace or vanilla before creating or renaming anything.',
                };
            case 'duplicate_definition':
                return {
                    recommendedTools: ['go_to_definition', 'workspace_symbols', 'document_symbols', 'read_file'],
                    avoidTools: ['deleting definitions without checking references', 'renaming both copies blindly'],
                    nextInstruction: 'Locate both definitions and references, then remove or rename only the unintended duplicate.',
                };
            case 'unknown_trigger_effect':
                return {
                    recommendedTools: ['query_rules', 'query_scripted_triggers', 'query_scripted_effects', 'go_to_definition', 'workspace_symbols', ...referenceTools],
                    avoidTools: ['web_search as first step', 'renaming identifiers by guesswork'],
                    nextInstruction: 'Check local CWT rules and workspace/project/vanilla definitions first, then edit only the invalid trigger/effect reference.',
                };
            case 'stale_lsp_cache':
                return {
                    recommendedTools: ['get_diagnostics', 'go_to_definition', 'workspace_symbols', ...referenceTools],
                    avoidTools: ['duplicate localisation/entity creation', 'blind retries', 'no-op dummy edits to force freshness'],
                    nextInstruction: referenceVerificationRequired
                        ? 'Verify whether the concrete referenced entity/key already exists before writing again; wait for fresh diagnostics if global checks are pending.'
                        : 'No concrete syntax or diagnostic errors were introduced. Do not perform dummy or no-op edits to force freshness; accept deterministic validation results if the code is correct.',
                };
            case 'lsp_no_feedback':
                return {
                    recommendedTools: ['get_diagnostics'],
                    avoidTools: ['grep without a concrete identifier', 'duplicate entity/localisation creation', 'blind retries'],
                    nextInstruction: 'The LSP feedback path did not confirm semantic diagnostics. Do not search project/vanilla without a concrete diagnostic identifier; use the degraded validation warning as a caveat or retry get_diagnostics later.',
                };
            default:
                return {
                    recommendedTools: requiredFreshRead
                        ? ['read_file', 'get_diagnostics']
                        : ['read_file', 'query_rules', 'get_diagnostics', ...referenceTools],
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
     *  during a reasoning loop (connect + initialize handshake can take 500ms+).
     *  The fingerprint detects config edits (settings or mcp.json) so a changed
     *  server is reconnected instead of reused. */
    private mcpPool = new Map<string, { client: import('./mcpClient').MCPClient; lastUsed: number; timer: ReturnType<typeof setTimeout>; fingerprint: string }>();
    /** Idle timeout before an MCP connection is automatically disconnected (ms). */
    private static readonly MCP_IDLE_TIMEOUT_MS = 60_000;

    /** Version token of the last mcp.json warning set we logged (log once per file change). */
    private lastLoggedMcpConfigVersion?: string;

    /**
     * Merge MCP servers from VS Code settings (lowest priority), the user-level
     * ~/.cwtools/mcp.json, and the project-level .cwtools/mcp.json (highest
     * priority, untrusted — see ensureProjectMcpServerApproved).
     */
    private getMergedMcpServers(): SourcedMCPServerConfig[] {
        const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const settingsServers = config.get<import('./types').MCPServerConfig[]>('mcp.servers') || [];
        const fileConfigs = loadMcpServerFileConfigs(this.workspaceRoot || undefined);
        if (fileConfigs.warnings.length > 0 && fileConfigs.version !== this.lastLoggedMcpConfigVersion) {
            this.lastLoggedMcpConfigVersion = fileConfigs.version;
            for (const warning of fileConfigs.warnings) {
                ErrorReporter.warn('mcp', warning);
            }
        }
        return mergeMcpServerConfigs(settingsServers, fileConfigs.home, fileConfigs.project);
    }

    private static mcpServerFingerprint(server: SourcedMCPServerConfig): string {
        return JSON.stringify(server);
    }

    /** Get or create a pooled MCP client for the given server. */
    private async getMcpClient(serverName: string, abortSignal?: AbortSignal): Promise<import('./mcpClient').MCPClient> {
        const servers = this.getMergedMcpServers();
        const serverConfig = servers.find(server => server.name === serverName);
        if (!serverConfig) throw new Error(`MCP server "${serverName}" not found in configuration`);
        if (!['paradox', 'general', 'both'].includes(serverConfig.capabilityDomain)) {
            throw new Error(`MCP server "${serverName}" must declare capabilityDomain`);
        }
        const fingerprint = AgentToolExecutor.mcpServerFingerprint(serverConfig);

        const cached = this.mcpPool.get(serverName);
        if (cached && cached.fingerprint === fingerprint) {
            cached.lastUsed = Date.now();
            // Reset idle timer
            clearTimeout(cached.timer);
            cached.timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
            return cached.client;
        }
        if (cached) this.evictMcpClient(serverName);

        // Create new connection
        const { MCPClient } = await import('./mcpClient');
        const client = new MCPClient(serverConfig);
        await client.connect(abortSignal);

        const timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
        this.mcpPool.set(serverName, { client, lastUsed: Date.now(), timer, fingerprint });
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
        configVersion: string;
        defs: import('./types').ToolDefinition[];
    };
    /** Reverse map for registered dynamic names — avoids ambiguous parsing when server names contain '_'. */
    private dynamicMcpToolNames = new Map<string, { server: string; tool: string }>();
    private static readonly MCP_TOOL_CACHE_TTL_MS = 300_000;

    /** List configured MCP servers' tools as mcp_<server>_<tool> definitions. Opt-in; metadata is untrusted. */
    async getDynamicMcpToolDefinitions(
        mode: import('./types').AgentMode,
        domain: import('./types').AgentRuntimeDomain,
    ): Promise<import('./types').ToolDefinition[]> {
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        if (cfg.get<boolean>('mcp.registerDynamicTools', false) !== true) return [];
        if (!evaluateEffectiveToolPolicy('mcp_call', { mode, domain }).allowed) return [];

        const runtimeDomain = domain;
        const servers = this.getMergedMcpServers();
        // Include the mcp.json file fingerprint so edits invalidate within one TTL.
        const configVersion = `${loadMcpServerFileConfigs(this.workspaceRoot || undefined).version}#${servers.length}`;
        if (this.dynamicMcpToolCache
            && this.dynamicMcpToolCache.domain === runtimeDomain
            && this.dynamicMcpToolCache.configVersion === configVersion
            && Date.now() - this.dynamicMcpToolCache.at < AgentToolExecutor.MCP_TOOL_CACHE_TTL_MS) {
            return this.dynamicMcpToolCache.defs;
        }
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
        this.dynamicMcpToolCache = { domain: runtimeDomain, at: Date.now(), configVersion, defs };
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
    }, context?: import('./types').AgentToolContext): Promise<{ success: boolean; result?: unknown; error?: string; terminalOutcome?: import('./types').ToolTerminalOutcome }> {
        let serverName = args.server;
        let toolName = args.tool;
        let isDynamicNameCall = false;

        // Dynamic MCP names are valid only when disclosed and registered for this run.
        if (!serverName && args._toolName) {
            isDynamicNameCall = true;
            const mapped = this.dynamicMcpToolNames.get(args._toolName);
            if (mapped) {
                serverName = mapped.server;
                toolName = mapped.tool;
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

        const isSubAgent = !!context?.runnerOptions?.useSlimPrompt;
        let mcpRules: Record<string, string> | undefined;
        try {
            mcpRules = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<{ mcp?: Record<string, string> }>('permissions')?.mcp;
        } catch { /* configuration unavailable (tests) — fall back to defaults */ }
        const permission = evaluateMcpPermission(serverName, toolName, { isSubAgent, rules: mcpRules });
        if (!permission.allowed && permission.action === 'deny') {
            return { success: false, error: permission.reason };
        }

        const runtimeDomain = context?.runnerOptions?.schedulingState.domainProfile;
        if (!runtimeDomain) {
            return { success: false, error: 'MCP calls require an active scheduler context.', terminalOutcome: 'policy_denied' };
        }
        const configuredServers = this.getMergedMcpServers();
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

    private executeEnterPlanMode(args: Record<string, unknown>, context?: import('./types').AgentToolContext): unknown {
        const runnerState = context?.runnerOptions?.schedulingState;
        if (!runnerState) {
            return { success: false, error: 'enter_plan_mode requires an active scheduler context.' };
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 400) : '';
        if (!reason) {
            return { success: false, error: 'enter_plan_mode requires a reason naming the user-owned decision.' };
        }
        if (runnerState.phase === 'plan') {
            return {
                success: true,
                alreadyActive: true,
                message: aiText(
                    'Plan mode is already active for this turn. Investigate and produce the complete Implementation Plan, then stop for approval.',
                    '本回合已处于计划模式。请完成调研并产出完整的 Implementation Plan，然后停止等待批准。',
                ),
            };
        }
        const next = transitionSchedulingState(runnerState, {
            phase: 'plan',
            authorization: 'plan_write_only',
            reason: 'agent entered plan mode: ' + reason,
        });
        if (AUTHORITY_RANK[next.authorization] > AUTHORITY_RANK[runnerState.authorization]) {
            return { success: false, error: 'enter_plan_mode cannot widen authorization.' };
        }
        Object.assign(runnerState, next);
        context?.runnerOptions?.runEventSink?.appendSoon('phase_changed', {
            previousPhase: runnerState.phase,
            state: next,
            enteredBy: 'enter_plan_mode',
            reason,
        }, { status: 'done' });
        return {
            success: true,
            phase: 'plan',
            authorization: next.authorization,
            message: aiText(
                'Plan mode is active from the next step. Project writes are blocked; the only allowed write is the topic-scoped Implementation Plan artifact. Investigate first, then produce the complete plan and stop for approval.',
                '计划模式将从下一步生效。项目写入被阻止，唯一允许的写入是话题范围内的 Implementation Plan 产物。请先完成调研，再产出完整计划并停止等待批准。',
            ),
            reason,
        };
    }

    private executeExitPlanMode(args: Record<string, unknown>, context?: import('./types').AgentToolContext): unknown {
        const runnerState = context?.runnerOptions?.schedulingState;
        if (!runnerState) {
            return { success: false, error: 'exit_plan_mode requires an active scheduler context.' };
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 400) : '';
        if (runnerState.phase !== 'plan') {
            return {
                success: false,
                error: aiText(
                    'exit_plan_mode is only valid while Plan mode is active.',
                    'exit_plan_mode 仅在计划模式生效期间可用。',
                ),
            };
        }
        const next = transitionSchedulingState(runnerState, {
            phase: 'inspect',
            reason: 'agent left plan mode without an approved plan: ' + (reason || 'not needed'),
        });
        Object.assign(runnerState, next);
        context?.runnerOptions?.runEventSink?.appendSoon('phase_changed', {
            previousPhase: runnerState.phase,
            state: next,
            enteredBy: 'exit_plan_mode',
            reason,
        }, { status: 'done' });
        return {
            success: true,
            phase: 'inspect',
            authorization: next.authorization,
            message: aiText(
                'Plan mode ended. Project writes remain blocked for this turn because no plan was approved; report your findings and what you would do, then let the user decide.',
                '计划模式已结束。由于没有计划获得批准，本回合项目写入仍被阻止；请报告你的发现和建议的做法，然后交由用户决定。',
            ),
        };
    }

    private toWorkspaceRel(filePath: string | undefined): string | undefined {
        if (!filePath) return undefined;
        const resolved = path.resolve(filePath);
        if (this.workspaceRoot && isPathInsideOrEqual(resolved, this.workspaceRoot)) {
            return path.relative(this.workspaceRoot, resolved).replace(/\\/g, '/');
        }
        return resolved.replace(/\\/g, '/');
    }

    private async executeGetIdeContext(args: Record<string, unknown>): Promise<unknown> {
        const includeSelectionText = args.includeSelectionText !== false;
        const includeActiveFileDiagnostics = args.includeActiveFileDiagnostics !== false;
        const editor = vs.window.activeTextEditor;

        let activeEditorInfo: Record<string, unknown> | null = null;
        if (editor) {
            const doc = editor.document;
            const sel = editor.selection;
            const selectedRaw = includeSelectionText && !sel.isEmpty ? doc.getText(sel) : '';
            const selectedText = selectedRaw.length > 4000
                ? `${selectedRaw.slice(0, 4000)}\n...[truncated, full ${selectedRaw.length} chars]`
                : selectedRaw;
            const diagnostics = includeActiveFileDiagnostics
                ? (vs.languages.getDiagnostics(doc.uri) ?? []).slice(0, 100).map(d => ({
                    line: d.range.start.line + 1,
                    column: d.range.start.character + 1,
                    severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vs.DiagnosticSeverity.Warning ? 'warning' : 'info',
                    code: typeof d.code === 'object' && d.code !== null
                        ? String((d.code as { value?: unknown }).value ?? '')
                        : String(d.code ?? ''),
                    message: d.message,
                    source: d.source ?? 'cwtools',
                }))
                : undefined;

            activeEditorInfo = {
                file: this.toWorkspaceRel(doc.uri.fsPath),
                absolutePath: doc.uri.fsPath,
                languageId: doc.languageId,
                lineCount: doc.lineCount,
                isDirty: doc.isDirty,
                cursor: {
                    line: sel.active.line + 1,
                    column: sel.active.character + 1,
                },
                selection: {
                    isEmpty: sel.isEmpty,
                    startLine: sel.start.line + 1,
                    startColumn: sel.start.character + 1,
                    endLine: sel.end.line + 1,
                    endColumn: sel.end.character + 1,
                    ...(includeSelectionText && !sel.isEmpty ? { text: selectedText } : {}),
                },
                ...(diagnostics ? { diagnostics, diagnosticCount: diagnostics.length } : {}),
            };
        }

        const dirtyDocuments = (vs.workspace.textDocuments ?? [])
            .filter(doc => doc.isDirty && !doc.isUntitled && doc.uri.scheme === 'file')
            .slice(0, 50)
            .map(doc => ({
                file: this.toWorkspaceRel(doc.uri.fsPath),
                languageId: doc.languageId,
                lineCount: doc.lineCount,
            }));

        const visualPanels: Array<Record<string, unknown>> = [];
        try {
            const { GuiPanel } = await import('../guiPanel');
            if (GuiPanel.currentPanel) {
                const guiDoc = (GuiPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                let guiSummary: Record<string, unknown> | undefined;
                if (guiDoc) {
                    const { parseGuiFile } = await import('../guiParser');
                    const parsedElements = parseGuiFile(guiDoc.getText(), new Map());
                    guiSummary = {
                        elementCount: parsedElements.length,
                        topLevelWindows: parsedElements.slice(0, 25).map(el => ({
                            type: el.type,
                            name: el.name,
                            line: el.line,
                            childCount: el.children.length,
                        })),
                    };
                }
                visualPanels.push({
                    editor: 'gui',
                    open: true,
                    file: this.toWorkspaceRel(guiDoc?.uri.fsPath),
                    ...(guiSummary ? { summary: guiSummary } : {}),
                });
            }
        } catch { /* ignore when panel module is unavailable in headless unit tests */ }

        try {
            const { EntityPanel } = await import('../entityPanel');
            if (EntityPanel.currentPanel) {
                const entityDoc = (EntityPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'entity',
                    open: true,
                    file: this.toWorkspaceRel(entityDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { ParticlePanel } = await import('../particlePanel');
            if (ParticlePanel.currentPanel) {
                const particleDoc = (ParticlePanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'particle',
                    open: true,
                    file: this.toWorkspaceRel(particleDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { SolarSystemPanel } = await import('../solarSystemPanel');
            if (SolarSystemPanel.currentPanel) {
                const solarDoc = (SolarSystemPanel.currentPanel as unknown as { _document?: vs.TextDocument })._document;
                visualPanels.push({
                    editor: 'solar_system',
                    open: true,
                    file: this.toWorkspaceRel(solarDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { TechTreePanel } = await import('../techTreePanel');
            if (TechTreePanel.currentPanel) {
                const techDoc = (TechTreePanel.currentPanel as unknown as { _seedDocument?: vs.TextDocument })._seedDocument;
                visualPanels.push({
                    editor: 'tech_tree',
                    open: true,
                    seedFile: this.toWorkspaceRel(techDoc?.uri.fsPath),
                });
            }
        } catch { /* ignore */ }

        try {
            const { EventChainPanel } = await import('../eventChainPanel');
            if (EventChainPanel.currentPanel) {
                visualPanels.push({
                    editor: 'event_chain',
                    open: true,
                });
            }
        } catch { /* ignore */ }

        try {
            const { TargetWeightPanel } = await import('../targetWeightPanel');
            if (TargetWeightPanel.currentPanel) {
                visualPanels.push({
                    editor: 'target_weight',
                    open: true,
                });
            }
        } catch { /* ignore */ }

        return {
            success: true,
            workspaceRoot: this.workspaceRoot,
            activeEditor: activeEditorInfo,
            dirtyDocuments,
            visualPanels,
        };
    }

    private async executeOpenInVisualEditor(args: Record<string, unknown>): Promise<unknown> {
        const rawFile = typeof args.file === 'string' ? args.file.trim() : '';
        const requestedEditor = typeof args.editor === 'string' ? args.editor.trim() : 'auto';
        const line = typeof args.line === 'number' && Number.isInteger(args.line) && args.line >= 1
            ? args.line
            : undefined;

        const extensionPath = this.extensionPath;
        if (!extensionPath) {
            return {
                success: false,
                error: 'Visual editor panels require an active VS Code Extension Host with extensionPath configured.',
            };
        }

        let targetDoc: vs.TextDocument | undefined;
        let resolvedFile: string | undefined;
        if (rawFile) {
            resolvedFile = path.isAbsolute(rawFile)
                ? path.resolve(rawFile)
                : path.resolve(this.workspaceRoot, rawFile);
            if (!isPathInsideOrEqual(resolvedFile, this.workspaceRoot)) {
                return {
                    success: false,
                    error: `Target file '${rawFile}' must be inside the workspace root.`,
                };
            }
            if (!fs.existsSync(resolvedFile)) {
                return {
                    success: false,
                    error: `Target file not found: '${rawFile}'.`,
                };
            }
            targetDoc = await vs.workspace.openTextDocument(vs.Uri.file(resolvedFile));
        } else {
            targetDoc = vs.window.activeTextEditor?.document;
            resolvedFile = targetDoc?.uri.fsPath;
        }

        const relPath = this.toWorkspaceRel(resolvedFile) ?? '';
        const lowerRel = relPath.toLowerCase();

        let editorKind = requestedEditor;
        if (!editorKind || editorKind === 'auto') {
            if (lowerRel.endsWith('.gui')) {
                editorKind = 'gui';
            } else if (lowerRel.endsWith('.asset')) {
                const text = targetDoc?.getText() ?? (resolvedFile ? fs.readFileSync(resolvedFile, 'utf8') : '');
                editorKind = /(?:^|\n)\s*particle\s*=\s*\{/.test(text) ? 'particle' : 'entity';
            } else if (lowerRel.includes('solar_system_initializers')) {
                editorKind = 'solar_system';
            } else if (lowerRel.includes('common/technology')) {
                editorKind = 'tech_tree';
            } else if (lowerRel.includes('common/component_templates')) {
                editorKind = 'target_weight';
            } else if (lowerRel.startsWith('events/') || lowerRel.includes('/events/')) {
                editorKind = 'event_chain';
            } else {
                return {
                    success: false,
                    error: `Could not auto-infer visual editor for '${relPath || '(no file)'}'. Specify editor explicitly: gui | entity | particle | solar_system | tech_tree | event_chain | target_weight.`,
                };
            }
        }

        switch (editorKind) {
            case 'gui': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.gui')) {
                    return { success: false, error: 'GUI Preview requires a .gui file.' };
                }
                const { GuiPanel } = await import('../guiPanel');
                const { parseGuiFile } = await import('../guiParser');
                await GuiPanel.create(extensionPath, targetDoc);
                const parsedElements = parseGuiFile(targetDoc.getText(), new Map());
                return {
                    success: true,
                    editor: 'gui',
                    file: relPath,
                    summary: {
                        elementCount: parsedElements.length,
                        topLevelWindows: parsedElements.slice(0, 30).map(el => ({
                            type: el.type,
                            name: el.name,
                            line: el.line,
                            childCount: el.children.length,
                        })),
                    },
                };
            }
            case 'entity': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.asset')) {
                    return { success: false, error: 'Entity Preview requires a .asset file.' };
                }
                const { EntityPanel } = await import('../entityPanel');
                const { parseAssetFile } = await import('../entityAssetParser');
                await EntityPanel.create(extensionPath, targetDoc);
                const parsed = parseAssetFile(targetDoc.getText(), targetDoc.uri.fsPath);
                return {
                    success: true,
                    editor: 'entity',
                    file: relPath,
                    summary: {
                        entityCount: parsed.entities.length,
                        entities: parsed.entities.slice(0, 30).map(ent => ({
                            name: ent.name,
                            pdxmesh: ent.pdxmesh,
                            line: ent.line,
                            stateCount: ent.states.length,
                            locatorCount: ent.locators.length,
                        })),
                    },
                };
            }
            case 'particle': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.asset')) {
                    return { success: false, error: 'Particle Preview requires a .asset file.' };
                }
                const { ParticlePanel } = await import('../particlePanel');
                const { parseParticleFile } = await import('../particleAssetParser');
                await ParticlePanel.create(extensionPath, targetDoc);
                const parsedParticle = parseParticleFile(targetDoc.getText());
                return {
                    success: true,
                    editor: 'particle',
                    file: relPath,
                    summary: {
                        effectCount: parsedParticle.effects.length,
                        effects: parsedParticle.effects.slice(0, 30).map(eff => ({
                            name: eff.name,
                            subsystemCount: eff.subsystems.length,
                        })),
                    },
                };
            }
            case 'solar_system': {
                if (!targetDoc || !targetDoc.fileName.toLowerCase().endsWith('.txt')) {
                    return { success: false, error: 'Solar System Preview requires a .txt initializer file.' };
                }
                const { SolarSystemPanel } = await import('../solarSystemPanel');
                const { parseSolarSystemFile } = await import('../solarSystemParser');
                await SolarSystemPanel.create(extensionPath, targetDoc);
                const systems = parseSolarSystemFile(targetDoc.getText());
                return {
                    success: true,
                    editor: 'solar_system',
                    file: relPath,
                    summary: {
                        systemCount: systems.length,
                        systems: systems.slice(0, 30).map(sys => ({
                            key: sys.key,
                            displayName: sys.displayName,
                            starClass: sys.starClass,
                            line: sys.line,
                            bodyCount: sys.bodies.length,
                        })),
                    },
                };
            }
            case 'tech_tree': {
                const { TechTreePanel } = await import('../techTreePanel');
                await TechTreePanel.create(extensionPath, targetDoc);
                return {
                    success: true,
                    editor: 'tech_tree',
                    file: relPath || undefined,
                };
            }
            case 'event_chain': {
                const { EventChainPanel } = await import('../eventChainPanel');
                await EventChainPanel.create(
                    extensionPath,
                    targetDoc,
                    line ?? (vs.window.activeTextEditor ? vs.window.activeTextEditor.selection.active.line + 1 : undefined),
                );
                return {
                    success: true,
                    editor: 'event_chain',
                    file: relPath || undefined,
                    line,
                };
            }
            case 'target_weight': {
                const { TargetWeightPanel } = await import('../targetWeightPanel');
                await TargetWeightPanel.create(extensionPath, {
                    indexService: this.indexService,
                    cursor: targetDoc
                        ? { document: targetDoc, line: line ?? (vs.window.activeTextEditor?.selection.active.line ?? 0) + 1 }
                        : undefined,
                });
                return {
                    success: true,
                    editor: 'target_weight',
                    file: relPath || undefined,
                    line,
                };
            }
            default:
                return {
                    success: false,
                    error: `Unsupported visual editor '${editorKind}'.`,
                };
        }
    }

    // - Public accessors for external consumers -

    getTodos(agentId?: string): TodoItem[] { return this.externalHandler.getTodos(agentId); }
    restoreTodos(todos: readonly TodoItem[], agentId?: string): void {
        this.externalHandler.restoreTodos(todos, agentId);
        this.onTodoUpdate?.(this.externalHandler.getTodos(agentId), agentId ? { agentId } : undefined);
    }
    clearTodos(agentId?: string): void { this.externalHandler.clearTodos(agentId); }
}
