# 订阅线路供应商扩展与改进计划

> 参考项目：`C:\Users\A\Documents\ChatGPT\dsh-chatgpt-subscription`（DSH 插件，8 条线路）。
> 本文是计划与进度文档；实施状态见 §6「分期实施」的勾选列，设计决策落在
> `.agents/notes/implemented/`。

## 1. 背景与目标

参考项目以 DSH 插件形态接入了 8 条订阅线路。本计划目标：

1. 将其中**除 Ollama 外**（用户明确要求排除）我们项目尚未支持的线路补齐；
2. 对**双方共有**的线路逐条比对，把参考项目已验证的协议细节与默认值修正吸收进来。

## 2. 线路对照总表

| 参考项目线路 | 协议 / 登录 | 我们项目现状 | 结论 |
| --- | --- | --- | --- |
| `codex-chatgpt` | Responses / ChatGPT OAuth（localhost:1455） | ✅ `codex-chatgpt`（OAuth + Responses + 实时目录） | ✅ 已改进（§3.1） |
| `antigravity` | Gemini / Google OAuth | ✅ `antigravity`（+ 图片预算） | ✅ 已改进（§3.2） |
| `command-code` | Anthropic/OpenAI 双轨按模型 id 路由 / 浏览器 OAuth 或 API Key | ✅ `commandcode` + `commandcode-messages`（+ 浏览器登录 + 实时目录） | ✅ 已改进（§3.3） |
| `kimi-code` | Anthropic Messages / RFC 8628 设备码 | ✅ `kimi-code-plan`（+ 设备码登录 + 凭据续期 + K3 保留思考） | ✅ 已改进（§3.4） |
| `minimax-code` | Anthropic Messages / 桌面端凭据复用或设备码（`agent.minimax.cn/mavis`） | ✅ `minimax-code`（与平台 API Key 线路 `minimax-token-plan` 并存） | ✅ 已新增（§4.2） |
| `claude-subscription` | Anthropic Messages / Claude Pro·Max OAuth | ✅ `claude-subscription`（与 API Key 的 `claude` 并存） | ✅ 已新增（§4.3，合规风险已标注） |
| `workbuddy-subscription` | OpenAI 兼容（仅流式）/ 桌面凭据扫描或浏览器授权 | ✅ `workbuddy-subscription` | ✅ 已新增（§4.1） |
| `ollama` | — | ✅ `ollama` | **按要求排除** |

## 3. 已有线路的改进点

### 3.1 `codex-chatgpt`（优先级 P1）✅ 已落地

现状：`client/extension/ai/codex/oauthService.ts`（OAuth 登录/刷新/wham 额度）+ `aiService.callOpenAIResponses` 的 `codexCompatibility` 分支（已做到：不发 `max_output_tokens`、`store:false`、`reasoning.encrypted_content`、`prompt_cache_key`、401 强制刷新重试一次）。

参考项目已验证、我们缺失的：

1. **缺 `openai-beta: responses=experimental` 请求头** —— 订阅后端在 beta 标志下提供，官方 Codex CLI 始终发送；上游收紧后缺它会变成 400/403。在 `callOpenAIResponses` 的 codex 分支加该头。
2. **模型目录静态**（`CODEX_CHATGPT_MODELS`）——参考项目实时拉取 `GET /backend-api/codex/models`，按账号缓存并持久化快照；静态表降级为兜底。目录同时提供每模型的上下文窗口 / 默认 verbosity / 支持的能力，避免按模型名猜测。
3. **推理摘要默认值**：我们现在 `onThinking` 开启时默认发 `reasoning.summary: 'auto'`（aiService.ts:667），而官方目录声明 `default_reasoning_summary: none`——摘要属于计费生成，每轮白耗额度。改为**默认省略**，仅用户显式选择时发送。
4. **输出 verbosity 默认值**：官方客户端每轮发目录里的 `default_verbosity`（当前为 `low`）；我们未配置时不发 `text`，服务端按隐含的 `medium` 回答（更啰嗦也更贵）。改为对目录声明支持的模型默认发 `low`。
5. **`x-codex-turn-state` 多轮续传**：回传响应头里的 turn state 以续接该轮；后端不再下发时立即停止回送。
6. **上下文/输出预留按系列区分**：GPT-6 系列有效上下文 384K（可配至 872K）、输出预留 128K 仅用于本地压缩判断（请求仍不带 `max_output_tokens`，此项我们已合规）。当前固定 272K 偏小。

### 3.2 `antigravity`（优先级 P2）✅ 已落地（1、2）

现状：`antigravity/oauthService.ts` + `api.ts` + `models.ts`，已有多端点 failover、模型发现（`fetchAvailableModels`）、配额解析、图片输入。

可吸收项：

