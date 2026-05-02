# Changelog

## [1.8.9] - 2026-05-02

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX Improvements)
- **[修复] Minimax 模型内联补全被误拦截**：修复了 `minimax-m2` 关键字误伤导致 Minimax 所有模型（包括适合轻量级补全的 `highspeed` 变体）被错误地判定为硬核思考大模型并禁止执行内联补全的拦截漏洞。
- **[优化] 内联补全的错误诊断体验**：极大地提升了非 FIM 补全时“静默失败”带来的黑盒困扰。现在当遭遇模型空响应或内部异常被主动 `catch` 时，系统在保持 UI （编辑器中央）安静以维护打字心流的同时，将通过左下角状态栏黄色小喇叭图标闪烁警报，并将完整的堆栈或故障模型代号输出进专门的 `Eddy CWTool Code` 输出面板中。

## [1.8.8] - 2026-05-02

### 🛡️ AI 代理可靠性与技术债务修复 (Audit Hardening)
- **[修复] Claude SSE Thinking Token 路由错误**：修复了流式传输中 `text_delta` 事件同时被分发给内容和思考回调的漏洞。现在系统按 `currentBlockType` 严格区分 thinking 和 text 块，并将 `reasoningBuf` 正确装配进回复响应上下文。
- **[清理] AI 核心工具流代码净化**：删除了早期旧版本的废弃代码（如 50 余行的 `fromClaudeResponse` 以及基于 AsyncGenerator 的 `chatCompletionStream`），提升了全流式通讯底座的一致性与整洁度。
- **[优化] 代理资源池配置隔离**：彻底移除了不活跃的占位型计费统计代码 `sessionTokenUsage`/`reportUsage`。将 `STRIP_IMAGE_DETAIL_PROVIDERS` 等变量提升为安全模块级常量，并从单点导入 `TOOL_RESULT_BUDGET_BASE` 避免配置重叠和冲突。
- **[完善] 上下文预算池单元测试**：全面扩展了 `contextBudget` 等核心 Token 预算管理逻辑的单元覆盖度。新增了针对去重逻辑（dedup）、文件预读以及边界溢出等方面的 13 个专业用例。

## [1.8.7] - 2026-04-30

### ✨ 用户体验与性能优化 (UX & Performance)
- **精准的 AI 报错白名单审查机制**：全面重构了 AI 与用户配置的联动机制。为了防止 AI 在查询长配置表时因直接拉取庞大的 `.vscode/settings.json` 而遭遇 Token 上下文崩溃或读取干扰，系统内置了全新的专属 `get_ignored_diagnostics` 查询指令通道。该工具允许主脑以纯粹极简的数据流精确定位白名单清单。
- **智能报错隐匿报告 (Smart Negatives Reversal)**：极大增强了 AI 对抗用户不当设置的免疫力。当用户自己把本该警报的拼写错误误塞入了白名单中导致游戏静默报错时，AI 在执行代码合规性审查（`validate_code`）期间，只会精确定位并报告出**此次校验真正激活了拦截**的词汇，通过 `SYSTEM_WHITELIST_INFO` 将错误反馈至上游并给出针对性的剔除建议。

## [1.8.6] - 2026-04-30

### ✨ 新特性 (Features)
- **行级 Diff 可视化**：彻底告别文件级变更提示！AI 代理在修改文件后，现在会通过 Myers Diff 算法计算出精确的行级变更，并在聊天面板中呈现 GitHub 风格的绿/红代码差异卡片。可点击展开/收起，并展示带有上下文的代码变更。
- **快速修复与代码解释 (CodeActionProvider)**：引入深度集成的 `CWToolsCodeActionProvider`。光标悬停在任何 CWTools 诊断错误（红波浪线）上时，点击小灯泡即可直接请求 AI “修复此错误” 或 “解释此错误”。支持运行时中英文国际化，无缝衔接 VS Code 原生体验。
- **跨会话持久记忆 (Persistent Memory)**：新增了跨会话保留重要规则的 `.cwtools-ai-memory.md` 机制。AI 在执行任务中提炼出的核心规范（如特定的文件命名规则或作用域使用习惯）会被记录至项目根目录，并在后续所有会话中生效。内置自动裁剪算法防止超量引发 Token 爆炸。

### 🐛 Bug 修复与清理
- **移除上游遗留流水线**：删除了 `pr.yml` 和 `release.yml` 等无用流水线。
- **修复 Gitee 同步发布 Bug**：修复了 `sync-gitee.yml` 中导致构建 Asset 文件上传失败的端点错误（改用 release id 替代 tag name）。

## [1.8.5] - 2026-04-29

### ✨ 新特性 (Features)
- **科技树与事件链全景可视化**：
  - **新增科技树可视化（Tech Tree Visualizer）**：支持对群星（Stellaris）内庞杂的科技树依赖结构（前置科技关系）进行自动化拓扑渲染。系统支持自动网格分层级布局（Deterministic Grid Layout），物理学、社会学与工程学按垂直条带清晰排列，同梯队科技纵向展开，跨层依赖水平链接，彻底终结手搓科技树的视觉盲区！
  - **事件链系统大成**：事件链预览引擎（Event Chain Preview）在原有的事件走向网络基础上，全面兼容 `common` 文件夹下各种系统触发源的追踪，包括：科技研究完成、传统/飞升解锁、间谍行动、异常点、巨构建筑等，让你随时掌握游戏动态事件的深度演化路线。

