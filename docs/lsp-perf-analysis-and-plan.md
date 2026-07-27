# LSP 性能冻结确认与改进计划

基于 `docs/lsp.txt`（15:11:58–15:20:33，Stellaris mod，约 7202–7204 个文件）及当前 LSP/CWTools 实现的复核结果。本计划区分“日志已确认”“代码强推断”和“仍需采样验证”，避免在根因尚未定量前过早选择优化方向。

## 一、结论摘要

当前存在三个相互关联、但需要分别处理的问题：

1. **40 秒级硬冻结已经确认**：`mode=full, shallow=True` 的单文件更新在写锁内进入全量校验；写锁释放前，补全、悬停和导航无法读取游戏状态。
2. **现有补全回退没有覆盖整个硬冻结窗口**：读取线程上的即时回退只在“保存后 2.5 秒”等窄时间窗内触发；未命中的请求会进入线程池，80 ms 读锁超时也只有在线程池工作流开始后才计时。日志与调度结构强烈表明这些工作流在重负载期间没有及时启动，但线程池饥饿仍需阶段 0 的分段时间戳最终确认。
3. **另有独立的 3.7–3.9 秒全局懒构建热点**：交互提交、补全和转到定义都出现约 12 GB 分配，最可疑的是全局资源版本变化使 Stellaris Carrier scope 快照失效，随后某个读/写操作成为全量快照的首个构建者。

全局 `RefreshCaches` 的 24–35 GB 分配是第四个明确热点，会放大内存、GC、线程池和后续诊断刷新压力，但不是两次硬冻结的唯一解释。

## 二、硬冻结证据

### 冻结 A：15:17:34–15:18:19

- 15:17:34 全局分析结束，随后长期没有服务端操作完成日志。
- 15:17:38–15:18:08 发起的 7 个补全请求最终全部取消，单次等待 11.0–38.6 秒。
- 冻结结束时出现：
  - `UpdateFile mode=full shallow=True allocDeltaMB=24702`
  - 同一事件文件的 save 反馈总延迟 58380 ms。
- 写操作结束后，15:18:21 起重新出现 `Completion lock-timeout fallback`，说明回退机制本身没有永久失效，而是在重负载窗口内无法及时运行。

### 冻结 B：15:19:23–15:20:03

- 15:19:21–15:19:45 发起的 3 个补全请求等待 16.8–38.7 秒后取消。
- 期间没有正常补全或 80 ms 超时回退日志。
- 冻结结束时出现：
  - `UpdateFile mode=full shallow=True allocDeltaMB=26257`
- 随后补全恢复为 8 ms；15:20:05 起再次正常产生锁超时回退。

两次冻结都以一个分配 24–26 GB 的 `full/shallow` 更新结束，并在结束后恢复服务，因此不是普通的补全算法慢，也不是永久死锁。

### 为什么“统计信息”也完全不动

当前性能摘要不是独立心跳。`maybePerfReport` 只在 lint、completion 或 delayedAnalyze 等操作结束后调用；正在执行的长操作没有中间事件，所以它未结束时日志和统计都会停止变化。

因此“统计冻结”可以确认没有操作完成，但单靠它不能区分 GC 停顿、线程池饥饿和长时间同步计算。阶段 0 会增加独立心跳和请求分段计时。

## 三、已确认的冻结调用链

`Program.fs` 在写锁内执行资源更新：

```text
lintFile
  → gameStateLock.EnterWriteLock()
  → prepared 路径不可用、被放弃或需要兼容回退
  → game.UpdateFile(shallow=true, file, text)
  → ResourceManager 更新实体
  → ValidationManager.Validate([edited entity])
  → ValidationManager.ValidateLocalisation([edited entity])
  → gameStateLock.ExitWriteLock()
```

普通单文件 `Validate` 与 `ValidateLocalisation` 都构造：

```fsharp
EntitySet(resources.AllEntities())
```

`EntitySet` 构造本身会枚举所有实体；使用 `AllEffects`、`AllTriggers`、`AddOrGetCached` 等成员的校验器还会对所有实体执行 `Lazy.Force()`。部分校验使用 `PSeq`，同时带来线程池占用和高分配。

