/**
 * CWTools AI Module — Provider Definitions & Quick Configurations Facade
 */

import type {
    AIProviderConfig,
    ChatCompletionRequest,
    ContentPart,
    CustomApiFormat,
    ModelReasoningCapability,
    ReasoningEffort,
} from './types';
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
    return 'xhigh';
}

const NO_REASONING: ModelReasoningCapability = {
    kind: 'none',
    options: [],
    defaultValue: 'high',
};

function reasoningCapability(
    kind: ModelReasoningCapability['kind'],
    options: ReasoningEffort[],
    defaultValue: ReasoningEffort
): ModelReasoningCapability {
    return { kind, options, defaultValue };
}

function openAiReasoningCapability(model: string): ModelReasoningCapability {
    const modelId = modelName(model).split('/').pop() ?? '';
    if (!/^(?:gpt-5|o[134](?:-|$))/.test(modelId)) return NO_REASONING;
    if (/-pro(?:-|$)/.test(modelId)) return reasoningCapability('fixed', ['high'], 'high');
    const version = modelId.match(/^gpt-5(?:[.-](\d+))?/);
    const minor = version?.[1] ? Number(version[1]) : 0;
    if (minor >= 2) {
        return reasoningCapability('effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], 'high');
    }
    if (minor === 1) {
        return reasoningCapability('effort', ['none', 'low', 'medium', 'high'], 'high');
    }
    return reasoningCapability('effort', ['minimal', 'low', 'medium', 'high'], 'medium');
}

function claudeReasoningCapability(model: string): ModelReasoningCapability {
    const lower = modelName(model);
    const features = getAnthropicModelFeatures(lower);
    if (features.effort) {
        const supportsMax = /claude-(?:fable-5|sonnet-5|opus-(?:4[.-][6-9]|[5-9]))/.test(lower);
        const supportsXHigh = /claude-(?:fable-5|sonnet-5|opus-(?:4[.-][78]|[5-9]))/.test(lower);
        const canDisable = !/claude-fable-5/.test(lower);
        return reasoningCapability('effort', [
            ...(canDisable ? ['none' as const] : []),
            'low',
            'medium',
            'high',
            ...(supportsXHigh ? ['xhigh' as const] : []),
            ...(supportsMax ? ['max' as const] : []),
        ], 'high');
    }
    if (/claude-(?:haiku-4[.-]5|opus-4[.-][0-4]|sonnet-4[.-][0-5])/.test(lower)) {
        return reasoningCapability('budget', ['none', 'low', 'medium', 'high', 'max'], 'high');
    }
    return NO_REASONING;
}

function geminiReasoningCapability(model: string): ModelReasoningCapability {
    const lower = modelName(model);
    if (/gemini-3[.]1-pro/.test(lower)) {
        return reasoningCapability('effort', ['low', 'medium', 'high'], 'high');
    }
    if (/gemini-(?:3[.]5-flash|3(?:[.-]|$)|3[.]1-flash-lite)/.test(lower)) {
        return reasoningCapability('effort', ['minimal', 'low', 'medium', 'high'], 'medium');
    }
    if (/gemini-2[.]5-pro/.test(lower)) {
        return reasoningCapability('budget', ['low', 'medium', 'high'], 'high');
    }
    if (/gemini-2[.]5-flash(?:-lite)?/.test(lower)) {
        return reasoningCapability('budget', ['none', 'low', 'medium', 'high'], lower.includes('flash-lite') ? 'none' : 'high');
    }
    return NO_REASONING;
}

function upstreamGatewayCapability(providerId: string, model: string): ModelReasoningCapability | undefined {
    const lower = modelName(model);
    if (lower.includes('openai/') || /(?:^|\/)(?:gpt-5|o[134](?:-|$))/.test(lower)) {
        return openAiReasoningCapability(lower);
    }
    if (lower.includes('anthropic/') || lower.includes('claude-')) {
        return claudeReasoningCapability(lower);
    }
    if (lower.includes('google/') || lower.includes('gemini-')) {
        return geminiReasoningCapability(lower);
    }
    if (lower.includes('qwen')) {
        return reasoningCapability('budget', ['none', 'minimal', 'low', 'medium', 'high', 'max'], 'high');
    }
    if (/deepseek-v4/.test(lower)) {
        return reasoningCapability('effort', ['none', 'high', 'max'], 'high');
    }
    if (/glm-5[.]2/.test(lower)) {
        return reasoningCapability('effort', ['none', 'high', 'max'], 'max');
    }
    if (/glm-(?:4[.]?[5-9]|5)/.test(lower)) {
        return reasoningCapability('toggle', ['none', 'high'], 'high');
    }
    if (/(?:^|\/)(?:kimi-)?k3(?:-|$)/.test(lower)) {
        return reasoningCapability('effort', ['low', 'high', 'max'], 'high');
    }
    if (/kimi-k2[.](?:5|6)/.test(lower)) {
        return reasoningCapability('toggle', ['none', 'high'], 'high');
    }
    if (/kimi-k2[.]7-code/.test(lower)) {
        return reasoningCapability('fixed', ['high'], 'high');
    }
    if (/minimax-m3/.test(lower)) {
        return reasoningCapability('toggle', ['none', 'high'], 'high');
    }
    if (/minimax-m2/.test(lower)) {
        return reasoningCapability('fixed', ['high'], 'high');
    }
    if (/mimo-v2[.]5/.test(lower)) {
        return reasoningCapability('toggle', ['none', 'high'], 'high');
    }
    if (/gpt-oss/.test(lower)) {
        return reasoningCapability('effort', ['low', 'medium', 'high'], 'medium');
    }
    return undefined;
}

/**
 * Resolve the exact reasoning control exposed for a provider/model pair.
 * Unknown models are deliberately treated as having no control so custom and
 * dynamically discovered endpoints never receive guessed parameters.
 */
export function getModelReasoningCapability(
    providerId: string,
    model: string,
    apiFormat: CustomApiFormat = getProviderApiFormat(providerId, model)
): ModelReasoningCapability {
    const provider = providerId.toLowerCase();
    const lower = modelName(model);

    if (!model) return NO_REASONING;
    if (provider === 'github') return NO_REASONING;

    if (provider === 'openrouter') {
        return upstreamGatewayCapability(provider, lower) ?? NO_REASONING;
    }
    if (provider === 'deepinfra') {
        return isKnownReasoningModel(lower)
            ? reasoningCapability('effort', ['none', 'low', 'medium', 'high'], 'high')
            : NO_REASONING;
    }
    if (provider === 'together') {
        if (/deepseek-v4/.test(lower)) return reasoningCapability('effort', ['none', 'high', 'max'], 'high');
        if (/gpt-oss/.test(lower)) return reasoningCapability('effort', ['low', 'medium', 'high'], 'medium');
        if (isKnownReasoningModel(lower)) return reasoningCapability('toggle', ['none', 'high'], 'high');
        return NO_REASONING;
    }
    if (provider === 'ollama') {
        if (/gpt-oss/.test(lower)) return reasoningCapability('effort', ['low', 'medium', 'high'], 'medium');
        if (/(?:qwen3|deepseek-(?:r1|v3)|qwq)/.test(lower)) {
            return reasoningCapability('toggle', ['none', 'high'], 'high');
        }
        return NO_REASONING;
    }
    if (provider === 'custom') {
        return upstreamGatewayCapability(provider, lower) ?? NO_REASONING;
    }
    if (provider === 'openai' || provider === 'codex-chatgpt'
        || (apiFormat === 'openai-responses' && /(?:^|\/)(?:gpt-5|o[134](?:-|$))/.test(lower))) {
        return openAiReasoningCapability(lower);
    }
    if (provider === 'claude') return claudeReasoningCapability(lower);
    if (provider === 'google') return geminiReasoningCapability(lower);
    if (provider === 'deepseek') return /deepseek-v4/.test(lower)
        ? reasoningCapability('effort', ['none', 'high', 'max'], 'high')
        : reasoningCapability('fixed', ['high'], 'high');
    if (provider === 'glm') {
        if (/glm-5[.]2/.test(lower)) return reasoningCapability('effort', ['none', 'high', 'max'], 'max');
        if (/glm-(?:4[.]?[5-9]|5)/.test(lower)) return reasoningCapability('toggle', ['none', 'high'], 'high');
        return NO_REASONING;
    }
    if (provider === 'qwen') return isQwenThinkingModel(lower)
        ? reasoningCapability('budget', ['none', 'minimal', 'low', 'medium', 'high', 'max'], 'high')
        : NO_REASONING;
    if (provider === 'siliconflow') return isKnownReasoningModel(lower)
        ? reasoningCapability('budget', ['none', 'low', 'medium', 'high', 'max'], 'high')
        : NO_REASONING;
    if (provider === 'mimo' || provider === 'mimo-token-plan') return /mimo-v2[.]5/.test(lower)
        ? reasoningCapability('toggle', ['none', 'high'], 'high')
        : NO_REASONING;
    if (provider === 'minimax' || provider === 'minimax-token-plan') {
        if (/minimax-m3/.test(lower)) return reasoningCapability('toggle', ['none', 'high'], 'high');
        if (/minimax-m2/.test(lower)) return reasoningCapability('fixed', ['high'], 'high');
        return NO_REASONING;
    }
    if (provider === 'kimi' || provider === 'kimi-code-plan') {
        if (/(?:^|\/)(?:kimi-)?k3(?:-|$)/.test(lower)) {
            return reasoningCapability('effort', ['low', 'high', 'max'], 'high');
        }
        if (/kimi-k2[.](?:5|6)/.test(lower)) return reasoningCapability('toggle', ['none', 'high'], 'high');
        if (/kimi-(?:for-coding|k2[.]7-code)/.test(lower)) return reasoningCapability('fixed', ['high'], 'high');
        return NO_REASONING;
    }
    if (provider === 'opencode' || provider === 'opencode-go') {
        return upstreamGatewayCapability(provider, lower) ?? NO_REASONING;
    }
    return NO_REASONING;
}

/** Narrow live model-catalog metadata such as OpenRouter's `reasoning` object. */
export function parseAdvertisedReasoningCapability(value: unknown): ModelReasoningCapability | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const allowed = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const advertisesAllEfforts = raw.supported_efforts === null;
    const efforts = advertisesAllEfforts
        ? Array.from(allowed)
        : Array.isArray(raw.supported_efforts)
        ? raw.supported_efforts.filter((item): item is ReasoningEffort => typeof item === 'string' && allowed.has(item as ReasoningEffort))
        : [];
    const mandatory = raw.mandatory === true;
    const supportsBudget = raw.supports_max_tokens === true;
    const defaultEffort = typeof raw.default_effort === 'string' && allowed.has(raw.default_effort as ReasoningEffort)
        ? raw.default_effort as ReasoningEffort
        : efforts.includes('high') ? 'high' : efforts[0];
    if (efforts.length > 0 || supportsBudget) {
        const enabledOptions = efforts.length > 0 ? efforts : ['low', 'medium', 'high', 'max'] satisfies ReasoningEffort[];
        const options = mandatory
            ? enabledOptions.filter(item => item !== 'none')
            : Array.from(new Set<ReasoningEffort>(['none', ...enabledOptions]));
        if (options.length === 0) return reasoningCapability('fixed', ['high'], 'high');
        const enabledDefault = defaultEffort
            ?? (enabledOptions.includes('high') ? 'high' : enabledOptions[0]);
        const defaultValue = !mandatory && (raw.default_enabled === false || defaultEffort === 'none')
            ? 'none'
            : enabledDefault && options.includes(enabledDefault) ? enabledDefault : options[0]!;
        const enabledCount = options.filter(item => item !== 'none').length;
        return reasoningCapability(
            supportsBudget ? 'budget' : enabledCount === 1 ? (mandatory ? 'fixed' : 'toggle') : 'effort',
            options,
            defaultValue
        );
    }
    if (typeof raw.default_enabled === 'boolean') {
        return reasoningCapability('toggle', ['none', 'high'], raw.default_enabled ? 'high' : 'none');
    }
    return undefined;
}

