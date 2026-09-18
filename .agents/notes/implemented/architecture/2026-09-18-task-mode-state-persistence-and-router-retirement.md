# Agent Note: 任务模式状态持久化与路由分类器退役收尾

Status: implemented

## Problem

上一轮把任务模式决策交给 Agent（`enter_plan_mode`/`exit_plan_mode` 工具）+ 用户覆盖命令（`/plan` 等），但留下三处未收：

1. **用户 pin 的模式只在内存**：`AgentSessionCoordinator.modeOverride` 不随话题保存。切换话题、重载扩展、分叉话题后 pin 静默失效，退回自动解析。
2. **审批标记只在内存**：`approvedPlanExecutionPending` 是一次性布尔。用户点批准后如果先切了话题或重载扩展再发消息，批准丢失，计划卡需要重新走一遍。
3. **计划升级在回合结束时被冲掉**：runner 在 run 完成时无条件把 phase 改成 `finalize`（`agentRunner.ts` 的 `updateRunStatus`），于是模型刚通过 `enter_plan_mode` 进入的 plan phase 在回合结束后消失；而 chatPanel 也没有把权威调度状态回流到 session/topic。结果是"计划模式"实际上活不过一轮。
4. **退役分类器的死代码仍在**：`parseModelAgentProfileDecision`、`resolveAgentProfileFromModelDecision`、`shouldUseSemanticAgentRouting`、`ModelAgentProfileDecision` 已无生产调用者，仅被 12 处单测引用，注释里也还留着"semantic router"的过时说明。

## Decision

### 1. 模式 pin 随话题持久化

`ChatTopic` 新增可选 `modeOverride`。`chatTopics.readModeOverride` 做边界校验：**未知或畸形值一律回落 `'auto'`，绝不回落到某个 pin**——损坏的字段不能悄悄限制 Agent 能做什么。写入点：`applyModeOverride`（用户命令）与消息发送时的 topic 同步；恢复点：话题激活；分叉继承（用户的选择针对"这事怎么做"，不属于某个话题 id）。

### 2. 审批标记随话题持久化

删除内存布尔 `approvedPlanExecutionPending`，改为 `ChatTopic.approvedPlanArtifact` 字符串（记录本次批准的 Implementation_Plan 路径）。`beginApprovedPlanExecution` 写入，`consumeApprovedPlan` 在后续执行回合**恰好消费一次**。附带一个必要的交互修正：批准时若 session 被 `/plan` 钉住，pin 会被清回 `auto`——否则 pin 会在批准回合把刚批准的授权重新收窄成 plan，形成"批准了却还是不能写"的死结。

### 3. 计划态跨回合存续

两处修正：

- `agentRunner.updateRunStatus` 的 finalize 转换新增 `planAwaitingApproval` 守卫：**plan 是"等待用户决定"而非"已完成"**，带 plan phase 结束的回合不再被改写成 `finalize`。
- chatPanel 在回合结束、收集产物前，从 `agentRuntime.getConversationUndoState(topicId, topicId)`（其 `schedulingState` 来自 domain store，是权威 post-run 状态）回流到 session 与 topic，并推送给 Webview。

已核对 finalize 的其他消费方（goal 完成校验、finalization overlay、profile phase 派生）不受影响：保留 plan 只让"目标已完成"的判定更保守，语义更准确。

### 4. 删除退役分类器

删除两个导出函数、一个决策接口与 `shouldUseSemanticAgentRouting`，并清理 `agentProfile.ts`/`chatPanel.ts` 中指向"semantic router"的过时注释。测试侧把原先"模型决策 → 调度状态"的用例改写为等价覆盖：**用户 pin 的模式**（`intent: 'plan'/'explore'` 直接产出对应 authorization/phase/mode）与**确定性解析**（域归属、write-admission、显式 no-write 读只读）。覆盖强度不变，但测的是当前真实契约。

## Alternatives considered

1. **模式 pin 只存 session、不存 topic**：切话题即失效，正是本轮要修的体验问题。否决。
2. **新增 `topic.approvedPlanExecutionPending` 布尔**：布尔无法承载"批准的是哪个计划产物"，且未来多计划并存时无法区分。用产物路径字符串更准确。否决。
3. **保留 `finalize` 无条件转换，靠 chatPanel 单独记住"本轮进过 plan"**：会在会话日志里留下与 domain store 冲突的 phase（`finalize` vs `plan`），并且 resume/fork 读到的是错误的一个。否决——权威状态应在源头正确。
4. **畸形 `modeOverride` 回落到上一个已知 pin**：需要额外维护"上一个 pin"状态，且静默恢复一个用户没主动选的限制模式更危险。回落到 `auto` 更安全。否决。
5. **保留死代码以维持测试不变**：这些函数已无调用者，留着会让后来者以为还存在模型路由路径，正是本次要消除的认知负担。改写测试。否决。

## Consequences

- 用户 pin 的模式、审批标记、以及模型计划升级三者现在都能跨话题切换、扩展重载与分叉存续；"进入计划模式"不再是单轮现象。
- 计划态与权威 domain store 一致，resume/fork 不会读到被 finalize 覆盖的错误 phase。
- 扩展侧不再存在模型路由分类器代码路径，注释与实现一致。
- 验证：`tsc` 双配置 0 错误；新增话题 pin/审批持久化往返测试与重写后的 profile 测试全绿；全量单测 2392 通过 + 既有 flaky 2 例（`agentToolSafety` 后台命令超时与临时目录 EPERM 清理，改动前即存在）。
- 已知遗留：模式状态尚未做成 DSH 式的独立日志投影（`plan/mode` 事件）；当前以 `ChatTopic` 字段 + domain store 承载，语义等价但两者之间没有单一投影层。`planContinuationPending` 仍是一个派生判定（读持久化的 phase 与磁盘产物）而非独立状态，因此保留。
