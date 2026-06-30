# 贡献指南

感谢你关注 **Stellaris Language Serves**。这份文档面向贡献者，说明如何准备环境、运行项目、提交改动和选择验证方式。架构背景见 [ARCHITECTURE.md](./ARCHITECTURE.md)，AI Agent 工作速查见 [CLAUDE.md](./CLAUDE.md)。

## 环境要求

| 工具 | 推荐版本 | 用途 |
| --- | --- | --- |
| Node.js | 20.x 或更高 | TypeScript 编译、Rollup Webview 打包 |
| npm | 10.x 或更高 | 依赖安装和脚本运行 |
| .NET SDK | 10.0.x | F# 语言服务器和 `CWTools Server` 构建 |
| VS Code | 1.90 或更高 | 扩展开发宿主和测试 |
| Git | 最新稳定版 | 源码和子模块管理 |

仓库的 `global.json` 当前指定 .NET SDK `10.0.301`，并允许 `latestMinor` roll-forward。

## 克隆和安装

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

如果已经克隆但缺少子模块：

```bash
git submodule update --init --recursive
```

默认 F# 构建使用 `submodules/cwtools`。如果需要指向本地 CWTools 仓库，可在 `src/Main/cwtools.local.props` 创建本机配置：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

把 `CwtoolsPath` 改成你的实际路径。不要提交本机路径配置。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run compile` | 编译扩展 TypeScript，并用 Rollup 打包 Webview |
| `npm run lint` | ESLint 9 检查 `client/` |
| `npm run test:unit` | 运行 `client/test/unit/**/*.test.ts` |
| `npm run test` | 编译后运行 VS Code 集成测试 |
| `npm run check:release` | 检查发布包元数据和必要产物 |
| `npm run verify` | 本地综合验证：lint、compile、unit、release gate |
| `npm run build:shared` / `build:mcp` | 构建 MCP 子包（`packages/cwtools-shared` / `cwtools-mcp`） |
| `npm run generate:mcp-schema` | 从上游 `definitions.ts`+`registry.ts` 重生成 MCP 工具 schema |
| `npm run test:contracts` | MCP 合约测试（schema 漂移、只读策略、工具路由、深层工具） |
| `dotnet build src/LSP/` | 构建 LSP 协议/解析层 |
| `dotnet build src/Main/` | 构建 `CWTools Server` |

`npm run compile` 会执行：

1. `tsc -p ./.config/tsconfig.extension.json`
2. `rollup -c`

Rollup 当前打包 7 个 Webview 入口：

- `client/webview/chatPanel.ts`
- `client/webview/agentManager.ts`
- `client/webview/guiPreview.ts`
- `client/webview/solarSystemPreview.ts`
- `client/webview/eventChainPreview.ts`
- `client/webview/techTreePreview.ts`
- `client/webview/entityPreview.ts`

Stellaris 规则同步脚本：

```bash
npm run rules:stellaris
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
```

`rules:stellaris:report` 会把最新游戏 `script_documentation` 日志、原版 `common/`
与 CWT 配置基线做只读对比，并生成自包含 HTML 报告
（`tools/rules-sync/report.ts`，默认自动在浏览器打开，可用 `--no-open` 关闭）。
详见 [tools/rules-sync/README.md](./tools/rules-sync/README.md)。


## 运行和调试

1. 用 VS Code 打开仓库根目录。
2. 按 `F5` 或执行 `Run and Debug: Start Debugging`。
3. VS Code 会启动新的 Extension Development Host 窗口。
4. 修改代码后，重新运行调试会话或重载开发宿主。

调试 Webview：

1. 在 Extension Development Host 中打开相关面板。
2. 执行 `Developer: Open Webview Developer Tools`。
3. 在 DevTools 中检查 DOM、控制台、网络请求和断点。

## 项目结构速览

```text
client/
  extension/                  VS Code Extension Host
    ai/                       AI assistant — full subsystem
      chat/                   Webview ↔ Host communication bridge
      orchestrator/           Multi-agent DAG, blackboard, sandbox, conflict & quality gates
      runner/                 Execution pipeline: compaction, checkpoint, scheduling,
                              permissions, ledger, reducers, replay, read tracking, memory
      tools/                  Tool schemas, registry, permissions, arg repair, handlers,
                              diagnostic metadata, fuzzy replacer suite, schema flattening
      prompt/
        sections/             Base system prompt and per-mode prompt sections
      providers/
        models/               Default model configs, capabilities, pricing
      agentRunner.ts          Main reasoning loop
      agentTools.ts           Tool dispatch hub
      aiService.ts            Multi-provider AI client
      promptBuilder.ts        Prompt construction facade
      projectProfile.ts       /init project scanning and profile
      chatInit.ts             /init command handler
      gameKnowledge.ts        Per-game PDXScript knowledge blocks (9 games)
      skills.ts               SKILL.md index (built-in/user/project) + run_skill body loading
      memoryParser.ts         Topic-scoped .cwtools-ai-memory.md long-term memory
      workspacePaths.ts       AI storage root, topic/scratch dirs
      workspaceSandbox.ts     Path sanitization and scope classification
      runnerPolicy.ts         Mode-based tool filtering and iteration limits
      planModeGuard.ts        Plan-mode write guard (plan + artifact files only)
      usageTracker.ts         Cumulative token usage and cost tracking
      diffEngine.ts           Structural diff engine
      fileCache.ts            Bounded file content cache
      errorReporter.ts        Structured error reporting
      toolCallParser.ts       Non-standard tool call parsing
      jsonRepair.ts           Incomplete JSON repair
      inlineProvider.ts       AI inline (FIM) completion for PDXScript
      mcpClient.ts            MCP stdio/SSE client
      types.ts                All AI type definitions
      workflowRegistry.ts     Workflow metadata and tool policies
      workflowI18n.ts         Workflow localization
    indexing/                 Shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           Multi-game profile registry
    extension.ts              Activation and command registration
    diagnosticI18n.ts         Client-side diagnostic Chinese translation + fix advice
    fileExtensions.ts         Case-insensitive extension matching helpers
    fsCaseInsensitive.ts      Case-insensitive path resolution (Linux/macOS)
    pathScope.ts              Shared isPathInsideOrEqual / foldPathCase helpers
    vanillaCompare.ts         Vanilla file diff and block migration
  webview/                    Browser-sandboxed Webview scripts
    chat/                     Extracted chat and Agent Manager modules (22 files)
    messageRenderer.ts        Message rendering (cache sparkline, annotations)
    svgIcons.ts               High-fidelity SVG icon library
    *Preview.ts               GUI, solar system, event chain, tech tree, entity previews
  test/
    unit/                     ts-mocha unit tests (60 files)
    suite/                    VS Code integration tests

