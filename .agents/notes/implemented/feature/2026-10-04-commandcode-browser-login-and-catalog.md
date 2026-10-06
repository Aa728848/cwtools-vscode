# Agent Note: Command Code 浏览器登录与实时模型目录

Status: implemented

## Problem

`commandcode` / `commandcode-messages` 此前只能手动粘贴 API Key，且模型目录与上下文
窗口是编译期常量：

1. **没有浏览器登录**。官方 CLI 走的是 Studio 页面的回环回调（`127.0.0.1:5959` 起顺延，
   Studio 页把刚签发的 Key 跨域 POST 回 `/callback`），用户必须自己到 Studio 复制 Key。
2. **上下文窗口靠内置表猜**。公开的 `GET /provider/v1/models` 对每个模型给出
   `context_length`，那是厂商公布的窗口；内置的 `COMMANDCODE_MODEL_CONTEXT_TOKENS`
   只是快照，新上架模型只能落到通用启发式。

## Decision

### 新增 `client/extension/ai/commandcode/oauthService.ts`

复刻官方 CLI 的回环回调契约，三个细节必须照抄，少一个浏览器就会把凭据卡住：

- 回调必须应答 **CORS 预检**，包括 Chrome 的
  `Access-Control-Request-Private-Network`——公网页面请求本机回环端口会被判为私有
  网络访问，缺该响应头 Studio 的 fetch 直接失败；
- 端口从 CLI 的默认值 **5959** 起顺延探测（端口会随回调 URL 交给 Studio，所以任意空闲
  端口都可用，但从默认值起保持与 CLI 一致）；
- 凭据落地后要**等标签页跳转到完成页**再结算（10 秒宽限），否则导航会被一个已经关闭的
  服务器打断。

其余安全约束：

- 只回显**已知 Studio 来源**的 Origin，未知来源不反射（否则浏览器会放行一个本不该被
  应答的页面）；
- state 不匹配的 POST **直接 403 且不读取**其中的凭据，也不会结算流程——一次伪造请求
  不能顶替正在进行的合法登录；
- 请求体上限 10,000 字节（CLI 同款）。**超限时不 destroy socket**：调用方还要投递 413，
  先拆连接会把可观测的错误变成网络错误，因此改为排空剩余字节；
- 被放弃/超时的尝试必须让等待者结算，否则流程会一直停在 pending 挡住之后每一次登录。

`CommandCodeOAuthService` 只负责回调契约本身：`verifyKey` 与 `saveKey` 由调用方注入，
所以 `/alpha/whoami` 的 HTTP 细节留在 `accountService.ts`。

### 新增 `client/extension/ai/commandcode/modelCatalog.ts`

- `parseCommandCodeCatalog` 解析 `{ data: [...] }` 与裸数组，读
  `context_length` / `contextLength` / `context_window` / `contextWindow` 与
  `supported_endpoints`；非正数窗口视为未声明。
- `loadCommandCodeCatalog` 有 30 分钟 TTL、单飞，**失败返回上一次快照**（可能为空）而
  不是抛错：目录只用于填默认值，读不到不该让设置页打不开。
- `commandCodeContextWindows` 把目录映射成「模型 id → 窗口」。

### 接线

- `aiService.ts` 持有 `CommandCodeOAuthService`：`verifyKey` 用
  `getCommandCodeAccountStatus(key, true)` 验证（`available === false` 即拒），
  `saveKey` 写入 `commandcode` 与 `commandcode-messages` 两个键（两条线路共用同一份
  凭据，沿用既有做法），`openBrowser` 走 `vscode.env.openExternal`；
  新增 `getCommandCodeOAuthService()`。
- `chatSettings.ts`：新增 `loginCommandCode(targetSurface)`——打开浏览器、提示用户在
  浏览器继续，完成后刷新设置数据；新增导入实时目录并把窗口以 `commandcode:<model>` 键
  合入 `modelContextTokens`（逐模型覆盖仍然优先）。
- 协议链：`chatHtml.ts` 的 `commandcodeLoginBtn`、`chat/webviewProtocol.ts` 的
  `commandcodeLogin: noFields`、`types.ts` 的 HostMessage 联合、`chat/bridge.ts` 分发、
  `webview/chatPanel.ts` 的按钮绑定。
- 手动粘贴 API Key 的既有路径**完全保留**：浏览器登录是并行入口，不是替代品。

### 回归测试

新增 `client/test/unit/commandcodeOAuth.test.ts`：Studio URL 形状、state 随机性、端口
顺延探测、CORS 预检（含私有网络头）、只回显已知来源、凭据落地 + 标签页跳转 + 完成页
结算、表单编码、state 不匹配不结算、超限 413、放弃时结算等待者、拒绝授权、
「验证通过才保存」与「验证失败不保存」、新登录取消旧登录，以及目录解析与失败保留。

## Alternatives considered

1. **不做浏览器登录，只保留手动粘贴**：否决。参照实现已实测该契约，用户不必再去 Studio
   复制 Key；手动路径同时保留作为无浏览器/弹窗被拦时的恢复手段。
2. **用 `vscode.env.openExternal` 之外自己 spawn 浏览器**：否决。VS Code 已经提供了
   跨平台且能报告失败的方式，`openExternal` 返回 false 时可以给出可操作提示。
3. **回调成功后立即结算，不等完成页**：否决。标签页还在导航时关掉服务器会让浏览器报错，
   用户看到的是失败而不是成功。
4. **超限请求直接 destroy socket**：否决（实测暴露的缺陷）。调用方要投递 413，先拆连接
   会把响应变成 `SocketError: other side closed`，测试与用户都只能看到一个网络错误。
5. **目录失败时抛错**：否决。目录只填默认值，抛错会让整个设置页打不开；保留上一次快照
   更符合「内置表兜底」的既有语义。
6. **把目录窗口写进 `COMMANDCODE_MODEL_CONTEXT_TOKENS` 常量**：否决。该常量是编译期
   数据，账号/时间相关的值必须走设置页通道。
7. **凭据先存后验**：否决。一个连不上账户 API 的 Key 会顶掉可用的那个；`/alpha/whoami`
   是唯一验证点。

## Consequences

- 用户可点「浏览器登录」完成授权，Key 通过 `/alpha/whoami` 验证后自动保存到
  `commandcode` 与 `commandcode-messages`；也可继续手动粘贴。
- 模型上下文窗口优先采用目录的 `context_length`，新上架模型无需改代码即可获得正确窗口；
  目录读不到时回落到既有内置表与通用启发式。
- 回环服务只在登录期间存在，端口从 5959 起顺延，登录结束（成功/失败/取消/超时）即关闭。
- 回调只应答已知 Studio 来源与匹配的 state；未匹配的 POST 不会读到凭据，也不会结算流程。
