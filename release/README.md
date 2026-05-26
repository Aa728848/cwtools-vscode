# 🌌 Eddy's Stellaris CWTools

[![Built with F#](https://img.shields.io/badge/backend-F%23%20%2F%20.NET%209-blue.svg?style=flat-square)](https://dotnet.microsoft.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square)]()

**Eddy's Stellaris CWTools** 是专为 Paradox 游戏 Modding（以 **Stellaris (群星)** 为核心）打造的顶级、现代化集成开发环境（IDE）级 VS Code 扩展。它基于上游的 [CWTools](https://github.com/cwtools/cwtools-vscode) 进行了深度的重构与定制开发，融合了**超高性能的 .NET 9 后端**、**极富表现力的 Webview 沙盒可视化引擎**，以及**前沿的自主多 Agent AI 协处理器**。

> [!NOTE]
> 本项目不仅是一个语法高亮与校验工具，而是一个集成了 3D 渲染、实时 GUI 画布、多 Agent 并行流水线及高精密迁移对比的**现代化 Mod 协同开发中枢**。

---

## 🚀 核心技术四大支柱

### ⚡ 1. 超高性能语言服务引擎 (High-Performance LSP)
基于 **.NET 9** 和 **F#** 深度定制的 CWTools LSP 服务端，作为整个插件的计算底座，为庞大的 Mod 代码提供了毫秒级的极致响应。
- **极致的并发性能**：重构了 `LanguageServer` 读写锁机制，只读请求（如悬浮预览、自动补全、跳转定义）多线程共享并发执行；变更写入操作（如文件修改）持独占锁串行执行，彻底告别慢查询导致的死锁或界面卡顿。
- **O(1) 定位查找**：`DocumentStore` 摒弃了传统的 $O(N)$ 遍历，采用**惰性重建行偏移缓存**技术，将 Hover 和 Go-To-Definition 的查找时间直接压缩至 $O(1)$，对拥有数十万行代码的超大型 Mod 文件实现即时定位。
- **语义校验与宏求值**：支持深度语法分析，甚至能对复杂的宏表达式 `@[...]` 以及 `value:xxx|` 进行实时求值，在编辑器行内无缝显示本地化文本（CodeLens）及 `inline_script` 文件悬浮预览。

### 🎨 2. 沙盒化多维 Webview 可视化引擎 (Rich Visualization)
本项目深度利用了 VS Code Webview 隔离沙盒，基于现代 Web 渲染技术（Canvas / Cytoscape.js / Three.js），为 Mod 开发者带来了前所未有的所见即所得体验。
- **GUI Canvas 实时预览与编辑**：支持群星 `.gui` 文件的实时双向交互渲染。完美实现 `corneredTileSpriteType` 9-切片拉伸绘制、多帧精灵（`noOfFrames`）动画循环，支持可视化图层树和直接在画布上**拖拽调整控件尺寸及坐标并回写源码**。
- **3D 恒星系渲染与轨道编辑**：进入 `solar_system_initializers/` 脚本，即可开启精美的 3D 星系空间。支持恒星、行星、卫星、环形世界（Ring World）的任意递归嵌套。开发者可以通过直接拖动行星改变其 `orbit_distance` 与 `orbit_angle` 并自动同步至脚本。
- **科技树与事件引用网络**：利用 Cytoscape.js 渲染高交互性的科技依赖图与事件链流向图。支持快速检索、关系筛选及点击节点瞬间定位至对应的 `.txt` 脚本源码行。
- **Three.js 实体与动画渲染**：支持 Paradox 原生 `.asset` 三维网格、贴图及骨骼动画在 Webview 中的沙盒化加载与动作调试。

### 🤖 3. 全自主多 Agent AI 协处理器 (Advanced AI System)
这是本插件最引以为傲的革新性子系统。不同于普通的单轮对话 AI，我们内置了一个由多 Agent 编排的高阶推理运行器。
- **Build / Review 双工作模式**：
  - **Build 模式**：允许 AI 自动生成代码、读写文件、操作共享本地化索引并运行本地验证套件。
  - **Review 模式**：独立安全的只读审查环境，禁用任何写入特权，专为强制校验代码规范、防御逻辑漏洞和越界覆盖而设计。
- **Sub-Agent 并行编排 (DAG)**：底层推理流基于拓扑排序任务图，通过 `Promise.allSettled` 并行调度多个专职子 Agent（如 Explorer, Builder, LocWriter, Reviewer），在**共享黑板 (Blackboard)** 上协同编写复杂的功能，速度相比单链 Agent 提升数倍。
- **防循环与智能压缩 (Context Smart Windowing)**：内置两阶段 "Doom-Loop" 循环调用防御机制；当长对话 Token 消耗接近上限的 70% 时，将自动触发 LLM 级别的结构化记忆压缩，并对孤儿 Tool Call 智能补齐，确保长任务的高成功率。
- **MCP & 全工作区本地化索引**：集成 **Model Context Protocol**（同时支持 stdio 与 SSE 传输），全工作区本地化 YML 文本基于后台 `FileSystemWatcher` 异步实时增量索引，为大模型源源不断地输送稳定、精准的项目上下文。

### 📂 4. 原版对比与极速迁移通道 (Vanilla Compare & Sync)
处理巨型 Mod 升级与适配 Paradox 官方版本更新的利器。
- **块级无缝对比**：支持在脚本中一键开启与原版（Vanilla）对应文件的 Diff 视图。
- **自底向上安全合并**：支持光标所在块的“一键迁移同步”（`migrateBlockFromVanilla`），底层迁移算法采用**从后往前（自底向上）**的替换策略，保证前端行号修改不会导致上方偏移失效，极速适配版本变动。

---

## 🏛️ 系统架构全景图

以下为项目的整体模块交互与数据流拓扑，清晰展现了各层级之间的隔离屏障与通信管道：

```mermaid
flowchart LR
    %% 前端沙盒层
    subgraph Webview ["Webview 隔离前端 (HTML / JS / Three.js)"]
        UI["智能对话 & 任务看板\nchatPanel.ts"]
        Canvas["GUI 实时画布预览\nguiPreview.ts"]
        TD3D["星系/实体 3D 渲染\nentityPreview.ts"]
        Graph["科技/事件依赖拓扑\ntechTreePreview.ts"]
    end

    %% VS Code 宿主层
    subgraph VSCode ["VS Code 扩展宿主 (运行中枢与 AI 协处理器)"]
        Extension["命令注册与激活\nextension.ts"]
        GP["游戏 Profile 注册\ngameProfiles.ts"]
        IDX["本地化与全局索引\nIndexService.ts"]
        AI["多 Agent 协同核心\nagentRunner.ts"]
        Queue["安全锁写入队列\nPartitionedWriteQueue"]
    end

    %% .NET 编译器后端
    subgraph Backend [".NET 9 / F# 编译器后端"]
        LSP["LSP 极速解析器\nsrc/Main.exe"]
        Lib["CWTools F# 解析库\nsubmodules/cwtools"]
    end

    %% 前端与宿主双向事件管道
    UI <-->|postMessage 事件流| Extension
    Canvas <-->|postMessage 事件流| Extension
    TD3D <-->|postMessage 事件流| Extension
    Graph <-->|postMessage 事件流| Extension

    %% 宿主内部协同
    Extension --> GP
    Extension --> IDX
    Extension --> AI
    AI --> IDX
    AI --> Queue
    Queue -->|顺序写入锁保护| IDX

    %% 宿主与后端语言服务通信
    Extension <-->|LSP JSON-RPC 通信| LSP
    LSP --> Lib

    %% 样式表定制
    classDef vscode fill:#1e1e24,stroke:#007acc,stroke-width:2px,color:#fff;
    classDef webview fill:#2d2d30,stroke:#2b8a3e,stroke-width:2px,color:#fff;
    classDef backend fill:#171717,stroke:#512bd4,stroke-width:2px,color:#fff;
    class VSCode,Extension,GP,IDX,AI,Queue vscode;
    class Webview,UI,Canvas,TD3D,Graph webview;
    class Backend,LSP,Lib backend;
```

---

## ⚙️ 极速安装与开始

### 运行要求
- **操作系统**：Windows / macOS / Linux
- **VS Code 版本**：1.85.0 或更高版本
- **.NET 运行时**：本地开发编译需要安装 [.NET 9.0 SDK](https://dotnet.microsoft.com/download/dotnet/9.0)

### 安装步骤
1. 在 Release 页面下载最新的 `.vsix` 打包文件。
2. 打开 VS Code，按下 `Ctrl+Shift+P` (macOS 下为 `Cmd+Shift+P`)，输入并选择 `Extensions: Install from VSIX...`，选择下载的 VSIX 文件完成安装。
3. 首次激活插件时，系统会弹出通知提示您选择**原版游戏安装目录**以构建初次语言服务器缓存，完成配置后即可开启极速开发之旅。

---

## 💡 主要功能使用指引 (Feature Guide)

为了让您能够快速上手这套极具表现力的 IDE 开发工具链，我们为您整理了如下核心功能的使用指引：

### 🎨 1. GUI 实时画布预览与拖拽同步编辑
* **如何打开**：在 VS Code 中打开任意 `.gui` 界面配置文件，点击右上角编辑器工具栏的 **画板图标 (Preview GUI)**。
* **同步操作**：
  - 双列网格属性面板将呈现在右侧，支持 DDS/TGA 贴图自动检索与解码显示。
  - 您可以直接在画布中点击选中控件并进行**拖拽缩放或平移位置**，底层的 AST 重构算法会即时重组代码并自动写回左侧的 `.gui` 源代码文件中。
  - 支持 `Ctrl+Z` 随时撤销画布和属性更改，提供所见即所得的极速开发体验。

### 🌌 2. 3D 恒星系交互编辑器 (3D Solar System)
* **如何打开**：在 `solar_system_initializers/` 目录下的星系初始化 `.txt` 脚本中，点击编辑器标题栏的 **望远镜图标 (Preview Solar System)**。
* **三维交互**：
  - 视图支持鼠标滚轮缩放、右键平移和 `Alt+拖拽` 进行多维度视角旋转。
  - 在**编辑模式**下，您可以通过右键菜单直接创建恒星、行星、卫星以及 Ring World。
  - 用鼠标**直接在 3D 轨道上拖拽行星**修改其轨道距离和角度，对应的 `orbit_distance` 与 `orbit_angle` 参数会同步写回至编辑器内的 Paradox 脚本。

### 🌐 3. 科技树与事件引用网络 (Dependency Graph)
* **如何打开**：在科技或事件定义脚本中，点击右上角的 **依赖图图标 (Show Dependency Graph)**。
* **交互导航**：
  - 底层基于 Cytoscape.js 渲染高表现力的连线节点拓扑，直观呈现复杂科技前置要求或事件的多级触发链。
  - 完美支持搜索框快速过滤、层级限制与节点高亮。**双击任意节点**，编辑器将自动跳转并精准高亮至其声明所在的源文件代码行。

### 🤖 4. 全自主多 Agent AI 开发面板 (Autonomous AI)
* **如何打开**：点击侧边栏的 **AI 图标**，或按快捷键 `Ctrl+Shift+P` 搜索并执行 `AI: Open Chat Panel` 开启会话。
* **全局快捷键**：
  - `Tab`：快捷切换Agent模式，支持构建、计划、分析、审查、协调，通用，六大基础模式一键切换。
* **特性操作**：会话支持完整的上下文压缩（超过 70% 时自动生成紧凑记忆）以及一键无损导入导出完整
运行步骤的 JSON 归档。

### 📂 5. 原版对比与块级安全合并 (Vanilla Sync)
* **一键对比**：插件激活后，当您编辑的 Mod 文件与原版游戏文件同名时，点击行上方的 CodeLens **Compare with Vanilla** 打开分屏 Diff。
* **安全替换**：如果需要提取原版官方代码段，点击代码块上方出现的 **Migrate Block from Vanilla**。系统将锁定并发队列，自底向上智能应用合并，防止因前端坐标更改导致后续块偏移失效。

### 💎 6. Asset 资产与 3D Mesh 实体动画调试器 (Asset & Mesh Previewer)
* **如何打开**：在 VS Code 中打开 `.asset` 实体配置文件或 `.gfx` 图形定义文件，点击右上角编辑器工具栏的 **3D 模型图标 (Preview Entity)**。
* **3D 网格与材质调试**：
  - 底层基于 Three.js 实现 Paradox 专有 3D 网格模型文件（`.mesh`）的极速沙盒化解析与三维渲染。
  - 自动根据配置搜寻、加载并解码 DDS 格式的材质贴图，提供高保真的光照着色预览。
* **骨骼动画微调**：
  - 完美解析绑定的骨骼节点树，支持在右侧控制台中实时挑选、播放不同的骨骼动画序列（如移动、待机、战斗）。
  - 支持材质属性（如漫反射、高光强度）在侧边栏面板上的动态滑块调节与实时重绘调试。

---

## 🛠️ 开发者指南 (Developer Hub)

如果您有志于为本项目贡献代码，或者需要使用 AI 助手进行二次开发，请务必遵循以下工作流：

### 常用构建与验证命令
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
```

### 📦 插件打包
如需将插件打包为跨平台的通用发布版本，请在 `release/` 目录中运行：
```bash
npx @vscode/vsce package
```
> [!IMPORTANT]
> 打包具体步骤请参阅 [.agents/workflows/package.md](file:///c:/Users/A/Documents/cwtools-vscode/.agents/workflows/package.md)，也可以使用 `package.ps1` 进行打包。

---

## 🤝 开源协议
本项目采用 [MIT 许可证](LICENSE) 分发。特别感谢 [CWTools](https://github.com/cwtools) 开源项目以及所有为 Paradox Modding 生态做出贡献的开发者们！