### 🐛 Bug 修复与体验优化
- **[重大修复] 星系轨道漂移 Bug**：修复了星系可视化预览中，当给包含双子星等同轨道天体的星系分配环世界（或生成带有子级 `change_orbit` 参数的天体）时，内部私有的偏移参数会错误地向外泄露至整个系统，导致兄弟星球轨道发生严重相对位移错位的解析器漏洞。现在解析器严格遵循引擎作用域原则隔离星体轨距。

## [1.8.4] - 2026-04-29

### ✨ 新特性 (Features)
- **强化事件链解析能力**：大幅扩展了对 Common 文件夹下外部来源（如科技、传统、飞升天赋、间谍行动、异常点、巨构建筑等）触发事件的解析支持，使得事件网络追踪更为完备。
## [1.8.3] - 2026-04-29

### ✨ 新特性 (Features)
- **新增了事件预览相关内容**：引入了全新的事件链预览面板模块，支持可视化呈现与追踪游戏内的事件流向。
## [1.8.2] — 2026-04-28

### 🐛 Bug 修复与体验优化

- **[修复] 预缓存界面持续挂起 Bug**：补充了由 CodeLens 分帧预架构剥离引起的加载条回收漏洞。现在，当后台预扫描池结束 `precacheAllFiles` 时，将会正常下发 `100%` (`totalEntities/totalEntities`) 收尾信息，并向主视窗抛出 `enable: false` 正确注销正在加载的指示轮询。

## [1.8.1] — 2026-04-28

### ⚡ 性能优化 (Performance)

- **[重大优化] CodeLens 零阻塞零 I/O 预加载**：彻底重构了全局 CodeLens 类型的预热与缓存索引机制。现在缓存剥离于 `gameStateLock` 独占锁，通过懒加载形式建立以绝对路径为建档原点的倒查表 `cachedGroupedTypes`。这一改动实现了针对 CodeLens 请求从原 `O(N)` 全局扫表骤降至 `O(1)` 精确打击，并且 100% 消灭了由于假 Hash 初始化带来的磁盘重复 `ReadAllText` 读取消耗！

## [1.8.0] — 2026-04-28

### ⚡ 性能优化与 LSP 增量流 (Performance & LSP Delta)

- **[重大优化] SemanticTokens 增量解析下发 (`full/delta`)**：彻底重构了全局和全文件的语法高亮下发逻辑，利用一维数组剥头尾步长切片算法实现了极简安全的差分更新。现在在修改数万行的 PDX 脚本文件时，从原先发送上兆载荷变为了仅同步几十字节的增量编辑描述符（SemanticTokensEdit），彻底根治了大文件输入打字时的卡顿黏滞感。
- **[重大优化] F# 后端无锁安全并发**：将代码补全池 (`completionCache`) 与各路查询高速缓存挂载更换为 `ConcurrentDictionary`，引入基于 `Interlocked.Increment` 的无锁键极速分配，并在核心管线上全域启用了函数尾递归优化 `<Tailcalls>true</Tailcalls>`，终结了深递归栈溢出风险。
- **[系统升级] 自适应智能内存防溢出淘汰策略**：废弃了由条目数量激发的硬编码被动清理策略，转而全面改用 `GC.GetTotalAllocatedBytes` 为基准的容量释放阀门；引入全套写前置访问频次追踪 (`LRU 淘汰`)，不仅消解了长篇开发时爆发的 STW 长挂起，还能精确留存高频热更新代码页面的快照状态。
- **[架构级重构] 后端数据驱动流路由**：剥离并重写了原本累赘杂乱的全局事件映射与旧游戏运行时对象手动回收机制，将其全部统一为了数据字典驱动表 (`langConfigMap`, `gameFieldClearers`) 的优雅迭代结构，大幅下压了代码冗余度与未来维护成本。

## [1.7.0] — 2026-04-28

### ✨ 用户体验与稳定性优化 (UX & Stability)

- **[重大优化] Chat 滚动条体验升级**：彻底重除了之前固定激进的自动滚轴聚焦机制。如果在生成中时用户发生手动往上翻阅行为，系统将暂时冻结自动滚动到底部行为，生成完毕时也不会抢走视觉焦点突变回到底层，大幅度改善长文审阅手感。
- **[重大优化] 交互卡片生命周期管束**：完善 AI Action 按钮执行流钩子管理。当用户对如 "Review Plan" 等内嵌卡片做出同意或任意修改交互后，已挂载卡片会即付即焚进行自我销毁刷新，避免冗长记录中大量已归档的 Plan/Walkthrough 等历史脏卡片积压导致性能卡顿。
- **[安全扩容] 写入工具降级授权**：为匹配系统级别的 Agent 执行计划全流程记录留痕，现向 `write_file` 主力写入工具解锁覆写（Overwrite）安全越权，使之能流畅执行 Markdown 工作日记记录。但针对源代码级别非纯新增的实质破坏动作，它依然通过正则表达式屏障死死卡拦截在差分修补 `edit_file`。
- **[系统升级] 执行守卫系统提示**：深度强化对局部代码替换等无脑大面积抛弃系统预警提示符的抑制。系统约束将更加关注细粒度控制重构，并且要求代码更新执行同时连同附带着受限于事件链层析与系统性能波动的代码进行过滤重组。

