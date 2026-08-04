# DeepSeek 适配策略改进汇总

> 内部工作文档:记录 2026-08 对 `client/extension/ai/` 中 DeepSeek 特殊适配的评估结论与改进计划。
> 参照实现:MoonshotAI/kimi-code(main 分支,Apache-2.0),文件引用均为该仓库路径。

## 1. 结论摘要

项目为 DeepSeek 维护了 4 条特殊策略。与 kimi-code 对比后判断:

| # | 策略 | 判断 | 处理 |
|---|------|------|------|
| 1 | `reasoning_content` 强制回传 | **必须保留**(全生态公认硬需求,缺失即 400) | ✅ 已执行:字段名可探测/可配置(reasoning-key 模式) |
| 2 | system prompt 指纹冻结(前缀缓存) | 有效,但实现偏复杂 | ✅ 已审查:冻结路径已排除动态参数;动态块追加在静态前缀后,无需改动 |
| 3 | 对话 prefix 续写(`/beta` + `prefix: true`) | **建议移除** | ✅ 已执行:代码、类型、能力表、测试全部移除 |
| 4 | DSML 文本工具调用兜底 | 保留,低优先级 | 维持现状,不扩展 |
| — | provider 特判分散在枚举分支 | 架构差距 | ✅ 已执行:`getThinkingParams` 收敛为规则表 |

注:对话 prefix 续写与 FIM 补全是两个独立功能(前者 `/beta/chat/completions` + `prefix: true`,后者 `/beta/completions` + `prompt/suffix`)。移除续写**不影响** FIM(aiService.ts:710+ 与 aiService.ts:786-791 保留)。

## 1.1 执行记录(2026-08-04)

- **P1-1 移除对话 prefix 续写**:已删除 `aiService.ts` 续写循环与 `prefix` 序列化、`types.ts` `provider_prefix`、`capabilities.ts` `prefixContinuation*` 字段;同步更新 `providerCapabilities.test.ts`,删除 `aiServiceTimeout.test.ts` 两个续写专项测试。
- **P0 reasoningKey 模式**:新增 `client/extension/ai/providers/reasoningKey.ts`(`KNOWN_REASONING_KEYS` + 探测 + explicit 覆盖);`ChatMessage` 增加 `reasoning_key` 元数据;`sanitizeRequest` 按 `reasoning_key` 动态序列化;流式/非流式读取、`removeUnsupportedOptionalChatFields`、`agentRunner` 提取全部走探测;AI 设置面板新增「Reasoning field name」输入框,配置 `stellarisLanguageServices.ai.reasoningKey`。
- **P1-2 system prompt 审查**:结论为无需改动——`buildFrozenSystemPrompt` 注释与实现均排除动态参数(pinned/topic/summary),`agentRunner.ts:1195` 已确保动态块(profile/plan/pinned/context)追加在冻结前缀之后,与参照实现「前缀只读」原则一致。
- **测试**:新增 `reasoningKey.test.ts`(探测/覆盖/空白)与流式探测回归测试 2 条;全量单元测试 1915 通过,`npm run compile` 与 eslint 无错误。
- **P2 provider 能力表驱动(已执行)**:`providers.ts` 的 `getThinkingParams` 约 150 行 if-else 链收敛为有序 `THINKING_RULES` 规则表(条件 = providers/apiFormats/model 正则,行为 = 协议翻译函数),新增 `ThinkingRule`/`ThinkingBuildContext` 类型与 gemini/siliconflow 协议翻译;`isQwenThinkingModel`/`isKnownReasoningModel` 提取为正则常量 `QWEN_THINKING_MODEL_RE`/`KNOWN_REASONING_MODEL_RE` 复用。规则顺序与原分支一一对应,`providerThinkingParams.test.ts` 22 条断言全部通过。新模型族 = 追加一条表规则,不再改分支逻辑。

## 2. 现状核对

| 策略 | 位置 |
|------|------|
| 冻结 system prompt | `agentRunner.ts:1151`(注释)、`promptBuilder.ts:201-404`(sha256 指纹缓存) |
| 对话 prefix 续写 | `aiService.ts:647-694`;`capabilities.ts:49-56`(官方端点探测);`types.ts:333`(`provider_prefix`);`aiService.ts:931`(`prefix: true` 序列化) |
| reasoning_content 回传 | `agentRunner.ts:3063-3105`(提取/回传)、`agentRunner.ts:3107-3117`(空消息守卫)、`aiService.ts:1404-1406`(流式置 null)、`contextBudget.ts:297-330`(压缩时 `delete`) |
| DSML 兜底 | `agentRunner.ts:3083-3088`(JSON 失败后回退)、`toolCallParser.ts`(解析/剥离) |

## 3. 参照对比(kimi-code)

- `reasoning_content` + `reasoning_effort`:自动透传、字段名自动探测,支持 `reasoning_key` 配置覆盖(`packages/kosong/src/providers/reasoning-key.ts`、`openai-legacy.ts:236,585`)。
- 前缀缓存:不冻结 prompt,而是「动态注入一律追加尾部、前缀只读」(`packages/agent-core/src/agent/injection/manager.ts:20,46`)——零维护的通用原则。
- 对话 prefix 续写、DSML 解析:**均不存在**。

## 4. 改进工作项

