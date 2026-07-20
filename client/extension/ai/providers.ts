/**
 * CWTools AI Module — Provider Definitions & Quick Configurations Facade
 */

import type { AIProviderConfig, ChatCompletionRequest, ContentPart, CustomApiFormat } from './types';
import { ErrorReporter } from './errorReporter';
import { SOURCE, aiText } from './messages';
import { contentToString } from './types';

// Import core settings and capabilities from partitioned sub-modules
import { BUILTIN_PROVIDERS } from './providers/models/defaults';
import {
    VISION_CAPABLE_MODELS,
    isModelVisionCapable,
    FIM_CAPABLE_MODELS,
    isModelFIMCapable,
    ALWAYS_THINKING_PREFIXES,
    OPENCODE_MODEL_LIMITS,
    OPENCODE_GO_MODEL_LIMITS,
    MODEL_CONTEXT_TOKENS,
    getModelContextTokens,
    getModelOutputTokens,
    getAnthropicModelFeatures
} from './providers/models/capabilities';

// Re-export for external backward compatibility
export {
    BUILTIN_PROVIDERS,
    VISION_CAPABLE_MODELS,
    isModelVisionCapable,
    FIM_CAPABLE_MODELS,
    isModelFIMCapable,
    ALWAYS_THINKING_PREFIXES,
    OPENCODE_MODEL_LIMITS,
    OPENCODE_GO_MODEL_LIMITS,
    MODEL_CONTEXT_TOKENS,
    getModelContextTokens,
    getModelOutputTokens,
    getAnthropicModelFeatures
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
    parts.push(aiText(
        `Recommended "${chatModel.name}" (${chatModel.parameterSize || chatModel.paramB + 'B'}) as the chat model`,
        `推荐 "${chatModel.name}" (${chatModel.parameterSize || chatModel.paramB + 'B'}) 作为对话模型`,
    ));
    if (inlineModel && inlineModel.name !== chatModel.name) {
        parts.push(aiText(
            `Recommended "${inlineModel.name}" as the inline completion model (faster)`,
            `推荐 "${inlineModel.name}" 作为补全模型（较快）`,
        ));
    }
    parts.push(aiText(`Suggested context window: ${contextTokens} tokens`, `建议上下文窗口: ${contextTokens} tokens`));
    if (chatModel.paramB < 7) {
        parts.push(aiText('Warning: this is a smaller model, so tool-calling ability may be limited', '⚠️ 模型较小，工具调用能力可能有限'));
    }

    return {
        chatModel: chatModel.name,
        inlineModel: inlineModel?.name,
        contextTokens,
        reasoning: parts.join(aiText('. ', '。')),
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

/** Apply provider-enforced sampling constraints while preserving normal user overrides. */
export function getEffectiveTemperature(model: string, requested?: number): number {
    const lower = model.toLowerCase();
    if (lower.includes('kimi-k2.7-code') || lower.includes('kimi-k3')
        || lower === 'k3' || lower.includes('kimi-for-coding')) return 1.0;
    return requested ?? 0.3;
}

/** OpenCode Zen exposes different wire protocols for each model family. */
export function getOpenCodeApiFormat(model: string): CustomApiFormat {
    const normalized = model.toLowerCase().replace(/\s*\([^)]*\)$/i, '');
    if (normalized.startsWith('gpt-')) return 'openai-responses';
    if (normalized.startsWith('claude-') || normalized.startsWith('qwen')) return 'anthropic-messages';
    if (normalized.startsWith('gemini-')) return 'gemini-generate-content';
    return 'openai-chat-completions';
}

/** OpenCode Go wire protocols: MiniMax and Qwen use Anthropic Messages, the rest use OpenAI chat completions. */
export function getOpenCodeGoApiFormat(model: string): CustomApiFormat {
    const normalized = model.toLowerCase().replace(/\s*\([^)]*\)$/i, '');
    if (normalized.startsWith('minimax-') || normalized.startsWith('qwen')) return 'anthropic-messages';
    return 'openai-chat-completions';
}

/**
 * Resolve the wire protocol for every built-in provider from one source of truth.
 * Custom channels keep the protocol selected by the user, while gateway providers
 * may choose a protocol per model family.
 */
