# P0 实施设计 v2：anchor 失败守卫 / 统一剪枝阶梯 / usage 校准

> 依据：`docs/reasonix-comparison-review.md`（已审批）修订路线的 P0 部分。
> 基线：cwtools-vscode `ee1dd600`。本文是设计稿 v2，不代表已实现。

## v2 修订记录（对应第二轮设计评审）

以下评审意见均已先对照源码核实，再落入设计：

| 评审意见 | 核实结果 |
|---|---|
| 子 Agent 共享 `toolExecutor/FileToolHandler` | 属实。`agentRunner.ts:1900-1904` 注释明示 "sub-agents share the executor and must not clear the parent run's counters" |
| 主循环 `messages` 已含 system/context/user，`fixedPromptTokens` 不在采样点作用域 | 属实。`fixedPromptMessages`（:1278-1283）含 systemPrompt+contextMessages+dynamicBlock+userContent，拼装后进入循环消息；`fixedPromptTokens` 是 `run()` 局部变量 |
| `ReadTracker` 无公开 `byteHash` 读取 API | 属实。`readMap` 私有，仅有 markRead/canWrite/markWritten/invalidate/reset |
| 文件锁使用 resolve 前原始路径作 key | 属实。`executeWithLock`（fileTools.ts:110-125）以入参 `filePath` 为 key，且 `resolveAndAuthorizeWrite` 在锁内才执行 |
| `estimateChatMessageTokens` 位于 agentRunner.ts，runner/ 新模块反向导入会成环 | 属实（:207）。设计 2 增加前置纯重构 |
| `AgentRunner` 先于 `AIChatPanelProvider` 构造 | 属实（extension.ts:1146 vs :1159）。校准表改在 extension.ts 创建注入 |
| v1 清除条件过宽且自相矛盾 | 属实。改为惰性清除，见设计 1.4 |

## 共享约束（不变）

- 不新建第二套写执行器；不绕开 `tools/registry.ts`、`policyEngine.ts`、ReadTracker、写锁链、Plan gate。
- 压缩改动继续使用 `contextTranscript.ts` 的 canonical transcript，不拆散 assistant/tool-call/result 组。
- 新状态必须有界；优先复用既有事件与 hint 通道，不新增 run-event 类型。

---

## 设计 1：anchor 级重复写失败守卫

### 目标

在现有"按文件失败预算（3/5 级）+ DoomLoop"之上，增加 `{scopeId, tool, pathKey, anchorHash, errorClass}`
签名守卫：精确识别"同一 scope 内同一 anchor 反复失配"，不污染共享 executor 上的其他 scope，
不误伤同文件新策略。

### 1.1 错误分类

`tools/editFailure.ts`（新文件）定义：

```ts
export type EditErrorClass =
  | 'anchor_not_found'   // edit_file 无匹配        → 参与守卫
  | 'anchor_ambiguous'   // edit_file 多匹配        → 参与守卫
  | 'anchor_stale'       // replace_lines expected* 校验不符 → 参与守卫
  | 'structure_rejected' // PDX 结构守卫            → 仅分类，不守卫
  | 'invalid_args'       // 参数错误                → 仅分类，不守卫
  | 'io_error';          // 读盘/锁/其他            → 仅分类，不守卫
```

**守卫只覆盖前三类**：只有 anchor 类失败能被 preview 证明恢复或仍失败；结构拒绝、参数错误、
I/O 错误无法用 anchor preview 判定，强行拦截会误伤合法重试（评审修正项）。

`replacerSuite.fuzzyReplace` 改抛 `ReplacerError { kind: 'no_match' | 'multiple_matches' }`，
message 文本不变（模型可见行为零变化）。

### 1.2 scopeId 与签名

```ts
interface FailureSignature {
  scopeId: string;        // 见下
  tool: 'edit_file' | 'replace_lines';
  pathKey: string;        // canonicalPathKey，见 1.5
  anchorHash: string;
  errorClass: EditErrorClass; // 仅 anchor_* 三类会进入此表
}
interface SignatureState { count: number; contentHashAtFailure: string; }
```

- **scopeId**：子 Agent 与父级共享 executor（已核实），因此签名必须按 scope 隔离。
  来源为类型化传递：`AgentToolContext` 增加显式字段 `scopeId: string`（顶层 run 用 runId，
  子 Agent 用各自的 sub-agent runId；在 `reasoningLoop` 构造 `agentToolContext`
  （agentRunner.ts:1916-1920）处赋值）。禁止 `as any` 透传。
