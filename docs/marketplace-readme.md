# Stellaris Language Serves

[English](#english) | [中文](#zh-cn) | [GitHub](https://github.com/Aa728848/cwtools-vscode) | [Report an issue](https://github.com/Aa728848/cwtools-vscode/issues)

<a id="english"></a>

## English

Build and maintain Paradox mods in VS Code with CWTools language support, Stellaris visual editors, vanilla comparison, Shader tooling, Steam Workshop upload,.

### Start here

Open your mod folder in VS Code and select the vanilla game folder when prompted. CWTools builds the initial project and vanilla indexes used by diagnostics, completion, navigation, and previews.

Language-server binaries for Windows, macOS, and Linux are bundled in the extension; no separate .NET installation is required.

### Language support

- Diagnostics, completion, hover information (including reverse-engineered Stellaris engine cost and hardcoded-behaviour notes), definitions, references, symbols, CodeLens, and inlay hints.
- Paradox script, localisation, assets, GUI files, compile-unit-aware `.shader` / `.fxh` editing, and dedicated `.cwt` rule support (diagnostics, completion, cross-file navigation, validated hot-swap, and CWT-only mode without a game install).
- Profiles for Stellaris, Hearts of Iron IV, Europa Universalis IV and V, Crusader Kings II and III, Imperator: Rome, Victoria II and 3, and custom CWT projects.
- Aura tooltip localisation generator for `friendly_aura` / `hostile_aura` blocks in `common/component_templates`.
- Incremental workspace and vanilla indexes for large mods.

Coverage depends on the active game profile and its CWT rules. Bundled rules and visual tools primarily target Stellaris.

### Stellaris visual tools

Open a supported file and use its editor-title action or context menu:

- **GUI Editor**: canvas selection, positioning, resizing, texture lookup, and source write-back.
- **Global Ship Design Workbench** (`common/global_ship_designs/*.txt`): locator-based 3D assembly, slot and core-component editing, filtered component library, Host-owned drafts, and offline loadout generation.
- **3D Solar System Preview**: interactive star/planet layout and orbit editing.
- **Static Galaxy Preview**: system, nebula, coordinate, and explicit-hyperlane editing.
- **Dependency Graphs**: technology-tree and event-chain visualizations.
- **Asset Previews**: entity, material, animation, and particle viewers.
- **Combat & Icon Tools**: weapon targeting-weight analysis and ship top-icon DDS sheet generation from `.mesh` models.

All source edits use VS Code workspace edits and support standard undo/redo. Previews clearly separate source-backed data from runtime approximations.

### Vanilla comparison and Steam Workshop

- **Compare & Migrate**: run **Compare File with Vanilla** or **Compare Block with Vanilla** to diff against vanilla counterparts, then migrate individual or selected blocks cleanly.
- **Steam Workshop**: run **Upload Mod to Steam Workshop** inside a workspace with `descriptor.mod` to create or update a Workshop item with tags, preview image, visibility, change notes, and `.gitignore`/`.steamignore` staging filters (requires the Steam client running and signed in).

### External agents via MCP

The extension has no built-in Agent. The separately released [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) package and DSH native plugin provide shared Paradox semantics, project initialization, whitelisted domain writes, skills, and host-side GUI evidence to external agents. Use Bridge mode to reuse the active VS Code host, or Standalone mode for an independent CWTools LSP.

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

### Documentation

- [Project README](https://github.com/Aa728848/cwtools-vscode#readme)
- [CWT rule guide](https://github.com/Aa728848/cwtools-vscode/blob/main/docs/cwt-rule-config.md)
- [Diagnostic code reference](https://github.com/Aa728848/cwtools-vscode/blob/main/docs/diagnostic-codes.md)
- [Contribution guide](https://github.com/Aa728848/cwtools-vscode/blob/main/CONTRIBUTING.md)

When reporting an issue on [GitHub](https://github.com/Aa728848/cwtools-vscode/issues), please include the game profile, extension version, file type, and reproduction steps.

---

<a id="zh-cn"></a>

## 中文

在 VS Code 中使用 CWTools 语言服务开发与维护 Paradox Mod，并集成 Stellaris 可视化编辑器、原版对比、Shader 支持、Steam 创意工坊上传与可选 AI 工作区。

### 开始使用

打开 Mod 文件夹，首次按提示选择原版游戏目录即可。CWTools 会自动建立诊断、补全、跳转和预览所需的项目与原版索引。

扩展包已内置 Windows、macOS 和 Linux 平台语言服务端，正常使用无需额外安装 .NET。

### 语言服务

- 诊断、补全、悬停信息（含 Stellaris 反编译引擎开销与硬编码行为说明）、定义、引用、符号、CodeLens 与嵌入提示。
- Paradox 脚本、本地化、资产、GUI、按真实编译单元分析的 `.shader` / `.fxh` 编辑，以及独立的 `.cwt` 规则语言支持（诊断、补全、跨文件跳转、安全热替换与无需游戏安装的 CWT-only 模式）。
- 支持 Stellaris、Hearts of Iron IV、Europa Universalis IV / V、Crusader Kings II / III、Imperator: Rome、Victoria II / 3 与自定义 CWT 项目。
- 针对 `common/component_templates` 中 `friendly_aura` / `hostile_aura` 块的光环 Tooltip 本地化生成。
- 面向大型 Mod 的项目与原版增量索引。

具体覆盖范围取决于当前游戏 Profile 与 CWT 规则。随扩展提供的规则与可视化工具主要面向 Stellaris。

### Stellaris 可视化工具

打开受支持的文件，通过编辑器标题栏按钮或右键菜单启动：

- **GUI 编辑器**：画布选择、定位、缩放、贴图查找与源码写回。
- **全局舰船设计工作台**（`common/global_ship_designs/*.txt`）：基于真实 locator 的 3D 组装、槽位与核心组件编辑、可筛选组件库、Host 草稿管理与离线配装生成。
- **3D 恒星系预览**：交互式星系布局与轨道编辑。
- **静态银河预览**：星系、星云、坐标与显式超空间航道编辑。
- **依赖关系图**：科技树与事件链可视化。
- **资产预览**：实体、材质、动画与粒子查看器。
- **战斗与图标工具**：武器索敌权重分析，以及从 `.mesh` 模型生成舰船顶部图标 DDS 表。

所有源码修改均通过 VS Code 工作区编辑写回并支持常规撤销。预览会明确区分源码数据与运行时近似估算。

### 原版对比与 Steam 创意工坊

- **对比与迁移**：通过 **与原版对比文件** 或 **与原版对比代码块** 打开差异视图，并按块或批量迁移原版内容。
- **Steam 创意工坊**：在包含 `descriptor.mod` 的工作区运行 **上传 Mod 到 Steam 创意工坊**，可新建或更新物品，支持标签、预览图、可见性、更新说明以及 `.gitignore`/`.steamignore` 过滤（需 Steam 客户端已运行并登录）。

### 通过 MCP 连接外部 Agent

扩展不再内置 Agent。独立发布的 [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) 与 DSH 原生插件为外部 Agent 提供共享 Paradox 语义、项目初始化、白名单领域写入、技能和宿主 GUI 证据。Bridge 模式复用当前 VS Code 宿主，Standalone 模式启动独立 CWTools LSP。

```sh
codex mcp add cwtools -- npx -y cwtools-mcp --stdio
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

### 文档与反馈

- [项目 README](https://github.com/Aa728848/cwtools-vscode#readme)
- [CWT 规则指南](https://github.com/Aa728848/cwtools-vscode/blob/main/docs/cwt-rule-config.md)
- [诊断码速查](https://github.com/Aa728848/cwtools-vscode/blob/main/docs/diagnostic-codes.md)
- [贡献指南](https://github.com/Aa728848/cwtools-vscode/blob/main/CONTRIBUTING.md)

反馈问题请在 [GitHub issue](https://github.com/Aa728848/cwtools-vscode/issues) 附上游戏 Profile、扩展版本、文件类型与复现步骤。