1. **图片体积预算**：参考项目对单请求图片 base64 负载设上限（12 MiB），超出时最旧图片按上游占位文案降级为文本，避免整条请求被体积上限拒绝且降级可见。核对我们 `visionAdapter.ts` 现有行为后补齐。
2. **流终结检测**：上游必然以 `finish_reason` 或 `data: [DONE]` 结束，两者皆缺即视为连接中断而报错，不把半截文本当完整回答（核对我们 Gemini 流路径是否已有等价校验）。
3. **多账号号池**（顺序耗尽/轮询/粘性、429 冷却换号）——参考项目的大特性；工程量大，列为**可选 P4**，不单独立项不阻塞其他项。

### 3.3 `commandcode` / `commandcode-messages`（优先级 P1）✅ 已落地（1、2）

现状：仅 API Key；`commandcode/accountService.ts` 已有 `/alpha/whoami`、billing、usage 额度面板；模型表静态。通用发现 `buildModelsRequests` 已能打 `{endpoint}/models`。

可吸收项：

1. **浏览器 OAuth 登录**：复刻官方 CLI 回环回调契约（`127.0.0.1:5959` 起顺延，`/callback` 接受 Studio 页面跨域 POST），与手动粘贴 API Key 并存；两条路径都先 `/alpha/whoami` 验证再加密保存。
2. **实时目录的 `context_length`**：拉取 `/provider/v1/models` 后把每模型 `context_length` 作为默认上下文窗口（可逐模型覆盖），供压缩与溢出判断。
3. **逐模型能力表**：图片输入与思考档位按表查询而非按厂商/模型名前缀推断（参考项目实测同厂商内部自相矛盾）。✅ 已落地：转录官方 CLI 注册表（85 个模型）。
4. **双 Provider 拆分维持现状**：参考项目是单 Provider 按模型 id 自动选 Anthropic/OpenAI 线路；我们拆成 `commandcode` / `commandcode-messages` 已发布且有用户数据，不合并，仅在设置文案中说明分工。

### 3.4 `kimi-code-plan`（优先级 P2）✅ 已落地（1、2）

现状：API Key + OpenAI Chat Completions（`api.kimi.com/coding/v1`），静态模型表 `k3` / `kimi-for-coding` / `kimi-for-coding-highspeed`。

可吸收项：

1. **RFC 8628 设备码登录**（`auth.kimi.com`）：无需回调端口；`slow_down` 调宽轮询、设备码过期自动重申请；与 API Key 并存。
2. **K3 线路规则**（按官方文档）：
   - 思考档位只发 `low/high/max`（其余收敛映射）；关闭发 `thinking:{type:"disabled"}`，开启发 `{type,effort,keep:"all"}`；
   - 开启思考时每条 assistant 消息回传 `reasoning_content`（无推理回传空串，否则 400）；
   - 不发 `temperature`；工具调用 id 截断 64 字符；`stop` 裁剪为 ≤5 条且每条 ≤32 字节；
   - **请求体超 2 MB 本地拒绝**（该端点最常见 400 就是 `total message size ... exceeds limit 2097152`），报错中给出可操作提示。
3. **实时目录**：运行时以 `GET /v1/models` 为准，静态表兜底；`k3` 默认按 256K 计、可覆盖到 1M。

## 4. 新增线路

三条新线路共用的落点（§5 详述）：`BUILTIN_PROVIDERS` 增加条目、`types.ts` 的 `authKind` 扩枚举、`getProviderApiFormat` 映射、`aiService` 鉴权头与分发、`chatSettings` 登录/账号状态、webview 设置卡片与额度组件、`messages.ts` 与 `chat/i18n.ts` 中英双语。

### 4.1 `workbuddy-subscription`（腾讯 WorkBuddy / CodeBuddy，优先级 P2）✅ 已落地

- 协议：OpenAI 兼容 `POST {backend}/v2/chat/completions`，两条硬约束：**仅流式**（`stream:false` → 400 `code 11101`）、**首条消息必须是 system**（否则 400 `code 11128`）——请求构造器始终 `stream:true` 并在缺系统提示时补中性 system。
- 登录：扫描 CodeBuddy 桌面端 `*.info` 凭据（只读优先、续期后原子写回），或设置页选国区/国际区走官方浏览器授权；凭据存 VS Code SecretStorage。
- **区域是凭据属性**：`*.workbuddy.ai` / `*.codebuddy.ai` 走国际区，其余走国区 `copilot.tencent.com`；模型目录、额度、对话跟随当前账号区域，模型选择器按区域过滤（跨区发模型 → 400 `code 11102`）。
- 模型目录：取自网关 `/v3/config`（含真实上下文/输出上限、图片能力、思考档位表），内置表仅作离线兜底；`/v1/models` 在该线路是 404，**不要**走通用发现。
- 额度：`/billing/meter/get-user-resource`。
- 桌面账号不可删除（只能在本扩展中隐藏/恢复），与参考项目做法一致。

