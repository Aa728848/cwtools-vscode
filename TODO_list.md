# Eddy's Stellaris CWTools — 项目功能分析与扩展建议（修订版）

> 基于对项目完整代码库与 CHANGELOG 的深入审查。对初版中错误标记为"缺失"的已完成功能进行了修正。

---

## 一、项目现状总览

### 架构健康度评分

| 层级 | 成熟度 | 技术债务 | 评分 |
|------|--------|----------|------|
| 🧠 AI Agent 子系统 | ★★★★★ | 中 | **A** |
| 🎨 GUI Preview | ★★★★☆ | 低 | **A-** |
| 🌌 Solar System Visualizer | ★★★★☆ | 低 | **A-** |
| 📊 Event Chain / Tech Tree | ★★★☆☆ | 中 | **B+** |
| 🔧 F# LSP Backend | ★★★★★ | 低 | **A+** |
| 🧪 测试覆盖率 | ★☆☆☆☆ | **高** | **D** |
| 📦 构建与打包 | ★★★★☆ | 低 | **A-** |

---

## 二、已完成功能清单（初版分析中的误判修正）

> [!IMPORTANT]
> 以下功能在初版分析中被错误标记为"缺失"或"建议实现"，实际上均已完整实现。

| 功能 | 实现版本 | 实际状态 |
|------|----------|----------|
| **SemanticTokens（含增量 delta）** | v1.8.0 | ✅ 完整实现。使用一维数组步长切片算法实现 `full/delta` 增量下发，大文件从上兆载荷降至几十字节 |
| **InlayHints（含缓存预加载）** | v1.6.1+ | ✅ 完整实现。`inlayHintCache` 使用 ConcurrentDictionary + 内容哈希缓存，预热阶段批量填充 |
| **CI/CD Pipeline** | 已存在 | ✅ 3 个 GitHub Actions：`pr.yml`（构建+测试）、`release.yml`（发布 VS Marketplace + Open VSX）、`sync-gitee.yml`（Gitee 镜像同步） |
| **agentRunner.ts 模块拆分** | v1.6.1 | ✅ 已部分完成。提取了 `toolCallParser.ts`（6.7KB）、`jsonRepair.ts`（2.4KB）、`contextBudget.ts`（13.5KB） |
| **多文件 Diff Summary** | v1.6.0 | ✅ 已实现 `sendDiffSummary()`，任务完成后展示涉及多文件的 Diff 概览视图 |
| **项目级 Memory 注入** | 已存在 | ✅ `memoryParser.ts` 读取 `CWTOOLS.md` 文件，通过 `PromptBuilder` 注入系统 Prompt |
| **加权全文对话搜索** | v1.6.0 | ✅ 基于权重的全文检索引擎，支持搜索模型回复与代码块，含命中段落前后文切片预览 |
| **AI 快捷命令与键盘绑定** | v1.6.0 | ✅ 已注册 `Ctrl+Shift+R`（Review）、`Ctrl+Shift+E`（Explain）、`Ctrl+Shift+F`（Fix Diagnostics） |
| **F# 后端多态重构** | v1.6.1 | ✅ 引入 `IGameVisitor`/`IGameDispatcher`，消除 10 向 match 冗余 |
| **无锁并发后端** | v1.8.0 | ✅ ConcurrentDictionary + Interlocked 原子操作 + 尾递归优化 |
| **智能 LRU 内存淘汰** | v1.8.0 | ✅ 基于 `GC.GetTotalAllocatedBytes` 的自适应容量释放 + LRU 追踪 |

---

## 三、关键问题识别（仍然存在）

### 🔴 P0 — 测试覆盖率严重不足

> [!CAUTION]
> 这是当前项目**最大的风险点**。

| 测试类别 | 文件数 | 覆盖面 |
|----------|--------|--------|
| 单元测试 | 2 | 仅 `contextBudget.test.ts` + `pricing.test.ts` |
| 集成测试 | 4 | `completion`, `extension`, `hover` + index |
| AI Agent 测试 | **0** | agentRunner、agentTools、providers、promptBuilder 等**完全没有测试** |
| Webview 测试 | **0** | chatPanel.ts (webview 154KB) 无任何测试 |
| 解析器测试 | **0** | guiParser、solarSystemParser、eventChainParser 无测试 |

**风险**：AI Agent 子系统约 580KB 代码，涉及 38 个工具定义、14 个 Provider 适配器、多模式 Prompt 构建、Doom-loop 检测、上下文压缩等复杂逻辑，全部处于零测试状态。CI 中 `npm test` 仅覆盖集成测试。