- **anchorHash**：
  - `edit_file`：`oldString` 经 CRLF 归一 → `stripLineNumberPrefixes` → `unicodeNormalize` 后
    sha256 前 16 hex（与 replacer 匹配前归一化对齐）；
  - `replace_lines`：有 `expected*` 时取其归一化拼接 hash，否则 `lines:{start}-{end}`；
  - `replaceAll=true` 不守卫。
- **contentHashAtFailure**：直接对 `editFile` 已读出的 `originalContent` 算 sha256。
  **不依赖 ReadTracker 的 `byteHash`**——它没有公开读取 API（已核实），且内容已在手，零额外 I/O。
- 表容量有界（如 256 条，LRU 淘汰），随 executor 生命周期存在。

### 1.3 拦截与 preview 复检

执行点：`editFile`/`replaceLines` 内，`resolveAndAuthorizeWrite` **之后**、执行替换之前。
policy/ReadTracker/锁链全部原样先行。

1. 算签名查表，`count < 2` 正常执行。
2. `count >= 2` 时先做无副作用 preview（在已持有的 per-file 锁内，对当前内容）：
   - `edit_file`：调 replacerSuite 新增的 `previewMatch(content, oldString)` 纯函数
     （复用同一组 REPLACERS，只返回 matched/ambiguous/not-found）；
   - `replace_lines`：**重新执行 `expectedContent/expectedHash/expectedStartText/expectedEndText`
     校验**（fileTools.ts:993-1022 抽成可复用纯函数），不调 `fuzzyReplace`（评审修正项）；
   - preview 通过 → 清除该签名并放行；preview 仍失败 → 拦截，返回
     `{success:false, message: BLOCKED 文案 + 当前内容预览 + 强制 read_file/换策略指引}`，
     不执行写入、不递增计数。
3. 正常执行失败且属 anchor 类 → 递增签名计数；现有 `editFailCount` 与 3/5 级 hint 行为不变。

拦截结果走正常 result 返回，经 `summarizeToolResultForLedger` 进入 `tool_call_end`，
不新增 run-event 类型。

### 1.4 清除规则（惰性，纠正 v1 矛盾）

- **不做**"同路径任意成功写入即清全部签名"（v1 过宽：非重叠 edit 不应清除其他 anchor 的签名）。
- 签名状态只通过 **1.3 的 preview** 消亡：同签名下次调用时，若
  `contentHash != contentHashAtFailure`（文件已变）且 preview 通过 → 清除并放行；
  preview 仍失败 → 拦截。换言之签名不清则已，清必有证据。
- `resetEditFailureTracking(scopeId)` 只清当前 scope（顶层 run 开始时清顶层 scope；
  子 Agent 结束清自身 scope）。不再有全局清表路径。
- 表满 LRU 淘汰是唯一的隐式清除。

### 1.5 canonical lock key（顺手修复，评审修正项）

当前 `executeWithLock`（fileTools.ts:110-125）与 runner `writeQueue.enqueue` 的 lockPaths
都用 resolve 前的原始 `args.filePath`，相对/绝对/大小写别名会拿到不同锁。

- 新增 `canonicalPathKey(filePath)`（`path.resolve` + 分隔符归一 + win32 小写，
  与 `ReadTracker.normalizeKey` 同规则），统一用于：`vfsLocks` key、`writeQueue` lockPaths、
  本守卫的 `pathKey`、现有 `editFailCount` key。
- 效果：别名共享同一把锁（严格更安全），签名/计数也不再因别名分裂。

### 测试计划

1. 同一 stale anchor 连续 2 次失败 → 第 3 次同签名被拦截且文件未写；
2. ambiguous anchor 同样生效；`replace_lines` 的 expected* stale 走 expected* 复检路径；
3. 同文件不同 anchor（新策略）不触发拦截；
4. 失败 2 次后外部修改文件使 anchor 成立 → preview 放行且签名清除；
5. 成功写入后**不清**其他 anchor 签名（v1 行为纠正的回归锁）；
6. **两个并行子 Agent 对同一文件、同一 anchor 的失败互不计数**（scopeId 隔离）；
7. 相对路径/绝对路径/大小写别名命中同一把锁、同一条签名；
8. `structure_rejected`/`invalid_args`/`io_error` 重复出现也永不拦截；
9. YML 重定向、tool-call/result 配对不受影响。