## [1.6.9] — 2026-04-27

### 🤖 多智能体架构加固与原子化事务 (Multi-Agent Concurrency Hardening)

- **[重大更新] 挂载 VFS 事务管理器**：重构了 `AgentRunner` 的状态持久化机制。通过新增的 `pendingTransactions` 管理器，所有子智能体的文件修改现在将被原子化地缓存在内存中。用户可以通过 Chat 面板顶部的 **批量事务卡片** 统一进行 Human-in-the-Loop (HITL) 审阅并一键提交或回滚，彻底解决了多节点并发修改导致的中间态碎文件污染问题。
- **[重大更新] VFS 异步互斥锁逻辑**：在 `FileToolHandler` 底层引入了 `vfsLocks` 路径互斥锁。针对同一文件的读写操作现在会自动进行异步排队。在大规模并行任务（如全项目 `multiedit`）中，确保了即便多个子智能体同时撞车修改相同模块，代码流也能在逻辑上保持原子排序。
- **[增强] 子任务自愈机制 (Node-Level Self-Healing)**：拓扑调度器现在具备检测局部崩溃的能力。当子任务由于 LLM 幻觉或网络抖动失败时，系统将自动发起带上下文的重试 (`maxRetries = 2`)。即便最终重试失败，系统也会根据 DAG 依赖关系精准级联跳过受损分支，并确保其他独立并行分支的任务成果能够被安全提交（Partial Success 容错模型）。
- **[新功能] 语义化 Blackboard 内存检索**：为解决长程会话中共享内存（Blackboard）数据堆积导致的“提示词膨胀”问题，新增 `search_memory` 工具。子智能体可以通过模糊检索快速定位跨节点存储的 AST 或数据清单片段，系统会自动截取命中点周围 150 字符的预览窗格，极大节省了主线流程的 Token 预算。
- **[修复] `ExternalToolContext` 类型对齐**：修复了子代理派发过程中由于 `agentRunnerRef` 引用丢失导致的 `pendingTransactions` 写入失败及配套的 TS 编译报错。

## [1.6.8] — 2026-04-27

### 🛡️ 核心工具层隐患排除与体验优化 (Agent Resilience & Quality of Life)

- **[P0 安全] 封禁 `write_file` 覆写越权**：底层工具链正式禁用 AI 使用 `write_file` 覆写已有文件。所有非新增文件操作会被自动错误拦截至更安全的差分编辑工具 (`edit_file` / `multiedit`)，彻底切断了因为 AI 漏写代码导致的“全文件清空”级项目摧毁事故。
- **[P1 安全] 阻断动态 SSRF 内网穿透**：外部数据获取工具 (`web_fetch`) 加入原生 `dns.promises.lookup`，强制在 IP 层面拦截诸如 `localtest.me` 这种恶意绑定回 `127.0.0.1` 的钓鱼劫持，防止 AI 被诱导扫描宿主内网环境。
- **[P1 修复] 毁灭震荡打断 (Doom-Loop)**：将执行管线的错误记录器由“滑动视窗连续对比”升级为“跨时空频次雷达图”。当 AI 陷入 `A -> B -> A -> B` 的盲人兜圈行为时，只要同一指令被机械重复 3 次将原地斩杀，避免计费雪崩。
- **[优化] 搜寻爆破硬截断机制**：`search_mod_files` 加入全局 Top-15 泄洪闸门。当检索到过于基础的词汇引发上千条文件爆闪时，工具只会在末尾温馨提示 AI 优化搜索精度，彻底断绝了海量文本塞爆上下文缓冲区的危机。
- **[优化] `astMutate` 智能排版融合**：赋予 AST 刀法视觉对齐的修养。针对完全没有前置缩进的光头代码块插入时，引擎现在会聪明地抓取锚点节点的上下文进行 Tab/空格自适应继承补充。
- **[优化] LSP 污染警报器降噪处理**：局部多重微调在检索过高共用词（如 `}`）时，会触发数百条原版语法报错轰炸。目前已实装前置限流拦截网，最多只抛最高危的前 20 项核心 `Error` 诊断给 AI，有效防止误导。

## 1.6.7
- **架构与修复**:
  - 重构了 `AgentRunner` 执行管线，解决由于写入队列错误引发的重复执行和丢失子代理快照的漏洞。
  - 修复 `fileTools.ts` 中的局域文件读取缓存脏污染漏洞，禁止对被指定 `endLine` 裁剪的内容进行错误全局缓存。
  - 在 `promptBuilder.ts` 中恢复了 Paradox Namespace、Entity IDs 的强制压缩保护层，防止因为多轮对话长记忆被遗忘。
  - 下载和更新链接中的镜像代理域名升级为最新的 `gh-proxy.org` 及相关加速网络。

## 1.6.6
  - 通过将服务可释放物绑定到 VSCode 扩展垃圾回收生命周期，消除了 MCP 客户端状态持久性问题，确保在编辑器重新加载时优雅地拆除模型上下文协议。
  - 重新调整了多代理循环的内部调度模式子类型边界，以便正确路由 `build` 命令。

## [1.6.5] — 2026-04-26

### 🛡️ 安全加固与缺陷修复 (Audit Hardening)

