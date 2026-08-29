/** 
* Eddy CWTool Code — Quality Gate 
* 
* After writable child profiles complete, the quality gate runs an independent review.
* Supports multiple rounds of repair cycles (up to 3 rounds) to ensure code quality. 
*/

import type { QualityGateResult, TaskGraph } from './types';
import * as path from 'path';
import type { AgentStep, GenerationResult, TokenUsage } from '../types';
import { aiText } from '../messages';
import type { RunEventSink } from '../runner/runContext';
import { SemanticVerifier } from './semanticVerifier';
import { mergeTokenUsageTotals } from '../cacheCapability';
import type { UserExecutionPolicy } from './userExecutionPolicy';
import { schedulingStateFromAdmission } from '../runner/scheduling';

/** Quality gate configuration */
export interface QualityGateConfig {
    /** Maximum number of repair cycles */
    maxFixCycles: number;
    /** Whether to enable automatic repair (false = report only) */
    autoFix: boolean;
}

/**Default configuration */
const DEFAULT_CONFIG: QualityGateConfig = {
    maxFixCycles: 3,
    autoFix: true,
};

const QUALITY_GATE_REVIEW_AGENT_ID = 'quality_gate_review';
const QUALITY_GATE_REVIEW_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const QUALITY_GATE_REVIEW_MAX_ITERATIONS = 15;
const QUALITY_GATE_PREFLIGHT_CONCURRENCY = 4;

export interface QualityGateReviewContext {
    taskGraph?: TaskGraph;
    workspaceRoot?: string;
    handoffs?: import('../runner/agentHandoff').AgentHandoff[];
}

export const PDX_DIAGNOSTIC_EXTENSIONS = ['.txt', '.gui', '.gfx', '.asset', '.entity'] as const;

export function isPdxDiagnosticFile(file: string): boolean {
    const normalized = file.toLowerCase();
    return PDX_DIAGNOSTIC_EXTENSIONS.some(ext => normalized.endsWith(ext));
}

function isParadoxTaskGraph(graph: TaskGraph | undefined): boolean {
    if (!graph) return true;
    return [...graph.nodes.values()].some(node =>
        ['paradox-coder', 'localization-writer', 'gui-expert'].includes(node.profileName));
}

function qualityGateAbortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error(signal.reason ? String(signal.reason) : 'Quality gate cancelled.');
    error.name = 'AbortError';
    return error;
}

async function qualityGateAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw qualityGateAbortError(signal);
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(qualityGateAbortError(signal));
        signal.addEventListener('abort', listener, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (listener) signal.removeEventListener('abort', listener);
    }
}

async function mapQualityGateBounded<T, R>(
    values: readonly T[],
    signal: AbortSignal,
    mapper: (value: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            if (signal.aborted) throw qualityGateAbortError(signal);
            const index = cursor++;
            if (index >= values.length) return;
            results[index] = await qualityGateAwait(mapper(values[index]!), signal);
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(QUALITY_GATE_PREFLIGHT_CONCURRENCY, values.length) },
        () => worker(),
    ));
    return results;
}

export const SPRITE_REPAIR_PROTOCOL = [
    '## Sprite Resource Diagnostic Protocol',
    '',
    'When any diagnostic says `Expected value of type sprite` or a field such as `picture`, `icon`, or `spriteType` references a missing/invalid `GFX_*` value:',
    '1. Treat it as an asset reference error, not as a generic syntax error.',
    '2. The value for a sprite-typed field must be an existing sprite name (usually `GFX_*`), never a raw `.dds` file path.',
    '3. Before proposing or applying a replacement, call `find_sprite_candidates` with the invalid value, the field name, and `searchContext="both"` so both project and vanilla `.gfx` sprite definitions are available.',
    '4. Prefer a project sprite candidate first, then a vanilla candidate whose indexed metadata and surrounding field context match the requested role. Do not infer asset families from hard-coded game prefixes.',
    '5. If no candidate is returned, retry with broader keywords taken from surrounding project content and indexed asset metadata before declaring it blocked.',
    '6. Fix only the offending line with guarded `replace_lines` when line numbers are known, then run `get_diagnostics` on the file again.',
].join('\n');

