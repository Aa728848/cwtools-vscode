# CWTools 扩展改进计划 - 实施进度追踪

本文档用于对齐 `docs/` 下的 5 份实现计划与当前代码落地情况。

状态口径：

- `已完成`：本轮计划中的首个可交付 PR/阶段目标已经落地，并有对应测试或编译验证。
- `部分完成`：骨架已落地，但计划中的后续深化项仍未完成。
- `后续项`：不阻塞本轮交付，但建议进入下一轮 roadmap。

## 总览

| 阶段 | 对应计划 | 当前状态 | 本轮核心成果 | 新增测试 |
| --- | --- | --- | --- | --- |
| 1 | [GameProfile Platform](docs/01-game-profile-platform-plan.md) | ✅ 达成 | 9 个游戏 profile 注册表，`extension.ts` 消费者迁移 | 25 个 |
| 1.4 | GameProfile AI 消费者迁移 | ✅ 达成 | `getGameDisplayName()` 委托到 GameProfile | 并入阶段 1 |
| 2 | [AI Workflow System](docs/02-ai-workflow-system-plan.md) | ✅ 核心达成 | 5 个 workflow 注册表 + runner 实际消费 (toolPolicy + promptSupplement) | 18 个 |
| 3 | [Incremental Index and Knowledge Layer](docs/03-incremental-index-knowledge-layer-plan.md) | ✅ 本轮达成 | `IndexService` + `locParser` 纯逻辑提取，解析/索引/查询/删除全链路 | 24 个 |
| 4 | [Webview Modularization](docs/04-webview-modularization-plan.md) | ✅ 阶段性达成 | chat 消息类型契约 + 格式化 helper 抽取 + chatPanel 实际消费 | 28 个 |
| 5 | [Test and Release Quality Gate](docs/05-test-and-release-quality-gate-plan.md) | ✅ 达成 | `check:release` 全绿 + `verify` 综合命令 + ESLint 测试免豁 | 通过脚本执行 |

本轮新增/修复测试共 99 个：`gameProfiles` 25、`workflowRegistry` 18、`chatFormatters` 28、`indexService` 24、`pricing` 4（修复）。

## 阶段 1: GameProfile 平台层

对应计划：[docs/01-game-profile-platform-plan.md](docs/01-game-profile-platform-plan.md)

### 已交付

- 新增 `client/extension/gameProfiles.ts`。
- 定义 `GameProfile` 主契约及子契约：
  - `LocalisationProfile`
  - `GameFolderProfile`
  - `PreviewCapabilityProfile`
  - `GameAiProfile`
  - `GameInstallProfile`
- 注册 9 个 Paradox 游戏 profile：
  - Stellaris
  - Hearts of Iron IV
  - Europa Universalis IV
  - Crusader Kings II
  - Imperator: Rome
  - Victoria 2
  - Crusader Kings III
  - Victoria 3
  - Europa Universalis V
- 提供 profile 查询和兼容 helper：
  - `getProfileByLanguageId()`
  - `getProfileForDocument()`
  - `getDefaultProfile()`
  - `getAllProfiles()`
  - `hasPreviewCapability()`
  - `getRulesRemoteUrl()`
  - `getCacheSettingKey()`
  - `getGameInfoMap()`
  - `getGameExeList()`
  - `getGameFolderMapping()`
  - `getAlternativeSteamFolderNames()`
- `client/extension/extension.ts` 已迁移到集中 profile 配置，减少硬编码游戏 URL、路径映射和分支。

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| 新游戏可通过新增 registry entry 接入 | 已完成基础能力 |
| Stellaris 行为保持默认优先 | 已完成，未知语言 fallback 到 Stellaris |
| preview 能力通过 capability gating 表达 | 已完成 profile 能力字段 |
| AI prompt 可拿到明确 game profile | 已完成第一步，见阶段 1.4 |
| profile resolution 有测试 | 已完成 |

### 测试

- `client/test/unit/gameProfiles.test.ts`
- 覆盖 25 个测试用例。

