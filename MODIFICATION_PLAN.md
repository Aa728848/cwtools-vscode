# CW Agent 改进实施计划

基于 `AGENT_IMPROVEMENTS_FROM_REASONIX.md`,本计划把 7 节改进项拆成可独立合入的任务,标注依赖、副作用(尤其对多 Agent 协作子系统)、验证方式、回滚路径。

## 阶段总览

```
Phase 1 ── 快赢 + 缓存正确性修复 (1-2 天)
   ├─ T1.1  Prefix-cache 三件套 (§7-A/B/F)
   ├─ T1.2  Storm mutating/exempt 标志 (§5)
   └─ T1.3  Cache hit 审计雏形 (§7-D)

Phase 2 ── 基础设施治本 (3-5 天)
   ├─ T2.1  Schema flatten/nest 管线 (§1)
   ├─ T2.2  ReadTracker (§2)
   └─ T2.3  Compaction 追加式 (§7-E)

Phase 3 ── Provider 适配 + 投影统一 (3-5 天)
   ├─ T3.1  Anthropic cache_control 适配 (§7-C)
   ├─ T3.2  纯 reducer 投影 (§4)
   └─ T3.3  Webview 接入 cache 命中率展示

Phase 4 ── Replay & Diff 工具链 (3-5 天)
   ├─ T4.1  replayRun 核心
   └─ T4.2  Webview split-view + 命令面板入口
```

依赖关系:T1.1 不依赖任何,优先做;T3.2 是 T3.3 的前置;T4.1 同时受益于 T3.2(reducer)和 T1.3(cache stats 事件)。

## 共通约定

- 每个任务一个 PR,单独可回滚。
- 改公共数据结构(`runLedger` 事件 union、`ToolRegistryEntry`、消息构造)的任务必须同步加 `npm run test:unit` 覆盖。
- 凡是改 `promptBuilder.ts` / `agentRunner.ts` 的任务,做完跑一次 ExtensionHost 手动 smoke:`build` mode 单 agent + 一次 `dispatch_agents` 多 agent 跑通。
- 涉及多 Agent 影响的任务,在 PR 描述里勾选"已验证 orchestrator 路径"。

---

## Phase 1 — 快赢 + 缓存正确性修复

### T1.1 Prefix-cache 三件套(§7-A/B/F)

**目标**:把 pinned 动态数据从 frozen prompt 中抽出来,cache key 去掉 `runId` / `topicId`,顺手解决 Map 泄漏。

**涉及文件**:
- `client/extension/ai/promptBuilder.ts`(`buildFrozenSystemPrompt`、`buildSlimSystemPromptForMode`、`_frozenPromptCache`)
- `client/extension/ai/agentRunner.ts:775-783` 调用点
- `client/extension/ai/runner/compaction.ts:193-208`(确认动态注入路径一致)

**实现要点**:
1. 新签名:`buildFrozenSystemPrompt(mode, providerId, languageId)` —— 移除 `topicId` / `runId` / `pinned` 三个参数,只缓存稳定区(mode prompt + 工具定义 + 项目规则 + skills)。
2. 新增 `buildDynamicPromptBlock(pinned, summaryPath)` 返回 `ChatMessage[]`(通常是一条 `role: 'user'` 消息),供 `agentRunner.ts` 在 system message 后、首条用户消息前插入。
3. 调用点改造:`agentRunner.ts:779-783` 拆成两步——先取 frozen system,再 append dynamic block。
4. cache key 改为 `${mode}|${providerId}|${languageId}`。
5. `_frozenPromptCache` 加 16 条 LRU 上限(键域已小,主要防御编程错误)。
6. 删除 `clearFrozenPromptCache` 内不必要的调用点(如有)。

**依赖**:无,优先合入。

