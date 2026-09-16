# Agent Note: 接入 Command Code Messages (Claude) 供应商

Status: implemented

## Problem

Command Code（`https://api.commandcode.ai/provider/v1`）除提供兼容 OpenAI 的 Chat Completions 接口外，亦提供 Anthropic Messages 协议端点（端点路径规范化后打到 `/messages`）。上一轮已接入 OpenAI 兼容的 `commandcode` 供应商，但使用 Claude 原生协议特性（如 Anthropic 格式的 thinking 推理输出、分层断点缓存）需要直接对接 Anthropic Messages 格式端点。先例为成对的 `minimax` 与 `minimax-token-plan`。

## Decision

接入内置供应商 `commandcode-messages`，仅内置 Command Code 官方目录公开的 8 个 Claude 系列模型，共改动以下文件：

1. `client/extension/ai/providers/models/defaults.ts`：在 `commandcode` 条目后新增 `commandcode-messages` 内置供应商：
   - `id: 'commandcode-messages'`
   - `name: 'Command Code Messages (Claude)'`
   - `endpoint: 'https://api.commandcode.ai/provider/v1'`
   - `defaultModel: 'claude-sonnet-5'`
   - `models`: 8 个 Claude 模型（`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`）
   - `isOpenAICompatible: false`, `requiresApiKey: true`, `supportsStreaming: true`, `supportsFIM: false`, `supportsVision: true`, `toolCallStyle: 'openai'`, `maxContextTokens: 1000000`
2. `client/extension/ai/providers/models/capabilities.ts`：在 `MODEL_CONTEXT_TOKENS` 中为 8 个模型添加 `commandcode-messages:<model>` 前缀字面量条目（7 个 1000000，haiku 200000）。
3. `client/extension/ai/providers.ts`：
   - `getProviderApiFormat` 增加 `case 'commandcode-messages': return 'anthropic-messages'`。
   - `getModelReasoningCapability` 扩展 `if (provider === 'claude' || provider === 'commandcode-messages') return claudeReasoningCapability(lower)`，自动继承 Claude 推理档位支持。
   - `THINKING_RULES` 中已有针对 `apiFormats: ['anthropic-messages']` 且 `model: /claude-/` 的规则，无需改动自动生效。
4. `client/extension/ai/cacheCapability.ts`：将 `'commandcode-messages'` 加入 `GATEWAY_PROVIDERS`。由于协议为 `anthropic-messages` 且模型命中 `/claude/`，自动解析为 `status: 'supported'` 与 `requestMode: 'anthropic-breakpoints'`。
5. `client/extension/ai/aiService.ts`：在 `callClaude` 的 `buildClaudeHeaders` 中加入 `providerId === 'commandcode-messages'`。Command Code 仅接受 Bearer 鉴权，且原生 401 回退仅对 `custom` 生效；加入后请求首发直接携带 Bearer Authorization 头。
6. `client/test/unit/providers.test.ts`：
   - `getProviderApiFormat` 全量枚举测试增加 `'commandcode-messages': 'anthropic-messages'`。
   - 新增 "Command Code Messages provider support" describe 块，覆盖注册形态、模型清单、线协议格式、上下文窗口前缀解析、输出上限继承与 Claude 推理能力。

## Alternatives considered

- **直接在单一 commandcode 供应商中按模型动态切换 apiFormat**：虽然技术可行，但违背了仓库中已有供应商模式的统一契约（如 minimax 与 minimax-token-plan 拆分）；独立供应商便于用户显式区分协议、各自独立配置 API Key 或模型设置。
- **复用通用 Bearer 401 失败重试而不是在 buildClaudeHeaders 中显式加入**：Command Code 明确只支持 Bearer 认证，如果默认发送 x-api-key 则每次首个请求必遭 401 且产生额外网络往返延时；同时 callClaude 内部的 401 重试逻辑仅对 `custom` 供应商开启。显式加入名单直截了当且开销最小。

## Consequences

- 用户在供应商列表中可选择 "Command Code Messages (Claude)"，使用同一把 API Key 获得原生 Anthropic Messages 协议支持（包括思维链解析与断点缓存）。
- 模型列表严格限定在官方支持的 8 个 Claude 模型，避免将 OpenAI/Gemini/DeepSeek 等不兼容 Anthropic Messages 接口的模型路由到该端点。
