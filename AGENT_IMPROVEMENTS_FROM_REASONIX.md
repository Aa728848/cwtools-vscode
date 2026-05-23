# CW Agent 可借鉴 DeepSeek-Reasonix 的改进项

参照项目:`C:\Users\A\Documents\DeepSeek-Reasonix`
本项目:`C:\Users\A\Documents\cwtools-vscode`

按"借鉴方向 → 具体落点 → 预期收益"组织,优先级从高到低。

---

## 1. Schema flatten / nest 管线(高优先)

**位置参考**:`DS/src/repair/flatten.ts`(`analyzeSchema` / `flattenSchema` / `nestArguments`)

**现状**:CW 的 `client/extension/ai/tools/argRepair.ts` 是逐工具治标修参数,新工具上线后还要再补一轮修复逻辑。

**改进**:
- 在 `client/extension/ai/tools/registry.ts` 注册工具时调用 `analyzeSchema`,根据深度 / 广度自动生成 `flatSchema` 缓存到 `ToolRegistryEntry`。
- 在 `runner/toolInvocation.ts` dispatch 前用 `flatSchema` 替换模型可见 schema;工具执行前用 `nestArguments` 把扁平参数还原成嵌套结构再传给 handler。
- CW 的领域工具(`get_pdx_block`、`query_references`、`edit_pdx_block`、`query_scripted_effects`)嵌套都很深,DeepSeek/部分弱模型会丢深层参数,这套机制是治本。

**收益**:argRepair 命中率下降,等价于减少一轮无效迭代;新增深 schema 工具不再需要单独写修复逻辑。

---

## 2. ReadTracker(写前确认已读)

**位置参考**:`DS/src/tools/read-tracker.ts`

**现状**:CW 的 `multi_replace_file_content` / `replace_lines` / `apply_patch` 没有强制"先读"门,模型靠记忆替换偶尔会替错,尤其在长会话被压缩后。

**改进**:
- 新建 `client/extension/ai/runner/readTracker.ts`,维护 per-session `Map<filePath, { mtime, byteHash }>`。
- `read_file` / `get_file_context` 命中后写入 tracker。
- 在 `runner/toolInvocation.ts` 写工具执行前查表:目标文件未被读过,或读后已被修改 → 拒绝并要求先 `read_file`,拒绝消息引导模型重新读取。
- 与 `runner/writeCoordinator.ts` 集成,写完成后更新 tracker 中的 mtime/hash,避免自己写后又触发拒绝。

**收益**:廉价、定向的护栏,大幅减少"幻觉替换"造成的脏改和反复 doom-loop。

---

## 3. Prefix-cache 友好不变量

**位置参考**:`DS/src/loop.ts` + `DS/README.md`(Pillar 1 — Cache-First Loop)

**现状**:CW 已有 `promptBuilder.ts:228` 的 `buildFrozenSystemPrompt` 和 `runner/compaction.ts:193` 的 `supportsPrefixCache` 分支,方向是对的——但实现里把动态 pinned 数据冻进了缓存字符串、cache key 含 `runId` 导致跨 run 永远 miss、Anthropic 的 `cache_control` 显式标记完全未处理。详见 §7 的逐项审查与修复优先级。

**改进**:
- 把 prompt 划成两个区:**稳定区**(系统提示分段、工具定义、`messages.ts` / `workflowI18n.ts` 文案、长期历史)和 **动态区**(诊断快照、working set、临时上下文)。
- 稳定区按固定顺序拼接,工具定义按 `tools/registry.ts` 注册顺序输出,不随调用频次或 mode 切换重排。
- 动态区放在稳定区之后的独立 message block,改动只影响 cache miss 区段。
- `runner/compaction.ts` 触发时压缩点只能单调前移,不允许"压缩了又解开"造成的反复重切。
- 新建 `runner/cachePolicy.ts` 在每轮 dispatch 前 diff 当前 prompt 与上一轮的稳定区,若 diff ≠ 0 写入 `runLedger` 一条 `cache-break` 事件,便于审计。

**收益**:多 provider 通吃;长会话 token 成本可降一个数量级(DS README 案例:99.82% 命中率,$12 vs $61)。

---

## 4. 纯 reducer 事件投影

**位置参考**:`DS/src/core/events.ts`(Event union) + `DS/src/core/reducers.ts`(纯函数投影)

**现状**:CW 的 `runner/runLedger.ts` 是 append-only JSONL,但 `client/webview/chat/runTimeline.ts`、`runInspector.ts`、`agentManager` 各自解析事件。`CLAUDE.md` 提到"新事件类型应同时更新两边"——这本身就是漂移信号。