**副作用与多 Agent 对策**:
- **`buildSlimSystemPromptForMode` 同样要拆**:sub-agent 路径目前没接 prefix-cache,但拆完后 slim 路径也应该具备相同的稳定/动态分区。sub-agent 的 pinned context 与父 agent 隔离,因此 slim 的 dynamic block 只包含 sub-agent 自身任务描述与共享黑板的相关条目,不能漏父级 pinned。
- **`dispatch_agents` 并发 fan-out 时的缓存键碰撞**:多个 sub-agent 同时取相同 `${mode}|${providerId}|${languageId}` 的 cached 字符串是安全的(Map 读不需要互斥,字符串不可变),但 LRU 淘汰要用 `Map` 顺序而非时间戳,避免并发改写淘汰指针。
- **`subAgentSandbox.enforceSubAgentSafety` 不受影响**:它在 dispatch 路径检查工具与路径,与 prompt 构建无关,但要在手动 smoke 时跑一次 `dispatch_agents → write_file` 拦截路径,确认拒绝消息仍正常注入(动态 block 形态变化不应破坏拒绝消息)。
- **黑板事件不受影响**:动态 block 不读黑板;黑板内容由 `query_blackboard` 工具显式读取。

**验证**:
- 单元:新增 `tests/promptBuilder.test.ts`(若不存在):同 `(mode, providerId, languageId)` 多次调用返回 referentially equal;`pinned` 不同的两次调用拿到相同的 frozen system + 不同的 dynamic block。
- 手动:开两个 topic 跑 5+ turn,检查 DeepSeek/OpenAI 响应里的 cache token 字段(配合 T1.3)非零且单调增长。
- 多 agent:跑 `dispatch_agents` 派 2 个 sub-agent,看父和子的 system 都不再含 stale pinned。

**回滚**:revert PR;`buildFrozenSystemPrompt` 旧签名是源码内调用,无外部消费者。

**风险**:`pinned` 从 system 移到 user message 后,模型对其"系统级权威性"的认知下降,可能忽略"剩余 todo"等指令。**缓解**:dynamic block 外包一层 `<system-reminder>` 标签(参照 Claude Code 的做法),保留语义权重。

---

### T1.2 Storm mutating/exempt 标志(§5)

**目标**:`tools/registry.ts` 上为每个工具标 `mutating` / `stormExempt`,`doomLoopDetector` 据此豁免/清窗口。

**涉及文件**:
- `client/extension/ai/tools/registry.ts`(`ToolRegistryEntry` 加字段 + 默认值表)
- `client/extension/ai/runner/doomLoopDetector.ts`(消费新字段)
- `client/extension/ai/agentRunner.ts` 中 doom-loop 触发点(读字段)

**实现要点**:
1. `ToolRegistryEntry` 扩两个字段,默认 `mutating: false`、`stormExempt: false`。
2. 在 registry 初始化时用 §5 列的清单批量打标。`mutating` 可从 `isWrite` 派生,但 `set_memory` / `save_memory` / `git_ops` 需显式补;`stormExempt` 全新。
3. `doomLoopDetector` 新增两个判定路径:
   - `stormExempt` → 直接跳过 hash 入窗。
   - `mutating` 调用成功后,清空 `targetPaths` 对应文件的窗口(per-file,不是全局)。
4. 加 telemetry:`runLedger` 事件加 `doom_loop_suppressed`(stormExempt 命中)和 `doom_loop_window_cleared`(mutating 清窗)子类型,便于事后看误杀率。

**依赖**:无。

**副作用与多 Agent 对策**:
- **每个 agent 一个 detector 实例**(确认现状如此),sub-agent 的窗口独立于父。
- `dispatch_agents` 本身:每次调用 task 描述不同 → hash 不同 → 不会自触发。但需把它标记 `stormExempt: false`,因为父连续调用是正常的 fan-out。
- `query_blackboard`:标 `stormExempt: true`(廉价状态检查)。子 agent 反复读黑板拿同步信号是合法行为,不该触发限流。
- `merge_results`:标 `mutating: true`(写黑板/产出 artifact)。

**验证**:
- 单元:`tests/doomLoopDetector.test.ts` 加用例——`get_diagnostics` × 10 不触发;`write_file` 后紧跟 `read_file` 同路径不算重复。
- 手动:跑一次明显会触发"反复 grep"的任务,看 `query_scope` 不再被压制。

**回滚**:字段默认 false 即关闭新行为;revert PR 不影响存量。

**风险**:误标 `stormExempt: true` 可能让真正的 doom-loop 漏网。**缓解**:首版只标极低频写、确定无副作用的查询工具;线上跑一段时间看 telemetry 再扩。

---

### T1.3 Cache hit 审计雏形(§7-D)

**目标**:把三家 provider 的 usage cache 字段读出来,写入 `runLedger`,为 T3.3 展示打底。

