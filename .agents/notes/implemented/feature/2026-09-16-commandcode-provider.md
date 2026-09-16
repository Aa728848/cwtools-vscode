# Agent Note: 接入 Command Code Provider API 供应商

Status: implemented

## Problem

CWTools 的 AI Agent 需要接入 [Command Code](https://commandcode.ai) 的 Provider API。该服务在
`https://api.commandcode.ai/provider/v1` 提供 OpenAI 兼容的 Chat Completions 端点（另有一个
Anthropic Messages 端点），按量计费，聚合 Claude / GPT / DeepSeek / GLM / Kimi / Qwen / MiniMax /
Gemini / Grok 等 60+ 模型，其模型目录 `GET /provider/v1/models` 无需鉴权即可访问。

## Decision

以 OpenAI 兼容网关形态接入，沿用 openrouter/opencode 的既有模式，共改动 6 个文件：

1. `providers/models/defaults.ts`：新增 `commandcode` 内置供应商——端点
   `https://api.commandcode.ai/provider/v1`、`isOpenAICompatible: true`、需要 API Key
   （Studio → API Keys 生成），模型清单为目录接口当前发布的完整 69 个模型（含厂商前缀形式的
   ID，如 `deepseek/deepseek-v4-flash`、`zai-org/GLM-5.2`），默认模型
   `deepseek/deepseek-v4-flash`。
2. `providers/models/capabilities.ts`：新增 `COMMANDCODE_MODEL_CONTEXT_TOKENS`（按目录接口的
   `context_length` 逐模型记录），以 `commandcode:<model>` 前缀键合入
   `MODEL_CONTEXT_TOKENS`，精确匹配优先于通用子串回退。输出上限不加供应商分支，复用
   `getModelOutputTokens` 的模型族启发式（deepseek→384000、kimi-k3→131072 等）。
3. `providers.ts`： barrel 导出 `COMMANDCODE_MODEL_CONTEXT_TOKENS`；
   `getModelReasoningCapability` 增加 `commandcode` 分支，复用
   `upstreamGatewayCapability` 按上游模型族推导推理档位；`THINKING_RULES` 末尾（通用兜底之前）
   新增规则：commandcode 统一以顶层 `reasoning_effort` 字段发送档位（与 Command Code 官方
   CLI/插件的线协议一致，由服务端按模型归一化）。
4. `cacheCapability.ts`：`commandcode` 加入 `GATEWAY_PROVIDERS`，按网关语义判定前缀缓存
   （模型名命中已知族则 `implicit-prefix`，否则 unknown）。
5. `chatSettings.ts`：模型拉取允许无 Key——`/provider/v1/models` 目录接口公开，
   与 opencode 的 models.dev 先例一致。
6. `client/test/unit/providers.test.ts`：新增 "Command Code provider support" 回归块，覆盖
   供应商注册形态、线协议为 `openai-chat-completions`、供应商前缀上下文窗口、输出上限
   启发式、推理能力与 `reasoning_effort` 发送。

决策记录（用户确认）：只接 OpenAI 兼容端点；不做 Go 套餐的 `/alpha/generate` 私有协议回退
（该协议是 CLI 私有线格式，工程量与合规风险显著更高），Go 套餐用户会得到 403
`upgrade_required` 报错。

## Alternatives considered

- **同时接入 Anthropic Messages 端点（commandcode-messages）**：可覆盖 Claude 原生协议特性
  （thinking display、effort 等），但用户选择仅接 OpenAI 兼容端点；Claude 模型经
  Chat Completions 端点同样可用，后续可按 minimax/minimax-token-plan 的成对先例增补。
- **Go 套餐 /alpha/generate 回退**：需实现 CLI 私有流式协议（专用请求头、流格式、工具转换），
  且可能触及服务条款；用户明确不做。
- **运行时动态模型发现替代静态目录**：设置页"拉取模型"本就走通用 `/models` 流程（支持
  `context_length` 解析），静态清单只是默认值；保持与其他内置供应商一致的静态目录，
  不新增运行时获取逻辑。
- **维护 commandcode 专用 pricing 表**：Command Code 按量计费且宣称无加价，
  `getModelPricing` 对 `deepseek/deepseek-v4-pro` 这类带前缀 ID 会回退到通用模型键匹配，
  暂不需要供应商级价格条目。

## Consequences

- 用户在供应商下拉框中选择 "Command Code"，填入 Studio 生成的 API Key 即可使用全部目录模型；
  设置页可不填 Key 直接刷新模型列表。
- 静态目录是快照：Command Code 上架新模型需更新 `defaults.ts` 与
  `COMMANDCODE_MODEL_CONTEXT_TOKENS` 两处（或用户手动在设置里添加模型）。
- Claude 系列经 commandcode 走 OpenAI 格式，不享有 anthropic-messages 的 thinking 块特性；
  推理控制统一依赖 `reasoning_effort`，由 Command Code 服务端归一化。