- **[P0 修复] `multiEdit` TOCTOU 竞态消除**：写入文件后不再重新读取文件来计算诊断行号，改为直接引用内存中的 `content` 变量，消除了写入和读取之间其他进程修改文件导致诊断偏移的竞态风险。(`fileTools.ts`)
- **[P0 修复] 9-Slice Canvas DOM 泄漏**：`corneredTileSpriteType` 的 `drawNineSlice()` 现在在追加新 Canvas 前清理已有的旧 Canvas 元素，防止分辨率切换或重渲染时 DOM 中累积无用节点。(`guiPreview.ts`)
- **[P1 修复] LSP 超时定时器泄漏**：`lspRequest` 和 `vsCommand` 的 `setTimeout` 定时器现在通过 `try/finally + clearTimeout` 正确清理，防止长时间会话中无用定时器的积累。(`lspTools.ts`)
- **[P1 修复] `retractMessage` 硬编码 `-2` 偏移**：`convLength` 改为在消息交换前记录（而非交换后），`retractMessage` 直接 slice 到该位置而无需任何偏移。修复了消息生成失败时过度截断对话历史的潜在问题。(`chatPanel.ts`)
- **[P1 修复] `applyPatch` 快照时机**：将文件原始内容的快照捕获移到了确认循环之前。修复了用户在确认弹窗期间手动编辑文件后，撤回操作无法恢复到真实原始状态的问题。(`fileTools.ts`)
- **[P1 修复] `contentToString` 去重**：从 `agentRunner.ts` 和 `contextBudget.ts` 中提取为 `types.ts` 中的唯一共享实现，消除 DRY 违规与未来不一致风险。

### ⚡ 性能优化

- **Levenshtein 滚动数组**：模糊匹配的 Levenshtein 距离计算从 O(n×m) 空间优化为 O(min(n,m)) 空间，减少大文件编辑时的 GC 压力。(`fileTools.ts`)
- **CJK 自适应 Token 估算**：上下文压缩的 token 计数器现在根据内容中 CJK 字符的比例动态调整（英文 ≈4 字符/token，中文 ≈1.5 字符/token），修复了中文密集场景下 2× 低估导致的意外上下文溢出。(`agentRunner.ts`)

### 🔧 改进

- **命令安全白名单 (P2-11)**：`run_command` 的安全过滤器现在采用两级策略——危险命令（`rm -rf`、`shutdown` 等）始终拦截；管道/重定向检查允许已知安全前缀（`git log`、`dir`、`echo` 等）通过，减少对合法只读命令的误拦截。(`externalTools.ts`)
- **增量验证 (C3)**：`validateCode` 新增 Strategy 1.5——当目标文件已在编辑器中打开且有现有诊断时，直接返回 VSCode 已有的诊断结果，避免创建临时文件导致的 I/O 开销和文件闪烁。(`lspTools.ts`)
- **子代理任务隔离 (C5)**：每个子代理现在维护独立的文件修改追踪。失败的子代理会自动回滚其所有文件写入，防止部分完成的任务留下不一致状态。(`externalTools.ts`)


### 🐛 Bug 修复与体验优化

- **[修复] AI 模型列表界面空白**：修正了当从其他标签页切回或重载面板时，AI 模型下拉框变为空白且需要打开设置弹窗才能恢复的 Bug，现在切回可无缝重建绑定数据。
- **[修复] AI 设置强制刷新导致的代码冻结**：彻底剥离了 AI 设置页修改时对语言服务器（Language Server）发送配置文件防灾重载的广播，此举消灭了切换模型或调整思考深度时诱发的每次等待 20 秒及代码解析全部停摆的顽疾！
- **[优化] 模块编译可视化提示**：为 Codelens 等功能的悬浮参考信息与语法实体索引补足了具体扫描分子和分母呈现。原先纯文字的 ”正在检查资源...“ 左下角加载项，现已变为附带动效及带有清晰数字计量的 ”(xxx/yyyy)“ 可视化进度。
- **[优化] 版本更新进度条显示**：现在插件启动时校验远端版本信息的过程将明确带有 UI 加载提示（VSCode 中央及左下角的滚动进度球），取代过去容易致使用户误解是不是卡死的无反馈后台请求。
- **[修复] Token 数据防呆清空阻断**：鉴于 Webview 的底层安全隔离导致原先设计的 `confirm()` 原生弹窗全部失效，在点击清空 Token 监控消耗数据时被系统拦截。改为事件抛出至插件原生线程来通过安全原生的提示信息阻断提醒和重置！

## [1.6.2] — 2026-04-26

### 🤖 Agentic 2.0 架构升级与新特性

- **[重大升级] 引入 AST Mutator 前端修饰器**：废弃了原有基于繁复正则表达式的文本定位和替换操作引擎。全面接入 `guiParser` 原生语法树（AST）解析能力，现在 AI 拥有真正手术级别的精准代码定位和局部热更新替换权限，彻底消灭 Paradox 格式因为混杂空格和缺少引号而错配的顽疾！
- **[重大升级] 并发子代理 (Sub-Agent Orchestration)**：重写了以往单线执行的 `task` 工具流！构建了原生基于 `Promise.allSettled` 的多路并发探针框架。当遇到复杂项目结构或需要跨多文件验证的繁重分析时，主脑将把任务自动分块并派发给多个 Sub-Agent 实例同时执行侦察。
- **[修复] UI 上下文满血解封 (L9)**：解决当由于服务商退回判定导致模型实际的 `1M` Token 上下文被错误判定截断为 `200k` 的漏洞。使用字符串倒序遍历确保如 `deepseek-v4-flash` 不再被短名误伤退回到 `128k` 或更短的服务商默认值。
- **[修复] 上下文压缩条显示对齐 (UI)**：优化了 Token 监控数据透出设计。底层的 `AgentRunner` 现在单独核算主循环（不含压缩、总结等隐藏消耗）的上下文水位 `contextWindowTokens`。UI 进度条从呈现混杂消耗量改为严格呈现“主脑当前拥挤度”，实现 1.7M / 1M 假爆条错误消减，现在压缩动作生效后界面会真正降回清爽状态！
- **[优化] 启动规则与更新校验提前**：调整插件入口逻辑，在语言服务器（Language Server）准备下载或校验庞大的 `.cwtools` 资源缓存池之前，同步阻塞执行自身版本校验更新。此举可防止更新过程互相争抢资源或引发后台规则下载冲突。