> 实施记录（2026-08-02）：已落地，与设计的细节偏差——
> - 签名 key 含 errorClass；执行前 preview 先解析当前错误类别，只消费该类别预算；matched 时清除此 anchor 的旧类别签名；
> - `scopeId` 缺省为 `'top'`；validation loop 与主循环共享 runId；
> - `resetEditFailureTracking(scopeId)` 已实现 scoped 清理；子 Agent 结束时的自动调用未接线，
>   由 256 条 LRU 上限兜底，顶层 run 重置全清；
> - `editFailCount` 键同步改为 canonicalPathKey（落实设计 1.5 的"锁/签名/计数同键"）；
> - 测试文件 `client/test/unit/anchorGuard.test.ts` 覆盖 CRLF/LF 归一化、成功后清零、并行竞态和错误类别转换。
>
> 评审修订（2026-08-02，隔离评审 warn 后修复）：
> - 清除条件改为 **preview 优先**：删除"内容哈希变化"前提——replace_lines 最常见的自纠正是
>   改行号不动内容，旧前提会误拦截；`contentHashAtFailure` 字段随之移除（附回归测试）；
> - `signatureKey` 改 NUL 分隔，`resetEditFailureTracking` 前缀匹配补 `` 边界；
> - `ReplaceLinesResult.currentContentPreview` 成为正式可选字段，移除两处 `as any`。

---

## 设计 2：统一免费剪枝阶梯（ContextMaintenanceCoordinator）

### 目标

所有付费压缩入口统一决策，但**按调用原因区分语义**（评审阻断项 2）：

```ts
export type MaintenanceReason = 'admission' | 'manual' | 'mid_loop' | 'overflow' | 'emergency';
```

| reason | 语义 |
|---|---|
| `admission` | 先统一口径估算；**未超阈值则原样返回，不修改历史**；超阈值 → 剪枝 → 重估 → 仍超才摘要 |
| `mid_loop` | 仅在被 0.78 检查触发时调用；剪枝 → 重估 → 仍超 0.80 才摘要 |
| `emergency` | 超 0.92 触发；剪枝 → 重估 → 仍超才摘要；throttle bypass 行为不变 |
| `manual` | 剪枝后**必须生成摘要**（用户点了"压缩"就是要摘要），即使估算低于阈值 |
| `overflow` | Provider 明确报 context overflow，**权威信号，强制摘要**；剪枝只用于缩小 summarizer 输入，不作为跳过依据。"一次免费重试"状态机明确不在本期 |

### 前置纯重构（实施第 0 步）

把 `estimateTokenCount`/`estimateTokensFast`/`estimateTokensPrecise`/`estimateChatMessageTokens`
及常量（agentRunner.ts:139-226）原样抽到 **`runner/tokenEstimation.ts`**，agentRunner 改为 re-export。
这是纯移动，先补行为特征测试（现有 `agentRunnerState.test.ts`/`promptBudget.test.ts` 已覆盖
部分用例，直接随迁）。目的：`runner/contextMaintenance.ts` 与 `runner/tokenCalibration.ts`
不反向导入 agentRunner，避免模块环（评审修正项）。

### 2.1 模块与接口

```ts
// runner/contextMaintenance.ts
export interface MaintenanceDeps {
  toolResultBudget: number;
  compactionOptions: CompactMessagesOptions;
  toolSchemaTokens: number;    // 与 reservedTokens 分开传（评审修正项）：
  reservedTokens: number;      // admission 已各自算过一次，直接透传，不重复计算 schema
  modelLimit: number;
}
export interface MaintenanceResult {
  messages: ChatMessage[];         // admission 未超阈值时为原数组引用（未修改）
  estimatedRequestTokens: number;  // 统一口径
  action: 'untouched' | 'pruned-below-threshold' | 'summarize';
}
export function runContextMaintenance(
  messages: ChatMessage[], reason: MaintenanceReason, deps: MaintenanceDeps,
): MaintenanceResult;
```

统一估算口径 `estimateContextTokens`（位于 tokenEstimation.ts）：
`Σ estimateChatMessageTokens(messages)`（含 tool_calls/reasoning/continuation state）
`+ toolSchemaTokens + reservedTokens`。

### 2.2 集成

