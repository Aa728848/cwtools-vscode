# Agent Context and Persistence Improvement Plan

This plan hardens the existing VS Code agent runtime without replacing its
domain-specific LSP tools, multi-agent DAG, or quality gates. The target is a
single durable contract shared by context compaction, crash resume, run replay,
and the Agent Manager timeline.

## Codex-derived design principles

- Separate the durable full transcript from the bounded active model context.
- Treat append-only run events as the audit trail and atomic snapshots as a fast materialized view.
- Compact only at structurally safe boundaries; never lose system policy or split a tool exchange.
- Make task discovery, resume, and recorded-tool replay work after the host process restarts.
- Keep approvals scoped to the process session unless a future explicit durable policy is designed.

Reference baseline: the [Codex repository](https://github.com/openai/codex), its
[compaction implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs),
[thread/turn/item persistence contract](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
and [memory pipeline](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md).

## Whole-agent improvement matrix

| Area | Project baseline | Plan outcome |
| --- | --- | --- |
| Repository guidance | Root `AGENTS.md`, bilingual architecture/contribution guides | Keep; no replacement needed |
| Structured tools and semantic reads | Registry metadata, LSP-first reads, MCP contracts | Keep; preserve registry as source of truth |
| Sandbox and approvals | Mode guard, command preflight, cwd scopes, sub-agent sandboxes | Harden restart boundary so session approvals never persist |
| Context compaction | CJK-aware budgeting, rolling summaries, manual/mid-loop compaction | Canonical boundaries and provider-independent system-context preservation |
| Checkpoint and resume | V2 compact tail plus transcript archive | Deliver atomic V3 with checksums, backups, stable event cursors, and V2 migration |
| Run audit and replay | JSONL events, reducers, Agent Manager, recorded-tool replay | Deliver ordered durable writes, prompt artifacts, disk discovery, and restart replay |
| Long-term memory | Bounded topic memory and structured compacted summaries | Keep as the explicit user/project memory layer; do not mix it with crash state |
| Multi-agent and verification | DAG, blackboard, worktree isolation, quality gates, release checks | Keep; validate new persistence contracts through focused and full gates |

## Scope and acceptance criteria

1. **Canonical transcript integrity**
   - Never persist orphan or duplicate tool responses.
   - Synthesize interrupted results for unfinished tool calls.
   - Preserve complete assistant-tool groups at resume and compaction boundaries.
   - Preserve the original system instructions through every compaction path.
2. **Durable V3 resume state**
   - Write state and transcript snapshots atomically with a recoverable backup.
   - Record transcript checksums, message counts, and the latest stable ledger event.
   - Load V2 states for compatibility and recover from a damaged primary file.
   - Never persist or restore `sessionOnly` approval rules.
3. **Replayable runs**
   - Archive the complete original user prompt outside the bounded event payload.
   - Resolve prompts and run snapshots after an Extension Host restart.
   - Persist small recorded tool results; retain artifact references for large results.
4. **Ordered event persistence**
   - Serialize per-run event/state writes so JSONL order matches monotonic sequence order.
   - Atomically replace `run_state.json` and tolerate a malformed final JSONL line.
5. **Verification and documentation**
   - Cover transcript normalization, compaction boundaries, V2 migration, backup recovery,
     permission isolation, disk replay, and concurrent event ordering with unit tests.
   - Keep the bilingual architecture and contribution guides synchronized.

## Delivery phases

- Phase A: shared atomic-storage and canonical-transcript primitives.
- Phase B: V3 checkpoint/resume migration and approval-boundary hardening.
- Phase C: durable RunLedger prompt artifacts, disk discovery, and replay recovery.
- Phase D: compaction integration, tests, documentation, and full verification.

## Non-goals

- Full replay that re-executes mutating tools.
- OS-level command sandboxing and background terminal management.
- Replacing the current multi-agent DAG or worktree merge strategy.

## Completion record

- [x] Shared canonical transcript and atomic storage primitives.
- [x] V3 resume state with V2 compatibility, checksums, backups, and permission isolation.
- [x] Prompt artifacts, ordered RunLedger persistence, disk discovery, and restart-safe replay.
- [x] Provider-independent system-prompt preservation through compaction.
- [x] Focused tests for structural integrity, migration, recovery, concurrency, and replay.
- [x] Bilingual architecture and contributor documentation.

---

# Agent 上下文与持久化改进计划

本计划在保留领域 LSP 工具、多 Agent DAG 和质量门禁的前提下，加固现有
VS Code Agent Runtime。目标是让上下文压缩、崩溃恢复、运行回放和 Agent
Manager 时间线共同使用一套可持久恢复的契约。

## 从 Codex 借鉴的设计原则

- 将完整持久 transcript 与有界的模型活动上下文分离。
- 追加式 run event 作为审计轨迹，原子 snapshot 作为快速物化视图。
- 只在结构安全的边界压缩，绝不丢失 system 策略或拆散工具调用往返。
- Extension Host 重启后，任务发现、恢复和 recorded-tool 回放仍可工作。
- 审批默认仅在当前进程会话有效，除非未来另行设计显式的持久策略。

对标基线包括 [Codex 仓库](https://github.com/openai/codex)、
[上下文压缩实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)、
[thread/turn/item 持久化契约](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
和 [memory pipeline](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md)。

## Agent 全面改进矩阵

| 领域 | 项目现状 | 计划结论 |
| --- | --- | --- |
| 仓库级指导 | 根 `AGENTS.md`、双语架构与贡献指南 | 保留，无需替换 |
| 结构化工具与语义读取 | registry 元数据、LSP 优先读取、MCP 契约 | 保留 registry 单一事实源 |
| 沙盒与审批 | mode guard、命令预检、cwd scope、子 Agent 沙盒 | 加固重启边界，session 审批绝不持久化 |
| 上下文压缩 | CJK 预算、滚动摘要、手动/循环中压缩 | 增加规范边界和跨 Provider 的 system 上下文保留 |
| Checkpoint 与恢复 | V2 压缩尾部和 transcript 归档 | 交付原子 V3、校验和、备份、稳定事件游标和 V2 迁移 |
| Run 审计与回放 | JSONL、reducers、Agent Manager、recorded-tool replay | 交付有序持久化、prompt artifact、磁盘发现和重启回放 |
| 长期记忆 | 有界 topic memory 与结构化压缩摘要 | 保持为显式用户/项目记忆层，不与崩溃恢复状态混合 |
| 多 Agent 与验证 | DAG、黑板、worktree 隔离、质量门、release checks | 保留，并通过定向与全量 gate 验证新持久化契约 |

## 范围与验收标准

1. **规范化会话记录完整性**
   - 不持久化孤立或重复的工具结果。
   - 为未完成的工具调用补充 interrupted 结果。
   - resume 和 compaction 的切分边界不拆散 assistant-tool 调用组。
   - 所有压缩路径都保留原始 system 指令。
2. **V3 持久恢复状态**
   - 状态和 transcript 使用带可恢复备份的原子写入。
   - 保存 transcript 校验和、消息数和最后一个稳定 ledger 事件。
   - 兼容读取 V2，并能在主状态文件损坏时从备份恢复。
   - 永不持久化或恢复 `sessionOnly` 审批规则。
3. **可回放运行**
   - 将完整原始用户提示存入事件负载之外的 artifact。
   - Extension Host 重启后仍能发现 run、读取 prompt 并执行 replay。
   - 小型工具结果进入 ledger，大型结果保留 artifact 引用。
4. **有序事件持久化**
   - 每个 run 串行写入 event/state，确保 JSONL 顺序与单调 sequence 一致。
   - 原子替换 `run_state.json`，并容忍 JSONL 尾部损坏记录。
5. **验证与文档**
   - 单测覆盖 transcript 规范化、压缩边界、V2 迁移、备份恢复、权限隔离、
     磁盘 replay 和并发事件顺序。
   - 同步中英双语架构与贡献文档。

## 交付阶段

- 阶段 A：共享原子存储和规范化 transcript 基础能力。
- 阶段 B：V3 checkpoint/resume 迁移及审批边界加固。
- 阶段 C：RunLedger prompt artifact、磁盘发现和 replay 恢复。
- 阶段 D：接入 compaction、补齐测试与文档、完成全量验证。

## 非目标

- 重新执行变更性工具的 full replay。
- 操作系统级命令沙箱与后台终端管理。
- 替换现有多 Agent DAG 或 worktree 合并策略。

## 完成记录

- [x] 共享的规范 transcript 与原子存储基础能力。
- [x] V3 resume state：V2 兼容、校验和、备份恢复与权限隔离。
- [x] prompt artifact、有序 RunLedger、磁盘发现与重启安全回放。
- [x] 所有 Provider 的压缩路径都保留 system prompt。
- [x] 覆盖结构完整性、迁移、损坏恢复、并发顺序和回放的定向测试。
- [x] 双语架构与贡献文档同步完成。
