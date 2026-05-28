# CWTools Agent UX 改进计划（v2 — 已根据批注修订）

## 修订说明

根据用户批注做了以下调整：
- ~~阶段 C（快速任务入口）~~ — **已移除**，不需要
- 阶段 B：工具分组策略确认为**按类型**分组
- 阶段 D：**不包含 vanilla 文件**；必须避免触发 IndexService 全量加载

> [!IMPORTANT]
> **IndexService 性能约束（阶段 D）**：Workspace Symbol 索引是懒加载的（`ensureWorkspaceSymbolsReady()` 按需触发），10 分钟空闲后自动驱逐。阶段 D 的 @ 搜索**仅使用已加载的数据源**：
> - ✅ Localisation 索引（启动时已加载，轻量）
> - ✅ `vscode.workspace.findFiles()`（VS Code 原生，不依赖 IndexService）
> - ✅ Workspace Symbol 索引 **仅当 `status === 'ready'` 时查询**，不触发构建
> - ❌ 不调用 `ensureWorkspaceSymbolsReady()`，不触发全量加载

---

## 阶段 A：Side Workspace 文件面板增强

在现有 `sideWorkspace` 中增加 Tab 切换和文件树视图。

### 设计

```
┌─ Side Workspace ──────────────────┐
│ [变更] [文件] [Artifacts]  ← Tab  │
│ ─────────────────────────────────  │
│ ▸ events/my_event.txt    +12 -3   │
│ ▸ localisation/l_en.yml  +5  -1   │
│ ─────────────────────────────────  │
│ 3 次变更 · 4 个文件               │
└───────────────────────────────────┘
```

### Proposed Changes

#### [MODIFY] [chatPanel.css](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chatPanel.css)

新增样式：
- `.side-workspace-tabs` — Tab 栏（flex 容器，底部 1px 边框）
- `.side-workspace-tab` — Tab 按钮（active 态底部 accent 高亮线 + `.tab-badge` 数字徽章）
- `.scratch-file-tree` / `.scratch-file-item` / `.scratch-file-icon` — 文件树样式

#### [MODIFY] [chatPanel.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chatPanel.ts)

1. 新增 `sideWorkspaceActiveTab` 状态变量
2. 新增 `renderSideWorkspaceTabs()` — 生成 Tab 栏 HTML
3. 新增 `renderScratchFileTree(files)` — 接收 Host 的文件列表，渲染文件树
4. 修改 `openSideWorkspace()` — 在面板顶部注入 Tab 栏
5. 新增 Artifacts Tab — 从现有 `artifacts[]` 提取精简卡片列表

#### [MODIFY] [chatPanel.ts (Extension Host)](file:///c:/Users/A/Documents/cwtools-vscode/client/extension/ai/chatPanel.ts)

1. 处理 `requestScratchFiles` 消息 → 读取 `.cwtools-ai/{topic}/scratch/` 目录
2. 处理 `openScratchFile` 消息 → `vscode.workspace.openTextDocument()`
3. 用 `vscode.workspace.createFileSystemWatcher()` 监听 scratch 目录变更，自动推送刷新

#### [MODIFY] [messages.chat.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chat/messages.chat.ts)

新增消息类型：`requestScratchFiles` / `scratchFiles` / `openScratchFile`

---

## 阶段 B：工具调用按类型分组折叠

将密集的工具调用按**类型**（读取/写入/查询/验证/执行）分组折叠，为 PDX 工具提供人类可读短语。

### 设计

```
┌ 📖 读取了 3 个文件              ─ 展开 ┐
│  ✓ read_file → events/my_event.txt     │
│  ✓ get_pdx_block → on_actions.txt      │
│  ✓ get_file_context → triggers.txt     │
└────────────────────────────────────────┘
┌ ✏️ 修改了 2 个文件              ─ 展开 ┐
│  ✓ edit_file → my_event.txt  +12 -3    │
│  ✓ write_localisation → l_en.yml +5    │
└────────────────────────────────────────┘
```

**分组规则**：一轮中工具调用 ≥3 时启用分组；<3 时保持逐条展示。

### Proposed Changes

#### [NEW] [toolPhrases.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chat/toolPhrases.ts)

工具分类与人类可读短语映射表：

