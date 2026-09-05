# Stellaris Language Serves

[English](#english) | [中文](#zh-cn) | [GitHub](https://github.com/Aa728848/cwtools-vscode) | [Report an issue](https://github.com/Aa728848/cwtools-vscode/issues)

<a id="english"></a>

## English

Build and maintain Paradox mods in VS Code with CWTools language support, Stellaris visual editors, vanilla comparison, Shader tooling, and an optional AI workspace.

### Start here

After installing the extension, open your mod folder in VS Code. On first use, select the vanilla game folder when prompted. CWTools loads the project and builds the indexes used by diagnostics, completion, navigation, and previews.

The extension package includes the language-server binaries for Windows, macOS, and Linux. You do not need a separate .NET installation to use the packaged extension.

### Language support

- Diagnostics, completion, hover information, definitions, references, symbols, CodeLens, and inlay hints
- Paradox script, localisation, assets, GUI files, and compile-unit-aware `.shader` / `.fxh` editing
- Profiles for Stellaris, Hearts of Iron IV, Europa Universalis IV and V, Crusader Kings II and III, Imperator: Rome, Victoria II and 3, and custom CWT projects
- Incremental project and vanilla indexes for larger workspaces

Coverage depends on the active game profile and its CWT rules. Stellaris is the primary target for the bundled rules and visual tools.

### Stellaris visual tools

Open a supported file and use its editor-title action or context menu:

- GUI canvas with selection, positioning, resizing, texture lookup, and source write-back
- 3D solar-system preview with orbit editing
- Static-galaxy preview with system, nebula, coordinate, and explicit-hyperlane editing
- Technology-tree and event-chain graphs
- Entity, material, animation, and particle previews

Source changes use VS Code workspace edits and can be undone normally. Previews distinguish source-backed data from estimates; runtime-generated content is not presented as exact file data.

### Vanilla comparison and migration

Use `Compare with Vanilla` on a matching mod file to open a diff. `Migrate Block from Vanilla` replaces the block under the cursor without turning the whole file into a generated rewrite.

### Optional AI workspace

Run `AI: Open Chat Panel` to use the built-in agent workspace. It supports general coding and Paradox/CWTools-aware tasks, project indexing, plans and workflows, explicit tool permissions, and optional MCP servers.

AI providers are configured separately. Credentials are stored with VS Code SecretStorage, and tool calls remain subject to the selected sandbox and approval policy. The ChatGPT-subscription-compatible Codex provider relies on an upstream compatibility endpoint and may need updates when that endpoint changes.

Antigravity supports Google browser sign-in, account model and quota discovery, streaming replies, image input, and tool calls. Select it in AI Settings after completing account setup in Antigravity.

### External agents through MCP

The separately released [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) package gives MCP clients read-only access to CWTools semantic queries. It normally connects to the active extension instead of starting another language server.

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

- 诊断、补全、悬停信息、定义、引用、符号、CodeLens 和嵌入提示
- Paradox 脚本、本地化、资产、GUI，以及按真实编译单元工作的 `.shader` / `.fxh` 编辑
- 支持 Stellaris、Hearts of Iron IV、Europa Universalis IV 和 V、Crusader Kings II 和 III、Imperator: Rome、Victoria II 和 3，以及自定义 CWT 项目
- 面向大型工作区的项目与原版增量索引

具体覆盖范围取决于当前游戏 Profile 及其 CWT 规则。随扩展提供的规则和可视化工具主要面向 Stellaris。

### Stellaris 可视化工具

打开受支持的文件，再使用编辑器标题栏按钮或右键菜单：

- GUI 画布：选择、定位、缩放控件，查找贴图并写回源码
- 3D 恒星系预览和轨道编辑
- 静态银河预览，以及星系、星云、坐标和显式超空间航道编辑
- 科技树与事件链关系图
- 实体、材质、动画和粒子预览

源码修改使用 VS Code 工作区编辑，可以正常撤销。预览会区分源码数据和估算结果，不会把运行时生成的内容当作文件中的精确数据。

### 原版对比与迁移

在有原版对应文件的 Mod 文件中使用 `Compare with Vanilla` 打开差异视图。`Migrate Block from Vanilla` 只替换光标所在代码块，不会把整个文件变成一次生成式重写。

### 可选 AI 工作区

运行 `AI: Open Chat Panel` 打开内置 Agent 工作区。它可以处理通用编码或 Paradox/CWTools 任务，并提供项目索引、计划和工作流、明确的工具权限，以及可选 MCP 服务。

AI Provider 需要单独配置。凭据通过 VS Code SecretStorage 保存，工具调用仍受当前沙盒和审批策略限制。兼容 ChatGPT 订阅的 Codex Provider 依赖上游兼容端点；上游变化时，扩展可能需要同步更新。

Antigravity 支持 Google 浏览器登录、账户模型与额度查询、流式回复、图片输入和工具调用。先在 Antigravity 中完成账户设置，再到 AI 设置中选择该供应商。

### 通过 MCP 连接外部 Agent

独立发布的 [`cwtools-mcp`](https://github.com/Aa728848/cwtools-mcp) 为 MCP 客户端提供只读 CWTools 语义查询。它通常会连接当前已激活的扩展，而不是再次启动语言服务。

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
