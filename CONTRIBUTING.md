# 贡献指南

感谢你关注 **Eddy's Stellaris CWTools**。这份文档面向贡献者，说明如何准备环境、运行项目、提交改动和选择验证方式。架构背景见 [ARCHITECTURE.md](./ARCHITECTURE.md)，AI Agent 工作速查见 [CLAUDE.md](./CLAUDE.md)。

## 环境要求

| 工具 | 推荐版本 | 用途 |
| --- | --- | --- |
| Node.js | 20.x 或更高 | TypeScript 编译、Rollup Webview 打包 |
| npm | 10.x 或更高 | 依赖安装和脚本运行 |
| .NET SDK | 9.0.x | F# 语言服务器和 `CWTools Server` 构建 |
| VS Code | 1.90 或更高 | 扩展开发宿主和测试 |
| Git | 最新稳定版 | 源码和子模块管理 |

仓库的 `global.json` 当前指定 .NET SDK `9.0.300`，并允许 `latestMinor` roll-forward。

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
| `dotnet build src/LSP/` | 构建 LSP 协议/解析层 |
| `dotnet build src/Main/` | 构建 `CWTools Server` |

`npm run compile` 会执行：

1. `tsc -p ./tsconfig.extension.json`
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
```

根目录也提供便捷构建脚本：

```bash
# Windows
.\build.cmd

# Linux / macOS
./build.sh

# Nushell
nu build.nu
```

这些脚本会恢复 dotnet tools、初始化子模块，并调用 `dotnet run --project build -- -t ...`。

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
                              fuzzy replacer suite, schema flattening
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
      memoryParser.ts         .cwtools-ai-memory.md long-term memory
      workspacePaths.ts       AI storage root, topic/scratch dirs
      workspaceSandbox.ts     Path sanitization and scope classification
      runnerPolicy.ts         Mode-based tool filtering and iteration limits
      usageTracker.ts         Cumulative token usage and cost tracking
      diffEngine.ts           Structural diff engine
      fileCache.ts            Bounded file content cache
      errorReporter.ts        Structured error reporting
      toolCallParser.ts       Non-standard tool call parsing
      jsonRepair.ts           Incomplete JSON repair
      mcpClient.ts            MCP stdio/SSE client
      types.ts                All AI type definitions
      workflowRegistry.ts     Workflow metadata and tool policies
      workflowI18n.ts         Workflow localization
    indexing/                 Shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           Multi-game profile registry
    extension.ts              Activation and command registration
    vanillaCompare.ts         Vanilla file diff and block migration
  webview/                    Browser-sandboxed Webview scripts
    chat/                     Extracted chat and Agent Manager modules (21 files)
    messageRenderer.ts        Message rendering (cache sparkline, annotations)
    svgIcons.ts               High-fidelity SVG icon library
    *Preview.ts               GUI, solar system, event chain, tech tree, entity previews
  test/
    unit/                     ts-mocha unit tests (46 files)
    suite/                    VS Code integration tests

src/
  LSP/                        Reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  Resource strings
  CSharpExtensions/           Helper project

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
- **沙盒与 I/O 隔离边界 (ReadTracker)**：严禁在 Webview 端直接操作文件或通过任何越权手段绕过 IPC 抓取文件树与文件元数据。所有的 I/O 跟踪逻辑（如 `ReadTracker`）已全部收敛在 Extension Host 扩展宿主进程中，前端仅处理数据展现并遵循纯粹的数据驱动模型，防止浏览器沙盒漏洞越权。
- **前缀缓存审计卡片与度量显示 (Prompt Cache)**：当大模型支持缓存并成功命中或新建前缀缓存（如 DeepSeek, Claude），会由后端发射 `cache_stats` 事件。前端渲染器 `messageRenderer.ts` 会将该事件编译拦截，并渲染为高颜值的"绿色 (命中) / 蓝色 (新建) / 橙黄色 (穿透) 三柱微图卡片 (Cache Sparkline)"。任何针对缓存费率打折因子（例如 DeepSeek/Claude 的 0.1× 优惠）或持久化的修改，应同步查验 `pricing.ts`、`UsageTracker` 与前端 `agentManager.ts` / `chatPanel.ts` 的自适应渲染区块。
- **UI 图标高保真原则**：在任何 Token 使用看板或 UI 文字标注区域中，严禁混用裸 Emojis 符号（如 ⚡），必须物理升级为带内联样式修饰的高保真 SVG 矢量图标（支持 `stroke="currentColor"` 主题色自适应与垂直对齐），保持编辑器的现代精致质感。

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
- 新增用户可见运行步骤时，通过 `runner/runLedger.ts` 写事件；新增事件类型时同步 `runTimeline.ts`、`runInspector.ts` 和 `runReducers.ts`。
- 文件编辑的模糊匹配策略集中在 `tools/replacerSuite.ts`，包含 10 种递进式匹配算法（直接匹配、Unicode 归一化、行级 trim、块锚定、空白归一化、缩进弹性、转义归一化、边界 trim、上下文感知、Jaccard 相似度）。修改替换策略时请同步更新 `editFileReplacer.test.ts`。
- 面向弱工具调用能力的 Provider，`tools/schemaFlatten.ts` 可自动将深层嵌套 schema 展平；执行工具前由 `nestArguments()` 反向还原。
- `runner/readTracker.ts` 在 Extension Host 中跟踪文件的读取状态（mtime + SHA-256 hash），防止 Agent 未读即写或写入已被外部修改的文件。
- `runner/runReducers.ts` 提供纯函数式的事件投影 reducer，用于从 JSONL 事件流重建 run 状态、工具时间线、Agent 拓扑图和缓存统计快照。新增事件类型时必须更新对应 reducer。
- `runner/runReplay.ts` 提供运行回放功能：模式 A (recorded-tool) 使用原始 ledger 的工具结果回答工具调用，模式 B (full-replay) 暂缓。`ReplaySession` 按规范化参数索引工具结果。
- `workspacePaths.ts` 负责解析 AI 存储根目录（`.cwtools-ai/`）、topic 目录和 scratch 目录，支持多 workspace folder 场景。
- `workspaceSandbox.ts` 负责路径输入清洗、作用域分类（`project`/`ai`/`workspace`/`outside`）和信任判定。
- `runnerPolicy.ts` 集中管理模式级工具过滤、每种模式的迭代次数上限、slim sub-agent 输出预算。
- `projectProfile.ts` 处理 `/init` 命令的项目扫描：目录检测、本地化语言/编码检测、命名空间/标识符采样、游戏检测、prompt card 生成和 `queryProjectProfile` 工具处理器。
- `gameKnowledge.ts` 按 languageId 提供 9 款游戏的 PDXScript 知识块，由 `promptBuilder.ts` 动态选择注入。
- `memoryParser.ts` 管理 `.cwtools-ai-memory.md` 长期工作区记忆：按优先级自动裁剪，上限 ~4000 字符。
- `usageTracker.ts` 跨会话持久化累计 token 用量、成本和缓存统计数据。

### F#、Shader 和 Vanilla Compare

- Shader 支持涉及 `src/Main/Program.fs`、`src/Main/GameLoader.fs` 和 `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`。
- 解析嵌套 shader 块时优先使用花括号深度计数，不要用只能匹配单层的 `[^}]+` 正则。
- 高频 shader 语义计算应复用已有 hash 缓存与 lazy built-in 集合，避免把大量顶级定义塞回 `Program.fs`。
- 字符串区间扫描要保留对转义双引号 `\"` 的处理。
- `client/extension/vanillaCompare.ts` 的块级迁移应按起始行从后往前应用 `WorkspaceEdit`，避免替换导致行号偏移。

