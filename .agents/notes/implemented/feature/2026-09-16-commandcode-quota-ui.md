# Agent Note: Command Code 账户额度与用量进度条 UI

Status: implemented

## Problem
Command Code 供应商（`commandcode` 与 `commandcode-messages`）此前未对齐 Codex（ChatGPT 订阅）的设置页交互体验，缺乏账户额度卡片与可视化进度条。用户在配置 API Key 后，无法在设置面板中直观查看 5 小时窗口配额、周配额、重置时间、当前套餐以及月度/已购/免费余额，同时也缺少一键刷新额度与自动状态感知机制。

## Decision
1. **Extension Host 账户服务与端点收窄**：
   - 新建 `client/extension/ai/commandcode/accountService.ts`，统一拉取 Command Code 只读端点：
     - `GET /alpha/whoami`（获取用户信息与 orgId）
     - `GET /alpha/usage/summary`（调用量与消耗汇总）
     - `GET /alpha/billing/credits`（月度/购买/免费额度及 5 小时/每周 windowLimits）
     - `GET /alpha/billing/subscriptions`（按需附带 orgId 获取订阅计划与状态）
   - 基于 `unknown` 与类型守卫逐层收窄数据；所有端点实行 fail-open 容错降级，任一端点异常仅缺失对应区块；401 或网络不可达降级为不可用，绝不阻塞聊天对话。
   - 实现 60s 内存缓存与进行中请求防抖并发合并。
2. **Webview 配额渲染器（commandcodeQuota.ts）**：
   - 新建 `client/webview/chat/commandcodeQuota.ts`，导出 `buildCommandCodeQuotaHtml`。
   - 窗口配额进度条计算百分比与色阶（>=90% 或 exceeded 呈 critical 红色，>=70% 呈 warning 黄色，其余呈 normal）；严格遵循“窗口缺省表示未上报，绝不画成 0”的原则。
   - 渲染套餐名行及信用额度行（月度/已购/免费余额，未上报字段不显示）；所有字段执行 `escapeHtml` 消毒。
3. **设置数据推送与双向通信**：
   - 在 `client/extension/ai/chatSettings.ts` 的 `buildAndSendSettingsData` 中将 `commandcodeAccount` 纳入下发数据包；将 `commandcode-messages` 补充进 `fetchApiModels` 免 Key 获取模型白名单；对两个 provider 实现 API Key 共享读取与状态感知。
   - 在 `types.ts`、`webviewProtocol.ts` 与 `bridge.ts` 中注册并路由 `refreshCommandCodeQuota` 消息。
   - 在 `chatHtml.ts` 中声明 `commandcodeAccountGroup` 容器，并在 `chatPanel.ts` 中绑定手动刷新按钮与 `updateApiKeyStatus` 分支渲染。

## Alternatives considered
1. **在 Webview 内部直接发起 HTTP 请求拉取额度**：
   - *未采纳理由*：违反 Webview 安全沙箱原则（不得使用 Node/跨域敏感网络调用），且会导致 API Key 泄露至前端 DOM 环境。API Key 必须严格保留在 Extension Host 端。
2. **未上报 windowLimits 时默认显示 0% 进度条**：
   - *未采纳理由*：“未配置/未上报”与“用量为 0”具有截然不同的业务含义。强行绘制 0% 会使用户误以为存在可用配额，因此必须完全不渲染未上报窗口。
3. **为 commandcode 与 commandcode-messages 拆分两套独立卡片与独立缓存**：
   - *未采纳理由*：两者属于同一平台的两种协议接入形式，共享 API Key 和同一账户配额，维护两份卡片会导致状态不一致和重复刷新流量。

## Consequences
- 无论切换到 `commandcode` 还是 `commandcode-messages`，设置页均能统一呈现清晰、安全的账户额度及进度条。
- 支持打开设置面板自动刷新与点击“刷新额度”手动刷新，全链路中英文案完全对齐。
- 新增单元测试 `client/test/unit/commandcodeAccount.test.ts` 全面覆盖正常解析、窗口缺省、异常降级、HTML 转义及百分比计算。
