Based on a thorough analysis of the codebase, here is the improvement plan:

---

# CWTools 改善计划

## 概述

该项目整体工程质量良好（类型严格、有 CSP 保护、有 SecretStorage），但存在三个系统性问题：**无测试覆盖**、**无激活事件限制**、**大量同步阻塞 I/O**。按优先级分三类展开。

---

## 🔴 P0 — 应立即修复

### 1. 添加 `activationEvents` 

`release/package.json` 中未定义 `activationEvents`，导致扩展在 VS Code 启动时无条件激活，即使打开纯 JavaScript 项目也会加载 LSP 服务端、AI 模块、扫描全部 YAML 文件。

**方案：** 在 `package.json` 中添加：
```json
"activationEvents": [
  "onLanguage:stellaris", "onLanguage:hoi4", "onLanguage:eu4",
  "onLanguage:ck3", "onLanguage:imperator", "onLanguage:paradox",
  "onLanguage:yaml"
]
```

### 2. 消除同步文件 I/O 阻塞

全代码库发现 ~91 处同步文件系统调用。最严重的是 `extension.ts:100-118` 的重命名回退逻辑——对 `**/*.txt` 全部文件逐行调用 `readFileSync`。对于数千文件的 Stellaris mod，这会完全阻塞扩展宿主数秒。

**方案：**
- `extension.ts` 重命名回退 → 改用 `vscode.workspace.fs.readFile()` 异步读取
- `guiPanel.ts` 的 `_buildSpriteIndex` → 改用 `fs.promises.readdir`
- `chatInit.ts` 的 25 处同步调用 → 改为异步初始化
- `ddsDecoder.ts` 纹理加载 → 保持同步但加缓存（DDS 解码必须同步）

### 3. 建立测试体系

当前仅 3 个集成测试文件，零单元测试。`extension.test.ts` 甚至包含一行无用占位断言 `assert.equal(-1, [1,2,3].indexOf(5))`。没有任何 AI 模块、解析器、工具函数的测试。

**方案：**
- 安装 `mocha` + `chai` + `nyc`（已在 `devDependencies` 中）
- 优先为以下模块编写单元测试：
  - `contextBudget.ts` — token 估算逻辑（纯函数，易测）
  - `guiParser.ts` — AST 解析（可提供 fixture 输入）
  - `ddsDecoder.ts` — DDS/TGA 解码（二进制 fixture）
  - `toolCallParser.ts` — 工具调用提取逻辑
  - `promptBuilder.ts` — 提示词构建逻辑
- 配置 `nyc` 覆盖率阈值（初期设 40%，逐步提升）
- 将 `npm test` 拆分为 `test:unit` 和 `test:integration`

### 4. 修复大量静默 catch

162 个 `catch` 块中大量为 `catch { /* ignore */ }` 模式。`lspTools.ts:733` 连续三个静默 catch 隐藏 LSP 失败。

**方案：**
- LSP 工具中的静默 catch → 添加 `outputChannel.appendLine()` 调试日志
- `extension.ts` dispose 路径 → 保持静默（资源释放不应抛错）
- `agentRunner.ts:747` 等执行路径 → 添加结构化错误记录
- 新增 ESLint 规则 `@typescript-eslint/no-empty-function`，豁免 dispose 路径

---

## 🟠 P1 — 高优先级（1-2 周内）

### 5. 建立 CI/CD 流水线

项目无 GitHub Actions、无 lint 脚本、无 typecheck 脚本。

