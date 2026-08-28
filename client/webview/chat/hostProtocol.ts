import {
    fields,
    isArray,
    isArrayOf,
    isBoolean,
    isFiniteNumber,
    isInteger,
    isObject,
    isOneOf,
    isRecord,
    isString,
    isStringArray,
    optional,
    parseProtocolMessage,
    type MessageValidator,
} from '../../shared/protocolValidation';

const isSurface = isOneOf(['chat', 'manager'] as const);
const isRecordArray = isArrayOf(isObject);
const isQuestionOption = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    return typeof value.label === 'string' && typeof value.description === 'string';
};
const isQuestionItems = (value: unknown): boolean => Array.isArray(value)
    && value.length >= 1
    && value.length <= 3
    && value.every(item => {
        if (!isRecord(item)) return false;
        return typeof item.id === 'string'
            && typeof item.question === 'string'
            && (item.header === undefined || typeof item.header === 'string')
            && (item.multiSelect === undefined || typeof item.multiSelect === 'boolean')
            && Array.isArray(item.options)
            && item.options.length >= 2
            && item.options.length <= 4
            && item.options.every(isQuestionOption);
    });
const isAny = () => true;
const noFields = fields();

const validators = {
    addUserMessage: fields({ text: isString, messageIndex: isInteger }, { images: optional(isStringArray), contexts: optional(isArray), schedulingState: optional(isObject) }),
    agentRoutingStatus: fields({ phase: isOneOf(['classifying', 'resolved', 'fallback'] as const) }, { schedulingState: optional(isObject) }),
    queuedUserInput: fields({ text: isString, messageIndex: isInteger }, { images: optional(isStringArray), contexts: optional(isArray) }),
    startBackgroundGeneration: noFields,
    agentStep: fields({ step: isObject }),
    contextCompactionStatus: fields({ step: isObject }),
    generationComplete: fields({ result: isObject }),
    generationError: fields({ error: isString }, { canResume: optional(isBoolean) }),
    insertSelectionReference: fields({ relPath: isString, startLine: isInteger, endLine: isInteger }),
    topicList: fields({ topics: isRecordArray }, { stats: optional(isObject) }),
    loadTopicMessages: fields({ messages: isRecordArray }, { targetSurface: optional(isSurface) }),
    streamToken: fields({ token: isString }),
    clearChat: fields({}, { targetSurface: optional(isSurface) }),
    workflowList: fields({ workflows: isRecordArray }, { currentWorkflowId: optional(value => value === null || typeof value === 'string'), labels: optional(isObject) }),
    workflowChanged: fields({}, { workflowId: optional(value => value === null || typeof value === 'string'), workflow: optional(isObject), labels: optional(isObject) }),
    slashCommandList: fields({ commands: isRecordArray }),
    slashCommandResult: fields({ command: isString, status: isString, message: isString }, { uiAction: optional(isString) }),
    todoUpdate: fields({ todos: isRecordArray }, { agentId: optional(isString), threadId: optional(isString), runId: optional(isString) }),
    settingsData: fields({ providers: isRecordArray, current: isObject }, {
        ollamaModels: optional(isRecordArray), showPanel: optional(isBoolean), targetSurface: optional(isSurface),
        modelContextTokens: optional(isObject), thinkingModelPrefixes: optional(isStringArray),
        reasoningCapabilities: optional(isObject), codexAccount: optional(isObject),
    }),
    ollamaModels: fields({ models: isRecordArray }, { error: optional(isString) }),
    apiModelsFetched: fields({ providerId: isString, models: isRecordArray }, {
        dynContexts: optional(isObject), reasoningCapabilities: optional(isObject), error: optional(isString), ctxNote: optional(isString),
    }),
    testConnectionResult: fields({ ok: isBoolean, message: isString }),
    messageRetracted: fields({ messageIndex: isInteger }, { restoredInput: optional(isObject), restoredFiles: optional(isFiniteNumber), skippedFiles: optional(isFiniteNumber) }),
    pendingWriteFile: fields({ file: isString, messageId: isString, isNewFile: isBoolean }, {
        diffPreview: optional(isString), additions: optional(isFiniteNumber), deletions: optional(isFiniteNumber), diffLines: optional(isArray),
    }),
    autoWriteFile: fields({ file: isString, isNewFile: isBoolean }),
    topicTitleGenerated: fields({ topicId: isString, title: isString }),
    topicForked: fields({ newTopicId: isString, title: isString }),
    permissionRequest: fields({
        permissionId: isString, itemId: isString, tool: isString, description: isString, availableDecisions: isStringArray,
    }, {
        threadId: optional(isString), turnId: optional(isString), command: optional(isString), allowAlways: optional(isBoolean),
        proposedRule: optional(isObject), preflight: optional(isObject),
    }),
    permissionResolved: fields({ permissionId: isString, itemId: isString, decision: isString, reviewer: isString }, {
        threadId: optional(isString), turnId: optional(isString),
    }),
    questionRequest: fields({ questionId: isString, topicId: isString, questions: isQuestionItems }, {
        threadId: optional(isString), turnId: optional(isString),
    }),
    questionResolved: fields({ questionId: isString }, { cancelled: optional(isBoolean) }),
    floatingCardResolved: fields({ card: isString }, { id: optional(isString) }),
    setSchedulingState: fields({ schedulingState: isObject }),
    replaySteps: fields({ steps: isRecordArray, isGenerating: isBoolean }),
    planFileSaved: fields({ filePath: isString, relPath: isString }),
    walkthroughFileSaved: fields({ filePath: isString, relPath: isString }),
    blueprintFileSaved: fields({ filePath: isString, relPath: isString }),
    renderPlan: fields({ sections: isStringArray }, { planText: optional(isString) }),
    renderWalkthrough: fields({ sections: isStringArray }),
    renderBlueprint: fields({ sections: isStringArray }, { planText: optional(isString) }),
    fileList: fields({ files: isStringArray }),
    tokenUsage: fields({ usage: isObject, model: isString }),
    diffSummary: fields({ files: isRecordArray }, { summaryId: optional(isString) }),
    topicSearchResults: fields({ results: isRecordArray }, {
        query: optional(isString), totalCount: optional(isFiniteNumber), stats: optional(isObject),
    }),
    topicImported: fields({ topicId: isString, title: isString }),
    skillsList: fields({ skills: isStringArray }),
    skillInstallComplete: fields({ success: isBoolean }),
    usageStats: fields({ stats: isAny }),
    artifactList: fields({ artifacts: isRecordArray }),
    runSnapshot: fields({ snapshot: isObject }, {
        events: optional(isRecordArray), eventCount: optional(isFiniteNumber), truncatedEventCount: optional(isFiniteNumber),
        childRuns: optional(isRecordArray), artifacts: optional(isRecordArray), cacheStats: optional(isObject), scheduling: optional(isObject),
    }),
    mentionSearchResults: fields({ results: isRecordArray }),
    managerSnapshot: fields({
        topics: isRecordArray, messages: isRecordArray, schedulingState: isObject,
        isGenerating: isBoolean, liveStepCount: isFiniteNumber, artifacts: isRecordArray,
    }, {
        stats: optional(isObject), messageCount: optional(isFiniteNumber),
        workflowId: optional(value => value === null || typeof value === 'string'), todos: optional(isRecordArray),
        activity: optional(isObject), runtimeInspector: optional(isObject), transcript: optional(isObject),
    }),
    activitySnapshot: fields({ activity: isObject }),
    runtimeInspectorSnapshot: fields({ runtimeInspector: isObject }),
    transcriptSnapshot: fields({ transcript: isObject }),
    compactedMemoryResult: fields({ content: isString }),
    runArtifactsCleanupResult: fields({ deletedCount: isFiniteNumber, keptCount: isFiniteNumber, reclaimedBytes: isFiniteNumber }),
    scratchFiles: fields({ files: isRecordArray }),
} satisfies Record<string, MessageValidator>;

export type HostProtocolMessage = Record<string, unknown> & { type: keyof typeof validators };

export function parseHostMessage(input: unknown): HostProtocolMessage | null {
    return parseProtocolMessage<HostProtocolMessage>(input, validators);
}