这条链路解释了：

- 为什么单文件保存能分配 24–26 GB；
- 为什么写锁持有期间所有读取都停住；
- 为什么补全请求成批积压；
- 为什么操作结束后补全立即恢复。

### 回退为什么没有在 80 ms 后返回

代码已经提供 `completionImmediateFallback`，可直接在 LSP 读取线程返回旧缓存；但当前条件同时要求命中特定重路径、处于保存后 2.5 秒窗口，并且仍在输入或补全活跃窗口。两次冻结持续约 40 秒，时间窗过后到达的补全不会走这条路径。

其余普通补全会被放入 `processQueue`；主处理循环再用 `Async.StartWithContinuations` 把读请求启动在线程池，之后才调用 `TryEnterReadLock(80)`。

因此 80 ms 是“工作流开始执行后的锁等待上限”，不是“客户端发出请求后的总响应上限”。当线程池被并行校验占满、GC 频繁或任务调度严重延迟时，工作流本身可能数十秒后才启动，80 ms 超时保护就无法及时生效。

这是由日志和调度结构得出的强推断。阶段 0 将记录“收到请求 → 出队 → 线程池开始 → 取得锁 → 服务方法开始 → 响应写出”，对线程池饥饿做最终确认。

### 不是 Gen2 STW 的充分证据

第一次硬冻结前后 Gen2 计数都为 19，没有新增 Gen2 collection；Gen0/Gen1 和分配压力仍可能产生停顿，但现有数据不支持把 40 秒冻结主要归因于 Gen2 STW。

显式 `GC.Collect(2, Optimized, blocking=false, compacting=false)` 仍不应在写锁内触发。当前全局刷新和本地化刷新路径各有一次锁内显式 collection，应一并迁出。

## 四、独立热点：Carrier 快照全局失效

交互 prepared 路径本应只做短原子提交，但 16 次 `CommitUpdateFileInteractive` 中有 11 次写锁持有约 3.7–3.9 秒。另有：

- 补全：3719 ms、11915 MB、仅 27 个结果；
- 转到定义：3784 ms、11903 MB。

补全和转到定义的 Stopwatch 在取得读锁之后才开始，所以这两个 3.8 秒不是锁等待，而是服务方法内部的真实计算。

最需要验证的调用链是：

```text
CommitPreparedFile
  → ResourceManagerEager.nextVersion()
  → InvalidateInteractive / InfoService fold / completion or navigation
  → Stellaris scopeContextOverride
  → CarrierScopeResolver.currentSnapshot()
  → version 不匹配
  → buildSnapshot(resources.AllEntities())
```

`currentSnapshot` 当前在 `gate` 锁内完成整个全量构建。首个构建者承担全量成本，其他依赖 Carrier scope 的操作同步等待。

这与 12 GB/3.8 秒现象高度吻合，但仍需阶段 0 的 Carrier build start/end、version、entity count 和 allocation 证据确认。

## 五、其他明确热点

### 1. 全局 RefreshCaches

4 次刷新分别分配 24.1、28.2、31.7、35.4 GB；相应分析周期达到 39.3、43.5、46.9、50.6 GB。文件数基本不变而成本持续上升，需要检查保留对象、重复服务构建和全局模型增长。

`/common/`、`/events/` 等整个目录目前都被视为 type-defining path。普通正文修改也可能设置 `needsTypeRefresh`，经过静默期和冷却后触发全量重建。

刷新完成后又将约 7202 个文件全部标为待全局重校验，扩大后续工作量和 freshness 波动。

### 2. 内存和 GC 压力

约 8.5 分钟内：

- 累计分配增加约 514 GB，约 1 GB/s；
- 工作集从 4.75 GB 增至 8.08 GB，峰值 11.13 GB；
- 专用内存从 4.82 GB 增至 8.42 GB；
- 堆碎片从 0.88 GB 增至 2.13 GB；
- Gen0 增加 9353 次，Gen1 增加 210 次，Gen2 增加 11 次。