export function getProviderApiFormat(
    providerId: string,
    model: string,
    customApiFormat: CustomApiFormat = 'openai-chat-completions'
): CustomApiFormat {
    switch (providerId.toLowerCase()) {
        case 'openai':
        case 'codex-chatgpt':
            return 'openai-responses';
        case 'claude':
        case 'minimax-token-plan':
            return 'anthropic-messages';
        case 'opencode':
            return getOpenCodeApiFormat(model);
        case 'opencode-go':
            return getOpenCodeGoApiFormat(model);
        case 'custom':
            return customApiFormat;
        default:
            return 'openai-chat-completions';
    }
}

/** Keep protocol-specific reasoning values inside the model's accepted enum. */
export function getEffectiveReasoningEffort(
    model: string,
    requested: ChatCompletionRequest['reasoning_effort'],
    apiFormat: CustomApiFormat
): ChatCompletionRequest['reasoning_effort'] {
    if (apiFormat !== 'openai-responses' || requested !== 'max') return requested;
    const modelId = model.toLowerCase().split('/').pop() ?? '';
    return /^gpt-5\.6(?:-|$)/.test(modelId) ? 'max' : 'high';
}

// ─── Disable-Thinking Capability Descriptors ─────────────────────────────────

/**
 * Result of looking up how to disable thinking for a specific model.
 * `extraBody`    → merged into the request body (e.g. enable_thinking, thinking_config)
 * `injectPrompt` → if true, append "/no_think" to system prompt (Qwen fallback)
 * `reasoningEffort` → use the lowest supported reasoning effort when full disable is unavailable
 */
export interface DisableThinkingResult {
    extraBody?: Record<string, unknown>;
    injectPrompt?: boolean;
    reasoningEffort?: ChatCompletionRequest['reasoning_effort'];
}

export interface EnableThinkingResult {
    extraBody?: Record<string, unknown>;
    reasoningEffort?: ChatCompletionRequest['reasoning_effort'];
}

type ReasoningEffort = NonNullable<ChatCompletionRequest['reasoning_effort']>;

const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
    low: 2048,
    medium: 8192,
    high: 32768,
    max: 81920,
};

function modelName(model: string): string {
    return model.toLowerCase().replace(/\s*\([^)]*\)$/i, '');
}

function isQwenThinkingModel(model: string): boolean {
    return /(?:^|\/)qwen3(?:[.-]|$)/.test(model)
        || /(?:^|\/)qwen(?:-max|-plus|-flash|-turbo|-long)(?:[-.]|$)/.test(model);
}

function isKnownReasoningModel(model: string): boolean {
    return /(?:^|\/)(?:gpt-5|o[134](?:-|$)|claude-|deepseek-(?:r1|v3|v4|reasoner)|glm-(?:4[.]?[5-9]|5)|qwen3|qwq|gemini-(?:2[.]5|3)|kimi-k2|kimi-k3|minimax-m2|minimax-m3|mimo-v2|gpt-oss)/.test(model);
}

function budgetFor(effort: ReasoningEffort, maximum = THINKING_BUDGETS.max): number {
    return Math.min(THINKING_BUDGETS[effort], maximum);
}

function withoutMax(effort: ReasoningEffort): ReasoningEffort {
    return effort === 'max' ? 'high' : effort;
}

function deepSeekV4Effort(effort: ReasoningEffort): ReasoningEffort {
    return effort === 'low' || effort === 'medium' ? 'high' : effort;
}

function kimiK3Effort(effort: ReasoningEffort): ReasoningEffort {
    return effort === 'medium' ? 'high' : effort;
}

function qwenThinkingMaximum(model: string): number {
    return /qwen3[.]7-(?:max|plus)/.test(model) ? 262144 : 81920;
}