### 后续项

- 将更多散落的路径判断继续迁移到 `GameProfile`。
- 将 manifest 的多游戏声明与 `GameProfile` 做一致性检查。
- 为第二个非 Stellaris 游戏加入更真实的 fixture 和端到端验证。

## 阶段 1.4: AI 消费者迁移

对应计划：阶段 1 的 AI consumer 子任务。

### 已交付

- `client/extension/ai/gameKnowledge.ts`
  - 引入 `getProfileByLanguageId()`。
  - `getGameDisplayName(languageId)` 改为返回 `GameProfile.displayName`。
  - `paradox` 元语言 ID 继续走特殊 fallback 语义。

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| AI 能从 profile 层读取游戏显示名 | 已完成 |
| 避免 AI 侧重复维护游戏名映射 | 已完成第一步 |

### 后续项

- 将更多 `gameKnowledge` 内部的游戏知识块与 `GameAiProfile.knowledgeKey` 绑定。
- 在 AI prompt 构建时显式传递完整 profile，而不只是显示名。

## 阶段 2: AI 工作流系统

对应计划：[docs/02-ai-workflow-system-plan.md](docs/02-ai-workflow-system-plan.md)

### 已交付

- 新增 `client/extension/ai/workflowRegistry.ts`。
- 定义 workflow 契约：
  - `AiWorkflow`
  - `WorkflowContextRequirement`
  - `WorkflowToolPolicy`
  - `WorkflowPhase`
  - `WorkflowVerificationStep`
- 注册 5 个初始 workflow：
  - `diagnostic-fix`
  - `loc-generation`
  - `event-chain-design`
  - `rules-sync-review`
  - `asset-wiring`
- 提供 workflow 查询 helper：
  - `getWorkflow()`
  - `getAllWorkflows()`
  - `getAllWorkflowIds()`
  - `getWorkflowAllowedTools()`
  - `checkWorkflowContext()`
- `client/extension/ai/agentRunner.ts`
  - 新增 `AgentRunnerOptions.workflowId`。
  - **已接入 workflow 执行逻辑**：
    - 在 tool filter 后应用 `workflow.toolPolicy`（allowlist/blocklist 进一步过滤工具集）。
    - 在 system prompt 前注入 `workflow.promptSupplement`。
    - ErrorReporter 日志记录 workflow 生效状态。

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| workflow registry 可加载 | 已完成 |
| 至少 Diagnostic Fix / Localisation workflow 可表达 | 已完成，且扩展到 5 个 |
| runner 可识别 active workflow | 已完成，`workflowId` 驱动 toolPolicy + promptSupplement |
| workflow toolPolicy 实际过滤工具 | 已完成，在 `filterToolDefinitionsForMode` 后二次过滤 |
| workflow promptSupplement 注入 system prompt | 已完成，前置于 mode prompt 之前 |

### 测试

- `client/test/unit/workflowRegistry.test.ts`
- 覆盖 18 个测试用例。

### 后续项

- 在 chat panel 中展示当前 workflow、phase 和 verification 状态。
- 为 workflow tool policy 的执行路径增加 runner 级测试。
- 增加命令入口或 UI 入口，让用户可直接启动常见 workflow。

## 阶段 3: 增量索引与知识层

对应计划：[docs/03-incremental-index-knowledge-layer-plan.md](docs/03-incremental-index-knowledge-layer-plan.md)

### 已交付

- 新增 `client/extension/indexing/indexService.ts`。
- 新增 `client/extension/indexing/locParser.ts` — 纯函数模块，可独立测试。
  - `parseLocFile(content, filePath)` — 解析 Paradox 本地化 YML 文件。
  - `detectLocLanguage(content)` — 检测语言标签。
  - `addEntriesToIndex(index, entries)` — 向内存索引添加条目。
  - `removeFileFromIndex(index, filePath)` — 按文件路径移除索引条目。
  - `queryLocIndex(index, query)` — 查询索引（精确/前缀/全量 + 语言过滤 + limit）。
