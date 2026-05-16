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
dotnet build src/LSP/
dotnet build src/Main/
```

`npm run compile` 会执行两步：

1. `tsc -p ./tsconfig.extension.json`
2. `rollup -c`

Rollup 当前打包 6 个 Webview 入口：

- `client/webview/chatPanel.ts`
- `client/webview/guiPreview.ts`
- `client/webview/solarSystemPreview.ts`
- `client/webview/eventChainPreview.ts`
- `client/webview/techTreePreview.ts`
- `client/webview/entityPreview.ts`

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
    ai/                       AI assistant, providers, tools, orchestrator
    extension.ts              activation and command registration
    guiPanel.ts               GUI preview host
    solarSystemPanel.ts       solar system preview host
    eventChainPanel.ts        event chain visualizer host
    techTreePanel.ts          tech tree visualizer host
    entityPanel.ts            3D entity preview host
    codeActions.ts            AI quick fixes
  webview/                    browser-sandboxed Webview scripts
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
- 用户可见中文文本尽量集中到 `client/extension/ai/messages.ts`。
- 修改大文件时优先做局部、可验证的变更。

## Webview 规范

Webview 代码运行在浏览器沙盒中：

- 不要导入 `vscode`、`fs`、`path` 或任何 Node.js-only API。
- 不要使用 `require()`。
- 与扩展宿主通信必须通过 `postMessage`。
- CSS 使用 VS Code 主题变量，例如 `var(--vscode-editor-background)`。
- 动画应支持 `prefers-reduced-motion`。
- Three.js/WebGL 面板必须在销毁时释放 renderer、geometry、material、texture、worker、事件监听器和动画循环。

## AI Agent 修改规范

新增或修改 AI 工具时，请同步维护：

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/agentTools.ts`
3. `client/extension/ai/types.ts`
4. `client/extension/ai/agentRunner.ts` 的 `WRITE_TOOLS`，如果该工具会写文件

并发写入规则：

- 写文件工具由 `PartitionedWriteQueue` 按文件路径串行化。
- 多文件写入按路径字典序获取锁，避免死锁。
- `todo_write` 是计划/UI 状态工具，必须继续排除在文件写锁之外。
- `.yml` 本地化文件必须用 `write_localisation`，不要用 `write_file`、`apply_patch` 或通用替换工具直接写。

多 Agent 协作：

- 当前协作模式使用 `dispatch_agents`、`query_blackboard`、`merge_results`。
- 角色注册在 `client/extension/ai/orchestrator/agentRegistry.ts`。
- 大上下文应通过 `contextFiles` 或 Blackboard key 传递，不要塞进子 Agent prompt。

## 测试

### 单元测试

单元测试位于 `client/test/unit/`，由 `ts-mocha` 自动发现：

```bash
npm run test:unit
```

当前包含的重点测试包括：

- `agentToolSafety.test.ts`
- `contextBudget.test.ts`
- `diffEngine.test.ts`
- `editFileReplacer.test.ts`
- `jsonRepair.test.ts`
- `messageRenderer.test.ts`
- `orchestrator.test.ts`
- `pricing.test.ts`
- `promptBuilderSprite.test.ts`
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
| AI 工具/Prompt/Orchestrator | `npm run test:unit`，重点看工具安全和 orchestrator 测试 |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口/发布 | `dotnet build src/Main/`，按打包流程验证 |

## Pull Request 清单

提交前请确认：

- [ ] 相关构建或测试已运行，或在 PR 中说明未运行原因。
- [ ] 新增用户可见文本已考虑中英双语或放入合适的消息文件。
- [ ] Webview 变更没有引入 Node.js 或 VS Code API 直接访问。
- [ ] 新 AI 工具同步更新了 schema、类型、路由和写锁配置。
- [ ] 文件写入逻辑不会绕过 `PartitionedWriteQueue`。
- [ ] 本地化写入使用 `write_localisation`。
- [ ] WebGL/Three.js 资源有明确释放路径。
- [ ] 大型缓存、索引、扫描结果有边界或清理策略。
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
- AI 助手工作指南：[AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md)
- 打包流程：`.agents/workflows/package.md`
