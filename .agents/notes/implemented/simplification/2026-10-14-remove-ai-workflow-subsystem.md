# Agent Note: 移除 AI Workflow 子系统（与 Agent Skill 合并后的冗余清退）

Status: implemented

## Problem

AI Workflow 子系统由三个扩展侧模块 `workflowRegistry.ts`（823 行）、`workflowI18n.ts`（329 行）、`workflowViewModel.ts`（35 行）与一个 webview 模块 `client/webview/chat/workflows.ts`（44 行）构成，对外提供 `/workflow:<id>` 斜杠命令、`save_workflow` 模型可见工具、composer 的工作流芯片与工作流选择菜单。落地时它的价值与 Agent Skill 高度重叠：两者都是「把一段可复用的过程固化成规范文本，按需载入本轮对话」，用户能做的事与得到的收益几乎一致。

逐层核对后确认，子系统的规模与实际行为严重不成比例：

- 约 1200 行的专属代码里，**真正的运行时行为只有 3 处**——`agentRunner.ts` 的工具白名单过滤、`promptBuilder.ts` 的 `workflow-instructions` 注入、`chatPanel.ts` 的 `switchWorkflow` 调度覆写。其余全部是元数据（frontmatter 解析、markdown 读写、DTO 序列化、i18n 词条、webview 渲染）。
- 内置的 5 条 workflow（`diagnostic-fix` / `loc-generation` / `event-chain-design` / `rules-sync-review` / `asset-wiring`）的 `domain` / `intent` / `strategy` **全部等于默认值**，即它们施加的调度结果与「不做任何事」相同；唯一有区分度的 `allowedTools` 白名单是硬编码的工具名列表，会随工具集增长而**静默过期**——新工具不会自动进入白名单，而过期项不会报错。
- 激活 workflow 期间，`chatPanel.ts` 的 `handleUserMessage` 有一处 `!this.currentWorkflowId` 短路，会让**整条自动模式路由（`resolveTurnAgentProfile`）对该话题剩余所有轮次失效**。这是一处纯损失：workflow 并没有提供等价的替代路由，只是把用户钉住的模式也一并关掉了。
- `projectProfile.ts` 生成的 `routing.recommendedWorkflowByIntent` 会被 `promptBuilder.ts` 读成 `- intent: workflowId` 提示注入系统提示。移除 workflow 后这 5 个 id 已无对应实体，保留即向模型投放**悬空提示**。

结论：该子系统是净负债。用户的可复用过程需求已由 Agent Skill 完整承接（`save_skill` + `run_skill` + `/skill`，见 [save_skill 模型可见工具](../feature/2026-10-13-save-skill-tool.md) 与 [`/skill` 斜杠直呼](../feature/2026-10-13-skill-slash-command.md)），workflow 不再承担任何独有能力。

## Decision

**整体删除，不做迁移**。用户已批准直接移除；没有把任何 workflow 内容搬到 SKILL.md，因为内置 5 条的 domain/intent/strategy 全为默认值、其 promptSupplement 内容与现有技能无实质重叠，搬迁只会把默认值换个文件名再维护一遍。

### 1. 删除的模块

| 路径 | 行数 |
| --- | --- |
| `client/extension/ai/workflowRegistry.ts` | 823 |
| `client/extension/ai/workflowI18n.ts` | 329 |
| `client/extension/ai/workflowViewModel.ts` | 35 |
| `client/webview/chat/workflows.ts` | 44 |
| `client/test/unit/workflowRegistry.test.ts` | — |
| `client/test/unit/workflowViewModel.test.ts` | — |

### 2. 唯一一处行为修复：自动路由恢复对所有轮次生效

`chatPanel.ts` 的 `handleUserMessage`：

```diff
- if (!_skipAutoModeSwitch && text.trim() && !this.currentWorkflowId) {
+ if (!_skipAutoModeSwitch && text.trim()) {
      resolvedProfile = await this.resolveTurnAgentProfile(text, !isBackground, {
          planContinuationPending: this.isPendingPlanContinuation(text),
      });
```

删除短路后，自动路由的生效路径是
`chatPanel.ts` `handleUserMessage` → `resolveTurnAgentProfile(text, !isBackground, { planContinuationPending })` → `session.schedulingState` → `executionModeForSchedulingState` → 本轮 `mode`。
`/plan`、`/execute`、`/explore`、`/review`、`/mode` 的钉住语义**完全不变**：钉住由 `session.modeOverride` 表达（见 [Agent 自行决策任务模式与用户覆写](../architecture/2026-09-18-agent-decided-task-mode-and-user-override.md)），与被删除的 `currentWorkflowId` 短路是正交的两套机制。

