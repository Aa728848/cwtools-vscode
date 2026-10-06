# Agent Note: 接入 Claude 订阅（Pro / Max）线路

Status: implemented

## Problem

**Claude 订阅（Pro / Max，即 Claude Code 使用的凭据）**此前没有接入：本仓库的 `claude`
线路只支持按量计费的 Console API Key。订阅是**另一个产品**——同一主机服务，但凭据是
**Bearer OAuth access token** 而不是 `x-api-key`，且订阅路由位于 API Key 线路从不发送的
beta 之后。

⚠️ **合规风险（用户已知悉并明确选择实现）**：Anthropic 现行条款明确写明**不允许第三方应用
提供 Claude.ai 登录、也不允许代用户经 Free / Pro / Max 凭据转发请求**，并保留不经预告的
执法权；已有账号因此被限制的公开报告。**本扩展未获 Anthropic 任何授权或认可**，使用风险
由使用者自行承担。设置卡片在按钮之前显著标注该事实。

## Decision

### 新增 `client/extension/ai/claudesub/types.ts`

协议常量与模型目录。三条承重事实：

- **订阅请求必须完整模仿 Claude Code 的身份**，否则会被服务端拒绝或分类判别：
  `authorization: Bearer` 且 **`x-api-key` 必须缺省**（同时携带两者是文档化的 401 成因）、
  `user-agent: claude-cli/<版本>`、`x-app: cli`、`anthropic-beta` 至少含
  `oauth-2025-04-20` 与 `claude-code-20250219`；
- **系统数组的第一条必须是 Claude Code 身份声明**（逐字），调用方的提示词成为第二条；
- **思考形态有四种，顺序决定成败**：
  - `mid-convo` → `{ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }`
    外加 `output_config.effort`（未指定时**强制 high**）；
  - `adaptive` → `{ type: 'adaptive' }`；
  - `budget` → `{ type: 'enabled', budget_tokens }`（预算计入 `max_tokens`，**必须**为回答
    留出至少 1024 token）；
  - `none` → 不发思考字段。

目录里两处**刻意不照抄参照实现**的取舍，都写在代码注释里：`claude-opus-5-5` 用 `adaptive`
而**不是** `mid-convo`（后者会在调用方未指定时强制 high，而该模型的文档默认是 medium，
会让每次请求都想得更狠、计费更贵）；`claude-sonnet-5-5` 保持 `mid-convo`（它的文档默认
就是 high，且思考块绑定前缀，重放需要 `block_binding`）。

版本下限是**观测值而非推断**：`claude-opus-5-5` 被以 `claude_code_version_too_old` 拒绝，
文案点名「2.1.280 或更新」。`CLAUDE_CLI_VERSION` 必须不低于目录中任何 `minCliVersion`，
否则就是一个本包在自己的选择器里展示、却根本调不动的模型。比较是**小巧且全域**的
（畸形输入按 0 而不是 NaN），因为这个检查存在的意义是阻止一个未知声称到达服务端，
会抛错的比较会把配置错误变成崩溃。

### 新增 `client/extension/ai/claudesub/credentials.ts`

凭据存储与单飞续期：

- **PKCE 的 state 与 verifier 独立生成**：`generateClaudePkce` 是两次独立随机抽样。
  参照实现把 verifier 直接当作 OAuth `state`，那会把本应保密的 verifier 写进授权 URL、
  地址栏、浏览器历史乃至剪贴板；有测试断言授权 URL 中**不出现**原始 verifier；
- **刷新是单飞的**：并发请求共享同一次刷新，否则到期瞬间的一批请求会各自轮换刷新令牌，
  除第一个之外全部作废；
- **被拒的 refresh token 进入冷却**：终局判定不该被反复送去撞墙；
- `isClaudeSubscriptionCredential` 要求 `user:inference` scope：缺它的令牌能通过认证，
  但在本 Provider 存在的路由上被拒，fail-closed 地拒绝它比发出必然失败的请求更有用；
- scope 归一化在**线协议边界**完成（RFC 6749 的空格分隔字符串或 SDK 的数组），留下字符串
  会在下游解析成零个 scope，并把一份可用凭据当成「不是订阅凭据」拒绝。

### 新增 `client/extension/ai/claudesub/oauthService.ts`

- `claudeSubscriptionHeaders`：身份约束的**单一实现**，且**无条件丢弃 `x-api-key`**；
- `claudeBetas`：`anthropic-beta` 集合。**头跟着请求体走**——`block_binding` 与一小时缓存档
  都是需要许可的能力，缺标记会被拒，因此从已构建的请求体读出后据此追加；
- 令牌端点分类：401/403 或 `invalid_grant` 等终局错误码**立即停止**（重试永远不可能成功），
  408/425/429 与 5xx 走有界退避；
- **回环回调**：绑定 `127.0.0.1` 并从注册端口起顺延探测（Windows 的动态保留端口段会让
  固定端口 `listen` 失败）；错误的 `state` **只拒绝那一个请求**，不终止正在进行的合法登录；
  已结算的流程再做兑换返回 410 且**不做任何兑换**；
