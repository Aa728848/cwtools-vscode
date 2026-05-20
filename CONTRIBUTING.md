# 贡献指南

感谢你关注 **Eddy's Stellaris CWTools**。本文档说明如何搭建环境、运行项目、提交改动和验证质量。

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

## 常用构建命令

```bash
npm run compile
npm run lint
npm run test:unit
npm run test
npm run check:release
npm run verify
dotnet build src/LSP/
dotnet build src/Main/
```

`npm run compile` 会执行两步：

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

`npm run verify` 是当前最完整的项目验证入口，会串联 lint、compile、unit test 和 release gate。

与 Stellaris 规则同步相关的脚本：

```bash
npm run rules:stellaris
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
```

也可以使用根目录脚本：

```bash
# Windows
.\build.cmd

# Linux / macOS
./build.sh

# Nushell
nu build.nu
```

这些脚本会恢复 dotnet tools、初始化子模块，并调用 `dotnet run --project build -- -t ...`。

## 运行和调试扩展

1. 用 VS Code 打开仓库根目录。
2. 按 `F5` 或执行 “Run and Debug: Start Debugging”。
3. VS Code 会启动新的 Extension Development Host 窗口。
4. 修改代码后，重新运行调试会话或重载开发宿主。

Webview 调试：

1. 在 Extension Development Host 中打开相关面板。
2. 运行命令 `Developer: Open Webview Developer Tools`。
3. 在 DevTools 中查看 DOM、控制台、网络和断点。

## 项目结构速览

```text
client/
  extension/                  VS Code Extension Host
    ai/                       AI assistant, providers, tools, workflows, orchestrator
      runner/                 compaction, checkpoint, write coordinator, fallback, cancel, emitter, scheduler, doomLoop, toolInvocation, commandPreflight, permissionPolicy, runLedger, contextMemory
      chat/                   extracted webview message bridge (bridge.ts)
      prompt/                 extracted base/mode prompt sections
      providers/              model defaults, capabilities, pricing helpers
      tools/                  schema, registry, dedicated handlers (file, LSP, memory, external, replacer)
      agentSessionCoordinator.ts
      agentUiBroadcaster.ts
      artifactStore.ts
      agentManagerHtml.ts
    indexing/                 shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           multi-game profile registry
    extension.ts              activation and command registration
    guiPanel.ts               GUI preview host
    solarSystemPanel.ts       solar system preview host
    eventChainPanel.ts        event chain visualizer host
    techTreePanel.ts          tech tree visualizer host
    entityPanel.ts            3D entity preview host
    codeActions.ts            AI quick fixes
  webview/                    browser-sandboxed Webview scripts
    chat/                     extracted chat modules
    agentManager.ts           detached Agent Manager surface
    agentManager.css
    chatPanel.ts
    messageRenderer.ts
    guiPreview.ts
    solarSystemPreview.ts
    eventChainPreview.ts
    techTreePreview.ts
    entityPreview.ts
  test/
    unit/                     ts-mocha unit tests
    suite/                    VS Code integration tests

src/
  LSP/                        reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  resource strings
  CSharpExtensions/           helper project

submodules/cwtools/           upstream CWTools F# library
```

更多细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 本地 CWTools 开发

默认构建使用 `submodules/cwtools`。如果需要指向本地 CWTools 仓库，在
`src/Main/cwtools.local.props` 创建类似配置：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

把 `CwtoolsPath` 改成你本机的实际路径。

## TypeScript 规范

- 使用现有模块风格和本地 helper，不为小改动引入新抽象。
- 生产代码避免无理由的 `any`，未知数据优先用 `unknown` 和类型守卫。
- 关注 ESLint 9 的异步安全规则：
  - `@typescript-eslint/no-floating-promises`
  - `@typescript-eslint/no-misused-promises`
  - `prefer-promise-reject-errors`
- Extension/AI 错误报告优先使用 `ErrorReporter`，不要裸用 `console.error`。
- 用户可见中文文本尽量放入现有 i18n / message 模块：
  - `client/extension/ai/messages.ts`
  - `client/extension/ai/workflowI18n.ts`
  - `client/webview/chat/i18n.ts`
- 修改大文件时优先做局部、可验证的变更。

## Webview 规范

Webview 代码运行在浏览器沙盒中：

