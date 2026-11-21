# Stellaris Language Serves

[English](#english) | [中文](#zh-cn) | [GitHub](https://github.com/Aa728848/cwtools-vscode) | [Report an issue](https://github.com/Aa728848/cwtools-vscode/issues)

<a id="english"></a>

## English

Build and maintain Paradox mods in VS Code with CWTools language support, Stellaris visual editors, vanilla comparison, Shader tooling, and an optional AI workspace.

### Start here

After installing the extension, open your mod folder in VS Code. On first use, select the vanilla game folder when prompted. CWTools loads the project and builds the indexes used by diagnostics, completion, navigation, and previews.

The extension package includes the language-server binaries for Windows, macOS, and Linux. You do not need a separate .NET installation to use the packaged extension.

### Language support

- Diagnostics, completion, hover information (including reverse-engineered Stellaris engine cost and hardcoded-behaviour notes), definitions, references, symbols, CodeLens, and inlay hints
- Paradox script, localisation, assets, GUI files, compile-unit-aware `.shader` / `.fxh` editing, and dedicated `.cwt` rule-file support (diagnostics, completion, navigation, safe hot-swap, and CWT-only mode without a game install)
- Profiles for Stellaris, Hearts of Iron IV, Europa Universalis IV and V, Crusader Kings II and III, Imperator: Rome, Victoria II and 3, and custom CWT projects
- Aura tooltip localisation for `friendly_aura` / `hostile_aura` blocks in `common/component_templates`, generated from their modifiers and `damage_per_day`
- Incremental project and vanilla indexes for larger workspaces

Coverage depends on the active game profile and its CWT rules. Stellaris is the primary target for the bundled rules and visual tools.

### Stellaris visual tools

Open a supported file and use its editor-title action or context menu:

- GUI canvas with selection, positioning, resizing, texture lookup, and source write-back
- Global ship design workbench for `common/global_ship_designs/*.txt` with locator-based 3D assembly, slot and required-component editing (click-to-place, drag-and-drop, Fill all), a filtered component library, Host-owned drafts, and offline loadout generation
- 3D solar-system preview with orbit editing
- Static-galaxy preview with system, nebula, coordinate, and explicit-hyperlane editing
- Technology-tree and event-chain graphs
- Entity, material, animation, and particle previews
- Weapon targeting-weight analysis and ship top-icon DDS sheet generation from `.mesh` models

Source changes use VS Code workspace edits and can be undone normally. Previews distinguish source-backed data from estimates; runtime-generated content is not presented as exact file data.

### Vanilla comparison and Steam Workshop

Use **Compare File with Vanilla** from the editor title bar or **Compare Block with Vanilla** from the editor context menu on a matching mod file to open a diff. **Migrate Block from Vanilla** replaces the block under the cursor, and **Migrate Changed Blocks from Vanilla** lets you batch-migrate selected blocks from the diff view.

Run **Upload Mod to Steam Workshop** inside a mod workspace (containing `descriptor.mod`) to create or update a Workshop item with tags, preview image, visibility, change note, and `.gitignore`/`.steamignore` staging filters. Requires the Steam client running and signed in to an account that owns the game.

### Optional AI workspace

Run **Stellaris AI: Open AI Chat** from the Command Palette (or **Stellaris AI: Open Agent Manager** for the detached manager) to use the built-in Paradox/CWTools-focused single-agent workspace. It supports semantic script/rule queries, project indexing, plans and Agent skills, `EvidenceGate` semantic prechecks, `confirm` / `auto` file-write controls, and optional MCP servers. The detached Agent Manager also includes a `.gui` **Preview** tab with structured element selection into chat and up to two rounds of automatic Before/After/Diff visual verification after GUI edits.

AI providers are configured separately. Credentials are stored with VS Code SecretStorage, and subscription lines (Codex, Claude, Kimi Code, MiniMax Code, Command Code, WorkBuddy, and OpenDesign) share a multi-account rotation pool with rate-limit failover and quota meters. The ChatGPT-subscription-compatible Codex provider relies on an upstream compatibility endpoint and may need updates when that endpoint changes.

Subscription providers share **AI Settings → Subscription channel proxy**: auto detection, custom HTTP/HTTPS/SOCKS5 proxy, or direct connection. Click **Save proxy** before signing in or testing. Proxy credentials are stored in VS Code SecretStorage. This covers token exchange and refresh, account queries, and chat; browser sign-in follows browser proxy settings.

### External agents through MCP

The separately released [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) package gives MCP clients CWTools semantic queries and six default-on whitelisted domain-write tools. It normally connects to the active extension instead of starting another language server.

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
```

```sh
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

### Documentation

- [Project README](https://github.com/Aa728848/cwtools-vscode#readme)
- [CWT rule guide](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md)
- [Diagnostic code reference](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/diagnostic-codes.md)
- [Contribution guide](https://github.com/Aa728848/cwtools-vscode/blob/master/CONTRIBUTING.md)

If something behaves unexpectedly, please include the game profile, extension version, relevant file type, and reproducible steps in a [GitHub issue](https://github.com/Aa728848/cwtools-vscode/issues).

---

<a id="zh-cn"></a>

## 中文

在 VS Code 中使用 CWTools 语言服务开发 Paradox Mod，并按需使用 Stellaris 可视化编辑器、原版对比、Shader 工具和 AI 工作区。

### 开始使用

安装扩展后，把 Mod 文件夹作为 VS Code 工作区打开。首次使用时，请按提示选择原版游戏目录。CWTools 会加载项目，并建立诊断、补全、跳转和预览所需的索引。

扩展包已经包含 Windows、macOS 和 Linux 的语言服务端。正常使用已安装的扩展不需要另外安装 .NET。

### 语言服务

- 诊断、补全、悬停信息（含 Stellaris 反编译引擎开销与硬编码行为说明）、定义、引用、符号、CodeLens 和嵌入提示
- Paradox 脚本、本地化、资产、GUI、按真实编译单元工作的 `.shader` / `.fxh` 编辑，以及独立的 `.cwt` 规则语言支持（诊断、补全、跳转、安全热替换与无需游戏安装的 CWT-only 模式）
- 支持 Stellaris、Hearts of Iron IV、Europa Universalis IV 和 V、Crusader Kings II 和 III、Imperator: Rome、Victoria II 和 3，以及自定义 CWT 项目
- 按 `common/component_templates` 中 `friendly_aura` / `hostile_aura` 的 modifier 与 `damage_per_day` 自动生成光环 Tooltip 本地化
- 面向大型工作区的项目与原版增量索引

具体覆盖范围取决于当前游戏 Profile 及其 CWT 规则。随扩展提供的规则和可视化工具主要面向 Stellaris。

### Stellaris 可视化工具

打开受支持的文件，再使用编辑器标题栏按钮或右键菜单：

- GUI 画布：选择、定位、缩放控件，查找贴图并写回源码
- 全局舰船设计工作台（`common/global_ship_designs/*.txt`）：基于真实 locator 的 3D 组装、槽位与必需部件编辑（点击放置、拖放与填充全部）、可筛选组件库、Host 草稿与离线配装生成
- 3D 恒星系预览和轨道编辑
- 静态银河预览，以及星系、星云、坐标和显式超空间航道编辑
- 科技树与事件链关系图
- 实体、材质、动画和粒子预览
- 武器索敌权重分析，以及从 `.mesh` 模型生成舰船顶部图标 DDS 表

源码修改使用 VS Code 工作区编辑，可以正常撤销。预览会区分源码数据和估算结果，不会把运行时生成的内容当作文件中的精确数据。

### 原版对比与 Steam 创意工坊

在有原版对应文件的 Mod 文件中，使用编辑器标题栏的 **与原版对比文件** 或右键菜单中的 **与原版对比代码块** 打开差异视图。**从原版迁移当前代码块** 只替换光标所在代码块，在差异视图中还可用 **从原版迁移所有变更块** 批量勾选迁移。

在 Mod 工作区（包含 `descriptor.mod`）运行 **上传 Mod 到 Steam 创意工坊**，可新建或更新工坊物品，支持标签、预览图、可见性、更新说明以及基于 `.gitignore`/`.steamignore` 的暂存过滤（需 Steam 客户端已运行并登录拥有该游戏的账号）。

### 可选 AI 工作区

从命令面板运行 **Stellaris AI: 打开 AI 对话面板**（或 **Stellaris AI: 打开 Agent 运行管理器** 打开独立管理器）以使用专注于 Paradox/CWTools 语义领域的内置单 Agent 工作区。它提供语义脚本与规则查询、项目索引、计划和 Agent 技能、`EvidenceGate` 语义预检、`confirm` / `auto` 文件写入控制，以及可选 MCP 服务。独立 Agent 管理器还提供 `.gui` **预览**页，支持框选/多选元素加入对话，并在 GUI 写入后自动执行最多两轮 Before/After/Diff 视觉核对。

AI Provider 需要单独配置。凭据通过 VS Code SecretStorage 保存，订阅线路（Codex、Claude、Kimi Code、MiniMax Code、Command Code、WorkBuddy 与 OpenDesign）共享支持限流自动切号与额度仪表的多账号号池。兼容 ChatGPT 订阅的 Codex Provider 依赖上游兼容端点；上游变化时，扩展可能需要同步更新。

订阅供应商共用 **AI 设置 → 订阅渠道代理**，支持自动检测、自定义 HTTP/HTTPS/SOCKS5 代理和直连。登录或测试前点击 **保存代理**。代理凭据保存在 VS Code SecretStorage，覆盖令牌交换与刷新、账户查询及聊天；浏览器登录页面遵循浏览器代理设置。

### 通过 MCP 连接外部 Agent

独立发布的 [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) 为 MCP 客户端提供 CWTools 语义查询和六个默认开启的白名单领域写入工具。它通常会连接当前已激活的扩展，而不是再次启动语言服务。

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
```

```sh
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

### 文档与反馈

- [项目 README](https://github.com/Aa728848/cwtools-vscode#readme)
- [CWT 规则指南](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md)
- [诊断码速查](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/diagnostic-codes.md)
- [贡献指南](https://github.com/Aa728848/cwtools-vscode/blob/master/CONTRIBUTING.md)

如果遇到问题，请在 [GitHub issue](https://github.com/Aa728848/cwtools-vscode/issues) 中附上游戏 Profile、扩展版本、相关文件类型和可复现步骤。