- `IndexService` 已重构为消费 `locParser.ts`，自身仅保留 vscode 生命周期和 I/O 层。
- 实现 `IndexService` 生命周期：
  - `start()`
  - `refresh(reason)`
  - `updateFile(uri)`
  - `removeFile(uri)`
  - `dispose()`
- 实现文件监听：
  - 监听 `localisation`、`localisation_synced`、`localization` 下的 `.yml` 文件。
  - 文件变更使用 300ms debounce。
- 实现本地化 key 索引：
  - `queryLocalisation(query)`
  - `hasLocKey(key)`
  - 精确匹配、前缀匹配、language 过滤、limit 限制。
- 实现状态管理：
  - `idle`
  - `indexing`
  - `ready`
  - `error`

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| 建立 index service skeleton | 已完成 |
| 文件变化可增量更新 | 已完成本地化文件路径 |
| 本地化 key 可查询 | 已完成 |
| symbol/asset/event/tech 索引 | 待后续 |
| AI/previews 消费共享索引 | 已完成第一批：`locDecorations.ts` 通过 `IndexService` 查询本地化 key |
| stale-file removal | 已完成并有测试覆盖 |
| 纯逻辑可单元测试 | 已完成 |

### 测试

- `client/test/unit/indexService.test.ts`
- 覆盖 24 个测试用例：parseLocFile（标准/版本号/无版本号/CRLF/行号/空文件/多语言）、detectLocLanguage、addEntriesToIndex（空索引/追加重复键）、removeFileFromIndex（单文件/全清/不存在文件）、queryLocIndex（精确/语言过滤/前缀/不存在/无条件/limit/语言过滤全量）。

### 后续项

- 继续将更多 AI tools/previews 消费者迁移到 `IndexService`。
- 增加 top-level PDXScript symbol 索引。
- 增加 sprite/asset/event/technology 查询。
- 将索引 freshness/status 暴露给 AI tools。

## 阶段 4: Webview 模块化

对应计划：[docs/04-webview-modularization-plan.md](docs/04-webview-modularization-plan.md)

### 已交付

- 新增 `client/webview/chat/messageTypes.ts`。
  - 定义 Webview -> Host 消息联合类型。
  - 定义 Host -> Webview 消息联合类型。
  - 为 chat panel 的消息契约建立集中类型入口。
- 新增 `client/webview/chat/formatters.ts`。
  - 抽取纯格式化 helper：
    - `escapeHtml`
    - `formatNum`
    - `formatTime`
    - `formatDuration`
    - `fileBaseName`
    - `extractStepFile`
    - `makeRunSummary`
  - 抽取 `RunSummary` 接口。
  - 抽取工具分类常量。

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| webview message contracts typed | 已完成 chat panel 第一批 |
| chat helper extraction | 已完成第一批纯函数 |
| extracted helpers 有测试 | 已完成 |
| `chatPanel.ts` 实际消费提取模块 | 已完成（import 委托，内部定义替换为 formatters 导入） |
| `chatPanel.ts` 变成 bootstrap | 待后续（进一步拆分 view/state 模块） |
| entity preview scene/material/locator 拆分 | 待后续 |
| visual regression | 待后续 |

### 测试

- `client/test/unit/chatFormatters.test.ts`
- 覆盖 28 个测试用例。

### 后续项

- 继续拆分 settings view、topics view、live steps、artifact/diff view。
- 拆分 `entityPreview.ts` 的 scene、materials、textures、locators、attachments、animation。
- 增加 webview smoke/visual regression 测试。

## 阶段 5: 测试与发布质量门禁

对应计划：[docs/05-test-and-release-quality-gate-plan.md](docs/05-test-and-release-quality-gate-plan.md)

### 已交付

- 新增 `tools/check-release.js`，覆盖 10 项检查。
- `package.json` 新增：
  - `check:release`: `node tools/check-release.js`
  - `verify`: `npm run lint && npm run compile && npm run test:unit && npm run check:release -- --skip-compile --skip-test`