## [1.6.1] — 2026-04-25

### 🏗️ 架构与维护性优化 (Architecture & Maintainability)

- **[重构] F# LSP 后端多态重构**：剥离出 `IGameVisitor` 泛型访问器与 `IGameDispatcher` 任务分发器，彻底移除分散在 SemanticTokens、InlayHints、Hover 及符号查询等核心功能中的 10 向 `match` 冗余状态树。解耦并统一了各游戏平台（STL, HOI4, EU4 等）对游戏数据库 `AllEntities` 与 `References` 的查询逻辑，大幅度改善后端的拓展能力与代码整洁度。
- **[重构] AI Agent 调度器拆解**：将原本长达 1716 行的 `agentRunner.ts` God Object 进行了模块化切分。提取出了独立的 `toolCallParser`、`jsonRepair` 及 `contextBudget` 等逻辑组件，并采取基于接口的内部 Delegate 转发模式。从根源上消除了杂乱的正则表达式提取器、异常修补器和计费控制系统逻辑污染，从而显著提升了主代理模块的内聚度。

## [1.6.0] — 2026-04-23

### 🤖 AI Agent — 新功能与深度集成

- **[新功能] 会话 JSON 完整导出/导入 (Feature 1)**：支持将包含完整步骤、工具调用结果以及图片的 AI 会话完整导出为 JSON 并无损导入，实现项目上下文的长效持久化。
- **[新功能] 多文件 Diff 预览 (Feature 2)**：任务完成后统一展示涉及多文件的 `Diff Summary` 视图，直观审阅全部修改点。
- **[新功能] MCP (Model Context Protocol) 客户端 (Feature 3)**：集成 MCP 支持，同时实现了 stdio 和 SSE 两种传输协议，可通过配置外部源深度增强 AI 补全上下文。
- **[增强] Sub-Agent 并行编排 (Feature 4)**：任务计划调度支持基于 `Promise.allSettled` 的多子任务（Sub-Agent）真实并行执行，显著提升复杂查询与分析的速度。
- **[增强] 全项目本地化索引 (Feature 5)**：本地化文本（`locDecorations.ts`）由仅处理当前打开文件升级为使用 `FileSystemWatcher` 的全工作区后台异步索引，即时可用并支持增量更新。
- **[新功能] Review Mode 代码审查 (Feature 6)**：新增独立的 `Review` 工作模式及专用系统提示词。在此模式下 AI 仅拥有审查与诊断等只读工具权限，用于高强度校验现有代码规范及逻辑漏洞并强制禁止代码覆盖。
- **[新功能] 性能监控 Dashboard (Feature 7)**：于扩展设置页内置 AI 性能计量主板。实现按供应商分类统计、单模型调用细分占比以及最近 14 天消耗的综合可视化计算。
- **[新功能] 多游戏 AI 知识库与 Prompt 支持**：内置 Stellaris, HOI4, EU4, CK2/3, VIC2/3, Imperator, EU5 等 9 款 Paradox 游戏的专属 PDXScript 语法与上下文，根据当前项目智能重组系统提示词。
- **[新功能] 上下文窗口智能化 (Smart Windowing)**：基于 AST 大括号深度扫描，智能提取光标所在的完整语义代码块片段，大幅降低多余 Token 消耗并提升 AI 语境精度。
- **[增强] 打字机流式输出体验**：推理反馈全面接入 `text_delta` Streaming 支持，无缝衔接主流 API 源及 Claude SSE，并重构 ProviderAdapter 消除长回复视觉停顿。
- **[增强] AI 对话全文快速检索引擎**：历史搜索升级为基于权重的全文匹配（同时包含模型回复与内嵌代码快），并新增命中段落的前后文切片预览。
- **[增强] AI 常用命令全局快捷键**：工作区全局注册 `AI: Review Current File` (Ctrl+Shift+R)、`AI: Explain Selected Code` (Ctrl+Shift+E) 及 `AI: Fix All Diagnostics` (Ctrl+Shift+F)。
- **[增强] 子任务 (Sub-Task) 执行进度投屏**：底层任务分发机制接入统一的 AgentStep 回调，子 Agent 探索的进度生命周期 (`subtask_start`/`complete`) 会实时推送至面板供追踪。
## [1.5.0] — 2026-04-21

### 🔒 LSP 服务端 — 稳定性与并发

