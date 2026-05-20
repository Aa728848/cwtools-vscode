# AI 子系统拆分与稳定化计划

## 目标

降低 AI 子系统的维护成本和变更风险，把当前几个高体量、高耦合文件拆成有清晰边界的模块，同时保持现有用户行为不变。

本计划重点解决：

- 巨型文件难以审查、难以测试、容易产生循环依赖。
- Prompt、Runner、Tool、Provider、Chat Host 的职责边界被拉长。
- 新增模型、工具、Workflow 时需要同时理解过多上下文。
- Orchestrator 与普通 Agent 路径共享状态时，排查问题成本偏高。

## 当前风险信号

| 文件 | 当前角色 | 主要风险 |
| --- | --- | --- |
| `client/extension/ai/promptBuilder.ts` | 系统提示词、模式提示词、项目上下文、记忆、技能注入 | 文本策略与运行策略混在一起，变更后很难判断影响范围 |
| `client/extension/ai/agentRunner.ts` | 推理循环、工具调用、压缩、验证、回退、事件发射 | 状态机过长，取消、fallback、验证和工具调度互相影响 |
| `client/extension/ai/chatPanel.ts` | Extension 侧 Chat 宿主、消息路由、设置、主题、artifact | VS Code API、会话状态、Webview 消息协议耦合 |
| `client/extension/ai/tools/lspTools.ts` | LSP 查询、诊断、资源候选、重命名、验证 | 工具数量多，读写语义和 LSP 交互边界不够明显 |
| `client/extension/ai/tools/fileTools.ts` | 文件读写、替换、patch、本地化、验证等待 | 写入安全、确认、diff、诊断等待混在一起 |
| `client/extension/ai/tools/externalTools.ts` | 命令执行、搜索、媒体/外部工具、变更捕获 | 沙盒、安全策略、外部进程和 artifact 逻辑混杂 |

## 设计原则

1. 保持现有行为优先。拆分 PR 不改变 Prompt 语义、工具权限、UI 协议或 Provider 请求格式。
2. 先抽纯逻辑。优先迁移不依赖 `vscode`、文件系统、网络和全局状态的函数。
3. 保留 facade。原入口文件可以先保留导出层，让调用方逐步迁移。
4. 小步可验证。每个阶段都能独立运行 `npm.cmd run lint` 和 `npm.cmd run test:unit`。
5. 严格模块方向。底层类型和纯函数不反向依赖 Runner、ChatPanel 或 VS Code API。

## 目标模块结构

### Prompt Builder

建议目标结构：

```text
client/extension/ai/prompt/
  index.ts
  promptBuilder.ts
  sections/
    baseSystem.ts
    modePrompts.ts
    workflowPrompts.ts
    toolPolicies.ts
    gameKnowledge.ts
    resourceRepair.ts
    outputContracts.ts
  context/
    projectContext.ts
    memoryContext.ts
    skillContext.ts
    fileContext.ts
  snapshots/
    promptSnapshot.ts
```

迁移策略：

- `promptBuilder.ts` 保留类或主函数入口。
- 大段常量文本迁移到 `sections/`，并用函数接收必要参数。
- `CWTOOLS.md`、记忆、技能读取放进 `context/`，避免 Prompt 文本文件直接读磁盘。
- 给关键模式增加快照测试：`build`、`plan`、`review`、`orchestrator`、`gui_expert`。

验收标准：

- 原 `PromptBuilder` public API 不变，调用方无需同步大改。
- Prompt 生成快照在无意改动时稳定。
- 模式、Workflow、资源修复规则能单独测试。

### Agent Runner

建议目标结构：

```text
client/extension/ai/runner/
  agentRunner.ts
  reasoningLoop.ts
  toolScheduler.ts
  toolExecution.ts
  stepEmitter.ts
  validationLoop.ts
  fallbackPolicy.ts
  cancellation.ts
  runState.ts
  compaction.ts
  checkpoint.ts
  writeCoordinator.ts
```

迁移策略：

