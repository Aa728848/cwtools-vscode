# Agent Note: 消除写者等待造成的编辑锁冻结（编辑时高亮/补全/悬停静默失效）

Status: implemented

## Problem

用户在 VS Code 问题栏中反复切换文件时，编辑器会周期性"卡锁"：悬停、高亮、补全、CodeLens、语义着色全部不出现，持续数十秒。

`docs/Memdiag.txt` 现场日志给出完整证据链：

1. **读者被饥饿**：冻结窗口内 `textDocument/hover`、`documentHighlight`、`inlayHint`、`documentSymbol`、`codeAction`、`codeLens`、`semanticTokens` 请求全部以 `lockWaitMs≈500`、`lockAcquired:false`、`outcome:cancelled` 结束，且快照恒为 `readerCount=1`、`waitingReadCount=N`、`waitingWriteCount=1`、`writerActivityCount=1`。500ms/80ms 是 `editorRequestLockTimeoutMs`/`completionLockTimeoutMs` 的超时上限，超时后按设计返回 `null`/`[]` 空回退，因此表现为功能"消失"而非报错。09:23:37–09:24:18 期间这种失败连续出现约 40 秒。
2. **根因是写者优先语义**：`gameStateLock` 是 `ReaderWriterLockSlim`。只要存在处于等待状态的写者，所有新读者都会被阻塞，即使当前持锁者只持有读锁。实测复现（读者持读锁 3s + 写者等待）：三次 `TryEnterReadLock(500)` 全部 500ms 超时；改为轮询获取的写者则全部 0ms 成功。
3. **触发者是一次长读锁持有**：延迟动态重校验 `revalidateDeferredDynamicFiles` 在**单次** `EnterReadLock()` 内对最多 `dynamicDeferMaxFiles = 500` 个文件执行 `ValidateFilesLocalCancellable`。日志实测同一批 500 文件的 `elapsedMs` 为 1060 / 6792 / 37227 / 37617ms，单批分配 1.7GB–42GB。批量运行期间读者本身可并发，但一个排队写者即把整段时间转成对所有编辑读请求的完全封锁。
4. **两个被实证的写者等待点**：
   - `Program.fs` 刷新/分析周期：09:23:36 `analyze-begin` → 09:24:08 `analyze-complete`（`elapsedMs=31711`），期间 `doRefresh=false`、待校验域为空、只有"刷新缓存·已跳过"，说明该周期**什么也不需要做**，却仍在 `enterGameStateWriteLock()` 上等待约 32 秒，并因此封锁全部读者；
   - `Program.fs` 交互更新提交：日志 `CommitUpdateFileInteractive wait=6746ms hold=0ms`，等待 6.7 秒期间同样封锁全部读者（该窗口内 09:24:15 补全走立即回退，`writerBusy=True`、`结果数: 0`）。

## Decision