export const SOUND_REPAIR_PROTOCOL = [
    '## Sound Asset Diagnostic Protocol',
    '',
    'When any diagnostic or field involves `show_sound = ...`, `sound = ...`, missing sound references, or an expected sound/music asset:',
    '1. Treat it as an asset lookup, not as a generic syntax error.',
    '2. The value should be an existing sound/music asset name from `.asset` definitions, not a raw `.wav`/`.ogg` path unless the local rule explicitly expects a file path.',
    '3. Before proposing or applying a replacement, call `find_sound_candidates` with the invalid value, the field name, and `searchContext="both"` so both project and vanilla `.asset` definitions are available.',
    '4. Prefer a project asset candidate first, then a semantically close vanilla candidate. For `show_sound`, prefer event/UI sound effects over music tracks unless the surrounding code clearly expects music.',
    '5. If no candidate is returned, retry with broader keywords from the surrounding content before declaring it blocked.',
    '6. Fix only the offending line with guarded `replace_lines` when line numbers are known, then run `get_diagnostics` on the file again.',
].join('\n');

/** 
* Quality gate. 
* 
* Workflow: 
* 1. Builder Agent completes code generation 
* 2. QualityGate automatically generates review prompts from written files
* 3. Run the reviewer profile
* 4. If a problem is found and autoFix = true: 
* - Generate repair prompt and call Builder Agent to repair 
* - re-examine (up to maxFixCycles rounds) 
* 5. Output the final review report 
*/
export class QualityGate {
    private config: QualityGateConfig;
    private eventSink?: RunEventSink;

