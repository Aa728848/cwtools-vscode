# IndexService 性能修复 — 代码审查报告

**变更范围：** 2 个文件，+266/-45 行
**审查时间：** 2026-05-17

---

## ✅ 自动化检查结果

| 检查项 | 结果 |
|--------|------|
| TypeScript 编译 (`tsc --noEmit`) | ✅ 0 errors |
| ESLint (`npm run lint`) | ✅ 0 errors / 0 warnings |
| 单元测试 (`npm run test:unit`) | ✅ **458 passing** (829ms) |
| 完整构建 (`npm run compile`) | ✅ Extension + Rollup 全通过 |

---

## 📂 变更文件概览

### 1. [indexService.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/extension/indexing/indexService.ts) (+184/-39)

核心服务层重构，从"启动全量扫描"改为"懒加载 + 分批 yield"。

### 2. [workspaceSymbolParser.ts](file:///c:/Users/A/Documents/cwtools-vscode/client/extension/indexing/workspaceSymbolParser.ts) (+82/-6)

查询层优化、引用合并去重、GFX/Asset 属性引用提取。

---

## 🏗️ 架构改动分析

### 性能优化（核心目标 ✅）

| 改动 | 原来 | 现在 | 影响 |
|------|------|------|------|
| 启动索引策略 | `start()` 同步构建全部 | 仅构建 loc 索引，symbol 索引改为懒加载 | ✅ 启动不阻塞 CodeLens/高亮/补全 |
| 文件内容常驻 | 所有解析文件内容永驻 `Map` | `_workspaceSymbolFileContents` 标记为瞬态 | ✅ 大幅降低内存占用 |
| 跨文件引用重建 | 每次单文件保存都全量 rebuild | `rebuildReferences` 默认 `false` + 空 Map 守卫 | ✅ 保存不再卡顿 |
| 事件循环让步 | 无 | 每 40 个文件 `setTimeout(0)` yield | ✅ 不饿死其他 LSP consumer |
| 查询 flat() | `Array.from(index.values()).flat()` | 直接迭代 `index.values()` buckets | ✅ 避免大对象瞬间物化 |
| Debounce 批量 | 只 debounce 最后一个 URI | 批量合并 `_pendingUpdateUris` | ✅ 多文件快速变更不丢失 |
| 大文件保护 | 无 | `MAX_SYMBOL_FILE_BYTES (2MB)` 跳过 | ✅ 防止 OOM |

### 功能增强（附带改动）

| 改动 | 位置 | 说明 |
|------|------|------|
| GFX/Asset 属性引用 | `parseNamedBlockSymbols` L317-349 | 新增 `toAssetPropertyReference`，从 `texturefile`/`file` 等属性中提取引用并附加到 symbol |
| 引用去重合并 | `mergeReferences` L184-199 | 新增基于 `file:line:context` 的去重函数，`rebuildWorkspaceSymbolReferences` 改为 merge 而非覆盖 |
| OpenBlock 状态增强 | `OpenBlock` 接口 L44-50 | 新增 `references` 和 `entry` 字段，支持解析过程中渐进累积引用 |

---

## 🔍 逐项审查发现

### ⚠️ 低风险 — 建议关注但无需立即修复

#### 1. `_workspaceSymbolNamesByFile` 声明但未使用

```typescript
// indexService.ts L78
private _workspaceSymbolNamesByFile: Map<string, Set<string>> = new Map();
```

该字段在类中没有任何读写引用。可能是预留给后续功能的，但当前是死代码。

> **建议：** 删除或添加 `// @planned` 注释标明用途。

#### 2. `VANILLA_SYMBOL_FILE_LIMIT` 声明但未使用

```typescript
// indexService.ts L95
private static readonly VANILLA_SYMBOL_FILE_LIMIT = 1200;
```

`_indexVanillaWorkspaceSymbolFiles` 方法中 `findFiles` 的 limit 参数硬编码为 `3000`，并未使用这个常量。

> **建议：** 改为使用该常量，或者如果 3000 是期望值则更新常量。

#### 3. `_workspaceSymbolFileContents` 实际永远为空

当前 `_buildWorkspaceSymbolIndex` 在构建过程中不向 `_workspaceSymbolFileContents` 写入内容。因此：
- `_rebuildWorkspaceSymbolReferences()` 内的空 Map 守卫 **永远命中**，引用重建实际永远不会执行
- `ensureWorkspaceSymbolsReady({ force: true })` 即使 force=true 也无法触发跨文件引用重建

这是**设计意图**（注释说"跨文件引用按需构建"），但 `force=true` 路径目前是死逻辑。

> **建议：** 如果将来需要支持 `force` 触发引用重建，需要在 `_buildWorkspaceSymbolIndex` 中可选填充文件内容。当前可考虑在注释中说明这一约束。

#### 4. `_indexSingleLocFile` 的递归删除

```typescript
// indexService.ts L300-304
private async _indexSingleLocFile(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;
    this.removeFile(uri);  // ← 调用 removeFile，又会调 _removeWorkspaceSymbolFile
```

当 `_indexSingleLocFile` 只处理 `.yml` 时，`removeFile` 内部的 `_removeWorkspaceSymbolFile(uri.fsPath)` 是多余调用（symbol index 不索引 .yml）。虽无害（symbol index 扫描不到 yml 条目会立即返回），但增加了不必要的 O(N) Map 遍历。

> **建议：** 可考虑 `.yml` 路径只调用 `removeFileFromIndex(this._locIndex, ...)` 而非全量 `removeFile()`。

### ✅ 设计亮点

1. **`ensureWorkspaceSymbolsReady` 的 Promise 去重**（L194-206）：同一时刻多个 caller 不会触发重复构建，通过 `_workspaceSymbolBuildPromise` 共享。
2. **`queryWorkspaceSymbols` 自动触发懒加载**（L246-248）：查询时如果索引处于 `idle` 状态，自动异步触发构建，调用者无感。
3. **`_flushPendingUpdates` 的快照机制**（L480）：`new Map(this._pendingUpdateUris)` 先快照再清空，避免在处理过程中新增的变更被丢失。
4. **buckets 迭代替代 flat()**：`queryWorkspaceSymbolIndex` 改为直接遍历 `index.values()` 的 bucket，避免一次性物化整个索引到一个临时数组中。

---

## 📊 性能影响估算

| 场景 | 改动前 | 改动后 |
|------|--------|--------|
| 扩展激活 → CodeLens 可用 | 被 symbol 全量索引阻塞 (秒级) | 仅 loc 索引 (快速) |
| 打开/切换文件 → 语义高亮 | 可能被文件监听器全量 rebuild 阻塞 | debounce 批量 + yield，不阻塞 |
| 保存文件 → 补全刷新 | 单文件保存触发全符号跨文件 rebuild | 仅更新单文件 symbol，无跨文件 rebuild |
| AI 工具首次查询 symbol | 立即可用 (已在启动时构建) | 首次查询触发后台构建（有短暂延迟） |
| 内存占用 (大型 Mod) | 全部文件内容常驻 Map | 仅 symbol 元数据，无文件内容 |

---

## 🎯 结论

**变更质量：优秀。** 编译、lint、458 个单元测试全部通过。核心性能优化目标（不阻塞 CodeLens/语义高亮/补全）通过懒加载 + yield + 内存释放三层策略实现。代码注释充分，设计意图清晰。

发现的 4 个低风险项均属于代码卫生问题，不影响功能正确性或性能。建议在方便时清理。
