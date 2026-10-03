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
- 标准价（每百万 tokens）：Sol `$2` 输入 / `$0.20` 缓存输入 / `$10` 输出；
  Luna `$0.10` 输入 / `$0.01` 缓存输入 / `$0.50` 输出，缓存输入统一为未缓存输入的 10%；
- ChatGPT 侧：Codex 于 2026-09-02 逐步放开 Sol 与 Luna，二者同时出现在
  Work 与 Codex（桌面端/CLI/IDE 扩展），但不在 Chat 中；Plus/Pro/Business/Enterprise
  均在 GPT-6 的开放范围；官方同时公告 `gpt-5.5` 将于 **2026-10-14** 从
  ChatGPT、ChatGPT Work 与 Codex 全线下线（OpenAI API 不受影响）。

本仓库此前的 GPT-6 支持（见
[增加 GPT-6 Astra 模型支持与参数契约适配](./2026-09-05-gpt-6-astra-provider-support.md)）
只覆盖 Astra 一个 id：`openai` 与 `codex-chatgpt` 目录没有 Sol/Luna，能力表
（视觉、上下文、输出预算）与推理协议中的判断全部硬编码 `gpt-6-astra`
或 `gpt-6(?:-astra)?`，定价表也没有 Sol/Luna 档位；「1M 扩展上下文」判定
（`isCodexExtendedContextModel`）同样只认 `gpt-6-astra` 与 `gpt-5.6`，
新模型会退化为「未知模型」处理。

## Decision

- **Codex 订阅目录**（`codex/oauthService.ts`）：`CODEX_CHATGPT_MODELS` 在
  `gpt-6-astra` 之后插入 `gpt-6-sol`、`gpt-6-luna`；默认模型仍为 `gpt-6-astra`，
  Codex 默认上下文仍为 272K。
- **OpenAI API 目录**（`providers/models/defaults.ts`）：`openai.models` 在
  `gpt-6-astra` 之后加入 `gpt-6-sol`、`gpt-6-luna`。
- **OpenRouter 目录**：新增 `openai/gpt-6-astra`、`openai/gpt-6-sol`、
  `openai/gpt-6-luna` 三项，并补齐 `openrouter:` 前缀 1,050,000 条目。
- **能力表**（`providers/models/capabilities.ts`）：为 Sol/Luna 打开视觉、
  补 1,050,000 上下文；`ALWAYS_THINKING_PREFIXES` **不加入** Sol/Luna（二者支持
  `none`），Astra 仍是该列表中唯一的 GPT-6 条目。
- **1M 扩展上下文**（`isCodexExtendedContextModel`）：判定由 `gpt-6(?:-astra)?|gpt-5.6`
  收敛为 `gpt-6|gpt-5.6`，GPT-5.3/5.5 等旧 Codex id 仍回退到 272K 服务窗口。
  Webview 预设按钮组同步。
- **推理协议**（`providers.ts`）：新增 `isGpt6ReasoningFamilyModel`，Astra 保持
  `low…max`（无 `none`），Sol/Luna 暴露含 `none` 的完整档位；
  `getEffectiveReasoningEffort` 全家族把 `minimal` 降到 `low`。
- **定价**（`pricingData.json` / `pricing.ts`）：新增 Sol/Luna 档位，缓存命中折扣
  改为 `gpt-6-` 前缀（0.1）。
- **回归测试**：`codexOAuthService.test.ts`、`providers.test.ts`、
  `providerThinkingParams.test.ts`、`pricing.test.ts`。

## Alternatives considered

1. **只加目录、不改进家族判定**：否决。会把新模型退化成未知模型。
2. **把 Sol/Luna 写进 `ALWAYS_THINKING_PREFIXES`**：否决。官方明确二者支持 `none`。
3. **让 `max` 在 Sol/Luna 上继续映射为 `xhigh`**：否决。官方支持 `max`。
4. **加入 OpenRouter 派生 id（`-pro` 后缀）**：否决。非官方 API 模型。
5. **把默认模型改为 `gpt-6-sol`**：否决。默认仍为 Astra（见
   [GPT-6 Astra 默认模型决策](./2026-09-09-gpt-6-astra-default-provider-update.md)）。
6. **同步改写第三方渠道的 GPT-6 目录**：否决。各渠道有独立上架节奏。

## Consequences

- 用户在两个渠道都能选择 `gpt-6-sol` 与 `gpt-6-luna`：1,050,000 上下文、
  128,000 输出预算、视觉输入、完整推理档位与正确计价即时生效。
- 已知后续事项：`gpt-5.5` 将于 2026-10-14 从 ChatGPT/Work/Codex 下线（API 不受影响），
  届时需移除该 id 并同步清理能力表与测试基线。

## 2026-10-03 增补：GPT-6.1 Sol 接入

### Problem

OpenAI 上线 GPT-6.1 系列，当前唯一档位 `gpt-6.1-sol`（"near-Astra performance at a
lower cost"）。本仓库完全没有该 id，且既有 GPT-6 家族判定只认 `gpt-6-` 连字符形态，
无法匹配 `gpt-6.1-sol` 的点号小版本，会让它退化成「未知模型」。

### 官方事实（来源）