### 4.2 `minimax-code`（MiniMax Code 编程订阅，优先级 P2）✅ 已落地

与现有 `minimax-token-plan`（平台 API Key）**并存**，两者凭据互不通用。

- 协议：Anthropic Messages，`https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`（国际区 `.io`），**只用 `Authorization: Bearer`**（`x-api-key` 一律 401，不做回退分支）。
- 登录：优先只读复用桌面端 `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`（有效期 >5 分钟直接用；进入续期窗口才轮换且原子替换；绝不创建/删除 `auth.lock`）；无桌面凭据时用 RFC 8628 设备码登录，凭据存 SecretStorage。登出只删我们自己那份。
- 模型目录**硬编码**：该端点 `GET /v1/models` 对订阅流量返回 503，目录取自官方客户端 `config.yaml` 模型表（M2.7 / M2.7 HighSpeed / M3 / M3.1 Flash Preview）。
- 思考形态三态：M2.7 恒定开启无档位（不发字段）；M3 开关二态；M3.1 强制开启可指定档位。未知档位回落目录默认。
- 令牌生命周期：access token 约 1 小时、refresh token 单次使用——续期提前 5 分钟、同进程单飞、轮换后先读回校验再落盘；401 先强制续期一次再原样重试，再拒才是终局。
- 请求体上限用本线路自己的 64 MB（**不要**复用 Kimi 的 2 MB 常量）；图片预算独立（参考项目曾因复用 Kimi 数字把合法截图静默替换成占位文本）。

### 4.3 `claude-subscription`（Claude Pro / Max，优先级 P3）✅ 已落地

> ⚠️ Anthropic 现行条款不允许第三方应用以 Free/Pro/Max 凭据转发请求，已有账号被限制的公开报告。参考项目也未获授权。**实施前需要用户明确拍板**；若做，设置卡片需显著风险提示。

- 协议：Anthropic Messages + 订阅 OAuth（PKCE，state 与 verifier **独立**生成；手动粘贴为主、可选 loopback 回调绑 `127.0.0.1` 顺序探测端口）。
- 身份模拟（参考项目实测必需）：`Authorization: Bearer` 且 `x-api-key` 缺省、`user-agent: claude-cli/<版本>`、`x-app: cli`、`anthropic-beta` 至少含 `oauth-2025-04-20` 与 `claude-code-20250219`、`system` 首块为 Claude Code 身份声明。
- 思考形态四类（`mid-convo` 优先且带 `block_binding`，需追加 `thinking-binding-controls` beta）；带签名的思考块原样回放，无签名丢弃。
- 刷新单飞、轮换后读回校验；额度主来源 `GET /api/oauth/usage`，辅以响应头 `anthropic-ratelimit-unified-5h-utilization`。
- 提示缓存 TTL 可选（跟随官方 / 1 小时 / 5 分钟；1 小时需 `extended-cache-ttl-2025-04-11` beta）。

## 5. 我们项目的架构落点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| Provider 注册 | `client/extension/ai/providers/models/defaults.ts` | `BUILTIN_PROVIDERS` 增加 `workbuddy-subscription`、`minimax-code`、（可选）`claude-subscription` |
| 类型 | `client/extension/ai/types.ts` | `authKind` 扩：`'kimi-device-oauth' | 'minimax-code-oauth' | 'workbuddy-oauth' | 'claude-subscription-oauth'`；账号状态类型 |
| 协议路由 | `client/extension/ai/providers.ts` | `getProviderApiFormat`：`minimax-code`/`claude-subscription` → `anthropic-messages`；`workbuddy-subscription` → `openai-chat-completions`（强制流式 + 首条 system 在请求构造处保证） |
| 请求层 | `client/extension/ai/aiService.ts` | 鉴权头分派（OAuth 线路走各自 service 而非 `buildAuthHeaders`）；k3 线路规则；codex 的 beta 头 / 目录驱动默认值 / turn-state |
| OAuth 服务 | 新增 `client/extension/ai/kimi/oauthService.ts`、`minimaxcode/oauthService.ts`、`workbuddy/oauthService.ts`、（可选）`claudesub/oauthService.ts` | 仿照 `codex/oauthService.ts`、`antigravity/oauthService.ts`：SecretStorage 存 token、PKCE、单飞刷新、可取消登录 |
| 模型目录 | 各线路 `modelCatalog.ts` | 实时拉取 + SecretStorage/globalState 快照 + 静态兜底（minimax-code 例外：纯硬编码） |
| 设置与额度 UI | `chatSettings.ts`、`chatHtml.ts`、`client/webview/chat/`（仿 `codexQuota.ts` / `antigravityAccount.ts` / `commandcodeQuota.ts`） | 登录按钮、账号卡片、额度胶囊 |
| 国际化 | `client/extension/ai/messages.ts`、`client/webview/chat/i18n.ts` | 中英同步新增 |
| 代理 | `subscriptionProxy.ts` | 新线路请求统一走 `SubscriptionProxyService.fetch`（现有订阅代理设置直接生效） |

