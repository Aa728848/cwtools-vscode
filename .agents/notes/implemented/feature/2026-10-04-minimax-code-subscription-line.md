# Agent Note: 接入 MiniMax Code 编程订阅线路

Status: implemented

## Problem

**MiniMax Code 编程订阅**此前没有接入。它与已有的 `minimax` / `minimax-token-plan`
（平台 API Key、按量计费）是两套**互不通用**的系统：订阅的模型接口是 Anthropic Messages，
凭据只来自订阅 OAuth 或桌面端登录态，把平台的 Key 或 base URL 用在这里会被拒。

参照实现（`dsh-chatgpt-subscription`）对该订阅做过实测，其中两条结论尤其承重：端点**只用
`authorization: Bearer`**（`x-api-key` 一律 401），以及**模型目录必须硬编码**
（`GET /v1/models` 对订阅流量未开放，返回 503 `direct_route_not_configured`）。

## Decision

### 新增模块

- `client/extension/ai/minimaxcode/types.ts`：协议常量、硬编码目录与思考控制。
  - **目录是硬编码的，而且必须硬编码**：该端点的 `GET /v1/models` 对订阅流量未开放，
    任何「实时目录」都只会是一个必然失败的请求。四个模型（M2.7 / M2.7 HighSpeed / M3 /
    M3.1 Flash Preview）的窗口、输出上限与思考形态逐字转录自官方客户端的模型表，
    **不从不存在的接口推断**；
  - **思考形态按模型表三态实现**：M2.7 系列恒定开启且没有档位（不发送任何字段）；M3 是
    开关二态；M3.1 Flash Preview 强制开启并可指定档位。
    - 官方文档写明深度档位属于**顶层 `output_config.effort`**，**不是** `thinking` 对象；
    - `effort` 的词表**没有 `default` 成员**（省略即 max），所以 `default` 与显式 `max`
      都不上线；未知档位一律不发送而不是猜测；
    - 关闭思考对 M3.1 返回 400，所以「要求关闭」的请求拿不到档位、落到服务端默认。
  - **只声明本线路真的能编码的模态**：模型表给 M3 / M3.1 标了视频输入，但本扩展没有视频
    字节读取器，因此只声明 `text` 与 `image`。声明一个做不到的能力比不声明更糟——DSH 的
    能力闸门、模型选择器与子代理委派都会当它成立。
  - 请求体上限是**本线路自己的 64 MB**，图片预算是**本线路自己的 16 MB**：Kimi 的 2 MB /
    1.5 MB 是为它自己的网关定的数字，用在这里会把合法图片静默替换成占位文本（MiniMax 的
    模型表单图上限就是 10 MB，一张普通截图就超标）。
- `client/extension/ai/minimaxcode/credentials.ts`：桌面端复用与托管存储。
  - 桌面端凭据路径为 `~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`；
  - **只读优先**：仍在有效期（且距到期还有 5 分钟以上）就原样使用；进入续期窗口才轮换，
    并走**原子替换**（临时文件 + rename），失败或中断都让原文件逐字节不变；
  - **不创建、不删除、不等待 `auth.lock`**：那是桌面端自己的刷新锁，第二方碰它就可能
    打断官方客户端的刷新；
  - **读回凭据时以记录里存的区域为准**，而不是拿默认区域覆盖它；两个区域的目录都会被
    探测，因此国际区账号不会因为没有国区文件而「未登录」。
- `client/extension/ai/minimaxcode/oauthService.ts`：RFC 8628 设备码登录（PKCE S256）与续期。
  - **PKCE verifier 与 challenge 是两次独立取值**，verifier 只在兑换时发送，绝不进入授权
    请求（避免把本应保密的 verifier 写进地址栏与浏览器历史）；
  - `slow_down` 按 RFC **永久**加宽轮询间隔；设备码过期**不是终局**，重新申请一份继续；
  - **设备码换到的令牌对必须完整保存**：缺 refresh token 时直接报错，否则会话一小时后
    必然失效并再次要求登录；
  - 续期窗口为**提前 5 分钟**（access token 实测约 1 小时）；被拒的 refresh token 是终局
    并提示重新登录；未返回新 refresh token 时沿用旧值而不是当作失败；桌面端凭据轮换后
    **原子写回原文件**。