字符串和整数池只增长约 5%–7%，不是本次 514 GB 分配的主来源。未经生命周期证明，不应直接给 token 池增加 LRU。

### 3. 校验反馈统计口径

change 后服务端会立即清空旧诊断；客户端把下一次 diagnostics publication 当作校验完成。因此大量 0–1 ms 记录只是“旧诊断已清空”，不是浅层或深层校验完成。

`superseded` 表示同一 URI 的观测请求被新输入替换，主要证明防抖正在合并输入，不等于已经浪费执行了同等数量的真实校验。

## 六、正确性约束

性能修改必须保持以下约束：

1. 实体、名字索引、类型索引和 model epoch 必须原子提交；重计算放在锁外，提交 diff 放在写锁内。
2. 名字索引不能只是 `EntityType -> Set<string>`。必须支持重复定义、mod 覆盖、删除和重命名，建议维护：
   - `source file -> names`
   - `name -> source files/refcount`
3. 反向引用索引只对已覆盖的依赖做精准 stale 传播。动态调用、模糊引用、本地化和未知依赖必须保守回退，不能误报 Fresh。
4. `ValidationManager` 是多游戏共享实现。删除 `os` 或改变 validator contract 前，要么审计所有游戏，要么增加 capability/惰性查询接口，不能只凭 Stellaris 审计直接改共享语义。
5. 新缓存必须有完整 epoch key、并发保护和明确容量上限；不能只用 `baseFrozenTypeMap` 引用作为 `RuleValidationService` 的缓存条件。
6. 延迟执行的全局诊断必须保留独立 freshness domain，不能用局部校验结果覆盖或清除。

## 七、落地计划

### 阶段 0：增加能够捕获冻结的观测

目标：一次复现即可区分同步计算、锁等待、线程池饥饿、GC 和 Carrier 全量构建。

1. 给 LSP 请求增加分段时间戳：
   - reader 收到请求；
   - `processQueue` 出队；
   - thread-pool workflow 开始；
   - 读锁等待开始/结束；
   - server method 开始/结束；
   - response 写出。
2. 增加有界的运行时快照：processQueue 长度、pending request 数、ThreadPool available/max/pending、writer active/waiting、reader count。
3. 使用独立 `Thread` 更新内存中的单调时钟心跳，不依赖线程池和日志输出；操作恢复后报告最大 heartbeat gap：
   - 心跳也停止：进程级 GC/OS suspend；
   - 心跳正常但 workflow 未开始：线程池饥饿；
   - workflow 已开始但锁未取得：锁竞争；
   - 锁已取得但 method 未结束：同步计算或内部锁。
4. 对 `UpdateFile` 增加总耗时和子阶段统计：prepare/commit、inline scripts、afterUpdateFile、invalidate、Validate、ValidateLocalisation。
5. 对 Carrier snapshot 增加 hit/miss/build start/build end/version/entity count/elapsed/allocation。
6. 用 PerfView 或 `dotnet-trace` 采集一次冻结窗口：GC pause、allocation tick、contention、ThreadPool queue 和 CPU stack。
7. 将验证观测拆为 `diagnostics-cleared`、`shallow-complete`、`deep-complete`，并带 document/model version。

验收：日志必须能对一次 5 秒以上请求给出唯一主等待阶段，不能再只看到最终总耗时。

### 阶段 1：先消除硬冻结

目标：重负载时也能及时返回降级补全，任何单文件更新不得在写锁内运行全量校验。

1. 将编辑/保存更新统一拆为：
   - 锁外 parse/prepare；
   - 写锁内只提交 prepared resource 和已准备好的索引 diff；
   - 读锁或 detached snapshot 下执行浅层/深层验证；
   - prepared 失败时不回退到写锁内 `game.UpdateFile + Validate`，而是发布 pending 状态并调度安全重试。
