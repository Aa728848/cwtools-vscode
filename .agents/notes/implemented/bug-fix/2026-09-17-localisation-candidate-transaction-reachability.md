# Agent Note: 修复本地化候选事务不可达导致写入无法提交

Status: implemented

## Problem

在含本地化（`write_localisation`）修改的运行中，模型会陷入下面这条自相矛盾的状态机，并在截图中表现为反复"校验接口返回异常 / 状态显示 overlay 为空 / 尝试提交 / 放弃事务 / 直接落盘"：

1. `candidate_transaction begin` 创建 overlay 后，`write_localisation` 只调用 `vfsOverlay.set(...)`，**从未调用 `CandidateTransactionManager.stage(...)`**。全仓库唯一的 `stage()` 调用点在 `executeTypedPdxWrite`（`agentTools.ts`），因此纯本地化运行的事务里 `files` 恒为空。
2. 空文件列表不会被短路：`validateOverlayCatalog([])` 无告警后仍会调用 LSP `cwtools.ai.validateOverlay`。F# 侧 `Program.fs` 的准入条件为 `fileValues.Length > 0`，空数组必然返回 `ok:false`。
3. 客户端 `validateCandidateOverlay` 因此抛出 `Overlay validation returned an invalid response.`，被 `executeCandidateTransaction` 的兜底 catch 捕获后返回 `success:false`。**事务状态永远停在 `active`，`commit` 的前置条件 `state === 'validated'` 永不成立。**
4. 返回值只有单一 `error` 字符串，调用方无法区分"候选内容不合法"与"校验通道本身失败"，于是只能盲试重试、丢弃事务、改为绕过事务直接落盘。

此外还有两个放大问题：

- `candidate_transaction` 不在 `LOC_MODES`，也不在 `loc-generation` / `diagnostic-fix` 工作流 allowlist 中。本地化运行即使想管理事务也拿不到该工具，overlay 成了"只进不出"的悬空写入。
- `AgentToolExecutor.candidateContext()` 是死代码，overlay 仅通过 `vfsOverlay` getter 暴露，依赖每个调用点手动透传，`typed_pdx_write` 之外的写入路径随时可能漏传。

## Decision

按"先消除死锁、再让失败可诊断"的顺序收敛：

1. **`candidateContext()` 落地为真实注入点**：当 overlay 与 `runnerOptions` 同时存在时，产出携带 `vfsOverlay` 的新 context。该方法不再假设 `runnerOptions` 必然存在（无 scheduler 的调用已由更早的 `execute` 入口拒绝）。
2. **`write_localisation` 接入事务**：新增 `executeWriteLocalisation`，以 `candidateContext(context)` 执行 `fileHandler.writeLocalisation`，再从结果里的 `stagedFiles` 逐项 `stage()`。写入路径与 overlay 读路径现在绑定同一份 context，事务管理器的文件清单与实际被改写的 overlay 不会再分叉。
3. **回传真实候选字节**：`writeSingleLocalisation` 在 overlay 模式下返回 `stagedFiles: [{ path, content, baseHash }]`（磁盘模式不返回，因为 caller 不持有 overlay）。`baseHash` 取写入前原始字节的 SHA-256（含 BOM），仅当内容来自 overlay 时给出，与 LSP 的 base-hash 校验口径一致。多语言 `languages` 分支聚合并传递同一结构。
4. **基础设施失败与内容失败分离**：`validateCandidateOverlay` 的异常不再落入兜底 catch，而是就地返回 `infrastructureError`，事务保持 `active` 可重试；只有候选自身不合法才走 `validationError` 并置为 `failed`。
5. **空事务按 no-op 提交**：`CandidateTransactionManager.commit()` 对 `files.length === 0` 直接进入 `committed`。空列表既没有可写字节也没有漂移风险，若继续走 `validateDisk`，会把文件与它自己的基线比对，freshness 条件不可能达成，只会制造假失败。
6. **工具可见性对齐**：`candidate_transaction` 加入 `LOC_MODES` 与两个含 `write_localisation` 的工作流 allowlist。

## Alternatives considered

- **只修 F# 侧，允许空 `files` 返回 `ok:true`**：能消掉报错，但事务文件清单依旧为空，`commit` 会因为缺少 `validated` 前的候选而不做任何事，"改完没落盘"的真实缺陷被掩盖。否决。
- **validate 时对空列表直接判通过**：同样只是让错误消息消失，事务仍不知道本地化文件的存在。否决。
- **把 `write_localisation` 移出 overlay 语义、在事务内直接写盘**：会破坏候选事务"先校验后落盘"的核心保证，也会让 `typed_pdx_write` 与本地化写入产生两种提交语义。否决。
- **让 `FileToolHandler` 自行向 `AgentToolExecutor` 回灌 stage**：handler 与 executor 之间会形成反向依赖，且 `FileToolHandler` 被多处复用（含子代理路径），把事务所有权塞进 handler 会扩大 `SUB_AGENT_EXCLUDES` 的设计边界。改为只回传事实（`stagedFiles`），由持有事务的 executor 决定是否登记。否决反向依赖方案。
- **给子代理共享父事务**：`typed_pdx_write` / `candidate_transaction` 被显式排除出子代理是有意设计（见 `registry.ts` 中 `SUB_AGENT_EXCLUDES_SET` 注释）。本次不改变该边界。

## Consequences

- 纯本地化运行现在可以完整走完 `begin → write_localisation(stage) → validate → commit`，提交前磁盘保持基线内容，提交后一次性落盘并沿用既有的提交后诊断回滚保护。
- `write_localisation` 在事务外的行为不变：没有 overlay 时仍然直接写盘，返回值不含 `stagedFiles`。
- 模型不再收到歧义错误。校验通道故障时得到的 `infrastructureError` 明确指向通道，事务仍为 `active`，可直接重试 validate 而不是重做写入或丢弃事务。
- 新增约束：任何"支持 overlay、又不经 `typed_pdx_write`"的写入路径，都必须在 `AgentToolExecutor` 层回传 `stagedFiles` 并由 `executeWriteLocalisation` 这类适配器登记，否则会重演本次的空事务。后续新增此类工具时应同步补该适配。
- 回归覆盖：`client/test/unit/agentToolSafety.test.ts` 新增三个用例，分别锁定"本地化写入被事务捕获且不落盘""校验通道失败返回 `infrastructureError` 且事务保持 `active`""空事务可 no-op 提交"。
