# Agent Note: 多根工作区下 AI 存储根与工具执行根跟随当前编辑器

Status: implemented

## Problem

多根工作区（`.code-workspace`）下存在三处与"当前编辑的 mod"脱节的路径决策：

1. `getAiStorageRoot()` 原先按"第一个已存在 `.cwtools` 子目录的工作区根"选目录，与活动编辑器无关。一旦某个非当前 mod 里存在过 `.cwtools`，项目级共享 AI 数据（`.cwtools/project/profile.json`、`hooks.json`、`.cwtools/agents`、缓存回退）就会持续落在那个 mod 上。用户反馈即为此症状："我在红箭头 mod 里工作，对话（相关）的文件却存在蓝箭头目录下"。
2. `AgentToolExecutor.workspaceRoot` 是激活时一次性捕获的只读字段（`extension.ts:841` → `new AgentToolExecutor(...)`），`PromptBuilder` 与 `McpBridgeServer` 同理。运行期不跟随活动编辑器，于是工具相对路径解析、权限 profile、沙箱范围停留在激活时刻的 mod，而 `chatPanel`、`checkpoint`、`sessionPermissions` 等按 `getProjectWorkspaceRoot()`（活动编辑器优先）解析——同一轮对话里出现两套根。
3. 新会话的 `workspaceLabel` 只有 webview 手动入口，默认落进"未分组"，无法体现会话属于哪个 mod。

## Decision

1. `client/extension/ai/workspacePaths.ts`：`getAiStorageRoot()` 改为"名字为 `.cwtools` 的工作区根 → `getProjectWorkspaceRoot()`（活动编辑器所在根）→ `fallbackWorkspaceRoot` → 空串"，删除"第一个碰巧存在 `.cwtools`"规则；`fs.existsSync` 依赖随之移除。
2. 引入"每轮刷新、轮内冻结"的根切换：
   - `AgentToolExecutor`：`workspaceRoot` 去掉 `readonly`，新增 `setWorkspaceRoot()`；切换时按配置重置 `fileWriteMode`（该字段会在 `enforcePolicy` 中缓存上一个根的会话写模式），并同步 `HostArchetypeArtifactStore.setWorkspaceRoot()`。领域 handler 持有执行器自身作为 ctx，因此调用时自然读到新根。
   - `PromptBuilder`：新增 `setWorkspaceRoot()`，重建 `MemoryParser` 并清空 frozen prompt 缓存（提示词与 fingerprint 都内嵌根路径）。
   - `AgentRunner.refreshWorkspaceRoots()`：解析 `getProjectWorkspaceRoot()` 并下发到执行器与提示词构建器；在每轮用户消息开始时调用（`chatPanel` 启动 `agentRuntime.startTurn` 之前）。
3. `ChatTopicManager`：`createNewTopic()` 用当前根目录名自动写入 `workspaceId/workspaceLabel`；`forkTopic()` 继承来源会话的标签。

## Alternatives considered

- **监听 `onDidChangeActiveTextEditor` 实时切换根**：否决。同一轮内先后解析到不同根会让审批卡预览路径与执行路径不一致，锁（`canonicalPathKey`）与同文件写冲突检测也会跨 mod 漂移，属于安全性回退。
- **读取仍用"第一个存在 `.cwtools`"、写入用活动根**：否决。读写分裂会让 profile、hooks 与工作流产物落在不同 mod，比现状更难解释和排查。
- **每个工作区根各自一份会话历史**：需要自行为 `storageUri` 加按根子键、迁移既有 `topics`、并重新定义 `clearPrivateHistory` 与保留策略，属产品语义变更，本次不做。
- **外部 MCP 桥（`McpBridgeServer`）同步跟随**：否决。外部 MCP 客户端是长连接，中途换根会让外部调用方持有的相对路径语义突变，留待单独决策。

## Consequences

- 多根工作区：模型的相对路径、项目 profile、hooks、缓存与新建会话的分组都跟随当前 mod；单根与无工作区行为不变。
- 已知行为变更：在 A mod 生成的 `.cwtools/project/profile.json` 不再于 B mod 复用，切到哪个 mod 就用哪个 mod 的 profile（更贴近"一个 mod 一个项目"）。既有数据不迁移、不删除。
- 根是每轮快照：一轮对话中切换编辑器不影响当前轮，下一轮生效；`refreshWorkspaceRoots()` 在任何 run 仍在途时（`activeRunEventSinks` 非空，含后台目标/任务续跑）直接跳过切换，避免后台 run 的后续工具调用被换根。
- 验证基线：`npm run compile`、`npm run typecheck:test`、`npm run test:unit`；新增回归用例 `client/test/unit/workspacePaths.test.ts`（活动根优先、无活动编辑器回退首根）与 `client/test/unit/agentToolSafety.test.ts`（`setWorkspaceRoot` 归一化、幂等、handler 调用时跟随）。
