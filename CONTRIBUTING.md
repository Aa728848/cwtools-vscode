# 贡献指南

感谢您对本项目的关注！本指南涵盖环境搭建、开发流程、调试方法和代码规范。

---

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| **Node.js** | ≥ 20.x | TypeScript 编译、Webview 打包 |
| **npm** | ≥ 10.x | 包管理 |
| **.NET SDK** | ≥ 9.0 | F# 语言服务器编译 |
| **VS Code** | ≥ 1.90 | 扩展宿主运行时 |
| **Git** | 最新版 | 源码管理 + 子模块 |

---

## 快速开始

### 1. 克隆（含子模块）

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
```

已有仓库但缺少子模块：
```bash
git submodule update --init --recursive
```

### 2. 安装依赖

```bash
npm install
```

### 3. 构建 F# 语言服务器

```bash
dotnet build src/LSP/
```

或使用便捷脚本：
```bash
# Windows
.\build.cmd

# Linux / macOS
./build.sh
```

### 4. 构建 TypeScript 扩展

```bash
npm run compile
```

包含两步：
1. `tsc -p ./tsconfig.extension.json` — 编译扩展上下文代码到 `release/bin/`
2. `rollup -c` — 打包 5 个 Webview 脚本（`chatPanel`, `guiPreview`, `solarSystemPreview`, `eventChainPreview`, `techTreePreview`）到 `release/bin/client/webview/`

### 5. 使用本地 CWTools F# 仓库

如需针对本地 cwtools 仓库开发，创建 `cwtools.local.props`：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

调整 `<CwtoolsPath>` 指向你的本地仓库。

---

## 开发流程

### 运行与调试

1. 在 VS Code 中打开本仓库
2. 按 **F5**（或 运行 → 开始调试）
3. 将启动新的 **扩展开发主机** 窗口，扩展已加载
4. 修改代码后重启主机（Ctrl+Shift+F5）重新加载

### Webview 调试

Webview 脚本（聊天面板、GUI 预览、星系预览、事件链、科技树）在隔离浏览器沙盒中运行。调试方法：

1. 在扩展开发主机窗口中，打开命令面板（`Ctrl+Shift+P`）
2. 执行：**Developer: Open Webview Developer Tools**
3. 打开 Chrome DevTools — 可设置断点、检查 DOM 等

> ⚠️ **重要**：Webview 脚本无法访问 `require()`、`vscode` API 或 Node.js 模块。与扩展宿主的通信必须通过 `postMessage`。详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

### 监视模式

快速迭代开发：
```bash
# 终端 1：监视 TypeScript
npx tsc -p ./tsconfig.extension.json --watch

# 终端 2：监视 Webview 打包
npx rollup -c --watch
```

---

## 构建脚本

| 命令 | 描述 |
|------|------|
| `npm run compile` | 完整构建（扩展 + 5 个 Webview） |
| `npm run lint` | ESLint 检查 `client/` |
| `npm run test` | 编译 + VS Code 集成测试 |
| `npm run test:unit` | 通过 `ts-mocha` 运行单元测试 |
| `npm run test:coverage` | 带覆盖率报告的单元测试 |

---

## 项目结构

详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 获取完整模块地图。简要概览：

```
client/
├── extension/              # 扩展上下文 (Node.js)
│   ├── ai/                 # AI Agent 模块 (27+ 文件)
│   │   ├── tools/          # 工具实现 (5 个文件)
│   │   ├── agentRunner.ts  # 核心推理循环
│   │   ├── aiService.ts    # 提供商 HTTP 客户端
│   │   ├── chatPanel.ts    # Webview 宿主
│   │   ├── providers.ts    # 16+ 提供商配置
│   │   └── diffEngine.ts   # Myers diff 算法
│   ├── extension.ts        # 主入口
│   ├── guiPanel.ts         # GUI 预览宿主
│   ├── solarSystemPanel.ts # 星系可视化器宿主
│   ├── eventChainPanel.ts  # 事件链可视化器宿主
│   ├── techTreePanel.ts    # 科技树可视化器宿主
│   └── codeActions.ts      # AI Quick Fix
├── webview/                # Webview 脚本 (浏览器沙盒)
│   ├── chatPanel.ts        # 聊天 UI + Markdown 渲染器
│   ├── guiPreview.ts       # GUI Canvas 渲染器
│   ├── solarSystemPreview.ts
│   ├── eventChainPreview.ts    # Cytoscape.js 事件链图
│   └── techTreePreview.ts      # Cytoscape.js 科技树图
└── test/                   # 测试
    ├── unit/               # 单元测试 (7 个文件)
    └── suite/              # 集成测试