1. **`src/LSP/Locking.fs` 新增 `tryAcquireWriteLockPolling`**：以 `TryEnterWriteLock(0)` + 短间隔睡眠轮询获取写锁，预算耗尽返回 `false`。零超时不会进入"写者等待"状态，因此等待期间读者不被阻塞（实测读者 0ms 获取）；预算内读者释放后写者即刻获得锁。若已有写者排队（`WaitingWriteCount > 0`）则不参与竞争，避免插队。
2. **`src/LSP/LanguageServer.fs` 新增 `tryEnterGameStateWriteLock budgetMs` 与 `gameStateWriteLockPollBudgetMs`（默认 10000ms）**：包装上述轮询获取，并且**仅在真正持锁后**才自增 `gameStateWriterActivityCount`。`isGameStateWriteBusy()` 的语义因此收窄为"写者正在修改模型"，单纯的等待不再触发补全立即回退。挂起式 `enterGameStateWriteLock()` 仅保留给已核实无法与批量读锁竞争的启动路径。
3. **刷新/分析周期（`Program.fs` `delayedAnalyzeUnsafe`）**：引入 `refreshNeedsRootWriter = doRefresh || needsTypeRefresh || delayedLocUpdate || scriptLocalisationDue`。该值为假时（本周期既不改模型也不提交暂存结果）完全不获取写锁，直接记 `RefreshCaches skipped pending=false`；为真时改用 `tryEnterGameStateWriteLock`，预算内未获得则记 `RefreshCaches write_lock_busy`、丢弃暂存候选（`stagedRefresh` 置空、本地化暂存交 `abandonedLocalisationStage` 供 `DiscardLocalisationRefresh` 释放）、`refreshSkipCount` 自增，并保留所有待处理域与 `delayedLocUpdate`，交由既有空闲/唤醒路径重试。
4. **交互更新提交（`Program.fs` `lint`）**：改用 `tryEnterGameStateWriteLock`；预算内未获得时不进入提交体（不调用 `exitGameStateWriteLock`），记录 `Interactive update commit deferred` 诊断日志，并复用既有"未提交"结果 `(…, preparedUpdateCommitted=false, updateSuperseded=true)`，从而自动走 `preparedCommitRetryRequested` 的既有重试与 `markFileStale` 路径。
5. **增量类型提交（`Program.fs` `lint`）**：新增 `commitWriteLockPollBudgetMs = 45000`（覆盖实测最长约 38s 的批量读锁持有）与 `TypeCommitDeferred` 结果；轮询未获得写锁时**不进入提交体**，结果落到既有的保守分支（`needsTypeRefresh`、`addPendingRefreshDomains ["types";"rules"]`、`clearTypeCaches`、`markFileStale`，`reason=commit_write_lock_busy`）。同时新增 `writeLockWaitBudgetMs = 1000` 的 `WriteLock wait budget exceeded` 观测日志，补齐此前只监控 hold、不监控 wait 的盲区。
6. **inline script 调用点提交（`Program.fs` `refreshDynamicCallSitesForDefinition`）**：同样改为轮询获取；预算耗尽时记 `RefreshInlineScriptCallers deferred` 并走保守全量刷新，不发布未提交的调用点列表。
7. **LSP 写请求与需写锁通知（`src/LSP/LanguageServer.fs`）**：写请求改用轮询获取，失败时以 `TimeoutException` 映射为既有 `RequestTerminalCause.Timeout`（响 `-32000`），避免为一次请求停放写者并连带拖住整个邮箱线程；`DidChangeConfiguration` 这类不可丢弃的通知在预算耗尽时改为延迟重新入队（`notificationRequeueDelayMs = 250`，计数节流打印），邮箱保持空闲、设置变更不丢失。`Initialized` 的实现体为空，改为不再获取写锁。
8. **文件删除（`Program.fs` `DidChangeWatchedFiles` 两个删除分支）**：同样改为轮询获取。本地化删除在预算耗尽时返回既有的 `LocalisationDeleteCapabilityUnavailable`（保持待处理并 `postRefreshWake`），增量贡献删除在预算耗尽时保持 `handled=false`（走既有 `needsTypeRefresh` 兜底），两者都新增 `RemoveLocalisation deferred` / `Incremental staged delete deferred` 观测日志。
9. **`reloadrulesconfig` 递归缺陷（`Program.fs` `ExecuteCommand`）**：先用 `gameStateLock.IsWriteLockHeld` 判断当前线程是否已持有根写锁（LSP 写请求路径已持有），仅在未持有时用轮询变体获取，并按是否由本处获取决定是否释放；未获得时保留"上一次规则仍生效"的既有日志路径，避免误报"被更新快照取代"。
10. **删除死代码 `publishPreparedWorkspaceUnderRootLock`**：全仓库无调用者（已核实），其挂起式获取随之移除。
11. **回归保护**：`src/LSP/Locking.Tests.fsx` 直接对锁原语做行为断言（挂起写者必须阻塞读者、轮询写者不得阻塞读者、预算内交接成功、不插队、零预算不轮询且不残留等待者）；`src/Main/RefreshLockIntegration.Tests.fsx` 增加源码护栏，逐个禁止刷新周期、交互更新提交、增量类型提交、inline 调用点提交、两个删除提交段重新出现挂起式 `enterGameStateWriteLock ()`，断言各自保留 `TypeCommitDeferred` / `RefreshInlineScriptCallers deferred` / `LocalisationDeleteCapabilityUnavailable` / `Incremental staged delete deferred` 等延后路径，并限制 `Program.fs` 中挂起式获取数量不超过 4 处（仅剩已核实的启动/命令路径）；`client/extension/memDiagFormatter.ts` 与 `client/test/unit/memDiagFormatter.test.ts` 为新的 `write_lock_busy` 状态补中英双语标签。

## Alternatives considered