- **[修复] Tokenizer CRLF 安全性**：`readLine` 现在在消费 `\r` 前 peek 下一字节；单独的 `\r` 不再吞噬后续内容字节 (`Tokenizer.fs`)
- **[修复] Tokenizer Content-Length 守卫**：`tokenize` 只在实际解析到有效 `Content-Length` 头时才调用 `readLength`；畸形空行静默跳过 (`Tokenizer.fs`)
- **[修复] LanguageServer 进程队列无界化**：将 `BlockingCollection(10)` 改为无界 `BlockingCollection`，消除 AI 高频指令下读/处理线程的交叉死锁 (`LanguageServer.fs`)
- **[修复] LanguageServer ReaderWriterLockSlim 并发**：只读 LSP 请求（Hover、Completion、GoToDefinition 等）在线程池中并发执行，持共享读锁；写操作（DidChange、validateCode 等）持独占写锁串行执行，消除慢查询阻塞快查询 (`LanguageServer.fs`)
- **[修复] LanguageServer 请求 ID 原子递增**：请求 ID 改用 `Interlocked.Increment` 原子自增，原 `ref` 写法非线程安全 (`LanguageServer.fs`)
- **[修复] LanguageServer 响应通道泄漏**：`responseAgent` 对每个挂起请求调度 30 秒 `Expire` 消息，防止客户端超时后 Map 无限增长 (`LanguageServer.fs`)
- **[修复] Program.fs UNC/符号链接路径**：`checkOrSetGameCache` 改用 `Directory.GetParent().FullName` 取代 `cp + "/../"` 字符串拼接，修复 UNC 路径和符号链接兼容性 (`Program.fs`)
- **[修复] Program.fs 孤儿命令响应**：为未处理的 `workspace/executeCommand` 调用（如 `cwtools.ai.queryVariables`）添加 stub 响应，服务端不再静默挂起 (`Program.fs`)
- **[修复] Program.fs GC 压力**：`GC.Collect` 改用 `GCCollectionMode.Optimized` + `blocking=false`，消除热路径 lint 分析中的 STW 暂停 (`Program.fs`)
- **[性能] DocumentStore O(n)→O(1) 范围查找**：`findRange` 替换为 `findRangeFast`，使用预构建行偏移缓存（`int[]`）实现 O(1) 定位——Open/Replace 时立即构建，Patch 修改后惰性重建。消除 Hover/GoToDefinition 对大文件的重复全文扫描 (`DocumentStore.fs`)

### 🤖 AI Agent — 可靠性与正确性

- **[修复] AbortController 并发安全 (C1)**：`AIService.activeControllers` 改为 `Set<AbortController>`，每次 `chatCompletion` 创建独立 controller，消除并发请求（压缩 + 主推理循环）互相取消的竞态 (`aiService.ts`)
- **[修复] 并行 tool_call 索引碰撞 (M1)**：`tc.index` 缺失时改用 `Object.keys(toolCallMap).length` 作为 fallback，防止并行 tool_call delta 在流式累积 Map 中相互覆盖 (`aiService.ts`)
- **[修复] 默认 max_tokens 提升至 8192 (M5)**：原 4096 会静默截断 Claude Opus 4 / Gemini 2.5 Pro 的长代码生成；`chatCompletion` 和 `chatCompletionStream` 均已更新 (`aiService.ts`)
- **[新功能] Claude SSE 流式传输 (L4)**：`callClaude` 从阻塞式 `response.json()` 完整迁移到 Anthropic Server-Sent Events 协议。支持实时 `onThinking` token 推送，消除 UI 生成阻塞。处理 `message_start`、`content_block_start`、`content_block_delta`（`text_delta`/`input_json_delta`）、`message_delta` 等事件类型 (`aiService.ts`)
- **[修复] Doom-loop 检测 (M2)**：连续计数器替代滑动窗口，A-B-A-B 交替调用签名现在能被正确检测并终止 (`agentRunner.ts`)
- **[修复] 最终 API 调用前中止信号检查 (C2)**：`reasoningLoop` 在每次 API 请求前调用 `options?.abortSignal?.throwIfAborted()`，防止用户取消后继续产生计费调用 (`agentRunner.ts`)
- **[修复] `validate_code` 串行执行 (M6)**：从 `READ_ONLY_TOOLS` 中移除 `validate_code`，现在持独占写锁串行执行，防止并发读取期间代码注入导致 AST 状态损坏 (`agentRunner.ts`)
- **[修复] 子 Agent token 用量传播 (L8)**：`runSubAgent` 接受 `parentAccumulator` 参数，子 agent 的 token 消耗正确合并到父 `TokenUsage`，UI 账单计数准确 (`agentRunner.ts`, `agentTools.ts`)
- **[修复] 压缩过滤系统消息 (L3)**：系统消息从压缩摘要中排除，防止角色混淆导致摘要模型误判 (`agentRunner.ts`)
- **[修复] 压缩截断限制 (M4)**：Tool/Assistant 消息截断上限从 500 提升至 2000 字符，保留技术细节跨压缩轮次传递 (`agentRunner.ts`)
- **[修复] PDXScript 启发式假阳性 (L2)**：代码提取要求候选块同时包含 `{` 和 `}`，防止 Markdown 表格或说明文本被误判为 PDXScript (`agentRunner.ts`)
- **[修复] Fence 模式去重 (L1)**：双 fence 正则合并为单一模式，消除双重匹配风险 (`agentRunner.ts`)
- **[修复] `multiedit`/`patch` 纳入写工具集 (L6)**：两者现在正确参与写操作串行守护 (`agentRunner.ts`)
- **[修复] Claude ContentPart[] 系统提示序列化 (L5)**：`toClaudeRequest` 使用 `contentToStr` 辅助函数正确序列化 `ContentPart[]` 类型的系统消息，修复原来 `.join()` 产生 `"[object Object]"` 的错误 (`providers.ts`)
- **[修复] 动态 provider 导入移除 (M3)**：`await import('./providers')` 替换为静态导入的 `getProvider` 函数 (`agentRunner.ts`)