### 3. 状态与持久化：会话态删除，历史数据优雅降级

`AgentSessionCoordinator` 移除 `_currentWorkflowId` / `currentWorkflowId` / `activateWorkflow` / `deactivateWorkflow`；**保留** `_previousSchedulingState` 与 `modeOverride`——前者与「用户显式覆写前」的快照语义（`switchSchedulingDomain` 写、`restorePreviousSchedulingState` 读，被 walkthrough 批准卡使用），后者与 workflow 无关。`chatPanel.startNewTopic` 同步重置 `previousSchedulingState`，避免批准 walkthrough 时把上一话题的状态恢复回来。

`ChatTopic` 类型移除 `workflowId` / `workflowReturnSchedulingState`。**这里是最容易出事的一处**：旧话题 JSON 里真的存着这两个字段，若解析器对未知字段抛错，整个话题会变成不可读。因此 `chatTopics.ts` 的 `readStoredTopic` 显式**忽略**这两个遗留字段（既不读取也不校验），会话内容完整保留。

### 4. `routingSource: 'workflow'`：降级而不是保留

`AgentSchedulingState.routingSource` 的联合从 `'model' | 'deterministic' | 'workflow' | 'user'` 收敛为 `'model' | 'deterministic' | 'user'`。旧话题里持久化过 `'workflow'`，直接把它移出校验集合会让 `normalizeSchedulingState` 对**整条历史话题抛错**。因此 `runner/scheduling.ts` 引入 `LEGACY_ROUTING_SOURCES = new Set(['workflow'])`：校验期放行，归一化期降级为 `undefined`（来源未知）。

取舍：保留 `'workflow'` 作为合法值也能避免抛错，但那样「workflow 是合法路由来源」会成为一条与代码现实不符的永久陈述，反而更危险。降级到 `undefined` 语义诚实——该来源确实已不存在。webview 的 `sourceLabel` 因此只剩「用户调度」与「Agent 调度」两支，与既有注释（关键词路由已退役）一致。

### 5. 悬空提示链：`recommendedWorkflowByIntent` 一并移除

`projectProfile.ts` 不再生成该字段，`isProjectProfileShape` 不再校验它，`promptBuilder.ts` 不再把它渲染成 `## Recommended Workflows` 区块，`types.ts` 的 `ProjectProfile.routing` 也不再声明它。5 个内置 workflow id 因此不会以任何形式出现在系统提示里。

### 6. `save_workflow` 全链路清退，`save_skill` 一行未改

`tools/definitions.ts`（定义）、`tools/registry.ts`（`AgentToolName` 联合、`TOOL_DOMAINS`、`EDIT`、`SUB_AGENT_EXCLUDES`、`FILE_SCOPED_WRITE_TOOLS`、6 个模式集、`GENERAL_WORKFLOW_SCHEMA` 与 `generalSchema` 分派）、`agentTools.ts`（`TOOL_TIMEOUTS`、dispatch case、handler、`onWorkflowSaved`、general 域守卫）、`runner/toolScheduler.ts`（目标路径 case 与专用的 id 归一 helper）、`planModeGuard.ts`、`runnerPolicy.ts`、`runner/autoReviewer.ts`、`experienceStore.ts`、`executePlanHandoff.ts`、`chat/toolPhrases.ts`（`save_workflow` 短语与图标）全部移除。

**`save_skill` 的每一层接线保持原样**：home 目录（`scope:'user'`）、`onSkillSaved` 热刷新、plan 模式放行、general 域守卫、`SUB_AGENT_EXCLUDES`、`FILE_SCOPED_WRITE_TOOLS`、`getAgentToolTargetFiles` 不上报目标路径——一条都没有因为这次删除而被削弱。

### 7. 其余清理面