- 不要导入 `vscode`、`fs`、`path` 或任何 Node.js-only API。
- 不要使用 `require()`。
- 与扩展宿主通信必须通过 `postMessage`。
- CSS 使用 VS Code 主题变量，例如 `var(--vscode-editor-background)`。
- 动画应支持 `prefers-reduced-motion`。
- Three.js/WebGL 面板必须在销毁时释放 renderer、geometry、material、texture、worker、事件监听器和动画循环。
- 新增 chat UI 逻辑时，优先沿用 `client/webview/chat/` 里的拆分模式，而不是继续膨胀 `chatPanel.ts`。
- Chat 面板和 Agent Manager 面板共享 host-side state；涉及跨 surface 同步时检查 `AgentUiBroadcaster`、`AgentSessionCoordinator`、`ArtifactStore` 和 `ai/chat/bridge.ts`。

## 平台与索引层规范

- 新的游戏差异优先落在 `client/extension/gameProfiles.ts`，不要在消费者里继续散落硬编码。
- 新的 localisation、symbol、asset 查询优先复用 `IndexService`；只有共享索引无法回答时才新增额外扫描逻辑。
- `IndexService` 的纯逻辑部分应尽量留在 `locParser.ts` / `workspaceSymbolParser.ts` 里，便于单元测试。
- 如果新增查询维度，请同步考虑：
  - workspace 与 vanilla 来源
  - freshness / fileVersion 元数据
  - limit 与缓存边界

## AI Agent 修改规范

