# Contributing / 贡献指南

[English](#english) | [中文](#zh-cn) | [Project overview / 项目介绍](README.md) | [Architecture / 架构](ARCHITECTURE.md) | [CWT rules / CWT 规则](docs/cwt-rule-config.md) | [Diagnostic codes / 诊断码](docs/diagnostic-codes.md) | [AI instructions](AGENTS.md)

<a id="english"></a>

## English

This guide covers local setup, verification, coding expectations, CWT rules tooling, and VSIX packaging/release. For module ownership and data flows, see [ARCHITECTURE.md](ARCHITECTURE.md).

### Setup

Install the prerequisites:

| Tool | Requirement |
| --- | --- |
| Node.js / npm | Node.js 20+ and npm 10+ |
| .NET SDK | .NET 10 (`global.json` pins SDK and roll-forward policy) |
| VS Code | 1.90+ |
| Git | Current version with submodule support |
| PowerShell | Windows PowerShell 5.1+ (for `package.ps1`) |

Clone with submodules, install dependencies, and build `cwtools-node` (which also builds `cwtools-shared`) before compiling on a fresh checkout:

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
(cd submodules/cwtools-mcp && npm ci && npm run build -w cwtools-node)
```

If cloned without submodules, run `git submodule update --init --recursive`. Missing `submodules/cwtools` breaks the F# build; missing `submodules/cwtools-stellaris-config/config` breaks packaging; missing `submodules/cwtools-mcp/packages/cwtools-node/dist` or `submodules/cwtools-mcp/packages/cwtools-shared/dist` breaks TypeScript compilation.

To build against an external local CWTools checkout, create an untracked `src/Main/cwtools.local.props`:

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

### Run and debug

1. Open the repository root in VS Code and press `F5` (`Run and Debug: Start Debugging`).
2. Open a test mod workspace in the Extension Development Host window.
3. For Webview debugging, open the panel and run `Developer: Open Webview Developer Tools`.

### Verification matrix

Run the narrowest useful check first, then broaden when crossing subsystem boundaries:

| Scope | Minimum check |
| --- | --- |
| Extension Host or Webview TS | `npm run compile`, `npm run typecheck:test`, targeted unit tests |
| MCP, DSH, or host tools | Shared/Node/MCP contract tests, DSH Host/Client tests, then `npm run test:unit` |
| Docs | `npm run build:docs` and `npm run check:release -- --skip-compile --skip-test` |
| F# LSP / server | `dotnet build src/LSP/` and/or `dotnet build src/Main/`, plus `npm run test:fsx` |
| Integration / Shader / CWT LSP | `npm test`, `npm run test:shader-lsp`, `npm run test:cwt-lsp`, `npm run test:cwt-game-lsp` |
| CWT rules sync | `npm run test:rules-sync` plus the relevant `rules:stellaris:*` command |
| Domain tools / workspace detection | Update `cwtools-shared/src/tools/catalog.ts` with dispatch, run `npm run generate:mcp-detection` when detection changes, then `npm run build && npm run test:contracts` inside `submodules/cwtools-mcp` |
| Broad pre-release gate | `npm run verify` |

Use `npm run check:mcp-detection` for a read-only workspace-detection drift check. Tool catalog consistency is covered by shared contract tests.

### Repository boundaries and submodules

| Path | Ownership |
| --- | --- |
| `client/extension/` | Extension Host, filesystem I/O, commands, LSP client, MCP/IDE host services (`client/extension/mcp/`) |
| `client/webview/` | Browser-sandboxed panels and visual editors |
| `src/LSP/`, `src/Main/` | F#/.NET LSP layer and server executable |
| `submodules/cwtools/` | Upstream CWTools parser, validation, game model, and Shader semantics |
| `submodules/cwtools-stellaris-config/` | Stellaris CWT rule data |
| `submodules/cwtools-mcp/` | Separately released MCP server packages (`cwtools-shared`, `cwtools-node`, `cwtools-mcp`) |

Each submodule has independent history and release cadence: commit and test inside the submodule first, then update the root pointer. Keep library code, rules data, and MCP releases in separate commits.

### Coding expectations

- Keep patches scoped and preserve unrelated working-tree changes.
- Reuse shared helpers (`gameProfiles.ts`, `indexing/`, `pathScope.ts`, `fileExtensions.ts`) before introducing new abstractions.
- Treat file contents, JSON, Webview messages, tool arguments, LSP/MCP payloads, and process output as untrusted input; validate and narrow at the boundary using `unknown`, type guards, and discriminated unions rather than new `any` or unchecked assertions.
- Preserve cancellation, timeouts, and disposal in async code; report errors with actionable context via `ErrorReporter` (not bare `console.error`) in Extension Host and AI code.
- Keep filesystem-derived outputs deterministic, bound caches and concurrency, and add focused regression tests for observable behavior changes.

Domain constraints:
- **Webviews (`client/webview/`)**: no `vscode`/`fs`/`path`/`require()`, communicate only via `postMessage`, use VS Code theme variables, support `prefers-reduced-motion`, dispose renderers/GPU/listeners/loops, and keep file I/O and `ReadTracker` in the Host.
- **MCP and host tools**: keep `cwtools-shared/src/tools/catalog.ts`, host capability filtering, and shared dispatch synchronized. Preserve path containment, sorted locking, per-file exclusion, cancellation, and evidence prechecks. External Agents own planning, shell, memory, and general editing.
- **F# & Shader (`src/`, `submodules/cwtools/`)**: reuse `PdxShaderFeatures`, handle nested block depth and escaped quotes, use case-insensitive path comparison only on Windows, and compare Stellaris incremental refresh results against full refreshes.
- **Localisation & docs**: update English and Chinese together (`client/extension/messages.ts`, `release/package.nls*.json`, and single-source bilingual docs). Never rewrite `.yml` localisation files with a generic text writer—use `write_localisation` to preserve encoding/BOM. Never duplicate version numbers outside root `package.json` and `release/package.json`.
- **Agent Notes**: record or update a Simplified Chinese decision note in `.agents/notes/` for every non-trivial change (see [.agents/notes/README.md](.agents/notes/README.md)).

### CWT rule work

Read [docs/cwt-rule-config.md](docs/cwt-rule-config.md) and [tools/rules-sync/README.md](tools/rules-sync/README.md) before modifying Stellaris rules. Main commands:

```bash
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
npm run rules:stellaris:optional-fields
```

Pass `--no-shader-abi` to `report` when you need a read-only report that leaves `config/shader/` untouched.

### Package a VSIX

From the repository root in Windows PowerShell (on a fresh checkout, run `npm ci` inside `release/` first so `vsce` finds the runtime dependency closure):

```bash
npm run pack          # Build all 3 self-contained servers and create the universal VSIX
npm run pack:install  # Package and install into local VS Code
npm run pack:quick    # Reuse existing server binaries and reinstall (not for fresh checkouts)
```

Output: `release/foreverskywalker-stellaris-cwtools-<version>.vsix`. See [.agents/workflows/package.md](.agents/workflows/package.md) for manual step-by-step commands.

### Publish a release

Pushing a `v<version>` tag triggers `.github/workflows/release.yml`, which builds the universal VSIX on Windows via `package.ps1`, runs `npm run check:release`, publishes to the VS Code Marketplace, uploads the VSIX artifact, and creates/updates the GitHub Release from `release/CHANGELOG.md`. Tag and both `package.json` versions must match.

Marketplace publishing uses [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing) over GitHub OIDC (no PAT stored in this repository). One-time publisher policy: in [Visual Studio Marketplace Management](https://marketplace.visualstudio.com/manage) → publisher `ForeverSkywalker` → **Trusted Publishing**, add owner `Aa728848`, repository `cwtools-vscode`, workflow `release.yml`, and empty environment.

To re-run without moving a tag, dispatch the workflow manually from GitHub Actions with the existing tag; uncheck **Publish to the VS Code Marketplace** to refresh only the VSIX and GitHub Release.

### Pull request checklist

- Scoped change; unrelated work preserved.
- User-visible English and Chinese text updated together.
- Focused regression tests added/updated; relevant verification checks pass.
- Untrusted inputs validated; async cancellation/timeout/disposal preserved.
- Submodule commits separated from root pointer updates; Agent Note added or updated.
- PR description states what changed, why, and which checks ran.

---

<a id="zh-cn"></a>

## 中文

本文说明本地环境搭建、验证方式、编码规范、CWT 规则工具及 VSIX 打包发布流程。模块职责与数据流详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 环境准备

| 工具 | 要求 |
| --- | --- |
| Node.js / npm | Node.js 20+、npm 10+ |
| .NET SDK | .NET 10（`global.json` 指定具体版本与滚动策略） |
| VS Code | 1.90+ |
| Git | 支持 submodule 的当前版本 |
| PowerShell | Windows PowerShell 5.1+（用于 `package.ps1`） |

连同子模块一起克隆，并在全新检出首次编译前构建 `cwtools-node`（其预构建步骤会同时构建 `cwtools-shared`）：

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
(cd submodules/cwtools-mcp && npm ci && npm run build -w cwtools-node)
```

若克隆时未拉取子模块，运行 `git submodule update --init --recursive`。缺少 `submodules/cwtools` 会导致 F# 构建失败；缺少 `submodules/cwtools-stellaris-config/config` 会导致打包失败；缺少 `submodules/cwtools-mcp/packages/cwtools-node/dist` 或 `submodules/cwtools-mcp/packages/cwtools-shared/dist` 会导致 TypeScript 编译失败。

如需链接另一份本地 CWTools 源码，创建不提交的 `src/Main/cwtools.local.props`：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

### 运行与调试

1. 在 VS Code 中打开仓库根目录，按 `F5`（`Run and Debug: Start Debugging`）。
2. 在弹出的 Extension Development Host 窗口中打开测试 Mod 工作区。
3. 调试 Webview 时，先打开对应面板，再运行 `Developer: Open Webview Developer Tools`。

### 验证矩阵

优先运行覆盖本次改动的最小检查，跨边界修改时再扩大验证范围：

| 修改范围 | 最小有效检查 |
| --- | --- |
| Extension Host 或 Webview TS | `npm run compile`、`npm run typecheck:test`、相关单元测试 |
| MCP、DSH 或宿主工具 | 共享/Node/MCP 契约测试、DSH Host/Client 测试，随后 `npm run test:unit` |
| 文档 | `npm run build:docs` 与 `npm run check:release -- --skip-compile --skip-test` |
| F# LSP / 服务端 | `dotnet build src/LSP/` 与/或 `dotnet build src/Main/`，以及 `npm run test:fsx` |
| 集成 / Shader / CWT LSP | `npm test`、`npm run test:shader-lsp`、`npm run test:cwt-lsp`、`npm run test:cwt-game-lsp` |
| CWT 规则同步 | `npm run test:rules-sync` 及对应的 `rules:stellaris:*` 命令 |
| 领域工具 / 工作区探测 | 同步修改 `cwtools-shared/src/tools/catalog.ts` 与 dispatcher；探测变化时运行 `npm run generate:mcp-detection`，随后在 `submodules/cwtools-mcp` 内执行 `npm run build && npm run test:contracts` |
| 发布前全量门禁 | `npm run verify` |

工作区探测的只读漂移检查可使用 `npm run check:mcp-detection`；工具目录一致性由共享契约测试覆盖。

### 仓库边界与子模块

| 路径 | 职责 |
| --- | --- |
| `client/extension/` | Extension Host、文件 I/O、命令、LSP 客户端、MCP/IDE 宿主服务（`client/extension/mcp/`） |
| `client/webview/` | 浏览器沙盒面板与可视化编辑器 |
| `src/LSP/`、`src/Main/` | F#/.NET 协议层与语言服务端程序 |
| `submodules/cwtools/` | 上游 CWTools 解析、校验、游戏模型与 Shader 语义 |
| `submodules/cwtools-stellaris-config/` | Stellaris CWT 规则数据 |
| `submodules/cwtools-mcp/` | 独立发布的 MCP 服务包（`cwtools-shared`、`cwtools-node`、`cwtools-mcp`） |

三个子模块拥有独立历史与发布周期：先在子模块内测试并提交，再更新根仓库指针；库代码、规则数据与 MCP 发布不要混在同一个提交中。

### 编码要求

- 保持改动聚焦，不覆盖无关工作区更改。
- 优先复用共享 helper（`gameProfiles.ts`、`indexing/`、`pathScope.ts`、`fileExtensions.ts`），避免重复造轮子。
- 将文件内容、JSON、Webview 消息、工具参数、LSP/MCP payload 与进程输出视为不可信输入；在边界用 `unknown`、类型守卫和可辨识联合收窄，避免新增 `any` 或无校验断言。
- 保留异步代码的取消、超时与释放逻辑；Extension Host 与 MCP 宿主代码通过 `ErrorReporter` 上报带上下文的错误，不使用裸 `console.error`。
- 文件系统派生输出保持确定排序，缓存与并发保持有界，可观察行为变更补充针对性回归测试。

领域约束：
- **Webview（`client/webview/`）**：禁止 `vscode`/`fs`/`path`/`require()`，仅通过 `postMessage` 通信；使用 VS Code 主题变量并支持 `prefers-reduced-motion`；关闭时释放渲染器/GPU/监听器/动画循环；文件访问与 `ReadTracker` 留在宿主。
- **MCP 与宿主工具**：同步维护 `cwtools-shared/src/tools/catalog.ts`、宿主能力过滤和共享 dispatcher；保留路径包含、排序锁、单文件排他、取消与证据预检。计划、Shell、记忆和通用编辑由外部 Agent 负责。
- **F# 与 Shader（`src/`、`submodules/cwtools/`）**：复用 `PdxShaderFeatures`，保留嵌套块深度与转义引号处理、仅 Windows 不区分大小写路径比较，以及 Stellaris 增量刷新与全量刷新的对比验证。
- **本地化与文档**：用户可见英文与中文同步更新（`client/extension/messages`、`release/package.nls*.json` 及单源双语文档）。本地化 `.yml` 必须通过 `write_localisation` 写入以保留编码/BOM。不要在根 `package.json` 与 `release/package.json` 之外重复写版本号。
- **Agent Notes**：每次非平凡变更均需在 `.agents/notes/` 中记录或原地更新简体中文决策笔记（见 [.agents/notes/README.md](.agents/notes/README.md)）。

### CWT 规则维护

修改规则前请阅读 [docs/cwt-rule-config.md](docs/cwt-rule-config.md) 与 [tools/rules-sync/README.md](tools/rules-sync/README.md)。常用命令：

```bash
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
npm run rules:stellaris:contracts
npm run rules:stellaris:optional-fields
```

需要完全只读的报告（不修改 `config/shader/`）时，给 `report` 传入 `--no-shader-abi`。

### 打包 VSIX

在仓库根目录通过 Windows PowerShell 运行（全新检出请先在 `release/` 执行 `npm ci`，以满足 `vsce` 的运行时依赖闭包校验）：

```bash
npm run pack          # 构建三平台自包含服务端并打包通用 VSIX
npm run pack:install  # 打包并安装到本地 VS Code
npm run pack:quick    # 复用已有服务端二进制快速重装（不适用于全新检出）
```

产物路径：`release/foreverskywalker-stellaris-cwtools-<version>.vsix`。手动分步命令见 [.agents/workflows/package.md](.agents/workflows/package.md)。

### 发布版本

推送 `v<version>` 标签会触发 `.github/workflows/release.yml`：在 Windows 上通过 `package.ps1` 构建通用 VSIX、执行 `npm run check:release`、发布到 VS Code 市场、上传 VSIX 产物，并以 `release/CHANGELOG.md` 对应章节创建或更新 GitHub Release。标签必须与两份 `package.json` 中的版本一致。

市场发布采用基于 GitHub OIDC 的 [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)（不在仓库保存 PAT）。发布者属主一次性配置：在 [发布者管理页面](https://marketplace.visualstudio.com/manage) → `ForeverSkywalker` → **Trusted Publishing**，添加仓库属主 `Aa728848`、仓库 `cwtools-vscode`、workflow `release.yml`、environment 留空。

如需在不移动标签的情况下重试，在 GitHub Actions 页面手动触发该工作流并填写已有标签；取消勾选 **Publish to the VS Code Marketplace** 可仅重建 VSIX 并刷新 GitHub Release。

### Pull request 检查清单

- 改动范围明确，无关工作未受影响。
- 用户可见英文与中文同步更新。
- 已补充/更新回归测试并通过相关验证。
- 边界输入已校验，异步取消/超时/释放行为完整。
- 子模块提交与根指针更新分开，已记录或更新 Agent Note。
- PR 描述写明改了什么、为什么改，以及运行过哪些检查。