- **共享协议**：`client/shared/agentSchedulingProtocol.ts` 移除 `WorkflowView` / `WorkflowPhaseView` / `WorkflowVerificationView` / `WorkflowUiLabels`，标题从「Agent Scheduling & Workflow Protocol」改为「Agent Scheduling Protocol」；`types.ts` 与 webview 侧的再导出同步移除。
- **斜杠命令**：`SlashCommandId` 与 `DEFINITIONS` 移除 `workflowList` / `workflowSave` / `workflowOff` / `workflowSelect` 四条，两个 category 联合移除 `'workflow'`。`/status` 的中英文案去掉 workflow 段。
- **webview `buildSlashCommands` 签名收窄**：由 `(hostCommands, workflows)` 改为 `(hostCommands)`，只保留「按命令名大小写不敏感去重」这一真实不变量；调用点 `chatPanel.ts` 与 `chatModels.test.ts` 同步更新。
- **`PolicyScope = 'once'|'session'|'workflow'|'global'`**（`runner/policyEngine.ts`）**保留**：它是独立的授权作用域概念，与 AI Workflow 无关。
- **`agentManager` 的调度档位词条改名 `ui.schedulingMode.*`**（Build/Plan/Review/Explore/Multi-Agent）：这些标注的是调度档位与 profile，不是被删的工作流实体。原先它们叫 `ui.workflow.*`、函数叫 `workflowLabel(scheduling, workflowId)`、按钮类名是 `manager-command-workflow`，都会继续暗示一个已不存在的概念，因此一并改名为 `schedulingModeLabel` / `manager-command-mode`；中英词条同步去掉「Workflow」字样（`Build Workflow` → `Build mode`）。
- **`workspaceSandbox.ts` 的 `SHARED_AI_STORAGE_SEGMENTS`** 移除 `'workflows'`：`saveProjectWorkflow` 是它的唯一写入方，删除后没有任何代码会再读或写 `.cwtools/workflows`。
- **文案**：`extension.ts` 的「清除私有历史」确认框原文含「shared workflows / 共享工作流」，中英文同步删去该分句；`memoryParser.ts` 生成的记忆 Markdown 页脚把「an explicit workflow」改为「an explicit Agent skill」；`chatHtml.ts` 删除 composer 的工作流按钮；`chat/i18n.ts` 删除无引用的 `manager.overview.workflow` 键。
- **测试**：删除两个 workflow 专属套件；`agentSessionCoordinator.test.ts` 的两个 workflow 用例替换为 `previousSchedulingState` 与 `modeOverride` 的等价覆盖（保留被删除成员的覆盖率，而不是删了了事）；其余引用 workflow 的既有测试逐条就地修正，**未弱化任何与 workflow 无关的断言**（例如 `chatModels.test.ts` 的 `buildSlashCommands` 用例改为断言 `/compact` 与 `/status` 的本地化描述与 `role="option"` 渲染）。

## Alternatives considered

1. **把 workflow 内容迁移到 SKILL.md frontmatter**：否决。5 条内置 workflow 的 `domain` / `intent` / `strategy` 全部等于默认值，`promptSupplement` 与现有技能无实质重叠；迁移等于把默认值换个文件名再维护一遍，且 `SKILL.md` 没有 `allowedTools` 之外的白名单语义，用户反而失去「一条命令直接钉住调度档位」的能力。
2. **保留只读展示（隐藏激活入口，仅保留 `/workflow:list` 与 `save_workflow`）**：否决。只读展示需要 `workflowRegistry` + `workflowViewModel` + `workflowI18n` + `chat/workflows.ts` 四层仍然全在（>1200 行），而用户实际能从中获得的仍然只是「看一组字段等于默认值的元数据」。保留它等于用一个 UI 永久供奉一个已无行为的概念。
3. **保留 `routingSource: 'workflow'` 作为合法值以回避历史数据抛错**：否决。它确实能避免抛错，但会让类型与 UI 继续宣称「workflow 是合法路由来源」，与代码现实不符——这正是本仓库 `One home per fact` 纪律要避免的悬空事实。降级到 `undefined` 同样不抛错，且语义诚实。
4. **保留 `workflowId` / `workflowReturnSchedulingState` 作为「已废弃但仍解析」的 topic 字段**：否决。没有任何消费方；保留只是让旧文件在两次保存后仍然带着两个永远为 `undefined` 的字段。忽略它们同样不丢任何用户数据（会话正文与 `schedulingState` 完整保留）。
5. **首次交付时曾把 `query_project_profile` 描述里的「workflow routing」留作遗留项**：当时的理由是改动会让 `npm run check:mcp-schema` 失败、修好它需要子模块发版，超出「不改 `submodules/`」的边界。**该取舍随后被用户否决并已收口**：MCP 本来就要随本变更一起更新，因此措辞改为「routing hints」，并按 `AGENTS.md` 的 MCP 契约重新生成 schema（`npm run generate:mcp-schema`，子模块内 `packages/cwtools-shared/src/generated/mcpTools.ts` 一行改动，36 tools 数量不变）。
6. **把 `PolicyEngine` 的 `PolicyScope` 里那个 `'workflow'` 一并删掉**：否决。它与 AI Workflow 无关——是授权作用域的一档，与 `'once'` / `'session'` / `'global'` 并列，语义上独立存在。

## Consequences