export function normalizeReasoningEffort(
    capability: ModelReasoningCapability,
    requested: ReasoningEffort | undefined
): ReasoningEffort {
    if (requested && capability.options.includes(requested)) return requested;
    if (requested === 'max' || requested === 'xhigh') {
        if (capability.options.includes('max')) return 'max';
        if (capability.options.includes('xhigh')) return 'xhigh';
        if (capability.options.includes('high')) return 'high';
    }
    if ((requested === 'minimal' || requested === 'low') && capability.options.includes('low')) return 'low';
    if (requested === 'medium' && capability.options.includes('high') && !capability.options.includes('medium')) return 'high';
    return capability.options.includes(capability.defaultValue)
        ? capability.defaultValue
        : capability.options[0] ?? 'high';
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

const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
    none: 0,
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 32768,
    xhigh: 65536,
    max: 81920,
};

function modelName(model: string): string {
    return model.toLowerCase().replace(/\s*\([^)]*\)$/i, '');
}

const QWEN_THINKING_MODEL_RE = /(?:^|\/)qwen3(?:[.-]|$)|(?:^|\/)qwen(?:-max|-plus|-flash|-turbo|-long)(?:[-.]|$)/;

const KNOWN_REASONING_MODEL_RE = /(?:^|\/)(?:gpt-5|o[134](?:-|$)|claude-|deepseek-(?:r1|v3|v4|reasoner)|glm-(?:4[.]?[5-9]|5)|qwen3|qwq|gemini-(?:2[.]5|3)|kimi-k2|kimi-k3|minimax-m2|minimax-m3|mimo-v2|gpt-oss)/;

