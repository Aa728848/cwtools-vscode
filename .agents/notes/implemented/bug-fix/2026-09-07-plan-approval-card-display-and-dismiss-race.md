# Agent Note: 修复对话界面与独立界面计划审批卡弹出及右侧展示异常

Status: implemented

## Problem
在最新版本中，用户反馈计划审批卡（Plan Approval Card）在对话界面中无法正常弹出显示，且在独立界面（Agent Manager Shell）的右侧审查工作区中也无法正确展示：
1. **对话界面清理竞态问题**：前端 `chatPanel.ts` 在收到 `renderPlan`、`renderWalkthrough` 和 `renderBlueprint` 事件时，会调用带有延时动画的 `dismissCard(el, 0)` 清理旧卡片；该函数内部使用双层 `setTimeout(..., 260)` 异步延迟移除 DOM。当快速复用缓存卡片或新创建卡片挂载到 `chatArea` 后，该延迟定时器触发强行从 DOM 树拔除节点，并触发 `forgetResponsiveWorkspaceContent`，导致新生成的审批卡被意外销毁或不可见。
2. **私有存储目录查找缺失**：后端 `findGeneratedTopicFile` 与 `getApprovedPlanArtifactContext` 仅检索了 `getPrivateTopicStorageDir`，未检索共享话题目录 `getTopicStorageDir`；当计划文件写入在不同模式的目录中，或步骤快照规范化路径差异时，导致后端判定计划产物未就绪，未能按预期派发 `renderPlan` 消息。
3. **独立界面右侧挂载与 Tab 偏好丢失**：独立界面 `agentManager.ts` 在收到嵌入式工作区内容（`applyEmbeddedWorkbenchContent`）时，`suggestedPrimaryTab` 仅根据 `state.run` 文件变动判断默认 Tab（当没有文件修改仅有计划卡片时仍留在 Activity 标签）；且 `renderInspector` 在工作区签名相同时会早期返回，当外部容器 DOM 节点尚未真正挂载或被重绘清空时，未能及时重新挂载卡片内容。

## Decision
1. **重塑卡片同步安全清理机制**：在 `client/webview/chatPanel.ts` 中，废除收到渲染消息时调用的异步延时 `dismissCard`，改为同步遍历 DOM 树；若旧节点不是当前缓存待复用节点（`el !== cachedContent`），则立即同步移除并注销，彻底消除 260ms 后延迟删除新卡片的竞态。
2. **复用卡片时恢复可见性样式**：在 `showAnnotationWorkspacePanel` 命中 `cached` 卡片时，强制重置可能残留的内联样式（`transition = ''`, `opacity = '1'`, `transform = ''`, `display = ''`），确保被复用的卡片绝对可见。
3. **扩展话题计划文件检索双目录与灵活匹配**：在 `client/extension/ai/chatPanel.ts` 的 `findGeneratedTopicFile` 和 `getApprovedPlanArtifactContext` 中，同时检索 `getPrivateTopicStorageDir` 与 `getTopicStorageDir`，并支持从当前消息快照与磁盘文件中多阶段匹配 `Implementation_Plan.md`；同时在 `hasCurrentPlanArtifact` 判定中补充当前模式回退与步骤产物匹配。
4. **增强独立界面工作区挂载与 Tab 联动**：
   - 更新 `agentManager.ts` 中的 `suggestedPrimaryTab`：只要存在 `workspaceEntries`（即包含计划卡片等工作区条目），优先切换至 `'changes'` 审查标签页。
   - 在 `renderInspector` 的签名比对中，增加 `hostHasAllEntries` 校验，确保宿主容器内确实已挂载所有条目节点，防止假性命中缓存导致的空界面。
   - `applyEmbeddedWorkbenchContent` 收到条目更新时，强制递增工作区渲染版本并清空缓存签名，确保立即触发重绘挂载。

## Alternatives considered
- **仅延长 `dismissCard` 的定时器延时**：否决。异步定时器本质上属于不可控的竞态隐患，在快速消息交互或重渲染流中依然可能在卡片复用之后触发。
- **将计划审批卡改为弹窗 Modal 拦截**：否决。破坏了现有的可注释（Annotatable）设计规范与平铺审查交互模式。

## Consequences
- 对话界面与独立界面右侧均能稳定、即时地弹出并展示计划审批卡，不会发生闪烁消失或空挂载。
- 话题切换与工作区清理逻辑更加健全。
- 编译 `npm run compile`、全量类型检查 `npm run typecheck:test`、全量单元测试（2388 项）以及新增的针对性端到端 Smoke 测试全部绿色通过。