### P0 — reasoning_content 字段名可探测/可配置(收益最大、改动最小)

**现状**:`aiService.ts:912-933`(`sanitizeRequest`)、`agentRunner.ts:3063-3105`、`aiService.ts:1326` 硬编码 `reasoning_content`;新网关(One API、中转站等)字段名不同就得改代码。

**改法**(对齐 kimi-code `reasoning-key.ts` 思路):
1. 在 `client/extension/ai/providers/reasoningKey.ts`(新建)定义 `KNOWN_REASONING_KEYS`(首项 `reasoning_content`,按生态常见字段扩展),支持从首个响应探测实际字段名。
2. 非流式响应与流式 `delta` 统一走探测结果(`delta.reasoning_content` / `delta.reasoning` / 探测到的自定义字段)。
3. 在 AI 设置中暴露可选配置 `reasoningKey`,显式覆盖探测。
4. `contextBudget.ts:297-330` 的 `delete` 逻辑改用动态字段名(保留「必须删除而非置空」的 DeepSeek 语义)。

**收益**:新兼容网关零适配;消除枚举分支。
**风险**:低;探测失败回退默认值。
**测试**:`client/test/unit/` 新增 reasoning-key 探测单测(标准字段/自定义字段/缺失三种情况)。

### P1 — 移除对话 prefix 续写

**现状**:`aiService.ts:647-694`。触发条件苛刻(仅官方端点 + `finish_reason === 'length'` + 纯文本/推理、无 tool_calls),续写时 `tools: undefined`,模型行为与正常生成不一致。

**改法**:删除以下内容(已确认无其他调用方):
- `aiService.ts:647-694` 续写循环
- `aiService.ts:931` 的 `prefix: true` 序列化
- `types.ts:333` `provider_prefix` 字段
- `capabilities.ts:6,15,19,50,55,65` 的 `prefixContinuation` / `prefixContinuationEndpoint`(仅被 aiService.ts:649,655 使用)

**保留**:截断恢复继续走现有 `recoverSlimOutputBudget` 路径;FIM(`/beta/completions`)不受影响。
**收益**:删掉一整块协议状态机(usage 合并、边界条件、能力探测)。
**风险**:截断场景回退为「切片引导」恢复,行为略变,已在既有路径覆盖。

### P1 — system prompt 冻结:保留 + 追加式注入原则

**现状**:`promptBuilder.ts:201-404` 指纹 + session 缓存,保证字节级稳定。

**改法**:
1. 保留冻结(DeepSeek 前缀缓存命中价格约为未命中 1/10,agent 长循环收益明确)。
2. 对齐 kimi-code:审查 `buildContextMessages`(`promptBuilder.ts:1167`)等动态内容,**确保一切逐轮变化的内容追加在对话尾部而非 system prompt**;若已有违反,改为追加式。
3. 评估指纹失效逻辑(`rebuildSystemPrompt` 相关)可否简化;该项需先阅读 `promptBuilder.ts` 全貌再定。

**测试**:`promptBuilderCache.test.ts` 已有覆盖,改动后运行。

### P2 — DSML 兜底:保留,不扩展

**现状**:`toolCallParser.ts` 完整解析 + `agentRunner.ts:3086-3088` JSON 失败后回退。

**结论**:官方 API 原生 `tool_calls` 是主流,但第三方/本地部署(硅基流动、vLLM 等)存在间歇性 DSML 泄漏(社区大量 issue 佐证)。解析成本低、失败无害,保留为防御层。**不新增功能**;如 `stripDsmlMarkup` 有回归风险,补一条单测即可。

### P2 — provider 能力表驱动 ✅ 已执行

**现状**:`getThinkingParams`(`providers.ts`)按 provider+模型名枚举(约 150 行 if-else)。

**改法(已完成)**:
- `getThinkingParams` 收敛为有序 `THINKING_RULES` 规则表:每条 = `{ providers?, apiFormats?, model?, build(ctx) }`,规则顺序与原分支一一对应。
- `isQwenThinkingModel` / `isKnownReasoningModel` 提取为 `QWEN_THINKING_MODEL_RE` / `KNOWN_REASONING_MODEL_RE` 常量,表与既有分支共用。
- 新模型族 = 追加一条表规则(数据),不再改分支逻辑。
- `getReducedThinkingParams` 保持现状(已由 `DISABLE_THINKING_PARAMS` 数据表 + 短 provider fallback 组成)。

**收益**:消除 `getThinkingParams` 的累积特判;`providerThinkingParams.test.ts` 22 条断言提供行为回归网。
**风险**:已通过专项测试 + 全量单元测试(1915)验证,行为无变化。

## 5. 验证

- P0/P1 改动后:`npm run compile` + `npm run test:unit`(重点 `promptBuilderCache`、新增 reasoning-key 单测)。
- 涉及工具/请求构造改动时,按 `AGENTS.md` 补充针对性回归测试。
- 行为验证:DeepSeek 官方端点 agent 循环 5 轮以上,确认无 400、截断恢复正常。

## 6. 决策记录

- 2026-08:对比 kimi-code 源码后确定上述优先级。核心判断:reasoning_content 处理是硬需求(生态 400 报告:openai/codex#24500、n8n、goose、spring-ai 等);prefix 续写与 DSML 是防御性增强,前者建议移除,后者保留。