src/
  LSP/                        Reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  Resource strings
  CSharpExtensions/           Helper project

docs/
  diagnostic-codes.md         CWxxx diagnostic code reference (codeDescription targets)

packages/
  cwtools-shared/             Read-only MCP core: generated schema, HostServices,
                              path/rules safety, vanilla-cache + readiness, knowledge
  cwtools-mcp/                MCP stdio/HTTP server: CLI, NodeHostServices,
                              LspProcessHost, vscodeCache detection, esbuild bundle

tools/
  rules-sync/                 Stellaris rules scan/check/update/report tooling
  generate-mcp-schema.cjs     Generates MCP tool schema from upstream definitions

submodules/
  cwtools/                    Upstream CWTools F# library
  cwtools-stellaris-config/   Stellaris CWT config data
```

## 开发规范

### TypeScript 和 Extension Host

- 优先复用现有模块风格和本地 helper，不为小改动引入新抽象。
- 生产代码避免无理由的 `any`；未知数据优先用 `unknown` 和类型守卫。
- 关注 ESLint 9 的异步安全规则：`no-floating-promises`、`no-misused-promises`、`prefer-promise-reject-errors`。
- Extension/AI 错误报告优先使用 `ErrorReporter`，不要裸用 `console.error`。
- 用户可见中文文本尽量放入现有 message / i18n 模块：
  `client/extension/ai/messages.ts`、`client/extension/ai/workflowI18n.ts`、`client/webview/chat/i18n.ts`。
- 修改大文件时优先做局部、可验证的变更，避免无关格式化和重排。

### Webview

Webview 运行在浏览器沙盒中：

- 不要导入 `vscode`、`fs`、`path` 或任何 Node.js-only API。
- 不要使用 `require()`。
- 与扩展宿主通信必须通过 `postMessage`。
- CSS 使用 VS Code 主题变量，例如 `var(--vscode-editor-background)`。
- 动画应支持 `prefers-reduced-motion`。
- Three.js/WebGL 面板必须在销毁时释放 renderer、geometry、material、texture、worker、事件监听器和动画循环。
- 新增 chat UI 逻辑时，优先沿用 `client/webview/chat/` 的拆分模式。
- Chat 面板和 Agent Manager 面板共享 host-side state；涉及跨 surface 同步时检查 `AgentUiBroadcaster`、`AgentSessionCoordinator`、`ArtifactStore` 和 `ai/chat/bridge.ts`。
- **沙盒与 I/O 隔离边界 (ReadTracker)**：不要在 Webview 端直接操作文件或绕过 IPC 抓取文件树与文件元数据。I/O 跟踪逻辑（如 `ReadTracker`）只在 Extension Host 中执行，前端仅做数据展现，所有文件访问通过 `postMessage` 委托给 Host。
- **前缀缓存度量卡片 (Prompt Cache)**：模型支持缓存并命中或新建前缀缓存（如 DeepSeek、Claude）时，后端会发射 `cache_stats` 事件，前端 `messageRenderer.ts` 将其渲染为三柱微图卡片（绿色命中 / 蓝色新建 / 橙黄穿透，Cache Sparkline）。改动缓存折扣率（如 DeepSeek/Claude 的 0.1× 优惠）或其持久化时，需同步查验 `pricing.ts`、`UsageTracker` 与前端 `agentManager.ts` / `chatPanel.ts` 的渲染区块。
- **UI 图标规范**：Token 使用看板等 UI 区域不要使用裸 Emoji（如 ⚡），改用带内联样式的 SVG 矢量图标（支持 `stroke="currentColor"` 主题色自适应与垂直对齐）。

### 平台与索引层

- 新的游戏差异优先放入 `client/extension/gameProfiles.ts`，不要在消费者里继续散落硬编码。
- 新的 localisation、symbol、asset 查询优先复用 `IndexService`；只有共享索引无法回答时才新增额外扫描逻辑。
- `IndexService` 的纯逻辑尽量留在 `locParser.ts` / `workspaceSymbolParser.ts`，便于单元测试。
- 新增查询维度时同步考虑 workspace 与 vanilla 来源、freshness / `fileVersion` 元数据、limit 和缓存边界。

### AI Agent

新增或修改 AI 工具时，请同步维护：

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts`（如果访问策略变化）
5. `client/extension/ai/agentTools.ts`

