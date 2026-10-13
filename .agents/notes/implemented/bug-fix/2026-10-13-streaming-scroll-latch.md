# Agent Note: 流式输出吸底改为锁存语义并回查排队帧

Status: implemented

## Problem

流式生成期间用户无法自由上翻历史内容，会被持续拉回底部。根因有二：

1. `scrollBottom` 调度 rAF 时检查一次 `isUserScrolledUp`，但 rAF 回调里无条件 `chatArea.scrollTop = chatArea.scrollHeight`——流式期间排队的帧快照在用户上翻后仍执行吸底。
2. `isUserScrolledUp` 是 scroll 事件里的瞬时重算（`scrollHeight - scrollTop - clientHeight > 65`）：内容高度收缩（live 回合 innerHTML 重建、`clipLiveMarkdownContent` 截断、虚拟滚动 `content-visibility` 占位）时浏览器被动钳位 scrollTop，会把标志误重置，随后一帧又把用户拉回底部。

## Decision

`client/webview/chatPanel.ts` 中将吸底标志改为**锁存（latch）语义**：

- **置位**：记录 `lastChatScrollTop`，仅在 scrollTop 真实向上移动、且距底 >65px 时累计 `chatUpwardDrift`，累积超过约 30px 才置 `isUserScrolledUp = true`。被动钳位（收缩时 scrollTop 被动变小但落点在底部 65px 区内）与内容增长（scrollTop 不动）都满足不了置位条件。
- **解锁**：仅当 scrollTop 向下（或不动）且回到距底 ≤65px、点击 jump-latest 按钮、或 `scrollBottom(force=true)`（新用户消息/新回合/话题加载等既有调用点）时解锁；收缩钳位恰好落到底部区时 delta 为负，不解锁。
- **rAF 回查**：主聊天区与子代理全屏视图的吸底 rAF 回调执行前重新检查锁存标志，已上翻则丢弃本次吸底；force 路径在调度时先复位锁存，使已排队的帧自然通过回查。
- **子代理全屏视图**：`bindSubagentScroll`/`scrollSubagentBottom` 套用同一套锁存与回查，滚动轨迹存于 `subagentScrollTrack` WeakMap。
- `applyStandaloneCompactionStep` 的 `scrollBottom(true)` 改为非 force：压缩卡片出现不应把已上翻的用户拽回底部。

## Alternatives considered

- **以 wheel/touch 交互门控 scroll 事件评估**：否决。拖拽滚动条与键盘翻页不产生 wheel/touch 事件，会漏判真实上翻；方向 + 漂移量判定不依赖输入源，更完备。
- **保留瞬时阈值判定、只在 rAF 回查**：否决。只修回查无法解决收缩钳位造成的误解锁，用户仍会被拉回。
- **子代理视图复用主聊天区标志**：否决。全屏子代理视图是独立滚动容器，且同时可能挂载多个（WeakMap 按元素隔离）。

## Consequences

- 流式期间用户上翻 ≥30px 即脱离吸底，jump-latest 按钮提供显式回底入口；回到底部 65px 内自动恢复跟随。
- `webviewSmoke.test.ts` 新增源码契约断言：锁存置位/解锁条件、rAF 内回查、子代理同款语义、compaction 非 force，防止回归。
