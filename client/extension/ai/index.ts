/**
 * CWTools AI Module — Public API
 *
 * Entry point for the AI module. Exports all components needed
 * for integration into the main extension.
 */

export { AIService, ApiKeyManager } from './aiService';
export { BUILTIN_PROVIDERS, getProvider } from './providers';
export { AgentToolExecutor, TOOL_DEFINITIONS } from './agentTools';
export { AgentRunner } from './agentRunner';
export { PromptBuilder } from './promptBuilder';
export { AIChatPanelProvider } from './chatPanel';
export { AIInlineCompletionProvider } from './inlineProvider';
export { UsageTracker } from './usageTracker';

// Re-export key types
export type {
    AIUserConfig,
    AIProviderConfig,
    GenerationResult,
    AgentStep,
    AgentMode,
    TodoItem,
    ChatTopic,
    ChatHistoryMessage,
    AgentToolName,
} from './types';
