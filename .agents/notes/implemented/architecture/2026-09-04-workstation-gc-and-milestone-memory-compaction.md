# Agent Note: 语言服务器 GC 架构调整与里程碑大对象堆压缩收缩

Status: implemented

## Problem
在加载群星原版完整数据（`D:\Steam\steamapps\common\Stellaris`）与大型模组（如 Kuat Ancient Empire）后，`CWTools Server`（.NET 10 语言服务器进程）物理内存工作集达到 12.6 GB。
通过 `dotnet-counters` 与 `dotnet-gcdump` 现场取证诊断，发现以下两项结构性原因导致内存严重虚高：
1. `Main.fsproj` 启用了 `<ServerGarbageCollection>true</ServerGarbageCollection>`。Server GC 为每个 CPU 核心分配独立堆段，在 16+ 核心多线程并发初始化与规则校验下，向 Windows 提交了 12.2 GB 的 Committed 内存，且由于整机内存未达到临界压力，CLR 保留了 5.5 GB 的闲置堆段拒绝向操作系统退还；
2. 校验与初始化产生大量 ≥85KB 临时数组进入大对象堆（LOH），且 .NET 默认从不对 LOH 压缩，导致 1.63 GB 的不可复用内存碎片孔洞；同时 `maybeCollectGarbage()` 使用 `Optimized` 模式，导致常规回收几乎处于空转状态。

## Decision
1. **服务端切换为 Workstation GC**：修改 `src/Main/Main.fsproj`，将 `ServerGarbageCollection` 设置为 `false`，遵循桌面 IDE 语言服务器标准架构，使用单一 Workstation 托管堆，杜绝多核多堆段的乘数膨胀，并允许后台 GC 积极向 Windows 操作系统退还空闲 Committed 页面；
2. **实现深度收缩逻辑 `forceTrimMemory`**：在 `src/Main/Program.fs` 中引入显式的两阶段带压缩回收：
   - 显式设置 `GCSettings.LargeObjectHeapCompactionMode <- GCLargeObjectHeapCompactionMode.CompactOnce`；
   - 触发带压缩的完整垃圾收集 `GC.Collect(2, GCCollectionMode.Aggressive, true, true)` 并配合 `WaitForPendingFinalizers`；
3. **在三大业务里程碑边界精准触发收缩**：
   - 工作区准备发布完成（`completePreparedWorkspacePublication`）：清理初始化反序列化、AST 树构建与初始诊断的临时碎片；
   - 全量后台规则校验结束（`startFullWorkspaceBackgroundValidation` finally 尾部）：清理数千个文件切片批处理与 2.2 万条诊断生成过程中的海量中间对象；
   - 原版快照重新生成后（`checkOrSetGameCache`）：清理重新解析原版的大量文本与词法缓冲；
4. **常规交互 GC 调整**：将 `maybeCollectGarbage` 中的模式从 `Optimized` 调整为 `Forced`，仍保持非阻塞以保证打字与补全零卡顿。

## Alternatives considered
1. **强制要求用户依赖静态打包的旧 `stl.cwb` 并不载入原版游戏**：已拒绝。群星版本更新频繁，旧快照缺乏新版本 triggers/effects 会造成大量假阳性报错；且通过本地实际原版生成 520MB 完整快照是保证 100% 规则准确性的基石，不应牺牲功能保真度换取内存；
2. **仅在打字或每次保存文件时强制执行 Full GC**：已拒绝。这会导致严重的编辑器卡顿与交互掉帧；显式深度修剪仅严格限制在初始化完毕、后台全量批处理结束等处于空闲等待的宏观业务转折点。

## Consequences
- **预期收益**：消除了 16+ 核心堆段导致的 5.5 GB 闲置 Committed 内存扣押与 1.63 GB 的 LOH 碎片，预计物理工作集从 12.6 GB 压缩至 4.5~5.2 GB 真实存活基线（内存降幅超 60%）；
- **已知权衡**：全量初始化与批处理校验吞吐量受单 GC 线程影响可能微增 3%~8% 的用时（约 1~2 秒），但日常打字、代码补全、悬停因后台并发 GC 保持零停顿，且系统分页压力大幅减轻。