工具设计注意点：

- `tools/registry.ts` 是模式门控、读写分类和子 Agent 可用性的事实来源；同时派生 `effect`、`riskLevel`、`concurrencyClass`。
- 结构化读取优先于原始命令读取：先考虑 `query_workspace_index`、`document_symbols`、`get_pdx_block`、`get_file_context`。
- `run_command` 必须经过 `runner/commandPreflight.ts` 风险分级；高危/升级类命令不能经预批准规则自动放行。
- `runner/permissionPolicy.ts` 只放行低风险预批准命令；`cwdScope` 校验必须保留 `path.relative` 形式，不要退回 `startsWith`。
- 写文件工具由 `PartitionedWriteQueue` 按文件路径串行化；多文件写入按路径字典序获取锁。
- `.yml` 本地化文件必须用 `write_localisation`，不要用通用写入或替换工具直接写。
- 多 Agent 协作使用 `dispatch_agents`、`query_blackboard`、`merge_results`；子 Agent 分派必须经过 `orchestrator/subAgentSandbox.ts`。
- 技能系统：`SKILL.md` 文件（built-in / user / project 三类作用域）由 `skills.ts` 建立索引，`promptBuilder.ts` 只注入精简的技能索引；完整技能正文通过 `run_skill` 工具按需加载，避免撑大基础 prompt。
- 计划模式写入受 `planModeGuard.ts` 约束：仅允许写入实现计划（`implementation_plan.md`）与 plan/blueprint/walkthrough 等产物文件，其余写操作一律拦截。
- 只读导向模式（plan/explore/review/script_reviewer/orchestrator/script）下的 `git_ops` 只放行 `status`/`diff`，变更性 action 由 `planModeGuard.ts` 的 `validateGitOpsForMode` 在 `agentRunner`/`agentTools` 执行前拦截。
- `edit_file(filePath, oldString, newString, replaceAll?)` 是单处模糊替换原语，复用 `fuzzyReplace` 与既有写守卫（`.yml` 拒绝、ReadTracker、pending-write）。新增同类编辑工具时记得同步 `editFailCount` 升级与 `doomLoopDetector` 归一化。
- `apply_patch`、`multi_replace_file_content`、`ast_mutate` 已从模型可见工具集中退役：`agentTools.execute()` 会拦截这些调用并引导改用 `edit_file`/`replace_lines`/`edit_pdx_block`/`write_localisation`；实现保留仅供内部调用，不要重新暴露。
- 同一文件的读操作会经 `writeCoordinator.afterCurrentWrites` 排在在途写入之后；`getAgentToolTargetFiles` 已为 `read_file`/`get_pdx_block`/`get_file_context`/`edit_file` 补齐路径提取。
- `get_file_context`/`get_pdx_block` 现会 `markRead` 并返回 1 基 `startLine`/`endLine`，可直接衔接 `replace_lines`；读/搜索工具出错时返回 `error` 字段以区别于"空结果"。`read_file` 输出带 `N | ` 行号前缀，`replacerSuite.ts` 的 `stripLineNumberPrefixes` 会在 `edit_file` 匹配失败时剥离模型误粘贴的行号前缀。
- 诊断修复元数据集中在 `tools/diagnosticMetadata.ts`：为 `analyze_diagnostic_error` 提供诊断分类（`DiagnosticAnalysisCategory`）与修复提示，修改时同步更新 `diagnosticMetadata.test.ts`。
- 新增用户可见运行步骤时，通过 `runner/runLedger.ts` 写事件；新增事件类型时同步 `runTimeline.ts`、`runInspector.ts` 和 `runReducers.ts`。
- 文件编辑的模糊匹配策略集中在 `tools/replacerSuite.ts`（`fuzzyReplace`），由 `tools/fileTools.ts` 的 `replace()` 辅助方法消费，用于 `edit_file` 工具与内部 hunk 应用（`replace_lines` 完全按行号替换）。它包含 10 种递进式匹配算法（直接匹配、Unicode 归一化、行级 trim、块锚定、空白归一化、缩进弹性、转义归一化、边界 trim、上下文感知、Jaccard 相似度）。修改替换策略时请同步更新 `editFileReplacer.test.ts`。
- 面向弱工具调用能力的 Provider，`tools/schemaFlatten.ts` 可自动将深层嵌套 schema 展平；执行工具前由 `nestArguments()` 反向还原。
- `runner/readTracker.ts` 在 Extension Host 中跟踪文件的读取状态（mtime + SHA-256 hash），防止 Agent 未读即写或写入已被外部修改的文件。
- `runner/runReducers.ts` 提供纯函数式的事件投影 reducer，用于从 JSONL 事件流重建 run 状态、工具时间线、Agent 拓扑图和缓存统计快照。新增事件类型时必须更新对应 reducer。
- `runner/runReplay.ts` 提供运行回放功能：模式 A (recorded-tool) 使用原始 ledger 的工具结果回答工具调用，模式 B (full-replay) 暂缓。`ReplaySession` 按规范化参数索引工具结果。
- `workspacePaths.ts` 负责解析 AI 存储根目录（`.cwtools-ai/`）、topic 目录和 scratch 目录，支持多 workspace folder 场景。
- `workspaceSandbox.ts` 负责路径输入清洗、作用域分类（`project`/`ai`/`workspace`/`outside`）和信任判定。
- `runnerPolicy.ts` 集中管理模式级工具过滤、每种模式的迭代次数上限、slim sub-agent 输出预算。
- `projectProfile.ts` 处理 `/init` 命令的项目扫描：目录检测、本地化语言/编码检测、命名空间/标识符采样、游戏检测、prompt card 生成和 `queryProjectProfile` 工具处理器。
- `gameKnowledge.ts` 按 languageId 提供 9 款游戏的 PDXScript 知识块，由 `promptBuilder.ts` 动态选择注入。
- `memoryParser.ts` 管理 topic 级长期记忆 `.cwtools-ai/<topicId>/.cwtools-ai-memory.md`（旧的工作区根目录文件仍作为读取回退）：按优先级自动裁剪，上限 ~4000 字符。
- 多 Agent 协作中，`plannedFiles` 全部为本地化 `.yml` 的子任务会被自动升级为 `loc_writer` 角色，且沙盒会屏蔽通用写工具，只允许 `write_localisation`。
- Custom Provider 通过 `cwtools.ai.customApiFormat` 支持四种线协议（`openai-chat-completions`、`openai-responses`、`anthropic-messages`、`gemini-generate-content`）；endpoint 按 Provider 存储在 `cwtools.ai.providerEndpoints`，旧的全局 `cwtools.ai.endpoint` 由 `migrateLegacyEndpoint()` 自动迁移，不要重新引入。
- `usageTracker.ts` 跨会话持久化累计 token 用量、成本和缓存统计数据。

