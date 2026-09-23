# Agent Note: GPT-6 Sol / Luna 供应商目录与能力刷新

Status: implemented

## Problem

OpenAI 于 2026-09-22 正式发布 GPT-6 家族的两款新模型：`gpt-6-sol`
（面向复杂编码与智能体流程）与 `gpt-6-luna`（面向高频、明确的重复性任务），
与 2026-09-03 发布的旗舰 `gpt-6-astra` 同属 GPT-6 家族。官方资料给出的共同规格：

- 上下文窗口 1,050,000 tokens（最大输入 922,000），最大输出 128,000 tokens；
- 输入模态 text + image，输出 text，支持推理 token；
- `reasoning.effort` 支持 `none`/`low`/`medium`(默认)/`high`/`xhigh`/`max`；
  与 Astra 不同，Sol/Luna **支持** `none`；
- 标准价（每百万 tokens）：Sol `$2` 输入 / `$0.10` 缓存输入 / `$10` 输出；
  Luna `$0.10` 输入 / `$0.01` 缓存输入 / `$0.50` 输出，缓存输入统一为未缓存输入的 10%；
- ChatGPT 侧：Codex 于 2026-09-02 起逐步放开 Sol 与 Luna，二者同时出现在
  Work 与 Codex（桌面端/CLI/IDE 扩展），但不在 Chat 中；Plus/Pro/Business/Enterprise
  均在 GPT-6 的开放范围；官方同时公告 `gpt-5.5` 将于 **2026-10-14** 从
  ChatGPT、ChatGPT Work 与 Codex 全线下线（OpenAI API 不受影响）。

本仓库此前的 GPT-6 支持（见
[增加 GPT-6 Astra 模型支持与参数契约适配](./2026-09-05-gpt-6-astra-provider-support.md)）
只覆盖 Astra 一个 id：`openai` 与 `codex-chatgpt` 目录没有 Sol/Luna，能力表
（视觉、上下文、输出预算）与推理协议中的判断全部硬编码 `gpt-6-astra`
或 `gpt-6(?:-astra)?`，定价表也没有 Sol/Luna 档位；Gemini 之外的
「1M 扩展上下文」判定（`isCodexExtendedContextModel`）同样只认 `gpt-6-astra`
与 `gpt-5.6`，新模型会退化为「未知模型」处理（无视觉、成本按 0、不提供推理档位、
Codex 订阅下无法放宽到 1M）。

## Decision

- **Codex 订阅目录**（`codex/oauthService.ts`）：`CODEX_CHATGPT_MODELS` 在
  `gpt-6-astra` 之后插入 `gpt-6-sol`、`gpt-6-luna`，保留 GPT-5.6 三项与
  `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.3-codex-spark` 兼容项；
  默认模型仍为 `gpt-6-astra`，Codex 默认上下文仍为 272K。
- **OpenAI API 目录**（`providers/models/defaults.ts`）：`openai.models` 在
  `gpt-6-astra` 之后加入 `gpt-6-sol`、`gpt-6-luna`；默认模型保持
  `gpt-6-astra`（官方 API 目录同样以 Astra 为首选）。
- **OpenRouter 目录**：新增 `openai/gpt-6-astra`、`openai/gpt-6-sol`、
  `openai/gpt-6-luna` 三项（此前 OpenRouter 只列到 `openai/gpt-5.5`，
  而上游目录已提供这三个 id），并在 `MODEL_CONTEXT_TOKENS` 中补齐对应的
  `openrouter:` 前缀 1,050,000 条目，使聚合渠道的上下文解析不依赖 provider 兜底。
- **能力表**（`providers/models/capabilities.ts`）：
  `VISION_CAPABLE_MODELS` 为 Sol/Luna 打开视觉；`MODEL_CONTEXT_TOKENS` 补齐
  两款 1,050,000；`ALWAYS_THINKING_PREFIXES`（`inlineProvider` 据此跳过
  「无法关闭思考」的模型）**不加入** Sol/Luna，因为二者支持 `none`，
  Astra 仍是该列表中唯一的 GPT-6 条目；
  `getModelOutputTokens` 的 GPT-6 分支由 `gpt-6-astra` 放宽为 `gpt-6` 前缀，
  两款得到 128,000 输出预算。
- **1M 扩展上下文**（`isCodexExtendedContextModel`）：判定正则由
  `gpt-6(?:-astra)?|gpt-5\.6` 收敛为 `gpt-6|gpt-5\.6`，即整个 GPT-6 家族都在
  Codex 下支持「默认 272K、用户可配置到 1,050,000」的扩展路径；GPT-5.3/5.5
  等旧 Codex id 仍回退到 272K 服务窗口。Webview 的预设按钮组
  （`chatPanel.ts` 的 `isCodexExtendedModel`）与提示文案同步按 `gpt-6` 前缀匹配。
