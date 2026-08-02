import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';
import * as vs from 'vscode';
import * as os from 'os';
import * as path from 'path';
import type { AgentSchedulingState, AgentStep, ChatMessage, GenerationResult, TodoItem } from '../types';
import { activeTurnRegistry } from './activeTurnRegistry';
import { readRunRollout, type RunRollout } from './rolloutStore';
import { threadStore, type AgentThreadRecord } from './threadStore';
import { goalStore, type DurableAgentGoal, type DurableGoalStatus, type GoalBudgetLimits } from './goalStore';
import { runLedger } from './runLedger';
import { runAgentHooks } from './hookRunner';
import { evaluateAgentRun } from './agentEvals';
import { goalSupervisor } from './goalSupervisor';
import { agentTaskManager, type AgentTaskRecord, type CreateAgentTask } from './taskManager';
import { projectActivities, type ActivityProjection } from './activityProjection';
import {
    createRuntimeDomainStateStore,
    type ContextDomainState,
    type SchedulingDomainState,
    type TranscriptDomainState,
    type PromptDomainState,
    type InteractionDomainState,
    type PermissionDomainState,
} from './state/runtimeModels';
import type { DomainStateStore } from './state/domainStateStore';
import { createStepRequest, type StepRequest } from './stepRequest';
import { TranscriptStreamBuffer } from './transcriptStreamBuffer';
import { sideQuestionService, type SideQuestion } from './sideQuestionService';
import { TOOL_REGISTRY } from '../tools/registry';
import { conversationUndoCoordinator, type UndoResult } from './undoCoordinator';
import { AgentLoopKernel } from './loopKernel';
import { runtimeFaultInjector } from './faultInjection';
import { PromptQueueService, InteractionService, type InteractionKind, type RuntimeInteraction } from './promptInteraction';
import { PermissionTraceStore, type PermissionTraceEntry } from './permissionTrace';
import { RuntimeScope, type RuntimeScopeSnapshot } from './runtimeScope';
import {
    AgentTranscriptStore,
    filterTranscriptOperations,
    paginateTranscriptTurns,
    redactTranscriptSnapshot,
    type AgentTranscriptSnapshot,
    type TranscriptGrade,
    type TranscriptOperation,
    type TranscriptOpBatch,
    type TranscriptTurn,
} from '../../../shared/agentTranscript';
import { agentProfileCatalog, ToolActivationService, type ToolActivationSnapshot } from './agentProfileCatalog';
import { createDirectoryAgentProfileSource } from './agentProfileSources';
import { getProjectWorkspaceRoots } from '../workspacePaths';
import { schedulingStateFromLegacyMode } from './scheduling';
import { ErrorReporter } from '../errorReporter';

const registeredProfileRoots = new Set<string>();

export interface TurnStartRequest {
    userMessage: string;
    context?: {
        activeFile?: string;
        cursorLine?: number;
        cursorColumn?: number;
        selectedText?: string;
        fileContent?: string;
        topicId?: string;
    };
    conversationHistory?: ChatMessage[];
    options?: AgentRunnerOptions;
    images?: string[];
    /** Internal prompt lifecycle id. Hosts should normally omit this. */
    promptId?: string;
}

export interface TurnStartResult {
    runId?: string;
    threadId: string;
    turnId?: string;
    result: GenerationResult;
    rollout?: RunRollout;
    /** All internal turns consumed by this user exchange, including Goal continuations. */
    turnIds?: string[];
    runIds?: string[];
}

export interface TurnSteerResult {
    accepted: boolean;
    runId: string;
}

export interface TurnInterruptResult {
    interrupted: boolean;
    runId: string;
}

export interface ConversationUndoRuntimeState {
    domainSequence: number;
    compactionBoundarySequence?: number;
    schedulingState: AgentSchedulingState | null;
    toolSchemas: string[];
    todos: TodoItem[];
}

export interface AgentRuntimeInspector {
    version: 1;
    topicId: string;
    threadId: string;
    profile?: string;
    overlays: string[];
    scheduling?: AgentSchedulingState;
    tools?: ToolActivationSnapshot;
    prompts: { total: number; pending: number; running: number };
    interactions: { total: number; pending: number };
    transcript: { sequence: number; turns: number; entities: number; pendingEntities: number; grade: TranscriptGrade };
    profiles: {
        revision: number;
        profiles: Array<{ name: string; domain?: string; authorizationCeiling: string }>;
        sources: Array<{ id: string; priority: number; profileCount: number; error?: string }>;
    };
    model?: {
        provider?: string;
        requested?: string;
        effective?: string;
        fallbackReason?: string;
        runId?: string;
        bindingSource?: string;
    };
    permissions: PermissionTraceEntry[];
    scope: RuntimeScopeSnapshot;
}

interface TranscriptRuntimeState {
    tail: Promise<void>;
    stepOrdinal: number;
    streams: TranscriptStreamBuffer;
}

interface ModelBindingState {
    source?: string;
    providerId?: string;
    model?: string;
}

interface GoalRuntimeState {
    owned: boolean;
    goal?: DurableAgentGoal;
    activeContinuations: Set<string>;
}

export class AgentRuntime {
    private readonly appScope = new RuntimeScope('app', 'cwtools-ai');
    private readonly promptQueue = this.appScope.set('promptQueue', new PromptQueueService());
    private readonly interactions = this.appScope.set('interactions', new InteractionService());
    private readonly permissionTrace = this.appScope.set('permissionTrace', new PermissionTraceStore());
    private readonly transcriptGrade: TranscriptGrade = 'delta';
    private readonly profilesReady: Promise<void>;

    constructor(private readonly runner: AgentRunner) {
        const roots = getProjectWorkspaceRoots();
        const sources = [
            { id: `user:${os.homedir().toLowerCase()}`, directory: path.join(os.homedir(), '.cwtools', 'agents'), priority: 100 },
            ...roots.flatMap((root, index) => [
                { id: `workspace-agents:${root.toLowerCase()}`, directory: path.join(root, '.agents', 'agents'), priority: 200 + index },
                { id: `workspace-cwtools:${root.toLowerCase()}`, directory: path.join(root, '.cwtools', 'agents'), priority: 300 + index },
            ]),
        ];
        for (const source of sources) {
            if (registeredProfileRoots.has(source.id)) continue;
            registeredProfileRoots.add(source.id);
            agentProfileCatalog.registerSource(createDirectoryAgentProfileSource(
                source.id,
                source.directory,
                source.priority,
            ));
        }
        this.profilesReady = agentProfileCatalog.reload();
    }

    startTurn(request: TurnStartRequest): Promise<TurnStartResult> {
        const topicId = request.context?.topicId ?? request.options?.topicId ?? 'default';
        const threadId = request.options?.threadId ?? topicId;
        const handle = this.promptQueue.enqueue({
            topicId,
            threadId,
            turnId: request.options?.turnId,
            text: request.userMessage,
        });
        const queuedRequest = { ...request, promptId: handle.prompt.id };
        const stepRequest = createStepRequest('user_prompt', queuedRequest, { sourceId: threadId });
        this.promptQueue.transition(handle.prompt.id, 'running');
        return this.getLoopKernel(topicId, threadId).run<TurnStartResult>(stepRequest).then(async result => {
            this.promptQueue.transition(handle.prompt.id, 'completed');
            await this.persistRuntimeProjections(topicId, threadId);
            return result;
        }, async error => {
            this.promptQueue.transition(
                handle.prompt.id,
                request.options?.abortSignal?.aborted ? 'cancelled' : 'failed',
                error instanceof Error ? error.message : String(error),
            );
            await this.persistRuntimeProjections(topicId, threadId).catch(() => {});
            throw error;
        });
    }