### 通用 MCP 服务（`packages/`）

`packages/cwtools-shared` 与 `packages/cwtools-mcp` 是随插件分发的**只读** MCP 服务，供 Codex / Claude Code 等外部 Agent 调用。开发约定：

- 工具 schema **不手写**：由 `tools/generate-mcp-schema.cjs` 从上游 `definitions.ts` + `registry.ts` 生成到 `cwtools-shared/src/generated/mcpTools.ts`。首期工具白名单同时存在于 `cwtools-shared/src/tools/names.ts` 与生成脚本，两处必须一致。改动后运行 `npm run generate:mcp-schema`，并用 `npm run test:contracts` 验证无漂移。
- **保持只读**：不要在 MCP 暴露写工具；`cwtools-mcp` 的 `createToolCallHandler` 会对任何非白名单工具返回 `tool_not_available`。文件写入交给宿主 Agent。
- 新语义能力先在 `src/LSP`/`src/Main` 增加 `cwtools.ai.*` 命令（只读命令同时加入 `LanguageServer.fs` 的 `isReadCmd`），再在 `cwtools-shared/src/tools/toolHandlers.ts` 的 dispatcher 接线，不要在 MCP 内重写 CWTools 语义。
- `cwtools-shared` 禁止 import `vscode`/`vscode-languageclient`/webview/extension context；宿主能力经 `HostServices` 注入。
- 受 vanilla / 加载状态影响的工具结果须经 `host/vanillaCache.ts`、`host/readiness.ts` 标注；新增此类工具时把它加入对应依赖集。
- 交付到已装插件需升版本号（VS Code 同版本号重装不替换文件）：同步根 `package.json`、`release/package.json`、`release/CHANGELOG.md`，再 `npm run pack:install -- -Version <x>`。

