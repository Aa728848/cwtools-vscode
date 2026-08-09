# Contributing / 贡献指南

[English](#english) | [中文](#zh-cn) | [Project overview / 项目介绍](README.md) | [Architecture / 架构](ARCHITECTURE.md) | [CWT rules / CWT 规则](docs/cwt-rule-config.md) | [Diagnostic codes / 诊断码](docs/diagnostic-codes.md) | [AI instructions](AGENTS.md)

<a id="english"></a>

## English

This guide covers local setup, repository boundaries, verification, and packaging. For data flow and component ownership, read [ARCHITECTURE.md](ARCHITECTURE.md).

### Before you start

Install the following tools:

| Tool | Requirement |
| --- | --- |
| Node.js / npm | Node.js 20+ and npm 10+ |
| .NET SDK | .NET 10; `global.json` selects the expected SDK and roll-forward policy |
| VS Code | 1.90+ |
| Git | A current version with submodule support |
| PowerShell | Windows PowerShell 5.1+ for the root packaging scripts |

Clone the repository with its submodules, then install the npm workspaces:

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

If you cloned without submodules, repair the checkout before building:

```bash
git submodule update --init --recursive
```

Missing `submodules/cwtools` breaks the F# build. Missing `submodules/cwtools-stellaris-config/config` breaks packaging.

To use a separate local CWTools checkout, create `src/Main/cwtools.local.props`:

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

Adjust `CwtoolsPath` for your machine and do not commit the file.

### Run the extension

1. Open the repository root in VS Code.
2. Press `F5`, or run `Run and Debug: Start Debugging`.
3. Use the new Extension Development Host window to open a test workspace.
4. Restart the debug session or reload that window after code changes.

For a Webview, open the panel in the Extension Development Host and run `Developer: Open Webview Developer Tools`.

### Choose the right verification

Run the smallest check that covers your change, then broaden when the change crosses a boundary.

| Change | Minimum useful check |
| --- | --- |
| Extension Host or Webview TypeScript | `npm run compile`, `npm run typecheck:test` (strict over the whole `client/` tree including tests), then targeted unit tests |
| AI runner or tools | Targeted tests, then `npm run test:unit` |
| Documentation | `npm run build:docs` and `npm run check:release -- --skip-compile --skip-test` |
| F# LSP layer | `dotnet build src/LSP/` |
| F# server or CWTools integration | `dotnet build src/Main/` |
| F# regression scripts | `dotnet fsi` each `src/**/*.Tests.fsx` from its directory |
| CWT rules sync | `npm run test:rules-sync` plus the relevant scan/check/report command |
| MCP contracts | Generate the schema, then build and test inside `submodules/cwtools-mcp` |
| Broad release-sensitive change | `npm run verify` |

Common commands:

```bash
npm run lint
npm run compile
npm run typecheck:test
npm run test:unit
npm run test
npm run verify
dotnet build src/LSP/
dotnet build src/Main/
```

For MCP schema changes:

```bash
npm run generate:mcp-schema
cd submodules/cwtools-mcp
npm run build
npm run test:contracts
```

The schema command writes into the MCP submodule. Review and commit that repository separately before updating the root submodule pointer.

### Repository boundaries

| Path | Ownership |
| --- | --- |
| `client/extension/` | VS Code Extension Host, filesystem access, commands, LSP client, AI host |
| `client/extension/ai/` | AI providers, runner, tools, permissions, workflows, memory, and orchestration |
| `client/webview/` | Browser-sandboxed panels and visual editors |
| `src/LSP/`, `src/Main/` | F#/.NET protocol layer and language-server executable |
| `submodules/cwtools/` | Upstream CWTools parser, validation, game model, and Shader semantics |
| `submodules/cwtools-stellaris-config/` | Stellaris CWT rule data |
| `submodules/cwtools-mcp/` | Separately released read-only MCP server |

The three submodules have separate histories and release concerns. Commit a change inside the relevant submodule first, then update its pointer in the root repository. Do not combine CWTools library work, rules-data work, and MCP release work into one unexplained change.

### Coding expectations

- Keep the patch focused and preserve unrelated working-tree changes.
- Follow nearby patterns and reuse shared helpers before adding a new abstraction.
- Treat file contents, JSON, Webview messages, tool arguments, LSP/MCP payloads, and process output as untrusted input. Narrow them at the boundary.
- Prefer `unknown`, type guards, and discriminated unions over new `any`, unchecked assertions, or non-null assertions for external data.
- Preserve cancellation, timeouts, and disposal in asynchronous code. Report failures with enough operation and target context to diagnose them.
- Keep filesystem-derived output deterministic and bound caches and concurrency.
- Add or update a regression test when observable behavior changes.
- Use `ErrorReporter` instead of bare `console.error` in Extension Host and AI code.

#### Webviews

Code under `client/webview/` runs in a browser sandbox:

- Do not import `vscode`, `fs`, `path`, use `require()`, or call other Node-only APIs.
- Communicate with the Extension Host through `postMessage`.
- Use VS Code theme variables and support `prefers-reduced-motion`.
- Dispose renderers, GPU resources, workers, listeners, and animation loops.
- Keep file access and read tracking in the Extension Host.

#### AI tools and runner

When a model-visible tool changes, update its definition, shared types, registry metadata, permission handling when applicable, and dispatch. The registry is the source of truth for gating, effects, risk, and concurrency.

Every tool call must pass through the policy engine. Preserve path containment checks, sorted multi-file locking, per-file write exclusion, command preflight, and plan-mode write gates. The active multi-agent tools are `dispatch_agents`, `query_blackboard`, and `merge_results`.

New run events must be handled by reducers and Webview renderers. Resume-format changes must remain compatible with V2 data. Read the AI sections of [ARCHITECTURE.md](ARCHITECTURE.md) before a broad runner change.

#### F# and Shader code

Reuse `PdxShaderFeatures` and existing parsing helpers. Preserve nested-block depth handling, escaped quotes, supported caches, and Windows-only case-insensitive path comparison.

Incremental scripted-type refresh spans the server and the CWTools submodule. Compare incremental output with a full refresh, and keep the submodule commit separate from the root pointer update.

#### Localisation and documentation

Update English and Chinese together for user-visible commands, settings, diagnostics, chat/workflow UI, Webviews, and release-facing docs. Existing catalogs include:

- `client/extension/ai/messages.ts`
- `client/extension/ai/workflowI18n.ts`
- `client/webview/chat/i18n.ts`

`README.md`, this guide, `ARCHITECTURE.md`, and `docs/cwt-rule-config.md` are bilingual single-source documents. Do not create separate `_EN` or `_ZH` copies. `npm run build:docs` validates them and generates `release/README.md` from `docs/marketplace-readme.md`.

Localisation `.yml` files may require a BOM or game-specific encoding. Do not rewrite them with a generic text writer; use the project's `write_localisation` path.

### CWT rule work

Read [docs/cwt-rule-config.md](docs/cwt-rule-config.md) before editing rules. The main commands are:

```bash
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
```

`report` compares current game documentation and vanilla content with the CWT baseline. With a Stellaris install available, it also refreshes the Shader ABI inventory unless `--no-shader-abi` is supplied. See [tools/rules-sync/README.md](tools/rules-sync/README.md) for inputs, outputs, and write behavior.

### Package a VSIX

The packaging scripts run from Windows PowerShell at the repository root:

```bash
npm run pack
npm run pack:install
npm run pack:quick
```

- `pack` builds the three self-contained language servers and creates the VSIX.
- `pack:install` also installs the result through the VS Code `code` command.
- `pack:quick` reuses existing server binaries, so it is not suitable for a fresh checkout.

The package is written to `release/eddy-stellaris-cwt-<version>.vsix`. Do not duplicate the current version in documentation; root `package.json` and `release/package.json` are authoritative.

### Pull request checklist

- The change is scoped and unrelated work is untouched.
- User-visible English and Chinese text are both updated.
- Behavior changes have a focused regression test.
- Relevant compile, test, and documentation checks pass.
- New input and message boundaries validate untrusted data.
- Async work still cancels, times out, and disposes correctly.
- Submodule commits and root pointer changes are separated and explained.
- The PR description states what changed, why, and which checks ran.

---

<a id="zh-cn"></a>

## 中文

本文说明本地环境、仓库边界、验证方式和打包流程。需要了解数据流和模块职责时，请阅读 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 开始之前

请先安装：

| 工具 | 要求 |
| --- | --- |
| Node.js / npm | Node.js 20+、npm 10+ |
| .NET SDK | .NET 10；具体 SDK 与滚动策略以 `global.json` 为准 |
| VS Code | 1.90+ |
| Git | 支持 submodule 的当前版本 |
| PowerShell | 根目录打包脚本需要 Windows PowerShell 5.1+ |

连同子模块一起克隆仓库，再安装 npm workspace 依赖：

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

如果克隆时没有拉取子模块，请先补全：

```bash
git submodule update --init --recursive
```

缺少 `submodules/cwtools` 会导致 F# 构建失败；缺少 `submodules/cwtools-stellaris-config/config` 会导致打包失败。

如需使用另一份本地 CWTools 检出，请创建 `src/Main/cwtools.local.props`：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

按本机路径修改 `CwtoolsPath`，不要提交这个文件。

### 运行扩展

1. 在 VS Code 中打开仓库根目录。
2. 按 `F5`，或运行 `Run and Debug: Start Debugging`。
3. 在新打开的 Extension Development Host 窗口中载入测试工作区。
4. 修改代码后，重新启动调试或重载该窗口。

调试 Webview 时，先在 Extension Development Host 中打开对应面板，再运行 `Developer: Open Webview Developer Tools`。

### 选择合适的验证

先运行能覆盖本次修改的最小检查；跨越模块边界时，再扩大验证范围。

| 修改范围 | 最小有效检查 |
| --- | --- |
| Extension Host 或 Webview TypeScript | `npm run compile`、`npm run typecheck:test`（对包含测试的整个 `client/` 严格检查），再运行相关单元测试 |
| AI runner 或工具 | 相关测试，然后 `npm run test:unit` |
| 文档 | `npm run build:docs` 和 `npm run check:release -- --skip-compile --skip-test` |
| F# LSP 层 | `dotnet build src/LSP/` |
| F# 服务端或 CWTools 集成 | `dotnet build src/Main/` |
| F# 回归脚本 | 在各自目录用 `dotnet fsi` 运行每个 `src/**/*.Tests.fsx` |
| CWT 规则同步 | `npm run test:rules-sync`，再运行相关 scan/check/report 命令 |
| MCP 契约 | 生成 schema，再进入 `submodules/cwtools-mcp` 构建和测试 |
| 影响发布的较大修改 | `npm run verify` |

常用命令：

```bash
npm run lint
npm run compile
npm run typecheck:test
npm run test:unit
npm run test
npm run verify
dotnet build src/LSP/
dotnet build src/Main/
```

修改 MCP schema 时：

```bash
npm run generate:mcp-schema
cd submodules/cwtools-mcp
npm run build
npm run test:contracts
```

schema 命令会写入 MCP 子模块。请先在该仓库中审阅并提交，再更新根仓库的 submodule 指针。

### 仓库边界

| 路径 | 职责 |
| --- | --- |
| `client/extension/` | VS Code Extension Host、文件访问、命令、LSP 客户端和 AI 宿主 |
| `client/extension/ai/` | AI Provider、runner、工具、权限、工作流、记忆和编排 |
| `client/webview/` | 运行在浏览器沙盒中的面板和可视化编辑器 |
| `src/LSP/`、`src/Main/` | F#/.NET 协议层和语言服务端程序 |
| `submodules/cwtools/` | 上游 CWTools 解析、校验、游戏模型和 Shader 语义 |
| `submodules/cwtools-stellaris-config/` | Stellaris CWT 规则数据 |
| `submodules/cwtools-mcp/` | 独立发布的只读 MCP 服务 |

三个子模块各有独立历史和发布边界。先在对应子模块内提交，再更新根仓库指针。CWTools 库、规则数据和 MCP 发布不应混成一项没有说明的改动。

### 编码要求

- 保持改动聚焦，不要覆盖工作区中的无关修改。
- 优先沿用附近实现和共享 helper，不为小改动增加新抽象。
- 把文件内容、JSON、Webview 消息、工具参数、LSP/MCP payload 和进程输出视为不可信输入，在边界处校验并收窄类型。
- 外部数据优先使用 `unknown`、类型守卫和可辨识联合，避免新增 `any`、未经检查的断言和非空断言。
- 异步代码要保留取消、超时和释放行为；错误信息应包含可定位问题的操作与目标上下文。
- 文件系统派生结果应保持确定顺序，并限制缓存和并发规模。
- 可观察行为变化需要补充或更新回归测试。
- Extension Host 和 AI 代码使用 `ErrorReporter`，不要直接写裸 `console.error`。

#### Webview

`client/webview/` 运行在浏览器沙盒中：

- 不要导入 `vscode`、`fs`、`path`，不要使用 `require()` 或其他 Node 专用 API。
- 通过 `postMessage` 与 Extension Host 通信。
- 使用 VS Code 主题变量，并支持 `prefers-reduced-motion`。
- 正确释放渲染器、GPU 资源、worker、监听器和动画循环。
- 文件访问和读取追踪留在 Extension Host。

#### AI 工具与 runner

修改模型可见工具时，要同步更新定义、共享类型、registry 元数据、适用的权限处理和 dispatch。工具 gating、副作用、风险和并发策略以 registry 为准。

所有工具调用都必须经过策略引擎。保留路径包含检查、排序后的多文件锁、单文件写排他、命令预检和 Plan 模式写入门。当前多 Agent 工具为 `dispatch_agents`、`query_blackboard` 和 `merge_results`。

新增 run event 时要同步 reducer 和 Webview renderer。恢复格式必须继续兼容 V2。大范围修改 runner 前，请先阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 的 AI 部分。

#### F# 与 Shader

复用 `PdxShaderFeatures` 和现有解析 helper。保留嵌套块深度、转义引号、已有缓存，以及仅在 Windows 使用不区分大小写路径比较的行为。

scripted type 增量刷新横跨服务端和 CWTools 子模块。请把增量结果与全量刷新对比，并把子模块提交与根指针更新分开。

#### 本地化与文档

用户可见的命令、设置、诊断、聊天/工作流 UI、Webview 和发布文档需要同时更新英文和中文。常用文案目录包括：

- `client/extension/ai/messages.ts`
- `client/extension/ai/workflowI18n.ts`
- `client/webview/chat/i18n.ts`

`README.md`、本文、`ARCHITECTURE.md` 和 `docs/cwt-rule-config.md` 都是双语单一来源，不要新增 `_EN` 或 `_ZH` 副本。`npm run build:docs` 会校验这些文件，并从 `docs/marketplace-readme.md` 生成 `release/README.md`。

本地化 `.yml` 可能要求 BOM 或游戏特定编码。不要用通用文本写入方式重写它们，应使用项目的 `write_localisation` 路径。

### CWT 规则

修改规则前请阅读 [docs/cwt-rule-config.md](docs/cwt-rule-config.md)。主要命令：

```bash
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
```

`report` 会把当前游戏文档和原版内容与 CWT 基线对比。如果能找到 Stellaris 安装，还会刷新 Shader ABI 清单；传入 `--no-shader-abi` 可跳过。输入、输出和写入行为见 [tools/rules-sync/README.md](tools/rules-sync/README.md)。

### 打包 VSIX

在仓库根目录使用 Windows PowerShell 运行：

```bash
npm run pack
npm run pack:install
npm run pack:quick
```

- `pack` 构建三个自包含语言服务端并生成 VSIX。
- `pack:install` 还会通过 VS Code 的 `code` 命令安装产物。
- `pack:quick` 复用已有服务端二进制，不适合全新检出。

产物位于 `release/eddy-stellaris-cwt-<version>.vsix`。不要在文档中重复维护当前版本；根 `package.json` 和 `release/package.json` 才是来源。

### Pull request 检查清单

- 改动范围明确，没有覆盖无关工作。
- 用户可见英文和中文均已更新。
- 行为变化有针对性的回归测试。
- 相关编译、测试和文档检查通过。
- 新增输入和消息边界会校验不可信数据。
- 异步任务仍能正确取消、超时和释放。
- 子模块提交与根指针更新分开，并在 PR 中说明。
- PR 描述写明改了什么、为什么改，以及运行过哪些检查。
