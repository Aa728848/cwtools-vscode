# 改进进度条为真百分比填充方案 (Implementation Plan)

本计划旨在优化项目启动时的各类漫长解析进程（如 `precacheAllFiles`），将目前的纯转圈 Loading + 拼接字串更改为真正的且安全的百分比注水进度条，使得等待体验更明确。

## User Review Required

> [!WARNING]
> **关于显示位置的重大变更申请：**
> 根据 VS Code API 限制，底部状态栏 (`ProgressLocation.Window`) **不支持**原生的增量进度条显示，只能表现为旋转的 loading spin。为了实现您要求的“真百分比填充”视觉效果，我们**必须**将进度显示位置改为 `ProgressLocation.Notification`。这会在屏幕右下角弹出一个带注水动画的通知框进程。请您核准该项变更。

## Proposed Changes

### TypeScript 前端调整

需要大幅调整接收侧的逻辑，支持 `increment` 并对负值回退进行边界防护，最关键的是更改 `Location`。

#### [MODIFY] [extension.ts](file:///C:/Users/A/Documents/cwtools-vscode/client/extension/extension.ts)
- **更新类型定义**：为 `loadingBarParams` 参数追加可选属性 `percentage?: number`。
- **防止进度回退**：引入外层词法变量 `lastPercentage = 0`，接收到新进度时计算 `inc = Math.max(0, param.percentage - lastPercentage)`。如果是全新的生命周期则重置。
- **更改 Progress API**：更改 `vs.window.withProgress` 中的 `location: vs.ProgressLocation.Window` 为 `location: vs.ProgressLocation.Notification`，从而激活真正的水平填充条。
- **传递消息**：在 `.report({ message, increment })` 调用中挂载最新计算的 `inc` 增量。

--- 

### F# 后端调整

核心改动在于向客户端提供有效的（并确保线程安全的）百分比数据，坚决防范产生 `DivideByZeroException` 导致 LS 崩溃的情况。

#### [MODIFY] [Program.fs](file:///C:/Users/A/Documents/cwtools-vscode/src/Main/Program.fs)
- **预防除以零灾难**：在 `precacheAllFiles` 等涉及数组总量的统计过程中，强制引入 `totalEntities` 的空值守卫。例如 `let percentage = if totalEntities = 0 then 100 else (entityCount * 100 / totalEntities)`。
- **生成 JSON Response**：在通过 `client.CustomNotification` 发送 `loadingBar` 更新阶段时，若计算出了 `percentage` 进度，就在打包的 `JsonValue.Record` 数组中追加 `"percentage", JsonValue.Number(decimal percentage)`。

## Open Questions

> [!IMPORTANT]
> 如果您觉得右下角的 `Notification` 进度通知由于占空间或者太频繁而过于烦人，并且**坚持要留在底部文字状态栏**，我们也能设计一套“用字符画拼接文本实现假进度”的方案（例：` Precaching UI [█████░░░░░] 50%`）。如果不接受右下角小弹窗，请回复反馈我将采取字符画的备用方案；如果接受的话，请直接审批当前方案。

## Verification Plan

### Manual Verification
1. **启动测试**: F5 进行客户端扩展 Debug 启动。
2. **重度进程监控**: 打开一个大型项目以触发 `precacheAllFiles`。
3. **视觉测试**: 观察右下脚能否顺利弹出通知框，并平滑填充蓝色的百分比进度条直至 `100%`。
4. **空项目边界测试**: 强制选择一个不存在 entity 的空文件夹加载作为 Workspace，确认 Language Server 是否安然无恙并迅速关闭通知，而没有发生红字崩盘。
