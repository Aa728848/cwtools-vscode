# Agent Note: 侧边栏与独立管理器窗口的状态消息同步追平

Status: implemented

## Problem
聊天侧边栏（chat surface）与独立 Agent 管理器窗口（manager surface）共享同一宿主 `AIChatPanelProvider`，经 `AgentUiBroadcaster` 分发消息。存在两类状态断层：

1. `agentRoutingStatus`（任务模式路由指示）在 4 个发送点经 `postMessageToSurface('chat', …)` 只发侧边栏；但 Webview 端处理器（`client/webview/chatPanel.ts` 共享脚本）没有 surface 门控，两个窗口都具备该 UI，独立窗口永远看不到路由状态。
2. 中途打开（或隐藏后重建）的窗口执行 `_restoreViewState` 时，只恢复消息历史、调度状态、运行快照与待办卡片；`agentRoutingStatus`、`tokenUsage`（token 用量仪表）、`todoUpdate`（任务清单）这类「只发一次、之后不再重发」的状态消息不会补发，导致新窗口与另一侧显示不一致（侧边栏 WebviewView 未开启 `retainContextWhenHidden`，隐藏即销毁，重建时同样受影响）。

## Decision
1. **路由状态改广播**：`resolveTurnAgentProfile` 的 3 处与 `applyModeOverride` 的 1 处 `agentRoutingStatus` 发送统一改为 `this.postMessage(...)` 广播，两个窗口同时应用。
2. **恢复序列补发一次性状态**：`_restoreViewState` 末尾（经其 `send` 闭包，对目标 surface 定向、未指定则广播）追加：
   - 当前话题存在消息时补发 `agentRoutingStatus { phase: 'resolved', schedulingState }`；空话题不补，避免遮盖空白态（Webview 处理器会隐藏 emptyState）。
   - 补发最近一次实际展示过的 `tokenUsage`：chatPanel 新增 `lastTokenUsageMessage` 字段，仅在两处真实发送点（turn 完成、/compact 完成）记录，恢复时原样重放。
   - 根作用域 todo 列表非空时补发 `todoUpdate`（数据源 `agentRunner.toolExecutor.getTodos()`，与 `sendManagerSnapshot` 一致）。
3. **定向发送审计结论**（保留不变）：`runSnapshot` 仅由 manager 专属脚本 `agentManager.ts` 处理；`managerSnapshot` 处理器有 `isManagerShell()` 门控；`_restoreViewState`/`sendManagerSnapshot`/`_syncViewChromeState` 中的 surface 定向属于按 surface 恢复的既有设计。除 `agentRoutingStatus` 外未发现「两侧都有 UI 却定向发送」的消息。

## Alternatives considered
- **在 Webview 端自行缓存最新状态**：否决。Host 是唯一事实来源，Webview 缓存会在销毁重建时丢失，且违反「状态经 Host 恢复序列统一下发」的既有架构。
- **给 UsageTracker 增加「最近一次用量」读取器**：否决。`UsageTracker` 是跨会话聚合统计组件，其记录与「当前 UI 展示的上次请求用量」语义不同；在 chatPanel 记录最后一次实际展示的消息更小、更准确，也不触碰共享文件。
- **恢复时无条件补发 agentRoutingStatus**：否决。空白话题下该消息会隐藏 Webview 的 emptyState 并显示无意义的路由指示，故以「当前话题有消息」为前置条件。

## Consequences
- 中途打开或重建的独立管理器窗口立即追平侧边栏当前显示（路由指示、token 仪表、todo 清单），反之侧边栏重建亦同。
- `agentRoutingStatus` 广播后，两个窗口的路由指示始终一致；Webview 端无需任何改动。
- 恢复补发均为幂等的状态消息，重复恢复不会产生重复卡片或计数。
- 测试：`client/test/unit/agentUiBroadcaster.test.ts` 新增「agentRoutingStatus 广播到达 chat 与 manager 两个 surface」回归断言。