### 1.4.0
#### 新功能
* **AI 助手 Agent 架构升级** — 工具栏与 Chat Panel 完成双模式升级与深层 Agent 增强体验：
  - **Build / Plan 双模式**：新增模式切换（Build 模式支持全自动生成验证，Plan 模式专注只读分析不改动文件），适应不同复杂度的 Prompt 任务。
  - **上下文智能压缩**：当长程对话 token 量超过模型处理极限的 70% 时，AI 自动生成压缩摘要取代旧记录。
  - **任务看板工具 (TodoWrite)**：AI 此刻能自发维护执行中的步骤，并向用户实时展示它的 `Todo` 清单可视化追踪进度。
  - **工作区深层检索**：新增 `workspace_symbols` 和 `document_symbols` 工具跨项目联调上下文定义。
* **模型与性能体验** — 参数配置面板迎来全面革新：
  - **Ollama 本地接入**：免 Key 直接零配置调用本地大语言模型服务，并且支持 `fetchOllamaModels` 自动呈现环境内装载模型名单及其参数容量。
  - **自定义上下文上限**：设置选项支持直接修改任意大语言模型 token 携带阈值（原厂 API 提供商选项同样全部上调对标 2026 年最新规格极限：GPT-5.4(400K), Claude Opus(1M), Qwen3(256K)）。

### 1.3.0
#### 新功能
* **星系可视化预览** — 在 `solar_system_initializers/` 下的 `.txt` 文件中，点击编辑器标题栏的望远镜图标打开星系可视化预览面板。
  - 支持 3D 透视投影渲染恒星、行星、卫星及其轨道
  - 支持递归层级：行星 → 卫星 → 子卫星（任意嵌套深度）
  - 环形世界（Ring World）完整支持：分段渲染、弧形显示、拖拽扩缩
  - 累积轨道系统正确解析 `orbit_distance`、`change_orbit`、`orbit_angle`
* **星系可视化编辑** — 在编辑模式下直接拖拽天体修改其轨道参数，修改实时同步到脚本文件。
  - 右键菜单创建：恒星、行星、卫星、环形世界、同轨道兄弟天体
  - 拖拽编辑轨道距离和角度，支持跨轨道重排序
  - 同轨道天体（orbit_distance=0）沿轨道圈拖拽、锁定半径
  - 环形世界拖拽缩放自动吸附到有效分段数（360的因子）
  - 删除天体、撤销操作（Ctrl+Z）
  - 双列网格右键菜单，紧凑高效
* **视图控制** — 鼠标滚轮缩放、右键拖拽平移、Alt+拖拽旋转视角（水平360°、垂直5°-175°）。

### 1.2.0
#### 新功能
* **GUI Preview 多分辨率切换** — 工具栏新增分辨率选择器（自适应 / 1920×1080 / 2560×1440 / 3840×2160），可在不同分辨率下预览 GUI 布局效果。
* **GUI Preview 动画预览** — 支持多帧 Sprite 自动循环播放，工具栏可控制播放/暂停，帧间隔 200ms。
* **本地化装饰增强** — 代码行内本地化文本显示支持切换开关，可通过编辑器标题栏按钮快速启用/禁用。
* **安全重命名** — 重命名操作移除了回车直接确认机制，改为预览后手动确认，避免误操作。

#### 移除
* **事件流程图** — 移除了基于 Cytoscape.js 的事件链可视化功能（`showGraph`、`setGraphDepth`、`graphFromJson` 等命令），简化插件体积与维护成本。
* **性能分析器** — 移除了冗余的 AND/OR 性能提示功能。

#### 修复
* **编译流程修正** — 修复了仅运行 TSC 而未执行 Rollup 导致 Webview 脚本未正确打包的部署问题。
* **构建产物清理** — 清理了已移除功能的残留编译产物，避免部署目录中存在过时文件。

### 1.1.5
#### 修复
* **Event Target 验证降噪** — 系统性扩展了 Event Target 扫描边界，包含工作区所有 `save_event_target_as` 的目标名称，防止局部分析时在别处设置但此事件链未检测到导致的假阳性报错引发满屏红色警报。
* **解析器增强** — 将 `+` 号添加入允许字符（idCharArray），修复例如 `xxx_+1m_button` 等名称含有 `+` 的标识符被截断导致的异常语法报错（CW001）。
* **UI 面板解析容错** — 修复了从本地读取 GUI 文件时诸如 `center_up` 等非全大写的对齐方式（Orientation），由于属性面板匹配严格大小写导致页面选项显示空白 `(无)` 的问题。
* **拖拽坐标偏移问题修复** — 修复了对具有额外中心点原点偏移（Orientation 或 Origo 设置不位于左上角）的元素调整位置拖拽时产生的坐标计算偏差机制。新基准剥离了 DOM 内实时拖拽相对于父窗口的 `Left/Top` 渲染和回推入 AST 代码（相对 `x/y`）保存的系统隔离绑定，解决任意异型控件设置好缩放且保存后重新加载时位置错断、乱窜飞天的问题。

