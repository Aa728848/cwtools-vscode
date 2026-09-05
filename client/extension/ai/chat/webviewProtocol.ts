import {
    isCodexServiceTier,
    isResponseVerbosity,
    type ConnectionTestSettings,
    type ContextItem,
    type PanelSettings,
    type WebViewMessage,
} from '../types';
import { isSubscriptionProxyMode } from '../../../shared/subscriptionProxy';
import {
    fields,
    isArrayOf,
    isBoolean,
    isFiniteNumber,
    isInteger,
    isOneOf,
    isRecord,
    isString,
    isStringArray,
    nullable,
    optional,
    parseProtocolMessage,
    type MessageValidator,
} from '../../../shared/protocolValidation';

const isReasoningEffort = isOneOf(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
const isWriteMode = isOneOf(['confirm', 'auto', 'auto_review', 'full'] as const);
const isPermissionDecision = isOneOf(['accept', 'acceptForSession', 'decline', 'cancel'] as const);
const isCustomApiFormat = isOneOf([
    'openai-chat-completions',
    'openai-responses',
    'anthropic-messages',
    'gemini-generate-content',
] as const);

function isContextItem(value: unknown): value is ContextItem {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.type !== 'string'
        || typeof value.label !== 'string') return false;
    if (value.description !== undefined && typeof value.description !== 'string') return false;
    if (value.tokenEstimate !== undefined && !isFiniteNumber(value.tokenEstimate)) return false;
    switch (value.type) {
        case 'code_selection':
            return typeof value.uri === 'string' && isInteger(value.startLine) && isInteger(value.endLine);
        case 'file':
        case 'folder':
            return typeof value.uri === 'string';
        case 'symbol':
            return typeof value.name === 'string';
        case 'vanilla':
            return typeof value.vanillaType === 'string' && typeof value.vanillaId === 'string';
        case 'blackboard':
            return typeof value.key === 'string';
        case 'quote':
            return typeof value.text === 'string';
        case 'image':
        case 'diagnostics':
        case 'scope':
            return true;
        default:
            return false;
    }
}

function isPanelSettings(value: unknown): value is PanelSettings {
    return isRecord(value)
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && typeof value.apiKey === 'string'
        && typeof value.endpoint === 'string'
        && isFiniteNumber(value.maxContextTokens)
        && (value.agentFileWriteMode === 'confirm' || value.agentFileWriteMode === 'auto')
        && isReasoningEffort(value.reasoningEffort)
        && isResponseVerbosity(value.responseVerbosity)
        && isCodexServiceTier(value.codexServiceTier)
        && isRecord(value.inlineCompletion)
        && isRecord(value.translationPreview);
}

function isConnectionTestSettings(value: unknown): value is ConnectionTestSettings {
    return isRecord(value)
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && typeof value.apiKey === 'string'
        && typeof value.endpoint === 'string'
        && (value.customApiFormat === undefined || isCustomApiFormat(value.customApiFormat));
}

const isAnnotations = isArrayOf(value => isRecord(value)
    && typeof value.section === 'string'
    && typeof value.note === 'string');
const isContexts = isArrayOf(isContextItem);
const isQuestionAnswers = (value: unknown): boolean => isRecord(value)
    && Object.values(value).every(answer => typeof answer === 'string'
        || (Array.isArray(answer) && answer.every(item => typeof item === 'string')));
const isOptionalStringArray = optional(isStringArray);
const noFields = fields();