### F#、Shader 和 Vanilla Compare

- Shader 支持涉及 `src/Main/Program.fs`、`src/Main/GameLoader.fs` 和 `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`。
- 解析嵌套 shader 块时优先使用花括号深度计数，不要用只能匹配单层的 `[^}]+` 正则。
- 高频 shader 语义计算应复用已有 hash 缓存与 lazy built-in 集合，避免把大量顶级定义塞回 `Program.fs`。
- 字符串区间扫描要保留对转义双引号 `\"` 的处理。
- `client/extension/vanillaCompare.ts` 的块级迁移应按起始行从后往前应用 `WorkspaceEdit`，避免替换导致行号偏移。
- **自定义 scripted 类型增量刷新**接入点跨多个层：`src/Main/Program.fs` 的 lint 路径（`isIncrementalScriptedPath` 判定 + 写锁内调 `IGame.RefreshScriptedTypes` / `RemoveScriptedTypes`），上游 `RulesManager.RefreshScriptedTypes`（按 `range.FileName` 滤旧条目、单趟 `getTypesFromDefinitions`、仅对改动 typeKey 增量重建 `tempTypeMap` 而非整表 `typeMapFromTypeDefInfo`）、`ResourceManager.RemoveFile` 与各游戏 `IGame` 实现（仅 Stellaris 真增量，其余返回 `false` 回退全量）。改动横跨 `submodules/cwtools` 这个**独立 git submodule**，须先在 submodule 内提交，再回根仓库提交其指针。该增量路径无上游测试覆盖，修改时务必保证逐键产出与全量一致（可临时对比增量与全量的 `typeDefInfo`）。详见 [CLAUDE.md](./CLAUDE.md) 的「Incremental Scripted-Type Refresh」。