**改进**:
- 新建 `client/extension/ai/runner/runReducers.ts`,把所有事件 → 视图状态的归纳集中成纯函数:`reduceRunState(events)`、`reduceToolTimeline(events)`、`reduceAgentGraph(events)`。
- Webview 端不再自己解析事件流,只消费 reducer 输出的快照(通过 `agentUiBroadcaster.ts` 推送)。
- 新增 event 类型只需在 union + reducer 各加一处,Webview 自动获益。

**收益**:消除多处 UI 漂移;reducer 可测试、可 replay;为未来"两次运行 diff"打基础。

---

## 5. Storm breaker 的 mutating / exempt 区分

**位置参考**:`DS/src/repair/storm.ts`(`isMutating`、`isStormExempt` 回调)

**现状**:CW 的 `runner/doomLoopDetector.ts` 用 `DOOM_LOOP_SOFT_THRESHOLD` + 语义化哈希,但所有工具一视同仁——`get_diagnostics`、`query_scope` 这类廉价检查工具被反复调用也会触发限流,误杀偏多。

**改进**:
- 在 `tools/registry.ts` 的 `ToolRegistryEntry` 增加两个标志:
  - `mutating: boolean` — 是否改变工作区/记忆状态。
  - `stormExempt: boolean` — 廉价状态检查,不计入重复窗口。
- `doomLoopDetector` 接受这两个回调:
  - 检测到 `mutating` 调用后清空对应文件的窗口(post-edit verify-read 不算重复)。
  - `stormExempt` 工具完全跳过计数。
- 默认值建议:
  - `mutating = true`:`write_file`、`multi_replace_file_content`、`replace_lines`、`apply_patch`、`edit_pdx_block`、`write_localisation`、`deploy_mod_asset`、`git_ops`、`set_memory`、`save_memory`。
  - `stormExempt = true`:`get_diagnostics`、`get_ignored_diagnostics`、`query_scope`、`document_symbols`、`workspace_symbols`、`list_directory`。

**收益**:误杀减少,正经 verify-after-write 模式不再被打断。

---

## 6. Transcript replay + diff

**位置参考**:`DS/src/transcript/`(write / diff / replay)

**现状**:CW 的 `runner/checkpoint.ts` V2 resume 已接近 replay,但缺"同一会话用新 prompt / 新模型重跑后对比差异"的能力。Prompt 调优时只能凭感觉。

**改进**:
- 基于 `runLedger` 的 JSONL,新增 `runner/runReplay.ts`,接口:
  - `replayRun(runId, overrides: { promptBuilder?, model?, toolStubs? }) → Promise<RunRecord>`
  - 输出新 `runId`,事件流可与原 run 做 timeline diff。
- 新增简单 CLI / 命令面板入口:`CWTools: Replay Run with Modified Prompt`,用于:
  - 调 `promptBuilder.ts` 时验证"改动是否真的减少了 doom-loop"。
  - 切换模型时对比成本/质量。
- Webview 加一个 split view:并排显示两次 run 的 toolTimeline。

**收益**:prompt 工程从"试一次看感觉"升级为"可量化对比",回归测试也能跑。

---

## 7. DeepSeek 缓存优化现有实现审查

参照位置:`promptBuilder.ts:228` `buildFrozenSystemPrompt`、`runner/compaction.ts:193-208` 的 `supportsPrefixCache` 分支、`agentRunner.ts:776` 的 provider 分流。

**整体评价**:架构意图(参考 DS 思路、识别字节稳定是核心)是对的;实现停留在"知道要冻结字符串"的表层,有几个会让缓存失效甚至产生陈旧数据的硬伤。bug 风险比性能风险更高——可能模型现在一直拿着 stale pinned 数据在做决策。

### 7.1 已做对的部分

- `_frozenPromptCache` 返回缓存字符串而不是每次重建,方向正确。
- `compaction.ts` 的 `supportsPrefixCache` 分支不重写 system message、把 summary 以 `user+assistant` 对的形式 append 在 system 之后,是标准 DS 做法。
- provider 分流存在,非目标 provider 走默认路径。

### 7.2 关键缺陷

**缺陷 A — 动态 pinned 数据被冻进 frozen 缓存(最严重)**

