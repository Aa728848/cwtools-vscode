# Reasonix vs cwtools-vscode 内置 Agent：事实复核与修订路线

> 复核基线：cwtools-vscode `ee1dd600`（2026-08-01），Reasonix `e2fe1616`（2026-08-01）。  
> 本文修订的是对比结论和实施优先级，不代表已经批准或实现其中的运行时改造。

## 结论

原报告的总体判断基本成立：cwtools-vscode 已有较强的领域隔离、工具策略、沙箱、Run Ledger、DAG 编排和质量门；真正值得继续借鉴的是更细粒度的上下文维护、失败签名、传输恢复和历史检索。

但原报告不能直接作为实施清单，原因有三类：

1. **事实已过期**：当前项目已经具备原报告列为缺失项的能力，包括免费原地压缩、工具调用补对、Agent hooks、分层 `AGENTS.md`、Skills 的 `runAs` / `allowed-tools` 解析，以及有界的 Resume State。
2. **把不同职责误判为重复实现**：Topic UI 历史、Thread 元数据、Run Ledger、Resume State 和完整 transcript 分别服务于展示、拓扑、审计、恢复和取证，不能未经 authority/retention 审计就合并成一个文件或一个事件流。
3. **存在与基础架构相冲突的照搬建议**：永久累积所有摘要会重新引入上下文增长；把所有间接命令一律改为人工审批会否定当前“策略判定 + OS 沙箱”的执行模型；把 Reasonix 的官方 DeepSeek Beta 特例泛化到所有 OpenAI-compatible Provider 也不安全。

修订后的优先顺序是：

1. 在现有按文件失败预算和 Doom Loop 之上增加 **anchor/intent 级重复写失败守卫**。
2. 把已有的免费 `compactMessagesInPlace` 统一放到所有付费摘要之前，形成一致的 **先剪枝、再重估、后总结** 阶梯。
3. 使用真实 usage 做 **按 provider/model/api-format 隔离的有界估算校准**。
4. 以能力开关实现 **仅限受支持 DeepSeek 官方端点的前缀续写**，并把传输恢复预算与正常推理迭代分开。
5. 在 Orchestrator 层增加 **父级恢复风暴熔断**，但保留子 Agent 本地的精确操作预算。

## 不可破坏的现有系统边界

任何改造都必须保持以下约束：

- `tools/registry.ts` 继续作为工具 effect、risk、domain 和 concurrency 的单一事实源；模型可见工具仍须经过 definition、type、registry、permission 和 dispatch 的完整链路。
- 一次 Run 的 capability domain 不可被 Workflow、Skill 或子 Agent 扩大；它们只能继续收紧权限。
- `policyEngine.ts`、`commandPreflight.ts` 和 OS sandbox 是叠加边界，不得用新的 failure/recovery hook 绕开审批、ReadTracker、写入锁或 Plan gate。
- 压缩、恢复和持久化必须继续使用 `contextTranscript.ts` 的 canonical transcript，不能拆散 assistant/tool-call/result 组。
- 多 Agent 写入仍须遵守父级 writable root、per-file write exclusion、排序锁和本地化专用 writer。
- Webview 只做展示和 IPC，不得承担历史文件、Resume、索引或 Snip 的文件 I/O。
- 新缓存、历史检索和校准状态必须有界，并遵守 `history.persistence`、保留期限、总字节数和路径脱敏策略。

## 逐项复核

### 1. 免费剪枝优先于付费压缩

**判定：方向正确，现状描述不完整。**

Reasonix 的默认阶梯确为 50% 软提示、60% snip、80% summary trigger、90% force（`internal/agent/compact.go`）。它还会在 80% 后先 prune，若重估已低于阈值则跳过 summarizer。

cwtools-vscode 并非“80% 直接付费且没有免费路径”：

- `contextBudget.ts` 的 `budgetToolResult` 会在工具结果进入上下文时有界化；
- `compactMessagesInPlace` 会裁剪旧工具结果、旧 assistant reasoning 和 provider continuation state；
- `agentRunner.ts` 在 mid-loop 和 92% emergency path 中先调用免费原地压缩，再决定是否调用 `maybeCompactHistory`；
- 付费摘要有 80% high watermark、60% target、最短间隔、摘要缓存和最多三次有界重试。