**涉及文件**:
- `client/extension/ai/agentRunner.ts`(响应处理段,约 line 1500-1700)
- `client/extension/ai/runner/runLedger.ts`(新事件类型 `cache_stats`)
- `client/extension/ai/types.ts`(`TokenUsage` 扩字段)

**实现要点**:
1. 在 `TokenUsage` 上加 `cacheReadTokens?: number` / `cacheWriteTokens?: number`(创建)。
2. 响应解析时按 provider 分支:
   - DeepSeek:`usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
   - OpenAI:`usage.prompt_tokens_details.cached_tokens`
   - Anthropic:`usage.cache_read_input_tokens` / `cache_creation_input_tokens`
3. 写 `runLedger.appendEvent(runId, 'cache_stats', { provider, model, read, write, totalInput })`。
4. `pricingData.json` 配合算实际成本(创建 vs 读取差价大,Anthropic 创建 1.25x、读取 0.1x)。

**依赖**:无,但 T3.3 消费此事件。

**副作用与多 Agent 对策**:
- Sub-agent 响应同样要走这段逻辑(`agentRunner` 是同一份代码,sub-agent 通过 `options.sandbox` 区分而非另一个 runner)。事件携带 `agentId` 字段,reducer 才能分桶。
- `runLedger` 已是 per-run,sub-agent 有自己的 runId,自然不会混。但 Webview agentManager 现在按 parent runId 聚合 sub-agent,要确保 cache_stats 事件能被聚合视图找到——`runLedger.getRun(parentRunId).subAgents[].events` 取得到即可。

**验证**:
- 手动:任意 turn 后 `cat .cwtools-ai/<topic>/runs/<runId>/events.jsonl | grep cache_stats`,确认三家 provider 都能拿到非空字段。
- 单元:`tests/runLedger.test.ts` 覆盖事件 schema。

**回滚**:revert PR;事件类型新增,Webview 旧版本会忽略未知事件(确认 `runTimeline.ts` 有 default 分支)。

**风险**:OpenAI compat provider(很多第三方)未必返回 `prompt_tokens_details`,要 null-safe。

---

## Phase 2 — 基础设施治本

### T2.1 Schema flatten / nest 管线(§1)

**目标**:在 registry 注册时分析 schema 深度/广度,自动生成 `flatSchema` 给模型看,执行前 re-nest 还原成嵌套对象。

**涉及文件**:
- 新建 `client/extension/ai/tools/schemaFlatten.ts`(对应 DS `src/repair/flatten.ts`)
- `client/extension/ai/tools/registry.ts`(`ToolRegistryEntry` 加 `flatSchema?: ToolDefinition`)
- `client/extension/ai/runner/toolInvocation.ts`(dispatch 前替换 schema,执行前 `nestArguments`)
- `client/extension/ai/agentRunner.ts` 给模型构造 tools 列表的位置(用 `flatSchema ?? schema`)

**实现要点**:
1. `analyzeSchema`:递归统计深度、叶子数;阈值(深度 > 2 或叶子 > 10)触发 flatten。
2. `flattenSchema`:对象嵌套用 `.` 拼 key,数组保留为数组但内部对象同样展平。命名冲突时回退原 schema(保守)。
3. `nestArguments`:逆操作,把 `{ "filter.range.from": 1 }` 还原为 `{ filter: { range: { from: 1 } } }`。
4. 在 registry 注册末尾对每个 entry 算一次 `flatSchema`(可缓存,因为 schema 不变)。
5. `toolInvocation.ts` 检测到 entry 有 `flatSchema`,执行前调 `nestArguments(args, originalSchema)`;失败回退到原 args + 现有 `argRepair` 兜底。

**依赖**:无;与 T1.1 不冲突(系统/工具定义都属稳定区,变形后字节稳定即可)。

**副作用与多 Agent 对策**:
- **关键影响**:工具定义变化破坏 prefix cache!T1.1 完成后 `flatSchema` 是稳定的(注册时生成、运行时不变),但首次合入这个 PR 时,所有用户的 cache 会一次性 miss。**对策**:合入时附 release note 提醒"首次升级后第一轮 turn cache miss 属预期"。
- **Sub-agent 看到的工具列表也变了**:`buildSlimSystemPromptForMode` 渲染工具时同样从 registry 取,自动跟上,无需额外改动。但 sub-agent 的工具子集(`SUB_AGENT_EXCLUDES_SET`)与 flatten 独立——一个工具能不能给 sub-agent 用、与它 schema 是否扁平无关。
- **`dispatch_agents` 自身**:它的 args schema 是 `{ sub_tasks: [{ task, mode, ... }] }`,深度刚好 2 层、叶子数中等,会被 flatten 命中。**关键风险**:flatten 后变成 `sub_tasks.0.task` 这种伪 key 模型不一定理解。**对策**:registry entry 加 `noFlatten: true` 旗标,`dispatch_agents` / `merge_results` / `query_blackboard` 全部豁免——它们的 schema 已经稳定、文档充分,模型熟悉嵌套形态。
- **`enforceSubAgentSafety` 检查的是工具名 + 解析后 args**,re-nest 后 args 形态与现状一致,沙盒不受影响。

**验证**:
- 单元:`tests/schemaFlatten.test.ts` 覆盖深嵌套、数组、空对象、命名冲突回退、roundtrip 等价。
- 手动:跑一次 `query_definition` 或 `get_pdx_block`(深参数工具)和 `dispatch_agents`(豁免工具),对比模型成功率。
- 度量:抓 `argRepair` 命中事件,合入前后对比下降比例。

**回滚**:revert PR;`flatSchema` 字段未填充时 `toolInvocation.ts` 自然走原路径。

**风险**:命名冲突或 enum 边界处理出错 → 模型给的扁平参数无法 nest 回来。**缓解**:`nestArguments` 失败时回退到原 args,把异常作为 `argRepair` 触发点而非直接报错。

---

### T2.2 ReadTracker(§2)

**目标**:写工具执行前强制目标文件"已读且未变",否则拒绝。

**涉及文件**:
- 新建 `client/extension/ai/runner/readTracker.ts`
- `client/extension/ai/runner/toolInvocation.ts`(写工具 dispatch 前查表)
- `client/extension/ai/runner/writeCoordinator.ts`(写完成后更新 tracker)
- `client/extension/ai/agentTools.ts`(`read_file` / `get_file_context` handler 末尾写入 tracker)
- `client/extension/ai/agentRunner.ts`(per-run 实例化,挂在 `AgentRunner` 上)

**实现要点**:
1. `ReadTracker` 接口:`markRead(path, mtime, byteHash)`、`canWrite(path): { ok, reason }`、`markWritten(path)`。
2. 拒绝消息模板:`"File X was not read in this conversation. Call read_file first, then retry the edit."`。模板里包含建议的工具名,引导自纠。
3. `multi_replace_file_content` 多文件场景:任一文件未读即拒绝整批;消息列出所有未读文件。
4. 兼容 `write_file` 新建文件:目标路径不存在时跳过 tracker(无可读)。

**依赖**:无。

**副作用与多 Agent 对策**:
- **核心设计选择**:tracker 是 per-agent-run 还是 session 级?
  - 选 **per-agent-run**(推荐):父和子各自跟踪,职责清晰。代价是 sub-agent 拿到父读过的文件还要再读一次。
  - 选 session 级:共享读状态,但 sub-agent 写后父 tracker 不会自动失效,容易 stale。
- **选 per-agent-run** + **黑板事件桥接**:sub-agent 写文件时,通过 `merge_results` / 黑板 entry 把"写过的文件路径"汇报给父;父在 sub-agent 返回后,把这些路径从自己的 tracker 里删掉(强制重新读)。
- `subAgentSandbox.enforceSubAgentSafety` 已经限制 sub-agent 不能改沙盒外的路径,所以"父读 → 子写 → 父需要重读"的场景只可能发生在沙盒交集区,数量可控。
- **`dispatch_agents` 调用本身**:不读不写文件,无影响。

**验证**:
- 单元:`tests/readTracker.test.ts` 覆盖未读拒绝、读后允许、外部修改后再拒绝、新建文件允许、sub-agent 写后父失效。
- 手动:故意让模型直接 `write_file` 一个未读文件,看是否被拒并自动 `read_file` 重试。
- 多 agent:跑 `dispatch_agents` 让子 agent 改父读过的文件,然后父 agent 继续写同一文件,验证父被要求重新读。

**回滚**:revert PR;或在 config 加 `cwtools.ai.readTracker.enabled` 开关,出问题先关再排查。

**风险**:模型对拒绝消息理解不到位,陷入"拒绝-重读-再拒绝"小循环。**缓解**:与 T1.2 的 doom-loop 配合,`read_file` 标 `stormExempt: true`,不会触发限流;同时拒绝消息里附"你已经读过 X 次,可能是 hash mismatch,请用 `read_file` 重新拉取最新版本"。

---

### T2.3 Compaction 追加式(§7-E)

**目标**:`runner/compaction.ts` 已写入的 summary user+assistant pair 不可改写,新压缩追加到尾部,旧 pair 永驻前缀。

**涉及文件**:
- `client/extension/ai/runner/compaction.ts:193-208`(`supportsPrefixCache` 分支)
- `client/extension/ai/runner/checkpoint.ts`(resume 路径同步)

**实现要点**:
1. 在 ledger 里记录"已有压缩段数",每次新压缩查这个数,生成第 N 对 pair。
2. compaction 函数不再"重写 summary",而是"append 一对新的 summary pair"。结构:
   ```
   [system]
   [user 1: "Context Recovery 1"] [assistant 1: "## Summary 1\n..."]
   [user 2: "Context Recovery 2"] [assistant 2: "## Summary 2\n(diff from 1)..."]
   ... [recent messages]
   ```
3. summary 生成 prompt 改为"incremental"模式:只总结上一次压缩点之后的内容,不重抓全文。
4. checkpoint resume 时按 pair 编号还原,不重写历史 pair。

**依赖**:T1.1(prompt 分区清晰后,compaction 注入位置稳定)。

**副作用与多 Agent 对策**:
- Sub-agent 寿命短,通常不触发 compaction,但走同一路径,正确性同步获得。
- `runner/contextMemory.ts` 产出的结构化 summary 也要按 pair 编号写,而非覆盖。具体看 `compactHistory` 当前是否生成单一 `summary.md` 还是分片;若是单一,改为 `summary-001.md`、`summary-002.md` 增量文件。
- Webview 展示 compaction 事件时,按 pair 编号渲染,避免"summary 又变了"的视觉漂移。

**验证**:
- 单元:`tests/compaction.test.ts` 覆盖连续 3 次压缩,前两对 pair 字节稳定。
- 手动:开长会话强制压缩 2 次,看 DeepSeek 响应 `prompt_cache_hit_tokens` 在第二次压缩后仍 ≥ 第一次压缩点位置的 token 数。

**回滚**:revert;无 schema 变化。

**风险**:summary-of-summaries 长度增长 → 长会话最终 summary 体积失控。**缓解**:第 N pair 长度超过阈值时,触发"meta-compaction"——将前 N-1 对 pair 整体压缩为一对,这次是允许重写的(代价:命中率短暂下降)。

---

## Phase 3 — Provider 适配 + 投影统一

### T3.1 Anthropic cache_control 适配(§7-C)

**目标**:Claude 用户也能享受缓存,与 DeepSeek 路径质量对齐。

**涉及文件**:
- `client/extension/ai/providers/`(Anthropic adapter,具体文件名按现状)
- `client/extension/ai/agentRunner.ts` 构造请求 body 的位置

**实现要点**:
1. Anthropic API 接受 `system` 字段为数组,每个 block 可带 `cache_control: { type: "ephemeral" }`。最多 4 个 breakpoint。
2. CW 的打点位置:
   - **breakpoint 1**:system message 末尾(整个稳定区)
   - **breakpoint 2**:工具定义数组末尾(`tools` 字段)
   - **breakpoint 3**:dynamic block(pinned + summary)末尾
   - **breakpoint 4**:倒数第二条 user message 末尾(滚动窗口,锁住对话历史前缀)
3. Anthropic 不支持工具定义嵌入 system,需要单独 `tools: [...]` 数组,确保顺序稳定。
4. `messages[]` 顺序与 OpenAI/DeepSeek 路径一致。

**依赖**:T1.1(稳定区/动态区已分离)、T1.3(能审计命中率验证生效)。

**副作用与多 Agent 对策**:
- **Sub-agent 调用 Anthropic 时同样打 cache_control**:slim system prompt 也得拆 block。但 sub-agent 寿命短,可能反复创建缓存却命中不了——可降级:sub-agent 路径只在 system 打一个 breakpoint,工具定义不打。
- **`dispatch_agents` 的并发 fan-out 不影响 Anthropic 缓存**:每个 sub-agent 独立 session,Anthropic 缓存按 API key + organization 隔离,并发请求各自命中。
- **成本风险**:Anthropic 缓存创建 1.25x、读取 0.1x。如果会话很短(< 5 turn),创建成本无法摊销。**对策**:在 config 加 `cwtools.ai.anthropic.cacheStrategy: 'always' | 'long-session' | 'off'`,默认 `long-session`(检测到对话 > 3 turn 才开)。

**验证**:
- 手动:用 Claude provider 跑 5 turn 长对话,观察 `cache_read_input_tokens` 在第 2 turn 起非零。
- 多 agent:`dispatch_agents` 派 2 个 Claude sub-agent,确认父和子各自有 cache 命中。

**回滚**:config 关 cache_control 字段,adapter 自然降级。

---

### T3.2 纯 reducer 投影(§4)

**目标**:`runLedger` 事件 → 视图状态的归纳集中到纯函数,Webview 不再各自解析。

**涉及文件**:
- 新建 `client/extension/ai/runner/runReducers.ts`
- `client/webview/chat/runTimeline.ts`、`runInspector.ts`、`agentManagerHtml.ts`(消费 reducer 输出)
- `client/extension/ai/agentUiBroadcaster.ts`(推送 reducer 快照而非裸事件)

**实现要点**:
1. Reducer 接口:
   - `reduceRunState(events): RunStateSnapshot`(总体进度、token、cost、当前 step)
   - `reduceToolTimeline(events, opts): ToolTimelineSnapshot`(按 agentId 过滤)
   - `reduceAgentGraph(events): AgentGraphSnapshot`(父 / 子 / 黑板节点关系)
   - `reduceCacheStats(events): CacheStatsSnapshot`(T3.3 消费)
2. Webview 收到 snapshot 后只做 diff-render,不解析事件。
3. 兼容性:旧 Webview 不更新时仍能收到原事件流;reducer 与事件流并行推送一段时间(双轨期 1-2 个版本)。

**依赖**:T1.3(`cache_stats` 事件已落地,reducer 才能投影)。

**副作用与多 Agent 对策**:
- **核心**:多 agent 是 reducer 设计的关键测试场景。事件流里夹杂父 / 子 / 黑板事件,reducer 必须按 `agentId`、`parentAgentId` 正确分组。
- **`agentManager` 现有的 UI 行为**:展示多个 sub-agent 的并发状态、token 累计、阻塞原因。reducer 必须能输出与现状等价或更优的快照。
- **黑板事件**:`blackboard.ts` 当前是否把读写写入 ledger?若否,T3.2 时顺便补一组 `blackboard_write` / `blackboard_read` 事件,让 `reduceAgentGraph` 能画出依赖箭头。
- **conflictDetector / qualityGate 事件**:同样要进 ledger 才能在 reducer 里展示。

**验证**:
- 单元:`tests/runReducers.test.ts` 喂一段典型多 agent 事件流,断言 snapshot 各字段。
- 手动:跑一次 `dispatch_agents` 看 agentManager 还能正常工作。

**回滚**:Webview 临时切回旧解析路径;reducer 模块保留待修。

---

### T3.3 Webview 接入 cache 命中率展示

**目标**:把 T1.3 的 `cache_stats` 事件渲染成可视化指标。

**涉及文件**:
- `client/webview/chat/runTimeline.ts`(顶栏加 cache 命中率徽章)
- `client/webview/chat/runInspector.ts`(per-turn cache 分解)
- `client/extension/ai/runner/runReducers.ts`(`reduceCacheStats`)

**实现要点**:
1. 顶栏:绿色徽章 `Cache 87% · saved $0.42`。
2. Inspector:turn 列表里每行加 cache hit/miss/created token 三柱微图。
3. 多 agent:父 run 展示聚合命中率,sub-agent 行展示自身命中率。
4. 数据来源:`reduceCacheStats(events)` 按 agentId 分桶。

**依赖**:T1.3、T3.2。

**副作用与多 Agent 对策**:
- Sub-agent 命中率天然偏低(寿命短)。UI 上区分"短命 agent"标识,避免被误读为 bug。
- 聚合命中率算法:`Σ read_tokens / Σ (read + miss) tokens`,不简单平均。

**验证**:跑一次长会话,徽章数字与 ledger 原始事件计算结果一致。

**回滚**:UI 旗标关闭。

---

## Phase 4 — Replay & Diff 工具链

### T4.1 replayRun 核心(§6)

**目标**:`replayRun(runId, overrides)` 从 ledger 重放一次,产出新 runId,可与原 run diff。

**涉及文件**:
- 新建 `client/extension/ai/runner/runReplay.ts`
- `client/extension/ai/runner/runLedger.ts`(只读重放接口)
- `client/extension/ai/agentRunner.ts`(支持 replay 模式启动)

**实现要点**:
1. 两种 replay 模式:
   - **模式 A — recorded-tool**:工具调用结果从 ledger 取(deterministic),只 LLM 重新调用。验证 prompt 改动是否减少 doom-loop。
   - **模式 B — full-replay**:工具也重新执行(危险,需 dry-run guard 或工作区快照)。
2. overrides:`{ promptBuilder?, model?, providerId?, toolStubs? }`,缺省时复用原 run 配置。
3. 新 run 写入独立 ledger 目录,带 `replayOf: originalRunId` 元数据。

**依赖**:T3.2(reducer 让 diff 可视化更简单,但 replay 本身只依赖 ledger)。

**副作用与多 Agent 对策**:
- **Sub-agent replay 的歧义**:原 run 派出过 sub-agent,replay 时是否也派?
  - **模式 A 推荐**:不重新派,直接从 ledger 取 sub-agent 的最终输出,节省成本。
  - **模式 B**:递归 replay 每个 sub-agent,语义最完整但成本爆炸。
- **黑板状态**:replay 时是否要重建黑板?**模式 A 不需要**(工具结果已含黑板返回值);模式 B 需要从原 ledger 重放黑板写入序列。
- **conflictDetector / qualityGate**:replay 时关闭或转为 dry-run,避免对原工作区产生副作用。

**验证**:
- 单元:`tests/runReplay.test.ts` 喂固定 ledger,模式 A 输出与原始一致(deterministic 部分),只有 LLM 输出可能不同。
- 手动:挑一个历史 doom-loop run,改 prompt 后 replay,看新 run 是否突破循环。

**回滚**:revert PR;新文件独立,无侵入。

---

### T4.2 Webview split-view + 命令面板入口

**目标**:用户能从 Webview 触发 replay,并排看两次 run 的 toolTimeline。

**涉及文件**:
- `client/extension/extension.ts`(命令注册 `CWTools: Replay Run`)
- `client/webview/chat/runInspector.ts`(split-view 渲染)
- `client/webview/chat/runTimeline.ts`(双列对比模式)

**实现要点**:
1. 命令面板入口:用户选一个历史 run + 一种 override(改 prompt / 换模型)。
2. Webview 双列:左边原 run,右边新 run,事件按时间轴对齐。
3. 高亮 diff 行:工具调用不同的 turn、token 差异 > 20% 的 turn。

**依赖**:T4.1、T3.2。

**副作用与多 Agent 对策**:
- 多 agent run 的 split-view:树形展开,父 agent 对齐、各 sub-agent 单独成块对比。
- 大 run(>100 events)的渲染性能:虚拟列表 + 懒加载 events。

**验证**:手动跑两次 replay 看 UI。

**回滚**:UI 旗标关闭。

---

## 多 Agent 协作影响矩阵(汇总)

| 任务 | Orchestrator | Blackboard | SubAgentSandbox | dispatch_agents | 风险等级 | 对策摘要 |
|---|---|---|---|---|---|---|
| T1.1 prompt 分区 | ✅ slim 路径同步拆 | 无 | 无 | 缓存键并发安全 | 低 | LRU 用 Map 顺序而非时间戳 |
| T1.2 storm 标志 | 每 agent 一 detector | `query_blackboard` 标 exempt | 无 | 父连续 dispatch 不重复 | 低 | task 描述不同自然哈希不同 |
| T1.3 cache 审计 | 事件携 agentId | 无 | 无 | sub-agent 走同代码 | 低 | reducer 按 agentId 分桶 |
| T2.1 schema flatten | sub-agent 工具列表跟随 | 无 | re-nest 后 args 形态一致 | **必须 noFlatten 豁免** | 中 | 加 noFlatten 旗标 |
| T2.2 ReadTracker | **per-agent-run** | merge_results 桥接失效 | 沙盒交集区需重读 | 无 | 中 | 父在 sub-agent 返回后清掉相关条目 |
| T2.3 compaction 追加 | sub-agent 寿命短少触发 | 无 | 无 | 无 | 低 | summary.md 改为分片 |
| T3.1 Anthropic cache | slim 路径降级单 breakpoint | 无 | 无 | 并发 fan-out 各自命中 | 中 | 短命 agent 关 cache |
| T3.2 reducer 投影 | **关键测试场景** | 黑板事件入 ledger | conflict/quality 事件入 ledger | 父子事件按 agentId 分组 | 中 | reducer 处理父子拓扑 |
| T3.3 命中率 UI | 父聚合 / 子单展 | 无 | 无 | 区分短命 agent | 低 | UI 加短命标识 |
| T4.1 replay | 模式 A 不重派 sub-agent | 模式 A 不重建黑板 | replay 关 conflict 检测 | 派发由 ledger 回放 | 高 | 默认模式 A |
| T4.2 split-view | 树形对齐 | 无 | 无 | 多 agent 树展开 | 低 | 虚拟列表 |

**额外补丁任务(发现于矩阵审查,需在对应 Phase 内顺手做)**:

- **B1**:`blackboard.ts` 读写事件落 `runLedger`(T3.2 前置)。落点:`blackboard.ts` 各 set/get/watch 触发点加 `runLedger.appendEvent`。
- **B2**:`conflictDetector.ts` / `qualityGate.ts` 决策事件落 `runLedger`(T3.2 前置)。
- **B3**:`merge_results` 工具返回值里增加 `writtenFiles: string[]`,供父 agent 清 ReadTracker(T2.2 配套)。
- **B4**:`subAgentSandbox.enforceSubAgentSafety` 拒绝事件改用结构化 event type,避免被 reducer 当作字符串 step 渲染(T3.2 配套)。

## 测试与发布策略

- **每个 Phase 末做一次集成 smoke**:build / explore / plan / dispatch_agents 各跑一遍,看不出回归再合下一 Phase。
- **灰度旗标**:T1.1、T2.1、T2.2、T3.1 各配 `cwtools.ai.experimental.*` 开关,默认开,出问题让用户先关再排查。
- **release note 标注**:T1.1、T2.1 首次合入时明确"首轮 cache miss 属预期",避免用户误以为缓存优化失效。
- **回归基线**:Phase 1 合入前抓一份"典型 5-turn build 任务"的 token 用量、doom-loop 触发次数、argRepair 命中次数 → 作为 Phase 2/3 度量基线。

## 度量目标

| 指标 | 基线方法 | Phase 1 后 | Phase 2 后 | Phase 3 后 |
|---|---|---|---|---|
| Cache 命中率(DeepSeek) | 现在不可知 | ≥ 60% | ≥ 75% | ≥ 85% |
| Cache 命中率(Anthropic) | 0(无 cache_control) | 0 | 0 | ≥ 70% |
| argRepair 命中次数 / 100 turn | 抓 ledger | — | 下降 50% | 下降 70% |
| doom-loop 误杀次数 / 100 turn | 抓 ledger | 下降 70% | — | — |
| stale pinned 数据导致的错误改动 | 用户报告 + 抓 turn 末诊断 | 趋零 | 趋零 | 趋零 |

度量数据来源:T1.3 的 `cache_stats` 事件 + T1.2 的 `doom_loop_suppressed` 事件 + 现有 `argRepair` 触发日志。

## 不在本计划范围

- DS 的 transcript replay + diff 之外的"工具失败根因聚合"(原文档 § 双方都值得做的 B 项)——等 T4 完成后,数据自然到位,再单独立项。
- §5 之外的工具并发类别细化(从单 `parallelSafe` 升到 DS 的多档)——本计划已默认沿用 CW 现有 `concurrencyClass`,不动。
- F# LSP 层与 AI 模块的耦合优化——独立议题,不在本计划。