- 保留现有 `runner/compaction.ts`、`runner/checkpoint.ts`、`runner/writeCoordinator.ts`。
- 先抽 `fallbackPolicy.ts`、`cancellation.ts`、`stepEmitter.ts` 这类低风险模块。
- 再抽 `toolScheduler.ts`，只负责工具调用排序、读写分类和超时包装。
- 最后拆 `reasoningLoop.ts` 与 `validationLoop.ts`，避免一次性改动主状态机。

关键边界：

- `reasoningLoop` 只知道模型响应、工具调用请求和下一轮消息。
- `toolScheduler` 只知道工具定义、权限、写入队列和超时。
- `stepEmitter` 统一 AgentStep、artifact、UI 广播事件。
- `validationLoop` 只处理诊断、质量门和重试上限。

验收标准：

- 取消请求仍能穿透 Provider 请求、工具执行和子 Agent。
- `dispatch_agents` 并发、写入冲突串行、token 统计保持现有测试通过。
- Runner 主文件只保留装配逻辑和 public API。

### Chat Host

建议目标结构：

```text
client/extension/ai/chat/
  chatPanel.ts
  chatController.ts
  webviewMessageRouter.ts
  chatSessionState.ts
  topicStore.ts
  artifactBridge.ts
  settingsBridge.ts
  workflowBridge.ts
  commandHandlers.ts
```

迁移策略：

- 将 Webview message `type` 到 handler 的分发迁出 `chatPanel.ts`。
- 将主题、artifact、settings 的持久化桥接独立出来。
- 将命令处理和 VS Code editor 交互独立出来。
- `chatPanel.ts` 最终只负责创建面板、注入 HTML、绑定生命周期。

验收标准：

- Chat Panel 与 Agent Manager 的共享 contract 不回退。
- 现有 `agent manager cross-surface contracts` 相关测试继续通过。
- Webview restore、topic 切换、artifact 抽屉、mode/workflow 切换行为保持不变。

### Tool System

建议目标结构：

```text
client/extension/ai/tools/
  registry.ts
  definitions.ts
  metadata.ts
  permissions.ts
  resultBudget.ts
  file/
    readTools.ts
    writeTools.ts
    localisationTools.ts
    patchTools.ts
    diagnosticsWait.ts
  lsp/
    diagnosticTools.ts
    symbolTools.ts
    resourceCandidateTools.ts
    renameTools.ts
  external/
    commandTools.ts
    webTools.ts
    mediaTools.ts
    changeCapture.ts
```

迁移策略：

- 先抽不改变工具名的内部 handler。
- `definitions.ts` 暂时保留 schema 事实来源，避免同步生成器带来额外风险。
- 将权限相关逻辑集中到 `permissions.ts`，减少 Runner 与工具定义重复判断。
- 将 `find_sprite_candidates`、`find_sound_candidates`、`query_workspace_index` 等共享索引工具放入 `lsp/resourceCandidateTools.ts` 或 `lsp/symbolTools.ts`。

验收标准：

- 工具名称、JSON schema 和工具结果结构保持兼容。
- `READ_ONLY_TOOLS`、`WRITE_TOOLS`、模式门控测试覆盖所有工具。
- 文件写入、本地化写入、命令变更捕获的安全测试保持通过。

### Provider Layer

建议目标结构：

```text
client/extension/ai/providers/
  index.ts
  providerRegistry.ts
  requestAdapters.ts
  streaming/
    openAiStream.ts
    claudeStream.ts
    geminiStream.ts
    compatibleStream.ts
  models/
    capabilities.ts
    pricing.ts
    defaults.ts
```

迁移策略：

- 先抽模型能力、价格、默认 endpoint 等纯数据。
- 再抽 Provider request adapter，保持 `AIService` 对外方法不变。
- 最后拆各 Provider 的 streaming parser。

验收标准：

- `toClaudeRequest`、模型能力、上下文窗口、FIM、vision、价格测试保持通过。
- Provider 新增模型时不需要修改 `AIService` 主流程。

## 分阶段实施计划