真实差距是：**自动入场压缩与 mid-loop/emergency 使用了两套决策路径**。普通 `maybeCompactHistory` 在越过阈值时没有统一先执行免费剪枝。

**修订建议**：提取一个 Context Maintenance Coordinator：规范化 transcript → 免费裁剪 → 重估（含 tool schema/reserved tokens）→ 仍超阈值才调用 summarizer。per-tool snip 几何应作为 registry 中的收紧型元数据，不另建可绕过 registry 的工具接口。

### 2. “钉住前缀”与摘要漂移

**判定：Reasonix 事实被夸大，原建议与当前低水位设计冲突。**

Reasonix 并非“所有用户轮永不折叠”：它逐字保留的是足够小的用户轮；超过 1500 token 或 context window 15% 的大段粘贴内容仍可折叠。既有 digest 确实不会被再次总结。

cwtools-vscode 当前有意只保留最新 rolling summary，并在更新时替换旧 summary；源码明确指出保留所有累积摘要会造成二次增长。完整 transcript 已另行归档并带 SHA-256，因此“所有 digest 永远追加进活动上下文”不适合直接照搬。

**修订建议**：不要累积全部摘要。应把不可漂移内容拆成小型结构化 anchors（用户约束、已确认决策、文件状态、未完成项），rolling narrative summary 仍可重写；用归档引用和 hash 保留可追溯性，并增加多轮压缩的 invariant regression test。

### 3. 语义级重复失败守卫

**判定：值得做，但原报告漏掉了现有的编辑失败防线。**

Reasonix 对写调用构造语义签名，并在相同写意图和错误类别连续失败后阻止再次执行；对 stale/ambiguous anchor 会通过无副作用 `Preview` 重新检查。

cwtools-vscode 已有：

- `FileToolHandler` 的按文件失败计数：3 次强制重读提示，5 次停止继续编辑该文件；
- replacer 的多级容错、nearest-match 和 `replace_lines` 修复建议；
- `DoomLoopState` 的调用对频率与规范化 result hash；
- 工具调用去重与 `tool_repeat_escalated` ledger event。

剩余缺口是现有计数按文件聚合，无法精确区分“同一 stale anchor”与“同文件上的新策略”。

**修订建议**：增加 `{tool, normalizedPath, anchorHash, errorClass}` 签名；在同一文件锁和 ReadTracker 约束内做 preview；只有被验证的重叠写入或 preview 状态变化才清除相应签名。它应补充而不是替换现有 per-file budget 和 Doom Loop。

### 4. 跨子 Agent 的恢复预算

**判定：问题存在，但不能直接复制 Reasonix 的共享模型。**

Reasonix 的 episode hard-stop 由根任务和子任务共享，精确 operation failure 仍保留在 task-local state。cwtools-vscode 的每个子 Agent 使用独立的 `run()` 窗口和 `RunBudgetTracker`，父级在 dispatch 完成后合并 token usage；context overflow、length、重复输出和 compaction thrash 也分别计数。

> 勘误（第二轮设计评审）：子 Agent 的 run/预算窗口独立，但 `toolExecutor/FileToolHandler`
> 是共享的（`agentRunner.ts:1900-1904` 注释明示 "sub-agents share the executor"）。
> 因此"精确 anchor/operation 计数留在子 Agent"不能靠独立 handler 实例实现，
> 需要按 scopeId 隔离，详见 `docs/reasonix-p0-design.md` 设计 1.2。

两者的子 Agent 语义不同：cwtools-vscode 允许有界并行 DAG 和不同写入角色，一个失败子任务不应立即耗尽所有兄弟节点的精确操作预算。

**修订建议**：在 Orchestrator 增加父级 storm budget，只聚合跨节点的同类系统性失败、reviewer rejection、无进展修复波次和已停止操作的重复提议；精确 anchor/operation 计数继续留在子 Agent。父级熔断必须写入 Run Ledger，并允许仍安全的只读诊断完成。

### 5. 流中断恢复与 DeepSeek 前缀续写

**判定：真实差距，但必须缩小适用范围。**

Reasonix 只在响应 header 阶段做普通 retry；流开始后用独立中断恢复。官方 DeepSeek endpoint 支持的 `prefix:true` 被用于 `finish_reason=length` 的文本/思维续写，并合并 usage。