## 测试和验证

根据改动范围选择验证：

| 改动范围 | 建议验证 |
| --- | --- |
| 文档 | 检查链接、路径和命令是否存在 |
| Extension TypeScript | `npm run compile`，必要时 `npm run test:unit` |
| AI 工具 / Prompt / Workflow / Orchestrator | 相关单测，再视范围执行 `npm run test:unit` |
| AI Runner Pipeline (reducers/replay/ledger) | `reducers.test.ts`、`runLedger.test.ts`、`resumeStateV2.test.ts` |
| AI Tool Execution (replacer/arg repair) | `editFileReplacer.test.ts`、`argRepair.test.ts`、`toolInvocation.test.ts` |
| Project Profile / `/init` | `projectProfile.test.ts` |
| IndexService / GameProfile | 相关单测 + `npm run test:unit` |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口 / 发布 | `dotnet build src/Main/`，必要时 `npm run verify` |
| 发布前总检 | `npm run verify` |

常见单测文件（46 个）包括：`agentToolSafety.test.ts`、`agentRunnerState.test.ts`、`agentRunnerFallback.test.ts`、`agentRunnerToolRepair.test.ts`、`agentResumeState.test.ts`、`agentSessionCoordinator.test.ts`、`agentUiBroadcaster.test.ts`、`agentManagerContracts.test.ts`、`agentManagerRunSnapshot.test.ts`、`aiServiceTimeout.test.ts`、`argRepair.test.ts`、`artifactPanelModel.test.ts`、`artifactStore.test.ts`、`chatFormatters.test.ts`、`chatModels.test.ts`、`commandPreflight.test.ts`、`contextBudget.test.ts`、`contextMemory.test.ts`、`diffEngine.test.ts`、`editFileReplacer.test.ts`、`gameProfiles.test.ts`、`graphicsFeatures.test.ts`、`indexService.test.ts`、`jsonRepair.test.ts`、`messageRenderer.test.ts`、`orchestrator.test.ts`、`pdxshader-grammar.test.ts`、`permissionPolicy.test.ts`、`pricing.test.ts`、`projectProfile.test.ts`、`promptBuilderContext.test.ts`、`promptBuilderSnapshot.test.ts`、`promptBuilderSprite.test.ts`、`providers.test.ts`、`reducers.test.ts`、`resumeStateV2.test.ts`、`runLedger.test.ts`、`runnerPolicy.test.ts`、`subAgentSandbox.test.ts`、`toolCallParser.test.ts`、`toolInvocation.test.ts`、`toolScheduler.test.ts`、`webviewSmoke.test.ts`、`workflowRegistry.test.ts`、`workflowViewModel.test.ts`、`workspaceSymbolParser.test.ts`。

## Pull Request 清单

提交前请确认：

- [ ] 相关构建或测试已运行，或在 PR 中说明未运行原因。
- [ ] 新增用户可见文本已放入合适的 message / i18n 模块。
- [ ] Webview 变更没有引入 Node.js 或 VS Code API 直接访问。
- [ ] 新 AI 工具同步更新了 schema、类型、registry 和 dispatch。
- [ ] 新 AI 工具设置了正确的 `effect` / `riskLevel` / `concurrencyClass`。
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

打包详细流程与说明请参见 [.agents/workflows/package.md](file:///c:/Users/A/Documents/cwtools-vscode/.agents/workflows/package.md)。当前 release 包从 `release/package.json` 生成。

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
生成的通用 VSIX 插件文件位于 `release/` 文件夹下，例如 `release/eddy-stellaris-cwt-2.2.2.vsix`。

