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
    ai/                       AI assistant, providers, tools, workflows, orchestrator
    indexing/                 shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           multi-game profile registry
    extension.ts              activation and command registration
  webview/                    browser-sandboxed Webview scripts
    chat/                     extracted chat and Agent Manager modules
    *Preview.ts               GUI, solar system, event chain, tech tree, entity previews
  test/
    unit/                     ts-mocha unit tests
    suite/                    VS Code integration tests

src/
  LSP/                        reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  resource strings
  CSharpExtensions/           helper project

submodules/
  cwtools/                    upstream CWTools F# library
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
- **前缀缓存审计卡片与度量显示 (Prompt Cache)**：当大模型支持缓存并成功命中或新建前缀缓存（如 DeepSeek, Claude），会由后端发射 `cache_stats` 事件。前端渲染器 `messageRenderer.ts` 会将该事件编译拦截，并渲染为高颜值的“绿色 (命中) / 蓝色 (新建) / 橙黄色 (穿透) 三柱微图卡片 (Cache Sparkline)”。任何针对缓存费率打折因子（例如 DeepSeek/Claude 的 0.1× 优惠）或持久化的修改，应同步查验 `pricing.ts`、`UsageTracker` 与前端 `agentManager.ts` / `chatPanel.ts` 的自适应渲染区块。
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
- 新增用户可见运行步骤时，通过 `runner/runLedger.ts` 写事件；新增事件类型时同步 `runTimeline.ts` 和 `runInspector.ts`。

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
| IndexService / GameProfile | 相关单测 + `npm run test:unit` |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口 / 发布 | `dotnet build src/Main/`，必要时 `npm run verify` |
| 发布前总检 | `npm run verify` |

常见单测文件包括 `agentToolSafety.test.ts`、`agentRunnerState.test.ts`、`argRepair.test.ts`、`commandPreflight.test.ts`、`contextMemory.test.ts`、`permissionPolicy.test.ts`、`resumeStateV2.test.ts`、`runLedger.test.ts`、`subAgentSandbox.test.ts`、`toolInvocation.test.ts`、`toolScheduler.test.ts`、`gameProfiles.test.ts`、`indexService.test.ts`、`workspaceSymbolParser.test.ts`、`workflowRegistry.test.ts`、`workflowViewModel.test.ts`、`webviewSmoke.test.ts`、`providers.test.ts` 和 `toolCallParser.test.ts`。

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
- [ ] 没有无关格式化、生成文件或大范围重排。

## 打包

打包流程见 `.agents/workflows/package.md`。当前 release 包从 `release/package.json` 生成，准备好 TypeScript/Webview 输出和三平台服务端后，在 `release/` 目录执行：

```powershell
npx @vscode/vsce package
```

生成的 VSIX 位于 `release/`，文件名类似：

```text
eddy-stellaris-cwt-<version>.vsix
```

注意：仓库根目录当前没有 `package.ps1`，不要把它写进新的流程说明。