> 实施记录（2026-08-02）：最终采用**调用点协调器 + wrapper 透传**而非"wrapper 内置协调器"。
> 原因：mid_loop/emergency 的 ledger 事件与 step 需要 before/after 数值且在不摘要时也要发出，
> 协调器放调用点可直接复用这些数值；admission 统一经 `precomputedRequestTokens` 把协调器估算
> 透传进 wrapper，保留 canonicalize 副作用且非 summarize 分支零模型调用。
> 语义与设计完全一致：所有付费入口都先过 `runContextMaintenance`。

- `runner/contextMaintenance.ts` 提供 `runContextMaintenance(messages, reason, deps)`：
  `untouched`（仅 admission 低阈值，原数组不动）/ `pruned-below-threshold`（免摘要）/ `summarize`；
- 五个调用点各自传入对应 reason 与本入口口径的 `extraTokens`/`summarizeThreshold`；
- mid_loop 的"剪枝减少 <10% 才升级付费"anti-thrash 门槛以 `ineffectivenessGate` 保留；
- `CompactionBudgetOptions.precomputedRequestTokens` 让 compaction.ts 的阈值判定消费统一估算；
- 传入 `precomputedRequestTokens` 时跳过 compaction.ts 的历史正文 2048-token 旧门槛，避免统一决策被二次推翻；
- 集成测试分别验证 manual 与 overflow 不只返回 `summarize`，还会实际调用一次 summarizer；
- 删除原 :2391-2395 与 :3914-3917 的重复剪枝块及已无调用方的 `compactMessagesInPlace` 私有 wrapper。

### 2.3 明确不动的行为

摘要缓存、throttle（60s/92% bypass）、60% target、abort、token accumulator、
3 次 summarizer 重试、fallback tail、0.78/0.80/0.92 三个阈值比率。

### 2.4 后续扩展点（不在本期）

per-tool snip 几何作为 `tools/registry.ts` 收紧型元数据接入 `compactMessagesInPlace`；
`MaintenanceDeps` 预留扩展位。不另建绕过 registry 的工具接口。

### 测试计划

1. admission：低于阈值的历史**逐字节不变**（同一数组引用/深比较）；
2. manual：历史低于阈值也**必须**产生一次 summarizer 调用；
3. overflow：本地估算低于阈值也**必须**产生一次 summarizer 调用；
4. mid_loop：剪枝后低于 0.80 → 零模型调用；仍超 → 恰好一次 summarizer（缓存 miss 时）；
5. 剪枝前后 tool-call/result 配对完整；`[Context Recovery]` summary pair 原子保留；
6. admission 与 mid_loop 对同一历史做出一致决策（阈值差异除外）；
7. emergency bypass throttle 行为不变；摘要缓存命中路径不变。

---

## 设计 3：真实 usage 校准的 token 估算

### 目标

按响应实际归属的 `{provider, model, apiFormat, endpoint}` 维护有界 EWMA 校准系数；
估算侧与决策侧同口径、不重复计数（评审阻断项 3）。

### 3.1 采样公式（纠正 v1 重复计数）

主循环 seam（agentRunner.ts:2799-2817）：

```ts
estimated = estimateChatMessagesTokens(messages)        // messages 已含 system/context/user（:1278-1283），
          + estimateEffectiveToolSchemas(availableTools) // 不再加 fixedPromptTokens（会重复）
          + providerNativeRequestOverhead;               // adapter 可声明的固定开销，默认 0
actual    = usage.prompt_tokens;                         // 仅真实存在时采样（fallback 自估算不参与）
```

- `estimateChatMessagesTokens` 是设计 2 前置重构抽到 `runner/tokenEstimation.ts` 的 plural 版本；
- **压缩请求**（compaction.ts:430-478）只估算实际 `compactionMessages`，不加主循环任何固定提示；
- **采样 key 用响应侧真实值**：`responseProviderId`（:2810，fallback 路径经 `__providerId`，
  fallbackPolicy.ts:52）与 `response.model`，绝不用 config 值——否则 fallback 会记错 provider；
- key 格式带分隔符 + 端点指纹（评审修正项）：
  `providerId + '' + model + '' + (customApiFormat ?? '') + '' + endpointFp`，
  其中 `endpointFp` = 规范化 baseURL 的 sha256 前 8 hex；custom/relay 端点更换后不复用旧校准。
  key 不含路径与用户内容，满足脱敏。

### 3.2 表与生命周期