- **推理协议**（`providers.ts`）：新增 `isGpt6ReasoningFamilyModel`
  （`gpt-6-astra|sol|luna`）作为 GPT-6 家族的统一判定，`openAiReasoningCapability`
  对 Astra 保持 `low…max`（无 `none`），对 Sol/Luna 暴露
  `none,low,medium,high,xhigh,max`；`getEffectiveReasoningEffort` 对全家族把
  `minimal` 降到 `low`（GPT-6 不接受 `minimal`），仅在 Astra 上额外把 `none`
  降到 `low`，Sol/Luna 保留原生 `none` 与 `max`（不再降级为 `xhigh`）；`upstreamGatewayCapability`、`provider === 'openai' | 'codex-chatgpt'`
  分支、`KNOWN_REASONING_MODEL_RE`（OpenRouter/网关）与 custom 渠道的
  `gpt-6-*` 规则一并改用家族判定。
- **定价**（`pricingData.json` / `pricing.ts`）：新增
  `gpt-6-sol: [13.64, 68.20]`（$2/$10 × 6.82）与
  `gpt-6-luna: [0.68, 3.41]`（$0.10/$0.50 × 6.82），缓存命中折扣由
  `gpt-6-astra` 特例改为 `gpt-6-` 前缀（0.1，官方为输入价的 10%）。
- **回归测试**：`codexOAuthService.test.ts`（订阅目录）、`providers.test.ts`
  （视觉、上下文、Codex 1M 扩展、输出预算、OpenAI 目录、Astra/Sol/Luna 的
  effort 映射）、`providerThinkingParams.test.ts`（Sol/Luna 的完整档位与
  `none`、Astra 不含 `none`）、`pricing.test.ts`（两款价格与缓存折扣）。

## Alternatives considered

1. **只加目录、不改进家族判定**：否决。会把新模型退化成未知模型（无视觉、
   成本 0、Codex 下不能扩展 1M、推理档位缺失），重演 Astra 首次接入时被否决的
   老路（见 [增加 GPT-6 Astra 模型支持与参数契约适配](./2026-09-05-gpt-6-astra-provider-support.md)）。
2. **把 `gpt-6-sol`/`gpt-6-luna` 也写进 `ALWAYS_THINKING_PREFIXES`**：否决。
   该列表的语义是「无法关闭思考」，`inlineProvider` 据此**直接跳过**内联补全；
   官方明确二者支持 `none`，列入会白白禁用这两款模型的内联补全，
   与 Astra 的差异必须保留。
3. **让 `max` 在 Sol/Luna 上继续映射为 `xhigh`**（沿用 `getEffectiveReasoningEffort`
   的旧行为）：否决。官方目录写明 Sol/Luna 支持 `max`，映射成 `xhigh` 会
   悄悄降低用户选择的推理强度，与 Astra 的 `max` 原生透传不一致。
4. **把 OpenRouter 的 `openai/gpt-6-sol-pro`、`gpt-6-luna-pro`、`gpt-6-astra-pro`
   一并加入目录**：否决。这些是上游聚合渠道的派生 id，不是 OpenAI 官方 API 模型，
   列入会让直连用户选到不存在的模型；OpenRouter 目录只跟随官方 id。
5. **把默认模型改为 `gpt-6-sol`**：否决。OpenAI 官方目录仍以 Astra 为首选，
   订阅与 API 的默认值属于既有决策（见
   [将 OpenAI 供应商与 ChatGPT 订阅渠道默认模型更新为 GPT-6 Astra](./2026-09-09-gpt-6-astra-default-provider-update.md)），
   本次不做反向改动。
6. **同步改写 OpenCode Zen / Command Code / TokenRhythm 等第三方渠道的 GPT-6 目录**：
   否决。各渠道有独立的上架节奏，按既有刷新边界不越界修改；共享能力表、定价表与
   推理协议按模型 id 生效，渠道一旦上架即可正确计价与判定。

## Consequences

- 用户在 OpenAI API 与 ChatGPT Codex 两个渠道都能选择 `gpt-6-sol` 与
  `gpt-6-luna`：1,050,000 上下文、128,000 输出预算、视觉输入、完整推理档位
  （含 `none`、`max`）与人民币成本估算均即时生效。
- Codex 订阅渠道下两款新模型沿用「默认 272K + 预设按钮可调到 1M」的扩展策略，
  与 Astra/GPT-5.6 的手感一致。
- `isCodexExtendedContextModel` 采用 `gpt-6` 家族前缀：日后新增的 GPT-6 档位
  自动获得 1M 扩展能力，无需再改判定；同时必须确认新档位确实支持扩展，
  否则会出现界面允许、服务端拒绝的偏差。
- 已知后续事项：`gpt-5.5` 将于 2026-10-14 从 ChatGPT/Work/Codex 下线
  （API 不受影响），届时需要从 `CODEX_CHATGPT_MODELS` 移除该 id 并同步清理
  能力表与测试基线；过渡期内保留以保证已保存会话的模型选择不失效。