2. 复用现有 `completionImmediateFallback`，用原子 `editorWriteBusy`/`heavyValidationActive` 状态替代“保存后 2.5 秒”的主要判定。读取线程发现实际写锁或重校验仍活跃时，直接在 reader thread 返回只读的 stale completion fallback，不再把“80 ms 保护”依赖在线程池调度之后；时间窗只作为次级提示，不能作为冻结保护的生命周期。
3. 保留回退结果的版本、prefix 过滤和 `isIncomplete=true`；写操作结束后只对最新光标位置触发一次刷新。
4. 将全局刷新和本地化刷新中的显式 Gen2 collection 全部移出写锁；优先在空闲期执行，活跃补全窗口内跳过。
5. 为写锁增加硬预算告警，例如 hold >100 ms 即记录子阶段和当前全局构建状态。

验收：

- 写锁 hold P95 <50 ms，最大值 <200 ms；
- 重负载期间 stale completion P99 <150 ms；
- 不再出现 >2 秒且没有 fallback 的补全请求；
- 保存后立即在另一文件连续输入，编辑器仍能持续返回补全或明确降级结果。

### 阶段 2：移除单文件校验的全量 EntitySet

目标：局部校验只处理当前实体和稳定索引，全局报告进入后台域。

1. 审计所有游戏 validator 对 `oldEntities` 的成员使用，形成覆盖表和回归样例。
2. 将 validator 输入拆为明确查询接口，而不是始终物化 `EntitySet`：
   - 当前变更实体；
   - 名字/类型/枚举存在性索引；
   - 仅全局 validator 可请求的惰性全实体视图。
3. 删除经全游戏审计确认未使用的 `validateLocalisation oldEntities` 物化。
4. Stellaris 的 `validateVariables` 使用现有 scripted-variable/inline-caller 索引。
5. 为 gfx asset、graphical culture、ship section/component 名字建立 source-aware 增量索引。
6. `unused technology`、`unused type`、event-chain 等项目级检查移入后台 global-validation domain。

正确性验证必须比较完整、排序后的诊断集合，而不是只比较 errors/warnings 总数：

```text
(file, code, severity, range, message, relatedErrors/data)
```

覆盖创建、删除、重命名、重复定义、mod 覆盖、inline script、动态定义和取消路径。

验收：单文件浅校验不枚举全部实体；交互更新的归属分配显著低于基线，目标 P95 <100 MB。

### 阶段 3：拆分 Carrier 和资源版本

目标：普通文件编辑不再使 Carrier 全局快照无条件失效。

1. 将全局 `ResourceManagerEager` version 拆为至少 resource、carrier-relevant、type/rules、localisation epoch。
2. 只有影响 Carrier 推断输入的路径或 semantic delta 才推进 carrier epoch。
3. `buildSnapshot` 移出 `gate` 长临界区：采用 single-flight staged build，锁内只检查 epoch 和原子发布结果。
4. 为 Carrier 输入建立文件级贡献和增量 diff；无法增量时在后台重建，前台读取旧的版本化快照并标记 incomplete/pending。
5. 保证旧快照不会与新实体对象混用：结果必须携带 resource/carrier epoch，并在发布前核对。

验收：普通 `component_sets`、`section_templates`、`solar_system_initializers` 编辑后，不再出现约 12 GB/3.8 秒的首次补全、导航或交互提交。

### 阶段 4：减少全局 RefreshCaches

目标：按 semantic delta 和诊断 domain 精准刷新。

1. 收窄 `isTypeDefiningPath`；目录位置只作为保守提示，实际以新增/删除定义、类型 ID、规则贡献和服务依赖变化为准。
2. 细化 `semanticDelta.requiresFullRefresh`：
   - semantic no-op 不刷新；
   - TypeIndexOnly 只提交索引；
   - scripted services 只重建受影响服务；
   - 只有无法证明安全时才全量刷新。
3. 全量刷新后不要无条件把全部文件标为 pending；按 domain 和反向依赖传播，未知依赖保守回退。
4. 对全量刷新增加 single-flight、取消旧 staged 结果、静默期和最小间隔；不能并行保留多个大型候选模型。
5. 分别统计 prepare 与 commit 的耗时/分配，保证 staged commit 仍是短原子交换。

验收：相同编辑序列中的全量刷新次数显著下降；若确需全量刷新，前台补全仍满足阶段 1 的延迟目标。

### 阶段 5：内存和次要成本