| category | 工具 | 短语 |
|----------|------|------|
| `read` | `read_file`, `get_pdx_block`, `get_file_context` | 读取文件 / 提取脚本块 / 获取上下文 |
| `write` | `edit_file`, `create_file`, `write_localisation` | 编辑文件 / 创建文件 / 写入本地化 |
| `query` | `query_workspace_index`, `query_localisation_index`, `document_symbols` | 搜索索引 / 搜索本地化 / 文档符号 |
| `validate` | `get_diagnostics` | 获取诊断 |
| `execute` | `run_command` | 执行命令 |
| `orchestrate` | `dispatch_agents` | 分派子任务 |

导出 `groupToolSteps(steps)` 函数：输入 `RendererStep[]`，输出 `ToolGroup[]`。

#### [MODIFY] [messageRenderer.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/messageRenderer.ts)

1. 新增 `renderToolGroup(group)` — 用 `<details>` 渲染折叠组
2. 修改 `buildToolPairHtml()` 调用处：≥3 工具调用时走分组路径

#### [MODIFY] [chatPanel.css](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chatPanel.css)

新增 `.tool-group-summary` / `.tool-group-count` / `.tool-group-details` 样式，颜色编码：读取(蓝)/写入(绿)/验证(橙)/执行(红)。

---

## 阶段 D：@ 搜索建议增强（性能安全版）

增强 `@` 引用的搜索建议，**仅使用已加载的数据源**，不触发 IndexService 全量加载。

### 数据源策略

```
@搜索请求到达 Extension Host 后：
  1. vscode.workspace.findFiles(query)           ← 始终可用
  2. indexService.queryLocalisation({contains})   ← 始终可用（启动时已加载）
  3. if (indexService.workspaceSymbolStatus === 'ready')
       indexService.queryWorkspaceSymbols(query)  ← 仅已加载时查询
     else
       跳过，不触发构建
```

### 设计

```
┌─ @ 搜索文件... ──────────────────────┐
│ 📂 最近文件                           │
│   events/my_event.txt                │
│   common/on_actions.txt              │
│ ─────────────────────────────────── │
│ 📁 文件                              │  ← findFiles
│   events/chain_event.txt             │
│ 🌐 本地化                            │  ← loc索引(已加载)
│   my_event.1.name                    │
│ 🏷️ 符号 (如已加载)                    │  ← symbol索引(仅ready时)
│   my_event_chain (event_chain)       │
└──────────────────────────────────────┘
```

### Proposed Changes

#### [MODIFY] [chatPanel.ts (Extension Host)](file:///c:/Users/A/Documents/cwtools-vscode/client/extension/ai/chatPanel.ts)

新增 `handleMentionSearch(query)` 方法：
1. 并行查询 `findFiles` + `queryLocalisation`
2. 条件查询 `queryWorkspaceSymbols`（仅 `status === 'ready'`）
3. 合并去重，按类型分组返回
4. 防抖 150ms

新增 `handleRecentFiles()` — 通过 `vscode.workspace.textDocuments` 返回最近文件

#### [MODIFY] [chatPanel.ts (Webview)](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chatPanel.ts)

修改 @ 弹出菜单渲染：
- 搜索输入变化时发送 `mentionSearch` 消息
- 接收结果后按类型分组渲染
- 无输入时展示最近文件快捷列表

#### [MODIFY] [messages.chat.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/webview/chat/messages.chat.ts)

新增消息：`mentionSearch` / `mentionSearchResults` / `requestRecentFiles` / `recentFiles`

---

## Verification Plan

### 编译检查
```bash
npm run compile
npm run lint
```

### 手动验证

**阶段 A**：
- [ ] 工作区面板展示 Tab 栏（变更/文件/Artifacts）
- [ ] 文件 Tab 正确展示 scratch 目录内容
- [ ] 点击文件可在编辑器中打开
- [ ] Agent 创建文件后文件树自动刷新

**阶段 B**：
- [ ] ≥3 工具调用时自动分组折叠
- [ ] 分组标签正确显示（如「读取了 3 个文件」）
- [ ] <3 调用时保持逐条展示
- [ ] PDX 工具短语翻译正确

**阶段 D**：
- [ ] 输入 `@` 后展示最近文件列表
- [ ] 输入关键词后展示分组搜索结果
- [ ] 确认**未触发** IndexService 全量加载（检查日志无 `Workspace symbol index ready` 输出）
- [ ] Symbol 索引已加载时，搜索结果包含符号；未加载时仅展示文件和本地化