**方案：**
- 创建 `.github/workflows/ci.yml`：
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    build:
      - npm ci
      - npm run lint        # 新增
      - npm run typecheck   # 新增
      - npm run test:unit
      - npm run compile
  ```
- 在 `package.json` 添加：
  - `"lint": "eslint client/"`
  - `"typecheck": "tsc -p tsconfig.extension.json --noEmit"`
  - `"format:check": "prettier --check client/"`
- 配置 `.prettierrc.json` 统一格式化

### 6. Webview 代码现代化

三个 Webview 文件均为单体 IIFE，最大 2412 行，混合了 DOM 操作、状态管理、消息路由、Markdown 渲染。

**方案：**
- `client/webview/chatPanel.ts` (2178 行) → 拆分为：
  - `chat/messages.ts` — 消息渲染
  - `chat/markdown.ts` — Markdown 解析
  - `chat/settings.ts` — 设置面板
  - `chat/files.ts` — 文件快照/差异视图
  - `chat/main.ts` — 主入口 + 消息路由
- `client/webview/guiPreview.ts` (2412 行) → 拆分为：
  - `gui/tree.ts` — 树形面板
  - `gui/canvas.ts` — 画布渲染
  - `gui/tooltip.ts` — 悬浮提示
  - `gui/animations.ts` — 动画逻辑
- **安全修复：** `guiPreview.ts:691-714` 的 tooltip `innerHTML` 需添加 `escapeHtml()` 包裹用户数据
- **安全修复：** `guiParser.ts:281` 和 `solarSystemParser.ts:297` 的 `new Function()` 替换为 `mathjs.evaluate()` 或安全表达式解析器

### 7. 添加遥测/错误报告

当前无任何遥测，`console.log` 仅 4 处，用户不可见。

**方案：**
- 引入 VS Code 官方 `@vscode/extension-telemetry` 包（或 Sentry）
- 记录关键事件：extension 激活、AI 调用、LSP 错误、大文件打开
- 用结构化日志替换 `console.log`（添加时间戳、级别、模块标识）
- 为 AI 调用记录请求/响应元数据（不含内容）以追踪成本
- **注意：** 需在 `package.json` 中声明 `"telemetry"` 字段并在 README 披露

### 8. 大工作区性能优化

多处全量工作区扫描无分页/限流。

**方案：**
- `locDecorations.performInitialScan()` → 分批处理 + 延迟加载（仅扫描可见文件）
- `chatInit.ts` 的目录扫描 → 限制扫描深度和文件数，优先缓存
- `guiPanel._buildSpriteIndex()` → 渐进式构建 + 文件系统 Watcher 增量更新
- 大文件（>500KB）跳过全文读取，仅索引元数据

### 9. 开启 `noUncheckedIndexedAccess` 

当前关闭，导致 `toolCalls[i]` 等数组访问无 `undefined` 检查。

**方案：**
- 在 `tsconfig.extension.json` 启用 `noUncheckedIndexedAccess: true`
- 逐一修复 TypeScript 错误（估计 50-100 处，主要在 AI 模块）
- 此过程约需 2-3 天工作量，但能防止大量运行时 `Cannot read property of undefined`

### 10. MCP 环境变量泄漏

`mcpClient.ts:42` 将 `process.env` 完整传递给 MCP 子进程。

**方案：**
- 改为白名单方式，仅传递 MCP 所需的环境变量
- 过滤掉 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD` 等敏感前缀

---

## 🟡 P2 — 中优先级（1-2 个月内）

### 11. God Object 重构

超过 1000 行的核心文件需要职责分离：

| 文件 | 行数 | 重构方向 |
|------|------|----------|
| `aiService.ts` | 1153 | 拆分为 `KeyManager` + `ProviderClient` (每个 provider 一个文件) + `StreamHandler` |
| `chatPanel.ts` | 1096 | 拆分为 `MessageRouter` + `SettingsSync` + `DiffRenderer` + `PlanParser` |
| `agentRunner.ts` | 1095 | 提取 `LoopController`、`ContextCompactor`、`ToolResultParser` |
| `solarSystemPanel.ts` | 1101 | 拆出 `SceneRenderer`、`UIInteractionHandler`、`DataTransformer` |
| `ai/tools/lspTools.ts` | 1003 | 拆分为 `hoverTool`、`completeTool`、`defineTool`、`queryTool` 独立文件 |
| `ai/types.ts` | 761 | 按域拆分：`agent-types.ts`、`tool-types.ts`、`chat-types.ts`、`provider-types.ts` |