src/LSP/                    # F# 语言服务器
submodules/cwtools/         # CWTools F# 库 (Git 子模块)
```

---

## 代码规范

### TypeScript

- **严格模式**：所有 tsconfig 启用 `strict: true` + `noUncheckedIndexedAccess: true`
- **禁用 `any`**：优先使用正确类型。类型真正未知时使用 `unknown` + 类型守卫
- **命名**：`camelCase` 用于变量/函数，`PascalCase` 用于类型/接口，`UPPER_SNAKE_CASE` 用于常量
- **导入排序**：(1) Node.js 内置模块, (2) VS Code API, (3) 本地模块
- **错误处理**：使用 `ErrorReporter`（`ai/errorReporter.ts`）代替裸 `console.error`：
  - `ErrorReporter.fatal(source, msg)` — 向用户显示通知
  - `ErrorReporter.warn(source, msg)` — 状态栏显示
  - `ErrorReporter.debug(source, msg)` — 仅输出通道
- **UI 字符串**：所有用户可见中文文本应放在 `ai/messages.ts`，不要硬编码

### AI 模块特定规范

- **工具安全**：添加修改文件的新工具时，必须将其加入 `agentRunner.ts` 中的 `WRITE_TOOLS` 集合，确保并行子代理执行时的串行写入
- **上下文隔离**：永远不要在 Webview 脚本中导入 `vscode`。永远不要在 Webview 代码中使用 `require()`
- **内存安全**：对任何随使用增长的数据使用有界缓存（LRU）。`lspTools.ts` 中的 LSP 缓存是参考模式（128 条目 + TTL）
- **Token 估算**：使用 `agentRunner.ts` 中的 `estimateTokenCount()` 进行所有 token 计算。自动选择快速 vs. 精确路径
- **工具分发**：新增工具时需同步更新 `agentTools.ts`（路由）、`tools/definitions.ts`（Schema）和 `types.ts`（类型）

### CSS

- 使用 VS Code 主题 CSS 变量（如 `var(--vscode-editor-background)`），不硬编码颜色
- 确保最低 4.5:1 对比度以满足无障碍要求
- 动画支持 `prefers-reduced-motion`

### ESLint 配置

项目使用 ESLint 9 平面配置（`eslint.config.mjs`），关键规则：
- `@typescript-eslint/no-floating-promises: error` — 防止未处理的 Promise
- `@typescript-eslint/no-misused-promises: error` — 防止 Promise 误用
- `prefer-promise-reject-errors: error` — 拒绝时使用 Error 对象

---

## Pull Request 检查清单

提交 PR 前请验证：

- [ ] `npm run compile` 零错误通过
- [ ] `npm run lint` 通过（或新警告有合理理由）
- [ ] 现有注释和文档字符串已保留
- [ ] 无未说明理由的 `any` 类型
- [ ] UI 字符串在 `messages.ts` 中，未硬编码
- [ ] 新写操作工具已加入 `WRITE_TOOLS` 锁守卫集合
- [ ] 新 Webview 功能通过 `postMessage` 与扩展通信
- [ ] 新工具同步更新了 `definitions.ts`、`agentTools.ts`、`types.ts`
- [ ] 在扩展开发主机中测试通过：
  - [ ] 聊天面板可打开并发送消息
  - [ ] 模式切换正常（Build/Plan/Explore/General/Review/LocTranslator/LocWriter）
  - [ ] GUI 预览可渲染（如有修改）
  - [ ] 事件链/科技树可视化器正常（如有修改）
  - [ ] Webview DevTools 无控制台错误

---

## 打包

构建 `.vsix` 分发包：

```powershell
# Windows — 构建全部 3 个平台
.\package.ps1
```

产出平台特定包：
- `cwtools-vscode-*-win32-x64.vsix`
- `cwtools-vscode-*-linux-x64.vsix`
- `cwtools-vscode-*-darwin-x64.vsix`

---

## 测试

### 单元测试

位于 `client/test/unit/`，覆盖核心模块：

| 测试文件 | 覆盖模块 |
|---------|---------|
| `contextBudget.test.ts` | Token 预算与压缩逻辑 |
| `diffEngine.test.ts` | Myers diff 算法正确性 |
| `editFileReplacer.test.ts` | 8 种模糊替换策略 |
| `jsonRepair.test.ts` | JSON 修复逻辑 |
| `pricing.test.ts` | 成本估算 |
| `providers.test.ts` | 提供商配置与能力检测 |
| `toolCallParser.test.ts` | 非标准工具调用解析 |

运行单元测试：
```bash
npm run test:unit
```

### 集成测试

位于 `client/test/suite/`，需要 VS Code 运行时：
```bash
npm run test
```

---

## 获取帮助

- **架构概览**：见 [ARCHITECTURE.md](./ARCHITECTURE.md)
- **AI 编码指南**：见 [CLAUDE.md](./CLAUDE.md)（AI 助手工作指南）
- **问题反馈**：提交 GitHub Issue