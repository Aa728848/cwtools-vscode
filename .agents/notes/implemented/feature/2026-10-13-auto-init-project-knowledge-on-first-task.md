# Agent Note: 无项目知识库时首个任务自动后台执行 /init 并反馈到对话窗口

Status: implemented

## Problem
项目知识库（`<workspaceRoot>/.cwtools/project/knowledge/knowledge.sqlite` + `manifest.json`）是 Agent 理解当前项目语义的基础，但它只在用户手动执行 `/init` 后才会生成。未执行过 `/init` 的工作区里，用户直接开始任务时 Agent 缺少项目级语义证据，回答质量下降，且用户往往不知道需要先初始化。此前不存在任何自动引导或自动构建机制。

## Decision
1. **入口触发**：`handleUserMessage`（`client/extension/ai/chatPanel.ts`）在 AI-enabled 检查之后、模式路由之前同步调用 `ensureProjectKnowledgeInitialized()`；方法内部异步执行，绝不阻塞当前 turn。Slash 命令路径在此之前已返回，不会误触发。
2. **缺失判定**：对每个 workspace folder，先经 `findKnowledgeOwnerRoot`（`client/extension/ai/projectKnowledge.ts`，本次改为 `export` 以复用多根持有判定）解析出持有根，再用 `chatInit.ts` 新增的 `isProjectKnowledgeDatabaseReady(root)` 判定：manifest 存在、`knowledge.sqlite` 存在、且 `manifest.schemaVersion` 与 `manifest.database.schemaVersion` 均等于当前 `PROJECT_KNOWLEDGE_SCHEMA_VERSION`（与 `queryProjectKnowledge` 的过期语义一致）。多根场景下被其它根 manifest `projectRoots` 覆盖的 folder 视为已初始化，不重复触发。
3. **会话级防重**：`autoInitAttemptedRoots: Set<string>` 记录本会话已触发的根，`autoInitInFlight` 防止并发重入；每个根每会话最多自动初始化一次，失败后由用户手动 `/init` 重试。
4. **对话窗口反馈**：触发时先经 `postMessage` 广播一条 `agentStep(thinking)` 双语提示（侧边栏与独立窗口均可见）；完成后按结果发 `slashCommandResult`，command 为 `/init (auto)`，成功/失败均为双语文案，失败时提示可手动 `/init`。
5. **auto 模式**：`chatInit.ts` 的 `generateInitFile`/`generateInitFileCore` 与 chatPanel 的 `generateInitFile` 包装均接受 `options?: { auto?: boolean }`；auto 模式跳过结尾打开 CWTOOLS.md 编辑器（避免后台任务抢夺焦点），profile 生成、符号索引、知识库导出、withProgress 与 agentStep 进度反馈完全保持不变。手动 `/init` 不传 options，行为与此前完全一致。
6. **设置开关**：`stellarisLanguageServices.ai.autoInitProjectKnowledge`（默认 `true`）可关闭自动初始化。

## Alternatives considered
- **在扩展激活时自动初始化**：否决。激活期 CWTools LSP 游戏模型尚未就绪，导出必然失败或退化为不可用清单；且对只浏览不提问的用户造成无谓的全量扫描开销。首个 AI 任务是最合适的惰性触发点。
- **阻塞当前 turn 等待初始化完成**：否决。全量知识导出耗时数十秒，阻塞会严重损害首轮交互体验；后台构建 + 完成后 `slashCommandResult` 通知已足够。
- **每个缺失根各触发一次 generateInitFile**：否决。`generateInitFileCore` 只初始化 `folders[0]`，多触发只会重复写同一批产物；会话级 Set 统一去重。
- **在 chatPanel 内联复制 findKnowledgeOwnerRoot 的多根判定**：否决。违反「优先复用现有 helper」原则；改为给既有函数加 `export`（一词改动，无行为变化）。

## Consequences
- 新工作区首个 AI 任务会自动补齐知识库，后续任务直接受益于项目语义证据；用户可从设置关闭。
- `projectKnowledge.ts` 的公共 API 新增 `findKnowledgeOwnerRoot` 导出（仅供 chatPanel 复用，无行为变化）。
- 自动与手动 `/init` 共享同一生成管线，维护面不增加；auto 与 manual 的唯一差异是是否打开 CWTOOLS.md 编辑器。
- 已知限制：多根工作区中自动初始化仍只构建首个 folder（`generateInitFileCore` 的既有行为），其余缺失根会在反馈文案后由用户手动处理。
- 测试：`client/test/unit/chatInit.test.ts` 新增 auto/manual 编辑器打开行为断言；`client/test/unit/chatAutoInit.test.ts` 覆盖缺 manifest / 缺 db / manifest schema 过期 / 仅 database schema 过期 / 已初始化五种判定。