```ts
// runner/tokenCalibration.ts
interface CalibrationEntry { ratio: number; samples: number; updatedAt: number; }
export class TokenCalibrationTable {
  record(key: string, estimated: number, actual: number): void; // EWMA α=0.2，clamp [0.5, 2.0]
  apply(key: string, estimated: number): number;                // samples < 5 原样返回
}
```

- 单样本比率超出 `[0.25, 4]` 拒绝；容量 50 键 LRU；不跨 key 共享。
- **创建与注入**（评审修正项）：在 `extension.ts` 构造（早于 `AgentRunner`，:1146），
  经构造函数/options 注入 Runner 与 compaction 依赖；不再由 chatPanel 持有。
- **持久化**：globalState `cwtools.ai.tokenCalibration.v1`；
  读取时按 `unknown` 逐字段类型收窄 + version 校验（评审修正项），坏数据整体丢弃回退冷启动；
  写入单飞串行化（pending promise 链），run 结束 + 每 20 样本防抖。

### 3.3 消费点

所有阈值决策读取估算处（admission、mid_loop :2370、overflow :2647-2649、emergency :3893-3895、
`estimateContextTokens`）经 `apply` 修正。`runMetrics.finalPromptTokens` 保留未校准原值，
另记校准后值。RunBudgetTracker 用真实 usage，不在校准范围。

### 测试计划

1. 离线误差：CJK/英文/代码+大 schema 三类负载，校准后误差收敛（`tools/perf/` 基准，非 CI 硬阈值）；

> 实施记录（2026-08-02）：已落地，与设计的细节偏差——
> - key 分隔符为 `''` 转义形式（字面 NUL 不进源码）；model 统一小写，并使用实际 provider、wire format 与该 provider 的 effective endpoint；
> - 采样点：主循环 usage 块（仅真实 `prompt_tokens`，fallback 自估算不采样）+
>   compaction 经 `CompactionBudgetOptions.onUsageSample` 回调，两处 key 均来自响应侧；含 `image_url` 的主请求不写入纯文本校准样本；
> - 消费：四个入口经 `MaintenanceDeps.calibrateEstimate` 注入闭包，coordinator 对
>   before/after 统一套用；`runMetrics.finalPromptTokens` 保持未校准原值，
>   "另记校准后值"未实现（低价值，留作后续）；
> - 表在 `extension.ts` 构造注入，globalState `cwtools.ai.tokenCalibration.v1`，
>   逐字段类型收窄 + 最新 50 项硬上限 + 单飞串行写；每 20 样本、每次 run 结束和 extension dispose 时持久化，失败报告并保留 dirty 状态供重试；
> - 测试覆盖 record、key、容量上限、低样本 flush、持久化失败重试、多模态过滤与 runner/compaction integration。
2. EWMA 收敛、clamp、异常样本拒绝；`samples < 5` 原样返回；usage fallback 不采样；
3. fallback 到备用 provider 时样本记入响应侧 key，不污染主 provider；
4. 持久化 round-trip；坏 JSON/错版本/字段类型错误均安全回退；容量淘汰；并发写串行；
5. 阈值决策集成：同一历史校准前后触发/不触发剪枝，方向符合比率。

---

## 实施顺序（按评审建议）

| 序 | 项 | 内容 | 验证 |
|---|---|---|---|
| 0 | 纯重构 | 抽 `runner/tokenEstimation.ts` + 行为特征测试 | `npm run compile` + 既有估算单测 |
| 1 | 设计 2 | ContextMaintenanceCoordinator + reason 语义 | 定向单测（含 manual/overflow/低阈值不变） |
| 2 | 设计 1 | scopeId anchor guard + canonical lock key | 定向单测（含并行子 Agent/别名/非 anchor 错误） |
| 3 | 设计 3 | 校准表 + extension.ts 注入 + 持久化 | 定向单测 + perf 基准 |
| 4 | 合入前 | 全量门禁 | `npm run compile`、定向测试、`npm run test:unit`、`npm run verify` |

## 显式不做（与两轮审批对齐）

- 不把签名状态放进无 scope 的全局表；不用 `as any` 透传 scopeId；
- 不对非 anchor 类失败做守卫拦截；
- admission 低阈值不修改历史；manual/overflow 永不跳过摘要；
- 不做"overflow 免费重试"状态机（如需另立设计）；
- 校准不做跨 key 共享、不做主动探测采样、不用 config 侧 provider/model 作 key；
- 不新增 run-event 类型；不动 DoomLoop/consecutiveErrorCount/`tool_repeat_escalated` 语义。