cwtools-vscode 已有 socket/ECONNRESET 和 `finish_reason=length` 的 chunked guidance，但它们会进入新的 reasoning iteration；当前没有 DeepSeek Beta prefix continuation。

**修订建议**：

- 仅对明确声明并通过 contract test 的 provider capability 开启 continuation；首个目标应是官方 DeepSeek Beta endpoint，而不是所有名字含 `deepseek` 的 relay/custom endpoint。
- 只续写可安全拼接的 text/reasoning；截断的 tool call、结构化输出或未知 provider state 必须走普通恢复。
- transport reconnect 可不消耗正常 tool iteration，但必须计入 API 次数、token、费用、墙钟和独立的最大恢复次数。
- 删除“cwtools 用户大量使用 DeepSeek”的无证据判断；是否优先应由本地匿名统计或用户反馈决定。

### 6. 用真实 usage 校准 token 估算

**判定：建议成立，但不是原报告所称的单一固定 CJK 比率。**

当前 `estimateTokenCount` 对短文本使用 CJK/ASCII 比率，对长文本使用单词、CJK、数字和长标识符的精细启发式；真实 usage 也已经进入成本、缓存和 Run Metrics。缺少的是把两者闭环。

**修订建议**：按 `{providerId, model, customApiFormat}` 维护有界 EWMA 校准系数；样本必须比较同一份最终 provider request 的估算量与 `prompt_tokens`，并包含 tool schema/provider-native continuation state。对异常比率做 clamp，冷启动继续使用现有估算器，不跨模型共享样本。

### 7. 会话持久化统一为事件日志 + CAS

**判定：原报告对 cwtools-vscode 的描述已经过期，且“全部统一”风险过高。**

Reasonix 是 append-first event log，但并非永不重写：事件日志超过至少 256 KiB 且大于活动 transcript 编码大小的 4 倍时会 compact。它具有 revision/base_revision/content_digest、torn-tail salvage、lock/lease 和 conflict recovery branch。

当前 cwtools-vscode 的存储不是五份无界全量副本：

- `checkpoint.json`：有损、只用于 UI/轻量进度；
- `resume_state.json`：summary + 最多 24 条尾部消息，并非全量数组；
- `resume_transcript.json`：按 Run 归档的完整恢复证据，带 SHA-256；
- `threadStore`：Thread/Run 拓扑和状态元数据，不保存消息正文；
- `runLedger`：事件、审计、回放和 provider request artifact；
- `ai-chat-topics.json`：聊天 UI 历史，最多 50 个 Topic。

私有历史还有默认 30 天/256 MiB 总量限制。因此“resume 每轮全量写入且磁盘无界”不符合当前事实。

**修订建议**：先写 authority matrix（谁是 UI、恢复、审计、回放、拓扑的权威），再淘汰确属兼容遗留的 `checkpoint.json` 或重复 projection。只在多窗口/多进程竞争真实存在的边界增加 CAS；不要把 UI Topic、Thread 元数据和恢复证据强行塞进单一 Ledger。

### 8. 记忆系统

**判定：原报告混淆了 Blackboard 搜索与长期记忆注入。**

`search_memory` 当前确实对 topic/domain scoped Blackboard 做 substring 查询；但长期结构化记忆由 `memoryParser.ts` 单独管理。它已经记录 kind、domain、source、confidence、revision/projectRevision、freshness、usage、expiry 和 stale 状态，按任务关键词、路径、优先级、置信度、时效和真实使用次数做有界 top-k 排序。注入文案也已经明确：记忆只是可能过时的私有提示，不覆盖当前用户指令、安全策略、诊断或验证后的项目证据。

真正缺少的是多写者并发控制、显式 archive/forget 语义，以及更强的 lexical ranking。

**修订建议**：先为 topic memory 增加串行写队列或 expected revision；若离线评测证明 substring/当前 hybrid scorer 召回不足，再把 BM25 作为相关性分量加入，不能替换 priority/confidence/freshness/provenance。任何 forget 都要区分归档、删除和“本轮已加载但后续忽略”。

### 9. 历史会话搜索工具

**判定：功能缺口真实，方向可取。**

Reasonix 的 `history` 工具按调用扫描允许的会话根并做 BM25；默认排除普通 tool output，`around` 默认返回命中前后各 3 条。cwtools-vscode 目前只有用户 UI 的 Topic substring 搜索，模型没有对应工具。

