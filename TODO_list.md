# CWTools VSCode 插件内存泄漏修复方案

## 背景

MemDiag.txt 显示严重的内存泄漏：25分钟编辑过程中，累计分配从 43GB 增长到 1138GB（约 7-8GB/分钟），每周期分配增量从 3.7GB 加速到 9GB。堆内存从 3.6GB 增长到 17GB。字符串/整数驻留池数量稳定（489K/736K），说明泄漏不在驻留系统中。

**根本原因**是一组相互叠加的问题：
1. `Seq.cache` 将整个补全结果集钉在内存中无法释放
2. `completionCache` 单调增长，仅每3次调用才清理一次
3. `rangeCache` 缓存了整个文件文本，文档关闭时从不失效
4. 模块级 `completionEntityCache` 永不淘汰过期条目
5. GC 策略过弱（`blocking=false`，阈值过高），无法及时回收大型死亡对象

## 修复内容

### 修复 1：将 `Seq.cache` 替换为即时物化（Completion.fs:525）

**文件：** `src/Main/Completion.fs`

将第 525 行的 `|> Seq.cache` 替换为 `|> Seq.toArray :> seq<_>`。`Seq.cache` 在缓存节点链表中钉住整个惰性序列。使用 `Seq.toArray` 将序列一次性物化为紧凑数组，当下次补全调用替换引用时，数组可立即被 GC 回收（无迭代器/闭包链持有引用）。

```fsharp
// 修改前
|> Seq.cache
// 修改后
|> Seq.toArray :> seq<_>
```

### 修复 2：为 `completionCache` 添加上限淘汰（Completion.fs:53-62）

**文件：** `src/Main/Completion.fs`

当前代码（第 287-291 行）每 3 次调用才清理一次，期间累积 2000-3000+ 条目。改为在 `addToCache` 中检查容量，超过 2048 条时立即清理旧批次。简化 `optimiseCompletion`（第 286-318 行），移除 `completionCacheCount` 计数逻辑。

### 修复 3：文档关闭时清除 `rangeCache`（Completion.fs:55）

**文件：** `src/Main/Completion.fs`、`src/Main/Program.fs`

在 Completion.fs 中添加 `clearRangeCache()` 函数（在 lock 下设置 `rangeCache <- None`）。在 Program.fs 的 `DidCloseTextDocument` 处理器中调用它，防止已关闭文档的完整文本继续驻留内存。

### 修复 4：在 `CleanupCache` 中淘汰 `completionEntityCache`（LanguageFeatures.fs）

**文件：** `submodules/cwtools/CWTools/Game/LanguageFeatures.fs`、`submodules/cwtools/CWTools/Game/Game.fs`

在 LanguageFeatures.fs 中添加公开的 `clearCompletionEntityCache()` 函数。在 Game.fs 的 `RefreshCaches` 或 `CleanupCache` 中调用它，清除不再相关文件的已解析实体缓存。

### 修复 5：优化 GC 策略（Program.fs:414-423）

**文件：** `src/Main/Program.fs`

两项改动：
1. `RefreshCaches()` 之后强制执行**阻塞式** Gen2 GC——因为已知旧服务实例已死亡，必须立即回收：
   ```fsharp
   GC.Collect(2, GCCollectionMode.Default, true, true)
   GC.WaitForPendingFinalizers()
   ```
2. `maybeCollectGarbage()` 中将 `blocking=false` 改为 `blocking=true`，阈值从 50MB 降至 20MB——分配速率已达每分钟数 GB，50MB 阈值过于粗糙。

### 修复 6：补全缓存诊断日志（Completion.fs）

**文件：** `src/Main/Completion.fs`

在 `optimiseCompletion` 中添加日志，报告 `completionCache.Count` 和 `completionPartialCache` 状态，便于监控修复效果。

## 需要修改的文件

| 文件 | 改动 |
|------|------|
| [Completion.fs](src/Main/Completion.fs) | 修复 1、2、3、6 |
| [Program.fs](src/Main/Program.fs) | 修复 3（调用 clearRangeCache）、修复 5 |
| [LanguageFeatures.fs](submodules/cwtools/CWTools/Game/LanguageFeatures.fs) | 修复 4（添加清理函数） |
| [Game.fs](submodules/cwtools/CWTools/Game/Game.fs) | 修复 4（在 CleanupCache/RefreshCaches 中调用清理） |

## 验证方式

1. 构建：`dotnet build src/LSP/` 和 `npm run compile`
2. 持续编辑 10+ 分钟，观察 MemDiag 日志
3. 预期：每周期分配增量应稳定（不再加速），堆内存保持在 5GB 以下，`completionCache.Count` 不超过 2048
4. 验证补全功能正常工作（自动完成无回归）