通用约束（来自 AGENTS.md）：错误上报用 `ErrorReporter`；外部响应一律 `isRecord` 收窄；保留 AbortSignal/超时语义；缓存有界；确定性行为。

## 6. 分期实施

| 期 | 内容 | 状态 | 风险 |
| --- | --- | --- | --- |
| P1 | §3.1 codex 改进（beta 头、实时目录、summary/verbosity 默认对齐、turn state、家族窗口）；§3.3 commandcode OAuth + 目录 `context_length` | ✅ 已完成 | 低：协议细节均有参考项目实测背书 |
| P2 | §3.2 antigravity 图片预算；§3.4 kimi 设备码 + 凭据续期 + K3 保留思考；§4.1 workbuddy；§4.2 minimax-code | ✅ 已完成 | 中：新 OAuth 流程与桌面凭据复用需真机验证 |
| P3 | §4.3 claude-subscription（Claude Pro/Max OAuth） | ✅ 已完成（用户确认合规取舍后实现） | 合规风险，卡片显著标注 |
| P4 | 多账号号池抽象（内核 + antigravity 接入 + 设置面） | ✅ 已完成 | — |

### P1 交付明细

- **codex**：新增 `codex/modelCatalog.ts`（实时目录 + 按账号缓存 + 快照兜底）与
  `codex/turnState.ts`（账号作用域、有界、即取即清的 `x-codex-turn-state`）；
  `oauthService.ts` 统一订阅请求头（含 `openai-beta: responses=experimental`）；
  `buildOpenAIResponsesPayload` 按目录默认发 `text.verbosity`（未建立支持则不发）；
  推理摘要不再默认发送；GPT-6 家族按 384K 起算、上限 872K，GPT-5.6 保持 272K；
  设置页把目录窗口合入 `modelContextTokens`。
- **commandcode**：新增 `commandcode/oauthService.ts`（Studio 回环回调：CORS/私有网络
  预检、5959 起顺延、完成页宽限、state 校验、验证后才保存）与
  `commandcode/modelCatalog.ts`（公开目录的 `context_length` 作为上下文窗口默认值）；
  设置页新增「浏览器登录」按钮，手动粘贴路径保留。
- **测试**：新增 `codexCatalog.test.ts`、`commandcodeOAuth.test.ts`；
  更新 `codexOAuthService.test.ts`、`aiServiceTimeout.test.ts`、`providers.test.ts`。
- **验证**：`npm run lint`（0 error）、`npm run compile`、`npm run typecheck:test`、
  `npm run test:unit`（2632 + 44 passing，0 failing）。
- **决策记录**：`.agents/notes/implemented/feature/2026-10-04-codex-subscription-catalog-and-wire-alignment.md`、
  `.agents/notes/implemented/feature/2026-10-04-commandcode-browser-login-and-catalog.md`。

### P2 交付明细

- **antigravity**：新增 `antigravity/imageBudget.ts`（12 MiB 请求图片预算，最旧优先替换为
  模型可见占位，只作用于本次请求）；流终结校验核对确认已存在，无需改动。
- **kimi**：新增 `kimi/oauthService.ts`（RFC 8628 设备码登录）、`kimi/tokenStore.ts`
  （`max(300s, expires_in×0.5)` 续期窗口、刷新单飞、终局拒绝冷却）、`kimi/accountStatus.ts`；
  `sanitizeRequest` 为 K3 家族在每条 assistant 消息上写 `reasoning_content`（无推理写空串）。
- **workbuddy**：新增 `workbuddy/types.ts`（区域/后端/档位收敛）、`credentials.ts`（桌面
  扫描、托管存储、原子写回、桌面账号不可删除）、`client.ts`（网关请求 + 浏览器授权）、
  `modelCatalog.ts`（`/v3/config` 实时目录）、`accountStatus.ts`；请求侧强制 `stream: true`
  与首条 system。
- **minimax-code**：新增 `minimaxcode/types.ts`（硬编码目录 + 三态思考控制 + 本线路自己的
  body/image 预算）、`credentials.ts`（桌面复用 + 原子写回 + 双区域探测）、
  `oauthService.ts`（设备码 PKCE S256 + 5 分钟续期窗口）；端点只用 bearer，无 x-api-key 回退。
- **测试**：新增 `workbuddySubscription.test.ts`（30 例）、`minimaxCodeSubscription.test.ts`
  （22 例）、`kimiCodeOAuth.test.ts`（23 例）、antigravity 图片预算块（5 例）；更新
  `providers.test.ts` 的协议覆盖与必需字段契约。
