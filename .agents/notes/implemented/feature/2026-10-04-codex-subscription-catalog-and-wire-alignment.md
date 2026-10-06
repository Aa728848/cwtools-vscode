# Agent Note: Codex 订阅线路目录与线协议对齐

Status: implemented

## Problem

`codex-chatgpt`（ChatGPT 订阅）线路此前只实现到「能跑通」的程度，与官方 Codex
客户端的线协议存在四处系统性偏差，且模型目录是编译期常量。参照实现
`dsh-chatgpt-subscription` 已在真实账号上验证了这些差异，逐条对照后确认都是我们
这一侧缺失的能力：

1. **缺少 `openai-beta: responses=experimental` 请求头**。订阅后端以 beta 标志
   提供，官方 CLI 一直发送该头；缺它时请求面不同，上游收紧后会变成 400/403。
2. **模型目录静态**（`CODEX_CHATGPT_MODELS` 常量）。只有后端知道某个套餐当前
   服务哪些模型、真实上下文窗口是多少——这正是订阅专属模型存在的原因。
3. **推理摘要默认发送 `summary: 'auto'`**。目录里每个模型都声明
   `default_reasoning_summary: none`，官方以此为准；摘要属于**计费生成**，等于每轮
   多花一块官方从不花的额度。
4. **未配置时整个不发 `text` 字段**。官方客户端每轮发送目录的 `default_verbosity`
   （当前全部为 `low`）；不发时服务端套用隐含的 `medium`，一个从未打开过该设置的
   用户会拿到比官方更啰嗦、也更贵的回答。
5. **没有多轮续接**：后端在 `x-codex-turn-state` 里回传本轮路由状态，官方在同一轮
   的下一次请求原样回送以续接该轮，而不是重新读整段历史。
6. **GPT-6 家族上下文按 272K 计**。目录同时公布 `context_window: 272000` 与
   `max_context_window: 872000`；官方 model manager 读的是更大的有效值。

## Decision

### 新增两个模块

- `client/extension/ai/codex/modelCatalog.ts`：订阅目录的读取、解析、按账号缓存与
  快照持久化。
  - `CODEX_MODELS_URL` 带 `client_version`（官方 CLI 同款参数）；
  - 解析 `{ models: [...] }` 与裸数组两种信封；只读后端确实声明的字段
    （`context_window` / `input_modalities` / `supported_reasoning_levels` /
    `default_verbosity`）；
  - 未声明的能力回落保守值：已知模型沿用内置表，未知模型按纯文本；`text.verbosity`
    只在目录或内置表能建立该模型的 verbosity 支持时才发送（**声明一个做不到的能力
    比不声明更糟**）；
  - 按 `accountId` 隔离缓存（不同套餐目录不同），15 分钟 TTL，同账号单飞；
  - **只持久化实时目录**：一次失败的调用不得用内置表覆盖好的快照；
  - 导出 `codexDefaultOutputVerbosity(model)`：目录优先、内置表兜底。
- `client/extension/ai/codex/turnState.ts`：`CodexTurnStateTracker`——有界
  （256 条）、账号作用域的 `x-codex-turn-state` 表。
  - 令牌由**签发它的认证身份**所有，签名者变化时丢弃而不是发给另一个账号；身份用
    `accountId` + `accessToken` 的本地摘要比对，**不上线、不落盘、不日志**；
  - 响应未携带（或为空）该头时**清除**该轮的值：一个不再发送该头的后端已经不再
    承认它，重放过期值就是猜测；
  - 没有可靠的人类轮次标识时按请求作用域处理（`callOpenAIResponses` 内即取即清），
    代价只是一次完整重发，永远不影响正确性。

### `codex/oauthService.ts`

- 新增 `codexSubscriptionHeaders(credentials, userAgent)`：订阅请求头的单一来源
  （Authorization、ChatGPT-Account-Id、`openai-beta`、originator、User-Agent），
  Responses 请求、目录请求与额度请求共用，避免线身份漂移。
- 新增 `getModelCatalog(force)` 与 `getTurnStateCredentials(forceRefresh)`；
  `getRequestHeaders` 与额度请求改走该 helper。
- 构造函数接收 `CodexCatalogSnapshotStore`（`read`/`write`）；`aiService` 用
  `context.globalState`（键 `cwtools.ai.codexChatgpt.catalog.v1`）实现，重启后第一个
  选择器先读磁盘而不是等网络。
- `getAccountStatus` 并行读取额度与目录：目录可用时 `models` 取目录、并新增
  `modelContextWindows` 与 `catalogLive`；目录为空（含失败）时回落到内置表，
  **选择器变宽而不是消失**。

### `aiService.ts`

- `callOpenAIResponses` 的 codex 分支：改用 `getTurnStateCredentials` 取凭据，从
  `codexSubscriptionHeaders` 组装头，附带本轮的 turn state；响应落定后
  `remember`（携带签发者摘要），失败则 `forget`。