function isQwenThinkingModel(model: string): boolean {
    return QWEN_THINKING_MODEL_RE.test(model);
}

function isKnownReasoningModel(model: string): boolean {
    return KNOWN_REASONING_MODEL_RE.test(model);
}

function budgetFor(effort: ReasoningEffort, maximum = THINKING_BUDGETS.max): number {
    return Math.min(THINKING_BUDGETS[effort], maximum);
}

function withoutMax(effort: ReasoningEffort): ReasoningEffort {
    return effort === 'max' || effort === 'xhigh' ? 'high' : effort;
}

function deepSeekV4Effort(effort: ReasoningEffort): ReasoningEffort {
    return effort === 'max' || effort === 'xhigh' ? 'max' : 'high';
}

function kimiK3Effort(effort: ReasoningEffort): ReasoningEffort {
    if (effort === 'max' || effort === 'xhigh') return 'max';
    return effort === 'low' || effort === 'minimal' ? 'low' : 'high';
}

function qwenThinkingMaximum(model: string): number {
    return /qwen3[.]7-(?:max|plus)/.test(model) ? 262144 : 81920;
}

function qwenBudgetFor(model: string, effort: ReasoningEffort): number {
    if (/qwen3[.]7-(?:max|plus)/.test(model)) {
        return effort === 'minimal' ? 1024
            : effort === 'low' ? 2048
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
    // GLM 4.0+ hybrid models use the same explicit thinking switch.
    {
        match: (m) => /(?:^|\/)glm-(?:4[.]?[0-9]v?|5)(?:[-.]|$)/.test(m),
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
    if (lowerProvider === 'openrouter') {
        return { extraBody: { reasoning: { enabled: false } } };
    }
    if (lowerProvider === 'together' && isKnownReasoningModel(lowerModel)) {
        return { extraBody: { reasoning: { enabled: false } } };
    }
    if (lowerProvider === 'openai' || lowerProvider === 'deepinfra' || lowerProvider === 'ollama'
        || lowerProvider === 'custom' || apiFormat === 'openai-responses') {
        return { reasoningEffort: 'none' };
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

interface ThinkingBuildContext {
    model: string;
    lowerModel: string;
    providerId: string;
    apiFormat: CustomApiFormat;
    requested: ReasoningEffort;
}

interface ThinkingRule {
    /** Provider ids (lowercase) this rule applies to; omitted = any provider. */
    providers?: readonly string[];
    /** Wire formats this rule applies to; omitted = any format. */
    apiFormats?: readonly CustomApiFormat[];
    /** Regex over the lowercased model name; omitted = any model. */
    model?: RegExp;
    /** Translate the normalized effort into the provider's request shape. */
    build: (ctx: ThinkingBuildContext) => EnableThinkingResult | undefined;
}

function siliconflowThinkingBudget(requested: ReasoningEffort): number {
    return requested === 'low' ? 2048
        : requested === 'medium' ? 8192
            : requested === 'high' ? 16384
                : 32768;
}

function geminiThinkingLevelParams(ctx: ThinkingBuildContext): EnableThinkingResult {
    const thinkingLevel = withoutMax(ctx.requested);
    return ctx.apiFormat === 'gemini-generate-content'
        ? { extraBody: { thinking_config: { thinking_level: thinkingLevel } } }
        : { extraBody: { google: { thinking_config: { thinking_level: thinkingLevel } } } };
}

function gemini25ThinkingBudgetParams(ctx: ThinkingBuildContext): EnableThinkingResult {
    const thinkingBudget = ctx.requested === 'low' ? 1024
        : ctx.requested === 'medium' ? 8192
            : 24576;
    return ctx.apiFormat === 'gemini-generate-content'
        ? { extraBody: { thinking_config: { thinking_budget: thinkingBudget } } }
        : { extraBody: { google: { thinking_config: { thinking_budget: thinkingBudget } } } };
}

/**
 * Ordered thinking-protocol table. First matching rule wins — keep entries in
 * specificity order (the order of the former if-else chain).
 * `build` translates the normalized UI effort into the provider's request shape.
 * Add a new model family by appending a rule here instead of editing aiService.
 */
const THINKING_RULES: ThinkingRule[] = [
    // OpenAI Responses API carries reasoning_effort on the wire; max → xhigh for
    // models that expose xhigh.
    { apiFormats: ['openai-responses'], build: ctx => ({ reasoningEffort: getEffectiveReasoningEffort(ctx.model, ctx.requested, ctx.apiFormat) }) },

    // OpenRouter normalizes request shapes; the upstream model decides whether an
    // effort selector exists and which values are meaningful.
    { providers: ['openrouter'], model: /(?:^|\/)(?:moonshotai\/kimi-k2|minimax\/minimax-m[23])/, build: () => ({ extraBody: { reasoning: { enabled: true } } }) },
    { providers: ['openrouter'], model: /deepseek-v4|glm-5[.]2/, build: ctx => ({ extraBody: { reasoning: { effort: deepSeekV4Effort(ctx.requested) } } }) },
    { providers: ['openrouter'], model: /(?:^|\/)moonshotai\/kimi-k3(?:-|$)/, build: ctx => ({ extraBody: { reasoning: { effort: kimiK3Effort(ctx.requested) } } }) },
    { providers: ['openrouter'], model: KNOWN_REASONING_MODEL_RE, build: ctx => ({ extraBody: { reasoning: { effort: ctx.requested } } }) },

    // Kimi K3 exposes named effort levels through the reasoning_effort field.
    { providers: ['kimi', 'kimi-code-plan'], model: /(?:^|\/)(?:kimi-)?k3(?:-|$)/, build: ctx => ({ reasoningEffort: kimiK3Effort(ctx.requested) }) },

    // MiniMax M3 exposes adaptive on/off control, but no named effort levels.
    { providers: ['minimax', 'minimax-token-plan', 'opencode', 'opencode-go'], model: /(?:^|\/)minimax-m3(?:-|$)/, build: () => ({ extraBody: { thinking: { type: 'adaptive' } } }) },

    // Anthropic Messages protocol.
    { apiFormats: ['anthropic-messages'], model: /claude-/, build: ctx => {
        const features = getAnthropicModelFeatures(ctx.lowerModel);
        return features.effort
            ? { reasoningEffort: ctx.requested }
            : { extraBody: { thinking_budget: budgetFor(ctx.requested, 64000) } };
    } },
    { apiFormats: ['anthropic-messages'], model: QWEN_THINKING_MODEL_RE, build: ctx => ({ extraBody: { thinking_budget: qwenBudgetFor(ctx.lowerModel, ctx.requested) } }) },
    { apiFormats: ['anthropic-messages'], build: ctx => getEnableThinkingParams(ctx.model, ctx.providerId) },

    // Gemini 3.x: thinking levels (cannot fully disable).
    { providers: ['google'], model: /gemini-3/, build: geminiThinkingLevelParams },
    { apiFormats: ['gemini-generate-content'], model: /gemini-3/, build: geminiThinkingLevelParams },
    // Gemini 2.5 Flash: thinking budget.
    { providers: ['google'], model: /gemini-2[.]5/, build: gemini25ThinkingBudgetParams },
    { apiFormats: ['gemini-generate-content'], model: /gemini-2[.]5/, build: gemini25ThinkingBudgetParams },

    { providers: ['qwen'], model: QWEN_THINKING_MODEL_RE, build: ctx => ({ extraBody: { enable_thinking: true, thinking_budget: qwenBudgetFor(ctx.lowerModel, ctx.requested) } }) },

    { providers: ['siliconflow'], model: KNOWN_REASONING_MODEL_RE, build: ctx => ({ extraBody: { enable_thinking: true, thinking_budget: siliconflowThinkingBudget(ctx.requested) } }) },

    { providers: ['glm', 'opencode', 'opencode-go'], model: /(?:^|\/)glm-5[.]2(?:-|$)/, build: ctx => ({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: deepSeekV4Effort(ctx.requested) }) },
    { providers: ['glm', 'opencode', 'opencode-go'], model: /(?:^|\/)glm-(?:4[.]?[5-9]|5)(?:[-.]|$)/, build: () => ({ extraBody: { thinking: { type: 'enabled' } } }) },

    { providers: ['deepseek', 'opencode', 'opencode-go'], model: /deepseek-v4/, build: ctx => ({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: deepSeekV4Effort(ctx.requested) }) },

    { providers: ['together'], model: /deepseek-(?:ai\/)?deepseek-v4|deepseek-v4/, build: ctx => ({ extraBody: { reasoning: { enabled: true } }, reasoningEffort: deepSeekV4Effort(ctx.requested) }) },
    { providers: ['together'], model: KNOWN_REASONING_MODEL_RE, build: () => ({ extraBody: { reasoning: { enabled: true } } }) },

    { providers: ['deepinfra'], model: KNOWN_REASONING_MODEL_RE, build: ctx => ({ reasoningEffort: withoutMax(ctx.requested) }) },
    { providers: ['ollama'], build: ctx => ({ reasoningEffort: withoutMax(ctx.requested) }) },

    // Custom OpenAI-compatible endpoints can still benefit from well-known model conventions.
    { providers: ['custom'], model: QWEN_THINKING_MODEL_RE, build: ctx => ({ extraBody: { enable_thinking: true, thinking_budget: qwenBudgetFor(ctx.lowerModel, ctx.requested) } }) },
    { providers: ['custom'], model: /(?:^|\/)(?:gpt-5|o[134](?:-|$)|deepseek-|glm-5[.]2|gpt-oss)/, build: ctx => ({ reasoningEffort: withoutMax(ctx.requested) }) },

    // Generic fallback: provider-specific on/off switches only.
    { build: ctx => getEnableThinkingParams(ctx.model, ctx.providerId) },
];

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
    requested = normalizeReasoningEffort(
        getModelReasoningCapability(lowerProvider, model, apiFormat),
        requested
    );
    if (requested === 'none') return getReducedThinkingParams(model, providerId, apiFormat);

    const ctx: ThinkingBuildContext = { model, lowerModel, providerId: lowerProvider, apiFormat, requested };
    for (const rule of THINKING_RULES) {
        if (rule.providers && !rule.providers.includes(lowerProvider)) continue;
        if (rule.apiFormats && !rule.apiFormats.includes(apiFormat)) continue;
        if (rule.model && !rule.model.test(lowerModel)) continue;
        return rule.build(ctx);
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