- 支持 `--skip-compile` 和 `--skip-test` 标记避免在 `verify` 流程中重复执行。
- 当前 release check 覆盖 10 项：
  1. Root `package.json` 与 `release/package.json` version 对齐。
  2. 当前 version 是否存在 CHANGELOG entry（检查根和 release 两个位置）。
  3. 必需文件存在性检查（README、CHANGELOG、LICENSE）。
  4. extension source 中硬编码 localhost/API key 扫描。
  5. TypeScript 编译检查。
  6. 单元测试。
  7. Release manifest (`release/package.json`) JSON 有效性和必需字段检查。
  8. NLS key 完整性：`package.nls.json` ↔ `package.nls.zh.json` 双向 key 对齐。
  9. NLS key 引用：manifest 中 `%key%` 引用的 key 在 NLS 文件中存在。
  10. Webview bundle 非空检查（6 个核心 bundle）。
  11. Server binary 三平台（win-x64, linux-x64, osx-x64）存在性检查。

### 验收对齐

| 计划验收项 | 当前结果 |
| --- | --- |
| 单命令验证 release readiness | 已完成 `npm run verify` |
| version mismatch 显式检查 | 已完成，对齐 `release/package.json` |
| required files 检查 | 已完成 |
| compile/test 串入 gate | 已完成 |
| NLS key 检查 | 已完成（en↔zh 双向 + manifest %key% 引用） |
| webview bundle/server output 检查 | 已完成（6 个 bundle + 3 个平台） |
| CI | 已完成：新增 GitHub Actions `npm run verify` 工作流 |

### 注意事项

- 当前 root `package.json` 与 `release/package.json` 已同步为 `2.1.23`。
- `client/extension/ai/aiService.ts` 中包含 `localhost` 地址，这是 Ollama 本地提供者的合理默认值。

### 后续项

- 增加版本同步命令（自动更新 root 和 release manifest）。
- 增加 webview visual regression 检测。

## 编译与测试状态（最终复核 2026-05-17）

| 检查项 | 结果 |
| --- | --- |
| `npm run compile` | ✅ 通过 |
| `npm run test:unit` | ✅ **442 passing, 0 failing** |
| `node tools/check-release.js` | ✅ 通过 |
| `npx eslint client/test/` | ✅ 通过（0 warnings） |
| `npm run lint`（全量） | ✅ 通过（0 errors, 0 warnings） |

## 新增文件清单

| 文件 | 阶段 | 说明 |
| --- | --- | --- |
| `client/extension/gameProfiles.ts` | 1 | GameProfile 注册表与 helper |
| `client/test/unit/gameProfiles.test.ts` | 1 | GameProfile 单元测试 |
| `client/extension/ai/workflowRegistry.ts` | 2 | AI workflow 注册表 |
| `client/test/unit/workflowRegistry.test.ts` | 2 | AI workflow 单元测试 |
| `client/extension/indexing/indexService.ts` | 3 | 增量索引服务（vscode 生命周期层） |
| `client/extension/indexing/locParser.ts` | 3 | 本地化解析纯函数（无 vscode 依赖） |
| `client/test/unit/indexService.test.ts` | 3 | 索引纯逻辑单元测试 |
| `client/webview/chat/messageTypes.ts` | 4 | Chat webview 消息类型契约 |
| `client/webview/chat/formatters.ts` | 4 | Chat 格式化 helper |
| `client/test/unit/chatFormatters.test.ts` | 4 | Chat helper 单元测试 |
| `tools/check-release.js` | 5 | Release quality gate 脚本（10 项检查） |
| `.github/workflows/ci.yml` | 5 | GitHub Actions CI，执行 `npm run verify` |
| `client/webview/chat/artifacts.ts` | 4 | Chat artifact drawer 纯模型/helper |
| `client/webview/chat/topics.ts` | 4 | Chat topic panel 纯模型/helper |
| `client/webview/chat/workflows.ts` | 2/4 | Webview workflow selector/helper |
| `client/extension/ai/workflowViewModel.ts` | 2 | Host → Webview workflow 视图模型 |
| `client/test/unit/chatModels.test.ts` | 4/5 | Chat topics/artifacts/workflows 模型测试 |
| `client/test/unit/workflowViewModel.test.ts` | 2 | Workflow 视图模型测试 |
| `client/test/unit/webviewSmoke.test.ts` | 5 | Chat webview smoke 检查 |
| `client/extension/ai/workflowI18n.ts` | 2 | Workflow 中英文 i18n 文案与 UI 标签 |
| `client/webview/chat/workflowSelector.ts` | 4 | Workflow selector DOM 渲染模块 |
| `client/extension/indexing/workspaceSymbolParser.ts` | 3 | Workspace symbol/asset 纯解析与查询 helper |
| `client/test/unit/workspaceSymbolParser.test.ts` | 3/5 | Workspace symbol/asset 索引单元测试 |