- **验证**：`npm run lint`（0 error）、`npm run compile`、`npm run typecheck:test`、
  `npm run test:unit`（2713 + 44 passing，0 failing）。
- **决策记录**：`.agents/notes/implemented/feature/2026-10-04-antigravity-request-image-budget.md`、
  `2026-10-04-kimi-code-subscription-login-and-token-lifecycle.md`、
  `2026-10-04-workbuddy-subscription-line.md`、
  `2026-10-04-minimax-code-subscription-line.md`。

### 已知待办（非阻塞）

- 三条新 OAuth 流程（workbuddy / minimax-code / kimi 设备码）与桌面凭据复用均以单元测试
  锁定契约，但**真机账号验证**尚未进行；建议在有对应订阅的机器上各跑一次登录 + 一轮对话。

每期完成后：更新 `.agents/notes/implemented/feature/` 笔记（简体中文）、README 供应商章节中英双语、按需 `npm run build:docs`。

## 7. 验证

- `npm run compile` + `npm run typecheck:test`；
- 新增逻辑配单元测试（请求体构造、目录解析、错误分类、刷新单飞），跑 `npm run test:unit` 中相关套件；
- OAuth 流程用本地回调模拟与真实账号各验一次；额度/目录失败路径要求 fail-open（卡片显示错误，不影响对话）；
- 每条新线路对照参考项目 README 的「实测行为」清单逐项核对（状态码分类、硬约束、字段禁忌）。

## 8. 风险与合规

- `claude-subscription` 与 Anthropic 条款冲突（见 §4.3）；`antigravity` 已有账号被限制的公开报告——设置页保留风险提示。
- 桌面端凭据（WorkBuddy `*.info`、MiniMax `auth.json`）**只读优先**；续期写回必须原子且只改 `auth` 块；绝不删除/撤销桌面端登录态。
- 所有 token 只进 VS Code SecretStorage，不写设置文件、不进 webview。### P3 交付明细

- **新增** `claudesub/types.ts`（协议常量 + 转录的模型目录 + 三态/四形态思考控制 + 版本下限
  与全域比较）、`claudesub/credentials.ts`（凭据存储、单飞续期、`user:inference` 校验）、
  `claudesub/oauthService.ts`（PKCE 登录、令牌兑换与分类、身份头与 beta 集合）。
- **身份约束**（订阅令牌要求请求完整模仿 Claude Code）：`Bearer` 且 `x-api-key` 缺省、
  `user-agent: claude-cli/<版本>`、`x-app: cli`、必需的 beta 集合、系统数组首条为身份声明。
- **思考形态四类**按模型表决定：`mid-convo` / `adaptive` / `budget` / `none`；目录里
  `claude-opus-5-5` 用 `adaptive`（避免强制 high 压过其 medium 默认），`claude-sonnet-5-5`
  保持 `mid-convo`。
- **PKCE 的 state 与 verifier 独立生成**（参照实现把 verifier 当 state，会把秘密写进 URL）。
- **设置卡片在按钮之前显著标注合规风险**；按量计费的 `claude` 线路不受影响。
- **测试**：新增 `claudeSubscription.test.ts`（29 例）；更新 `providers.test.ts` 的协议覆盖。
- **决策记录**：`.agents/notes/implemented/feature/2026-10-04-claude-subscription-line.md`。

### 全部完成状态（P1 / P2 / P3）

| 项 | 状态 |
| --- | --- |
| P1 codex-chatgpt + commandcode | ✅ 完成 |
| P2 antigravity + kimi + workbuddy + minimax-code | ✅ 完成 |
| P3 claude-subscription | ✅ 完成 |
| P4 多账号号池抽象 | ✅ 完成 |

> 唯一**非阻塞**待办：三条新 OAuth 流程（workbuddy / minimax-code / claude-subscription）与
> kimi 设备码、桌面凭据复用均以单元测试锁定契约，但**真机账号验证**尚未进行；建议在有对应
> 订阅的机器上各跑一次登录 + 一轮对话。### P4 交付明细（多账号号池）

- **内核**：新增 `client/extension/ai/pool/accountPool.ts`——provider 无关的号池，含存储、
  序列化、可调度性、三种轮转策略、429 冷却与账号级失效保留。各线路只提供少数钩子。
  两处实现细节是缺陷修复：**单飞续期**（并发共用一次轮换，否则除第一个外全部拿到作废令牌）、
  **`AccountPoolStore` 返回 `Thenable`**（匹配 VS Code 的 SecretStorage）。