### 🟡 P1 — 单文件巨型化（部分已改善）

> [!NOTE]
> `agentRunner.ts` 已在 v1.6.1 中完成部分拆分（提取了 `toolCallParser.ts`、`jsonRepair.ts`、`contextBudget.ts`），但核心文件仍然很大。

| 文件 | 行数 | 大小 | 状态 | 建议 |
|------|------|------|------|------|
| `agentRunner.ts` | 1,814 | 88KB | ⚠️ 已部分拆分 | 可进一步提取 `compaction.ts` + `checkpoint.ts` + `validation.ts` |
| `chatPanel.ts` (webview) | ~4,000+ | 155KB | ❌ 未拆分 | 拆分为独立模块（markdown 渲染、settings UI、消息列表等） |
| `chatPanel.ts` (extension) | 1,260 | 60KB | ❌ 未拆分 | 拆分为 `messageHandler.ts` + `planManager.ts` + `retractManager.ts` |
| `lspTools.ts` | ~1,500+ | 66KB | ❌ 未拆分 | 按工具类别拆分 |
| `fileTools.ts` | ~1,300+ | 54KB | ❌ 未拆分 | 按工具类别拆分 |
| `promptBuilder.ts` | 1,005 | 60KB | ❌ 未拆分 | 每种模式的 Prompt 可提取到独立文件 |
| `guiPreview.ts` | ~3,000+ | 118KB | ❌ 未拆分 | 拆分为渲染器、交互层、属性面板 |

### 🟡 P2 — 构建优化空间

- Rollup 未启用 `terser`/`swc` 压缩，Webview 脚本可能较大
- 5 个 Webview bundle 各自独立编译 TypeScript，可考虑共享编译缓存
- `rollup-plugin-typescript2` 已较旧，可升级为 `@rollup/plugin-typescript` + `@rollup/plugin-swc`

---

## 四、扩展建议（仅保留确实未完成的项目）

### 🏆 Tier 1 — 基础加固（建议最先执行）

#### 1.1 AI Agent 单元测试框架搭建

```
client/test/unit/ai/
├── agentRunner.test.ts       — Doom-loop 检测、压缩逻辑、Checkpoint
├── promptBuilder.test.ts     — 多模式 Prompt 正确性
├── providers.test.ts         — Vision/FIM 能力判断、Context Token 查找
├── toolCallParser.test.ts    — DSML 解析、Think 块剥离
├── contextBudget.test.ts     — 已有，扩展覆盖
└── tools/
    ├── fileTools.test.ts     — edit_file fuzzy match、multiedit 原子性
    └── lspTools.test.ts      — 缓存命中/失效逻辑
```

**预期收益**：覆盖 AI 核心逻辑 50+ 个关键路径，回归测试每次 PR 可在 <3s 完成。

#### 1.2 agentRunner.ts 进一步模块拆分

> [!NOTE]
> v1.6.1 已完成第一轮拆分（提取了 `toolCallParser.ts`、`jsonRepair.ts`、`contextBudget.ts`），但 `agentRunner.ts` 仍有 1,814 行。建议继续拆分为：

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `compaction.ts` (扩展) | `maybeCompactHistory()` + mid-loop compaction | ~250 |
| `checkpoint.ts` | `saveCheckpoint()` + `loadCheckpoint()` | ~100 |
| `validation.ts` | `validationLoop()` + code extraction | ~200 |
| `agentRunner.ts` | 入口类 `AgentRunner.run()` + `reasoningLoop()` | ~800 |

---

### 🥈 Tier 2 — 用户体验增强

#### 2.1 Diff 预览增强 — 行级 Diff 可视化

> [!NOTE]
> 当前已实现了 `sendDiffSummary` 功能（v1.6.0），可在任务完成后展示多文件 Diff Summary。但目前仅报告 "File modified" 等粗粒度状态，缺乏行级变更信息。

**建议进一步增强**：
- 使用 Myers diff 算法生成行级 `+/-` 变更
- 在 Webview 中渲染类似 GitHub PR 的行级 Diff 视图
- 支持点击 Diff 跳转到对应文件位置

#### 2.2 Code Action — 自动修复 Quick Fix

当前 CWTools LSP 诊断错误在 VS Code 问题面板中显示，用户可通过快捷键 `Ctrl+Shift+F` 触发 AI 修复，但需要手动操作。

**建议**：注册 `CodeActionProvider`，对每个 CWTools 诊断自动生成 Quick Fix 选项：
- "AI: Fix this error" → 自动将错误上下文发送到 AI Agent
- "AI: Explain this error" → 自动生成解释
- 无需手动输入或切换面板，在编辑器右键菜单或灯泡图标中直接操作