**修订建议**：可新增只读 `history` 工具，但必须完整接入 definition/type/registry/permission/dispatch；默认只搜当前 workspace/topic-domain，服从 `history.persistence`，不泄露绝对本地路径，普通 tool output 默认排除，并把历史内容标记为不可信背景而非指令。应使用有界候选集或缓存，不能每次无界扫描所有 transcript。

### 10. Shell 间接执行拆解

**判定：原报告已过期，且建议与当前沙箱模型部分冲突。**

当前 `commandPreflight.ts` 已经：

- 分割 `&&` / `||` / `;` / pipeline；
- 递归分析 `bash|sh|zsh -c`、PowerShell command 和 `cmd /c`；
- 解包 `sudo` / `env`；
- 将 command substitution、重定向、脚本块和 malformed quotes 降级为 `prompt`；
- 阻止 `find -exec/-delete`、高危删除和破坏性 Git；
- 禁止为解释器、Shell 或 Git 保存过宽的 allow prefix。

剩余覆盖差距主要是 `eval`、`xargs`、`python -c`、`node -e` 等 opaque inline interpreter payload。

**修订建议**：补齐间接执行分类和测试，但不要采用“只要间接执行就永远人工”的全局规则。当前基础设计允许普通 workspace mutation 在经过 policy 后由强制 OS sandbox 约束；只有复杂/不可证明、越界、额外网络/cwd 或 unsandboxed 场景才需要升级审批。

### 11. 取消时的 tool-call/result 配对

**判定：核心能力已经存在。**

`contextTranscript.ts` 的 canonical normalization 会移除 orphan/duplicate result，并为未完成 tool call 自动补 `{ interrupted: true }` 的合成 result；Resume 和 Compaction 都使用这条路径，且已有回归测试。因此无需再复制一套“取消时补 cancelled result”的逻辑。

仍应改进的是 `(this as any).initialPendingToolCalls`：它保存的是待恢复并重新审批的交互操作，不是 transcript 配对的唯一保障。

**修订建议**：把它改成显式 typed field，或完全迁移到已有 `pendingStepRequests` / retry step request；保持恢复后重新审批敏感操作的语义。

### 12. 生命周期 Hooks

**判定：已经实现，属于产品化缺口而非新能力。**

当前 `hookRunner.ts` 已支持 `userPromptSubmit`、`preToolUse`、`postToolUse` 和 `stop`；只在 trusted workspace、显式启用且命令位于 allowlist 时执行。Tool execution pipeline 和 loop kernel 也有内部 hook slots。

**修订建议**：补 package configuration schema、用户文档、配置校验、超时/取消策略和中英文错误展示。不要开放任意 shell hook，也无需复制 Claude 兼容格式。

### 13. Skills frontmatter

**判定：`runAs` 和 `allowed-tools` 已解析，但当前主要是 advisory metadata。**

`skills.ts` 已索引 built-in/user/project Skill，解析 `runAs`、`allowedTools` 和 capability domain，并按需加载正文。`run_skill` 会返回这些字段，但 `allowedTools` 尚未形成一次 Skill invocation 的强制 tool-policy 交集，`runAs` 也只是调度指引。

**修订建议**：先决定字段是 advisory 还是 enforced；如果强制执行，只能与当前 domain/mode/profile/workflow policy 求交集，绝不能扩大权限。随后再考虑 `invocation: manual`，并为旧 Skill 保持兼容默认值。

### 14. 指令分层

**判定：原报告“单层读取”不符合当前事实。**

`projectInstructions.ts` 已读取根 `AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`，并按目标路径从 workspace root 到目标目录叠加 nested `AGENTS.md`；路径必须位于 workspace 内，且 prompt 明确把仓库指令视为不可信 repository policy。

**修订建议**：可选地增加 user-scope 指令和内容 hash 去重，但优先级、来源显示和信任边界必须明确。hash 去重只是 token 优化，不是当前功能缺失。

### 15. Provider 能力探测

**判定：应采用“声明 + 观察证据”的混合模型，不应做盲目主动探测。**

