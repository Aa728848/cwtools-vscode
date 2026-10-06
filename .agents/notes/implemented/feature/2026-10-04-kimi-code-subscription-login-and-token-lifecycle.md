# Agent Note: Kimi Code 订阅登录与凭据续期

Status: implemented

## Problem

`kimi-code-plan` 此前只支持手动粘贴 API Key，且缺少该线路自己的协议纪律：

1. **没有订阅登录**。Kimi Code 订阅（`https://www.kimi.com/code`）与 Moonshot 开放平台是
   两套互不通用的系统：订阅的模型接口是 `https://api.kimi.com/coding/v1`，凭据只来自订阅
   OAuth；把开放平台的 Key 用在这里会被判为 `401 Invalid Authentication`。官方客户端走
   RFC 8628 设备码流程，用户此前只能自己去别处取 Key。
2. **K3 的「保留思考」契约未实现**。K3 默认思考且服务端保留整条思考链，因此带工具调用的
   assistant 消息**必须**带 `reasoning_content`；缺失时服务端报
   `thinking is enabled but reasoning_content is missing in assistant tool call message at
   index N`。我们此前只在有非空推理时才发该字段。

## Decision

### 新增 `client/extension/ai/kimi/oauthService.ts`

按 RFC 8628 实现设备码登录，三个必须照抄官方客户端的细节：

- 设备码流程**无需回调端口**，因此无浏览器环境也能手工完成（用户码与一次性链接直接展示）；
- `slow_down` 按 RFC **永久**加宽轮询间隔（不是只跳过一轮），否则会被持续限流；
- 设备码**过期不是终局**：重新申请一份授权继续轮询，让动作慢的用户仍能登录。

身份头抄官方客户端的词表（`x-msh-platform: kimi_code_cli`、`x-msh-version`、设备名/机型/
系统版本、`x-msh-device-id`）。设备 id 稳定且只创建一次；写入失败退化为进程内取值而不是
让登录失败。非可打印 ASCII 的头值被剥除，空值则省略该头。

**设备码换到的令牌对必须完整保存**：只留 access token 会让会话一小时后失效并再次要求
登录；响应缺 refresh token 时直接报错而不是存一个必然过期的凭据。

### 新增 `client/extension/ai/kimi/tokenStore.ts`

凭据存进 VS Code SecretStorage 的独立槽位（`cwtools.ai.kimiCode.oauth.v1`），与手动粘贴
API Key 的槽位**互不覆盖**：

- 续期窗口 `max(300s, expires_in × 0.5)`，抄自官方客户端；
- **同进程单飞**：到期瞬间的一批请求共用一次刷新，否则除第一个之外全部拿到
  `invalid_grant`；
- 401/403 或 `invalid_grant` 是对令牌本身的终局判定，**立即停止**并记入 300 秒冷却，
  不重试（重试永远不可能成功）；429/5xx 才走有界退避；
- 响应未返回新 refresh token 时**沿用旧值**，而不是当作失败。

### 新增 `client/extension/ai/kimi/accountStatus.ts`

设置页状态只做**本地**判断（是否持有会话、是否刚被拒绝），不发网络请求：设置页会频繁
刷新，而「是否登录」不需要问服务端。令牌是否真的还能用，由真正发起对话时的续期结果决定。

### `aiService.ts`

- 持有 `KimiCodeOAuthService` 与 `KimiCodeTokenStore`；
- `getKeyForProvider('kimi-code-plan')` 在 API Key 槽位为空时回落到
  `ensureAccessToken()`：手动粘贴的 Key 优先，订阅会话作为后备；被拒的会话返回空串而不是
  抛错，让调用方看到「未配置凭据」而不是一个续期错误；
- `sanitizeRequest` 新增 `requiresReasoningOnEveryAssistantMessage`：`kimi-code-plan` 的
  K3 家族（`k3`、`kimi-k3` 前缀形式）在 assistant 消息上**总是**写
  `reasoning_content`（无推理写空串）。判定按模型族而不是 provider，所以同线路的 K2 家族
  与其它 provider 的 K3 模型行为不变。

### 设置面

`chatHtml.ts` 新增 Kimi 账户卡片（设备码登录 / 退出账号），仅在 `kimi-code-plan` 时显示；
协议链为 `webviewProtocol.ts` 的 `kimiLogin`/`kimiLogout`、`types.ts` 的 HostMessage 与
`settingsData.kimiAccount`、`bridge.ts` 分发、`chatPanel.ts` 的按钮绑定与状态渲染。
登录成功后刷新设置数据并提示；退出只清除本插件自己那份凭据。

### 回归测试

新增 `client/test/unit/kimiCodeOAuth.test.ts`：设备授权只发 `client_id`、RFC 字段解析、
默认轮询参数、身份头可打印性与稳定性、令牌对必须完整、pending/slow_down/expired 分类、
嵌套错误信封、5xx 不当作 pending、登录保存令牌对、用户码回调、新登录取消旧登录、
凭据完整性校验、续期窗口、轮换保留、单飞、终局拒绝与冷却、瞬时失败重试、退出清理。
`aiServiceTimeout.test.ts` 新增 K3 保留思考的回归块（K3 必带、K2 与其它 provider 不带）。

## Alternatives considered

1. **只支持手动粘贴 API Key**：否决。订阅与开放平台互不通用，用户很难自己拿到正确的
   凭据；设备码流程是官方客户端的方式且无需回调端口。
2. **把设备码凭据存进 API Key 槽位**：否决。凭据会过期、需要续期，而 API Key 不会；
   混在一个槽位里会让「这是不是一个静态 Key」变得无法判断。
3. **只保存 access token**：否决（实现中发现的缺陷）。Kimi 的 access token 会过期，
   只留它等于一小时后必然要求重新登录。
4. **被拒的 refresh token 直接重试**：否决。终局判定重试永远不可能成功，还会把账号
   往墙上撞；改为记冷却并让卡片提示重新登录。
5. **续期窗口沿用 60 秒提前量**：否决。短命令牌会恰好在服务端开始拒收的时刻才轮换；
   官方客户端的 `max(300s, expires_in × 0.5)` 才是正确取值。
6. **按 provider 给所有 assistant 消息补空 reasoning_content**：否决。K2 家族与其它
   provider 没有这个要求，多发的字段可能被拒；判定收敛到 K3 家族。
7. **状态查询顺带验证令牌有效性**：否决。设置页频繁刷新，为一个本地判断付出网络请求
   不值得；真正的可用性由对话请求决定。

## Consequences

- 用户可点「设备码登录」，无需浏览器回调端口即可完成订阅授权；手动粘贴 API Key 仍然
  可用，两者互不覆盖。
- 订阅会话自动续期且并发安全；被服务端拒绝的会话会让卡片提示重新登录，而不是反复撞墙。
- K3 的工具调用轮次不再触发「reasoning_content is missing」400；K2 家族与其它 provider
  的请求体逐字节不变。
- 令牌只进 VS Code SecretStorage，不进设置文件、不进 webview。