1. 评估缓存 `prepareTypeIndex` 的临时服务，但缓存键必须覆盖 rules、types、enums、variables、files、localisation 和 lookup epochs，且使用单项或小容量上限。
2. `getDiagnosticSnapshot` 改为经过不变量测试的原子增量计数器；这是日志开销优化，不列为主要内存修复。
3. 对 String/Int token 池先做来源和存活分析。只有能够证明旧 epoch 不再被 AST/Map/索引引用时，才允许整 epoch 回收；不直接使用普通 LRU 或复用 token ID。
4. 记录重复刷新后老服务、旧快照和大型 FrozenDictionary 的存活路径，修复实际保留引用。

验收：固定 100 次编辑脚本完成后，强制稳定观察窗口中的 heap/private/fragmentation 能回落并趋于平台，不随每轮刷新线性增长。

## 八、复现与验证矩阵

### 固定操作序列

1. 保存一个大型 events 文件，立即在另一个 common 文件连续触发补全。
2. 编辑 section template，再执行补全和转到定义。
3. 连续编辑并保存 solar initializer、section template、component set、event 各 25 次。
4. 创建、重命名、删除带重复定义和覆盖关系的文件。
5. 编辑 scripted trigger/effect、inline script 和引用它们的调用文件。

### 核心指标

- reader receive → response 的 completion P50/P95/P99；
- workflow 调度延迟、lock wait、method execution 分布；
- stale/immediate/timeout fallback 次数与延迟；
- 每种 UpdateFile 模式的 elapsed、allocation、write hold；
- Carrier snapshot build 次数、命中率、elapsed、allocation；
- RefreshCaches prepare/commit 次数与成本；
- GC pause、ThreadPool queue、heartbeat gap；
- heap、working set、private、fragmentation 的稳态趋势；
- 完整诊断集合与全量基线的一致性。

### 构建与测试

- 子模块修改先在 `submodules/cwtools` 内单独提交，再更新根仓库指针。
- F# 后端至少运行：
  - `dotnet build src/LSP/`
  - `dotnet build src/Main/`
- 每个可观察行为修改都增加针对性回归测试。
- 阶段 2–4 必须运行增量与全量结果对照测试，并覆盖取消、超时和并发编辑。

## 九、实施优先级

| 优先级 | 工作 | 目的 |
|---|---|---|
| P0 | 阶段 0 请求/线程池/Carrier/心跳观测 | 对冻结做最终分段定性 |
| P0 | 阶段 1 写锁外验证与 reader-thread 回退 | 先恢复编辑器可用性 |
| P1 | 阶段 2 局部校验去全量 EntitySet | 消除 24–26 GB 单文件更新 |
| P1 | 阶段 3 Carrier epoch/快照增量化 | 消除独立的 12 GB/3.8 秒热点 |
| P2 | 阶段 4 精准刷新 | 降低 24–50 GB 全局周期频率 |
| P3 | 阶段 5 内存保留和日志微优化 | 收敛长会话内存 |

第一轮实现不应从 token LRU、诊断计数器或提高增量 patch 上限开始；应先完成冻结探针和写锁外验证，因为它们直接决定编辑器是否可用，也为后续所有分配优化提供可信基线。

## 十、落地状态（2026-07-27）

本节记录实际进入代码的机制；原计划中的延迟、分配和内存阈值仍须在原始约 7200 文件工作区用固定矩阵复测，未把小型测试夹具结果冒充大型工作区验收结果。

### 已完成