function qwenBudgetFor(model: string, effort: ReasoningEffort): number {
    if (/qwen3[.]7-(?:max|plus)/.test(model)) {
        return effort === 'low' ? 2048
            : effort === 'medium' ? 8192
                : effort === 'high' ? 81920
                    : 262144;
    }
    return budgetFor(effort, qwenThinkingMaximum(model));
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
    {
        match: (m) => /(?:^|\/)deepseek-v4(?:-|$)/.test(m),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    {
        match: (m) => /(?:^|\/)kimi-k2[.](?:5|6)(?:-|$)/.test(m),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    {
        match: (m) => /(?:^|\/)(?:mimo-v2[.]5|minimax-m3)(?:-|$)/.test(m),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    // Claude Sonnet 5 thinks by default and requires an explicit disable switch.
    {
        match: (m) => /(?:^|\/)claude-sonnet-5(?:-|$)/.test(m),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    // Fable 5 always uses adaptive thinking; low effort is the closest fast path.
    {
        match: (m) => /(?:^|\/)claude-fable-5(?:-|$)/.test(m),
        result: { reasoningEffort: 'low' },
    },
    // ── Qwen: enable_thinking=false + /no_think prompt fallback ──
    {
        match: (m) => m.startsWith('qwen') && (
            m.includes('qwen3') || m.includes('qwen-max') || m.includes('qwen-turbo') || m.includes('qwen-long')
        ),
        result: { extraBody: { enable_thinking: false }, injectPrompt: true },
    },
    // GLM 4.5+ hybrid models use the same explicit thinking switch.
    {
        match: (m) => /(?:^|\/)glm-(?:4[.]?[5-9]|5)(?:[-.]|$)/.test(m),
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

/**
 * Resolve the lowest-thinking request shape for a concrete provider call.
 * Model-specific hard disables win; provider fallbacks only lower effort for
 * APIs where that does not turn thinking back on.
 */
export function getReducedThinkingParams(
    model: string,
    providerId?: string,
    apiFormat?: CustomApiFormat
): DisableThinkingResult | undefined {
    const modelParams = getDisableThinkingParams(model);
    if (modelParams) return modelParams;

    const lowerProvider = providerId?.toLowerCase() ?? '';
    const lowerModel = modelName(model);
    if ((lowerProvider === 'kimi' || lowerProvider === 'kimi-code-plan')
        && /(?:^|\/)(?:kimi-)?k3(?:-|$)/.test(lowerModel)) {
        return { reasoningEffort: 'low' };
    }
    if (lowerProvider === 'openai' || lowerProvider === 'deepseek' || apiFormat === 'openai-responses') {
        return { reasoningEffort: 'low' };
    }

    return undefined;
}

/**
 * Look up provider-specific parameters for explicitly enabling thinking.
 */
export function getEnableThinkingParams(model: string, providerId?: string): EnableThinkingResult | undefined {
    const lowerModel = model.toLowerCase();
    const lowerProvider = providerId?.toLowerCase() ?? '';
    if (
        lowerProvider === 'mimo' ||
        lowerProvider === 'mimo-token-plan' ||
        lowerProvider.includes('mimo') ||
        lowerModel.startsWith('mimo-v2')
    ) {
        return { extraBody: { thinking: { type: 'enabled' } } };
    }
    if ((lowerProvider === 'kimi' || lowerProvider === 'kimi-code-plan'
        || lowerProvider === 'opencode' || lowerProvider === 'opencode-go')
        && /(?:^|\/)kimi-k2[.](?:5|6)(?:-|$)/.test(lowerModel)) {
        return { extraBody: { thinking: { type: 'enabled' } } };
    }
    return undefined;
}

/**
 * Translate the common UI effort into the request shape accepted by a provider/model pair.
 * Providers that expose only an on/off switch deliberately do not pretend to support levels.
 */
export function getThinkingParams(
    model: string,
    providerId: string | undefined,
    apiFormat: CustomApiFormat,
    requested: ReasoningEffort
): EnableThinkingResult | undefined {
    const lowerModel = modelName(model);
    const lowerProvider = providerId?.toLowerCase() ?? '';

    if (apiFormat === 'openai-responses') {
        return { reasoningEffort: getEffectiveReasoningEffort(model, requested, apiFormat) };
    }

    // OpenRouter normalizes request shapes, while the upstream model still defines
    // whether an effort selector exists and which values are meaningful.
    if (lowerProvider === 'openrouter' && isKnownReasoningModel(lowerModel)) {
        if (/(?:^|\/)(?:moonshotai\/kimi-k2|minimax\/minimax-m[23])/.test(lowerModel)) {
            return { extraBody: { reasoning: { enabled: true } } };
        }
        if (/deepseek-v4|glm-5[.]2/.test(lowerModel)) {
            return { extraBody: { reasoning: { effort: deepSeekV4Effort(requested) } } };
        }
        if (/(?:^|\/)moonshotai\/kimi-k3(?:-|$)/.test(lowerModel)) {
            return { extraBody: { reasoning: { effort: kimiK3Effort(requested) } } };
        }
        return { extraBody: { reasoning: { effort: requested } } };
    }

    if ((lowerProvider === 'kimi' || lowerProvider === 'kimi-code-plan')
        && /(?:^|\/)(?:kimi-)?k3(?:-|$)/.test(lowerModel)) {
        return { reasoningEffort: kimiK3Effort(requested) };
    }

    // MiniMax M3 exposes adaptive on/off control, but no named effort levels.
    if ((lowerProvider === 'minimax' || lowerProvider === 'minimax-token-plan'
        || lowerProvider === 'opencode' || lowerProvider === 'opencode-go')
        && /(?:^|\/)minimax-m3(?:-|$)/.test(lowerModel)) {
        return { extraBody: { thinking: { type: 'adaptive' } } };
    }

    if (apiFormat === 'anthropic-messages') {
        if (lowerModel.includes('claude-')) {
            const features = getAnthropicModelFeatures(lowerModel);
            return features.effort
                ? { reasoningEffort: requested }
                : { extraBody: { thinking_budget: budgetFor(requested, 64000) } };
        }
        if (isQwenThinkingModel(lowerModel)) {
            return { extraBody: { thinking_budget: qwenBudgetFor(lowerModel, requested) } };
        }
        return getEnableThinkingParams(model, providerId);
    }

    if ((lowerProvider === 'google' || apiFormat === 'gemini-generate-content') && lowerModel.includes('gemini-3')) {
        const thinkingLevel = withoutMax(requested);
        return apiFormat === 'gemini-generate-content'
            ? { extraBody: { thinking_config: { thinking_level: thinkingLevel } } }
            : { extraBody: { google: { thinking_config: { thinking_level: thinkingLevel } } } };
    }

    if ((lowerProvider === 'google' || apiFormat === 'gemini-generate-content') && lowerModel.includes('gemini-2.5')) {
        const thinkingBudget = requested === 'low' ? 1024
            : requested === 'medium' ? 8192
                : 24576;
        return apiFormat === 'gemini-generate-content'
            ? { extraBody: { thinking_config: { thinking_budget: thinkingBudget } } }
            : { extraBody: { google: { thinking_config: { thinking_budget: thinkingBudget } } } };
    }

    if (lowerProvider === 'qwen' && isQwenThinkingModel(lowerModel)) {
        return {
            extraBody: {
                enable_thinking: true,
                thinking_budget: qwenBudgetFor(lowerModel, requested),
            },
        };
    }

    if (lowerProvider === 'siliconflow' && isKnownReasoningModel(lowerModel)) {
        const thinkingBudget = requested === 'low' ? 2048
            : requested === 'medium' ? 8192
                : requested === 'high' ? 16384
                    : 32768;
        return {
            extraBody: {
                enable_thinking: true,
                thinking_budget: thinkingBudget,
            },
        };
    }

    if ((lowerProvider === 'glm' || lowerProvider === 'opencode' || lowerProvider === 'opencode-go')
        && /(?:^|\/)glm-5[.]2(?:-|$)/.test(lowerModel)) {
        return {
            extraBody: { thinking: { type: 'enabled' } },
            reasoningEffort: deepSeekV4Effort(requested),
        };
    }

    if ((lowerProvider === 'glm' || lowerProvider === 'opencode' || lowerProvider === 'opencode-go')
        && /(?:^|\/)glm-(?:4[.]?[5-9]|5)(?:[-.]|$)/.test(lowerModel)) {
        return { extraBody: { thinking: { type: 'enabled' } } };
    }

    if ((lowerProvider === 'deepseek' || lowerProvider === 'opencode' || lowerProvider === 'opencode-go')
        && /deepseek-v4/.test(lowerModel)) {
        return {
            extraBody: { thinking: { type: 'enabled' } },
            reasoningEffort: deepSeekV4Effort(requested),
        };
    }

    if (lowerProvider === 'together') {
        if (/deepseek-(?:ai\/)?deepseek-v4|deepseek-v4/.test(lowerModel)) {
            return { reasoningEffort: deepSeekV4Effort(requested) };
        }
        if (isKnownReasoningModel(lowerModel)) return { extraBody: { reasoning: { enabled: true } } };
    }

    if (lowerProvider === 'deepinfra' && isKnownReasoningModel(lowerModel)) {
        return { reasoningEffort: withoutMax(requested) };
    }

    if (lowerProvider === 'ollama') {
        return { reasoningEffort: withoutMax(requested) };
    }

    // Custom OpenAI-compatible endpoints can still benefit from well-known model conventions.
    if (lowerProvider === 'custom') {
        if (isQwenThinkingModel(lowerModel)) {
            return {
                extraBody: {
                    enable_thinking: true,
                    thinking_budget: qwenBudgetFor(lowerModel, requested),
                },
            };
        }
        if (/(?:^|\/)(?:gpt-5|o[134](?:-|$)|deepseek-|glm-5[.]2|gpt-oss)/.test(lowerModel)) {
            return { reasoningEffort: withoutMax(requested) };
        }
    }

    return getEnableThinkingParams(model, providerId);
}

// ─── Claude API Adapter ──────────────────────────────────────────────────────

function toClaudeContentBlocks(content: ContentPart[]): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const part of content) {
        if (part.type === 'text') {
            if (part.text) blocks.push({ type: 'text', text: part.text });
            continue;
        }
        const url = part.image_url.url;
        const mediaMatch = url.match(/^data:(image\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=]+)/);
        if (mediaMatch) {
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaMatch[1],
                    data: mediaMatch[2],
                },
            });
        } else if (/^https?:\/\//i.test(url)) {
            blocks.push({
                type: 'image',
                source: { type: 'url', url },
            });
        }
    }
    return blocks;
}

