/**
 * Chat Panel Message Types
 *
 * Typed contracts for host ↔ webview communication.
 * This module defines all message types exchanged between the
 * Extension Host (chatPanelProvider.ts) and the Webview (chatPanel.ts).
 *
 * Phase 1 of the Webview Modularization plan:
 *   - Stabilize message contracts with compile-time types
 *   - No runtime behavior changes
 */

// ─── Webview → Host messages (postMessage from webview) ──────────────────────

export interface ReadyMessage { type: 'ready' }
export interface SendMessagePayload { type: 'sendMessage'; text: string; mode: string; images?: string[] }
export interface SendMessageWithReferencePayload { type: 'sendMessageWithReference'; text: string; mode: string; reference: unknown; images?: string[] }
export interface EditAndResendMessagePayload { type: 'editAndResendMessage'; messageIndex: number; text: string; contexts?: unknown[]; images?: string[] }
export interface CancelGenerationMessage { type: 'cancelGeneration' }
export interface ResumeGenerationMessage { type: 'resumeGeneration' }
export interface NewTopicMessage { type: 'newTopic' }
export interface OpenSettingsMessage { type: 'openSettings' }
export interface SwitchModeMessage { type: 'switchMode'; mode: string }
export interface SwitchWorkflowMessage { type: 'switchWorkflow'; workflowId?: string | null }
export interface QuickChangeModelMessage { type: 'quickChangeModel'; model: string }
export interface RetractMessagePayload { type: 'retractMessage'; messageIndex: number }
export interface SearchTopicsMessage { type: 'searchTopics'; query: string }
export interface ExportTopicMessage { type: 'exportTopic'; topicId?: string }
export interface OpenPlanFileMessage { type: 'openPlanFile'; filePath: string }
export interface OpenArtifactMessage { type: 'openArtifact'; artifactId: string; file?: string }
export interface OpenContextReferenceMessage { type: 'openContextReference'; context: unknown }
export interface PermissionResponseMessage { type: 'permissionResponse'; permissionId: string; allowed: boolean; alwaysAllow?: boolean }
export interface ApproveTransactionMessage { type: 'approveTransaction'; txId: string }
export interface RejectTransactionMessage { type: 'rejectTransaction'; txId: string }
export interface ConfirmWriteFileMessage { type: 'confirmWriteFile'; messageId: string }
export interface CancelWriteFileMessage { type: 'cancelWriteFile'; messageId: string }
export interface RequestUsageStatsMessage { type: 'requestUsageStats' }
export interface PromptClearUsageStatsMessage { type: 'promptClearUsageStats' }
export interface SetShowArchivedMessage { type: 'setShowArchived'; show: boolean }
export interface RenameTopicMessage { type: 'renameTopic'; topicId: string; title: string }
export interface ForkTopicMessage { type: 'forkTopic'; topicId: string; messageIndex: number }
export interface SlashCommandMessage { type: 'slashCommand'; command: string }
export interface RequestMentionSearchMessage { type: 'requestMentionSearch'; query: string }
export interface InstallSkillMessage { type: 'installSkill'; source: string }
export interface DeleteSkillMessage { type: 'deleteSkill'; skill: string }
export interface QuestionResponseMessage { type: 'questionResponse'; questionId: string; answers: Record<string, string> }

/** Union of all webview → host messages. */
export type WebviewToHostMessage =
    | ReadyMessage
    | SendMessagePayload
    | SendMessageWithReferencePayload
    | EditAndResendMessagePayload
    | CancelGenerationMessage
    | ResumeGenerationMessage
    | NewTopicMessage
    | OpenSettingsMessage
    | SwitchModeMessage
    | SwitchWorkflowMessage
    | QuickChangeModelMessage
    | RetractMessagePayload
    | SearchTopicsMessage
    | ExportTopicMessage
    | OpenPlanFileMessage
    | OpenArtifactMessage
    | OpenContextReferenceMessage
    | PermissionResponseMessage
    | ApproveTransactionMessage
    | RejectTransactionMessage
    | ConfirmWriteFileMessage
    | CancelWriteFileMessage
    | RequestUsageStatsMessage
    | PromptClearUsageStatsMessage
    | SetShowArchivedMessage
    | RenameTopicMessage
    | ForkTopicMessage
    | SlashCommandMessage
    | RequestMentionSearchMessage
    | InstallSkillMessage
    | DeleteSkillMessage
    | QuestionResponseMessage;

// ─── Host → Webview messages (panel.webview.postMessage) ─────────────────────

export interface StreamTextMessage { type: 'streamText'; text: string; isComplete: boolean }
export interface AgentStepMessage { type: 'agentStep'; step: unknown }
export interface ContextCompactionStatusMessage { type: 'contextCompactionStatus'; step: unknown }
export interface UpdateHistoryMessage { type: 'updateHistory'; messages: unknown[] }
export interface SetModeMessage { type: 'setMode'; mode: string }
export interface WorkflowListMessage { type: 'workflowList'; workflows: unknown[]; currentWorkflowId?: string | null; labels?: unknown }
export interface WorkflowChangedMessage { type: 'workflowChanged'; workflowId?: string | null; workflow?: unknown; labels?: unknown }
export interface SetModelMessage { type: 'setModel'; model: string }
export interface ShowPermissionMessage { type: 'showPermission'; permissionId: string; tool: string; description: string; command?: string }
export interface ShowWriteConfirmMessage { type: 'showWriteConfirm'; messageId: string; filePath: string; diff: string }
export interface TopicListMessage { type: 'topicList'; topics: unknown[] }
export interface UsageStatsMessage { type: 'usageStats'; stats: unknown }
export interface MentionSearchResultsMessage { type: 'mentionSearchResults'; results: unknown[] }
export interface ErrorMessage { type: 'error'; message: string }
export interface ConfigMessage { type: 'config'; config: unknown }
export interface SetGeneratingMessage { type: 'setGenerating'; generating: boolean }
export interface ArtifactsUpdateMessage { type: 'artifactsUpdate'; artifacts: unknown[] }
export interface SkillsUpdateMessage { type: 'skillsUpdate'; skills: unknown[] }

/** Union of all host → webview messages. */
export type HostToWebviewMessage =
    | StreamTextMessage
    | AgentStepMessage
    | ContextCompactionStatusMessage
    | UpdateHistoryMessage
    | SetModeMessage
    | WorkflowListMessage
    | WorkflowChangedMessage
    | SetModelMessage
    | ShowPermissionMessage
    | ShowWriteConfirmMessage
    | TopicListMessage
    | UsageStatsMessage
    | MentionSearchResultsMessage
    | ErrorMessage
    | ConfigMessage
    | SetGeneratingMessage
    | ArtifactsUpdateMessage
    | SkillsUpdateMessage;
