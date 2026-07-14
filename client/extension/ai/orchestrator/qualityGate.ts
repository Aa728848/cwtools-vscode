/** 
* Eddy CWTool Code — Quality Gate 
* 
* After the Builder Agent is completed, the Reviewer Agent is automatically triggered for review. 
* Supports multiple rounds of repair cycles (up to 3 rounds) to ensure code quality. 
*/

import type { QualityGateResult, SubAgentResult, TaskGraph } from './types';
import type { AgentStep, GenerationResult } from '../types';
import { aiText } from '../messages';
import type { RunEventSink } from '../runner/runContext';
import { SemanticVerifier } from './semanticVerifier';

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
const QUALITY_GATE_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const QUALITY_GATE_REVIEW_MAX_ITERATIONS = 15;

export interface QualityGateReviewContext {
    taskGraph?: TaskGraph;
    workspaceRoot?: string;
}

export const PDX_DIAGNOSTIC_EXTENSIONS = ['.txt', '.gui'] as const;

export function isPdxDiagnosticFile(file: string): boolean {
    const normalized = file.toLowerCase();
    return PDX_DIAGNOSTIC_EXTENSIONS.some(ext => normalized.endsWith(ext));
}

export const SPRITE_REPAIR_PROTOCOL = [
    '## Sprite Resource Diagnostic Protocol',
    '',
    'When any diagnostic says `Expected value of type sprite` or a field such as `picture`, `icon`, or `spriteType` references a missing/invalid `GFX_*` value:',
    '1. Treat it as an asset reference error, not as a generic syntax error.',
    '2. The value for a sprite-typed field must be an existing sprite name (usually `GFX_*`), never a raw `.dds` file path.',
    '3. Before proposing or applying a replacement, call `find_sprite_candidates` with the invalid value, the field name, and `searchContext="both"` so both project and vanilla `.gfx` sprite definitions are available.',
    '4. Prefer a project sprite candidate first, then a semantically close vanilla candidate. For event `picture = ...`, prefer event-picture sprites such as `GFX_evt_*` or candidates whose texture path indicates event/anomaly/archaeology art; avoid UI icon textures unless the field is actually an icon field.',
    '5. If no candidate is returned, retry with broader keywords from the surrounding content (for example anomaly, archaeology, situation, relic, event) before declaring it blocked.',
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
* 2. QualityGate automatically generates review prompts (based on the file list written by Builder) 
* 3. Call Reviewer Agent to review 
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

        return [
            '## Quality Gate Review Task',
            '',
            ...requestSection,
            'Please review the code quality of the following files:',
            fileList,
            diagnosticsSection,
            spriteSection,
            soundSection,
            ...semanticSection,
            'Review Checklist:',
            step1,
            '2. Check for logic conflict issues (e.g., an event has `option` but uses `hide_window = yes`, which is a contradiction). Such conflicts MUST be reported and fixed.',
            '3. Check cross-file reference consistency (Event IDs, Modifier names, Localization keys, and sprite/asset references).',
            '4. Verify the correctness of the scope chain.',
            '5. Check file structure integrity and functional completeness (Refer to Rule 3b).',
            diagnosticTargets.length > 0 ? `6. LSP diagnostic target files include: ${diagnosticTargets.join(', ')}` : '6. No LSP diagnostic target files were written.',
            '7. Check every required Feature Manifest edge and acceptance criterion. Each passed criterion must cite concrete file/line or deterministic evidence; otherwise mark it failed.',
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
            'IMPORTANT: Do not output PASSED or FAILED. The system will automatically fail the quality gate if any LSP errors exist. You only need to report semantic or logic issues.',
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
    ): Promise<QualityGateResult> {
        const taskGraph = reviewContext?.taskGraph;
        const workspaceRoot = reviewContext?.workspaceRoot ?? agentRunner.toolExecutor.workspaceRoot;
        const semantic = taskGraph
            ? await new SemanticVerifier().verify(workspaceRoot, writtenFiles, taskGraph, agentRunner.toolExecutor)
            : {
                passed: true,
                issues: [],
                acceptanceFailures: [],
                filesChecked: writtenFiles,
                report: '',
            };
        const expectedChanges = taskGraph?.metadata.featureManifest?.expectsFileChanges === true
            || [...(taskGraph?.nodes.values() ?? [])].some(node => ['build', 'loc_writer', 'gui_expert'].includes(node.agentType)
                && ((node.plannedFiles?.length ?? 0) > 0 || (node.produces?.length ?? 0) > 0));
        if (writtenFiles.length === 0) {
            const acceptanceFailures = [...semantic.acceptanceFailures];
            if (expectedChanges) acceptanceFailures.push('Expected project changes were not written.');
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
        try {
            const diagResults: string[] = [];
            for (const file of writtenFiles) {
                if (!isPdxDiagnosticFile(file)) continue;
                const res = await agentRunner.toolExecutor.execute('get_diagnostics', { file, severity: 'error' });
                if (res && typeof res === 'object') {
                    const count = (res as any).totalDiagnosticCount || 0;
                    if (count > 0) {
                        diagnosticErrorCount += count;
                        diagResults.push(`File: ${file}\n${JSON.stringify((res as any).diagnostics, null, 2)}`);
                    }
                }
            }
            if (diagResults.length > 0) {
                preFetchedDiagnostics = diagResults.join('\n\n');
            }
        } catch {
            // ignore
        }

        const prompt = this.buildCombinedReviewPrompt(writtenFiles, preFetchedDiagnostics, reviewContext, semantic.report);
        
        // Run the hidden post-dispatch reviewer as a real bounded child agent.
        // Previously it inherited the top-level 10,000-iteration allowance, so
        // Script Mode could appear stuck after every visible task had completed.
        const parentAbortSignal = options.abortSignal;
        const reviewController = new AbortController();
        const forwardParentAbort = () => reviewController.abort(parentAbortSignal?.reason);
        if (parentAbortSignal?.aborted) {
            forwardParentAbort();
        } else {
            parentAbortSignal?.addEventListener('abort', forwardParentAbort, { once: true });
        }

        const reviewTimeout = setTimeout(() => {
            const error = new Error(aiText(
                'Quality gate reviewer timed out after 5 minutes.',
                '质量门审查超过 5 分钟，已终止。',
            ));
            error.name = 'TimeoutError';
            reviewController.abort(error);
        }, QUALITY_GATE_REVIEW_TIMEOUT_MS);

        const forwardStep = (step: AgentStep) => {
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

        let reviewResult: GenerationResult;
        try {
            forwardStep({
                type: 'subtask_start',
                content: aiText('Starting bounded quality gate review', '启动有界质量门审查'),
                subagentType: 'script_reviewer',
                timestamp: Date.now(),
            });
            const runPromise = agentRunner.run(
                prompt,
                {}, // context
                [], // conversationHistory
                {
                    ...options,
                    mode: 'script_reviewer',
                    useSlimPrompt: true,
                    maxIterations: QUALITY_GATE_REVIEW_MAX_ITERATIONS,
                    skipValidation: true,
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
                timestamp: Date.now(),
            });
        } catch (error) {
            if (parentAbortSignal?.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            forwardStep({
                type: 'subtask_complete',
                content: aiText('Review stopped after timeout or error', '审查因超时或异常终止'),
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
                logicIssues: 0,
                semanticIssues: semantic.issues.length,
                acceptanceFailures,
                filesChecked: writtenFiles,
                reviewReport: [semantic.report, message].filter(Boolean).join('\n\n'),
                semanticReport: semantic.report,
                fixSuggestions: semantic.issues.map(issue => issue.message),
            };
        } finally {
            clearTimeout(reviewTimeout);
            parentAbortSignal?.removeEventListener('abort', forwardParentAbort);
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
            && totalLogicIssues === 0
            && semantic.issues.length === 0
            && acceptanceFailures.length === 0;

        this.eventSink?.appendSoon('quality_gate_decision', {
            passed,
            diagnosticErrors: diagnosticErrorCount,
            logicIssues: totalLogicIssues,
            semanticIssues: semantic.issues.length,
            acceptanceFailures,
            filesChecked: writtenFiles,
            fixSuggestions: parsed.fixSuggestions || []
        });

        return {
            passed,
            diagnosticErrors: diagnosticErrorCount,
            logicIssues: totalLogicIssues,
            semanticIssues: semantic.issues.length,
            acceptanceFailures,
            filesChecked: writtenFiles,
            reviewReport: [semantic.report, reviewResult.explanation].filter(Boolean).join('\n\n'),
            semanticReport: semantic.report,
            fixSuggestions: [...new Set([...semantic.issues.map(issue => issue.message), ...parsed.fixSuggestions])],
        };
    }

    // W11 fix: Removed old interface that was an exact duplicate of buildCombinedReviewPrompt functionality.
    // The old method only exists because of the different parameter types (SubAgentResult vs string[]),
    // Now use buildCombinedReviewPrompt(writtenFiles: string[]) uniformly.
    /** @deprecated Use buildCombinedReviewPrompt instead */
    buildReviewPrompt(builderResult: SubAgentResult, preFetchedDiagnostics?: string): string {
        return this.buildCombinedReviewPrompt(builderResult.writtenFiles, preFetchedDiagnostics);
    }

    /** 
* Generate repair prompt. 
* Based on Reviewer's review report, build repair instructions. 
*/
    buildFixPrompt(reviewReport: string, writtenFiles: string[]): string {
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
            '1. Only fix the specific issues listed in the review report. You MUST fix ALL LSP red errors and logic conflicts (e.g., `hide_window = yes` used with `option`).',
            '2. Do not delete or simplify existing logic (Follow Rule 3b).',
            '3. For sprite-type diagnostics, replace invalid values only with candidates returned by `find_sprite_candidates` or another verified `.gfx` definition; never invent a `GFX_*` name.',
            '4. For sound diagnostics, replace invalid values only with candidates returned by `find_sound_candidates` or another verified `.asset` definition; never invent a sound asset name.',
            '5. After fixing, call `get_diagnostics` for each modified file to verify that the errors are resolved.',
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