#### 2.3 智能 Snippet 系统

根据当前文件类型和目录，自动推荐常用代码片段：

| 目录 | Snippet |
|------|---------|
| `events/` | 完整事件模板（含 namespace、title、desc、trigger、immediate、option） |
| `common/decisions/` | 决策模板 |
| `common/technology/` | 科技模板 |
| `common/buildings/` | 建筑模板 |
| `common/traits/` | 特质模板 |

#### 2.4 AI 对话搜索增强 — 语义搜索

> [!NOTE]
> 当前已有基于权重的全文检索引擎（v1.6.0）。建议进一步增强：

- 基于对话中的关键 PDXScript 实体名建立倒排索引
- 引入 BM25 或 TF-IDF 排序，提升长期历史检索精度

---

### 🥉 Tier 3 — LSP 增强（聚焦未完成项）

> SemanticTokens ✅ 和 InlayHints ✅ 均已完整实现，此 Tier 仅保留真正待做项。

#### 3.1 Diagnostic Severity 精细化配置

当前 CWTools 诊断已有 Severity 级别，但可进一步精细化：
- 允许用户通过 `.cwtools.json` 自定义诊断规则的严重性等级
- 为缺少本地化 key 统一设置为 Warning 而非 Error
- 为潜在性能问题（如 `on_monthly_pulse` 无 trigger 过滤）设置为 Information 级别

#### 3.2 CodeLens 增强 — 引用计数与跳转

在定义处显示引用次数（如 `3 references`），点击展开引用列表。当前已有 CodeLens 本地化文本（v1.1.0），可扩展到更多类型。

---

### 🎯 Tier 4 — 可视化扩展

#### 4.1 Mod 依赖关系全局图谱

创建一个新 Webview 面板，显示整个 Mod 的实体依赖关系：
- 节点：Events、Technologies、Buildings、Decisions、Traditions 等
- 边：引用关系（`fire_event`、`has_technology`、`has_modifier` 等）
- 使用 Force-Directed Layout 布局
- 支持按文件夹/类型筛选、搜索聚焦

#### 4.2 本地化覆盖率仪表板

在 Webview 中展示：
- 总本地化 Key 数量 vs 缺失数量
- 按语言分类的覆盖率百分比
- 快速跳转到缺失 Key 的定义位置

#### 4.3 GUI Preview — 交互增强

- **对齐辅助线**：拖拽元素时显示对齐参考线（类似 Figma）
- **组合选取框**：框选多个元素进行批量操作
- **深色/亮色模式切换**：模拟游戏内不同 UI 主题

---

### 💡 Tier 5 — AI 可靠性深化

#### 5.1 工具调用审计日志

在 Agent 每次工具调用后，记录结构化日志：
```ts
interface ToolAuditEntry {
    timestamp: number;
    toolName: string;
    args: Record<string, unknown>;
    result: 'success' | 'error';
    durationMs: number;
    tokensCost: number;
    retryCount: number;
}
```

支持导出为 JSON/CSV，用于分析 AI 行为模式和调试失败。

#### 5.2 工具调用成功率监控

在 Usage Dashboard 中增加：
- 按工具分类的成功率、平均延迟
- 失败原因分布（timeout、LSP error、file not found 等）
- 自动检测异常模式并提示用户

#### 5.3 Agent 行为回放

保存完整的 Agent 推理轨迹（messages + tool calls + results），支持：
- 在 Webview 中逐步回放 Agent 的思考过程
- 导出为可分享的 HTML 报告
- 用于调试"为什么 AI 做了错误的事情"

#### 5.4 跨会话持久 Agent Memory

> [!NOTE]
> 当前已有 `memoryParser.ts` 支持基于 `CWTOOLS.md` 文件的项目级记忆注入（集成于 `PromptBuilder`）。但仅限于单文件静态规则。

**建议扩展为跨会话动态持久记忆**：
- 自动从 Agent 对话中提取和持久化项目特有的模式与偏好
- 记录常见的假阳性诊断规则和用户纠正过的 AI 错误
- 支持向量化检索而非全量注入 Prompt

---

### 🔧 Tier 6 — 工程基础设施

#### 6.1 CI/CD 增强

> [!TIP]
> 项目已有 3 个 GitHub Actions 工作流：
> - `pr.yml` — Push/PR 触发 → npm install → build → test → 上传 .vsix
> - `release.yml` — 手动触发 → 构建 → 发布到 VS Marketplace + Open VSX
> - `sync-gitee.yml` — 中国区 Gitee 镜像同步