`buildFrozenSystemPrompt` 把 `pinned`(todos、diagnostics、recentWrittenFiles、pendingInteractions、blockedSubAgents、decisions)整个塞进将要被缓存的字符串。后果两难:
- cache key 命中 → 返回首次构建时的快照,后续 turn 的诊断变化、新完成的 todo、新写入文件全部丢失 → **模型看到陈旧的世界**。
- cache key 因 turn 变化失效 → 每 turn 重建 → 服务端 prefix cache 也跟着碎,等于没缓存。

**修复**:稳定区(mode prompt + 工具定义 + 项目规则)留在 system,pinned 与 compacted summary 移到 system 之后的独立 user message。物理分离两区是关键。

**缺陷 B — cache key 包含 `runId` → 跨 run 永远 miss**

```ts
const cacheKey = `${mode}|${providerId}|${languageId}|${topicId}|${runId}`;
```

每次新 run 必然换 `runId`,本地 Map miss 还是小事;重建出的字符串若带任何浮动内容(诊断顺序、`Date.now()` 等),服务端 prefix cache 一并 miss。DeepSeek 的 prefix cache 是 session 级以上、按 64 token 块匹配字节 —— 应改为 `${mode}|${providerId}|${languageId}`,跨 run 复用前缀。

**缺陷 C — 三家 provider 被 lump 在一起,Anthropic 完全没处理**

```ts
const supportsPrefixCache = provider.startsWith('deepseek') || provider.startsWith('openai');
```

| Provider | 缓存机制 | CW 当前处理 |
|---|---|---|
| DeepSeek | 自动,64 token 块,字节匹配 | 字节冻结(被缺陷 A 破坏) |
| OpenAI | 自动,≥1024 token,字节匹配 | 复用 DS 路径,无害但意义不大 |
| Anthropic | **显式** `cache_control: {type:"ephemeral"}`,≤4 breakpoint | **零处理 → Claude 用户零缓存收益** |

**修复**:Anthropic adapter 在 system message + 工具定义 + 最近一条 user message 上分别打 `cache_control` 标记。

**缺陷 D — 没有 cache hit 审计**

DS README 敢喊 99.82% 是因为有实测 usage 统计。三家的字段:
- DeepSeek `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- OpenAI `usage.prompt_tokens_details.cached_tokens`
- Anthropic `usage.cache_read_input_tokens` / `cache_creation_input_tokens`

CW 的 `pricing.ts` 已有 `getCacheDiscountFactor`,但没读 usage 里的实际命中字段 → 无法验证 frozen prompt 真的命中了服务端缓存,可能现在一直在 miss 也不知道。

**修复**:在 `agentRunner.ts` 收到响应后解析上述字段,写入 `runLedger` 的 `cache_stats` 事件,Webview 展示命中率。这条与 §4 纯 reducer 投影天然契合。

**缺陷 E — compaction 路径自身也会破缓存**

`runner/compaction.ts:204-206` 在 system 后追加的 `user+assistant` pair,**下一次压缩**生成的 summary 字节不同,会把第一对 pair 替换 → 之前命中的整个尾段缓存作废。

**修复**:压缩点单调前移,已写入的 summary pair 不可改写,新压缩追加成第二对、第三对,旧 pair 永驻前缀。

**缺陷 F — `_frozenPromptCache` 跨 run 累积不清理**

每个新 runId 写一条新 entry,长 session 下 Map 持续增长。`clearFrozenPromptCache` 存在但只在显式调用时触发。修缺陷 B 时(把 key 中的 runId/topicId 拿掉),这条同步解决。

### 7.3 修复优先级

| 优先级 | 修复 | 落点 |
|---|---|---|
| P0 | 拆 prompt 为稳定区 + 动态区,frozen 只缓存稳定区,pinned/summary 移到独立 user message | `promptBuilder.ts:228` |
| P0 | cache key 去掉 `topicId` 和 `runId`,保留 `mode\|providerId\|languageId` | `promptBuilder.ts:243` |
| P1 | Anthropic 适配:在 system / 工具定义 / 最近一条 user message 打 `cache_control` 标记 | `providers/` 各 adapter |
| P1 | 读 usage 的实际 cache 字段写入 runLedger,Webview 展示命中率 | `agentRunner.ts` 响应后处理 |
| P2 | compaction summary 改追加式,旧 pair 不可变,新压缩拼到尾部 | `runner/compaction.ts:202-207` |
| P2 | OpenAI 分支去掉特殊处理(它的自动缓存只需字节稳定,不需要 freeze 逻辑) | `agentRunner.ts:776` |
| P3 | `_frozenPromptCache` 加 LRU 上限或会话级清理 | `promptBuilder.ts:78` |

---
