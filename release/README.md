# Stellaris Language Serves

[English](#english) | [中文](#zh-cn) | [CWT Rule Guide / CWT 规则指南](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md) | [Diagnostic Codes / 诊断码](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/diagnostic-codes.md)

<a id="english"></a>

## English

### 🌌 Stellaris Language Serves

[![Built with F#](https://img.shields.io/badge/backend-F%23%20%2F%20.NET%2010-blue.svg?style=flat-square)](https://dotnet.microsoft.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square)]()

**Stellaris Language Serves** is a premier, modern IDE-grade VS Code extension custom-built for Paradox game modding, centered around **Stellaris**. Based on the upstream [CWTools](https://github.com/cwtools/cwtools-vscode), it undergoes deep refactoring and customization, combining a **high-performance .NET 10 backend**, an **expressive Webview sandbox visualization engine**, and a **cutting-edge autonomous multi-agent AI coprocessor**.

> [!NOTE]
> This project is not merely a syntax highlighter and validator; it is a **modern collaborative mod development hub** integrating 3D rendering, a real-time GUI canvas, a multi-agent parallel pipeline, and high-precision migration comparison.

---

#### 🚀 Four Pillars of Core Technology

##### ⚡ 1. High-Performance LSP (Language Server Protocol)
The CWTools LSP server, customized using **.NET 10** and **F#**, serves as the computation base of the entire extension, providing millisecond-level responsiveness for massive mod codebases.
- **Extreme Concurrent Performance**: Refactored the `LanguageServer` read-write lock mechanism. Read-only requests (hover preview, autocompletion, go-to-definition) execute concurrently across multiple threads; write modifications acquire exclusive locks sequentially, eliminating deadlocks or interface lagging.
- **O(1) Definition Search**: The `DocumentStore` abandons traditional $O(N)$ traversals, adopting **lazy line offset cache reconstruction** to compress Hover and Go-To-Definition search times to $O(1)$, realizing instantaneous positioning even for large mod files with hundreds of thousands of lines of code.
- **Semantic Validation & Macro Evaluation**: Supports deep syntax analysis, including real-time evaluation of complex macro expressions `@[...]` and `value:xxx|`, displaying localized texts in-line (CodeLens) and allowing hover previews of `inline_script` files.
- **Incremental Type Index Refresh**: When editing custom script definitions in `scripted_triggers` / `scripted_effects` / `script_values`, you no longer experience the 15-25s lag of reload project. The backend precisely replaces the affected type entries by file name and reconstructs index ONLY for modified types (zero-overhead reuse of other types). Diagnostics and completion refresh instantly on save (when `experimental` toggle is enabled).

##### 🎨 2. Sandbox Multi-Dimensional Webview Visualization Engine
This project makes deep use of the VS Code Webview isolation sandbox, utilizing modern web rendering technologies (Canvas / Cytoscape.js / Three.js) to deliver an unprecedented WYSIWYG experience to mod developers.
- **GUI Canvas Real-time Preview & Editing**: Supports real-time bidirectional interactive rendering of Stellaris `.gui` interface configuration files. It perfectly renders `corneredTileSpriteType` 9-slice stretching and multi-frame sprite (`noOfFrames`) animations. It supports visual layer trees and directly **drags controls to resize/reposition them, automatically writing back coordinate changes to the source code**.
- **3D Solar System Rendering & Orbit Editing**: Enter any solar system initializer `.txt` script in `solar_system_initializers/` to launch a gorgeous 3D system space. It supports recursive nesting of stars, planets, moons, and ring worlds. Developers can directly drag planets to modify their `orbit_distance` and `orbit_angle`, syncing changes back to the script.
- **Static Galaxy Preview & Position Editor**: Opens `map/setup_scenarios/*.txt` `static_galaxy_scenario` files in a Canvas2D galaxy map with systems, coordinate ranges, nebulas, and explicit hyperlanes. In Edit Mode, drag systems or nebulas to rewrite X/Y, edit or add Z in the Inspector, and add/disconnect explicit hyperlanes with minimal, span-precise `WorkspaceEdit`s that participate in native undo; reversed ranges, duplicate ids, and dangling lanes surface as visual diagnostics.
- **Technology Tree & Event Reference Network**: Uses Cytoscape.js to render highly interactive tech dependency and multi-level event flow graphs. It supports quick searching, relationship filtering, and double-clicking nodes to instantly navigate to the declaring script file and line number.
- **Three.js Entity & Animation Rendering**: Supports loading and debugging Paradox native `.asset` 3D meshes, textures, and skeletal animations within the Webview sandbox.
- **Particle Effect Preview & Editor**: Provides a three-pane editor for `particle={...}` definitions in `gfx/particles/**/*.asset` files, featuring Three.js real-time simulation, curve editing, subsystem/force/property modification, texture decoding, and write-back to `.asset`.

##### 🤖 3. Autonomous AI Coprocessor
This subsystem combines a general repository-coding Agent with a Paradox/CWTools specialist and a profile-aware multi-Agent runner.
- **Automatic Agent Routing with an Explicit Domain Boundary**: The composer exposes only the **capability domain** (`Auto`, `Paradox / CWTools`, or `General Coding`). A lightweight model-routing call resolves task intent and the single/multi-Agent strategy on every turn from the request, recent conversation, and active-file context; the applied mode and strategy appear beneath that user message and survive topic replay. Scoped changes execute directly, while genuinely complex changes may enter Plan; approving its annotation card starts the domain-matched Multi-Agent coordinator directly. Permission profiles and approval policy remain user-owned and are never changed by Agent routing. Invalid or unavailable routing falls back to deterministic safe classification.
- **Domain-Separated Execution**: General Coding receives only domain-neutral repository prompts, tools, diagnostics, memory, caches, resume state, and sub-Agent roles. It can inspect and edit ordinary repositories, run approved commands, and verify builds/tests, but cannot call CWT/CWTools/PDXScript, localisation, game-asset, or MCP capabilities. Paradox execution obtains mutable game facts on demand from active CWT rules, the CWTools LSP, and project indexes instead of embedding a small hard-coded rules table in prompts.
- **Profile-Aware Parallel DAG Orchestration**: General Multi-Agent dispatches repository engineering roles; Paradox Multi-Agent adds CWT/LSP evidence, entity contracts, localisation specialists, and semantic quality gates. Both coordinate bounded parallel work through a shared Blackboard.
- **Long-Run Reliability & Smart Context Windowing**: Structured context compression, recoverable checkpoints, progress-aware run budgets, activity-based child-Agent stall detection, and loop prevention allow long-running tasks to continue while still stopping genuinely stalled work.
- **Bi-directional MCP Integration**: The Paradox capability domain can consume configured stdio/SSE tools as an **MCP Client**; General Coding does not receive MCP tools because configured servers do not yet declare a trustworthy capability domain. The plugin simultaneously **exports a read-only MCP Server** (`packages/cwtools-mcp`) with 27 semantic tools for external agents like **Codex / Claude Code**—see Section 8 for details.
- **Workspace-wide Localization Indexing**: An asynchronous incremental indexing system based on VS Code `FileSystemWatcher` feeds stable, accurate localization context to the large model.

##### 📂 4. Differences & Fast Migration Pipeline (Vanilla Compare)
A powerful tool for updating mods to new Paradox game patches.
- **Block-Level Diff**: Open side-by-side diff screens against corresponding vanilla files with one click.
- **Safe Bottom-Up Merge**: Supports migrating the block under the cursor (`migrateBlockFromVanilla`). The underlying algorithm applies replacements **bottom-up (from back to front)**, preventing line offsets from invalidating subsequent changes.

---

#### 🏛️ System Architecture

Below is the overall module interaction and data flow topology:

![System architecture overview](docs/system-architecture.png)

---

#### ⚙️ Quick Start

##### Prerequisites
- **OS**: Windows / macOS / Linux
- **VS Code**: 1.90.0 or higher
- **.NET Runtime**: [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) is required for local building/development.

##### Installation Steps
1. Download the latest `.vsix` package from the Releases page.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), select `Extensions: Install from VSIX...`, and choose the downloaded VSIX file to complete the installation.
3. Upon first activation, a notification will prompt you to select the **vanilla game installation folder** to build the initial language server cache.

---

#### 💡 Feature Guide

##### 🎨 1. GUI Canvas Preview & Drag-and-Sync Editing
* **How to open**: Open any `.gui` file in VS Code and click the **Palette Icon (Preview GUI)** in the top right editor toolbar.
* **Operations**:
  - The dual-column attribute panel will slide in on the right, automatically parsing DDS/TGA textures.
  - You can click to select components in the canvas and **drag to resize or move them**. The AST rewriting algorithm will rewrite the code layout in the left `.gui` editor in real-time.
  - Press `Ctrl+Z` to undo canvas modifications.

##### 🌌 2. 3D Solar System Interactive Editor
* **How to open**: Open any system initializer `.txt` script under `solar_system_initializers/` and click the **Telescope Icon (Preview Solar System)** in the top right.
* **Operations**:
  - Zoom with mouse wheel, pan with right-click, and rotate view with `Alt+Drag`.
  - In **Edit Mode**, right-click the canvas to create stars, planets, moons, or ring worlds.
  - **Drag a planet directly along its orbit** to modify its distance and angle; variables like `orbit_distance` and `orbit_angle` will sync back to the editor.

##### 🌌 3. Static Galaxy Preview & Position Editor
* **How to open**: Open any `.txt` file under `map/setup_scenarios/` and click the **Map Icon (Preview/Edit Static Galaxy)** in the editor title bar, or use the file's context menu. A `Static Galaxy Preview/Editor` entry is also available via **Open With...**.
* **Operations**:
  - Zoom with the mouse wheel, pan with `Space`/`Alt`/middle-drag, click to select a system or nebula, and **double-click to jump to its source block**.
  - Use the **Preview / Edit** segmented control (shortcut `E`) to switch modes without losing zoom, pan, filters, or selection.
  - In **Edit Mode**, drag a system or nebula to translate its X/Y position; range coordinates `{ min max }` keep their width, and only the touched number tokens are rewritten — one drag produces exactly one native undo step. The Inspector accepts precise X/Y/Z values (and can add a missing Z) plus nebula radius. Systems with an `initializer` show resolved details (star class with matching node color, planet/moon/belt counts, ring worlds). Explicit hyperlanes can be drawn on the canvas: right-click a system to enter lane-drawing mode, left-click to chain endpoints (A→B→C…), and right-click again to confirm all segments as a single edit; right-clicking an existing lane deletes its `add_hyperlane` declaration from the source. The **Spray/Erase** tools scatter or remove undefined random systems (named/initializer systems are always protected) with one undo step per stroke — the brush radius has a slider, `Alt+right-drag` resizes it, `Shift` sprays along a straight direction with scatter, and `Ctrl+Shift` presses exact lines whose column count grows with the radius.
  - `random_hyperlanes = yes` is called out explicitly: runtime-generated lanes are never presented as exact preview data. An optional **Estimated lanes** toggle (off by default) draws a clearly-labeled heuristic approximation — never written back to source.
  - Steam Workshop files show a risk banner and require confirmation before editing; copying the file into your mod workspace is offered as the safe path.

##### 🌐 4. Tech Tree & Event Dependency Graph
* **How to open**: Inside tech or event definition scripts, click the **Graph Icon (Show Dependency Graph)**.
* **Operations**:
  - Leverages Cytoscape.js to display pre-requisites and downstream effects.
  - Supports searching, filter constraints, and node highlighting. **Double-click any node** to navigate and jump to its declaration line in the source file.

##### 🤖 5. Autonomous AI Panel
* **How to open**: Click the **AI Icon** in the Activity Bar or execute `AI: Open Chat Panel` in the Command Palette.
* **Agent profile**: Use the composer menu only when you need to pin the **Capability Domain**. Task intent and execution strategy remain automatic; choosing `Auto` also lets the runtime detect the domain for each turn.
* **Operations**: Supports context memory compression (triggered at 70% threshold) and importing/exporting full JSON execution archives.
* **Codex with ChatGPT quota**: Select **Codex (ChatGPT Subscription)** in AI Settings and sign in once through the browser PKCE flow compatible with [OpenCode's ChatGPT Plus/Pro integration](https://opencode.ai/docs/providers/). Access and refresh tokens are stored only in VS Code SecretStorage and refreshed automatically; **Sign out** removes only this extension's credentials. The provider calls the fixed ChatGPT Codex Responses backend, never accepts an API key or endpoint override, and never falls back to billable OpenAI Platform calls. It does not install, launch, inspect, or share login state with Codex CLI/Desktop. Account, plan, quota windows, and a compatibility model catalog are shown in settings. Chat turns use the extension's native Agent runtime, so the selected model and reasoning level, current Agent sandbox, permission policy, write scheduler, tools, and MCP configuration all follow the same path as other providers. This subscription endpoint is an internal compatibility surface rather than a public stable API and may require updates when the upstream flow changes. The provider remains excluded from inline completion, translation preview, and child-Agent model selectors.
* **Architecture Diagrams**: When a design or analysis contains several connected components, the Agent can emit Mermaid flow/sequence/state diagrams. Chat messages, live process text, tool-result cards, plans, blueprints, and walkthrough cards render them locally with VS Code theme colors, source copy, fullscreen viewing, and safe source fallback.
* **Web Access**: Agent settings separate search from live page access. Search providers include OpenAI, Brave, Exa, Tavily, Serper, SerpAPI, SearXNG, and a DuckDuckGo fallback; provider keys are kept in VS Code SecretStorage. Live pages pass public-address, redirect, size, and domain-policy checks and are always treated as untrusted evidence.

##### 📂 6. Vanilla Compare & Safe Merge
* **Diff View**: When editing a mod file that shares the same name as a vanilla file, click the **Compare with Vanilla** CodeLens.
* **Sync**: Click **Migrate Block from Vanilla** above a changed block. The system locks the write queue and applies changes bottom-up, keeping line coordinates accurate.

##### 💎 7. Asset & 3D Mesh Animation Debugger
* **How to open**: In `.asset` or `.gfx` files, click the **3D Model Icon (Preview Entity)**.
* **3D & Material Debug**:
  - Parses and renders `.mesh` files.
  - Automatically loads and decodes DDS materials to render high-fidelity graphics.
* **Animation Playback**:
  - Renders skeleton node trees, allowing you to select and play animations (e.g., move, idle, attack) in the right-hand panel.
  - Fine-tune materials (e.g., diffuse, specular) using slider panels.

##### 🔌 8. Out-of-the-Box MCP Server (for Codex / Claude Code)
This extension bundles a **read-only** Model Context Protocol (MCP) server, offering 27 read-only semantic tools of CWTools (project knowledge pack, bounded project graph, syntax check, scope queries, definitions, references, diagnostics, scripted triggers/effects/enums) to external agents.
* **Bounded Semantic Graph**: `explore_pdx_project` is the preferred first query for large mods. It returns ranked typed entry points, dependency edges, per-file semantic facts, provenance, truncation budgets, and freshness from the live CWTools model without reading whole files.
* **Compact `/init` Knowledge Database**: the deep `/init` phase performs one complete export of the loaded project + vanilla definitions and workspace reference topology into `.cwtools/project/knowledge/manifest.json` plus `knowledge.sqlite`, replacing the former duplicated capability/archetype JSON set. Deterministic partial results are published once with an accurate coverage warning instead of repeating the same full scan; transient loading/stale states still retry. `/init` also directly creates or incrementally updates `.cwtools/index/workspace-symbols.sqlite` before deep export. On first activation, an existing `.cwtools-ai` tree is merged into `.cwtools` and the old directory is removed; when both contain the same relative path, the current `.cwtools` copy wins and the legacy copy is preserved under `.cwtools/migration-conflicts/cwtools-ai/`. A lower-left VS Code progress indicator remains visible while the workspace index is built, CWTools becomes ready, and the knowledge database is published. `query_project_knowledge` resolves explicit IDs through SQLite indexes, expands their reference/event/logic neighbourhood, and falls back to bounded intent search only when no identifier seed is supplied. It retrieves definitions, stacks, topology, project/vanilla patterns, and event structure/logic—including call phases, `on_action` entries, flags, technologies, variables, and scope bridges—without loading the whole database into the prompt. Lazy `query_workspace_index` calls restore persistent SQLite rows, publish the workspace phase first, parse only changed files, and wait at most eight seconds before returning partial results while vanilla indexing continues. After a serialized vanilla `.cwb` and its metadata are successfully rewritten, the Extension immediately force-rebuilds that game's global vanilla-symbol SQLite database before reloading; the filesystem watcher remains a fallback and marks matching project knowledge for refresh.
* **Extension-Host Bridge by Default**: The MCP entry script connects to the active VS Code-compatible host (VS Code, Cursor, VSCodium, Antigravity, etc.) through `globalStorage/mcp/bridge-manifest.json`, reusing the IDE's existing CWTools language client and Problems diagnostics instead of starting a second server. The client workspace is discovered dynamically from MCP roots/session environment/cwd and must match the bridge workspace; mismatches return `bridge_unavailable` instead of answering from another project.
* **Stable Version-Independent Path**: Activated plugins copy the proxy script to `globalStorage/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs` to survive version upgrades. Legacy standalone mode is still available with `--standalone`.
* **Codex**:
  ```sh
  codex mcp add cwtools -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
  ```
* **Claude Code**:
  ```sh
  claude mcp add cwtools --scope user -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
  ```
* **Antigravity**: add `cwtools` to `~/.gemini/config/mcp_config.json` with `"command": "node"` and `"args": ["<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs", "--stdio"]`.
  Use the `globalStorage` path from the compatible host where the extension is active. For configuration details, see [packages/cwtools-mcp/README.md](https://github.com/Aa728848/cwtools-vscode/blob/master/packages/cwtools-mcp/README.md).

---

#### 🛠️ Developer Hub

If you intend to contribute code or perform development using AI assistants, please follow these guidelines:

##### Fresh Clone Setup

Install these tools before building or packaging:

| Tool | Required version / notes |
| --- | --- |
| Git | A current version with submodule support |
| Node.js / npm | Node.js 20.x or newer and npm 10.x or newer |
| .NET SDK | .NET 10 SDK; `global.json` currently selects `10.0.301` and allows the latest minor roll-forward |
| PowerShell | Windows PowerShell 5.1 or newer for the root `npm run pack*` scripts |
| VS Code | 1.90 or newer; the `code` CLI is additionally required only by `npm run pack:install` / `pack:quick` |

Clone the two required submodules and install all npm workspace dependencies:

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

If the repository was cloned without `--recurse-submodules`, repair it before
building; a missing `submodules/cwtools` breaks the F# build and a missing
`submodules/cwtools-stellaris-config/config` breaks packaging:

```bash
git submodule update --init --recursive
```

Before the first full package, verify that `node --version`, `npm --version`,
`dotnet --version`, and `git --version` work from the same terminal, and check
`$PSVersionTable.PSVersion` in PowerShell. Then run `npm run compile` once to
catch dependency or frontend setup problems before the slower three-platform
server publish.

##### Common Commands
Run the following at the workspace root:
```bash
# 1. Compile TypeScript extension & build webviews via Rollup
npm run compile

# 2. Run ESLint code checks (ESLint 9 strict mode)
npm run lint

# 3. Run unit tests
npm run test:unit

# 4. Run VS Code integration tests
npm run test

# 5. Build .NET/F# language server backend
dotnet build src/LSP/
dotnet build src/Main/

# 6. Quality gate verify (Lint + Compile + Test + Release Gate)
npm run verify

# 7. Build and verify the MCP service (packages/)
npm run build:mcp
npm run generate:mcp-schema
npm run test:contracts
```

For CWT rule authoring, see [CWT Rule Configuration Guide](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md).

##### Submodules
This repository uses two submodules with different roles:

- [`submodules/cwtools/`](submodules/cwtools/README.md): upstream CWTools F# library used by the language server
  for parsing, validation, game semantics, shader support, and scripted-type
  refresh behavior.
- [`submodules/cwtools-stellaris-config/`](submodules/cwtools-stellaris-config/README.md): Stellaris CWT rule configuration data.
  Rules sync tooling compares it against game `script_documentation` logs and
  vanilla `common/`; packaging uses its `config/` directory as the fallback
  rules bundle.

##### 📦 Extension Packaging
The generated VSIX contains self-contained `win-x64`, `linux-x64`, and
`osx-x64` servers. The root npm packaging commands invoke `package.ps1`, so run
them from Windows PowerShell at the repository root after completing the fresh
clone setup above:

```bash
npm run pack         # full package
npm run pack:install # package and install locally
npm run pack:quick   # skip server rebuild, package and install locally
```

`pack:quick` reuses existing server binaries; it is not suitable for the first
package unless a complete `release/bin/server/` already exists. `pack:install`
and `pack:quick` also require the VS Code `code` command on `PATH`. A successful
package is written to `release/eddy-stellaris-cwt-<version>.vsix`.

`npm run build:docs` validates the single-source bilingual docs and builds
`release/README.md` from this README. For the full packaging workflow, see
[.agents/workflows/package.md](https://github.com/Aa728848/cwtools-vscode/blob/master/.agents/workflows/package.md) or use
`package.ps1` directly.

---

#### 🤝 License
This project is distributed under the [MIT License](LICENSE). Special thanks to the [CWTools](https://github.com/cwtools) open-source project and all contributors in the Paradox modding ecosystem!

---

<a id="zh-cn"></a>

## 中文

### 🌌 Stellaris Language Serves

[![Built with F#](https://img.shields.io/badge/backend-F%23%20%2F%20.NET%2010-blue.svg?style=flat-square)](https://dotnet.microsoft.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square)]()

**Stellaris Language Serves** 是专为 Paradox 游戏 Modding（以 **Stellaris (群星)** 为核心）打造的顶级、现代化集成开发环境（IDE）级 VS Code 扩展。它基于上游的 [CWTools](https://github.com/cwtools/cwtools-vscode) 进行了深度的重构与定制开发，融合了**超高性能的 .NET 10 后端**、**极富表现力的 Webview 沙盒可视化引擎**，以及**前沿的自主多 Agent AI 协处理器**。

> [!NOTE]
> 本项目不仅是一个语法高亮与校验工具，而是一个集成了 3D 渲染、实时 GUI 画布、多 Agent 并行流水线及高精密迁移对比的**现代化 Mod 协同开发中枢**。

---

#### 🚀 核心技术四大支柱

##### ⚡ 1. 超高性能语言服务引擎 (High-Performance LSP)
基于 **.NET 10** 和 **F#** 深度定制的 CWTools LSP 服务端，作为整个插件的计算底座，为庞大的 Mod 代码提供了毫秒级的极致响应。
- **极致的并发性能**：重构了 `LanguageServer` 读写锁机制，只读请求（如悬浮预览、自动补全、跳转定义）多线程共享并发执行；变更写入操作（如文件修改）持独占锁串行执行，彻底告别慢查询导致的死锁或界面卡顿。
- **O(1) 定位查找**：`DocumentStore` 摒弃了传统的 $O(N)$ 遍历，采用**惰性重建行偏移缓存**技术，将 Hover 和 Go-To-Definition 的查找时间直接压缩至 $O(1)$，对拥有数十万行代码的超大型 Mod 文件实现即时定位。
- **语义校验与宏求值**：支持深度语法分析，甚至能对复杂的宏表达式 `@[...]` 以及 `value:xxx|` 进行实时求值，在编辑器行内无缝显示本地化文本（CodeLens）及 `inline_script` 文件悬浮预览。
- **增量类型索引刷新**：编辑保存 `scripted_triggers` / `scripted_effects` / `script_values` 等自定义脚本定义时，告别旧版「必须重新加载项目」的 15–25 秒卡顿——后端按文件名精确替换受影响的类型条目、仅重建变更类型的索引（其余类型零开销复用），保存后诊断与补全即时刷新（`experimental` 开关启用）。

##### 🎨 2. 沙盒化多维 Webview 可视化引擎 (Rich Visualization)
本项目深度利用了 VS Code Webview 隔离沙盒，基于现代 Web 渲染技术（Canvas / Cytoscape.js / Three.js），为 Mod 开发者带来了前所未有的所见即所得体验。
- **GUI Canvas 实时预览与编辑**：支持群星 `.gui` 文件的实时双向交互渲染。完美实现 `corneredTileSpriteType` 9-切片拉伸绘制、多帧精灵（`noOfFrames`）动画循环，支持可视化图层树和直接在画布上**拖拽调整控件尺寸及坐标并回写源码**。
- **3D 恒星系渲染与轨道编辑**：进入 `solar_system_initializers/` 脚本，即可开启精美的 3D 星系空间。支持恒星、行星、卫星、环形世界（Ring World）的任意递归嵌套。开发者可以通过直接拖动行星改变其 `orbit_distance` 与 `orbit_angle` 并自动同步至脚本。
- **静态银河预览与位置编辑**：在 Canvas2D 银河地图上打开 `map/setup_scenarios/*.txt` 中的 `static_galaxy_scenario`，展示系统、坐标范围、星云与显式超空间航道。编辑模式下可拖动系统或星云回写 X/Y、在检视器中编辑或补充 Z，并添加/断开显式航道；所有修改均使用最小 `WorkspaceEdit` 并接入原生撤销。反向范围、重复 ID、悬空航道等问题会以可视化诊断呈现。
- **科技树与事件引用网络**：利用 Cytoscape.js 渲染高交互性的科技依赖图与事件链流向图。支持快速检索、关系筛选及点击节点瞬间定位至对应的 `.txt` 脚本源码行。
- **Three.js 实体与动画渲染**：支持 Paradox 原生 `.asset` 三维网格、贴图及骨骼动画在 Webview 中的沙盒化加载与动作调试。
- **粒子特效预览与编辑**：支持 Stellaris `gfx/particles/**/*.asset` 中 `particle={...}` 的三栏粒子编辑器，提供 Three.js 实时近似模拟、曲线编辑、子系统/力/属性编辑、贴图解码预览与 `.asset` 写回。

##### 🤖 3. 自主 AI 协处理器 (Advanced AI System)
该子系统同时提供通用仓库编码 Agent、Paradox / CWTools 专用 Agent，以及能够按领域选择角色和质量门的多 Agent 运行器。
- **显式领域边界与自动 Agent 路由**：输入框只提供**能力领域**（`自动`、`Paradox / CWTools`、`通用编码`）选择；每一轮由轻量模型路由调用依据当前请求、近期对话和活动文件判断任务意图以及单/多 Agent 执行策略，实际采用的模式与策略会显示在对应用户消息下方并随 Topic 恢复。范围明确的修改直接执行，真正复杂的修改可以先进入 Plan；批准其批注卡后会直接启动与能力领域匹配的多 Agent 协调器。权限 Profile 与审批策略始终由用户控制，不会被 Agent 路由改变。路由不可用或结果无效时，使用确定性的安全回退。
- **按领域分离执行链**：通用编码 Agent 只接收领域中立的仓库提示词、工具、诊断、记忆、缓存、恢复状态和子 Agent 角色；它可以调查普通仓库、修改代码/配置/测试/文档并运行获准的构建测试，但不能调用 CWT/CWTools/PDXScript、本地化、游戏资产或 MCP 能力。Paradox Agent 则按需从活动 CWT 规则、CWTools LSP 和项目索引获取动态游戏事实，不在提示词中维护少量易过时的硬编码规则表。
- **Profile 感知的并行 DAG 编排**：通用多 Agent 使用领域中立的仓库工程角色；Paradox 多 Agent 额外使用 CWT/LSP 证据、实体契约、本地化专职角色和语义质量门。两者都通过共享黑板协调有界并行任务。
- **长期运行可靠性与智能压缩**：结构化上下文压缩、可恢复检查点、按进展续期的运行预算、基于活动状态的子 Agent 卡死检测和循环防御，使长任务可以持续完成，同时仍会终止真正停滞的工作。
- **MCP 双向集成（消费 + 输出）**：Paradox 能力领域可作为 **MCP 客户端**调用已配置的 stdio/SSE 工具；由于现有 MCP Server 配置尚无可信的能力领域声明，通用编码不会获得 MCP 工具。插件同时**对外输出一个随包分发的只读 MCP 服务**（`packages/cwtools-mcp`），把 27 个 PDX 语义工具开放给 **Codex / Claude Code** 等外部 Agent 复用——详见下方功能指引第 8 节。
- **全工作区本地化索引**：全工作区本地化 YML 文本基于后台 `FileSystemWatcher` 异步实时增量索引，为大模型源源不断地输送稳定、精准的项目上下文。

##### 📂 4. 原版对比与极速迁移通道 (Vanilla Compare & Sync)
处理巨型 Mod 升级与适配 Paradox 官方版本更新的利器。
- **块级无缝对比**：支持在脚本中一键开启与原版（Vanilla）对应文件的 Diff 视图。
- **自底向上安全合并**：支持光标所在块的“一键迁移同步”（`migrateBlockFromVanilla`），底层迁移算法采用**从后往前（自底向上）**的替换策略，保证前端行号修改不会导致上方偏移失效，极速适配版本变动。

---

#### 🏛️ 系统架构全景图

以下为项目的整体模块交互与数据流拓扑，清晰展现了各层级之间的隔离屏障与通信管道：

![System architecture overview](docs/system-architecture.png)

---

#### ⚙️ 极速安装与开始

##### 运行要求
- **操作系统**：Windows / macOS / Linux
- **VS Code 版本**：1.90.0 或更高版本
- **.NET 运行时**：本地开发编译需要安装 [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)

##### 安装步骤
1. 在 Release 页面下载最新的 `.vsix` 打包文件。
2. 打开 VS Code，按下 `Ctrl+Shift+P` (macOS 下为 `Cmd+Shift+P`)，输入并选择 `Extensions: Install from VSIX...`，选择下载的 VSIX 文件完成安装。
3. 首次激活插件时，系统会弹出通知提示您选择**原版游戏安装目录**以构建初次语言服务器缓存，完成配置后即可开启极速开发之旅。

---

#### 💡 主要功能使用指引 (Feature Guide)

为了让您能够快速上手这套极具表现力的 IDE 开发工具链，我们为您整理了如下核心功能的使用指引：

##### 🎨 1. GUI 实时画布预览与拖拽同步编辑
* **如何打开**：在 VS Code 中打开任意 `.gui` 界面配置文件，点击右上角编辑器工具栏的 **画板图标 (Preview GUI)**。
* **同步操作**：
  - 双列网格属性面板将呈现在右侧，支持 DDS/TGA 贴图自动检索与解码显示。
  - 您可以直接在画布中点击选中控件并进行**拖拽缩放或平移位置**，底层的 AST 重构算法会即时重组代码并自动写回左侧的 `.gui` 源代码文件中。
  - 支持 `Ctrl+Z` 随时撤销画布和属性更改，提供所见即所得的极速开发体验。

##### 🌌 2. 3D 恒星系交互编辑器 (3D Solar System)
* **如何打开**：在 `solar_system_initializers/` 目录下的星系初始化 `.txt` 脚本中，点击编辑器标题栏的 **望远镜图标 (Preview Solar System)**。
* **三维交互**：
  - 视图支持鼠标滚轮缩放、右键平移和 `Alt+拖拽` 进行多维度视角旋转。
  - 在**编辑模式**下，您可以通过右键菜单直接创建恒星、行星、卫星以及 Ring World。
  - 用鼠标**直接在 3D 轨道上拖拽行星**修改其轨道距离和角度，对应的 `orbit_distance` 与 `orbit_angle` 参数会同步写回至编辑器内的 Paradox 脚本。

##### 🌌 3. 静态银河预览与位置编辑器 (Static Galaxy)
* **如何打开**：打开 `map/setup_scenarios/` 目录下的 `.txt` 文件，点击编辑器标题栏的 **地图图标 (Preview/Edit Static Galaxy)**，或使用文件右键菜单；也可通过 **打开方式 (Open With...)** 选择 `Static Galaxy Preview/Editor`。
* **交互操作**：
  - 滚轮缩放，`空格`/`Alt`/中键拖动平移，单击选择系统或星云，**双击跳转到对应源码块**。
  - 通过顶部的 **预览 / 编辑** 分段按钮（快捷键 `E`）切换模式，缩放、平移、筛选和选中项均不会重置。
  - 在**编辑模式**下拖动系统或星云即可平移其 X/Y 位置；范围坐标 `{ min max }` 平移时保持宽度不变，写回只替换被修改的数字 token——一次拖动恰好对应一次原生撤销。检视器支持精确填写 X/Y/Z（包括为原本没有 Z 的位置补充 Z）以及星云半径。定义了 `initializer` 的系统会显示解析出的星系详情（恒星类型及同色节点、行星/卫星/小行星带数量、环形世界）。显式航道可直接在画布上绘制：右键点击系统进入绘制模式，左键连续链接端点（A→B→C…），再次右键把所有航段合并为一次写回；右键点击已有航道会从源码中删除对应的 `add_hyperlane` 声明。**喷涂/擦除**工具可批量散布或移除未定义的随机星系（有名称或 initializer 的系统始终受保护），每次笔画恰好一次撤销——笔刷半径可用滑块或 `Alt+右键拖动` 调整，按住 `Shift` 沿直线方向散布，`Ctrl+Shift` 则精确压线且列数随半径增加。
  - `random_hyperlanes = yes` 会明确提示：运行时生成的随机航道不会被当作精确预览结果展示。可选的**估算航道**开关（默认关闭）绘制明确标注的启发式近似航道——永远不会写回源码。
  - Steam Workshop 文件会显示风险横幅，编辑前需要确认，并优先提供复制到 Mod 工作区的安全路径。

##### 🌐 4. 科技树与事件引用网络 (Dependency Graph)
* **如何打开**：在科技或事件定义脚本中，点击右上角的 **依赖图图标 (Show Dependency Graph)**。
* **交互导航**：
  - 底层基于 Cytoscape.js 渲染高表现力的连线节点拓扑，直观呈现复杂科技前置要求或事件的多级触发链。
  - 完美支持搜索框快速过滤、层级限制与节点高亮。**双击任意节点**，编辑器将自动跳转并精准高亮至其声明所在的源文件代码行。

##### 🤖 5. 自主 AI 开发面板 (Autonomous AI)
* **如何打开**：点击侧边栏的 **AI 图标**，或按快捷键 `Ctrl+Shift+P` 搜索并执行 `AI: Open Chat Panel` 开启会话。
* **Agent Profile**：输入框旁的菜单只用于选择或固定**能力领域**；任务意图和执行策略始终自动判断。选择“自动”时，运行时也会逐轮识别能力领域。
* **特性操作**：会话支持完整的上下文压缩（超过 70% 时自动生成紧凑记忆）以及一键无损导入导出完整
运行步骤的 JSON 归档。
* **使用 ChatGPT 额度的 Codex Provider**：在 AI 设置中选择 **Codex（ChatGPT 订阅）**，通过与 [OpenCode 的 ChatGPT Plus / Pro 集成](https://opencode.ai/docs/providers/)兼容的浏览器 PKCE 流程登录一次即可。Access Token 和 Refresh Token 只保存在 VS Code SecretStorage，并会自动刷新；“退出账号”只删除本插件保存的凭据。Provider 固定调用 ChatGPT Codex Responses 后端，不接受 API Key 或自定义 Endpoint，也不会降级到按量计费的 OpenAI Platform API。它不安装、启动或探测 Codex CLI / Desktop，也不与这些程序共享登录状态。设置页会显示账户、套餐、额度窗口及兼容模型清单。对话统一使用插件原生 Agent 运行时，因此所选模型与思考等级、当前 Agent 沙盒、权限策略、写入调度、工具和 MCP 配置均与其他 Provider 走同一条链路。该订阅端点属于内部兼容接口，并非公开稳定 API；上游流程变化时可能需要同步适配。该 Provider 仍从内联补全、翻译预览和子 Agent 模型选择器中排除。
* **架构流程图**：当设计或分析包含多个相互关联的组件时，Agent 可以按需输出 Mermaid 流程图、时序图或状态图。聊天消息、实时过程文本、工具结果卡、计划、蓝图和 walkthrough 卡片都会使用 VS Code 主题在本地渲染，并支持复制源码、全屏查看和失败时安全回退到源码。
* **网页访问**：Agent 设置将搜索与实时网页访问分开控制。搜索供应商支持 OpenAI、Brave、Exa、Tavily、Serper、SerpAPI、SearXNG，并可降级到 DuckDuckGo；供应商密钥保存在 VS Code SecretStorage。实时网页必须经过公开地址、重定向、响应大小和域名策略检查，并始终作为不可信外部证据处理。

##### 📂 6. 原版对比与块级安全合并 (Vanilla Sync)
* **一键对比**：插件激活后，当您编辑的 Mod 文件与原版游戏文件同名时，点击行上方的 CodeLens **Compare with Vanilla** 打开分屏 Diff。
* **安全替换**：如果需要提取原版官方代码段，点击代码块上方出现的 **Migrate Block from Vanilla**。系统将锁定并发队列，自底向上智能应用合并，防止因前端坐标更改导致后续块偏移失效。

##### 💎 7. Asset 资产与 3D Mesh 实体动画调试器 (Asset & Mesh Previewer)
* **如何打开**：在 VS Code 中打开 `.asset` 实体配置文件或 `.gfx` 图形定义文件，点击右上角编辑器工具栏的 **3D 模型图标 (Preview Entity)**。
* **3D 网格与材质调试**：
  - 底层基于 Three.js 实现 Paradox 专有 3D 网格模型文件（`.mesh`）的极速沙盒化解析与三维渲染。
  - 自动根据配置搜寻、加载并解码 DDS 格式的材质贴图，提供高保真的光照着色预览。
* **骨骼动画微调**：
  - 完美解析绑定的骨骼节点树，支持在右侧控制台中实时挑选、播放不同的骨骼动画序列（如移动、待机、战斗）。
  - 支持材质属性（如漫反射、高光强度）在侧边栏面板上的动态滑块调节与实时重绘调试。

##### 🔌 8. 通用 MCP 服务（供 Codex / Claude Code 调用）
本插件随包分发一个**只读**的 MCP 服务，把 CWTools 的 PDX 语义能力（项目知识包、有界项目语义图、验证 ID、查语法、查作用域、全项目诊断、定义/引用、补全、scripted effects/triggers/enums/modifiers/variables、实体信息，共 27 个只读工具）开放给任意 MCP 客户端。文件写入仍由你的 Agent 自带环境完成。
* **有界语义图**：大型 Mod 优先调用 `explore_pdx_project`。它直接读取 live CWTools model，返回排序后的 typed entry point、依赖边、逐文件语义事实、provenance、截断预算与 freshness，不需要读取整份文件。
* **紧凑的 `/init` 知识数据库**：深度 `/init` 阶段只执行一次完整导出，把已加载的项目与原版定义以及工作区引用拓扑保存为 `.cwtools/project/knowledge/manifest.json` 和 `knowledge.sqlite`，替代原先重复的 capability/archetype JSON 集合。确定性的部分结果只发布一次并准确提示覆盖范围，不再重复相同的全量扫描；仅临时的加载中或陈旧状态会重试。`/init` 还会在深层导出前直接创建或增量更新 `.cwtools/index/workspace-symbols.sqlite`。首次激活时，已有 `.cwtools-ai` 会合并进 `.cwtools` 并删除旧目录；同一相对路径同时存在时，以当前 `.cwtools` 文件为准，旧冲突内容保存在 `.cwtools/migration-conflicts/cwtools-ai/`。构建工作区索引、等待 CWTools 和发布知识数据库期间，VS Code 左下角会持续显示进度。`query_project_knowledge` 会先通过 SQLite 索引解析显式 ID，再扩展其引用、事件与逻辑邻域；只有未提供标识符种子时才退回有界意图检索。它可按需检索定义、定义栈、拓扑、项目/原版范例，以及事件调用阶段、`on_action` 入口、Flag、科技、变量和作用域桥接等事件结构与逻辑关系，无需把整个数据库塞入提示词。懒加载的 `query_workspace_index` 会先恢复持久化 SQLite、优先发布工作区阶段、只解析变化文件，并最多等待八秒后返回部分结果，同时让原版索引继续构建。序列化原版 `.cwb` 及其元数据成功重写后，Extension 会在重载窗口前立即强制重建该游戏的全局原版符号 SQLite；文件 watcher 仍作为兜底，并把匹配的项目知识标记为待刷新。

* **默认复用插件内服务**：MCP 入口脚本会通过 `globalStorage/mcp/bridge-manifest.json` 连接当前已激活的 VS Code 兼容宿主（VS Code / Cursor / VSCodium / Antigravity 等），复用 IDE 中已有的 CWTools LSP 与 Problems 诊断，不再额外启动第二个重型服务。客户端工作区会从 MCP roots、会话环境变量或 cwd 动态发现，且必须与 bridge 暴露的工作区一致；不一致时返回 `bridge_unavailable`，不会从另一个项目静默回答。
* **版本无关稳定路径**：插件激活时把 MCP 代理脚本同步到 `globalStorage/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs`（不含版本号），配置指向它即可**自动跟随插件更新**。旧的独立 LSP 模式仍可用 `--standalone` 显式启用。
* **Codex**：

```sh
codex mcp add cwtools -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

* **Claude Code**：

```sh
claude mcp add cwtools --scope user -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

* **Antigravity**：在 `~/.gemini/config/mcp_config.json` 中添加 `cwtools`，内容为 `"command": "node"` 和 `"args": ["<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs", "--stdio"]`。

  请使用实际运行插件的兼容宿主自己的 `globalStorage` 路径。等价的 `~/.codex/config.toml` 手写配置、`--standalone`/`--rules`/`--cache`/`--game-path` 高级选项与 Claude Code 接入方式，详见 [packages/cwtools-mcp/README.md](https://github.com/Aa728848/cwtools-vscode/blob/master/packages/cwtools-mcp/README.md)。

---

#### 🛠️ 开发者指南 (Developer Hub)

如果您有志于为本项目贡献代码，或者需要使用 AI 助手进行二次开发，请务必遵循以下工作流：

##### 首次克隆与环境准备

构建或打包前请先安装以下工具：

| 工具 | 必要版本 / 说明 |
| --- | --- |
| Git | 支持 submodule 的当前版本 |
| Node.js / npm | Node.js 20.x 或更高、npm 10.x 或更高 |
| .NET SDK | .NET 10 SDK；`global.json` 当前选择 `10.0.301`，并允许滚动到最新 minor 版本 |
| PowerShell | 根目录 `npm run pack*` 脚本需要 Windows PowerShell 5.1 或更高版本 |
| VS Code | 1.90 或更高；只有 `npm run pack:install` / `pack:quick` 还要求 `code` CLI 可用 |

克隆两个必需的子模块，并安装根项目及 npm workspaces 的全部依赖：

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

如果克隆时没有使用 `--recurse-submodules`，请在构建前补全子模块；缺少
`submodules/cwtools` 会导致 F# 构建失败，缺少
`submodules/cwtools-stellaris-config/config` 会导致打包失败：

```bash
git submodule update --init --recursive
```

首次完整打包前，请在同一个终端确认 `node --version`、`npm --version`、
`dotnet --version` 和 `git --version` 均能正常运行，并在 PowerShell 中检查
`$PSVersionTable.PSVersion`。建议先执行一次 `npm run compile`，尽早发现依赖或前端环境问题，再进行耗时更长的三平台服务端发布。

##### 常用构建与验证命令
在项目根目录下，您可以使用以下命令验证项目的完整性：

```bash
# 1. 编译全部 TypeScript 代码并使用 Rollup 捆绑前端 Webview UI
npm run compile

# 2. 运行 ESLint 代码质量检查 (ESLint 9 严格模式)
npm run lint

# 3. 运行 TypeScript 单元测试
npm run test:unit

# 4. 运行 VS Code 集成测试套件
npm run test

# 5. 编译 C# / F# 语言服务端后端代码
dotnet build src/LSP/
dotnet build src/Main/

# 6. 一键全面质量检查 (Lint + Compile + Unit Test + Release Gate)
npm run verify

# 7. 构建并校验随插件分发的 MCP 服务（packages/）
npm run build:mcp            # 构建 MCP 子包
npm run generate:mcp-schema  # 从上游工具定义重生成 MCP schema
npm run test:contracts       # MCP 合约测试（schema 漂移 / 只读 / 路由）
```

CWT 规则编写说明见 [CWT 规则配置开发指南](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md)。

##### 子模块
本仓库使用两个职责不同的子模块：

- [`submodules/cwtools/`](submodules/cwtools/README.md)：上游 CWTools F# 库，供语言服务器复用解析、校验、游戏语义、Shader 支持和 scripted type 增量刷新等能力。
- [`submodules/cwtools-stellaris-config/`](submodules/cwtools-stellaris-config/README.md)：Stellaris CWT 规则配置数据。规则同步工具会把它与游戏 `script_documentation` 日志和原版 `common/` 对比；打包时使用其中的 `config/` 目录作为 fallback 规则包来源。

##### 📦 插件打包
生成的 VSIX 会包含自包含的 `win-x64`、`linux-x64` 和 `osx-x64` 服务端。
根目录 npm 打包命令会调用 `package.ps1`，因此请先完成上述首次克隆准备，
然后在仓库根目录使用 Windows PowerShell 执行：

```bash
npm run pack         # 完整打包
npm run pack:install # 打包并安装到本机 VS Code
npm run pack:quick   # 跳过服务端重编译，快速打包并安装
```

`pack:quick` 会复用现有服务端二进制；如果 `release/bin/server/` 尚无完整产物，
它不适合首次打包。`pack:install` 和 `pack:quick` 还要求 VS Code 的 `code`
命令已加入 `PATH`。打包成功后，产物位于
`release/eddy-stellaris-cwt-<version>.vsix`。

`npm run build:docs` 会校验单一双语主文档，并从本 README 生成
`release/README.md`。完整打包流程见
[.agents/workflows/package.md](https://github.com/Aa728848/cwtools-vscode/blob/master/.agents/workflows/package.md)，也可以直接使用
`package.ps1`。

---

#### 🤝 开源协议
本项目采用 [MIT 许可证](LICENSE) 分发。特别感谢 [CWTools](https://github.com/cwtools) 开源项目以及所有为 Paradox Modding 生态做出贡献的开发者们！