1. **把批量校验切成小批以缩短读锁持有时长**：已拒绝。`validateDynamicLocal` 每次调用都要构建全工作区的 `EntitySet(resources.AllEntities())`，并在有 inline script 时对全工作区做 `Map` 折叠；固定开销与改动文件数无关（同一 500 文件批次耗时从 1.06s 到 37.6s）。切分会让固定开销按批数倍增，可能让总耗时恶化数倍。
2. **让读者忽略等待中的写者（改读优先）**：已拒绝。`ReaderWriterLockSlim` 不提供读优先策略；取消写者优先会让写者被持续到达的短读请求饿死，导致模型提交（编辑入库、类型提交）长期无法落地。
3. **把延迟动态重校验整体推迟到用户空闲**：已拒绝（本次）。这会改变动态参数诊断的新鲜度语义；本次只修复锁等待拓扑，不改变诊断刷新策略。
4. **挂起式写者固定使用 `TryEnterWriteLock(timeout)` 超时**：已拒绝。该 API 在等待期间同样处于"写者等待"状态，仍会阻塞读者整个超时窗口，而 500ms 的读者预算经不起任何 250ms 级别的写者等待叠加。
5. **对增量类型提交采用"短预算 + 复用 `TypeCommitSuperseded`"**：已拒绝。核实后 `TypeCommitSuperseded` 分支只写一条 `monitorLog`，既不 `markFileStale`、不请求全量刷新，也没有任何重驱动机制；它的安全性当前完全依赖"被更新的快照覆盖"（`lintSnapshotStillCurrent()`），而锁竞争导致的延后并不满足该前提，会让已提交类型索引与诊断新鲜度脱节。因此该站点改为"长预算轮询 + 预算耗尽后走既有的保守全量刷新分支（`needsTypeRefresh`/`addPendingRefreshDomains`/`clearTypeCaches`/`markFileStale`）"，并新增可观测的 `TypeCommitDeferred` 结果。

## Consequences

- **收益**：写者等待不再转化为读者封锁。批量校验持有读锁期间，悬停、高亮、补全、语义着色、CodeLens 恢复正常（等待上界退化为"实际写锁持有时间"而非"写者等待时间"），问题栏来回切换文件的周期性卡锁消失；分析周期在无事可做时彻底不再触碰写锁，删除了一处纯属浪费的 30 秒级等待。
- **已收敛的写者站点**：分析/刷新周期（`delayedAnalyzeUnsafe`，仅在有实际工作且空转的 `not refreshNeedsRootWriter` 分支完全不取写锁）、交互更新提交（`lint`）、增量类型提交（`lint`，预算耗尽→`TypeCommitDeferred`→保守全量刷新）、inline script 调用点提交（预算耗尽→保守全量刷新并记 `RefreshInlineScriptCallers deferred`）、`reloadrulesconfig`、以及 LSP 层的写请求与需写锁通知。
- **`reloadrulesconfig` 的既有缺陷同时被修复**：该命令被 `Commands` 归类为写命令，因此 LSP 已在邮箱线程持有根写锁，而处理器原先再次 `enterGameStateWriteLock ()`；在 `LockRecursionPolicy.NoRecursion` 下这必然抛 `LockRecursionException`（已用最小复现确认："Recursive write lock acquisitions not allowed in this mode"）并返回 `-32603 Internal error`。现在只在未持锁时才获取（且使用轮询变体），使该命令可以正常提交规则。
- **`Initialized` 不再获取写锁**：其实现体为空（`async { () }`），原先仅为一个空操作排队等待写锁；去掉后启动阶段少一次无意义的写者排队。
- **锁等待预算耗尽后的行为变化**：批量校验持续超过预算时，交互更新提交改为本轮不提交并走既有重试路径（最多 `maxPreparedCommitRetries` 次重新 lint），分析周期改为推迟到下一次唤醒，增量/inline 提交改为保守全量刷新，LSP 写请求返回 `-32000 Request timed out`，需写锁的通知改为延迟重新入队（不丢设置变更、邮箱保持空闲）。除 LSP 写请求外都保留待处理状态并在后续周期收敛；最坏情况是相关文件诊断短暂保持待校验态（既有 `markFileStale`/`pending` 语义，并输出 `write_lock_busy`、`deferred`、`WriteLock wait budget exceeded` 日志）。
- **仍保留挂起式写者的站点（已核实为低风险且各有理由）**：`Program.fs` 中规则候选激活（仅当工作区把 `.cwt` 目录设为手动规则根时可达，且其失败路径语义为"候选被拒绝"，需要独立消息设计）、`finishBackgroundRulesUpdate` 的启动规则提交与"无模型时的分离式工作区发布"（后者在 `gameObj.IsNone` 时运行，此时不存在批量校验读锁，无法产生该竞争）、`DidChangeConfiguration` 的工作区重载（跳过会导致工作区未加载，需要"重触发重载"而非丢弃的独立设计）。原死代码 `publishPreparedWorkspaceUnderRootLock` 已确认无调用者并删除。
- **观测口径变化**：`writerActivityCount=1` 现在只反映真实写锁持有；新增 `RefreshCaches write_lock_busy`、`WriteLock wait budget exceeded`、`TypeCommitDeferred`、`RefreshInlineScriptCallers deferred`、`Deferred notification`(dprintfn) 等可定位信号；`WriteLock hold budget exceeded` 仅在同一次进入真正持锁后超预算时输出。