### 1.1.4
#### 修复
* **缩放处理机制重构** — 彻底抛弃使用 CSS `transform` 进行引擎组件（Button, Icon 等子控件）属性可视缩放的方案，换为其原生同步计算视觉宽高的算法（解决原先因子组件拖拽棒跟随缩放导致过小无法使用的问题）。
* **规模尺寸架构统一** — 增强创建新子组件流程和判定体系。限制 `size` 类型只服务于特定全屏和容器组合层类型（`containerWindowType`系列），剥除 `IconType` 和按钮元素受限于错误 `Size` 参数导致的不正常拉动生效并强行转化只使用 `Scale` 输出。
* **连贯性二次缩放** — 修复二次缩放后使用原始宽高直接累进缩放值导致的不准弹跳缩放回初始实际大小时错误的视觉刷新重渲染回源的问题。

### 1.1.3
#### 新功能
* **更多的创建按钮支持** — 在右键菜单中新增了创建 `effectButtonType` 和 `guiButtonType` 类型的选项

#### 修复
* 修复在连续调整属性（如多次缩放同时触发 `position` 和 `scale` 变化）时，由于异步处理延迟导致旧属性找不到从而错误生成重复属性代码的问题（加入了操作队列串行处理与就近扫描替换策略）
* 修复编辑任意内容后 `_loadAndRender` 会导致预览画布重置到中心的问题，现在仅在首次加载时应用自适应居中，之后的修改将保留用户的平移/缩放视角

### 1.1.2
#### 修复
* 修复多选元素时拖拽缩放边界（resize）无效的问题，现在所有选中的元素会同步改变大小
* 修复由于 `size` 导致重复插入代码的 bug，将其从实时事件触发改为失去焦点后触发
* 修复多元素操作时撤回（undo）导致的状态快照重复问题，添加了操作防抖处理
* 修复无显式 `size`（自动采用纹理大小）的控件（如 `iconType`）缩放时应使用 `scale` 进行调整的问题

### 1.1.1
#### 新功能
* **贴图选择器** — 属性面板中的贴图属性支持搜索式下拉补全，数据来源于工作区和游戏目录的 `.gfx` 文件
* **Effect 属性编辑** — effectButtonType 类型新增 effect 属性输入框，支持 `common/button_effects/` 中定义的效果名称补全
* **多选可见性切换** — 图层面板中多选元素后，点击眼睛图标可批量切换可见性
* **属性修改撤销** — 属性面板中的所有修改（帧、贴图、位置、大小等）均支持 Ctrl+Z 撤销

#### 修复
* 修复帧属性修改在单行格式元素上会重复插入 `frame` 代码的 bug
* 修复帧属性 spinner 点击触发两次更新的问题（移除冗余 input 事件）
* 修复单行格式元素属性编辑现在正确使用行内正则替换而非插入新行
* 修复贴图选择器下拉框被属性面板 overflow 裁剪导致不可见
* 修复输入框中按方向键会同时移动画布元素的键盘冲突
* 修复图层面板多选时高亮状态不同步

### 1.1.0
#### 新功能
* **GUI 预览** — 在 VS Code 中实时预览 `.gui` 文件渲染效果
  - 支持所有主要控件类型（containerWindowType、iconType、buttonType、effectButtonType 等）
  - DDS 纹理解码（BC1/BC2/BC3/BC7、未压缩 BGRA/BGR）
  - TGA 纹理解码（未压缩、RLE 压缩，24/32bpp）
  - corneredTileSpriteType 的 Canvas 9-切片渲染
  - 多帧精灵裁切（noOfFrames）
  - 百分比尺寸继承（`width = 100%`）
  - PDX 布局系统支持（orientation、origo、centerPosition）
  - 图层面板、元素搜索（Ctrl+F）、缩放/平移
  - 离屏元素自动过滤（坐标 > 5000）
* **CodeLens 本地化文本** — 在代码上方显示对应的本地化文本
* **Inline Script 导航** — Ctrl+Click 跳转到 inline_script 文件定义
* **文件悬浮预览** — 鼠标悬浮显示 inline_script 引用文件的内容
* **算术表达式求值** — 悬浮显示 `value:xxx|` 表达式的计算结果

#### 修复
* 修复 scale 属性的双重缩放 bug（同时在布局和 CSS transform 中应用）
* 修复 scale 不应对 containerWindowType/windowType 生效
* 修复 centerPosition + scale 的变换原点应为 center
* 修复 corneredTileSpriteType 在 Webview 中无法渲染的问题
* 修复 portraitType 的 masking_texture 字段未被索引
* 修复百分比尺寸（`100%`）被错误转为数字的解析 bug
* 修复无显式 size 的容器应继承父容器尺寸而非自动收缩
* 修复 background 中 spriteType 应使用原始纹理尺寸显示

#### 性能
* 纹理缓存添加 50MB LRU 上限，防止内存无限增长
* 插件重载时正确停止 Language Server 并清理资源
* 离屏元素和 size=0 容器从渲染和图层面板中过滤

### 1.0.0
* Stellaris: Allow "(", ")" as values, to allow parsing (but not proper support for) `@[()]`
* Fix a bug with document symbols