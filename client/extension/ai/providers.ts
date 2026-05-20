/**
 * CWTools AI Module — Provider Definitions & Quick Configurations Facade
 */

import type { AIProviderConfig, ChatCompletionRequest, ContentPart } from './types';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';
import { contentToString } from './types';

// Import core settings and capabilities from partitioned sub-modules
import { BUILTIN_PROVIDERS } from './providers/models/defaults';
import {
    VISION_CAPABLE_MODELS,
    isModelVisionCapable,
    FIM_CAPABLE_MODELS,
    isModelFIMCapable,
    ALWAYS_THINKING_PREFIXES,
    MODEL_CONTEXT_TOKENS,
    getModelContextTokens,
    getModelOutputTokens
} from './providers/models/capabilities';

// Re-export for external backward compatibility
export {
    BUILTIN_PROVIDERS,
    VISION_CAPABLE_MODELS,
    isModelVisionCapable,
    FIM_CAPABLE_MODELS,
    isModelFIMCapable,
    ALWAYS_THINKING_PREFIXES,
    MODEL_CONTEXT_TOKENS,
    getModelContextTokens,
    getModelOutputTokens
};

/**
 * Get a provider config by ID, falling back to OpenAI.
 */
export function getProvider(id: string): AIProviderConfig {
    if (id && !(id in BUILTIN_PROVIDERS)) {
        ErrorReporter.debug(SOURCE.AI_SERVICE, `Unknown provider "${id}", falling back to openai.`);
    }
     
    return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS['openai']!;
}

/**
 * Fetch available models from a running Ollama instance.
 * Queries GET /api/tags and returns model names with metadata.
 * Returns empty array if Ollama is not reachable.
 */