- 阶段 0：LSP 请求已经记录 reader receive、processQueue、worker start、lock wait、method 和 response write 分段；独立 OS thread 心跳记录最大 gap，并同时输出 ThreadPool、队列、reader/writer 和 pending 状态。Carrier build 记录 epoch、命中/未命中、实体数、耗时和分配。
- 阶段 1：编辑和磁盘 watcher 更新统一使用锁外 parse/prepare、锁内短提交、锁外/读锁校验。prepared commit 失败只保留 pending 并做最多两次有界重试；不再进入写锁内 `UpdateFile + full validation`。全量刷新也只允许锁外 prepare 和锁内 guarded commit；prepare、commit 或 resource epoch 失配时丢弃 staged 结果并延后重试。completion 在 writer/validation 活跃时从 reader thread 直接返回带 `isIncomplete=true` 的 stale/empty fallback。显式 Gen2 GC 已移出写锁并避开活跃补全。
- 阶段 2：局部和全局 validator 使用不同类型契约。局部结构/lookup validator 只能接收 changed entity set；兼容适配器给 legacy validator 注入“访问即失败”的 workspace view，防止以后重新引入隐式全量枚举。所有游戏配置已经按 local/global domain 审计；Stellaris 项目级变量、船型、图形和 unused/event-chain 等检查保留在 global domain。局部 localisation 不再物化 old entities。回归测试验证误分类会立即失败。
- 阶段 3：资源版本拆为 resource、Carrier、type/rules、localisation 和 file-set epoch。Carrier 文件贡献使用忽略位置、注释和 trivia 的语义指纹；只有 old/new fingerprint 不同才推进 Carrier epoch。普通资源编辑和 comment-only event 保存不会失效 Carrier。快照使用 epoch + generation、`Lazy<Task<_>>` single-flight、单 build lane、旧快照 fallback 和发布前 guard；构建输入只保留 Carrier 贡献文件，不再把所有 workspace entity 送入多轮推导。删除和 inline caller 更新也覆盖失效传播。
- 阶段 4：`SemanticDecision` 已成为唯一刷新决策，删除了可被误用的 `requiresFullRefresh` 布尔路径。semantic no-op、TypeIndexOnly、ScriptedServices 和 FullRefresh 分开提交；创建、变更和删除统一进入 staged delta 流程。superseded commit 不再错误排队全量刷新。全量 refresh 由 lint agent 串行 single-flight，并用 resource/lookup guard 拒绝过期候选；失败不会在写锁内二次构建。
- 阶段 5：`prepareTypeIndex` 的临时 validation service 使用单项有界缓存，key 覆盖 config/rules identity、type map identity、type/rules epoch、localisation epoch 和 file-set epoch；scripted clone 路径显式绕开缓存。诊断摘要改为写入时维护的原子计数，不再每次性能日志枚举所有文件。缓存日志增加完整 epoch 和容量快照。没有对 String/Int token ID 使用不安全 LRU 或复用。
- 验证反馈现在区分 `diagnostics-cleared`、`shallow-complete` 和 `deep-complete`，并携带 document version、model epoch、freshness、pending domains 和诊断数。
- 新增 `tools/perf/capture-lsp-trace.ps1`、`tools/perf/README-lsp.md`，并扩展 `lsp-memory-profile.mjs` 支持固定 N 次 comment-only edit/save/completion 和稳定观察窗口。

### 已执行验证

- `dotnet build src/LSP/ --no-restore`：通过。
- `dotnet build src/Main/ --no-restore`：通过。
- `dotnet build submodules/cwtools/CWToolsTests/CWToolsTests.fsproj --no-restore`：通过。
- CWTools 全量测试：新增 local-validator contract 和 Carrier fingerprint 测试均通过；总计 228 passed、6 skipped。另有 1 个仓库既有的 partial on_action completion 语义断言失败，与本性能改动无关，未通过改变产品补全语义来掩盖。
- 小型 44 文件 Stellaris fixture 的 100 次自动编辑冒烟：完成且进程正常退出；`carrierEpoch` 保持 1，没有 Carrier rebuild 或 FullRefresh；诊断最终为 44 fresh、0 pending、0 stale；缓存容量没有随编辑次数增长。该运行只验证机制和脚本，不替代大型工作区阈值验收。

### 仍需外部数据的验收

在原始大型 mod 上运行 `tools/perf/README-lsp.md` 的矩阵并保留 `.nettrace` 后，才能填写 write-lock P95/P99、completion P99、Carrier/RefreshCaches 分配、GC pause 以及五分钟稳定窗口的 heap/private/fragmentation 数值。代码和采集入口已经就绪，但这些环境相关指标不能在没有目标工作区的情况下诚实地声明达标。