- 用户可见的 AI Workflow 表面全部消失：`/workflow*` 四条命令、`save_workflow` 工具、composer 工作流菜单与工作流芯片、`/status` 中的工作流段、「清除私有历史」确认框里的「共享工作流」字样。可复用的过程沉淀走 Agent Skill（`/skill` / `save_skill` / `run_skill`），能力面没有收窄。
- **一个既有缺陷被顺带修掉**：此前激活 workflow 期间自动路由被静默跳过；现在自动模式路由对每一轮都生效，`.cwtools` 之外的任何话题都不会再出现「钉住之后再也不自动路由」的现象。
- 旧话题数据（`workflowId` / `workflowReturnSchedulingState` / `routingSource:'workflow'`）继续可读，会话完整，遗留字段被静默忽略、路由来源降级为「未知」。已由 `client/test/unit/chatTopicsLegacy.test.ts` 与 `client/test/unit/scheduling.test.ts` 锁定。
- `buildSlashCommands` 的第二个参数消失，`.cwtools` 项目侧不再需要维护 `.cwtools/workflows` 目录；旧目录若还在磁盘上则成为无人读写的死数据（`Clear private history` 明确不触碰项目文件）。
- 系统提示少了一块 `## Recommended Workflows`，`<runtime-state>` 少了 `workflow:` / `workflow-instructions:` 两行；两者都只是移除，没有任何补偿性注入。
- `query_project_profile` 的描述由「workflow routing」改为「routing hints」，该字符串经 `npm run generate:mcp-schema` 投影进 `submodules/cwtools-mcp/packages/cwtools-shared/src/generated/mcpTools.ts`（一行改动，工具数仍为 36）。子模块改动需按 `AGENTS.md` 的 MCP 契约在子模块仓库内提交推送后再提升根指针，**根指针尚未提升**。

## 验证契约

- `npm run typecheck:test`：exit 0、无输出。
- `npm run build:docs`：通过（「Single-source bilingual documentation checked.」+「Built release README from Marketplace source」）。本次同步了 `ARCHITECTURE.md`（中英双份的「Profile、Workflow 和子 Agent 只能进一步收窄」改为「Profile 和子 Agent」）、`AGENTS.md`、`CONTRIBUTING.md`（移除 `client/extension/ai/workflowI18n.ts` 文案目录条目）、`README.md`、`docs/marketplace-readme.md`。
- `node tools/generate-mcp-schema.cjs --check`：输出「MCP tool schema is up to date (36 tools).」，`submodules/cwtools-mcp` 零 diff。
- 新增 `client/test/unit/chatTopicsLegacy.test.ts`（3 passing）：旧话题带 `workflowId` + `workflowReturnSchedulingState` + `routingSource:'workflow'` 时完整读回且遗留字段被丢弃、`revision` 保留、`modeOverride` 保留；`workflowId` 存在但回退态缺失时不再整条丢弃；`schedulingState` 本身损坏时仍然拒绝。
- `client/test/unit/scheduling.test.ts` 新增 1 条：`routingSource:'workflow'` 降级为 `undefined` 而不抛错，`'model' | 'deterministic' | 'user'` 三个存续来源原样往返，未知来源（`'telepathy'`）仍然抛 `invalid`。
- `save_skill` / `/skill` 全链路回归：`skillCatalogRefresh.test.ts`、`skillSlashCommand.test.ts`、`saveSkill.test.ts`、`skills.test.ts` 全部通过，未新增或删除任何用例。
- 全量 `npx ts-mocha -p tsconfig.json "client/test/unit/**/*.test.ts"`：2928 passing / 1 failing。唯一失败是 `claudeSubscription.test.ts` 的「probes forward from the registered callback port」（`No free local port for the Claude sign-in callback`），属运行环境没有可用本地 TCP 端口的既有缺陷，与本变更无关（`claudeSubscription.test.ts` 与 `client/extension/ai/claudesub/` 均未被本次变更触及）。

## 交叉链接

本变更推翻了以下两条笔记中的部分事实陈述，已在同一变更内原地保鲜：

- [`/skill` 斜杠直呼](../feature/2026-10-13-skill-slash-command.md)：其 `Problem` 把 `/workflow:<id>` 当作「静态表 + 动态条目」的先例、`onSkillSaved` 参照 `onWorkflowSaved` 写法、`buildSlashCommands` 的双参签名、验证契约里列举的 `workflowRegistry.test.ts` / `workflowViewModel.test.ts`，均已随本变更失效。
- [save_skill 模型可见工具](../feature/2026-10-13-save-skill-tool.md)：其 `Problem`、`save_workflow` 接线对照、备选方案与 `parseFrontmatter` 共享层描述中多处把 `save_workflow` 当作对照物，`save_skill` 的决策本身不变。