### 阶段 0：建立基线

任务：

- 记录当前 `npm.cmd run lint` 和 `npm.cmd run test:unit` 结果。
- 给 PromptBuilder 增加 3 到 5 个快照测试。
- 给 Runner 的取消、fallback、tool scheduling 增加最小状态机测试。
- 标记所有 AI public entrypoints，避免拆分后遗漏导出。

交付物：

- `client/test/unit/promptBuilderSnapshot.test.ts`
- `client/test/unit/agentRunnerState.test.ts`
- 一份临时迁移清单或 TODO issue。

### 阶段 1：抽纯函数与常量

任务：

- 将 Prompt 大段文本拆入 `prompt/sections/`。
- 将 Provider 模型能力、价格、默认值拆入 `providers/models/`。
- 将工具结果裁剪、权限判断、工具分组相关纯逻辑集中。

风险：

- Prompt 文本换行、缩进、顺序变化会影响模型行为。

防护：

- 快照测试允许有意更新，但禁止无意大面积漂移。

### 阶段 2：拆 Runner 外围能力

任务：

- 抽 `fallbackPolicy.ts`。
- 抽 `cancellation.ts`。
- 抽 `stepEmitter.ts`。
- 抽 `toolScheduler.ts` 的非核心路径。

风险：

- UI 进度事件顺序变化。
- 子 Agent token 统计或 artifact 归属错误。

防护：

- 保持现有 Orchestrator runtime safety 测试。
- 新增 step 顺序测试。

### 阶段 3：拆 Chat Host

任务：

- 将 Webview message route 拆到 `webviewMessageRouter.ts`。
- 将 settings、topic、artifact、workflow 桥接拆分。
- 保留 `chatPanel.ts` 生命周期和 VS Code 面板创建逻辑。

风险：

- Chat Panel 与 Agent Manager 双界面状态不同步。
- Webview restore 后重复广播或丢失 topic 状态。

防护：

- 复用现有 cross-surface contract 测试。
- Webview 回归计划中的真实交互测试接入后再做较大拆分。

### 阶段 4：拆工具实现

任务：

- 文件工具按读、写、本地化、patch、诊断等待拆分。
- LSP 工具按诊断、符号、资源候选、重命名拆分。
- 外部工具按命令、搜索、媒体、变更捕获拆分。

风险：

- 写工具分类错误会破坏串行写入保护。
- `.yml` 本地化写入可能绕过专用工具。
- 命令变更捕获可能漏报 diff artifact。

防护：

- 扩展现有 `agent tool file path safety` 测试。
- 每移动一组工具，先保持旧 handler re-export。

### 阶段 5：收口与移除 facade 冗余

任务：

- 移除临时 re-export。
- 更新 `ARCHITECTURE.md` 中 AI 子系统模块表。
- 增加贡献指南，说明新增工具、Provider、Workflow 时要改哪些文件。

验收：

- 核心 AI 文件体量显著下降。
- public API 清晰。
- `npm.cmd run lint`、`npm.cmd run test:unit`、`npm.cmd run compile` 通过。

## 回归测试重点

必须覆盖：

- Provider 请求转换：OpenAI compatible、Claude、Gemini、自定义 endpoint。
- Streaming：text delta、thinking delta、tool call delta、JSON repair。
- Runner：取消、fallback、压缩、质量门、工具超时、写锁。
- Orchestrator：并发上限、依赖失败、写目标冲突、子 Agent 取消。
- Tools：文件边界、本地化写入、命令安全、资源候选查找。
- Chat：topic restore、artifact restore、mode/workflow 同步、Agent Manager 双界面。

## 完成定义

- AI 子系统核心文件职责清晰，任一文件都能用一句话说明边界。
- 新增 Provider 不需要理解 Runner 内部。
- 新增工具不需要修改 PromptBuilder 主体。
- 新增 Workflow 不需要改 Chat Host 的生命周期代码。
- 拆分后的测试覆盖能捕获 Prompt 漂移、工具权限漂移和状态机回退。

