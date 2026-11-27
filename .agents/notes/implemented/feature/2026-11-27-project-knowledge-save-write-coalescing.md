# Agent Note: 项目知识库保存事件的内容去重、事实短路与合并批处理

Status: implemented

## Problem

项目知识库 watcher 仅按路径记录文件事件。手动原样保存、格式化或不改变知识事实的编辑也会进入 SQLite 增量导出，并无条件更新时间戳、统计元数据并提交；一次增量导出末尾还存在主数据与统计元数据两个事务。固定 500ms 去抖只能合并紧邻事件，无法消除无意义写盘。

## Decision

1. **文件内容去重**：`client/extension/projectKnowledgeWatcher.ts` 串行计算变更文件 SHA-256，只有内容哈希变化才交给 `ProjectKnowledgeRefreshScheduler`。指纹仅在导出成功后成为已发布基线；失败批次保留下次事件重试，但不自动无限重试。哈希队列并发为 1，待哈希事件达到 32 个后保守调度刷新。
2. **尾沿去抖与最大等待**：`projectKnowledgeRefreshScheduler.ts` 使用 1500ms 尾沿去抖和 10000ms 最大等待；运行期间的 full 请求不会降级为 incremental。待处理文件超过 500 个升级为 full，事件版本和已发布指纹缓存各限制为 1000 项。
3. **知识事实短路**：`ProjectKnowledge.fs` 在开启写事务前，对变更文件关联的定义、拓扑、事件图和 Inline 图事实做确定性排序与 SHA-256 指纹。指纹存于 V7 `metadata` 的 `incremental_facts_sha256:` 内部键，不新增表、不升级公开 schema。旧数据库首次增量建立基线；运行状态一致且所有指纹一致时返回 `generationMode = "unchanged"`，保留原 `generated_at` 和 `graph_version`。
4. **产物零重写**：`cwtools-shared/src/project/init.ts` 收到 unchanged 且 profile/manifest 均存在时直接复用现有产物，不重复写 profile、manifest 或 SQLite。profile 不再在导出前预写；成功路径仍写一次，失败路径保留原有不可用产物行为。
5. **单事务发布**：有效增量更新的数据、统计和文件指纹在同一 SQLite 事务提交。`last_incremental_duration_ms` 与 `database_size_bytes` 仍作为返回诊断，但不再每次持久化；图级文件的 full 规则与数据库锁保持不变。

## Alternatives considered

- **只延长去抖**：否决。只能降低连续保存频率，原样保存和无事实变化仍写库，并会无上限增加知识库滞后。
- **只用 mtime/size**：否决。原样保存会更新 mtime，同大小内容替换也无法可靠识别。
- **为指纹新增表并升级 schema**：本次不采用。内部 metadata 键足以保存基线，可避免迫使所有现有 V7 数据库全量重建。
- **失败后立即自动重试**：否决。模型或锁持续不可用时会形成后台重试风暴；保留下一文件事件或既有 stale resume 入口重试。

## Consequences

- 首次升级后的增量保存可能多写一次事实指纹基线；之后同内容保存由 watcher 跳过，内容变化但知识事实不变的保存由后端 unchanged 短路。
- unchanged 是有意的内部导出诊断状态，不改变 V7 数据库 schema，也不放宽图级变更必须 full 刷新的正确性约束。
- 验证：调度器 5 项定向测试；shared 152 项契约；根仓库 compile、typecheck:test、909 项 unit、60 项 rules-sync、7 项 perf；F# Main build 与全部 36 个 FSX 测试脚本。