## 测试和验证

根据改动范围选择验证：

| 改动范围 | 建议验证 |
| --- | --- |
| 文档 | 检查链接、路径和命令是否存在 |
| Extension TypeScript | `npm run compile`，必要时 `npm run test:unit` |
| AI 工具 / Prompt / Workflow / Orchestrator | 相关单测，再视范围执行 `npm run test:unit` |
| AI Runner Pipeline (reducers/replay/ledger) | `reducers.test.ts`、`runLedger.test.ts`、`resumeStateV2.test.ts` |
| AI Tool Execution (replacer/arg repair) | `editFileReplacer.test.ts`、`argRepair.test.ts`、`toolInvocation.test.ts` |
| 诊断 i18n / ReadTracker / 命令安全 | `diagnosticI18n.test.ts`、`readTracker.test.ts`、`runCommandReadonly.test.ts`、`commandPreflight.test.ts` |
| Project Profile / `/init` | `projectProfile.test.ts` |
| 通用 MCP 服务 (`packages/`) | `npm run generate:mcp-schema`（如改工具）+ `npm run test:contracts`；真实验证跑 `release/bin/mcp/cwtools-mcp.cjs` |
| IndexService / GameProfile | 相关单测 + `npm run test:unit` |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口 / 发布 | `dotnet build src/Main/`，必要时 `npm run verify` |
| 自定义 scripted 类型增量刷新 | `dotnet build src/Main/`；行为验证需在扩展开发宿主开启 `experimental`，手测脚本定义文件的增/改/删是否即时生效且无重复/丢失 |
| 发布前总检 | `npm run verify` |