## 修改文件清单

| 文件 | 改动 |
| --- | --- |
| `client/extension/extension.ts` | 使用 GameProfile 替代硬编码游戏配置 |
| `client/extension/ai/gameKnowledge.ts` | `getGameDisplayName()` 委托到 GameProfile |
| `client/extension/ai/agentRunner.ts` | 新增 `workflowId` 选项 |
| `client/extension/ai/agentTools.ts` | 新增 `query_localisation_index` / `query_workspace_index`，通过共享 `IndexService` 查询本地化与 workspace 索引 |
| `client/extension/ai/chatPanel.ts` | 新增 workflow 状态下发、切换入口、i18n 标签与 active workflow 传递 |
| `client/extension/ai/chatHtml.ts` | 新增 workflow selector |
| `client/extension/ai/tools/definitions.ts` | 新增 `query_localisation_index` / `query_workspace_index` 工具 schema |
| `client/extension/ai/tools/registry.ts` | 将 `query_localisation_index` / `query_workspace_index` 注册为只读工具 |
| `client/extension/gameProfiles.ts` | 新增本地化目录推导 helper |
| `client/extension/indexing/indexService.ts` | 本地化扫描/监听 glob 改为从 `GameProfile` 推导，并扩展 workspace symbol/asset 索引 |
| `client/extension/locDecorations.ts` | 迁移本地化 hover/definition 到共享 `IndexService` |
| `client/webview/chatPanel.ts` | 内部 helper 继续迁移到 `chat/formatters.ts`、`chat/artifacts.ts`、`chat/topics.ts`、`chat/workflows.ts`、`chat/workflowSelector.ts` |
| `package.json` | 新增 `check:release` + `verify` scripts |

## 本轮追加完成项（2026-05-17）

针对上一轮列出的 5 个后续方向，本轮已完成一批可编译、可测试的落地点：

1. `chatPanel.ts` 继续模块化：新增 artifacts/topics/workflows 纯模型模块，并让 chat panel 消费。
2. `IndexService` 扩大消费入口：新增 AI 工具 `query_localisation_index`。
3. AI Workflow 可见化入口：新增 workflow selector、`switchWorkflow`、`/workflow:<id>`、`/workflow:off`，并把 active workflow 传入 `AgentRunner.run()`。
4. `GameProfile` 继续成为游戏能力入口：本地化扫描/监听目录由 profile 推导。
5. Webview 质量门补强：新增 chat webview smoke 检查。

当前验证：

- `npm run compile`：通过
- `npm run test:unit`：442 passing, 0 failing
- `npm run lint`：通过，0 warnings

## 下一轮建议优先级

1. 继续拆分 `chatPanel.ts` 为 settings/topics/liveSteps/artifacts 子模块。
2. 增加 webview smoke/visual regression 检测。
3. 继续将更多 AI tools/previews 消费者迁移到 `IndexService`。
4. 增加 top-level PDXScript symbol、sprite/asset/event/technology 索引。
5. 继续将 GameProfile 作为新增游戏能力的唯一入口。