- **Antigravity 接入**：新增 `antigravity/accountPool.ts`；`oauthService.ts` 的
  `getRequestContext` 改为从号池取账号并返回 `accountId`；**项目缓存按账号隔离**（原先的
  无键缓存会在轮转后把前一个账号的 project 交给下一个）；登录入池、登出清池、续期绑定会话
  信号；`callAntigravity` 支持 401 强制续期与 429 换号（上限 3 次尝试）。
- **设置面**：Antigravity 卡片新增调度策略选择器与账号列表（主账号标记、冷却倒计时、
  失效提示、「设为主账号」/「清除冷却」按钮）；协议链为 `setAntigravityPoolStrategy` /
  `setAntigravityPrimary` / `clearAntigravityCooldown` + `settingsData.antigravityAccount.pool`。
- **测试**：新增 `accountPool.test.ts`（28 例）+ `commandCodeCapabilities.test.ts`；
  更新 `antigravity.test.ts`（并发用例断言新契约）与 `providers.test.ts`（能力按表）。
- **验证**：`npm run lint`（0 error）、`npm run compile`、`npm run typecheck:test`、
  `npm run test:unit`（**2780 + 44 passing，0 failing**）。
- **决策记录**：`.agents/notes/implemented/architecture/2026-10-04-multi-account-pool-core-and-antigravity.md`、
  `feature/2026-10-04-commandcode-per-model-capabilities.md`。

### 全部剩余项状态

| 项 | 状态 |
| --- | --- |
| commandcode 逐模型能力表 | ✅ 完成（85 个模型，逐精确 id 查表） |
| P4 多账号号池（内核 + antigravity + 设置面） | ✅ 完成 |

> 唯一**非阻塞**待办仍是真机验证：三条新 OAuth 流程（workbuddy / minimax-code /
> claude-subscription）、kimi 设备码、桌面凭据复用与多账号轮转均以单元测试锁定契约，
> 但尚未在真实订阅账号上端到端跑过。

### 号池全线路接入（本轮）

P4 的内核此前只接了 Antigravity（计划里的起点）。本轮把**其余全部线路**接上：
codex-chatgpt、kimi-code-plan、workbuddy-subscription、minimax-code、claude-subscription、
commandcode（静态 API Key）。

- **新增 `pool/oauthAccountPool.ts`**：provider 无关的「OAuth 凭据号池」工厂。六条线路的凭据
  形状是同构的，差异只在身份键、别名、续期与失败分类；工厂统一处理旧单凭据迁移、主账号镜像
  与账号生命周期，避免六份重复适配器各自漂移。
- **新增 `pool/subscriptionPools.ts`**：各线路的凭据解析与身份键（Claude uuid/email、
  MiniMax 区域+记录槽、WorkBuddy uid/uin/名、Kimi 令牌 userId/email、Codex accountId、
  Command Code userId/email/key 名）。
- **新增 `pool/poolRegistry.ts`**：provider → 号池的注册表，含**幂等 seed**（桌面端账号每次
  选择前并入池子，同一身份原地更新）。
- **antigravity** 改为复用同一工厂（删掉自己那份实现），行为与其余线路一致。
- **请求路径**：OpenAI 兼容流式路径与 Responses 路径都接入 429 冷却换号 + 401 强制续期；
  账号集合排除本次已尝试的账号；`Retry-After` 被解析并夹取上限。
- **设置面**：新增通用「账号池」区块（策略选择器 + 账号行：主账号标记、冷却倒计时、失效
  提示，以及「设为主账号」/「清除冷却」/「移除」），对任何已接池的线路生效。
- **测试**：新增 `subscriptionPools.test.ts`（24 例）、`poolSeeding.test.ts`（3 例）、
  `poolRegistry.test.ts`（4 例）；总计 **2811 + 44 passing，0 failing**。
- **验证**：`npm run lint`（0 error）、`npm run compile`、`npm run typecheck:test`、
  `npm run test:unit` 全通过。

#### 修复的真实缺陷（接入多账号时暴露，含实机反馈定位的四处）

1. **续期单飞是全局的，不是按凭据的**：Codex 与 Claude 的 store 用一个全局 promise 槽位，
   单账号时无害；一旦池里有第二个账号，账号 B 会拿到账号 A 的续期 promise 并**收到 A 的
   凭据**。两处都改为按 refresh token 归类；Codex 的池内续期还改为**不写单凭据槽位**
   （否则会覆盖另一个账号）。
2. **`expiresAt: 0` 被误读为「永不过期」**：epoch 0 是**过去**，而 Antigravity 的测试凭据
   正是用它表示已过期。误读会让一个死令牌继续服役。改为只把「未声明到期」视为不过期。
3. **seed 漏掉托管存储**：WorkBuddy / MiniMax Code 的 seed 只扫描桌面端文件，因此「只用本
   插件登录过」的情形读出**空池**——卡片照常显示该账号，号池区却隐藏，且该账号从不参与
   调度。改为两个来源合并（桌面扫描 + 托管存储）。