常见单测文件（60 个）包括：`agentToolSafety.test.ts`、`agentRunnerState.test.ts`、`agentRunnerFallback.test.ts`、`agentRunnerToolRepair.test.ts`、`agentResumeState.test.ts`、`agentSessionCoordinator.test.ts`、`agentUiBroadcaster.test.ts`、`agentManagerContracts.test.ts`、`agentManagerRunSnapshot.test.ts`、`aiServiceTimeout.test.ts`、`approvalBoundary.test.ts`、`argRepair.test.ts`、`artifactPanelModel.test.ts`、`artifactStore.test.ts`、`chatFormatters.test.ts`、`chatModels.test.ts`、`commandPreflight.test.ts`、`contextBudget.test.ts`、`contextMemory.test.ts`、`diagnosticI18n.test.ts`、`diagnosticMetadata.test.ts`、`diffEngine.test.ts`、`editFileReplacer.test.ts`、`gameKnowledge.test.ts`、`gameProfiles.test.ts`、`graphicsFeatures.test.ts`、`indexService.test.ts`、`jsonRepair.test.ts`、`locatorDuplicate.test.ts`、`mcpPermissions.test.ts`、`memoryParser.test.ts`、`messageRenderer.test.ts`、`orchestrator.test.ts`、`pdxIndentFormatter.test.ts`、`pdxshader-grammar.test.ts`、`permissionPolicy.test.ts`、`planModeGuard.test.ts`、`policyEngine.test.ts`、`pricing.test.ts`、`projectProfile.test.ts`、`promptBuilderContext.test.ts`、`promptBuilderSnapshot.test.ts`、`promptBuilderSprite.test.ts`、`providers.test.ts`、`readTracker.test.ts`、`reducers.test.ts`、`resumeStateV2.test.ts`、`runCommandReadonly.test.ts`、`runLedger.test.ts`、`runnerPolicy.test.ts`、`subAgentSandbox.test.ts`、`toolCallParser.test.ts`、`toolDefinitions.test.ts`、`toolInvocation.test.ts`、`toolScheduler.test.ts`、`webviewSmoke.test.ts`、`workflowRegistry.test.ts`、`workflowViewModel.test.ts`、`workspaceSymbolParser.test.ts`、`worktreeManager.test.ts`。

## Pull Request 清单

提交前请确认：

- [ ] 相关构建或测试已运行，或在 PR 中说明未运行原因。
- [ ] 新增用户可见文本已放入合适的 message / i18n 模块。
- [ ] Webview 变更没有引入 Node.js 或 VS Code API 直接访问。
- [ ] 新 AI 工具同步更新了 schema、类型、registry 和 dispatch。
- [ ] 新 AI 工具设置了正确的 `effect` / `riskLevel` / `concurrencyClass`。
- [ ] 改动 MCP 工具集后运行了 `npm run generate:mcp-schema`，且 `names.ts` 与生成脚本白名单一致、`npm run test:contracts` 通过；MCP 保持只读。
- [ ] 文件写入逻辑没有绕过 `PartitionedWriteQueue`。
- [ ] 本地化写入使用 `write_localisation`。
- [ ] 新的游戏差异优先进入 `gameProfiles.ts`。
- [ ] 新的 localisation / symbol / asset 查询优先复用 `IndexService`。
- [ ] WebGL/Three.js 资源有明确释放路径。
- [ ] 大型缓存、索引、扫描结果有边界或清理策略。
- [ ] 修改 `AgentResumeState` 或事件 schema 时保持兼容并扩充相关测试。
- [ ] 子 Agent 调度走 `subAgentSandbox`，没有绕过 `enforceSubAgentSafety`。
- [ ] 新事件类型同步更新了 `runReducers.ts` 中的对应 reducer。
- [ ] 修改模糊替换策略时同步更新了 `editFileReplacer.test.ts`。
- [ ] 没有无关格式化、生成文件或大范围重排。

## 打包

打包详细流程与说明请参见 [.agents/workflows/package.md](./.agents/workflows/package.md)。当前 release 包从 `release/package.json` 生成。

我们强烈推荐在根目录下运行 `package.ps1` 自动化脚本，或直接通过快捷 npm scripts 进行打包和安装：
```bash
# 一键自动完成三平台服务端编译、前端 Webview 编译、资源复制与插件 VSIX 打包
npm run pack

# 自动打包并在打包成功后，强制安装升级至当前系统的 VSCode
npm run pack:install

# 极速打包（跳过重新编译 F# 服务端，仅快速打包 TypeScript 和 Webview 前端并自动安装，耗时约 30 秒）
npm run pack:quick
```

如果不使用自动化脚本，也可以进入 `release/` 目录中手动执行：
```powershell
npx @vscode/vsce package
```
生成的通用 VSIX 插件文件位于 `release/` 文件夹下，例如 `release/eddy-stellaris-cwt-<version>.vsix`（`<version>` 取自 `release/package.json`）。