    private async startTurnInternal(request: TurnStartRequest, stepRequest: StepRequest): Promise<TurnStartResult> {
        const turnStartedAt = Date.now();
        const context = request.context ?? {};
        const topicId = context.topicId ?? request.options?.topicId ?? 'default';
        const threadId = request.options?.threadId ?? topicId;
        const turnId = request.options?.turnId ?? `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const goalRuntime = this.getGoalRuntimeState(topicId, threadId);
        let goal = goalRuntime.goal ?? await goalStore.getGoal(topicId, threadId);
        if (goal?.status === 'active' && !goalRuntime.owned) {
            goal = await goalStore.updateStatus(topicId, threadId, 'paused', 'Extension host restarted; explicit resume is required.');
            if (goal) goalRuntime.goal = goal;
        }
        const history = [...(request.conversationHistory ?? [])];
        if (goal?.status === 'active') {
            history.unshift({
                role: 'system',
                content: `[DURABLE GOAL]\nObjective: ${goal.objective}\nStatus: ${goal.status}${goal.tokenBudget ? `\nToken budget: ${goal.tokenBudget}` : ''}`,
            });
        }
        const promptHook = await runAgentHooks('userPromptSubmit', { topicId, threadId, turnId });
        if (!promptHook.allowed) {
            throw new Error(promptHook.reason ?? 'Prompt was rejected by an Agent hook.');
        }
        for (const readonlyContext of promptHook.readonlyContext) {
            history.push({ role: 'system', content: `[HOOK READ-ONLY CONTEXT]\n${readonlyContext}` });
        }
        const domainStore = await this.getDomainStore(topicId, threadId);
        await this.profilesReady;
        const scope = this.getAgentScope(topicId, threadId);
        this.getTranscriptStore(topicId, threadId, domainStore);
        const schedulingState = request.options?.schedulingState
            ?? schedulingStateFromLegacyMode(request.options?.mode ?? 'build', request.options?.domain);
        const profile = agentProfileCatalog.get(schedulingState.profileName ?? '')
            ?? agentProfileCatalog.resolve({
                domainProfile: schedulingState.domainProfile,
                authorization: schedulingState.authorization,
                initialPhase: schedulingState.phase === 'plan' ? 'plan' : schedulingState.phase === 'verify' ? 'verify' : 'inspect',
                explicitDelegation: schedulingState.dispatch !== 'single',
                confidence: schedulingState.routeConfidence,
                evidence: schedulingState.routeEvidence,
            });
        const activation = scope.get<ToolActivationService>('toolActivation')
            ?? scope.set('toolActivation', new ToolActivationService());
        const toolSnapshot = activation.activate(profile, schedulingState);
        const inactiveTools = toolSnapshot.registered.filter(name => !toolSnapshot.activated.includes(name));
        const existingExclusions = request.options?.excludeTools ?? [];
        const profilePhase = toolSnapshot.authorization === 'read_only'
            ? (profile.name === 'reviewer' ? 'verify' : 'inspect')
            : toolSnapshot.authorization === 'plan_write_only'
                && (schedulingState.phase === 'execute' || schedulingState.phase === 'finalize')
                ? 'plan'
                : schedulingState.phase;
        const profileDispatch = toolSnapshot.activated.includes('dispatch_agents')
            && (profile.subagents === undefined || profile.subagents.length > 0)
            ? schedulingState.dispatch
            : 'single';
        const configuredModels = typeof vs.workspace?.getConfiguration === 'function'
            ? vs.workspace.getConfiguration('stellarisLanguageServices.ai')
                .get<Record<string, { provider: string; model: string }>>('orchestrator.agentModels')
            : undefined;
        const modelBindingKey = configuredModels?.[profile.name]
            ? profile.name
            : profile.modelPreference && configuredModels?.[profile.modelPreference]
                ? profile.modelPreference
                : undefined;
        const modelBinding = modelBindingKey ? configuredModels?.[modelBindingKey] : undefined;
        const priorOnStep = request.options?.onStep;
        const effectiveOptions = {
            ...request.options,
            // The admitted domain is user/runtime-owned. Profiles may only
            // narrow tools and authorization; they cannot cross this boundary.
            domain: schedulingState.domainProfile,
            schedulingState: {
                ...schedulingState,
                domainProfile: schedulingState.domainProfile,
                authorization: toolSnapshot.authorization,
                phase: profilePhase,
                phaseReason: profilePhase === schedulingState.phase
                    ? schedulingState.phaseReason
                    : `Runtime profile "${profile.name}" constrained the initial phase.`,
                dispatch: profileDispatch,
                profileName: profile.name,
            },
            agentProfileName: profile.name,
            agentProfileInstructions: profile.instructions,
            agentProfileAllowedSubagents: profile.subagents,
            providerId: request.options?.providerId ?? modelBinding?.provider,
            model: request.options?.model ?? modelBinding?.model,
            excludeTools: [...new Set([...existingExclusions, ...inactiveTools])],
            onStep: (step: AgentStep) => {
                priorOnStep?.(step);
                void this.recordTranscriptStep(topicId, threadId, turnId, step).catch(error => {
                    ErrorReporter.warn('AgentRuntime', 'Failed to persist a live transcript step.', error);
                });
            },
        };
        const bindingState: ModelBindingState = {
            source: request.options?.providerId || request.options?.model
                ? 'request'
                : modelBindingKey ? `profile:${modelBindingKey}` : 'workspace-default',
            providerId: effectiveOptions.providerId,
            model: effectiveOptions.model,
        };
        const existingBinding = scope.get<ModelBindingState>('modelBinding');
        if (existingBinding) Object.assign(existingBinding, bindingState);
        else scope.set<ModelBindingState>('modelBinding', bindingState);
        if (request.promptId) {
            await domainStore.apply({
                type: 'prompt.state.replaced',
                version: 1,
                domain: 'prompt',
                payload: { prompts: this.promptQueue.list(threadId) },
            });
        }
        await this.appendTranscriptOperations(topicId, threadId, [{
            op: 'turn.upsert',
            turn: {
                turnId,
                ordinal: turnStartedAt,
                state: 'running',
                prompt: request.userMessage,
                startedAt: turnStartedAt,
            },
        }, ...(request.promptId ? [{
            op: 'entity.upsert' as const,
            entity: {
                id: request.promptId,
                kind: 'prompt' as const,
                anchorTurnId: turnId,
                state: 'running',
                value: { text: request.userMessage },
                updatedAt: turnStartedAt,
            },
        }] : [])]);
        await domainStore.apply({
            type: 'scheduling.state.replaced',
            version: 1,
            domain: 'scheduling',
            payload: { state: effectiveOptions.schedulingState },
        });
        await domainStore.apply({
            type: 'goal.state.replaced',
            version: 1,
            domain: 'goal',
            payload: { goal: goal ?? null },
        });
        await domainStore.apply({
            type: 'context.turn.recorded',
            version: 1,
            domain: 'context',
            payload: { turnId, status: 'started' },
        });
        await domainStore.apply({
            type: 'context.transcript.changed',
            version: 1,
            domain: 'context',
            payload: { action: 'append', turnId },
        });
        let result: GenerationResult;
        try {
            const finalizationGrace = stepRequest.kind === 'goal_continuation'
                && !!(stepRequest.payload as { finalizationGrace?: boolean }).finalizationGrace;
            const runnerPrompt = stepRequest.kind === 'goal_continuation' && goal
                ? [
                    '[GOAL CONTINUATION]',
                    `Continue the active durable goal: ${goal.objective}`,
                    goal.completionCriterion.length > 0
                        ? `Completion criteria:\n${goal.completionCriterion.map(item => `- ${item}`).join('\n')}`
                        : '',
                    finalizationGrace
                        ? 'This is the single budget finalization grace step. Do not start writes or new work. Preserve the checkpoint, report the exhausted budget, and finalize or block the goal with evidence.'
                        : 'Resume from verified state. Do not repeat completed work. If complete, call update_goal with evidence.',
                ].filter(Boolean).join('\n')
                : request.userMessage;
            result = await this.runner.run(
                runnerPrompt,
                { ...context, topicId },
                history,
                {
                    ...effectiveOptions,
                    topicId,
                    threadId,
                    turnId,
                    tokenBudget: finalizationGrace
                        ? 1_024
                        : request.options?.tokenBudget
                        ?? (goal?.budgetLimits.tokens === undefined
                            ? undefined
                            : Math.max(0, goal.budgetLimits.tokens - goal.tokensUsed)),
                    schedulingState: finalizationGrace && effectiveOptions.schedulingState
                        ? {
                            ...effectiveOptions.schedulingState,
                            phase: 'finalize',
                            phaseReason: 'Durable Goal budget finalization grace step.',
                            revision: effectiveOptions.schedulingState.revision + 1,
                        }
                        : effectiveOptions.schedulingState,
                    durableGoal: goal?.status === 'active',
                    goalCreationAuthorized: request.options?.goalCreationAuthorized
                        ?? /\b(?:goal|long-running|do not stop|until complete)\b|目标|持续|直到完成/i.test(request.userMessage),
                },
                request.images,
            );
        } catch (error) {
            await this.flushTranscript(topicId, threadId);
            await this.appendTranscriptOperations(topicId, threadId, [{
                op: 'turn.upsert',
                turn: {
                    turnId,
                    ordinal: turnStartedAt,
                    state: request.options?.abortSignal?.aborted ? 'cancelled' : 'failed',
                    prompt: request.userMessage,
                    startedAt: turnStartedAt,
                    endedAt: Date.now(),
                    error: error instanceof Error ? error.message : String(error),
                },
            }]);
            this.clearTranscriptTurnState(topicId, threadId, turnId);
            await domainStore.apply({
                type: 'context.turn.recorded',
                version: 1,
                domain: 'context',
                payload: { turnId, status: 'interrupted' },
            });
            await domainStore.checkpoint();
            throw error;
        } finally {
            await runAgentHooks('stop', { topicId, threadId, turnId });
        }
        if (goal?.status === 'active') {
            await goalSupervisor.recordTurn(goal, result, Math.max(0, Date.now() - turnStartedAt));
        }
        agentTaskManager.configure(topicId);
        const backgroundNotifications = await this.takeTaskNotifications(topicId, threadId);
        for (const notification of backgroundNotifications) {
            const payload = notification.payload as {
                taskId: string;
                status: string;
                resultSummary?: string;
                outputRef?: string;
            };
            history.push({
                role: 'system',
                content: [
                    '[BACKGROUND TASK RESULT]',
                    `Task: ${payload.taskId}`,
                    `Status: ${payload.status}`,
                    payload.resultSummary ? `Summary: ${payload.resultSummary}` : '',
                    payload.outputRef ? `Full output: ${payload.outputRef}` : '',
                ].filter(Boolean).join('\n'),
            });
        }
        agentTaskManager.configure(topicId);
        const currentGoal = await goalStore.getGoal(topicId, threadId);
        if (currentGoal) goalRuntime.goal = currentGoal;
        await this.flushTranscript(topicId, threadId);
        const streamed = this.getTranscriptRuntimeState(topicId, threadId).streams.hasStream(turnId);
        const finalStepId = streamed ? `${turnId}:assistant-stream` : result.runId ?? `${turnId}:result`;
        await this.appendTranscriptOperations(topicId, threadId, [
            {
                op: 'step.upsert',
                turnId,
                step: { stepId: finalStepId, ordinal: 0, state: result.isValid ? 'completed' : 'failed' },
            },
            {
                op: 'frame.upsert',
                turnId,
                stepId: finalStepId,
                frame: {
                    frameId: `${turnId}:assistant`,
                    kind: 'text',
                    text: result.explanation || result.code || '',
                    status: result.isValid ? 'completed' : 'failed',
                },
            },
            {
                op: 'turn.upsert',
                turn: {
                    turnId,
                    ordinal: turnStartedAt,
                    state: result.isValid ? 'completed' : 'failed',
                    prompt: request.userMessage,
                    startedAt: turnStartedAt,
                    endedAt: Date.now(),
                },
            },
            ...(request.promptId ? [{
                op: 'entity.upsert' as const,
                entity: {
                    id: request.promptId,
                    kind: 'prompt' as const,
                    anchorTurnId: turnId,
                    state: result.isValid ? 'completed' : 'failed',
                    value: { text: request.userMessage, runId: result.runId },
                    updatedAt: Date.now(),
                },
            }] : []),
            ...backgroundNotifications.map(notification => ({
                op: 'entity.upsert' as const,
                entity: {
                    id: `task:${notification.sourceId}`,
                    kind: 'task' as const,
                    anchorTurnId: turnId,
                    state: String((notification.payload as { status?: unknown }).status ?? 'completed'),
                    value: notification.payload,
                    updatedAt: Date.now(),
                },
            })),
        ]);
        this.clearTranscriptTurnState(topicId, threadId, turnId);
        const domainOperations = await Promise.all([
            domainStore.apply({
                type: 'goal.state.replaced',
                version: 1,
                domain: 'goal',
                payload: { goal: currentGoal ?? null },
            }),
            domainStore.apply({
                type: 'task.state.replaced',
                version: 1,
                domain: 'task',
                payload: { tasks: agentTaskManager.list() },
            }),
            domainStore.apply({
                type: 'context.turn.recorded',
                version: 1,
                domain: 'context',
                payload: { turnId, runId: result.runId, status: 'completed' },
            }),
            domainStore.apply({
                type: 'prompt.state.replaced',
                version: 1,
                domain: 'prompt',
                payload: { prompts: this.promptQueue.list(threadId) },
            }),
            domainStore.apply({
                type: 'interaction.state.replaced',
                version: 1,
                domain: 'interaction',
                payload: { interactions: this.interactions.list({ threadId }) },
            }),
        ]);
        await domainStore.checkpoint();
        const rollout = result.runId ? await readRunRollout(result.runId, topicId) : undefined;
        if (result.runId) {
            for (const notification of backgroundNotifications) {
                await runLedger.appendEvent(result.runId, 'task_notification_delivered', {
                    stepRequestId: notification.id,
                    ...notification.payload as Record<string, unknown>,
                }, { status: 'done' });
            }
            for (const operation of domainOperations) {
                await runLedger.appendEvent(result.runId, 'domain_op_applied', {
                    type: operation.type,
                    domain: operation.domain,
                    sequence: operation.sequence,
                    operationId: operation.operationId,
                }, { status: 'done' });
            }
            const evaluation = await evaluateAgentRun(result.runId, topicId);
            if (evaluation) await runLedger.writeJsonArtifact(result.runId, 'evaluations/latest.json', evaluation);
            const run = runLedger.getRun(result.runId);
            const events = runLedger.getSnapshot(result.runId)?.events ?? [];
            for (const notification of backgroundNotifications) {
                await domainStore.apply({
                    type: 'context.transcript.changed',
                    version: 1,
                    domain: 'context',
                    payload: { action: 'background_result', turnId, ref: notification.sourceId },
                });
            }
            if (events.some(event => event.type === 'compaction_end')) {
                const compactionOperation = await domainStore.apply({
                    type: 'context.transcript.changed',
                    version: 1,
                    domain: 'context',
                    payload: { action: 'compaction', turnId, ref: result.runId },
                });
                await domainStore.apply({
                    type: 'context.compaction.boundary.set',
                    version: 1,
                    domain: 'context',
                    payload: { sequence: compactionOperation.sequence },
                });
            }
            const disclosedTools = events
                .filter(event => event.type === 'tool_disclosure_changed')
                .flatMap(event => Array.isArray(event.payload?.loaded)
                    ? event.payload.loaded.filter((item: unknown): item is string => typeof item === 'string')
                    : []);
            if (disclosedTools.length > 0) {
                await domainStore.apply({
                    type: 'context.tool_schemas.replaced',
                    version: 1,
                    domain: 'context',
                    payload: { loaded: disclosedTools },
                });
                await domainStore.checkpoint();
            }
            const finalSchedulingState = run?.schedulingState ?? effectiveOptions.schedulingState;
            activation.activate(profile, finalSchedulingState, disclosedTools);
            await domainStore.apply({
                type: 'scheduling.state.replaced',
                version: 1,
                domain: 'scheduling',
                payload: { state: finalSchedulingState },
            });
            await domainStore.checkpoint();
            const admission = events.find(event => event.type === 'admission_decided')?.payload;
            const finalPhase = [...events].reverse()
                .find(event => event.type === 'phase_changed')?.payload?.to
                ?? run?.schedulingState?.phase;
            const dispatched = events.some(event =>
                event.type === 'dispatch_evaluated' && event.payload?.accepted === true);
            const wroteFiles = (run?.writtenFiles.length ?? 0) > 0;
            await runLedger.appendEvent(result.runId, 'route_outcome_evaluated', {
                predictedMode: run?.mode,
                predictedPhase: admission?.initialPhase,
                actualPhase: finalPhase,
                predictedDispatch: admission?.explicitDelegation === true ? 'parallel' : 'single',
                actualDispatch: dispatched ? 'parallel' : 'single',
                wroteFiles,
                toolCallCount: result.runMetrics?.toolCallCount ?? 0,
                validationPassed: result.isValid,
            });
        }
        const continuationGoal = await goalStore.getGoal(topicId, threadId);
        if (continuationGoal) goalRuntime.goal = continuationGoal;
        const continuationKey = continuationGoal?.goalId;
        const reachedStepLimit = !!result.runMetrics
            && result.runMetrics.iterations >= result.runMetrics.maxIterations
            && result.runMetrics.toolCallCount > 0;
        const madeObservableProgress = (result.runMetrics?.toolCallCount ?? 0) > 0 && result.isValid;
        if (
            continuationGoal
            && continuationKey
            && (continuationGoal.budgetGracePending
                || reachedStepLimit
                || promptHook.requestContinuation
                || madeObservableProgress)
            && vs.workspace.getConfiguration('stellarisLanguageServices.ai.runtime')
                .get<boolean>('goalContinuation.enabled', true)
            && goalSupervisor.shouldContinue(continuationGoal, {
                cancelled: request.options?.abortSignal?.aborted === true,
                pendingApproval: false,
                pendingUserAnswer: false,
                blockingValidation: result.validationErrors.length > 0,
                madeProgress: result.runMetrics?.toolCallCount ? result.runMetrics.toolCallCount > 0 : result.isValid,
                loopIdle: true,
                continuationQueued: goalRuntime.activeContinuations.has(continuationKey),
            })
        ) {
            goalRuntime.owned = true;
            goalRuntime.activeContinuations.add(continuationKey);
            const continuation = goalSupervisor.createContinuation(continuationGoal);
            const continuationRunGoal = await goalSupervisor.claimBudgetGrace(continuationGoal);
            goalRuntime.goal = continuationRunGoal;
            if (result.runId) {
                await runLedger.appendEvent(result.runId, 'goal_continuation_queued', {
                    goalId: continuationGoal.goalId,
                    stepRequestId: continuation.id,
                    reason: reachedStepLimit ? 'step_limit_with_progress'
                        : promptHook.requestContinuation ? 'hook_request'
                            : 'observable_progress',
                }, { status: 'pending' });
            }
            try {
                const continued = await this.startTurnInternal({
                    ...request,
                    conversationHistory: [
                        ...history,
                        { role: 'assistant', content: result.explanation || result.code || '[Turn completed with tool progress.]' },
                    ],
                    options: { ...request.options, turnId: undefined },
                    images: undefined,
                }, continuation);
                return {
                    ...continued,
                    turnIds: [turnId, ...(continued.turnIds ?? (continued.turnId ? [continued.turnId] : []))],
                    runIds: [...(result.runId ? [result.runId] : []), ...(continued.runIds ?? (continued.runId ? [continued.runId] : []))],
                };
            } finally {
                goalRuntime.activeContinuations.delete(continuationKey);
            }
        }
        return {
            runId: result.runId,
            threadId,
            turnId,
            turnIds: [turnId],
            runIds: result.runId ? [result.runId] : [],
            result,
            rollout,
        };
    }

    steerTurn(runId: string, message: string, clientUserMessageId?: string, images?: string[]): TurnSteerResult {
        const run = runLedger.getRun(runId);
        const activePrompt = run?.threadId
            ? [...this.promptQueue.list(run.threadId)].reverse()
                .find(prompt => prompt.state === 'running' || prompt.state === 'pending')
            : undefined;
        if (activePrompt) {
            this.promptQueue.transition(activePrompt.id, 'steered');
            void this.persistRuntimeProjections(run!.topicId, run!.threadId!);
        }
        return {
            runId,
            accepted: activeTurnRegistry.steer(runId, message, clientUserMessageId, images),
        };
    }

    interruptTurn(runId: string, reason?: string): TurnInterruptResult {
        const run = runLedger.getRun(runId);
        const activePrompt = run?.threadId
            ? [...this.promptQueue.list(run.threadId)].reverse()
                .find(prompt => prompt.state === 'running' || prompt.state === 'steered' || prompt.state === 'pending')
            : undefined;
        if (activePrompt) {
            this.promptQueue.transition(activePrompt.id, 'cancelled', reason);
            void this.persistRuntimeProjections(run!.topicId, run!.threadId!);
        }
        return {
            runId,
            interrupted: activeTurnRegistry.interrupt(runId, reason),
        };
    }

    readTurnRollout(runId: string, topicId?: string): Promise<RunRollout | undefined> {
        return readRunRollout(runId, topicId);
    }

    resumeThread(topicId: string, threadId: string): Promise<AgentThreadRecord | undefined> {
        return threadStore.getThread(topicId, threadId);
    }

    async resumeThreadContext(topicId: string, threadId: string): Promise<{
        thread: AgentThreadRecord;
        conversationHistory: ChatMessage[];
        goal?: DurableAgentGoal;
    } | undefined> {
        const thread = await threadStore.getThread(topicId, threadId);
        if (!thread) return undefined;
        const conversationHistory = thread.currentRunId
            ? await runLedger.readResumeTranscript(thread.currentRunId, topicId) ?? []
            : [];
        return { thread, conversationHistory, goal: await goalStore.getGoal(topicId, threadId) };
    }

    forkThread(topicId: string, sourceThreadId: string, newThreadId: string, newTopicId?: string, sourceRunId?: string, messageIndex?: number): Promise<AgentThreadRecord | undefined> {
        return threadStore.forkThread(topicId, sourceThreadId, newThreadId, newTopicId, sourceRunId, messageIndex);
    }

    async setGoal(topicId: string, threadId: string, objective: string, tokenBudget?: number): Promise<DurableAgentGoal> {
        const state = this.getGoalRuntimeState(topicId, threadId);
        state.owned = true;
        const goal = await goalStore.setGoal(topicId, threadId, objective, tokenBudget);
        state.goal = goal;
        return goal;
    }

    async updateGoal(topicId: string, threadId: string, status: DurableGoalStatus | 'completed', reason?: string): Promise<DurableAgentGoal | undefined> {
        const normalized = status === 'completed' ? 'complete' : status;
        const state = this.getGoalRuntimeState(topicId, threadId);
        if (normalized === 'active') state.owned = true;
        const goal = await goalSupervisor.transition(topicId, threadId, normalized, reason);
        if (goal) state.goal = goal;
        return goal;
    }

    getGoal(topicId: string, threadId: string): Promise<DurableAgentGoal | undefined> {
        const cached = this.getGoalRuntimeState(topicId, threadId).goal;
        return cached ? Promise.resolve({ ...cached }) : goalStore.getGoal(topicId, threadId);
    }

    setGoalBudget(topicId: string, threadId: string, budget: GoalBudgetLimits): Promise<DurableAgentGoal | undefined> {
        return goalStore.setBudget(topicId, threadId, budget);
    }

    async createTask(input: CreateAgentTask): Promise<AgentTaskRecord> {
        agentTaskManager.configure(input.topicId);
        return agentTaskManager.create(input);
    }

    async resumeAgentTask(input: {
        agentId: string;
        topicId: string;
        threadId: string;
        runId: string;
        authorization: 'read_only' | 'workspace_write';
    }): Promise<AgentTaskRecord> {
        agentTaskManager.configure(input.topicId);
        return agentTaskManager.resumeSubagent(input);
    }

    async resumeAgentTaskContext(input: {
        agentId: string;
        topicId: string;
        threadId: string;
        runId: string;
        authorization: 'read_only' | 'workspace_write';
    }): Promise<{ task: AgentTaskRecord; conversationHistory: ChatMessage[]; recoveryInstruction: string }> {
        agentTaskManager.configure(input.topicId);
        const previous = agentTaskManager.findResumableAgent(input.agentId, input.topicId, input.threadId);
        if (!previous) throw new Error(`No resumable Agent ${input.agentId} exists in this thread.`);
        const conversationHistory = previous.contextRef
            ? await runLedger.readResumeTranscript(previous.contextRef, input.topicId) ?? []
            : [];
        const task = await agentTaskManager.resumeSubagent(input);
        return {
            task,
            conversationHistory,
            recoveryInstruction: 'The previous in-flight tool result was not restored. Re-read authoritative state and retry the last incomplete step.',
        };
    }

    listTasks(topicId: string): AgentTaskRecord[] {
        agentTaskManager.configure(topicId);
        return agentTaskManager.list();
    }

    async takeTaskNotifications(topicId: string, threadId: string): Promise<StepRequest[]> {
        agentTaskManager.configure(topicId);
        const notifications: StepRequest[] = [];
        for (const task of agentTaskManager.list()) {
            if (task.threadId !== threadId) continue;
            await runtimeFaultInjector.hit('before_task_notify');
            if (!await agentTaskManager.claimNotification(task.taskId)) continue;
            notifications.push(createStepRequest('background_result', {
                taskId: task.taskId,
                agentId: task.agentId,
                status: task.status,
                resultSummary: task.resultSummary,
                outputRef: task.outputRef,
            }, { sourceId: task.taskId }));
        }
        return notifications;
    }

    async getActivity(topicId: string, threadId: string): Promise<ActivityProjection> {
        agentTaskManager.configure(topicId);
        const latestRun = await runLedger.loadLatestRunForTopic(topicId).catch(() => undefined);
        return projectActivities({
            goal: await goalStore.getGoal(topicId, threadId),
            tasks: agentTaskManager.list(),
            events: latestRun?.runId ? runLedger.getSnapshot(latestRun.runId)?.events : undefined,
        });
    }

    beginInteraction(input: {
        id: string;
        topicId: string;
        threadId: string;
        turnId?: string;
        runId?: string;
        kind: InteractionKind;
        title: string;
        detail?: string;
    }): RuntimeInteraction {
        const interaction = this.interactions.request(input);
        void this.appendTranscriptOperations(input.topicId, input.threadId, [{
            op: 'entity.upsert',
            entity: {
                id: interaction.id,
                kind: 'interaction',
                anchorTurnId: interaction.turnId,
                state: interaction.state,
                value: interaction,
                updatedAt: interaction.createdAt,
            },
        }]).catch(error => ErrorReporter.warn('AgentRuntime', 'Failed to persist interaction transcript.', error));
        void this.persistRuntimeProjections(input.topicId, input.threadId);
        return interaction;
    }

    resolveInteraction(
        id: string,
        topicId: string,
        threadId: string,
        resolution: unknown,
        cancelled = false,
    ): RuntimeInteraction | undefined {
        const interaction = cancelled
            ? this.interactions.cancel(id, resolution)
            : this.interactions.resolve(id, resolution);
        if (interaction) {
            void this.appendTranscriptOperations(topicId, threadId, [{
                op: 'entity.upsert',
                entity: {
                    id: interaction.id,
                    kind: 'interaction',
                    anchorTurnId: interaction.turnId,
                    state: interaction.state,
                    value: interaction,
                    updatedAt: interaction.resolvedAt ?? Date.now(),
                },
            }]).catch(error => ErrorReporter.warn('AgentRuntime', 'Failed to persist resolved interaction.', error));
        }
        void this.persistRuntimeProjections(topicId, threadId);
        return interaction;
    }

    recordPermissionTrace(entry: Omit<PermissionTraceEntry, 'timestamp'> & { timestamp?: number }): PermissionTraceEntry {
        const recorded = this.permissionTrace.record(entry);
        void this.getDomainStore(recorded.topicId, recorded.threadId).then(store => store.apply({
            type: 'permission.trace.appended',
            version: 1,
            domain: 'permission',
            payload: { entry: recorded },
        })).catch(error => ErrorReporter.warn('AgentRuntime', 'Failed to persist permission trace.', error));
        return recorded;
    }

    getTranscript(
        topicId: string,
        threadId: string,
        grade: TranscriptGrade = this.transcriptGrade,
    ): AgentTranscriptSnapshot | undefined {
        const snapshot = this.getAgentScope(topicId, threadId).get<AgentTranscriptStore>('transcript')?.snapshot();
        return snapshot ? redactTranscriptSnapshot(snapshot, grade) : undefined;
    }

    getTranscriptPage(
        topicId: string,
        threadId: string,
        options: { beforeOrdinal?: number; pageSize: number },
    ): { turns: TranscriptTurn[]; hasMore: boolean } {
        const transcript = this.getTranscript(topicId, threadId);
        return transcript
            ? paginateTranscriptTurns(transcript, options)
            : { turns: [], hasMore: false };
    }

    async applyTranscriptBatch(
        topicId: string,
        threadId: string,
        batch: TranscriptOpBatch,
        grade: TranscriptGrade = this.transcriptGrade,
    ): Promise<ReturnType<AgentTranscriptStore['apply']>> {
        const domainStore = await this.getDomainStore(topicId, threadId);
        const transcript = this.getTranscriptStore(topicId, threadId, domainStore);
        const result = transcript.apply(batch);
        if (!result.gap && batch.sequence === result.snapshot.sequence) {
            await domainStore.apply({
                type: 'transcript.batch.applied',
                version: 1,
                domain: 'transcript',
                payload: { batch },
            });
        }
        return {
            ...result,
            snapshot: redactTranscriptSnapshot(result.snapshot, grade),
            accepted: filterTranscriptOperations(grade, result.accepted),
        };
    }

    async getRuntimeInspector(topicId: string, threadId: string): Promise<AgentRuntimeInspector> {
        const domainStore = await this.getDomainStore(topicId, threadId);
        const scope = this.getAgentScope(topicId, threadId);
        const snapshot = domainStore.getSnapshot();
        const scheduling = (snapshot.models.scheduling as SchedulingDomainState | undefined)?.state ?? undefined;
        const latestRun = await runLedger.loadLatestRunForTopic(topicId).catch(() => undefined);
        const latestEvents = latestRun?.runId ? runLedger.getSnapshot(latestRun.runId)?.events ?? [] : [];
        const lastModelStart = [...latestEvents].reverse().find(event => event.type === 'model_call_start');
        const lastModelEnd = [...latestEvents].reverse().find(event => event.type === 'model_call_end');
        const prompts = this.promptQueue.list(threadId);
        const interactions = this.interactions.list({ threadId });
        const transcript = this.getTranscriptStore(topicId, threadId, domainStore).snapshot();
        const profileCatalog = agentProfileCatalog.snapshot();
        return {
            version: 1,
            topicId,
            threadId,
            profile: scheduling?.profileName ?? scope.get<ToolActivationService>('toolActivation')?.snapshot().profileName,
            overlays: [...(scheduling?.overlays ?? [])],
            scheduling,
            tools: scope.get<ToolActivationService>('toolActivation')?.snapshot(),
            prompts: {
                total: prompts.length,
                pending: prompts.filter(prompt => prompt.state === 'pending').length,
                running: prompts.filter(prompt => prompt.state === 'running' || prompt.state === 'steered').length,
            },
            interactions: {
                total: interactions.length,
                pending: interactions.filter(interaction => interaction.state === 'pending').length,
            },
            transcript: {
                sequence: transcript.sequence,
                turns: transcript.turns.length,
                entities: transcript.entities.length,
                pendingEntities: transcript.entities.filter(entity => entity.state === 'pending' || entity.state === 'running').length,
                grade: this.transcriptGrade,
            },
            profiles: {
                revision: profileCatalog.revision,
                profiles: profileCatalog.profiles.map(profile => ({
                    name: profile.name,
                    domain: profile.domain,
                    authorizationCeiling: profile.authorizationCeiling,
                })),
                sources: profileCatalog.sources,
            },
            model: latestRun ? {
                provider: lastModelStart?.payload?.providerId ?? latestRun.providerId,
                requested: lastModelStart?.payload?.model ?? latestRun.model,
                effective: lastModelEnd?.payload?.model ?? lastModelStart?.payload?.model ?? latestRun.model,
                fallbackReason: lastModelEnd?.payload?.fallbackFromError,
                runId: latestRun.runId,
                bindingSource: scope.get<ModelBindingState>('modelBinding')?.source,
            } : undefined,
            permissions: this.permissionTrace.list(topicId, threadId).slice(-20),
            scope: this.getAgentScope(topicId, threadId).snapshot(),
        };
    }

    async dispose(): Promise<void> {
        await this.appScope.dispose();
    }

    async askSideQuestion(input: {
        parentRunId: string;
        topicId: string;
        threadId: string;
        question: string;
        abortSignal?: AbortSignal;
    }): Promise<{ sideQuestion: SideQuestion; result: GenerationResult }> {
        if (!vs.workspace.getConfiguration('stellarisLanguageServices.ai.chat').get<boolean>('sideQuestion.enabled', true)) {
            throw new Error('Side questions are disabled by configuration.');
        }
        const stableSequence = runLedger.getLatestEvent(input.parentRunId)?.sequence ?? 0;
        let sideQuestion = sideQuestionService.start(
            input.parentRunId,
            input.threadId,
            input.question,
            stableSequence,
        );
        await runLedger.appendEvent(input.parentRunId, 'side_question_started', {
            sideQuestionId: sideQuestion.id,
            contextRevision: stableSequence,
        }, { status: 'running' });
        sideQuestion = sideQuestionService.anchor(
            sideQuestion.id,
            runLedger.getLatestEvent(input.parentRunId)?.sequence ?? stableSequence,
        );
        const parentHistory = await runLedger.readResumeTranscript(input.parentRunId, input.topicId) ?? [];
        const history: ChatMessage[] = [
            ...parentHistory,
            ...sideQuestionService.getConversation(input.parentRunId),
            {
                role: 'system',
                content: 'Answer the side question only from the stable snapshot. All tools, network, MCP, writes, and main-run steering are disabled. State clearly when the snapshot does not contain the answer.',
            },
        ];
        try {
            const result = await this.runner.run(
                input.question,
                { topicId: input.topicId },
                history,
                {
                    topicId: input.topicId,
                    threadId: `${input.threadId}:side-question`,
                    mode: 'general',
                    domain: 'general',
                    maxIterations: 1,
                    useSlimPrompt: true,
                    excludeTools: [...TOOL_REGISTRY.keys()],
                    abortSignal: input.abortSignal,
                },
            );
            const currentRevision = runLedger.getLatestEvent(input.parentRunId)?.sequence ?? stableSequence;
            const completed = sideQuestionService.complete(
                sideQuestion.id,
                result.explanation || result.code,
                currentRevision,
            );
            await runLedger.appendEvent(input.parentRunId, 'side_question_completed', {
                sideQuestionId: completed.id,
                status: completed.status,
                contextRevision: completed.contextRevision,
            }, { status: completed.status === 'complete' ? 'done' : 'failed' });
            return { sideQuestion: completed, result };
        } catch (error) {
            sideQuestionService.cancel(sideQuestion.id);
            throw error;
        }
    }

    async reconcileConversationUndo(input: {
        topicId: string;
        threadId: string;
        turnIds: string[];
        goal?: DurableAgentGoal;
        taskNotifications: Record<string, AgentTaskRecord['notification']>;
        schedulingState: AgentSchedulingState | null;
        toolSchemas: string[];
        todos: TodoItem[];
        targetSequence: number;
        compactionBoundarySequence?: number;
    }): Promise<UndoResult> {
        const domainStore = await this.getDomainStore(input.topicId, input.threadId);
        const currentSnapshot = domainStore.getSnapshot();
        const sequence = currentSnapshot.sequence;
        const currentContext = currentSnapshot.models.context as ContextDomainState | undefined;
        const compactionBoundarySequence = Math.max(
            input.compactionBoundarySequence ?? 0,
            currentContext?.compactionBoundarySequence ?? 0,
        ) || undefined;
        const run = await runLedger.loadLatestRunForTopic(input.topicId).catch(() => undefined);
        if (run?.runId) {
            await runLedger.appendEvent(run.runId, 'undo_started', {
                turnId: input.turnIds[0] ?? 'unknown',
                domainSequence: sequence,
            }, { status: 'running' });
        }
        const result = await conversationUndoCoordinator.undo({
            topicId: input.topicId,
            threadId: input.threadId,
            turnId: input.turnIds[0] ?? 'unknown',
            sequence: input.targetSequence,
            compactionBoundarySequence,
        }, async () => {
            await goalStore.restoreSnapshot(input.topicId, input.threadId, input.goal);
            const goalRuntime = this.getGoalRuntimeState(input.topicId, input.threadId);
            goalRuntime.goal = input.goal;
            await agentTaskManager.restoreNotificationStates(input.topicId, input.taskNotifications);
            this.runner.toolExecutor.restoreTodos(input.todos);
            await domainStore.apply({
                type: 'scheduling.state.replaced',
                version: 1,
                domain: 'scheduling',
                payload: { state: input.schedulingState },
            });
            await domainStore.apply({
                type: 'goal.state.replaced',
                version: 1,
                domain: 'goal',
                payload: { goal: input.goal ?? null },
            });
            await domainStore.apply({
                type: 'task.state.replaced',
                version: 1,
                domain: 'task',
                payload: { tasks: agentTaskManager.list(input.topicId) },
            });
            await domainStore.apply({
                type: 'context.tool_schemas.replaced',
                version: 1,
                domain: 'context',
                payload: { loaded: input.toolSchemas },
            });
            for (const turnId of input.turnIds) {
                await domainStore.apply({
                    type: 'context.turn.undone',
                    version: 1,
                    domain: 'context',
                    payload: { turnId },
                });
                await domainStore.apply({
                    type: 'context.transcript.changed',
                    version: 1,
                    domain: 'context',
                    payload: { action: 'splice', turnId },
                });
            }
            await this.appendTranscriptOperations(input.topicId, input.threadId, [{
                op: 'turns.remove',
                turnIds: input.turnIds,
            }]);
            await domainStore.checkpoint();
        });
        if (run?.runId) {
            await runLedger.appendEvent(run.runId, 'undo_completed', {
                turnIds: input.turnIds,
                applied: result.applied,
                needsAttention: result.needsAttention,
                reason: result.reason,
            }, { status: result.applied ? 'done' : 'failed' });
        }
        return result;
    }

    async getConversationUndoState(topicId: string, threadId: string): Promise<ConversationUndoRuntimeState> {
        const snapshot = (await this.getDomainStore(topicId, threadId)).getSnapshot();
        const scheduling = snapshot.models.scheduling as SchedulingDomainState | undefined;
        const context = snapshot.models.context as ContextDomainState | undefined;
        return {
            domainSequence: snapshot.sequence,
            compactionBoundarySequence: context?.compactionBoundarySequence,
            schedulingState: scheduling?.state ?? null,
            toolSchemas: [...(context?.toolSchemas ?? [])],
            todos: this.runner.toolExecutor.getTodos(),
        };
    }

    compactThread(topicId: string, threadId: string, compactedFromRunId?: string, latestSummaryRef?: string): Promise<AgentThreadRecord | undefined> {
        return threadStore.markCompacted(topicId, threadId, compactedFromRunId, latestSummaryRef);
    }

    listThreads(topicId: string): Promise<AgentThreadRecord[]> {
        return threadStore.listThreads(topicId);
    }

    private getDomainStore(topicId: string, threadId: string): Promise<DomainStateStore> {
        const scope = this.getAgentScope(topicId, threadId);
        return scope.getOrCreate('domainStore', async () => {
                const created = createRuntimeDomainStateStore(topicId, threadId);
                await created.restore();
                const restored = created.getSnapshot();
                this.promptQueue.restore((restored.models.prompt as PromptDomainState | undefined)?.prompts ?? []);
                this.interactions.restore((restored.models.interaction as InteractionDomainState | undefined)?.interactions ?? []);
                this.permissionTrace.restore((restored.models.permission as PermissionDomainState | undefined)?.entries ?? []);
                const restoredPrompts = (restored.models.prompt as PromptDomainState | undefined)?.prompts ?? [];
                const restoredInteractions = (restored.models.interaction as InteractionDomainState | undefined)?.interactions ?? [];
                const normalizedPrompts = this.promptQueue.list(threadId);
                const normalizedInteractions = this.interactions.list({ threadId });
                if (JSON.stringify(restoredPrompts) !== JSON.stringify(normalizedPrompts)) {
                    await created.apply({
                        type: 'prompt.state.replaced',
                        version: 1,
                        domain: 'prompt',
                        payload: { prompts: normalizedPrompts },
                    });
                }
                if (JSON.stringify(restoredInteractions) !== JSON.stringify(normalizedInteractions)) {
                    await created.apply({
                        type: 'interaction.state.replaced',
                        version: 1,
                        domain: 'interaction',
                        payload: { interactions: normalizedInteractions },
                    });
                }
                return created;
        });
    }

    private getAgentScope(topicId: string, threadId: string): RuntimeScope {
        return this.appScope.child('session', topicId).child('agent', threadId);
    }

    private getTranscriptStore(
        topicId: string,
        threadId: string,
        domainStore?: DomainStateStore,
    ): AgentTranscriptStore {
        const scope = this.getAgentScope(topicId, threadId);
        let transcript = scope.get<AgentTranscriptStore>('transcript');
        if (!transcript) {
            const restored = domainStore
                ? (domainStore.getSnapshot().models.transcript as TranscriptDomainState | undefined)?.transcript
                : undefined;
            transcript = new AgentTranscriptStore(threadId, restored);
            scope.set('transcript', transcript);
        }
        return transcript;
    }

    private getTranscriptRuntimeState(topicId: string, threadId: string): TranscriptRuntimeState {
        const scope = this.getAgentScope(topicId, threadId);
        return scope.get<TranscriptRuntimeState>('transcriptRuntime')
            ?? scope.set<TranscriptRuntimeState>('transcriptRuntime', {
                tail: Promise.resolve(),
                stepOrdinal: 0,
                streams: new TranscriptStreamBuffer(),
            });
    }

    private getGoalRuntimeState(topicId: string, threadId: string): GoalRuntimeState {
        const scope = this.getAgentScope(topicId, threadId);
        return scope.get<GoalRuntimeState>('goalRuntime')
            ?? scope.set<GoalRuntimeState>('goalRuntime', {
                owned: false,
                activeContinuations: new Set(),
            });
    }

    private appendTranscriptOperations(
        topicId: string,
        threadId: string,
        operations: TranscriptOperation[],
    ): Promise<void> {
        if (operations.length === 0) return Promise.resolve();
        const state = this.getTranscriptRuntimeState(topicId, threadId);
        const current = state.tail.then(async () => {
            const store = await this.getDomainStore(topicId, threadId);
            const transcript = this.getTranscriptStore(topicId, threadId, store);
            const batch = transcript.nextBatch(operations);
            await store.apply({
                type: 'transcript.batch.applied',
                version: 1,
                domain: 'transcript',
                payload: { batch },
            });
            const result = transcript.apply(batch);
            if (result.gap) {
                throw new Error(
                    `Transcript operation gap (${result.gap.kind}): expected ${result.gap.expected}, received ${result.gap.received}.`,
                );
            }
        });
        state.tail = current.catch(() => {});
        return current;
    }

    private flushTranscript(topicId: string, threadId: string): Promise<void> {
        const state = this.getTranscriptRuntimeState(topicId, threadId);
        for (const turnId of state.streams.pendingTurnIds()) {
            this.flushPendingTranscriptStream(topicId, threadId, turnId);
        }
        return state.tail;
    }

    private clearTranscriptTurnState(topicId: string, threadId: string, turnId: string): void {
        const state = this.getTranscriptRuntimeState(topicId, threadId);
        state.streams.clear(turnId);
    }

    private flushPendingTranscriptStream(topicId: string, threadId: string, turnId: string): Promise<void> {
        const batch = this.getTranscriptRuntimeState(topicId, threadId).streams.take(turnId);
        if (!batch) return this.getTranscriptRuntimeState(topicId, threadId).tail;
        return this.appendTranscriptOperations(topicId, threadId, [
            ...(batch.initialize ? [{
                op: 'step.upsert' as const,
                turnId,
                step: { stepId: `${turnId}:assistant-stream`, ordinal: batch.ordinal, state: 'running' as const },
            }, {
                op: 'frame.upsert' as const,
                turnId,
                stepId: `${turnId}:assistant-stream`,
                frame: { frameId: `${turnId}:assistant`, kind: 'text' as const, text: '', status: 'running' },
            }] : []),
            {
                op: 'append',
                target: {
                    turnId,
                    stepId: `${turnId}:assistant-stream`,
                    frameId: `${turnId}:assistant`,
                },
                offset: batch.offset,
                text: batch.text,
            },
        ]);
    }

    private recordTranscriptStep(
        topicId: string,
        threadId: string,
        turnId: string,
        step: AgentStep,
    ): Promise<void> {
        const runtime = this.getTranscriptRuntimeState(topicId, threadId);
        const ordinal = runtime.stepOrdinal++;
        if (step.type === 'text_delta') {
            return runtime.streams.append(turnId, step.content, ordinal)
                ? this.flushPendingTranscriptStream(topicId, threadId, turnId)
                : runtime.tail;
        }

        // Preserve transcript ordering when a tool/thinking step follows streamed text.
        this.flushPendingTranscriptStream(topicId, threadId, turnId);

        if (step.type === 'todo_update') {
            return this.appendTranscriptOperations(topicId, threadId, [{
                op: 'entity.upsert',
                entity: {
                    id: `todo:${turnId}:${step.stepIndex ?? ordinal}`,
                    kind: 'todo',
                    anchorTurnId: turnId,
                    state: 'running',
                    value: step.toolResult ?? step.content,
                    updatedAt: step.timestamp,
                },
            }]);
        }

        if (step.type === 'subtask_start' || step.type === 'subtask_complete') {
            return this.appendTranscriptOperations(topicId, threadId, [{
                op: 'entity.upsert',
                entity: {
                    id: `task:${turnId}:${step.agentId ?? step.invocationId ?? step.stepIndex ?? ordinal}`,
                    kind: 'task',
                    anchorTurnId: turnId,
                    state: step.type === 'subtask_start' ? 'running' : 'completed',
                    value: {
                        content: step.content,
                        agentId: step.agentId,
                        invocationId: step.invocationId,
                        subagentType: step.subagentType,
                    },
                    updatedAt: step.timestamp,
                },
            }]);
        }

        if (step.type === 'permission_request') {
            return this.appendTranscriptOperations(topicId, threadId, [{
                op: 'entity.upsert',
                entity: {
                    id: step.permissionId ?? `permission:${turnId}:${ordinal}`,
                    kind: 'interaction',
                    anchorTurnId: turnId,
                    state: 'pending',
                    value: { content: step.content, toolName: step.toolName },
                    updatedAt: step.timestamp,
                },
            }]);
        }

        const stepId = step.invocationId ?? `${turnId}:step:${step.stepIndex ?? ordinal}`;
        const kind = step.type === 'thinking' || step.type === 'thinking_content'
            ? 'thinking'
            : step.type === 'tool_call' || step.type === 'tool_result'
                ? 'tool'
                : 'notice';
        const failed = step.type === 'error';
        const running = step.type === 'tool_call' || step.type === 'thinking' || step.type === 'thinking_content';
        const frameSuffix = step.type === 'tool_call'
            ? 'call'
            : step.type === 'tool_result' ? 'result' : 'frame';
        return this.appendTranscriptOperations(topicId, threadId, [{
            op: 'step.upsert',
            turnId,
            step: {
                stepId,
                ordinal,
                state: failed ? 'failed' : running ? 'running' : 'completed',
            },
        }, {
            op: 'frame.upsert',
            turnId,
            stepId,
            frame: {
                frameId: `${stepId}:${frameSuffix}`,
                kind,
                text: step.content,
                toolName: step.toolName,
                toolCallId: step.invocationId,
                status: failed ? 'failed' : running ? 'running' : 'completed',
                payload: step.type === 'tool_call' ? step.toolArgs : step.toolResult,
            },
        }]);
    }

    private async persistRuntimeProjections(topicId: string, threadId: string): Promise<void> {
        const store = await this.getDomainStore(topicId, threadId);
        await Promise.all([
            store.apply({
                type: 'prompt.state.replaced',
                version: 1,
                domain: 'prompt',
                payload: { prompts: this.promptQueue.list(threadId) },
            }),
            store.apply({
                type: 'interaction.state.replaced',
                version: 1,
                domain: 'interaction',
                payload: { interactions: this.interactions.list({ threadId }) },
            }),
        ]);
        await store.checkpoint();
    }

    private getLoopKernel(topicId: string, threadId: string): AgentLoopKernel {
        const scope = this.getAgentScope(topicId, threadId);
        let kernel = scope.get<AgentLoopKernel>('loopKernel');
        if (!kernel) {
            kernel = new AgentLoopKernel({
                execute: async ({ request }) => {
                    const turn = request.payload as TurnStartRequest;
                    return this.startTurnInternal(turn, request);
                },
            });
            scope.set('loopKernel', kernel);
        }
        return kernel;
    }
}