4. **设置面只推送已保存 provider 的池**：在未保存的表单里切换 provider 时，号池区停留在
   上一条线路上。改为一次推送全部线路，并按**下拉框当前值**取用；池动作（策略/主账号/清除
   冷却/移除）也随之带上 `providerId`，避免改动已保存的另一条线路。
5. **Codex 登录不入池**：其余线路都在登录回调里入池，Codex 只写单凭据槽位，第二个 ChatGPT
   账号因此存下来却永远无法参与轮转。已补上登录后入池。
6. **Codex 的号池区永不可见**：区块渲染调用位于 `isCodex` 分支的提前 `return` 之后，改为
   在所有分线路分支之前渲染。
7. **别名 id 各建一个池**：Command Code 两条线路共用一把 Key，却各自建池写同一槽位，后写
   的那次会丢掉前一条线路刚加的账号。新增 `poolId` 让它们共用一个池实例。
8. **WorkBuddy 模型下拉框为空**：内置表不列该线路模型，而实时目录此前只被用来取上下文
   窗口。改为用目录同时填充模型列表。
9. **登录控件在有账号后被隐藏**（用户实机反馈：除 WorkBuddy / MiniMax 外，其余线路登录一个
   账号后无法再登录第二个）。多账号池要求登录控件保持可用，现在它改称「再添加一个账号」。
   WorkBuddy / MiniMax 本来就没隐藏，这正是只有它们能加第二个账号的原因。
10. **额度从未展示**：`workbuddyQuotaStatus` 元素一直存在却无人渲染，号池行也没有额度。
   已接入六条线路各自的额度面（见下）。
11. **MiniMax 一次登录变成两个账号**（用户实机截图）：`MinimaxCodeCredentialStore.save()` 只
   持久化 4 个字段、**没有 `recordKey`**，于是托管凭据算不出身份键，`addAccount` 永远匹配不到
   它自己 seed 进来的那一行。托管存储是**单槽**，因此该槽即身份（`managed:<region>`）。
12. **Codex 模型选择器只剩一个不可用选项**（用户实机截图：下拉里只有 `codex-auto-review`）。
   订阅目录里混进了**代码评审**专用 slug，而「目录非空即采用」的规则让它成了列表里唯一的
   模型。参照实现明确记录过这个套餐形态。两条规则：评审类 slug 不算对话模型；**一份无法满足
   选择器的目录不允许把选择器清空**——此时由内置表作答。
13. **旧号池文档不会被新身份键修复**：只补身份键只防新重复，已写下的两行还在。因此内核
    `read()` 按去重键收敛重复行（主账号标记转移、粘性指针清除），下一次写入即持久化。

### 与参照实现的逐条比对审计（本轮）

按线路把参照实现（`dsh-chatgpt-subscription`）的每一条特殊约束与本项目对照，每条都要求在两边
找到真实代码才算「已迁移」。审计与修复结果：

**本轮据此修复：**

| 问题 | 线路 | 后果 |
| --- | --- | --- |
| 2 MB 请求体上限未实现（计划声称已完成） | kimi | 该端点最常见的 400，用户无从下手 |
| GPT-6 家族缺少**线路层**的 effort 兜底 | codex | 旧会话残留的 `none`/`minimal` 会被拒 |
| 续期提前量声明了但号池未采用 | minimax-code | 每小时边界变成失败轮次而非透明轮换 |
| 缺少 401 强制续期 + 原样重放 | minimax-code | 同上 |
| 续期失败不带状态码 | workbuddy | 死账号永不退出轮转 |
| 该线路从未请求 usage trailer | workbuddy | 完全没有 token / 成本统计 |
| 工具名用 `+=` 累加 | 全线 | 重发名字的网关拼出永不派发的工具名 |
| `adaptive` 思考形态不带 `block_binding` | claude-subscription | opus-5-5 等模型在前缀被编辑后每轮 400 |
| 从不发送 `max_completion_tokens` | commandcode | GPT 家族模型每请求 400 |
| k3 按 1M 预算 | kimi | 超出套餐权益时服务答 **401**，长会话硬失败而非压缩 |
| 溢出文案不匹配 | kimi | 上下文溢出不被识别，直接失败而不压缩 |
| 强制发送 `temperature` | kimi | 每轮一次确定会失败的 400 往返 |

### 审计发现已全部落地（第二轮）

第一轮只修了会**硬失败**的十二项。第二轮把审计确认的其余项做完：

- **图片预算按线路统一实现**：Anthropic 8 MB + 8000 px 长边（图片超过 20 张时收紧到 2000 px）、
  kimi 1.5 MB（对 2 MB 整包）、antigravity 12 MB。长边那条最要命：历史保留每一张图，长会话
  只能加不能减，越过收紧线之后每轮 400 且本地无法补救。