### 12. 缓存策略增强

**方案：**
- 纹理缓存改用 `lru-cache` npm 包替代手动 Map 驱逐（更精确的 LRU 语义）
- 添加 LSP 结果的进程内缓存（带 TTL），减少服务端往返
- 添加 AI 文件读取的短期缓存（同一次 agent 循环内不重复读同一文件）
- 考虑将定位索引缓存写入 `globalState` 持久化，加速冷启动

### 13. 移除死代码和弃用函数

- `agentRunner.ts:123-129` 孤立数组 → 删除
- `ddsDecoder.ts:646` `ddsToDataUri` → 删除
- `promptBuilder.ts:614` `buildSystemPrompt` → 删除或设为私有
- `fileTools.ts:944` `generateSimpleDiff` → 删除
- `fileExplorer.ts:157-159` 注释代码块 → 删除

### 14. 类型安全加固

- 将 ESLint `no-floating-promises` 从 `warn` 改为 `error`
- 逐步减少 62 处 `as any` 强制转换
- `ai/types.ts` 的 `WebViewMessage` 联合类型（87 行）改用 Zod 或类型守卫验证
- Webview 消息接收端添加运行时 schema 验证

### 15. 依赖管理

- `merge-images@1.2.0` → 替换或升级（2019 年后未维护）
- `popper.js@^1.16.1` → 升级到 v2
- `cytoscape-elk` GitHub URL 依赖 → 固定到具体 commit hash
- `@types/vscode@^1.83.0` → 升级到 `^1.90.0` 匹配引擎版本
- 配置 Dependabot 自动更新

### 16. 定价表自动化

`pricing.ts` 硬编码 20+ 模型价格，标注 "verified 2026-04"。数月后即失效。

**方案：**
- 将定价数据移至外部 JSON/CSV 文件，通过 GitHub Releases 或远程 API 获取最新价格
- 添加 "更新定价数据" 命令供用户手动刷新
- 对未知模型使用用户可配置的默认价格替代 `[0, 0]`

### 17. 其他改进

- 合并/去重 `.yml` 文件的多个 `FileSystemWatcher`（当前 `extension.ts` 和 `locDecorations` 各创建一个）
- `AIChatPanelProvider.sendProgrammaticMessage()` 中的 `setTimeout(200)` 改为事件驱动等待
- LSP Error Monitor 的 monkey-patch 模式改为装饰器/代理模式
- 考虑添加 `onDidChangeActiveTextEditor` 驱动的延迟初始化，避免冷启动一次性加载所有缓存

---

## 📊 工程量估算

| 阶段 | 内容 | 预估人天 |
|------|------|----------|
| P0-1 | 添加 activationEvents | 0.5 |
| P0-2 | 异步化同步 I/O | 2 |
| P0-3 | 建立测试体系 | 3 |
| P0-4 | 修复静默 catch | 1.5 |
| P1-5 | CI/CD 流水线 | 1 |
| P1-6 | Webview 模块化 | 4 |
| P1-7 | 遥测系统 | 2 |
| P1-8 | 大工作区优化 | 3 |
| P1-9 | noUncheckedIndexedAccess | 2 |
| P1-10 | MCP 环境变量过滤 | 0.5 |
| P2-11 | God Object 重构 | 8 |
| P2-12 | 缓存增强 | 3 |
| P2-13 | 死代码清理 | 0.5 |
| P2-14 | 类型安全加固 | 3 |
| P2-15 | 依赖升级 | 1 |
| P2-16 | 定价自动化 | 1 |
| **合计** | | **~36 人天** |

---

需要我对其中任何一项展开详细的实施方案吗？或者你想先讨论优先级的调整？P0-P2 tasks complete! 