const validators: Record<WebViewMessage['type'], MessageValidator> = {
    sendMessage: fields({ text: isString }, { attachedFiles: isOptionalStringArray, images: isOptionalStringArray }),
    steerGeneration: fields({ text: isString }, { images: isOptionalStringArray }),
    sendMessageWithReference: fields({ text: isString, contexts: isContexts }, { images: isOptionalStringArray }),
    editAndResendMessage: fields({ messageIndex: isInteger, text: isString }, { contexts: optional(isContexts), images: isOptionalStringArray }),
    openContextReference: fields({ context: isContextItem }),
    insertCode: fields({ code: isString }),
    copyCode: fields({ code: isString }),
    regenerate: noFields,
    resumeGeneration: noFields,
    newTopic: noFields,
    loadTopic: fields({ topicId: isString }),
    deleteTopic: fields({ topicId: isString }),
    renameTopic: fields({ topicId: isString, title: isString }),
    forkTopic: fields({ topicId: isString, messageIndex: isInteger }),
    archiveTopic: fields({ topicId: isString }),
    pinTopic: fields({ topicId: isString }, { pinned: optional(isBoolean) }),
    setTopicWorkspace: fields({ topicId: isString }, { workspaceId: optional(nullable(isString)), workspaceLabel: optional(nullable(isString)) }),
    setShowArchived: fields({ show: isBoolean }),
    configureProvider: noFields,
    cancelGeneration: noFields,
    switchSchedulingDomain: fields({ domain: isOneOf(['paradox', 'general', 'hybrid'] as const) }),
    switchWorkflow: fields({}, { workflowId: optional(nullable(isString)) }),
    openAgentManager: noFields,
    openSettings: noFields,
    saveSettings: fields({ settings: isPanelSettings }),
    detectOllamaModels: fields({ endpoint: isString }),
    fetchApiModels: fields({ providerId: isString, endpoint: isString, apiKey: isString }, { customApiFormat: optional(isCustomApiFormat) }),
    deleteApiKey: fields({ providerId: isString }),
    testConnection: fields({ settings: isConnectionTestSettings }),
    deleteDynamicModel: fields({ providerId: isString, modelId: isString }),
    codexLogin: noFields,
    codexRefreshAccount: noFields,
    codexLogout: noFields,
    antigravityLogin: noFields,
    antigravityRefreshAccount: noFields,
    antigravityLogout: noFields,
    saveSubscriptionProxy: fields({ mode: isSubscriptionProxyMode }, { url: optional(value => typeof value === 'string' && value.length <= 2048) }),
    refreshSubscriptionProxy: noFields,
    installSkill: fields({ source: isString }),
    deleteSkill: fields({ skill: isString }),
    retractMessage: fields({ messageIndex: isInteger }),
    confirmWriteFile: fields({ messageId: isString }),
    cancelWriteFile: fields({ messageId: isString }),
    quickChangeModel: fields({ model: isString }),
    quickChangeReasoningEffort: fields({ effort: isReasoningEffort }),
    quickChangeWriteMode: fields({ mode: isWriteMode }),
    slashCommand: fields({ command: isString }),
    permissionResponse: fields({ permissionId: isString }, {
        decision: optional(isPermissionDecision),
        allowed: optional(isBoolean),
        alwaysAllow: optional(isBoolean),
    }),
    questionResponse: fields({ questionId: isString }, {
        answers: optional(isQuestionAnswers),
        cancelled: optional(isBoolean),
    }),
    submitPlanAnnotations: fields({ annotations: isAnnotations }),
    revisePlanWithAnnotations: fields({ annotations: isAnnotations }),
    reviseWalkthroughWithAnnotations: fields({ annotations: isAnnotations }),
    approveWalkthrough: noFields,
    openPlanFile: fields({ filePath: isString }),
    openArtifact: fields({ artifactId: isString }, { file: optional(isString) }),
    openRunResult: fields({ filePath: isString }),
    cleanupRunArtifacts: fields({}, { maxAgeDays: optional(isFiniteNumber), maxFiles: optional(isFiniteNumber) }),
    ready: noFields,
    requestFileList: noFields,
    searchTopics: fields({ query: isString }),
    exportTopic: fields({}, { topicId: optional(isString) }),
    exportTopicJson: fields({}, { topicId: optional(isString) }),
    importTopic: fields({ data: isString }),
    requestUsageStats: noFields,
    promptClearUsageStats: noFields,
    clearUsageStats: noFields,
    requestMentionSearch: fields({ query: isString }),
    requestManagerSnapshot: noFields,
    requestCompactedMemory: noFields,
    requestScratchFiles: noFields,
    openScratchFile: fields({ file: isString }),
};

export function parseWebviewMessage(input: unknown): WebViewMessage | null {
    return parseProtocolMessage<WebViewMessage>(input, validators);
}