- **WorkBuddy 身份来自令牌**：在凭据被解析时（即任何账号键被计算之前）读取 `sub` 回填 uid。
  账号资料端点是一次 best-effort 请求，失败时凭据只剩显示名，同一账号就存成两行。
- **统一的失败分类驱动换号**：死凭据停用该账号、账号级限额按账单周期量级冷却、无标签的 429
  保持全局（对着全局限流换号只会白白烧掉整个号池）。Claude 线路此前**完全没有**账号级处理。
- **WorkBuddy 每日签到**：请求契约 + 幂等调度器 + 原子当日状态 + 卡片行与手动执行。国区专属——
  国际区账号没有该活动，卡片若声称「已签到」就是声称了一件没发生的事。
- **kimi 实时目录**：模型清单与逐模型窗口都来自服务端，按**请求路径实际使用的账号**缓存。
  随包表无法知道发布后新增的模型，也无法知道这个套餐解锁了哪些。
- **Claude 缓存断点落在最后一条 user 消息**：断点必须落在把历史带到下一轮的位置上；打在倒数
  第二条上，下一轮它变成最后一条，那一整段历史被当作新输入重新计费，而命中率归零看不出异常。
- **出站文本清洗**：NUL 与落单代理项都会让整包 JSON 非法，而落单代理项**留在历史里**，于是之后
  每一个请求都以同样方式失败。
- 其余：截断流不再报成干净结束、`display: summarized`、`max_completion_tokens`、逐模型输出上限、
  Command Code 额度窗口与套餐名、终帧 usage、`keep: all`、`$schema` 剥离、`reasoning_details`。

**仍未做（按影响排序）：**

- **MED**　kimi 国际区（`.ai`）不可达：登录固定走国区主机，配置端点也不参与解析。
- **MED**　MiniMax 轮换竞争：refresh token 单次使用，但同进程并发续期没有去重、没有墓碑、
  拒绝后不回读。
- **MED**　Claude 工具名词表（出站改名 + 入站回映射）与逐请求碰撞检测。
- **MED**　Command Code ZDR 路由与 1 token 探活。
- **LOW**　kimi 视频模态与 `kimi_attach_video` 工具；各线路缓存 TTL 分档、命中最优化与冷缓存提示。

> MiniMax 的**每日签到**未做，且是**刻意的**：参照实现自己记录（`checkin-gateway.ts:14-23`）
> 该网关**拒绝**不带 `yy`/`x-timestamp`/`x-signature` 的请求，也就是必须伪造官方客户端的第一方
> 签名身份。同一个项目在额度读取上选择不伪造（默认关闭），在签到上选择伪造并显式记录了这个取舍。
> 这属于产品决策而非移植缺口，需用户拍板后再做。WorkBuddy 的签到用我们已在发的诚实请求头，
> 可以直接实现。

### 账号额度展示（本轮）

号池的每个账号行下方画该账号自己的额度。额度是展示数据而不是路由状态：不进号池文档、
不影响可调度性，读取失败只让这一行没有数字。按需读取（区块上屏后才发一次请求），按账号
缓存与单飞。

| 线路 | 额度面 | 备注 |
| --- | --- | --- |
| workbuddy-subscription | `POST /billing/meter/get-user-resource` | 多套餐求和；容量与周期计数各成一个仪表 |
| kimi-code-plan | `GET {coding}/v1/usages` | coding 主机；兼容两种形状 |
| claude-subscription | `GET /api/oauth/usage` | `utilization` 是 0-100 百分数 |
| codex-chatgpt | 复用账号状态 `rateLimits` | 不额外发请求 |
| commandcode | 复用账号状态 | 按 Key 记账；只报余额时画成数值 |
| minimax-code | `GET /v1/api/openplatform/coding_plan/remains` | **只带 bearer**，不伪造官方客户端第一方标记 |

### 全部剩余项状态（本轮结束后）

| 项 | 状态 |
| --- | --- |
| commandcode 逐模型能力表 | ✅ 完成 |
| P4 号池：内核 | ✅ 完成 |
| P4 号池：antigravity | ✅ 完成 |
| P4 号池：codex / kimi / claude / minimax / workbuddy / commandcode | ✅ 完成 |
| P4 号池：设置面（通用账号池区块，按选中线路渲染） | ✅ 完成 |
| WorkBuddy 实时目录填充模型列表 | ✅ 完成 |
| 登录控件在有账号后仍可用（可加第二个账号） | ✅ 完成 |
| 各线路账号额度展示（六条线路） | ✅ 完成 |

> 唯一**非阻塞**待办仍是真机验证：各线路的 OAuth 流程、桌面凭据复用与多账号轮转均以单元
> 测试（mock transport）锁定契约，尚未在真实订阅账号上端到端跑过。