当前确有约 22 KiB 的模型能力表，但也已经有 provider adapter、Anthropic per-model feature derivation，以及“观察到 cache hit 即证明 cache capable”的运行时证据。Reasonix 所谓 feature detection 主要是 Go interface/type assertion，不等于对远端 API 逐项发请求探测。

**修订建议**：逐步把功能能力收敛为 provider adapter 的 typed capability；模型表只保留无法从协议推断的静态差异。运行时观察只能把能力从 unknown 提升为 supported，失败不能轻率证明 unsupported；不得为探测制造额外计费调用或发送用户上下文。

### 16. 错误分类

**判定：方向正确，但“Reasonix 只有四种错误”不应成为目标。**

cwtools-vscode 仍有多个依赖错误字符串的恢复分支，例如 fallback、rate limit、context overflow、stream disconnect 和 cancellation。适合逐步引入 typed control-flow errors。

**修订建议**：先覆盖 provider transport、rate limit、context overflow、cancellation、sandbox unavailable、permission denial 和 tool validation；用户/Provider 原始错误仍作为 cause/context 保存到 `ErrorReporter` 和 Run Ledger。不要为了减少类型数量而丢失诊断信息。

### 17. God-file 风险

**判定：成立，但应承认已经开始按机制拆分。**

当前约为：`agentRunner.ts` 4811 行/251 KiB、`agentTools.ts` 3505 行/181 KiB、`chatPanel.ts` 4045 行/200 KiB。与此同时，compaction、checkpoint、policy、scheduler、hooks、state、tool handlers 和 chat bridge 等能力已经逐步外移。

**修订建议**：继续按机制和可测试状态机拆分，优先抽出 recovery coordinator、context maintenance coordinator 和 provider continuation；不要只为缩短文件再增加一层无职责目录，也不要让新模块绕开现有 registry/policy/event reducer。

## 修订后的实施路线

### P0：局部、高收益、可回归

1. **Anchor-aware failure guard**
   - 扩展现有 FileToolHandler 失败追踪，不新建第二套写执行器。
   - 覆盖 `edit_file` 和带 `expectedContent` 的 `replace_lines`。
   - 测试 stale anchor、ambiguous anchor、同文件新 anchor、外部修改、成功重叠写后的精确清理。

2. **统一免费剪枝阶梯**
   - 所有 paid compaction 前先 canonicalize、免费剪枝和重估。
   - 保持 summary cache、abort、tool pairing、token accumulator、60% target 和 92% emergency 行为。
   - 测试“剪枝后低于阈值不调用模型”和“剪枝不足时只调用一次 summarizer”。

3. **Usage calibration**
   - per provider/model/api-format 有界 EWMA；异常样本拒绝；无 usage 时回退现有估算器。
   - 用不同 CJK/英文/代码/tool schema 组合做离线误差测试。

### P1：需要 Provider/Orchestrator 设计

4. **DeepSeek 官方 prefix continuation**：capability gated；先做 provider contract tests，再接 runner。
5. **父级 recovery storm budget**：只聚合系统性恢复和修复波次，不吞并子节点精确失败预算。
6. **模型可见 history 工具**：workspace/domain/persistence scoped，默认排除普通 tool output，严格有界。
7. **typed pending step restore**：消除 `initialPendingToolCalls as any`，复用 V4 StepRequest。

### P2：先审计或评测，再改结构

8. 存储 authority/retention matrix 与真正重复 projection 的迁移计划。
9. 长期记忆的串行写/CAS、可选 BM25 hybrid 和 archive/forget 语义。
10. Hooks 设置与文档产品化；Skill metadata 的强制语义。
11. Provider capability adapter 与 typed recovery error 的渐进收敛。
12. 按 recovery/compaction/provider continuation 机制继续拆分 god files。

## 明确不建议执行

- 不把所有历史 digest 永久塞回活动上下文。
- 不立即把 Topic、Thread、Resume、Ledger 和 transcript 合并为一个存储格式。
- 不为所有间接/解释器命令强制人工审批，从而绕开既定 OS sandbox 产品模型。
- 不按 provider 名称猜测 DeepSeek prefix 能力，也不对 custom gateway 自动使用 Beta 协议。
- 不用纯 BM25 替换现有 provenance/priority/confidence/freshness/usage 记忆评分。
- 不新增任何绕开 registry、policy engine、domain boundary、ReadTracker 或 Run Ledger 的“快捷”恢复路径。