- **兑换要求 refresh token，续期不要求**：一份没有它的订阅凭据永远无法续期，存下它只会
  得到一个看起来已登录、在第一次到期时就死掉的账号；
- 令牌响应的生命周期被夹到 [300, 31_536_000] 秒，**5 分钟续期提前量就写在到期时刻的
  算术里**，因此恰好在边界前开始的请求永远不会携带一个已死的令牌。

### `providers.ts` 与 `aiService.ts`

- `toClaudeRequest` 新增 `claudeSubscriptionModel` 与 `claudeCacheTtl`：由**模型表**决定思考
  形态与是否删除 `temperature`，并在系统数组**开头**插入身份块（缓存标记落在最后一块，
  因为 Anthropic 推荐的形态是「末尾断点缓存其上的全部内容」）；
- 该分支直接返回，不落入通用 Anthropic 分支；
- 端点使用订阅自己的 beta 路由 `/v1/messages?beta=true`（**不是**普通路由的别名）；
- **调用方必须显式传入凭据**：bearer 与请求体的思考形态必须来自同一账号，因此凭据由
  `chatCompletion` 解析一次后作为参数传给 `callClaude`；
- **401 先强制续期一次再重放同一个请求体**：本地看着有效、服务端却拒收的令牌与「真的需要
  重新登录」在状态码上无法区分，重试再被拒才是终局；
- 该线路**刻意不读 API Key 槽位**（一个陈旧的 Key 不该被发到订阅后端），且**排除在通用
  认证 spread 之外**——否则会重新引入 `x-api-key` 并覆盖 bearer。

### 设置面

卡片**在按钮之前**显著标注合规风险，并展示登录状态、脱敏邮箱与账号 uuid 后六位。
协议链为 `webviewProtocol.ts` 的 `claudeSubscriptionLogin`/`claudeSubscriptionLogout`、
`types.ts` 的 HostMessage 与 `settingsData.claudeSubscriptionAccount`、`bridge.ts` 分发、
`chatPanel.ts` 的按钮绑定与状态渲染。按量计费的 `claude` 线路**不受影响**。

### 回归测试

新增 `client/test/unit/claudeSubscription.test.ts`（29 例）：目录思考形态、Opus 5.5 保持
`adaptive` 的取舍、`mid-convo` 的 `block_binding` 与强制档位、未知模型保守回落、版本下限
不变式与全域比较、缓存标记、身份头（含 `x-api-key` 被丢弃与 haiku beta 排除）、
`block_binding` 的 beta 联动、state 与 verifier 独立且 verifier 不上线、端口顺延、scope 归一化
与 `user:inference` 要求、凭据读取、续期单飞与冷却、兑换/续期对 refresh token 的不同要求、
5 分钟提前量、终局与临时错误分类、身份文本逐字。

## Alternatives considered

1. **不做这条线路**：用户在知悉合规风险后**明确选择实现**，因此实现并在卡片显著标注风险。
2. **复用 `claude` 线路的 Provider id**：否决。按量计费与订阅的凭据类型、路由与 beta 都
   不同；分开才能让用户保留一个不受影响的 API Key 线路。
3. **照抄参照实现的 `state: verifier`**：否决。那会把本应保密的 verifier 写进授权 URL 与
   浏览器历史；本实现是两次独立抽样并有断言锁定。
4. **`claude-opus-5-5` 用 `mid-convo`**：否决（目录注释记录了原因）。该形态在调用方未指定
   时强制 high，会压过该模型文档声明的 medium 默认，让每次请求都想得更狠、计费更贵。
5. **无条件发送 `anthropic-beta` 全集**：否决。`block_binding` 与一小时缓存档是需要许可的
   能力，头必须跟着请求体走，否则两者会不一致。
6. **兑换时容忍缺 refresh token**：否决。那会得到一个第一次到期就死、除了重新登录无路可走
   的账号。
7. **只在设置卡片里放一行小字风险提示**：否决。风险是**使用该线路的前置事实**，卡片把
   提示放在按钮**之前**并用醒目样式呈现。
8. **让该线路复用 API Key 槽位**：否决。凭据会过期、需要续期，而 API Key 不会；混在一个
   槽位里会让「这是不是静态 Key」无法判断。

## Consequences

- 用户在设置中登录 Claude 订阅后即可在模型选择器中使用订阅模型；按量计费的 `claude`
  线路不受影响。
- 请求携带完整的 Claude Code 身份（bearer、claude-cli user agent、`x-app: cli`、必需的
  beta 集合），且系统数组以身份声明开头。
- 思考形态由模型表逐模型决定；未知模型不声明任何思考能力、不声明图片支持、使用更小的
  默认窗口——高估能力是那个会硬失败的错误。
- 版本下限在本地预检：低于某模型声明的下限时**在请求发出之前**拒绝，而不是一个既不点名
  模型也不给出所需数字的上游 400。
- 令牌只进 VS Code SecretStorage，不进设置文件、不进 webview；登出只清除本插件自己那份。
- ⚠️ 该线路的使用与 Anthropic 现行条款冲突，且本扩展未获其授权；风险由使用者承担。