### `aiService.ts`

- 凭据解析在 `chatCompletion` 里做一次，bearer 与区域端点都来自同一份凭据；端点按区域
  拼成 `<agentHost>/mavis/api/v1/llm/v1/messages`；
- **没有 x-api-key 回退分支**：实测该端点对 `x-api-key` 一律 401，回退只会在每次请求上
  白花一个往返；
- `toClaudeRequest` 新增 `minimaxCodeModel` 选项：由**模型表**而不是模型名启发式决定
  思考控制，且该分支直接返回、不落入通用 Anthropic 分支（否则会发出服务端不读的
  `thinking` 对象）。

### 设置面

卡片支持设备码登录（展示用户码与一次性链接）、退出账号与账号计数展示。**退出只清除本
插件自己那份凭据**：桌面端的登录态会被续期写回（只读优先），但绝不撤销、绝不删除——
撤销它等于把用户从正在跑的 MiniMax Code 里踢下线。

### 回归测试

新增 `client/test/unit/minimaxCodeSubscription.test.ts`（22 例）：目录窗口与模态声明、
思考控制的三态与「不发 `default`/`max`」、本线路自己的 body/image 预算、端点拼接不出现
双 `/v1`、凭据解析与区域保持、双区域探测、桌面扫描、原子写回、5 分钟续期窗口、托管存储
往返、设备授权的 PKCE（verifier 不上线）、pending/slow_down/expired 分类、缺 refresh token
时拒绝保存、登录保存与用户码回调、新登录取消旧登录、续期轮换与终局判定。

## Alternatives considered

1. **复用 `minimax-token-plan`**：否决。那是平台 API Key 线路，凭据与产品都不同，混用会
   让「这是订阅还是按量」无法判断。
2. **实时拉取 `/v1/models`**：否决（实测 503 `direct_route_not_configured`）。任何实时目录
   都只是一个必然失败的请求。
3. **发送 `thinking` 对象**：否决。该字段是推断出来的、从未被文档化；官方文档明确深度
   档位在顶层 `output_config.effort`，放在 `thinking` 里服务端根本不读。
4. **发送 `effort: 'default'`**：否决。词表里没有 `default` 成员，省略才是「服务端默认」。
5. **声明 `video` 模态**：否决。本扩展没有视频字节读取器，声明一个做不到的能力会让
   能力闸门与子代理委派把它当成成立。
6. **复用 Kimi 的 2 MB / 1.5 MB 预算**：否决（参照实现已记录该缺陷的代价）。字节上限是
   上游网关的属性，不是通用常量；用错数字会**静默**把合法图片换成占位文本，比拒绝更难
   诊断。
7. **PKCE verifier 兼作 `state`**：否决。那会把本应保密的 verifier 写进授权 URL、地址栏、
   浏览器历史乃至剪贴板；本实现是两次独立取值。
8. **只保存 access token**：否决。它约 1 小时过期，等于每次都要重新登录。
9. **删除或撤销桌面端登录态**：否决。那会把用户从正在跑的官方客户端踢下线。
10. **续期窗口用 60 秒**：否决。那正好是服务端开始拒收的时刻；5 分钟才是安全提前量。

## Consequences

- 用户可直接复用 MiniMax Code 桌面端的登录态（只读优先、原子写回），或在没有桌面凭据时
  用设备码登录。
- 思考控制按模型表三态实现，不会把模型没有声明的档位发出去；关闭思考对 M3.1 落到服务端
  默认而不是触发 400。
- 请求体与图片预算使用本线路自己的数字，合法会话不会被本地拒绝或静默降级。
- 退出只影响本插件自己的凭据；桌面端登录态不受影响。
- 令牌只进 VS Code SecretStorage 与桌面端自己的文件，不进设置文件、不进 webview。