新增或修改 AI 工具时，请同步维护：

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts`（如果访问策略变化）
5. `client/extension/ai/agentTools.ts`

工具设计注意点：

- `tools/registry.ts` 是模式门控、读写分类和子 Agent 可用性的事实来源；同时也是 `effect`、`riskLevel`、`concurrencyClass` 的派生源，不要绕开。
- `tools/permissions.ts` 统一读取 registry 元数据做访问校验。
- `tools/argRepair.ts` 负责常见工具参数名/类型修复；新增 schema 字段时留意是否需要 alias。
- 结构化读取优先级高于原始命令读取：先考虑 `query_workspace_index`、`document_symbols`、`get_pdx_block`、`get_file_context`，再考虑全文读取或 shell。
- `run_command` 必须经过 `runner/commandPreflight.ts` 风险分级；高危/升级类命令禁止经预批准规则自动放行。
- `runner/permissionPolicy.ts` 仅放行低风险预批准命令；新增豁免类型时必须保留 `path.relative` 形式的 `cwdScope` 校验，禁止退回 `startsWith`。
- 新增并发敏感工具时，给注册条目正确分类 `concurrencyClass`，避免 LSP / 网络 / 全局排他类工具被错误地并行调度。

并发写入规则：

- 写文件工具由 `PartitionedWriteQueue` 按文件路径串行化。
- 多文件写入按路径字典序获取锁，避免死锁。
- `todo_write` 是计划/UI 状态工具，必须继续排除在文件写锁之外。
- `.yml` 本地化文件必须用 `write_localisation`，不要用 `write_file`、`apply_patch` 或通用替换工具直接写。

Workflow 与多 Agent 协作：

- 当前 workflow 注册表在 `client/extension/ai/workflowRegistry.ts`。
- 当前协作模式使用 `dispatch_agents`、`query_blackboard`、`merge_results`。
- 角色注册在 `client/extension/ai/orchestrator/agentRegistry.ts`。
- 子 Agent 分派必须经 `orchestrator/subAgentSandbox.ts` 构造的沙盒；新增高危工具时同步检查其默认黑名单与只读角色禁写名单。
- 大上下文应通过 `contextFiles` 或 Blackboard key 传递，不要塞进子 Agent prompt。
- 如果 workflow 会新增 UI 元数据，请同步检查 `workflowI18n.ts`、`workflowViewModel.ts` 和 webview workflow 模块。

运行账本与恢复：

- 任何会产生用户可见步骤的新流程都应通过 `runner/runLedger.ts` 写事件，让 Agent Manager 时间轴与 Inspector 可见。
- 新增 `AgentRunEventType` 时同步更新 `runInspector.ts` 的 `formatEventPayload` 与 `runTimeline.ts` 的分组逻辑，避免事件落到 `other`。
- 修改 `AgentResumeState` 结构必须保持 V2 向下兼容，并扩充 `resumeStateV2.test.ts`；恢复时务必让 `prepareMessagesForResume` 处理新增的 tool_call 形态，避免 OpenAI 风格 API 拒绝。
- 触发 `runner/contextMemory.ts` 压缩的新策略需确保 `CompactedSummary` 的 11 个维度仍然可解析，并跑 `contextMemory.test.ts`。

## 测试

### 单元测试

单元测试位于 `client/test/unit/`，由 `ts-mocha` 自动发现：

```bash
npm run test:unit
```

当前较有代表性的测试包括：

- `agentToolSafety.test.ts`
- `agentRunnerState.test.ts` (状态机、Token 估算与 API 回退测试)
- `agentRunnerToolRepair.test.ts`
- `agentSessionCoordinator.test.ts`
- `agentUiBroadcaster.test.ts`
- `agentManagerContracts.test.ts`
- `agentManagerRunSnapshot.test.ts`
- `artifactStore.test.ts`
- `argRepair.test.ts`
- `commandPreflight.test.ts`
- `contextMemory.test.ts`
- `permissionPolicy.test.ts`
- `promptBuilderSnapshot.test.ts` (系统提示词防漂移快照测试)
- `resumeStateV2.test.ts`
- `runLedger.test.ts`
- `runnerPolicy.test.ts`
- `subAgentSandbox.test.ts`
- `toolInvocation.test.ts`
- `toolScheduler.test.ts`
- `contextBudget.test.ts`
- `gameProfiles.test.ts`
- `indexService.test.ts`
- `workspaceSymbolParser.test.ts`
- `workflowRegistry.test.ts`
- `workflowViewModel.test.ts`
- `chatFormatters.test.ts`
- `chatModels.test.ts`
- `webviewSmoke.test.ts`
- `orchestrator.test.ts`
- `providers.test.ts`
- `toolCallParser.test.ts`

### 集成测试

集成测试位于 `client/test/suite/`，需要 VS Code 测试运行时：

```bash
npm run test
```

## 验证建议

根据改动范围选择验证：

| 改动范围 | 建议验证 |
| --- | --- |
| 文档 | 检查链接、路径和命令是否存在 |
| Extension TypeScript | `npm run compile`，必要时 `npm run test:unit` |
| AI 工具 / Prompt / Workflow / Orchestrator | 先跑相关单测，再视范围执行 `npm run test:unit` |
| IndexService / GameProfile | 相关单测 + `npm run test:unit` |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口 / 发布 | `dotnet build src/Main/`，必要时 `npm run verify` |
| 发布前总检 | `npm run verify` |

## Pull Request 清单

提交前请确认：

- [ ] 相关构建或测试已运行，或在 PR 中说明未运行原因。
- [ ] 新增用户可见文本已放入合适的 message / i18n 模块。
- [ ] Webview 变更没有引入 Node.js 或 VS Code API 直接访问。
- [ ] 新 AI 工具同步更新了 schema、类型、registry 和 dispatch；并在 registry 上设置了正确的 `effect` / `riskLevel` / `concurrencyClass`。
- [ ] 文件写入逻辑不会绕过 `PartitionedWriteQueue`。
- [ ] 本地化写入使用 `write_localisation`。
- [ ] 新的游戏差异优先进入 `gameProfiles.ts`。
- [ ] 新的 localisation / symbol / asset 查询优先复用 `IndexService`。
- [ ] WebGL/Three.js 资源有明确释放路径。
- [ ] 大型缓存、索引、扫描结果有边界或清理策略。
- [ ] 新 `run_command` 用法已经过 `commandPreflight` 风险分级；高风险命令不会进入 `permissionPolicy` 自动豁免。
- [ ] 修改 `AgentResumeState` 或事件 schema 时保持兼容并扩充 `resumeStateV2.test.ts` / `runLedger.test.ts`。
- [ ] 子 Agent 调度走 `subAgentSandbox`，没有引入绕过 `enforceSubAgentSafety` 的直连执行路径。
- [ ] 没有无关格式化、生成文件或大范围重排。

## 打包

打包流程见 `.agents/workflows/package.md`。当前 release 包从 `release/package.json`
生成，准备好编译输出和三平台服务端后，在 `release/` 目录执行：

```powershell
npx @vscode/vsce package
```

生成的 VSIX 位于 `release/`，文件名类似：

```text
eddy-stellaris-cwt-<version>.vsix
```

注意：仓库根目录当前没有 `package.ps1`，不要把它写进新的流程说明。

## 获取帮助

- 架构概览：[ARCHITECTURE.md](./ARCHITECTURE.md)
- AI 助手工作指南：[CLAUDE.md](./CLAUDE.md)
- 打包流程：`.agents/workflows/package.md`