export async function fetchOllamaModels(
    endpoint?: string
): Promise<Array<{ name: string; size: string; parameterSize?: string }>> {
    // Ollama API root is at port 11434, not /v1
    const baseUrl = (endpoint || 'http://localhost:11434/v1')
        .replace(/\/v1\/?$/, '');

    try {
        const response = await fetch(`${baseUrl}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (!response.ok) return [];

        const data = await response.json() as {
            models?: Array<{
                name: string;
                size: number;
                details?: {
                    parameter_size?: string;
                    family?: string;
                };
            }>;
        };

        if (!data.models || data.models.length === 0) return [];

        return data.models.map(m => ({
            name: m.name,
            size: formatBytes(m.size),
            parameterSize: m.details?.parameter_size,
        }));
    } catch {
        return [];
    }
}

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
}

/**
 * Batch 4.4: Suggest optimal Ollama configuration based on detected models.
 * Analyzes model parameter sizes and names to recommend:
 * - Best model for agent/chat use (largest capable model)
 * - Best model for inline completion (fastest small model)
 * - Recommended context window size
 */
export interface OllamaModelSuggestion {
    /** Recommended model name for chat/agent use */
    chatModel: string;
    /** Recommended model for inline FIM completion (if available) */
    inlineModel?: string;
    /** Recommended context window size */
    contextTokens: number;
    /** Human-readable reasoning for the recommendation */
    reasoning: string;
}

export function suggestOllamaConfig(
    models: Array<{ name: string; size: string; parameterSize?: string }>
): OllamaModelSuggestion | null {
    if (!models.length) return null;

    // Parse parameter sizes to numeric values (e.g., "7B" → 7, "70B" → 70)
    const parsed = models.map(m => {
        let paramB = 0;
        if (m.parameterSize) {
            const match = m.parameterSize.match(/([\d.]+)\s*([BM])/i);
            if (match) {
                paramB = parseFloat(match[1]!);
                if (match[2]!.toUpperCase() === 'M') paramB /= 1000;
            }
        }
        // Fallback: infer from model name (e.g., "llama3:70b", "qwen2.5-coder:32b")
        if (paramB === 0) {
            const nameMatch = m.name.match(/(\d+)[bB]/);
            if (nameMatch) paramB = parseInt(nameMatch[1]!, 10);
        }
        return { ...m, paramB };
    }).sort((a, b) => b.paramB - a.paramB);

    // Identify coding-capable models (prefer those with 'coder', 'code', 'instruct' in name)
    const isCodingModel = (name: string) =>
        /coder|code|instruct|chat/i.test(name);

    // Chat model: largest available coding model, or largest overall
    const codingModels = parsed.filter(m => isCodingModel(m.name));
    const chatModel = codingModels.length > 0 ? codingModels[0]! : parsed[0]!;

    // Inline completion model: smallest model that supports FIM (prefer <14B for speed)
    const smallModels = parsed.filter(m => m.paramB > 0 && m.paramB <= 14);
    const fimCandidates = smallModels.filter(m =>
        /coder|code|deepseek|starcoder|codellama/i.test(m.name)
    );
    const inlineModel = fimCandidates.length > 0
        ? fimCandidates[fimCandidates.length - 1] // smallest FIM-capable
        : (smallModels.length > 0 ? smallModels[smallModels.length - 1] : undefined);

    // Context window: based on largest model's param count
    let contextTokens = 4096; // conservative default
    if (chatModel.paramB >= 70) contextTokens = 32768;
    else if (chatModel.paramB >= 30) contextTokens = 16384;
    else if (chatModel.paramB >= 13) contextTokens = 8192;
    else if (chatModel.paramB >= 7) contextTokens = 4096;

    // Build reasoning
    const parts: string[] = [];
    parts.push(`推荐 "${chatModel.name}" (${chatModel.parameterSize || chatModel.paramB + 'B'}) 作为对话模型`);
    if (inlineModel && inlineModel.name !== chatModel.name) {
        parts.push(`推荐 "${inlineModel.name}" 作为补全模型（较快）`);
    }
    parts.push(`建议上下文窗口: ${contextTokens} tokens`);
    if (chatModel.paramB < 7) {
        parts.push('⚠️ 模型较小，工具调用能力可能有限');
    }

    return {
        chatModel: chatModel.name,
        inlineModel: inlineModel?.name,
        contextTokens,
        reasoning: parts.join('。'),
    };
}

/**
 * Get the effective endpoint for a provider (user override takes precedence).
 */
export function getEffectiveEndpoint(providerId: string, userEndpoint?: string): string {
    if (userEndpoint && userEndpoint.trim().length > 0) {
        return userEndpoint.trim().replace(/\/+$/, '');
    }
    const provider = getProvider(providerId);
    return provider.endpoint;
}

/**
 * Get the effective model for a provider (user override takes precedence).
 */
export function getEffectiveModel(providerId: string, userModel?: string): string {
    if (userModel && userModel.trim().length > 0) {
        return userModel.trim();
    }
    const provider = getProvider(providerId);
    return provider.defaultModel;
}

// ─── Disable-Thinking Capability Descriptors ─────────────────────────────────

/**
 * Result of looking up how to disable thinking for a specific model.
 * `extraBody`    → merged into the request body (e.g. enable_thinking, thinking_config)
 * `injectPrompt` → if true, append "/no_think" to system prompt (Qwen fallback)
 */
export interface DisableThinkingResult {
    extraBody?: Record<string, unknown>;
    injectPrompt?: boolean;
}

/**
 * Data-driven table: model-name prefix → disable-thinking parameters.
 * Evaluated top-to-bottom; first match wins.
 * Add new providers here instead of editing aiService.ts if-else trees.
 */
const DISABLE_THINKING_PARAMS: Array<{
    match: (lowerModel: string) => boolean;
    result: DisableThinkingResult;
}> = [
    // ── Qwen: enable_thinking=false + /no_think prompt fallback ──
    {
        match: (m) => m.startsWith('qwen') && (
            m.includes('qwen3') || m.includes('qwen-max') || m.includes('qwen-turbo') || m.includes('qwen-long')
        ),
        result: { extraBody: { enable_thinking: false }, injectPrompt: true },
    },
    // ── GLM thinking models: thinking.type="disabled" ──
    {
        match: (m) => m.startsWith('glm-') && m.includes('thinking'),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    // ── Gemini 2.5 Flash: thinkingBudget=0 (fully disables thinking) ──
    {
        match: (m) => m.startsWith('gemini-2.5-flash'),
        result: { extraBody: { thinking_config: { thinking_budget: 0 } } },
    },
    // ── Gemini 3.x: thinkingLevel="minimal" (cannot fully disable, but minimizes) ──
    {
        match: (m) => m.startsWith('gemini-3'),
        result: { extraBody: { thinking_config: { thinking_level: 'minimal' } } },
    },
];

/**
 * Look up the disable-thinking parameters for a model.
 * Returns undefined if the model doesn't need any special handling.
 */
export function getDisableThinkingParams(model: string): DisableThinkingResult | undefined {
    const lower = model.toLowerCase();
    for (const entry of DISABLE_THINKING_PARAMS) {
        if (entry.match(lower)) return entry.result;
    }
    return undefined;
}

// ─── Claude API Adapter ──────────────────────────────────────────────────────

/**
 * Converts an OpenAI-format request to Claude Messages API format.
 * Claude uses a different structure for system prompts, tools, and responses.
 */
export function toClaudeRequest(request: ChatCompletionRequest): Record<string, unknown> {
    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => contentToString(m.content)).join('\n\n');

    // Convert non-system messages
    const claudeMessages: Array<Record<string, unknown>> = [];
    for (const msg of request.messages) {
        if (msg.role === 'system') continue;

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            // Assistant message with tool calls
            const content: Array<Record<string, unknown>> = [];
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            for (const tc of msg.tool_calls) {
                // Guard against malformed/truncated arguments from streaming
                let toolInput: unknown = {};
                try { toolInput = JSON.parse(tc.function.arguments); }
                catch { toolInput = {}; /* Degraded: empty args better than a crash */ }
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: toolInput,
                });
            }
            claudeMessages.push({ role: 'assistant', content });
        } else if (msg.role === 'tool') {
            // Tool result message
            claudeMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                }],
            });
        } else {
            // Text or multimodal user/assistant message
            const role = msg.role === 'user' ? 'user' : 'assistant';
            if (Array.isArray(msg.content)) {
                // Convert OpenAI ContentPart[] → Claude content blocks
                const claudeContent: Array<Record<string, unknown>> = [];
                for (const part of msg.content as ContentPart[]) {
                    if (part.type === 'text') {
                        claudeContent.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url') {
                        // Convert data URL to Claude's base64 source format.
                        const url = part.image_url.url;
                        const mediaMatch = url.match(/^data:(image\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=]+)/);
                        if (mediaMatch) {
                            claudeContent.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaMatch[1],
                                    data: mediaMatch[2],
                                },
                            });
                        }
                        // If URL is an HTTPS URL (not data:), pass as url type instead
                        else if (url.startsWith('http')) {
                            claudeContent.push({
                                type: 'image',
                                source: { type: 'url', url },
                            });
                        }
                    }
                }
                claudeMessages.push({ role, content: claudeContent });
            } else {
                claudeMessages.push({ role, content: msg.content ?? '' });
            }
        }
    }

    // Convert tools
    const claudeTools = request.tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));

    const claudeRequest: Record<string, unknown> = {
        model: request.model,
        system: systemPrompt || undefined,
        messages: claudeMessages,
        max_tokens: request.max_tokens ?? 4096,
    };
    if (claudeTools && claudeTools.length > 0) {
        claudeRequest.tools = claudeTools;
    }
    if (request.temperature !== undefined) {
        claudeRequest.temperature = request.temperature;
    }
    if (request.stream) {
        claudeRequest.stream = true;
    }

    return claudeRequest;
}