    constructor(config?: Partial<QualityGateConfig>, eventSink?: RunEventSink) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventSink = eventSink;
    }

    setEventSink(eventSink?: RunEventSink): void {
        this.eventSink = eventSink;
    }

    /** 
* Generate comprehensive review prompt. 
* Build targeted review instructions based on a list of all files written. 
*/
    buildCombinedReviewPrompt(
        writtenFiles: string[],
        preFetchedDiagnostics?: string,
        reviewContext?: QualityGateReviewContext,
        semanticReport?: string,
    ): string {
        const fileList = writtenFiles.length > 0
            ? writtenFiles.map(f => `- ${f}`).join('\n')
            : '(No file write records)';

        // W3 fix: Explicitly prohibit Reviewer from repeatedly calling get_diagnostics when prefetch diagnostics exist
        const diagnosticsSection = preFetchedDiagnostics 
            ? `\n## Pre-fetched LSP Diagnostics (ALREADY RETRIEVED — DO NOT call get_diagnostics again):\n${preFetchedDiagnostics}\n` 
            : '';

        const diagnosticTargets = writtenFiles.filter(isPdxDiagnosticFile);
        const diagnosticTargetText = PDX_DIAGNOSTIC_EXTENSIONS.join(', ');
        const step1 = preFetchedDiagnostics
            ? '1. Review the pre-fetched diagnostics above.'
            : `1. Diagnostics were not pre-fetched. You may call \`get_diagnostics\` if needed, especially for LSP diagnostic target files (${diagnosticTargetText}).`;

        const hasSpriteDiagnostics = /Expected value of type sprite|type sprite|spriteType|picture|GFX_/i.test(preFetchedDiagnostics ?? '');
        const hasSoundDiagnostics = /show_sound|Expected value of type sound|type sound|sound\s*=|music|\.asset/i.test(preFetchedDiagnostics ?? '');
        const spriteSection = hasSpriteDiagnostics ? `\n${SPRITE_REPAIR_PROTOCOL}\n` : '';
        const soundSection = hasSoundDiagnostics ? `\n${SOUND_REPAIR_PROTOCOL}\n` : '';
        const featureManifest = reviewContext?.taskGraph?.metadata.featureManifest;
        const userExecutionPolicy = reviewContext?.taskGraph?.metadata.userExecutionPolicy;
        const userPolicySection = userExecutionPolicy
            ? [
                '## Host-Enforced User Execution Policy',
                `- Localisation ownership: ${userExecutionPolicy.localisationOwnership}`,
                `- Warning handling: ${userExecutionPolicy.warningHandling}`,
                '- Error-severity LSP diagnostics remain blocking regardless of warning preferences.',
                ...(userExecutionPolicy.localisationOwnership === 'user'
                    ? ['- The user retained localisation work. Do not request, suggest, or perform localisation writes. Missing-localisation warnings are non-blocking; an error-severity diagnostic must still be reported as blocking user action.']
                    : []),
                ...(userExecutionPolicy.warningHandling === 'ignore'
                    ? ['- Do not include warning/info/hint diagnostics in logicIssuesCount, acceptanceFailures, or fixSuggestions. You may mention them as non-blocking observations only.']
                    : []),
                '',
            ]
            : [];
        const requestSection = reviewContext?.taskGraph
            ? [
                '## Original User Request',
                reviewContext.taskGraph.metadata.userPrompt,
                '',
                '## Feature Manifest',
                JSON.stringify(featureManifest ?? { objective: reviewContext.taskGraph.metadata.userPrompt }, null, 2),
                '',
            ]
            : [];
        const semanticSection = semanticReport
            ? ['## Deterministic Semantic Report', semanticReport, '']
            : [];
        const handoffSection = reviewContext?.handoffs?.length
            ? [
                '## Structured Builder Handoffs',
                JSON.stringify(reviewContext.handoffs.map(handoff => ({
                    summary: handoff.summary,
                    changedFiles: handoff.changedFiles,
                    verification: handoff.verification,
                    unresolved: handoff.unresolved,
                })), null, 2),
                'Treat verification as a claim to check independently. Every unresolved item is a mandatory review target.',
                '',
            ]
            : [];
        const paradoxReview = isParadoxTaskGraph(reviewContext?.taskGraph);
        const reviewChecklist = paradoxReview
            ? [
                step1,
                '2. Check logic contradictions and unintended behavior.',
                '3. Check cross-file reference consistency using dynamic CWT/LSP evidence.',
                '4. Verify scope chains and current-game rule constraints.',
                '5. Check file structure integrity and functional completeness.',
                diagnosticTargets.length > 0 ? `6. LSP diagnostic target files include: ${diagnosticTargets.join(', ')}` : '6. No PDX LSP diagnostic target files were written.',
                '7. Check every required Feature Manifest edge and acceptance criterion with concrete evidence.',
            ]
            : [
                '1. Read the changed files and relevant callers/tests; do not apply Paradox-specific assumptions.',
                '2. Check correctness, regressions, error handling, security boundaries, cancellation/disposal, and deterministic behavior.',
                '3. Check public contracts and cross-file integration against the original request.',
                '4. Check whether tests and verification are sufficient for the change.',
                '5. Check every required acceptance criterion with concrete file/line or test evidence.',
            ];

        return [
            '## Quality Gate Review Task',
            '',
            ...requestSection,
            ...userPolicySection,
            'Please review the code quality of the following files:',
            fileList,
            diagnosticsSection,
            spriteSection,
            soundSection,
            ...semanticSection,
            ...handoffSection,
            'Review Checklist:',
            ...reviewChecklist,
            '',
            'Output Format (You MUST output EXACTLY this JSON format in a markdown code block):',
            '```json',
            '{',
            '  "logicIssuesCount": <number>,',
            '  "logicIssues": ["<issue 1>", "<issue 2>"],',
            '  "fixSuggestions": ["<suggestion 1>", "<suggestion 2>"],',
            '  "acceptanceEvidence": [{"id":"<criterion id>","passed":true,"evidence":"<file:line or deterministic evidence>"}],',
            '  "acceptanceFailures": ["<required criterion without evidence>"]',
            '}',
            '```',
            'IMPORTANT: Do not output PASSED or FAILED. The system automatically fails the quality gate for error-severity LSP diagnostics. Warning/info/hint diagnostics follow the Host-Enforced User Execution Policy and must never be promoted to errors.',
        ].join('\n');
    }

    /** 
* Perform review. 
* Pull up Reviewer Agent and analyze the results. 
*/
    async reviewOutput(
        agentRunner: import('../agentRunner').AgentRunner,
        writtenFiles: string[],
        options: Partial<import('../agentRunner').AgentRunnerOptions>,
        reviewContext?: QualityGateReviewContext,
        tokenAccumulator?: TokenUsage,
    ): Promise<QualityGateResult> {
        const taskGraph = reviewContext?.taskGraph;
        const paradoxReview = isParadoxTaskGraph(taskGraph);
        const reviewSchedulingState = {
            ...schedulingStateFromAdmission({
                domainProfile: paradoxReview ? 'paradox' : 'general',
                authorization: 'read_only',
                initialPhase: 'verify',
                explicitDelegation: false,
                confidence: 1,
                evidence: ['quality gate review'],
            }, 'quality gate review'),
            profileName: 'reviewer',
        };
        const workspaceRoot = reviewContext?.workspaceRoot ?? agentRunner.toolExecutor.workspaceRoot;
        const parentAbortSignal = options.abortSignal;
        const reviewController = new AbortController();
        const forwardParentAbort = () => reviewController.abort(parentAbortSignal?.reason);
        if (parentAbortSignal?.aborted) {
            forwardParentAbort();
        } else {
            parentAbortSignal?.addEventListener('abort', forwardParentAbort, { once: true });
        }
        const abortIdleReview = () => {
            const error = new Error(aiText(
                'Quality gate stopped after 20 minutes without observable progress.',
                '质量门连续 20 分钟没有可观察进展，已终止。',
            ));
            error.name = 'TimeoutError';
            reviewController.abort(error);
        };
        let reviewTimeout = setTimeout(abortIdleReview, QUALITY_GATE_REVIEW_IDLE_TIMEOUT_MS);
        const refreshReviewIdleTimeout = () => {
            clearTimeout(reviewTimeout);
            reviewTimeout = setTimeout(abortIdleReview, QUALITY_GATE_REVIEW_IDLE_TIMEOUT_MS);
        };
        const cleanupReviewBudget = () => {
            clearTimeout(reviewTimeout);
            parentAbortSignal?.removeEventListener('abort', forwardParentAbort);
        };

        let finalEvidence: Awaited<ReturnType<typeof agentRunner.toolExecutor.finalizePdxEvidence>>;
        let semantic: Awaited<ReturnType<SemanticVerifier['verify']>>;
        try {
            [finalEvidence, semantic] = await qualityGateAwait(Promise.all([
                paradoxReview && typeof agentRunner.toolExecutor.finalizePdxEvidence === 'function'
                    ? agentRunner.toolExecutor.finalizePdxEvidence(writtenFiles, {
                        runnerOptions: { schedulingState: reviewSchedulingState, abortSignal: reviewController.signal },
                    })
                    : Promise.resolve({ passed: true, filesChecked: [], conflictFiles: [], pendingFiles: [], coveragePendingFiles: [], report: '' }),
                paradoxReview && taskGraph
                    ? new SemanticVerifier().verify(workspaceRoot, writtenFiles, taskGraph, agentRunner.toolExecutor)
                    : Promise.resolve({
                        passed: true,
                        issues: [],
                        evidence: [],
                        acceptanceFailures: [],
                        filesChecked: writtenFiles,
                        report: '',
                    }),
            ]), reviewController.signal);
        } catch (error) {
            cleanupReviewBudget();
            throw error;
        }
        const expectedChanges = taskGraph?.metadata.featureManifest?.expectsFileChanges === true
            || [...(taskGraph?.nodes.values() ?? [])].some(node =>
                ['paradox-coder', 'localization-writer', 'gui-expert', 'general-coder'].includes(node.profileName)
                && ((node.plannedFiles?.length ?? 0) > 0 || (node.produces?.length ?? 0) > 0));
        if (writtenFiles.length === 0) {
            const acceptanceFailures = [...semantic.acceptanceFailures];
            if (expectedChanges) acceptanceFailures.push('Expected project changes were not written.');
            cleanupReviewBudget();
            return {
                passed: !expectedChanges && semantic.passed,
                diagnosticErrors: 0,
                logicIssues: semantic.issues.length,
                semanticIssues: semantic.issues.length,
                acceptanceFailures,
                filesChecked: [],
                semanticReport: semantic.report,
                fixSuggestions: semantic.issues.map(issue => issue.message),
                reviewReport: semantic.report || aiText('No file changes', '无文件修改'),
            };
        }

        let preFetchedDiagnostics = '';
        let diagnosticErrorCount = 0;
        let cachedDiagnosticErrorCount = 0;
        const validationPendingFiles = new Set<string>();
        const freshDiagnosticFiles = new Set<string>();
        try {
            const diagResults: string[] = [];
            const diagnosticTargets = paradoxReview ? [...new Set(writtenFiles.filter(isPdxDiagnosticFile))] : [];
            const results = await mapQualityGateBounded(
                diagnosticTargets,
                reviewController.signal,
                async file => {
                    refreshReviewIdleTimeout();
                    const result = await agentRunner.toolExecutor.execute(
                        'get_diagnostics',
                        { file, severity: 'error' },
                        { runnerOptions: { schedulingState: reviewSchedulingState, abortSignal: reviewController.signal } },
                    );
                    refreshReviewIdleTimeout();
                    return { file, result };
                },
            );
            for (const { file, result: res } of results) {
                const resolvedFile = path.isAbsolute(file) ? path.resolve(file) : path.resolve(workspaceRoot, file);
                if (res && typeof res === 'object') {
                    const record = res as Record<string, unknown>;
                    const summary = record.summary && typeof record.summary === 'object'
                        ? record.summary as Record<string, unknown>
                        : undefined;
                    const errorCount = typeof summary?.errors === 'number'
                        ? summary.errors
                        : Array.isArray(record.diagnostics)
                            ? record.diagnostics.filter(item => (item as any)?.severity === 'error').length
                            : (typeof record.totalDiagnosticCount === 'number' ? record.totalDiagnosticCount : 0);
                    const totalCount = typeof record.totalDiagnosticCount === 'number' ? record.totalDiagnosticCount : errorCount;
                    if (record.freshness === 'fresh' && errorCount > 0) {
                        diagnosticErrorCount += errorCount;
                        diagResults.push(`File: ${file}\n${JSON.stringify(record.diagnostics, null, 2)}`);
                    } else if (record.freshness !== 'fresh') {
                        if (errorCount > 0) {
                            cachedDiagnosticErrorCount += errorCount;
                            diagResults.push(`File: ${file}\n${errorCount} cached diagnostic error(s) are advisory because freshness is ${String(record.freshness ?? 'unavailable')}.`);
                        } else if (totalCount > 0) {
                            diagResults.push(`File: ${file}\n${totalCount} cached diagnostic(s) (non-error) are advisory because freshness is ${String(record.freshness ?? 'unavailable')}.`);
                        }
                    }
                    if (record.freshness !== 'fresh') {
                        validationPendingFiles.add(resolvedFile);
                        diagResults.push(`File: ${file}\nFinal diagnostics are ${String(record.freshness ?? 'unavailable')}; do not report this file as validated yet.`);
                    } else {
                        freshDiagnosticFiles.add(resolvedFile);
                    }
                } else {
                    validationPendingFiles.add(resolvedFile);
                }
            }
            if (diagResults.length > 0) {
                preFetchedDiagnostics = diagResults.join('\n\n');
            }
        } catch (error) {
            if (reviewController.signal.aborted) {
                cleanupReviewBudget();
                throw qualityGateAbortError(reviewController.signal);
            }
            validationPendingFiles.add('__diagnostics_unavailable__');
            preFetchedDiagnostics = `Final diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }

        const coveragePending = new Set(finalEvidence.coveragePendingFiles.map(file => path.resolve(file)));
        const unresolvedEvidencePending = finalEvidence.pendingFiles.filter(file =>
            !coveragePending.has(path.resolve(file)) || !freshDiagnosticFiles.has(path.resolve(file)));
        for (const file of unresolvedEvidencePending) validationPendingFiles.add(path.resolve(file));
        const validationPendingCount = validationPendingFiles.size;
        const coverageResolved = finalEvidence.coveragePendingFiles.length - unresolvedEvidencePending
            .filter(file => coveragePending.has(path.resolve(file))).length;
        const deterministicReport = [
            finalEvidence.report,
            coverageResolved > 0
                ? `Final fresh diagnostics covered ${coverageResolved} file(s) whose semantic extraction hit a safety bound.`
                : '',
            semantic.report,
        ].filter(Boolean).join('\n\n');

        // A reviewer cannot make the LSP fresher. If every deterministic logic,
        // semantic, evidence, and acceptance check passed and the only remaining
        // uncertainty is diagnostic freshness without introducing new errors,
        // accept once with an advisory and skip the token-heavy reviewer/repair stack.
        const freshnessOnlyPending = validationPendingCount > 0
            && unresolvedEvidencePending.length === 0
            && diagnosticErrorCount === 0
            && cachedDiagnosticErrorCount === 0
            && finalEvidence.conflictFiles.length === 0
            && semantic.issues.length === 0
            && semantic.acceptanceFailures.length === 0;
        if (freshnessOnlyPending) {
            cleanupReviewBudget();
            const reviewReport = [
                deterministicReport,
                aiText(
                    `${validationPendingCount} file diagnostic refresh(es) remain pending; deterministic checks passed, so this is advisory and does not restart validation.`,
                    `${validationPendingCount} 个文件的诊断刷新仍在等待；确定性检查已通过，因此仅作提示，不再重新启动验证。`,
                ),
            ].filter(Boolean).join('\n\n');
            this.eventSink?.appendSoon('quality_gate_decision', {
                passed: true,
                acceptedWithAdvisory: true,
                diagnosticErrors: 0,
                validationPending: validationPendingCount,
                evidenceConflicts: 0,
                logicIssues: 0,
                semanticIssues: 0,
                acceptanceFailures: [],
                filesChecked: writtenFiles,
                fixSuggestions: [],
            });
            return {
                passed: true,
                diagnosticErrors: 0,
                validationPending: validationPendingCount,
                evidenceConflicts: 0,
                logicIssues: 0,
                semanticIssues: 0,
                acceptanceFailures: [],
                filesChecked: writtenFiles,
                reviewReport,
                semanticReport: deterministicReport,
                fixSuggestions: [],
            };
        }
        const prompt = this.buildCombinedReviewPrompt(writtenFiles, preFetchedDiagnostics, reviewContext, deterministicReport);
        
        // Run the hidden post-dispatch reviewer as a real bounded child agent.
        // Previously it inherited the top-level 10,000-iteration allowance, so
        // Paradox Multi-Agent could appear stuck after every visible task had completed.
        const forwardStep = (step: AgentStep) => {
            refreshReviewIdleTimeout();
            options.onStep?.({ ...step, agentId: QUALITY_GATE_REVIEW_AGENT_ID });
        };
        let abortListener: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
            abortListener = () => {
                const reason = reviewController.signal.reason;
                if (reason instanceof Error) {
                    reject(reason);
                    return;
                }
                const error = new Error(reason ? String(reason) : aiText(
                    'Quality gate reviewer aborted.',
                    '质量门审查已中止。',
                ));
                error.name = 'AbortError';
                reject(error);
            };
            if (reviewController.signal.aborted) {
                abortListener();
            } else {
                reviewController.signal.addEventListener('abort', abortListener, { once: true });
            }
        });

        let reviewResult!: GenerationResult;
        try {
            forwardStep({
                type: 'subtask_start',
                content: aiText('Starting bounded quality gate review', '启动有界质量门审查'),
                subagentProfileName: 'reviewer',
                timestamp: Date.now(),
            });
            const runPromise = agentRunner.run(
                prompt,
                {}, // context
                [], // conversationHistory
                {
                    ...options,
                    schedulingState: reviewSchedulingState,
                    useSlimPrompt: true,
                    maxIterations: QUALITY_GATE_REVIEW_MAX_ITERATIONS,
                    deferTerminalValidationToParent: true,
                    agentId: QUALITY_GATE_REVIEW_AGENT_ID,
                    threadId: `${options.parentRunId ?? options.topicId ?? 'orchestrator'}/${QUALITY_GATE_REVIEW_AGENT_ID}`,
                    turnId: `${QUALITY_GATE_REVIEW_AGENT_ID}_${Date.now()}`,
                    abortSignal: reviewController.signal,
                    onStep: forwardStep,
                },
            );
            reviewResult = await Promise.race([runPromise, abortPromise]);
            if (parentAbortSignal?.aborted) {
                throw parentAbortSignal.reason instanceof Error
                    ? parentAbortSignal.reason
                    : new Error(parentAbortSignal.reason ? String(parentAbortSignal.reason) : aiText(
                        'Quality gate review cancelled.',
                        '质量门审查已取消。',
                    ));
            }
            if (reviewController.signal.aborted || !reviewResult.isValid) {
                const reason = reviewController.signal.reason;
                throw reason instanceof Error
                    ? reason
                    : new Error(reviewResult.explanation || aiText(
                        'Quality gate reviewer did not complete successfully.',
                        '质量门审查未能成功完成。',
                    ));
            }
            forwardStep({
                type: 'subtask_complete',
                content: aiText('Review complete', '审查完成'),
                subtaskStatus: 'completed',
                timestamp: Date.now(),
            });
        } catch (error) {
            if (parentAbortSignal?.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            forwardStep({
                type: 'subtask_complete',
                content: aiText('Review stopped after timeout or error', '审查因超时或异常终止'),
                subtaskStatus: 'failed',
                timestamp: Date.now(),
            });
            const acceptanceFailures = [...new Set([
                ...semantic.acceptanceFailures,
                aiText(
                    `Quality gate reviewer unavailable: ${message}`,
                    `质量门审查不可用：${message}`,
                ),
            ])];
            this.eventSink?.appendSoon('quality_gate_decision', {
                passed: false,
                operationalFailure: true,
                diagnosticErrors: diagnosticErrorCount,
                validationPending: validationPendingCount,
                evidenceConflicts: finalEvidence.conflictFiles.length,
                logicIssues: 0,
                semanticIssues: semantic.issues.length,
                acceptanceFailures,
                filesChecked: writtenFiles,
                fixSuggestions: [],
            });
            return {
                passed: false,
                operationalFailure: true,
                diagnosticErrors: diagnosticErrorCount,
                validationPending: validationPendingCount,
                evidenceConflicts: finalEvidence.conflictFiles.length,
                logicIssues: 0,
                semanticIssues: semantic.issues.length,
                acceptanceFailures,
                filesChecked: writtenFiles,
                reviewReport: [deterministicReport, message].filter(Boolean).join('\n\n'),
                semanticReport: deterministicReport,
                fixSuggestions: semantic.issues.map(issue => issue.message),
            };
        } finally {
            mergeTokenUsageTotals(tokenAccumulator, reviewResult?.tokenUsage);
            cleanupReviewBudget();
            if (abortListener) reviewController.signal.removeEventListener('abort', abortListener);
        }

        const parsed = this.parseReviewResult(reviewResult.explanation);
        const totalLogicIssues = parsed.logicIssuesCount || 0;
        const requiredCriteria = [
            ...(taskGraph?.metadata.featureManifest?.acceptanceCriteria ?? []),
            ...[...(taskGraph?.nodes.values() ?? [])].flatMap(node => node.acceptanceChecks ?? []),
        ].filter(check => check.required !== false);
        const missingAcceptanceEvidence = requiredCriteria
            .filter(check => !parsed.acceptanceEvidence.some(item =>
                item.id === check.id && item.passed === true && item.evidence.trim().length > 0))
            .map(check => `${check.id}: ${check.description}`);
        const acceptanceFailures = [...new Set([
            ...semantic.acceptanceFailures,
            ...parsed.acceptanceFailures,
            ...missingAcceptanceEvidence,
        ])];
        const passed = diagnosticErrorCount === 0
            && validationPendingCount === 0
            && finalEvidence.conflictFiles.length === 0
            && totalLogicIssues === 0
            && semantic.issues.length === 0
            && acceptanceFailures.length === 0;

        this.eventSink?.appendSoon('quality_gate_decision', {
            passed,
            diagnosticErrors: diagnosticErrorCount,
            validationPending: validationPendingCount,
            evidenceConflicts: finalEvidence.conflictFiles.length,
            logicIssues: totalLogicIssues,
            semanticIssues: semantic.issues.length,
            acceptanceFailures,
            filesChecked: writtenFiles,
            fixSuggestions: parsed.fixSuggestions || []
        });

        return {
            passed,
            diagnosticErrors: diagnosticErrorCount,
            validationPending: validationPendingCount,
            evidenceConflicts: finalEvidence.conflictFiles.length,
            logicIssues: totalLogicIssues,
            semanticIssues: semantic.issues.length,
            acceptanceFailures,
            filesChecked: writtenFiles,
            reviewReport: [deterministicReport, reviewResult.explanation].filter(Boolean).join('\n\n'),
            semanticReport: deterministicReport,
            fixSuggestions: [...new Set([
                ...finalEvidence.conflictFiles.map(file => `Resolve confirmed PDX evidence conflicts in ${file}.`),
                ...semantic.issues.map(issue => issue.message),
                ...parsed.fixSuggestions,
            ])],
        };
    }

    /** 
* Generate repair prompt. 
* Based on Reviewer's review report, build repair instructions. 
*/
    buildFixPrompt(
        reviewReport: string,
        writtenFiles: string[],
        paradoxReview = true,
        userExecutionPolicy?: UserExecutionPolicy,
    ): string {
        const hasSpriteIssues = /Expected value of type sprite|type sprite|spriteType|picture|GFX_/i.test(reviewReport);
        const hasSoundIssues = /show_sound|Expected value of type sound|type sound|sound\s*=|music|\.asset/i.test(reviewReport);
        return [
            '## Quality Gate Fix Task',
            '',
            'The Review Agent has found the following issues, please fix them:',
            '',
            reviewReport,
            '',
            ...(hasSpriteIssues ? [SPRITE_REPAIR_PROTOCOL, ''] : []),
            ...(hasSoundIssues ? [SOUND_REPAIR_PROTOCOL, ''] : []),
            'Related Files:',
            ...writtenFiles.map(f => `- ${f}`),
            '',
            'Fix Requirements:',
            ...(userExecutionPolicy?.warningHandling === 'ignore'
                ? ['- Do not repair warning/info/hint diagnostics; only error-severity diagnostics and verified functional defects are blocking.']
                : []),
            ...(userExecutionPolicy?.localisationOwnership === 'user'
                ? ['- Localisation is user-owned. Do not create or modify localisation files, and do not remove or rename valid script references merely to silence missing-localisation warnings.']
                : []),
            ...(paradoxReview
                ? [
                    '1. Only fix the specific issues listed in the review report. Fix all real LSP errors and logic conflicts.',
                    '2. Do not delete or simplify required existing logic.',
                    '3. For sprite issues, use dynamic indexed candidates; never invent a `GFX_*` name.',
                    '4. For sound issues, use dynamic indexed candidates; never invent a sound asset name.',
                    '5. After fixing, obtain fresh diagnostics for each modified PDX file.',
                ]
                : [
                    '1. Fix only the specific issues listed in the review report and preserve unrelated behavior.',
                    '2. Follow repository conventions and public contracts; add or update focused regression tests where appropriate.',
                    '3. Run the narrowest relevant build, typecheck, lint, or tests and repair failures caused by the change.',
                ]),
        ].join('\n');
    }

    /** 
* Analyze the review report and determine whether it is passed. 
*/
    parseReviewResult(reviewOutput: string): {
        logicIssuesCount: number;
        fixSuggestions: string[];
        acceptanceFailures: string[];
        acceptanceEvidence: Array<{ id: string; passed: boolean; evidence: string }>;
    } {
        try {
            // Try extracting JSON block
            const jsonMatch = reviewOutput.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                const parsed = JSON.parse(jsonMatch[1]);
                return {
                    logicIssuesCount: parsed.logicIssuesCount || 0,
                    fixSuggestions: Array.isArray(parsed.fixSuggestions) ? parsed.fixSuggestions : [],
                    acceptanceFailures: Array.isArray(parsed.acceptanceFailures) ? parsed.acceptanceFailures.map(String) : [],
                    acceptanceEvidence: Array.isArray(parsed.acceptanceEvidence)
                        ? parsed.acceptanceEvidence
                            .filter((item: unknown) => !!item && typeof item === 'object')
                            .map((item: any) => ({
                                id: String(item.id ?? ''),
                                passed: item.passed === true,
                                evidence: String(item.evidence ?? ''),
                            }))
                        : [],
                };
            }
            // Fallback for non-JSON formatted but contains logic issues count
            const match = reviewOutput.match(/(\d+)\s*(?:个|issues?|problems?|errors?)/i);
            const numericIssueMatch = reviewOutput.match(/(\d+)\s*(?:issues?|problems?|errors?)/i) ?? match;
            if (/\bPASSED\b/i.test(reviewOutput)) return { logicIssuesCount: 0, fixSuggestions: [], acceptanceFailures: [], acceptanceEvidence: [] };
            const logicIssuesCount = numericIssueMatch ? parseInt(numericIssueMatch[1]!, 10) : 1;
            return {
                logicIssuesCount,
                fixSuggestions: numericIssueMatch ? [] : ['Reviewer output did not contain the required structured verdict.'],
                acceptanceFailures: [],
                acceptanceEvidence: [],
            };
        } catch {
            return {
                logicIssuesCount: 1,
                fixSuggestions: ['Reviewer output could not be parsed.'],
                acceptanceFailures: [],
                acceptanceEvidence: [],
            };
        }
    }

    /** Get configuration */
    getConfig(): QualityGateConfig {
        return { ...this.config };
    }
}