- <https://developers.openai.com/api/docs/models/gpt-6.1-sol.md>：1,050,000 上下文 /
  922,000 最大输入 / 128,000 最大输出；输入 text+image；工具必须走 Responses；
  `reasoning.effort` = `low`/`medium`(默认)/`high`/`xhigh`/`max`，**`none` 与
  `minimal` 均不支持**；$2 输入 / $0.1 缓存输入 / $10 输出，缓存为未缓存价的 **5%**。
- <https://developers.openai.com/api/docs/guides/latest-model.md>：「When reasoning
  effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`」；并明确
  「GPT-6 Astra and GPT-6.1 Sol do not support the `none` reasoning effort」。
- <https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json>：
  `visibility=list`、`supported_in_api=true`、`priority=1`、
  `default_reasoning_level=low`、`context_window=272000`、`max_context_window=872000`。
- 缓存折扣复核：Astra $1/$10、Sol $0.2/$2、Luna $0.01/$0.1 **均为 10%**，与本文上方
  「统一 10%」一致（原文 Sol 的 `$0.10` 系笔误，已更正为 `$0.20`）；5% 仅 6.1 Sol 一家。

### Decision

- **目录**：`CODEX_CHATGPT_MODELS` 与 `openai.models` 在 `gpt-6-astra` 之后插入
  `gpt-6.1-sol`；两个渠道默认模型仍为 `gpt-6-astra`。
- **能力表**：视觉 + 1,050,000 上下文；**加入 `ALWAYS_THINKING_PREFIXES`**（官方不支持
  `none`，应像 Astra 一样跳过内联补全）。`isCodexExtendedContextModel` 与 Webview
  同步放宽为 `gpt-6(?:[.]1)?`。
- **Codex 与 API 分离**（本次最关键）：
  - 上下文：API 侧 1,050,000；Codex 服务目录上限为 **872,000**，故新增
    `CODEX_CHATGPT_MAX_CONTEXT_TOKENS` 覆盖，`clampConfiguredContextTokens` 对该 id
    夹到 872,000（旧 GPT-6 档位保持原 1M 策略不动）。Webview 预设按钮改为每次
    `updateContextControls` 写 `dataset.contextTokens` 与文案、点击时读取，避免只绑定
    一次的监听器闭包捕获旧模型。
  - 推理默认：API 官方默认 `medium`，Codex 服务目录默认 `low`，
    `openAiReasoningCapability` 按 `providerId` 解析出不同 `defaultValue`。
- **家族判定**：`isGpt6AstraModel` 更名 `isGpt6NoNoneEffortModel`（= `gpt-6-astra` ∪
  `gpt-6[.]1-sol`），family 保持显式枚举 ∪ `6.1-sol`，`KNOWN_REASONING_MODEL_RE` 同步。
  点号小版本**只认已发布的 `6.1`**，不写通配数字，避免未发布档位继承无人承诺的契约。
- **温度**：`gpt-6.1-sol` 与 Astra 一样不传 `temperature`，依据是上述两条官方陈述的
  组合（effort 非 `none` 需移除 + 该模型无 `none`），而非从 `none` 反推。
- **定价**：`pricingData.json` 新增 `gpt-6.1-sol: [13.64, 68.20]`；`getCacheDiscountFactor`
  新增**精确 id** 规则 `gpt-6.1-sol` → `0.05`，置于 `gpt-6-` → `0.1` 之前。
- **回归测试**：`codexOAuthService.test.ts`、`providers.test.ts`（含 Codex 872,000 与
  API 1,050,000 分离、`gpt-6.2-sol` 负向断言）、`providerThinkingParams.test.ts`
  （per-channel 默认）、`pricing.test.ts`（5%/10% 缓存折扣）。

### Alternatives considered

1. **点号小版本用通配数字**：否决。未发布的 `6.2` 会继承 1M 上限与「无 `none`」契约，
   造成界面允许、服务端拒绝。
2. **沿用家族 1M 策略给 6.1**：否决。Codex 目录明确 `max_context_window=872000`。
3. **缓存折扣并入 `gpt-6-` 前缀规则**：否决。费率不同（5% vs 10%），会高估一倍。
4. **同步更新 OpenRouter 目录**：本次不做，范围限定 GPT/Antigravity；共享能力表与定价
   按 id 生效，手输 `openai/gpt-6.1-sol` 也能正确计价。
5. **删除 `gpt-5.5`**：否决。官方下线日 2026-10-14 未到。
6. **采纳 `ultra` 档位**：否决。Codex `models.json` 为多款列出 `ultra`，但 Responses
   API 的 `reasoning.effort` 枚举不含它，直发会 400。

### 审计与后续（本轮不实现）

- **Codex 目录是静态的**：`getAccountStatus` 恒返回编译期常量，不随账号/远端变化，
  无「按账号动态发现」能力，需独立设计。
- **Prompt Cache TTL 未实现**：`client/extension/ai` 中 `prompt_cache_retention` /
  `prompt_cache_options` 均无出现，故无旧字段兼容 bug，仅缺该新能力。
- `gpt-daybreak-*`、`codex-auto-review` 为 `visibility=hide` 内部模型，不纳入目录。