**建议增强**：
- 添加 lint 步骤（当前 CI 缺少 `npm run lint`）
- 添加 AI 模块专项单元测试步骤
- 添加 bundle size 监控（防止 Webview 包无节制膨胀）

#### 6.2 Webview 热重载

当前开发 Webview 需要 `npm run compile` → 重新加载扩展。建议：
- 使用 Rollup watch 模式监听 Webview 文件变更
- 在 Webview 中注入 Dev 模式的 LiveReload 脚本
- 显著减少 UI 迭代时间

#### 6.3 Bundle 分析与优化

- 添加 `rollup-plugin-visualizer` 查看 Webview 包的体积分布
- 对 `chatPanel.ts` 使用 code splitting（动态 import 设置页、历史搜索等非核心模块）
- 为 Rollup 添加 terser 压缩

---

### 🌐 Tier 7 — 生态系统扩展

#### 7.1 Stellaris Mod Workshop 集成

- 从 Steam Workshop 获取 Mod 元数据
- 在 File Explorer 中标记来自依赖 Mod 的文件
- 解析 `.mod` 描述文件中的依赖关系

#### 7.2 多人协作 Mod 开发

- 集成 Git 状态到 File Explorer（显示文件修改状态）
- AI Agent 生成的 `walkthrough.md` 自动作为 PR 描述模板
- 支持 `.cwtools-team.json` 配置文件共享团队 AI 设置

#### 7.3 Mod 模板市场

- 内置常见 Mod 模板（起源、文明特质包、事件链、危机、飞升等）
- 支持社区贡献模板
- AI 可以基于模板快速脚手架化生成完整 Mod 结构

---

### 🚀 Tier 8 — 未来方向探索

#### 8.1 PDXScript AST Playground

类似 [AST Explorer](https://astexplorer.net/) 的交互式工具：
- 在左侧输入 PDXScript 代码
- 在右侧实时显示 CWTools 解析的 AST 树
- 帮助 Mod 开发者理解解析器行为

#### 8.2 AI 辅助的性能分析器

分析 Mod 代码的潜在性能问题：
- 检测 `on_monthly_pulse` 等高频触发器中缺少前置条件检查的事件
- 统计全局 `every_owned_planet` 等重循环的嵌套深度
- 估算运行时的 scope 切换开销

#### 8.3 AI 自主代码审查流水线

自动化的代码质量保证流程：
1. 用户提交代码 → 触发 Review 模式
2. AI 自动检查所有修改文件的诊断错误
3. 生成审查报告（通过/不通过 + 修复建议）
4. 支持与 Git hook 集成

---

## 五、技术债务清理路线图

### 短期（1-2 周）

- [ ] 为 `agentRunner.ts` 核心函数添加 20+ 单元测试
- [ ] 为 `providers.ts` 的 `isModelVisionCapable()` / `getModelContextTokens()` 添加边界测试
- [ ] 将 `agentRunner.ts` 进一步拆分（compaction / checkpoint / validation）
- [ ] 为 Rollup 添加 terser 压缩

### 中期（3-4 周）

- [ ] 为 `fileTools.ts` 的 `edit_file` fuzzy match 添加测试用例集
- [ ] 拆分 Webview `chatPanel.ts` 为 3-4 个模块
- [ ] 在 CI 中增加 lint + AI 模块专项测试步骤
- [ ] 添加 Webview 热重载开发模式

### 长期（1-2 月）

- [ ] 实现 Mod 依赖关系图谱
- [ ] 实现 AI 工具调用审计日志
- [ ] 实现跨会话动态 Agent Memory
- [ ] 注册 CodeActionProvider Quick Fix

---

## 六、总结

Eddy's Stellaris CWTools 已经是一个**功能极其丰富且架构成熟的项目**——14 个 AI 供应商、38 个 AI 工具、5 个交互式 Webview 面板、完整的 LSP 语言服务（含 SemanticTokens 增量下发和 InlayHints 缓存预加载），以及 3 套 CI/CD 工作流。

> [!IMPORTANT]
> **当前阶段的核心策略应该是"加固基础"而非"堆砌功能"**。测试覆盖率的严重不足是最大的风险——每次功能迭代都在无测试保护下进行，bug 回归的概率随复杂度指数增长。建议将 Tier 1（测试 + 继续拆分）和 Tier 6.1（CI 增强）作为下一阶段的最高优先级。

功能扩展方面，**Tier 2（用户体验增强）**的 ROI 最高：行级 Diff 预览、Code Action Quick Fix、智能 Snippet 都是用户可直接感知的改善，且实现成本相对较低。