/**
 * Converts an OpenAI-format request to Claude Messages API format.
 * Claude uses a different structure for system prompts, tools, and responses.
 */
export function toClaudeRequest(
    request: ChatCompletionRequest,
    options: { cacheControl?: boolean } = {}
): Record<string, unknown> {
    const enableCacheControl = options.cacheControl !== false;
    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => contentToString(m.content)).join('\n\n');

    // Convert non-system messages
    const claudeMessages: Array<Record<string, any>> = [];
    for (const msg of request.messages) {
        if (msg.role === 'system') continue;

        if (msg.role === 'assistant' && (
            (msg.tool_calls && msg.tool_calls.length > 0)
            || (msg.anthropic_thinking_blocks && msg.anthropic_thinking_blocks.length > 0)
        )) {
            // Thinking blocks must be replayed byte-for-byte before tool_use blocks.
            // Anthropic rejects the tool continuation when their signatures are lost.
            const content: Array<Record<string, unknown>> = [];
            for (const block of msg.anthropic_thinking_blocks ?? []) {
                if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                    content.push(JSON.parse(JSON.stringify(block)) as Record<string, unknown>);
                }
            }
            if (Array.isArray(msg.content)) {
                content.push(...toClaudeContentBlocks(msg.content));
            } else if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            for (const tc of msg.tool_calls ?? []) {
                let toolInput: unknown;
                try {
                    toolInput = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    throw new Error(`Cannot replay Anthropic tool call '${tc.function.name}' (${tc.id}): arguments are not valid JSON.`);
                }
                if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
                    throw new Error(`Cannot replay Anthropic tool call '${tc.function.name}' (${tc.id}): arguments must be a JSON object.`);
                }
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: toolInput,
                });
            }
            claudeMessages.push({ role: 'assistant', content });
        } else if (msg.role === 'tool') {
            // Anthropic expects parallel tool results in one user turn.
            const toolResult = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: contentToString(msg.content),
            };
            const previous = claudeMessages[claudeMessages.length - 1];
            const canAppend = previous?.role === 'user'
                && Array.isArray(previous.content)
                && previous.content.every((part: any) => part?.type === 'tool_result');
            if (canAppend) previous.content.push(toolResult);
            else claudeMessages.push({ role: 'user', content: [toolResult] });
        } else {
            // Text or multimodal user/assistant message
            const role = msg.role === 'user' ? 'user' : 'assistant';
            if (Array.isArray(msg.content)) {
                // Convert OpenAI ContentPart[] → Claude content blocks
                const claudeContent = toClaudeContentBlocks(msg.content as ContentPart[]);
                claudeMessages.push({ role, content: claudeContent });
            } else {
                claudeMessages.push({ role, content: msg.content ?? '' });
            }
        }
    }

    // 🌟 自动注入 Anthropic cache_control 断点 (T3.1)
    // breakpoint 1: System prompt 末尾
    let claudeSystem: any = undefined;
    if (systemPrompt) {
        claudeSystem = enableCacheControl
            ? [
                {
                    type: 'text',
                    text: systemPrompt,
                    cache_control: { type: 'ephemeral' }
                }
            ]
            : systemPrompt;
    }

    // Convert tools
    const claudeTools = request.tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
        cache_control: undefined as any
    }));

    // breakpoint 2: 最后一个 tool 定义上打 breakpoint
    if (enableCacheControl && claudeTools && claudeTools.length > 0) {
        const lastTool = claudeTools[claudeTools.length - 1];
        if (lastTool) {
            lastTool.cache_control = { type: 'ephemeral' };
        }
    }

    // breakpoint 3: 寻找第一个包含 Context Recovery 或 system-reminder 的 user 消息
    let recoveryIdx = -1;
    if (enableCacheControl) {
        for (let i = 0; i < claudeMessages.length; i++) {
            const m = claudeMessages[i];
            if (m && m.role === 'user') {
                const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (txt.includes('[Context Recovery]') || txt.includes('<system-reminder>')) {
                    recoveryIdx = i;
                    if (typeof m.content === 'string') {
                        m.content = [
                            {
                                type: 'text',
                                text: m.content,
                                cache_control: { type: 'ephemeral' }
                            }
                        ];
                    } else if (Array.isArray(m.content) && m.content.length > 0) {
                        const lastContentPart = m.content[m.content.length - 1];
                        if (lastContentPart) {
                            lastContentPart.cache_control = { type: 'ephemeral' };
                        }
                    }
                    break; // 只打第一个
                }
            }
        }
    }

    // breakpoint 4: 滚动历史前缀。在 claudeMessages 倒数第二条 user 消息（非最新 user 消息）上打 breakpoint
    if (enableCacheControl) {
        let userCount = 0;
        for (let i = claudeMessages.length - 1; i >= 0; i--) {
            const m = claudeMessages[i];
            if (m && m.role === 'user') {
                userCount++;
                // 倒数第二条 user 消息，且其索引必须大于 recoveryIdx（避免与 breakpoint 3 碰撞）
                if (userCount === 2 && i > recoveryIdx) {
                    if (typeof m.content === 'string') {
                        m.content = [
                            {
                                type: 'text',
                                text: m.content,
                                cache_control: { type: 'ephemeral' }
                            }
                        ];
                    } else if (Array.isArray(m.content) && m.content.length > 0) {
                        const lastContentPart = m.content[m.content.length - 1];
                        if (lastContentPart) {
                            lastContentPart.cache_control = { type: 'ephemeral' };
                        }
                    }
                    break;
                }
            }
        }
    }

    const claudeRequest: Record<string, unknown> = {
        model: request.model,
        system: claudeSystem,
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

    // Model-gated request shaping for newer Anthropic models (Fable 5 / Opus 4.x / Sonnet 4.6).
    // reasoning_effort doubles as the "thinking wanted" signal: aiService only sets it
    // when the call is not thinking-disabled (e.g. inline completion stays fast).
    const anthropicFeatures = getAnthropicModelFeatures(request.model);
    if (anthropicFeatures.samplingRemoved) {
        // temperature/top_p/top_k return HTTP 400 on Fable 5 / Opus 4.7+
        delete claudeRequest.temperature;
    }
    if (request.thinking?.type === 'disabled') {
        claudeRequest.thinking = { type: 'disabled' };
    }
    if (!anthropicFeatures.effort && request.thinking?.type === 'adaptive') {
        // Anthropic-compatible non-Claude gateways (currently MiniMax M3).
        claudeRequest.thinking = { type: 'adaptive' };
        delete claudeRequest.temperature;
    }
    if (request.reasoning_effort) {
        if (anthropicFeatures.effort) {
            claudeRequest.output_config = { effort: request.reasoning_effort };
        }
        if (anthropicFeatures.adaptiveThinking) {
            // display: 'summarized' restores thinking text on models that omit it by default
            claudeRequest.thinking = anthropicFeatures.thinkingDisplay
                ? { type: 'adaptive', display: 'summarized' }
                : { type: 'adaptive' };
            // Anthropic rejects sampling params alongside thinking
            delete claudeRequest.temperature;
        }
    } else if (typeof request.thinking_budget === 'number' && request.thinking_budget >= 1024) {
        // Anthropic-compatible gateways use the standard manual thinking budget
        // for non-Claude thinking models such as Qwen.
        claudeRequest.thinking = {
            type: 'enabled',
            budget_tokens: Math.min(request.thinking_budget, Math.max(1024, (request.max_tokens ?? 4096) - 1)),
        };
        delete claudeRequest.temperature;
    }

    return claudeRequest;
}
