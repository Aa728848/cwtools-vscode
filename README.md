# Stellaris Language Serves

[English](#english) | [中文](#zh-cn) | [Contributing / 贡献指南](CONTRIBUTING.md) | [Architecture / 架构](ARCHITECTURE.md) | [CWT rules / CWT 规则](docs/cwt-rule-config.md) | [Diagnostic codes / 诊断码](docs/diagnostic-codes.md) | [AI instructions](AGENTS.md)

<a id="english"></a>

## English

Stellaris Language Serves is a VS Code extension for Paradox modding. It combines the CWTools language server with visual editors, vanilla comparison, Shader support, and an optional AI workspace.

[![Built with F#](https://img.shields.io/badge/backend-F%23%20%2F%20.NET%2010-blue.svg?style=flat-square)](https://dotnet.microsoft.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square)]()

Most language features work across supported Paradox game profiles. The visual tools and bundled rules are developed primarily for Stellaris.

### What it includes

| Area | What you can do |
| --- | --- |
| Script editing | Get diagnostics, completion, hover information, navigation, references, symbols, CodeLens, and inlay hints for Paradox script and localisation. |
| Visual tools | Preview and edit Stellaris GUI files, solar systems, static galaxies, particles, entities, technology trees, and event chains. |
| Shader editing | Work with `.shader` and `.fxh` files using compile-unit-aware diagnostics, navigation, completion, formatting, rename, and semantic highlighting. |
| CWT rule editing | Edit `.cwt` rule files with their own language id: parser/structure diagnostics (CWT0xx), directive and field-expression validation (CWT1xx/CWT2xx), project-wide undefined-reference and duplicate-type checks (CWT3xx), context completion for root blocks/directives/field expressions/symbols, cross-file navigation, and safe hot-swap of validated edits from the configured manual rules folder into the game model (CWT9xx). A rules-only repository starts the server in CWT-only mode without a game install and never activates a game model; a game workspace keeps full mode. |
| Vanilla comparison | Compare a mod file with its vanilla counterpart and migrate the block under the cursor. |
| AI workspace | Use a general coding agent or a Paradox/CWTools-aware agent with explicit permissions, project indexing, workflows, and optional MCP servers. |
| External MCP | Connect Codex, Claude Code, or another MCP client to the separate read-only `cwtools-mcp` package. |

The extension also supports Hearts of Iron IV, Europa Universalis IV and V, Crusader Kings II and III, Imperator: Rome, Victoria II and 3, and custom CWT projects. Game-specific coverage depends on the active profile and available rules.

### Install

1. Download the latest `.vsix` from [Releases](https://github.com/Aa728848/cwtools-vscode/releases).
2. In VS Code, run `Extensions: Install from VSIX...` and select the file.
3. When prompted, choose the vanilla game folder. CWTools uses it to build its initial cache.

The packaged extension includes its language-server binaries. The .NET SDK is only needed when building the project locally.

### Common workflows

#### Edit Paradox script

Open a supported mod workspace as a folder. Diagnostics and navigation become available after the language server has loaded the project and vanilla data.

#### Open a visual editor

Use the editor-title action or the file context menu:

- `.gui`: GUI canvas and property editor
- `solar_system_initializers/*.txt`: 3D solar-system preview
- `map/setup_scenarios/*.txt`: static-galaxy preview and position editor
- `.asset` and `.gfx`: entity, animation, and particle previews
- technology and event files: dependency graphs

Edits made by a visual editor use VS Code workspace edits, so they participate in normal undo and redo. Some previews are intentionally approximate; for example, runtime-generated hyperlanes are never presented as exact source data.

#### Compare with vanilla

Use the `Compare with Vanilla` CodeLens on a matching mod file. `Migrate Block from Vanilla` replaces the current block while preserving the coordinates of other pending edits.

#### Use the AI panel

Open `AI: Open Chat Panel` from the Command Palette. The composer lets you keep routing automatic or restrict a turn to the Paradox/CWTools or general-coding domain. Provider credentials are stored through VS Code SecretStorage; tool access still follows the selected sandbox and approval policy.

Eligible Build and Utility stages can use programmable `run_code`: a stage-specific typed SDK lets the model branch on Paradox/CWTools or general-tool results, filter intermediate evidence, and run bounded independent reads concurrently. Programs execute in a QuickJS/WASM guest without Node or VS Code authority. Every nested tool call still passes the normal mode/domain/stage, permission, policy, scheduler, and write-queue gates; only explicit logs and the final return value enter model context.

The ChatGPT-subscription-compatible Codex provider uses a browser sign-in flow and the extension's own agent runtime. It is an integration with an upstream compatibility endpoint, not a public stable API, so upstream changes can require extension updates.

Antigravity is also available in AI Settings. Select **Antigravity (Google OAuth)**, sign in with Google, then refresh the account to load its models and quota. The extension stores OAuth tokens in VS Code SecretStorage and supports streaming text, image input, and tool calls through Antigravity's Gemini transport. Complete account setup in Antigravity first. This provider uses fixed upstream compatibility endpoints; API keys, custom endpoints, FIM, and utility calls are unavailable.

Codex subscription and Antigravity (Gemini OAuth) share **AI Settings → Subscription channel proxy**. Choose **Auto detect**, **Custom proxy**, or **Direct connection**, then click **Save proxy** before signing in or testing. Custom mode accepts HTTP, HTTPS, and SOCKS5 addresses (for example `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`), with optional `username:password@` authentication stored in VS Code SecretStorage. Leave the address empty to keep the saved proxy. Auto mode checks VS Code `http.proxy`, `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (including lowercase variants), then Windows/macOS manual system proxy settings; PAC is not evaluated. Without a detected proxy it connects directly. A configured proxy failure is reported without a direct fallback. Changes apply to subsequent token, account, quota and chat requests; active streams continue with their existing connection. Browser sign-in uses the browser's own proxy settings.

#### Connect an external MCP client

`cwtools-mcp` is maintained and released separately. It exposes read-only semantic queries and normally reuses the language server already running in VS Code.

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
```

```sh
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

See the [cwtools-mcp repository](https://github.com/Aa728848/cwtools-mcp) for standalone mode and manual configuration.

### Architecture

![System architecture overview](docs/system-architecture.png)

The main runtime boundaries are:

- `client/extension/`: VS Code Extension Host code and filesystem access
- `client/webview/`: browser-sandboxed panels and visual editors
- `src/LSP/` and `src/Main/`: the F#/.NET language server
- `submodules/cwtools/`: the upstream CWTools library
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rules
- `submodules/cwtools-mcp/`: the separately released read-only MCP server

Webviews communicate with the Extension Host through messages and do not access Node.js or the filesystem directly. The [architecture guide](ARCHITECTURE.md) covers the data flows and maintenance boundaries in detail.

### Develop

You need Node.js 20+, npm 10+, the .NET 10 SDK, Git with submodule support, and VS Code 1.90+.

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
npm run compile
npm run test:unit
```

Useful checks:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Lint Extension Host and Webview code. |
| `npm run compile` | Compile TypeScript and bundle Webviews. |
| `npm run test:unit` | Run unit tests. |
| `dotnet build src/LSP/` | Build the reusable LSP layer. |
| `dotnet build src/Main/` | Build the server executable. |
| `npm run verify` | Run the broad local quality gate. |
| `npm run build:docs` | Validate bilingual docs and generate the Marketplace README. |

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code, packaging the extension, or editing a submodule. CWT rule authors should start with the [rule configuration guide](docs/cwt-rule-config.md).

### License

Released under the [MIT License](LICENSE.md). This project builds on [CWTools](https://github.com/cwtools) and the work of the Paradox modding community.

---

<a id="zh-cn"></a>

## 中文

Stellaris Language Serves 是一款面向 Paradox Mod 开发的 VS Code 扩展。它把 CWTools 语言服务、可视化编辑器、原版对比、Shader 支持和可选的 AI 工作区放在同一个插件中。

[![Built with F#](https://img.shields.io/badge/backend-F%23%20%2F%20.NET%2010-blue.svg?style=flat-square)](https://dotnet.microsoft.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square)]()

语言服务覆盖多个受支持的 Paradox 游戏 Profile；可视化工具和随插件提供的规则主要围绕 Stellaris 开发。

### 主要功能

| 范围 | 可以做什么 |
| --- | --- |
| 脚本编辑 | 为 Paradox 脚本和本地化提供诊断、补全、悬停信息、跳转、引用、符号、CodeLens 和嵌入提示。 |
| 可视化工具 | 预览或编辑 Stellaris GUI、恒星系、静态银河、粒子、实体、科技树和事件链。 |
| Shader 编辑 | 按真实编译单元处理 `.shader` 和 `.fxh`，提供诊断、跳转、补全、格式化、重命名和语义高亮。 |
| CWT 规则编辑 | 用独立的 `cwt` 语言编辑 `.cwt` 规则文件:解析/结构诊断(CWT0xx)、指令与字段表达式校验(CWT1xx/CWT2xx)、项目级未定义引用与重复类型检查(CWT3xx)、根块/指令/字段表达式/符号的上下文补全、跨文件跳转,以及把当前配置的手动规则目录中验证通过的编辑安全热替换进游戏模型(CWT9xx)。纯规则仓库以 CWT-only 模式启动服务,无需游戏安装且不会激活游戏模型;游戏工作区保持 full mode。 |
| 原版对比 | 将 Mod 文件与原版对应文件对比，并迁移光标所在的代码块。 |
| AI 工作区 | 使用通用编码 Agent 或了解 Paradox/CWTools 的 Agent，并通过权限、项目索引、工作流和可选 MCP 服务控制执行范围。 |
| 外部 MCP | 通过独立发布的只读 `cwtools-mcp`，让 Codex、Claude Code 等客户端查询 CWTools 语义信息。 |

语言服务还支持 Hearts of Iron IV、Europa Universalis IV 和 V、Crusader Kings II 和 III、Imperator: Rome、Victoria II 和 3，以及自定义 CWT 项目。具体能力取决于当前 Profile 和可用规则。

### 安装

1. 从 [Releases](https://github.com/Aa728848/cwtools-vscode/releases) 下载最新 `.vsix`。
2. 在 VS Code 中运行 `Extensions: Install from VSIX...`，选择下载的文件。
3. 首次提示时选择原版游戏目录，CWTools 会据此建立缓存。

发布的扩展已经包含语言服务端；只有本地构建项目时才需要 .NET SDK。

### 常用方式

#### 编辑 Paradox 脚本

把受支持的 Mod 目录作为工作区打开。语言服务完成项目和原版数据加载后，诊断、补全和跳转等功能会自动启用。

#### 打开可视化编辑器

使用编辑器标题栏按钮或文件右键菜单：

- `.gui`：GUI 画布和属性编辑
- `solar_system_initializers/*.txt`：3D 恒星系预览
- `map/setup_scenarios/*.txt`：静态银河预览和位置编辑
- `.asset`、`.gfx`：实体、动画和粒子预览
- 科技与事件文件：依赖关系图

可视化编辑器通过 VS Code 工作区编辑写回文件，因此可以正常撤销和重做。部分预览只能近似表达游戏运行时结果；例如，运行时随机生成的超空间航道不会被当成精确数据展示。

#### 与原版对比

在有原版对应文件的 Mod 文件中使用 `Compare with Vanilla` CodeLens。`Migrate Block from Vanilla` 会替换当前代码块，并避免其他待处理修改的行号失效。

#### 使用 AI 面板

从命令面板运行 `AI: Open Chat Panel`。输入区可以保持自动路由，也可以把当前请求限制在 Paradox/CWTools 或通用编码领域。Provider 凭据通过 VS Code SecretStorage 保存；工具调用仍受当前沙盒和审批策略约束。

符合条件的 Build 与 Utility 阶段可以使用可编程 `run_code`：模型通过当前阶段的类型化 SDK，按 Paradox/CWTools 或通用工具结果分支、筛选中间证据，并对有界的独立读取并发执行。程序运行在不具备 Node 或 VS Code 权限的 QuickJS/WASM guest 中；每个内部工具调用仍经过 mode/domain/stage、权限、策略、调度和写队列检查，只有显式日志与最终返回值进入模型上下文。

兼容 ChatGPT 订阅的 Codex Provider 通过浏览器登录，并使用插件自己的 Agent 运行时。它依赖上游兼容端点，不属于公开稳定 API；如果上游流程变化，插件可能需要同步更新。

AI 设置也支持 Antigravity。选择 **Antigravity (Google OAuth)**，使用 Google 登录后刷新账户，即可加载模型和额度。扩展将 OAuth Token 存入 VS Code SecretStorage，通过 Antigravity 的 Gemini 协议支持流式文本、图片输入和工具调用。请先在 Antigravity 中完成账户设置。该供应商使用固定的上游兼容端点，不提供 API Key、自定义端点、FIM 或辅助调用。

Codex 订阅与 Antigravity（Gemini OAuth）共用 **AI 设置 → 订阅渠道代理**。选择 **自动检测**、**自定义代理** 或 **直连**，登录或测试前点击 **保存代理**。自定义模式支持 HTTP、HTTPS、SOCKS5 地址（例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`），可用 `用户名:密码@` 提供认证，凭据保存在 VS Code SecretStorage。地址留空会保留已保存的代理。自动模式依次检测 VS Code `http.proxy`、`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写形式）、Windows/macOS 系统手动代理；不解析 PAC。未检测到代理时直连，已配置的代理连接失败时会报错，不会回退直连。修改对后续令牌、账户、额度和聊天请求生效，进行中的流式回复继续使用原连接。浏览器登录页面遵循浏览器自身的代理设置。

#### 连接外部 MCP 客户端

`cwtools-mcp` 独立维护和发布，只提供语义查询，默认复用 VS Code 中已经运行的语言服务。

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
```

```sh
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

独立模式和手动配置见 [cwtools-mcp 仓库](https://github.com/Aa728848/cwtools-mcp)。

### 架构

![System architecture overview](docs/system-architecture.png)

主要运行边界如下：

- `client/extension/`：VS Code Extension Host 代码和文件系统访问
- `client/webview/`：运行在浏览器沙盒中的面板与可视化编辑器
- `src/LSP/`、`src/Main/`：F#/.NET 语言服务
- `submodules/cwtools/`：上游 CWTools 库
- `submodules/cwtools-stellaris-config/`：Stellaris CWT 规则
- `submodules/cwtools-mcp/`：独立发布的只读 MCP 服务

Webview 只通过消息与 Extension Host 通信，不能直接访问 Node.js 或文件系统。详细数据流和维护边界见[架构文档](ARCHITECTURE.md)。

### 参与开发

本地开发需要 Node.js 20+、npm 10+、.NET 10 SDK、支持 submodule 的 Git，以及 VS Code 1.90+。

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
npm run compile
npm run test:unit
```

常用检查：

| 命令 | 用途 |
| --- | --- |
| `npm run lint` | 检查 Extension Host 和 Webview 代码。 |
| `npm run compile` | 编译 TypeScript 并打包 Webview。 |
| `npm run test:unit` | 运行单元测试。 |
| `dotnet build src/LSP/` | 构建可复用 LSP 层。 |
| `dotnet build src/Main/` | 构建语言服务端。 |
| `npm run verify` | 运行较完整的本地质量检查。 |
| `npm run build:docs` | 校验双语文档并生成 Marketplace README。 |

修改代码、打包扩展或调整子模块前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。编写 CWT 规则请从[规则配置指南](docs/cwt-rule-config.md)开始。

### 许可证

本项目采用 [MIT License](LICENSE.md)。感谢 [CWTools](https://github.com/cwtools) 以及 Paradox Mod 社区的贡献。