- `buildOpenAIResponsesPayload` 新增 `resolvedVerbosity`：codex 兼容路径下，
  用户显式选择优先，否则发 `codexDefaultOutputVerbosity(model)`；两者都没有则不发
  `text` 字段。

### 上下文与能力表（`providers/models/capabilities.ts`、`chatSettings.ts`）

- 新增 `CODEX_CHATGPT_EFFECTIVE_CONTEXT_TOKENS = 384_000` 与
  `isCodexGpt6FamilyModel`：**只有 GPT-6 家族**（6 Astra / 6.1 Sol / 6 Sol / 6 Luna）
  以 384K 起算，GPT-5.6 家族保持目录声明的 272K。
- `CODEX_CHATGPT_MAX_CONTEXT_TOKENS` 补齐整个 GPT-6 家族 → 872,000（原先只有
  `gpt-6.1-sol`）。
- `chatSettings.buildAndSendSettingsData` 把目录的每模型窗口以
  `codex-chatgpt:<model>` 键合入 `modelContextTokens`，**实时目录压过内置表**，让 DSH
  的压缩与溢出判断使用服务端真正提供的数字。
- 内置的 `codex-chatgpt:<model>` 表项按家族区分（GPT-6 → 384K，其余 → 272K）。

### 回归测试

- 新增 `client/test/unit/codexCatalog.test.ts`：线协议常量、两种信封、声明字段解析、
  未知模型保守回落、条目上限、快照形状校验、实时目录与失败保留、账号隔离、单飞、
  请求头透传、verbosity 解析优先级、turn-state 的身份作用域/清除/有界/年龄刷新。
- `codexOAuthService.test.ts`：新增「实时目录与上下文窗口」与「目录无模型时回落内置表」
  两例；套件 `beforeEach` 清理进程级目录缓存。
- `aiServiceTimeout.test.ts`：verbosity 默认值断言（未配置 → `low`；目录未建立支持 →
  不发 `text`）；401 重试用例改用 `getTurnStateCredentials` 接缝并断言两次请求都带
  `openai-beta`。
- `providers.test.ts`：GPT-6 家族 384K / 872K 上限与 GPT-5.6 保持 272K 的分离断言。

## Alternatives considered

1. **只补 `openai-beta` 头，其余不动**：否决。摘要与 verbosity 的默认值偏差是**计费
   行为**，用户看不见却在持续多花额度；turn state 与目录是同一批已实测的契约差异。
2. **目录只放在内存、不做快照**：否决。重启后第一个选择器会等一次网络往返；参照实现
   已验证「快照兜底、实时目录优先」是正确取舍。
3. **目录失败时清空选择器**：否决。目录是「账号能调什么」的窄视图，读不到时应变宽
   （回落内置表），而不是让用户没有模型可选。
4. **目录条目直接进入 `MODEL_CONTEXT_TOKENS` 常量**：否决。该常量是编译期数据，
   账号相关的结果必须走设置页的 `modelContextTokens` 通道。
5. **把 turn state 按会话跨轮保存**：否决。官方写明跨轮复用违反客户端/服务端契约并
   可能造成路由错误；即取即清只是少一次续接，不会错。
6. **用刷新令牌/账号 id 作 turn state 的键**：否决。令牌每次轮换都会变，会把同一账号
   看成新账号；改用本地摘要比对签发者。
7. **给所有 codex 模型统一发 `text.verbosity`**：否决。目录按模型声明该能力，
   对未声明的模型强加字段可能被拒；宁可少发一个字段。
8. **把 GPT-5.6 也提到 384K**：否决。目录对 5.6 家族没有更大的有效值证据，只有 GPT-6
   家族有；不同数字混用会让溢出判断失去意义。

## Consequences

- 订阅请求与官方 Codex CLI 在同一线协议上：beta 头、`store:false`、
  `reasoning.encrypted_content`、`prompt_cache_key`、turn state、目录驱动的 verbosity。
- 默认行为更省额度：不再默认请求推理摘要，且回答详细程度与官方一致（`low`）。
- 选择器与上下文窗口随账号变化：签约不同套餐的账号会看到各自的目录；读不到目录时
  自动回落内置表，功能不降级。
- GPT-6 家族在 Codex 上按 384K 起算、可配至 872K；GPT-5.6 保持 272K。
- 请求仍**绝不发送 `max_output_tokens`**：订阅 Responses 端点会以
  `400 Unsupported parameter: max_output_tokens` 拒收，官方 CLI 的请求结构里也没有该
  字段；输出长度由服务端决定。
- 目录与 turn state 都不落盘敏感数据：目录快照只含模型 id 与窗口；turn state 只存在
  进程内且有界。
