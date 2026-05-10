---
trigger: always_on
---

# CWTools VSCode 开发规范

作为 AI 编程助手 (Antigravity)，在处理本项目（Eddy's Stellaris CWTools）时，你必须严格遵循以下开发规范：

## 0. 📖 项目理解先行
- **阅读文档**：在对项目进行任何代码或架构改动前，必须先阅读项目根目录下的 `README.md`、`ARCHITECTURE.md` 确保对项目的业务逻辑和架构有充分的理解。

## 1. 🌍 语言与本地化规范
- **UI 文本**：所有用户可见的 VS Code 界面文本（如信息提示、报错、状态栏）应当考虑中英双语兼容，核心中文文本应存放于统一文件（如 `ai/messages.ts`）。
- **Git Commit**：如果需要代表用户提供 Git 提交建议或执行提交，Commit Message 必须使用中文，并采用传统的 `type: description` 格式（例如 `feat: 新增 AI 提示词构建器`）。

## 2. 🛡️ 前后端架构与通信规范
- **Webview 沙盒隔离**：牢记 Webview 环境（如 `guiPreview.ts`、`chatPanel.ts`、`entityPreview.ts`）运行在受限的浏览器沙盒中。**绝对禁止**在 Webview 代码中引入 Node.js 原生 API（如 `fs`, `path`）或 `vscode` 模块。它们只能通过 `vscode.postMessage` 与扩展宿主 (Extension Host) 进行通信。
- **错误上报体系**：前端及扩展层禁止使用粗暴的裸 `console.error`。必须使用项目中现有的 `ErrorReporter` 进行结构化日志记录（分发 fatal/warn/debug 三个等级），确保错误能正确显示在 VS Code 输出面板中。

## 3. 🤖 AI Agent 系统维护规范
- **多文件并发安全**：当扩展或修改可能突变项目文件的 AI 工具时，任何写操作都必须挂载到 `PartitionedWriteQueue`。在多文件写入场景下，必须确保按文件路径的字典序获取写入锁，以防止 AB/BA 死锁引发文件损坏。
- **Tool 注册三位一体**：如果需要为内置 Agent 增加新 Tool，必须**同时**修改以下三个文件，缺一不可：
  1. `tools/definitions.ts` (定义 JSON Schema)
  2. `agentTools.ts` (添加执行路由映射)
  3. `types.ts` (添加 TypeScript 类型及 Args/Result 接口)
- **幻觉与死循环防御**：处理提示词（Prompt Builder）或修改 Agent 执行循环（Agent Runner）时，不得绕过现有的两阶段“Doom-Loop”检测机制。

## 4. ⚡ 3D / 渲染性能与内存规范
- **资源缓存**：针对海量 Paradox 游戏资源（如 DDS/TGA 贴图、巨大 3D 网格模型），必须利用已有的 LRU 缓存池限制内存膨胀。
- **WebGL 内存释放**：由于 VS Code 中频繁开关标签页会导致 Webview 被销毁，务必在 `dispose` 生命周期中：
  - 手动清理事件监听器。
  - 释放 WebGL Context 和 Three.js 相关资源（如 `material.dispose()`, `geometry.dispose()`）。
  - 严防对象游离导致的严重内存泄漏。

## 5. 📝 代码风格与质量
- **TypeScript 严格模式**：禁止在生产代码中滥用 `any`，必须明确接口与类型。
- **异步安全**：遵守项目根目录的 ESLint 9 配置规则，特别是关于 Promise 的规则（严禁触发 `no-floating-promises`，必须正确 `await` 或显式 `.catch`）。
- **UI 主题适配**：Webview 内的 CSS 与内联样式必须使用 VS Code 主题 CSS 变量（如 `var(--vscode-editor-background)`、`var(--vscode-button-background)`），确保在不同主题下均具备良好的可读性。

## 6. 🧪 构建与验证流程
- **编译检查**：完成 TypeScript 层面的修改后，建议指引用户或自行通过后台终端运行 `npm run compile`，验证 Extension 和 Rollup (Webview 捆绑器) 阶段的构建是否通过。
- **单元测试**：针对 Agent 核心逻辑、Diff 引擎或工具调度器修改后，应引导执行 `npm run test:unit`。
- **发布工作流**：如果涉及全局版本更新或构建分发，调用相关的 `/package` 工作流（`.agents/workflows/package.md`）。