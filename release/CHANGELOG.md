# Changelog

## [2.11.2] - 2026-08-10

### 新功能 / New Features
- **[新增] 实体预览视角操作提示**：画布右上角新增"?"帮助卡片，展示旋转/平移/缩放/聚焦的快捷键（中英双语）。
  English: [New] Entity preview view-control help — a "?" card in the canvas corner shows the orbit/pan/zoom/frame shortcuts.
- **[优化] 实体预览选择持久化**：编辑保存并重新渲染后，保持之前选中的实体（按名称恢复，不再因排序变化跳回第一个）。
  English: [Improvement] Entity selection persists across re-render — after saving an edit the previously selected entity is restored by name instead of resetting to the first one.

### 稳定性与工程 / Stability & Engineering
- **[更新] CWT 规则与 MCP 子模块**：捆绑的 Stellaris 规则随 cwtools-stellaris-config 更新并重新打包；cwtools-mcp 指针同步。
  English: [Updated] CWT rules and MCP submodules — bundled Stellaris rules refreshed from cwtools-stellaris-config; cwtools-mcp pointer bumped.
- **[清理] 移除误提交的调试日志**：`docs/message.txt`（内存诊断日志）不再随仓库分发。
  English: [Cleanup] Removed the accidentally committed debug log (`docs/message.txt`) from the repository.

## [2.11.1] - 2026-08-09

### 新功能 / New Features
- **[新增] 本地化诊断过滤设置**：`errors.localisationFilter` 可隐藏本地化诊断——`off` 不过滤，`problems` 仅从问题面板隐藏（AI 与服务器诊断查询仍可用），`all` 完全过滤。
  English: [New] Localisation diagnostic filtering — `errors.localisationFilter` hides localisation diagnostics: `off` keeps them, `problems` hides them only from the Problems panel (server and AI queries still see them), `all` suppresses them completely.

### 修复 / Fixes
- **[修复] 延迟动态重验证无限循环导致内存持续增长**：两个稳定的真实错误组会不断把对方重新排队，批次交替验证并每次分配数 GB 临时数据。现在携带动态诊断的文件与请求文件折叠进同一有界批次，一次验证完成，循环消除。
  English: [Fix] Deferred dynamic revalidation could loop forever and grow memory — two stable groups of real errors kept requeuing each other, so batches alternated and allocated gigabytes per pass. Files carrying dynamic diagnostics now fold into the same bounded batch as requested files and are validated in one pass.

## [2.11.0] - 2026-08-09

### 新功能 / New Features
- **[新增] 实体预览支持旗帜颜色遮罩**：舰船等实体预览按舰队/国家旗帜颜色渲染遮罩，旗帜颜色可实时影响模型外观。
  English: [New] Flag color masking in the entity preview — ship and entity models render with the fleet/country flag palette applied to masked surfaces.
- **[优化] AI 对话已完成的回合默认折叠**：活动流（工具调用、执行步骤）默认收起，只显示状态条与最终回答，展开即可查看过程；流式输出中的回合保持展开。
  English: [New] Completed AI turns collapse by default — the activity stream hides behind the status bar and final answer until expanded, while live turns stay open.

### 修复 / Fixes
- **[修复] 本地化悬停提示在某些环境下失效**：未配置本地化语言（英文界面常见）时，悬停在本地化键上不再显示对应文本——服务器现在始终按实际加载的游戏派生默认语言，本地化数据正常解析。
  English: [Fix] Localisation hover could show nothing — when no localisation language was configured the server parsed zero keys; it now derives the language set for the loaded game (with a default fallback), so hovers resolve everywhere.
- **[修复] 星系/舰船模型/GUI 预览可能完全无法打开或渲染**：共享文件扫描器在深层目录下会死锁（目录递归占满并发槽位后与排队任务互相等待），导致精灵索引和资产图永远构建不完。扫描器重构为"确定性发现 + 有界并发读取"，死锁消除。
  English: [Fix] Solar-system, ship-model, and GUI previews could hang — the shared file walker deadlocked on deep directories (slotted recursion waited on queued reads), so sprite/asset indexes never finished. The walker now uses a deterministic discovery pass plus bounded concurrent reads.
- **[变更] 远程规则渠道取消 stable，默认只使用 latest**：`rules_version` 设置仅保留 `latest` 与 `manual`；规则缓存始终跟踪远程默认分支，不再按 git tag 切换到"稳定版"。
  English: [Changed] Removed the stable remote-rules channel — `rules_version` now offers only `latest` and `manual`, and the rules cache always tracks the remote default branch instead of checking out tagged releases.

### 稳定性与工程 / Stability & Engineering
- **[新增] Stellaris 项目语言关联与降级**：`*.txt/gui/gfx/asset/cwt` 按 Stellaris 语言加载；缺少原版数据（未安装游戏或无缓存）时自动切换到通用模式，补全与悬停仍可用。
  English: [New] Stellaris file associations and graceful degradation — files load under the Stellaris language, and without vanilla data the server falls back to the generic game while completions and hovers keep working.
- **[加固] 预览面板消息运行时校验**：GUI/星系/实体/粒子/事件链五个面板的 Webview 消息全部经过边界校验（行号范围、数组结构、截图大小上限、路径逃逸拦截），非法输入被拒绝而非触发异常。
  English: [Hardening] Runtime validation for all preview-panel Webview messages — bounds, shapes, screenshot size caps, and workspace path escapes are rejected at the boundary.
- **[加固] AI 运行时资源清理与图像限制**：运行中止/异常路径不再泄漏进程与监听器；MiniMax 图像描述改为独立适配器（超时、取消、8 MiB 上限、临时文件清理）。
  English: [Hardening] AI runner cleanup and image limits — cancelled or failed runs release subprocesses and listeners; the MiniMax vision fallback gained timeouts, abort support, an 8 MiB cap, and temp-file cleanup.
- **[工程] 测试门禁与三平台 CI**：修复 43 处严格类型错误，全量类型检查 0 错误；2044 项单元测试 + 13 项服务器回归测试 + 4 套件集成测试全部纳入 CI（Linux + Windows + .NET），推送即自动验证。
  English: [Engineering] Test gates and three-platform CI — strict typecheck is clean, and 2044 unit tests, 13 F# regression scripts, and 4 Extension Host suites run automatically on every push.
- **[工程] 确定性文件扫描器**：预览面板共享的递归文件扫描改为排序遍历、并发有界、上限同步执行、支持取消，结果按发现顺序稳定输出。
  English: [Engineering] Deterministic file walker — sorted traversal, bounded concurrency, push-time limits, cancellation, and stable result ordering across the preview panels.

## [2.10.19] - 2026-08-08

### 性能与内存 / Performance & Memory
- **[优化] 串行化重型分析并降低峰值内存**：动态调用点校验与分阶段全局刷新共用同一信号量串行执行，本地编辑不再同时持有两份大规则图；动态校验改为可取消，批次被新编辑取代时自动重新排队。
  English: [Optimization] Serialized heavy analysis to cut peak memory — dynamic call-site validation and staged global refreshes share one gate so a local edit cannot retain two rule-graph snapshots; dynamic validation is cancellable and superseded batches re-queue automatically.
- **[优化] 按文件预热动态参数数据**：延迟批处理只预热本批文件，替代原先的全量预热，减少无效计算与内存压力。
  English: [Optimization] Per-file dynamic-parameter warm-up — deferred batches force computed data only for queued files instead of the whole workspace.

### 诊断刷新 / Diagnostics Refresh
- **[修复] 修复动态批处理发布缺口**：跨文件调用点诊断（如 inline script 调用方的展开报错）在错误修复后不再残留——仍持有动态展开诊断但未被本批校验的文件会自动进入后续批次重新校验，修复后旧报错被真正清除。
  English: [Fix] Closed the deferred-batch publish gap — files holding dynamic-expansion diagnostics (e.g. inline-script caller errors) that a batch did not revalidate are re-queued automatically, so a fixed error is actually cleared instead of lingering.
- **[修复] 修复打开/聚焦时跳过重新校验的问题**：模型版本（本地化/类型/规则）已变化但状态仍标记为最新（Fresh）的文件，打开或聚焦时会重新校验，不再显示过期报错。
  English: [Fix] Open/focus revalidation no longer skipped when the model epoch moved — files marked fresh under an outdated model epoch are re-linted on open or focus, so stale diagnostics are replaced.

## [2.10.18] - 2026-08-08

### 多 Agent 编排 / Multi-Agent Orchestration
- **[新增] 编排结果持久化与跨波次合并**：任务图、逐节点结果与黑板快照落盘持久化，`merge_results` 可跨波次、跨会话合并详细结果。
  English: [New] Durable orchestration records and cross-wave merging — task graphs, per-node results, and blackboard snapshots persist to disk; `merge_results` merges past waves across turns and sessions.
- **[新增] 可恢复多波次编排**：`dispatch_agents` 支持 `resumeGraphId` 续跑已持久化图、`appendTasks` 动态增补任务（Paradox 域限只读角色）、`answerClarifications` 回答子代理澄清后重跑对应节点。
  English: [New] Resumable waves — resume persisted graphs, append tasks (read-only roles only in the Paradox domain), and re-run nodes after parent clarification answers.
- **[新增] 后台子代理与取消**：`dispatch_agents(background: true)` 立即返回、图在后台继续执行，完成结果自动注入下一轮对话；新增 `cancel_dispatch` 取消后台图，取消后仍可恢复。
  English: [New] Background dispatch and cancellation — waves run off the tool call with next-turn result notifications; `cancel_dispatch` aborts a running graph for later resume.
- **[新增] 证据裁决持久化**：证据门的已验证裁决按证据版本落盘复用，减少跨会话重复验证（设置 `stellarisLanguageServices.ai.evidenceGate.persistLedger`，默认开启）。
  English: [New] Persistent evidence decisions — verified allow verdicts are reused across runs keyed by evidence revision (`persistLedger`, on by default).
- **[新增] 选项式澄清**：通用域子代理澄清可携带 2-4 个预设选项，父代理或用户直接选择回答。
  English: [New] Option-based clarifications — General-domain sub-agents may attach preset OPTIONS lists to clarifications.
- **[新增] 黑板写入校验与结构化查询**：按条目类型与键前缀校验黑板写入并拒绝畸形数据；`query_blackboard(structured: true)` 返回解析后的 JSON 值。
  English: [New] Blackboard write validation by entry type and key prefix, plus structured JSON queries.

## [2.10.17] - 2026-08-08

### 性能与后端 / Performance & Backend
- **[优化] 优化后端响应速度**：优化了后端服务响应处理流程，提升整体响应与执行速度。
  English: [Optimization] Optimized backend response performance and processing flow, improving overall speed and execution.

## [2.10.16] - 2026-08-07

### 版本打包与发布 / Packaging & Release
- **[打包] 重新升级版本号并打包发布至 GitHub Release**：更新发布配置并重新构建发布扩展包。
  English: [Package] Bumped version number and published updated release package to GitHub Release.

## [2.10.15] - 2026-08-07

### 实体预览与编辑器 / Entity Preview & Editor
- **[优化] 将实体预览撤销/重做路由至 VS Code 快捷键绑定**：优化了 Entity 预览中的撤销/重做操作响应机制，使其与全局快捷键（如 Ctrl+Z / Ctrl+Y）完全兼容。
  English: [Improvement] Routed entity preview undo/redo actions through VS Code keybindings for standard Ctrl+Z/Ctrl+Y handling.
- **[修复] 修复占位符 Token 拆分正则表达式**：修复了占位符格式化和文本拆分时的匹配处理。
  English: [Fix] Fixed the regex pattern for placeholder token splitting during localization formatting.

### MCP 服务端 / MCP Server Integration
- **[更新] 同步 cwtools-mcp 子模块与协议架构至 0.2.1**：升级只读 MCP 服务端及 Schema 协议文件。
  English: [Update] Bumped `cwtools-mcp` submodule pointer and synchronized MCP schema definition to version 0.2.1.

## [2.10.14] - 2026-08-07

### 模型预览与编辑 / Model Preview & Editing
- **[优化] 提升模型预览的编辑功能**：优化了模型预览面板交互与编辑体验，提供了更完善的编辑能力。
  English: [Improvement] Enhanced editing capabilities for the model preview panel, improving interaction and editing experience.

## [2.10.13] - 2026-08-07

### AI 数据库与知识解析 / AI Database and Knowledge Parsing
- **[优化] 提升 AI 数据库解析能力**：增强了项目数据库与 AI 知识库的结构化解析与上下文提取能力，提升了复杂工作区下的关联与检索精准度。
  English: [Optimization] Enhanced AI database parsing capabilities, improving structured parsing, context extraction, and retrieval accuracy across complex workspaces.

## [2.10.12] - 2026-08-06

### 项目数据库与知识库 / Project Database and Knowledge Base
- **[重要] 重构成项目数据库架构，不再兼容旧版数据库**：项目数据库格式进行了重构升级，旧版数据库不再支持。请在工作区中使用重新初始化命令以更新项目数据库。
  English: [Important] Refactored project database architecture; legacy databases are no longer supported. Please run the re-initialization command in your workspace to update the database.

### MCP 服务端同步与发布 / MCP Server Sync and Publishing
- **[发布] 升级只读 MCP 服务端并同步发布至 npm 仓库**：`cwtools-mcp` 与 `cwtools-shared` 升级至 `0.2.0` 版本并发布至 npm 官方注册表，支持 Shader 语义工具与项目知识库 (Project Knowledge) 索引能力。
  English: [Publish] Upgraded and published read-only MCP server packages (`cwtools-mcp` and `cwtools-shared`) to `0.2.0` on npm, introducing Shader semantic tools and Project Knowledge indexing capabilities.

## [2.10.11] - 2026-08-06

### 规则加载与离线可用性 / Rules Loading and Offline Availability
- **[优化] 优先载入本地规则再进行后台远程更新**：在后台异步检测和拉取远程规则更新之前，优先载入本地已有的规则缓存，提升初始加载性能与离线可用性。
  English: [Optimization] Load local rules before initiating background remote updates, improving startup performance and offline usability.

## [2.10.10] - 2026-08-04

### AI 对话与推理兼容性 / AI Chat and Reasoning Compatibility
- **[新增] OpenAI 兼容渠道支持自动探测和手动配置推理字段名**：可识别 `reasoning_content`、`reasoning`、`reasoning_text` 与 `thinking`，并在流式展示及多轮工具调用中按原字段回传思考内容，兼容使用非标准字段的网关与中转服务。
  English: [New] OpenAI-compatible channels can now auto-detect or explicitly configure the reasoning field name. `reasoning_content`, `reasoning`, `reasoning_text`, and `thinking` are preserved across streaming output and multi-turn tool calls for gateways and relays that use non-standard fields.
- **[改进] 推理参数路由统一为按 Provider、协议和模型匹配的规则表**：OpenAI、OpenRouter、Anthropic、Gemini、Qwen、SiliconFlow、GLM、DeepSeek、Together、DeepInfra、Ollama 及自定义渠道继续使用各自正确的思考参数，并更易扩展新模型。
  English: [Improvement] Reasoning parameters now use a centralized rule table keyed by provider, wire format, and model. OpenAI, OpenRouter, Anthropic, Gemini, Qwen, SiliconFlow, GLM, DeepSeek, Together, DeepInfra, Ollama, and custom channels retain their provider-specific request shapes while making new model support easier to extend.
- **[兼容] 移除 DeepSeek Beta 前缀续写的专用分支**，统一通过标准对话与 Agent 循环处理后续轮次，避免专有续写协议干扰工具调用或结构化消息状态。
  English: [Compatibility] Removed the dedicated DeepSeek Beta prefix-continuation path so subsequent turns consistently use the standard conversation and Agent loop without risking tool-call or structured-message state.

### 模型与规则数据 / Models and Rules Data
- **[新增] 更新内置模型与价格数据**：加入 GPT-5.6 系列、`qwen3.8-max` 与 `gemini-3.6-flash` 的模型或价格信息。
  English: [New] Updated built-in model and pricing data for the GPT-5.6 family, `qwen3.8-max`, and `gemini-3.6-flash`.
- **[更新] 刷新 Stellaris 规则配置与随包规则集**：修复触发船只角色的名称引用并移除冗余船只角色枚举。
  English: [Update] Refreshed the Stellaris rule configuration and bundled rules, fixing triggered ship-role name references and removing a redundant ship-role enumeration.
- **[更新] 升级 CWTools 规则信息服务并清理旧版 MCP 集成文件**，保持核心库、只读 MCP 服务与扩展所用子模块版本一致。
  English: [Update] Upgraded the CWTools rule-information service and removed legacy MCP integration files, keeping the core library, read-only MCP server, and extension submodules aligned.

### 质量 / Quality
- **[测试] 增加推理字段探测、Provider 能力、思考参数及新模型价格的回归覆盖。**
  English: [Tests] Added regression coverage for reasoning-field detection, provider capabilities, thinking parameters, and new model pricing.

## [2.10.9] - 2026-08-04

### 实体与粒子预览 / Entity and Particle Preview
- **[新增] Entity 状态现在会播放 `.asset` 中的 `event` 与 `start_event` 粒子事件**：粒子与动画共用状态时间轴，支持同一状态内动画与粒子同时播放、循环控制、时间跳转以及定位器/骨骼挂载。
  English: [New] Entity states now play particle `event` and `start_event` blocks from `.asset` files. Particles share the animation state timeline, including combined animation/particle playback, looping, seeking, and locator or bone attachment.
- **[兼容] 按 CWT 规则解析真实粒子引用链**：Entity 事件中的粒子名会先解析 `gfx` 下 `objectTypes.pdxparticle`，再沿 `type` 查找 `.asset` 中的 `particle`，同时应用别名 `scale`；模组资源优先，缺失内容自动回退原版 Stellaris 数据目录。
  English: [Compatibility] Particle references now follow the CWT-defined chain from Entity events through `objectTypes.pdxparticle` in `.gfx` files to `particle` definitions in `.asset` files, including alias scale, mod override priority, and vanilla Stellaris fallback.
- **[修复] 挂载粒子现在使用定位器或动画骨骼的完整方向矩阵**：尾喷粒子沿挂点本地后向轴发射，位置、拖尾、非公告牌朝向和缩放均随节点变换更新；缺少节点时会明确区分“效果未解析”和“效果已载入但挂点不存在”。
  English: [Fix] Attached particles now use the complete locator or animated-bone orientation matrix. Exhaust emits along the attachment's local backward axis, while positions, trails, non-billboard orientation, and scale follow node transforms; diagnostics distinguish unresolved effects from loaded effects with missing attachment nodes.

### 编辑器与工具 / Editor and Tooling
- **[改进] AI 连接测试设置使用独立校验路径**，避免连接测试被常规聊天设置的校验状态错误阻断。
  English: [Improvement] AI connection-test settings now use an independent validation path so regular chat-setting validation cannot incorrectly block connection tests.
- **[优化] Mermaid 高图预览限制在可视窗口高度内**，改善大型图表的浏览与滚动体验。
  English: [Optimization] Tall Mermaid previews are constrained to the viewport height for easier navigation and scrolling.
- **[维护] 增加 Stellaris Shader ABI 同步与自动化测试工具，拆分 Chat Webview 模块，并清理废弃服务与配置文件。**
  English: [Maintenance] Added Stellaris Shader ABI synchronization and automated test tooling, modularized the Chat Webview, and removed deprecated services and configuration files.

### 质量 / Quality
- **[测试] 增加 Entity 粒子事件、`pdxparticle` 别名链、原版/模组资源解析、挂点方向以及动画与粒子组合播放的回归覆盖。**
  English: [Tests] Added regressions for Entity particle events, `pdxparticle` alias chains, vanilla/mod resource resolution, attachment orientation, and combined animation/particle playback.

## [2.10.8] - 2026-08-02

### AI Agent 语义模式路由 / AI Agent Semantic Mode Routing
- **[修复] 自动任务模式现在完全由模型按对话语义判断**：执行、计划、探索、审查以及显式多 Agent 委派不再被关键词分类器覆盖；确定性文本规则仅在路由调用失败或超时时作为安全回退。
  English: [Fix] Automatic task modes are now selected entirely from model-level conversation semantics. Execute, Plan, Explore, Review, and explicit Multi-Agent delegation are no longer overridden by keyword classifiers; deterministic text rules remain only as the safe fallback when routing fails or times out.
- **[修复] 用户明确要求开始、继续或按已定方案执行时会进入执行模式**；如果仍存在会改变结果、范围或行为的关键选择，则保持在计划权限边界，待用户敲定后由下一轮语义判断正常进入执行。
  English: [Fix] Requests to start, continue, or carry out an agreed plan now enter Execute mode. Material unresolved choices remain behind the Plan authorization boundary, and the next semantic routing turn can enter Execute normally after the user decides.
- **[安全] 能力领域继续完全由用户控制**：Paradox / CWTools 与通用编码领域不会被模型或请求语义自动切换；路由也不会改变权限配置或审批策略。
  English: [Safety] Capability domains remain entirely user-owned. Model semantics cannot switch between Paradox/CWTools and General Coding, and routing never changes permission profiles or approval policy.

### 对话界面 / Conversation UI
- **[优化] 对话中显示语义路由进度与可展开判断摘要**：用户可以看到当前选择的任务模式、单/多 Agent、置信度和有界证据；路由失败时明确显示规则回退，不再呈现为无反馈等待。
  English: [Improvement] The conversation now shows semantic-routing progress and an expandable bounded decision summary with task mode, Agent strategy, confidence, and evidence. Rule fallback is shown explicitly when routing is unavailable.

### 测试 / Tests
- **[质量] 增加语义执行授权、显式只读、用户决策阻断、手动领域保持、路由协议和 Webview 展示回归测试。**
  English: [Quality] Added regressions for semantic execution authorization, explicit no-write requests, user-decision blocking, manual domain preservation, routing protocol validation, and Webview presentation.

## [2.10.7] - 2026-08-02

### AI Agent 方案确认边界 / AI Agent Plan Approval Boundary
- **[修复] 执行模式展示方案后不再自动进入写入阶段**：静默的内部规划仍可在同一轮继续执行；但一旦 Agent 将拟执行方案作为可审阅内容展示，就会生成交互式方案卡并停止，只有用户明确批准后才进入写入或多 Agent 调度。
  English: [Fix] Execute mode no longer proceeds automatically after presenting a reviewable implementation proposal. Silent internal planning may still continue in the same turn, but a user-facing plan now creates an interactive approval stop before writes or dispatch.
- **[安全] 同一模型响应中提交完整 `Implementation_Plan.md` 时，后续项目写入、命令和 Agent 调度会被运行时拦截**，防止模型在方案卡尚未经过用户确认时抢先执行；已批准方案的续跑不会重复请求批准。
  English: [Safety] When a complete `Implementation_Plan.md` is submitted, later project writes, commands, and Agent dispatches in the same model response are blocked by the runtime. Approved continuations do not reopen the approval boundary.

### 测试 / Tests
- **[质量] 增加执行模式无落盘方案、完整方案写入识别、批准后续跑和方案卡渲染边界的回归测试。**
  English: [Quality] Added regressions for unpersisted Execute-mode proposals, complete plan-write detection, approved continuations, and interactive plan rendering boundaries.

## [2.10.6] - 2026-08-02

### AI Agent 快照与结算 / AI Agent Snapshot and Finalization
- **[修复] DeepSeek 多轮长回复不再因思考流快照膨胀而停留在运行中**：`reasoning_content` 现在按有界批次持久化，不再为每个细粒度增量创建独立步骤；同等 4.5 万增量规模约缩减为二十余次转录写入。
  English: [Fix] DeepSeek multi-turn answers no longer remain running while fine-grained reasoning deltas inflate the snapshot. `reasoning_content` is now persisted in bounded batches instead of one durable step per provider delta.
- **[性能] 转录快照增加硬边界与自动收敛**：限制保留轮次、步骤、帧、文本及结构化载荷；旧的大型快照在恢复或下一次转录更新时自动压缩，避免序列化时间和磁盘占用随对话无限增长。
  English: [Performance] Durable transcripts now enforce hard limits for turns, steps, frames, text, and structured payloads. Existing oversized snapshots converge automatically during restore or the next transcript update.
- **[修复] 快照落盘不再阻塞前台回复结算**：域操作先写入可恢复日志，快照作为回放加速器在后台生成；重复快照请求会合并，慢磁盘或大历史不会继续占用停止按钮和“运行中”状态。
  English: [Fix] Snapshot materialization no longer blocks user-visible completion. Recoverable journal operations remain durable, snapshots are generated in the background, and duplicate checkpoint requests are coalesced.

### 测试 / Tests
- **[质量] 增加 4.5 万思考增量批处理、快照总量边界和活动流 append offset 保持的回归测试。**
  English: [Quality] Added regressions for batching 45,000 reasoning deltas, total snapshot bounds, and preserving append offsets for an active stream.

## [2.10.5] - 2026-08-02

### AI Agent 工具调用可见性 / AI Agent Tool-call Visibility
- **[修复] DeepSeek 输出正文后继续准备工具时不再呈现为假卡死**：OpenAI-compatible 流一旦提供稳定的工具调用 ID 与工具名，界面会立即显示运行中的工具步骤；完整参数与正式执行到达后在同一行原地更新，不重复生成工具栏。
  English: [Fix] DeepSeek no longer appears stuck while preparing tools after visible text has finished. OpenAI-compatible streams now show a running tool step as soon as a stable call ID and tool name are available, then upgrade that row in place when complete arguments and execution arrive.

### Stellaris 规则 / Stellaris Rules
- **[修复] 统一 `ordered_*` 效果中 `order_by = value[variable]` 的 cardinality 元数据缩进。**
  English: [Fix] Normalized cardinality metadata indentation for `order_by = value[variable]` across `ordered_*` effects.

### 测试 / Tests
- **[质量] 增加流式工具调用身份传递和预览行原地升级回归测试。**
  English: [Quality] Added regressions for streamed tool-call identity propagation and in-place preview-row upgrades.

## [2.10.4] - 2026-08-02

### AI Agent 多轮收尾 / AI Agent Multi-turn Finalization
- **[修复] 第二轮与编辑重发不再等待流连接自然关闭**：DeepSeek 官方 Provider 返回 `stream_options.include_usage` 的空 `choices` usage 尾帧时，即使缺少 `finish_reason` 和 `[DONE]`，也会将该协议尾帧识别为回合完成并主动释放流。
  English: [Fix] Second turns and edit-resend runs no longer wait for the stream connection to close. An empty-`choices` usage trailer from the official DeepSeek provider now completes the turn even when both `finish_reason` and `[DONE]` are absent.
- **[修复] 流式输出期间可正常展开工具步骤**：活动组在鼠标按下时立即切换，并在逐 token 重绘以及“思考”组增长为混合步骤组时保留展开状态。
  English: [Fix] Tool steps remain expandable during streaming. Live controls now react before token-driven DOM replacement and preserve expansion when a thinking group grows into a mixed activity group.

### 测试 / Tests
- **[质量] 增加 DeepSeek usage 尾帧保持 HTTP 连接开启，以及实时工具组跨重绘展开的回归测试。**
  English: [Quality] Added regressions for an open DeepSeek stream after its usage trailer and for live tool-group expansion across streaming redraws.

## [2.10.3] - 2026-08-02

### AI Agent 流式收尾 / AI Agent Stream Finalization
- **[修复] 兼容接口输出结论后会立即正确结束任务**：OpenAI Chat Completions 兼容流现在将 `[DONE]` 和 `finish_reason` 视为终止信号，不再依赖中转服务器关闭 HTTP 连接；DeepSeek 等 Provider 会在终止后短暂接收 usage 尾帧，随后主动释放流。
  English: [Fix] OpenAI-compatible streams now finish on `[DONE]` or `finish_reason` instead of waiting for relay servers to close the HTTP connection. DeepSeek-compatible streams briefly accept the trailing usage frame before releasing the stream.
- **[修复] 缓存命中统计不再漏掉终止后的 usage 数据**：保留并解析 DeepSeek `prompt_cache_hit_tokens` 尾帧，避免已命中的前缀缓存被误记为零命中。
  English: [Fix] Cache-hit metrics now retain trailing DeepSeek usage data, including `prompt_cache_hit_tokens`, instead of under-reporting successful prefix-cache hits as zero.

### 测试 / Tests
- **[质量] 增加中转连接保持开启、`[DONE]` 收尾及 DeepSeek usage 尾帧的流式回归测试。**
  English: [Quality] Added streaming regressions for relays that keep connections open, `[DONE]` termination, and DeepSeek usage trailers.

## [2.10.2] - 2026-08-02

### AI Agent 运行收尾 / AI Agent Turn Finalization
- **[修复] 多轮长回答完成后不再停留在运行状态**：流式回答的 transcript 增量改为有界批量持久化，并在工具步骤切换和回合结束时强制冲刷；避免大量细碎磁盘写入阻塞 `generationComplete`，尤其改善用户确认修改后的第二轮执行。
  English: [Fix] Multi-turn runs no longer remain active after a long answer finishes. Streamed transcript deltas are persisted in bounded batches and flushed at tool boundaries and turn completion, preventing thousands of tiny journal writes from delaying `generationComplete`, especially on the second turn after the user approves an edit.

### 测试 / Tests
- **[质量] 增加流式 transcript 批处理、连续 offset 与多回合隔离回归测试。**
  English: [Quality] Added regression coverage for streamed transcript batching, contiguous offsets, and per-turn isolation.

## [2.10.1] - 2026-08-01

### Agent 界面与任务可见性 / Agent UI & Task Visibility
- **[优化] 独立 Agent 界面采用紧凑的运行面板**：在输入区上方持续显示当前任务进度和权威改动文件统计，支持弹出查看任务清单、逐文件增删行数及一键进入审阅工作区。
  English: [Optimization] The standalone Agent view now keeps a compact run panel above the composer with live task progress and authoritative changed-file totals, plus popovers for task details, per-file line deltas, and direct review access.
- **[修复] 子 Agent 任务不再覆盖主 Agent 任务**：Todo 状态按 Agent/Run 隔离，子任务只在所属子 Agent 界面展示，根任务继续独立持久化。
  English: [Fix] Child-Agent todos no longer overwrite the root task. Todo state is scoped by Agent/Run, child tasks render only in their owning Agent view, and root tasks retain independent persistence.
- **[优化] 超长用户输入折叠显示**：达到 800 字符或 10 行的输入默认显示为带行数、字符数和五行预览的可展开卡片，完整原文仍用于模型请求、历史恢复和编辑重发。
  English: [Optimization] User inputs of at least 800 characters or 10 lines now collapse into an expandable card with line/character counts and a five-line preview, while the complete original text remains available to the model, history restore, and edit-resend flows.

### 运行恢复与缓存统计 / Execution Recovery & Cache Statistics
- **[修复] 避免写模式澄清回复重复续跑**：Runner 能识别普通中英文的缺少目标/需要补充信息回复并正常停下；自动恢复遥测不再泄漏到对话，历史记录中的旧提示也会被过滤。
  English: [Fix] Writable runs now recognize ordinary Chinese and English clarification responses that require more input, preventing repeated automatic continuation. Recovery telemetry stays internal, and legacy visible recovery notes are filtered from transcripts.
- **[优化] 重做 Token 缓存请求分组**：缓存请求、缓存输入、Token 命中和节省量改用指标卡；Provider、模型、Agent 模式和工具阶段显示命中次数与命中率，提示词指纹默认折叠缩写，零命中原因单独展示。
  English: [Optimization] Token cache statistics now use metric cards for request hits, cached input, token hit rate, and savings. Provider/model/Agent-mode/tool-stage groups show hit counts and rates, prompt fingerprints are compact and collapsed by default, and zero-hit reasons are separated for faster scanning.

### 编排与安全 / Orchestration & Safety
- **[可靠性] 收紧多 Agent 任务图依赖修复**：仅接受唯一的大小写、规范化或编辑距离匹配，修复后重新检测循环，避免模糊依赖被错误连接。
  English: [Reliability] Multi-Agent task-graph dependency healing now accepts only unique case-insensitive, normalized, or edit-distance matches and rechecks cycles after healing, preventing ambiguous dependencies from being linked incorrectly.
- **[安全] 加固命令与科技树 Webview 边界**：Git 命令周围的复杂 Shell 语法重新进入审批；科技树仅读取允许根目录内的真实文件，并对 PNG Data URI、大小和源行号进行边界验证。
  English: [Security] Complex shell syntax around Git commands now returns to approval, while the technology-tree Webview restricts source reads to real files under allowed roots and validates PNG data URIs, size limits, and source line numbers.
- **[安全] 多 Skill 权限取交集并在 Run 结束时清理**，避免连续加载 Skill 扩大当前运行的工具权限。
  English: [Security] Multiple Skill tool policies now intersect and are cleared when the Run finishes, preventing sequential Skill loads from widening the active tool boundary.

### 测试 / Tests
- **[质量] 新增 Agent 跨界面契约、任务隔离、恢复策略、缓存 UI、长输入、编排依赖、命令预检和科技树输入安全回归测试。**
  English: [Quality] Added regression coverage for cross-surface Agent contracts, task isolation, recovery policy, cache UI, long inputs, orchestration dependencies, command preflight, and technology-tree input safety.

## [2.10.0] - 2026-08-01

### AI Agent 可靠性 / AI Agent Reliability
- **[功能] 类型化、分级且有界的恢复机制**：区分取消、上下文溢出、限流、传输故障、沙箱不可用、权限拒绝、工具校验和 Provider 故障，分别执行有界恢复；Checkpoint 持久化经过校验的重试请求，并通过父级恢复风暴预算阻止跨子任务的无效重复修改。
  English: [Feature] Added typed, classified, and bounded recovery for cancellation, context overflow, rate limits, transport failures, sandbox unavailability, permission denial, tool validation, and provider failures. Checkpoints now persist validated retry requests, while a parent recovery-storm budget stops repeated unproductive mutations across child tasks.
- **[功能] 有界历史检索工具**：新增只读 `history` 工具，仅检索扩展私有的持久化对话记录；限制文件、消息、结果和字符规模，默认排除 system/tool 内容并脱敏本地路径。
  English: [Feature] Added a bounded read-only `history` tool for extension-private persisted transcripts, with file/message/result/character limits, system/tool exclusion by default, and local-path redaction.

### Provider 与上下文 / Providers & Context
- **[优化] Provider 能力按实际协议与端点判定**：不再仅按 Provider 名称推断能力；官方 DeepSeek Chat Completions 在纯文本或推理响应因长度截断时支持最多两次 Beta prefix continuation，并合并统计全部续写用量。
  English: [Optimization] Provider capabilities are now derived from the effective protocol and endpoint instead of provider names. Official DeepSeek Chat Completions can perform up to two Beta prefix continuations for length-truncated text/reasoning responses, with usage merged across all continuation calls.

### 记忆、Skill 与 Hook / Memory, Skills & Hooks
- **[功能] 加强持久记忆治理**：按 Topic 串行写入，增加单调版本、`expectedRevision` 乐观并发控制、可恢复归档、显式永久删除，以及不包含记忆正文的有界召回轨迹。
  English: [Feature] Strengthened persistent-memory governance with per-topic serialized writes, monotonic revisions, `expectedRevision` optimistic concurrency, recoverable archives, explicit permanent deletion, and bounded metadata-only recall traces.
- **[安全] 强制执行 Skill 与 Hook 权限边界**：Skill 的 `allowed-tools` 成为当前 Run 的真实工具上限；Hook 配置经过大小与结构校验，仅运行白名单 VS Code 命令，并支持有界超时与 ignore/block 失败模式。
  English: [Security] Skill `allowed-tools` now form an enforced per-run tool ceiling. Hook configuration is size/schema validated, limited to allowlisted VS Code commands, and supports bounded timeouts plus explicit ignore/block failure modes.

### Shell 审批安全 / Shell Approval Safety
- **[安全] 不透明命令逐次审查**：`python -c`、`node -e`、`eval`、`xargs`、复杂 Shell 语法及嵌套等价形式不能复用历史放行规则。自动审核模式会先由模型检查安全性、用户意图和权限范围，无法确定时转人工；用户明确选择当前会话的完全放行模式后则直接执行。
  English: [Security] Opaque commands such as `python -c`, `node -e`, `eval`, `xargs`, complex shell syntax, and nested equivalents cannot reuse learned approvals. Auto Review sends each invocation to the reviewer model for safety, user-intent, and permission-scope checks, falling back to the user when uncertain; explicit session Full Access executes directly.

### 测试与文档 / Tests & Documentation
- **[质量] 补充恢复、Provider、历史、记忆、Hook、命令预检与权限路由回归测试，并同步更新架构和交付文档。**
  English: [Quality] Added regression coverage for recovery, providers, history, memory, hooks, command preflight, and permission routing, with synchronized architecture and delivery documentation.

## [2.9.7] - 2026-07-30

### 功能与优化 / Features & Optimizations
- **[优化] 优化项目索引和Agent运行**
  English: [Optimization] Optimize project indexing and agent execution.

## [2.9.6] - 2026-07-29

### 版本更新与打包 / Version Update & Packaging
- **[打包] 升级版本号并打包**
  English: [Package] Update version number and package.

## [2.9.5] - 2026-07-29

### 功能与优化 / Features & Optimizations
- **[优化] 增加异常崩溃监控**：增加异常崩溃监控。
  English: [Optimization] Added crash monitoring.

### 修复 / Fixes
- **[修复] 修复多个补全和跳转问题**：修复多个补全和跳转问题。
  English: [Fix] Fixed multiple completion and navigation issues.

## [2.9.3] - 2026-07-28

### 功能与优化 / Features & Optimizations
- **[优化] 优化项目知识库的更新延迟**：降低了项目知识库更新检测的延迟，提升 AI 对项目最新状态与语境的理解时效。
  English: [Optimization] Optimized the update latency of the project knowledge base, improving AI responsiveness to recent project changes.


## [2.9.0] - 2026-07-26

### 功能与优化 / Features & Optimizations
- **[优化] 增强性能和Shader语言和Agent支持**：增强了语言服务性能、Shader 语言服务与 Agent 运行协同体验。
  English: [Optimization] Enhanced performance, Shader language services, and Agent support.
- **[优化] Steam 创意工坊工作区默认不自动启用**：检测到工作区位于 `steamapps/workshop/content/` 时会先询问，用户确认后才启动 CWTools；同时改用工坊路径中的 Steam App ID 识别游戏，修复工坊 Mod 被误判为其他游戏（如 EU4/EU5）并写入设置的问题。
  English: [Optimization] Steam Workshop workspaces no longer auto-activate: folders under `steamapps/workshop/content/` now require user confirmation before CWTools starts. The game is now identified from the Steam App ID in the workshop path, fixing workshop mods being misdetected as other games (e.g. EU4/EU5) and having settings written into them.
- **[修复] 游戏识别不再"猜测"**：当工作区证据不足时，不再回退为用户唯一配置过路径的游戏（会把其他游戏的 Mod 误判为该游戏并写入错误设置）；无法确定游戏时弹出列表让用户选择，并按工作区记住选择。
  English: [Fix] Game detection no longer guesses: when workspace evidence is inconclusive, detection no longer falls back to the one game with a configured path (which mislabelled mods for other games and wrote wrong settings into them). Undetermined workspaces now ask the user to pick the game from a list, remembered per workspace.

## [2.8.39] - 2026-07-26

### 功能与优化 / Features & Optimizations
- **[优化] 增强性能和Shader语言和Agent支持**：增强了语言服务性能、Shader 语言支持与 Agent 运行协同体验。
  English: [Optimization] Enhanced performance, Shader language services, and Agent support.
- **[优化] Steam 创意工坊工作区默认不自动启用**：检测到工作区位于 `steamapps/workshop/content/` 时会先询问，用户确认后才启动 CWTools；同时改用工坊路径中的 Steam App ID 识别游戏，修复工坊 Mod 被误判为其他游戏（如 EU4/EU5）并写入设置的问题。
  English: [Optimization] Steam Workshop workspaces no longer auto-activate: folders under `steamapps/workshop/content/` now require user confirmation before CWTools starts. The game is now identified from the Steam App ID in the workshop path, fixing workshop mods being misdetected as other games (e.g. EU4/EU5) and having settings written into them.
- **[修复] 游戏识别不再"猜测"**：当工作区证据不足时，不再回退为用户唯一配置过路径的游戏（会把其他游戏的 Mod 误判为该游戏并写入错误设置）；无法确定游戏时弹出列表让用户选择，并按工作区记住选择。
  English: [Fix] Game detection no longer guesses: when workspace evidence is inconclusive, detection no longer falls back to the one game with a configured path (which mislabelled mods for other games and wrote wrong settings into them). Undetermined workspaces now ask the user to pick the game from a list, remembered per workspace.

## [2.8.36] - 2026-07-24

### 功能与优化 / Features & Optimizations
- **[优化] 优化内存消耗和补全验证性能**
  English: [Optimization] Optimize memory consumption and completion/validation performance.
- **[修复] 静态银河预览的 Y 轴方向**：使 Y 坐标与游戏地图的屏幕方向一致，并同步修正节点拖拽、画布平移、鼠标锚点缩放和网格绘制的逆变换。
  English: [Fix] Static galaxy preview Y-axis orientation now matches the in-game map, with node dragging, canvas panning, cursor-anchored zoom, and grid rendering using the same inverse transform.

## [2.8.30] - 2026-07-22

### 功能与优化 / Features & Optimizations
- **[优化] 优化Agent运行和使用体验**
  English: [Optimization] Optimize agent execution and user experience.

## [2.8.29] - 2026-07-21

### 功能与优化 / Features & Optimizations
- **[功能] 静态银河预览与位置编辑**：为 `map/setup_scenarios/*.txt` 中的 `static_galaxy_scenario` 提供 Canvas2D 银河地图预览（系统、坐标范围、星云、显式超空间航道）；编辑模式支持拖动系统与星云回写 X/Y、精确编辑或补充 Z，以及添加/断开显式航道（范围宽度保持、最小跨度写回、原生撤销），并提供反向范围、重复 ID、悬空航道等可视化诊断与 Steam Workshop 编辑风险确认。标题栏改用独立的地图图标，避免与翻译命令混淆。
  English: [Feature] Static galaxy preview & position editor: Canvas2D galaxy map for `static_galaxy_scenario` in `map/setup_scenarios/*.txt` (systems, coordinate ranges, nebulas, explicit hyperlanes). Edit Mode can drag systems and nebulas to write X/Y, edit or add Z, and add/disconnect explicit lanes with minimal span-precise edits (range width preserved, native undo), plus visual diagnostics for reversed ranges, duplicate ids and dangling lanes, Steam Workshop edit-risk confirmation, and a distinct map toolbar icon.
- **[优化] 优化了载入和运行性能**
  English: [Optimization] Optimized loading and runtime performance.

## [2.8.28] - 2026-07-20

### 功能与优化 / Features & Optimizations
- **[功能] 支持GPT PLUS会员登陆**
  English: Supported GPT PLUS member login.

## [2.8.27] - 2026-07-19

### 修复 / Fixes
- **[修复] 修复Openai等协议的支持**
  English: Fixed support for OpenAI and other protocols.

## [2.8.26] - 2026-07-19

### 功能与优化 / Features & Optimizations
- **[优化] 优化验证系统的更新速度**
  English: [Optimization] Optimize the update speed of the validation system.

## [2.8.25] - 2026-07-18

### 修复 / Fixes
- **[修复] inline_script 全局事件目标作用域关联**：展开模板时复用具体保存点已经计算出的作用域，避免模板坐标被重新解析为调用事件的 Country 作用域。
  English: Fixed inline-script global event-target scope association by reusing the concrete save site's computed scope instead of reinterpreting duplicated template coordinates as the caller event's Country scope.

## [2.8.22] - 2026-07-16

### 功能与优化 / Features & Optimizations
- **[优化] 优化域解析**：优化了针对脚本文件的域解析机制。
  English: [Optimization] Optimize domain/scope resolution.

## [2.8.21] - 2026-07-16

### 版本更新与打包 / Version Update & Packaging
- **[打包] 升级版本号并打包**
  English: [Package] Update version number and package.

## [2.8.20] - 2026-07-16

### 功能与优化 / Features & Optimizations
- **[优化] 优化域解析**：优化了针对脚本文件的域解析机制。
  English: [Optimization] Optimize domain/scope resolution.

## [2.8.19] - 2026-07-16

### 功能与优化 / Features & Optimizations
- **[功能] 实现了事件链解析器与 Paradox 脚本项目知识分析工具**：为 Paradox 脚本文件引入了事件链解析以及项目知识库的抽取和分析支持，提升了 AI 对项目结构的全局理解能力。
  English: Implemented Event Chain Parser and Project Knowledge extraction/analysis tools for Paradox script files, improving AI's global understanding of project structure.
- **[功能] 增强作用域解析能力并新增 `event_target` 等解析支持**：强化了对脚本中作用域的整体解析能力，并特别增加了对 `event_target` 等动态作用域的解析支持。
  English: Enhanced scope resolution capabilities and added parsing support for dynamic scopes such as `event_target`.
- **[功能] 实现 Stellaris 规则同步的作用域契约提取和验证工具**：支持在 Stellaris 规则同步流程中进行作用域契约（Scope Contracts）的自动提取和校验。
  English: Implemented scope contract extraction and validation utilities for Stellaris rules sync pipeline.
- **[重构] 清理废弃和未使用的服务接口与文件**：删除了子模块和主项目中已废弃及未使用的服务接口、实现文件，简化了核心后端系统结构。
  English: Removed deprecated and unused service interfaces and implementation files to clean up backend architecture.

### 依赖与配置 / Dependencies & Configuration
- **[配置] 更新 Stellaris 规则包与子模块**：更新了 `cwtools` 和 `cwtools-stellaris-config` 子模块，并同步更新了内置的 `stellaris-rules.zip` 规则压缩包和对应的版本元数据。
  English: Updated `cwtools` and `cwtools-stellaris-config` submodules, and generated the latest `stellaris-rules.zip` rules bundle alongside version metadata.

## [2.8.18] - 2026-07-14

### 功能与优化 / Features & Optimizations
- **[AI] 接入 OpenAI Responses 极速流式集成**：实现了 OpenAI Responses 的流式输出、Token 规格化和工具调用管理。
  English: [AI] Implemented OpenAI Responses fast-path integration with streaming, token normalization, and tool call management.
- **[AI] 优化编排器逻辑与对话面板样式**：重构了多 Agent 编排器核心逻辑，并美化了聊天面板的 Webview 样式。
  English: [AI] Implemented orchestrator logic and webview styling for chat panel.
- **[功能] 新增科技树可视化预览与解析器**：新增科技树预览面板与解析逻辑，支持查看依赖关系。
  English: Implemented Technology Tree visualizer webview and parser support.
- **[本地化] 重构本地化解析与富文本分词**：将本地化解析与富文本分词提取到独立的、可测试的工具模块中。
  English: Extracted localisation parsing and rich text tokenization into a pure, testable utility module.
- **[功能] 新增 GUI 预览面板与实时编辑**：实现了 GUI 文件的实时可视化预览与编辑支持。
  English: Implemented GUI preview panel for real-time visualization and editing of GUI files.
- **[功能] 新增星系预览与 Webview 编辑**：新增星系可视化预览面板，并支持在 Webview 中编辑天体。
  English: Added solar system visualization panel and webview editing support.
- **[AI] 新增 Agent 管理器 Webview**：实现了 Agent 管理器页面与相关的单元测试。
  English: Implemented agent manager webview and associated unit tests.
- **[AI] 完善 AI 助手集成**：整合了 AI 助手与对话面板、工具注册表和工作流管理。
  English: Implemented AI Assistant integration with chat panel, tool registry, and workflow management.
- **[AI] 实现外部工具处理器与指令预检**：支持外部工具调用、命令预检验证以及更完善的本地化支持。
  English: Implemented external tool handler, command preflight validation, and localization support.
- **[AI] 实现 Agent 运行器与断点恢复**：实现带检查点和 Token 预估的 Agent 运行器。
  English: Implemented agent runner module with checkpointing and token estimation.
- **[AI] 实现 AI 自动审查机制**：引入自动安全策略审查，防止 Agent 越权或执行高风险命令。
  English: Implemented AI auto-reviewer for safe, policy-driven authorization of agent tool actions.
- **[功能] 支持游戏 data 序列化与配置**：实现了游戏数据序列化工具，并初始化项目配置。
  English: Implemented game data serialization utilities and initialize project configuration.
- **[AI] 补充 AI 对话基础架构与 PDX 语法**：增加了 AI 聊天 UI 组件、设置管理与 Paradox 语法高亮支持。
  English: Added AI chat infrastructure including UI components, settings management, and Paradox grammar support.
- **[AI] 实现事件驱动的运行状态追踪**：引入事件驱动的 Agent 运行 reducers，支持细粒度追踪运行状态、工具调用和子 Agent 拓扑关系。
  English: Implemented event-driven agent run reducers and infrastructure for tracking state, tools, and sub-agent topologies.

### 依赖与配置 / Dependencies & Configuration
- **[配置] 更新子模块配置**：更新了 `cwtools-stellaris-config` 子模块至最新版本。
  English: Updated `cwtools-stellaris-config` submodule.

## [2.8.17] - 2026-07-12

### 功能与优化 / Features & Optimizations
- **[优化] 优化AI审批边界**：优化了 AI 在执行任务时的自动审批与权限判定边界，降低了对低风险工具和常用查询命令的误拦截，同时细化并收紧了核心高危及敏感操作的安全校验。
  English: [Optimization] Optimized AI approval boundaries and policy enforcement, reducing false blocks on low-risk tools and common query commands while refining security verification for critical sensitive operations.

## [2.8.16] - 2026-07-11

### 功能与优化 / Features & Optimizations
- **[优化] 提升了Agent的项目理解能力，建议使用/init**
  English: [Optimization] Improved Agent's project understanding, recommend using /init.

## [2.8.15] - 2026-07-11

### 功能与优化 / Features & Optimizations
- **[优化] 优化Agent运行**
  English: [Optimization] Optimize agent execution.

## [2.8.14] - 2026-07-09

### 功能与优化 / Features & Optimizations
- **[优化] 支持Opencode Go套餐**
  English: [Optimization] Support Opencode Go package.

## [2.8.13] - 2026-07-09

### 修复 / Fixes
- **[修复] 修复Meshscale的应用问题**
  English: [Fix] Fix application issues of Meshscale.

## [2.8.12] - 2026-07-08

### 功能与优化 / Features & Optimizations
- **[功能] 新增注释翻译预览命令**：新增 `cwtools.ai.previewSelectionTranslation` 命令，支持在右键菜单或编辑器标题栏中对选中的注释文本快速进行翻译预览，而无需直接修改/覆盖原文件。
  English: Added `cwtools.ai.previewSelectionTranslation` command to preview translation of the selected text in a hover/preview pane from the context menu or editor title bar, without directly overwriting files.

## [2.8.11] - 2026-07-07

### 改善用户体验 / Improve User Experience
- **[优化] 改善用户体验**
  English: Improve user experience.

## [2.8.10] - 2026-07-06

### 功能与优化 / Features & Optimizations
- **[优化] 动态合成辅助槽枚举扩展**：在群星游戏模式下，自动扫描 Mod 舰船区块定义的 `large_utility_slots` 等的最大数值，并动态扩展 `utility_component_slots` 的静态枚举范围，从而彻底根治由于 Mod 超大槽位数目导致的高插槽校验误报。
  English: Dynamically synthesise utility component slots: In Stellaris mode, automatically scans Mod ship section definitions for values like `large_utility_slots`, and extends the static `utility_component_slots` enum accordingly, preventing false positives from extremely large slot counts.

## [2.8.8] - 2026-07-05

### AI 规则语义与 LSP 证据 / AI Rule Semantics & LSP Evidence
- **[AI] 规则查询语义增强**：`query_rules` 现在会从 CWT 规则、`scope_changes.cwt`、`trigger_docs.log`、`scopes.cwt`、CWT 注释与 `modifiers.log` 中返回结构化 `hardFacts` 与 `semanticHints`，让 AI 区分“合法语法/作用域事实”和“文档语义提示”。
  English: `query_rules` now returns structured `hardFacts` and `semanticHints` from CWT rules, `scope_changes.cwt`, `trigger_docs.log`, `scopes.cwt`, CWT comments, and `modifiers.log`, so AI can separate legality facts from documentation hints.
- **[AI] 新增规则能力发现工具**：新增 `search_rule_capabilities`、`explain_scope`、`parse_pdx_fragment`，支持按意图、当前作用域和目标作用域查找合法 trigger/effect/scope_change；例如“舰队中遍历舰船”会优先定位到 `every_owned_ship`。
  English: Added `search_rule_capabilities`, `explain_scope`, and `parse_pdx_fragment` to discover legal trigger/effect/scope_change rules by intent and scope; for example, iterating ships from fleet scope now ranks `every_owned_ship` correctly.
- **[AI] 静态知识优先级修正**：静态知识库现在只作为背景指导；当它与 `query_rules.hardFacts`、LSP completion/diagnostics 或当前规则库证据冲突时，AI 应优先采用本地可验证规则证据。
  English: Static knowledge is now explicitly background guidance; when it conflicts with `query_rules.hardFacts`, LSP completion/diagnostics, or current rule evidence, AI should prefer verified local evidence.
- **[MCP] 多游戏规则源对齐**：MCP 与内置 AI 工具现在会优先读取当前游戏的规则目录，并支持显式规则目录、项目 profile、当前 game 的 `.cwtools`/release/submodule 规则源，避免非 Stellaris 项目误用 Stellaris fallback。
  English: MCP and built-in AI tools now prefer the active game's rules source, including explicit rules folders, project profiles, and current-game `.cwtools`/release/submodule rules, preventing non-Stellaris projects from accidentally using Stellaris fallback rules.
- **[修复] 规则源为空时不再误判作用域非法**：当没有加载到 `scopes.cwt` 或 CWT 规则文件时，`explain_scope`、`query_rules`、`search_rule_capabilities` 会返回明确的规则源缺失提示，而不是声称 `Fleet` 等作用域不存在。
  English: When no `scopes.cwt` or CWT rule files are loaded, `explain_scope`, `query_rules`, and `search_rule_capabilities` now report an empty rules source instead of claiming scopes such as `Fleet` are invalid.
- **[修复] 规则获取只使用主扩展来源**：AI/MCP 规则与缓存发现现在只读取 `ForeverSkywalker.foreverskywalker-stellaris-cwtools`，不再从旧的 `eddy-stellaris-cwt`、`tboby.cwtools-vscode` 或 `cwtools.cwtools-vscode` 目录获取过期规则。
  English: AI/MCP rule and cache discovery now uses only `ForeverSkywalker.foreverskywalker-stellaris-cwtools`, avoiding stale rules from legacy `eddy-stellaris-cwt`, `tboby.cwtools-vscode`, or `cwtools.cwtools-vscode` directories.

## [2.8.5] - 2026-07-03

### 功能与修复 / Features & Fixes
- **[功能] 新增默认主题**。
  English: [Feature] Added a new default theme.
- **[修复] 修复了 inline 的验证顺序**。
  English: [Fix] Fixed validation order for inline elements.

## [2.8.3] - 2026-07-02

### 修复 / Fixes
- **[修复] 修复 AI 卡片的错误**。
  English: [Fix] Fixed errors with AI cards.

## [2.8.2] - 2026-07-02

### 优化与更新 / Optimization & Updates
- **[修复] `@` 变量补全作用域与退格重拉问题**：改为服务端逐键前缀过滤；候选严格区分全局（`common/scripted_variables/`）与当前文件局部变量；支持退格删除自动重拉补全列表。
  English: Fixed `@` variable completion scope & backspacing issues: Implemented per-keystroke server-side filtering; restricted candidates to globals (`common/scripted_variables/`) and current file's locals; auto-trigger completion on backspace.
- **[优化] 减少编辑正文时的类型索引重建**：仅在编辑/增删顶层定义时触发索引刷新，普通正文编辑连续打字不再触发缓存清空。
  English: Avoid redundant type index rebuilds while typing: Skips the incremental refresh pipeline for body-only edits; saves or definition updates still refresh immediately.
- **[功能] 支持脚本与 inline_script 参数值的智能补全**：调用参数时自动根据定义中的使用位置代理补全其合法取值；`=` 加入补全触发字符、`= ` 后输空格自动拉起列表，无需 Ctrl+Space。
  English: Smart value completion for scripted/inline_script parameters: Proxies parameter values to their definition usage context to provide valid candidates; `=` is now a trigger character and typing the space after `=` pulls the list up automatically, no Ctrl+Space needed.
- **[优化] 加快补全弹出速度并缩短保存写锁**：缓存类型片段补全的 snippet 主体；增量保存首轮更新降级为浅层更新。
  English: Faster completion popup and shorter save locks: Cached snippet bodies for clause completions; optimized incremental save updates to be shallow initially.
- **[修复] 连续编辑后补全列表卡顿数秒的问题**：使用弱表缓存复用补全列表；预热本地化映射并把重算和深度校验移出写锁。
  English: 1s+ completion stall after continuous edits: Reused completion lists via weak-table caches; moved localisation pre-warming and deep validation off the write lock.
- **[优化] 避免全量类型刷新阻塞补全与悬停**：在读锁下重建 Lookup 克隆体并在写锁中快速交换引用，使刷新期间相关服务依然可用。
  English: Avoid blocking completions during full type refreshes: Rebuilt lookup indices under a read lock and performed reference swaps under the write lock to keep completion/hover responsive.
- **[优化] 降低连续保存时的补全延迟**：按引用缓存并复用变量和规则结构；对补全列表与校验倒排表进行惰性构建。
  English: Lower completion latency on frequent saves: Reused cached variable and rule structures; lazily built completion lists and validation maps.
- **[优化] 懒加载并自动回收工作区符号文件监视器**：减少保存时主机的多余唤醒。
  English: Lazily create and reclaim the workspace symbol file watcher to reduce redundant extension-host wakeups on save.
- **[优化] 提升参数解析器性能并降低内存占用**。
  English: Improved parameter parser performance and optimized memory usage.



## [2.8.1] - 2026-07-01

### 修复 / Fixes
- **[修复] 优化语言服务启动条件**：仅在检测到 Paradox 游戏或 Mod 项目证据时启动，其余工作区延迟至打开相关文件或手动引导时加载。
  English: [Fix] Optimize language server startup conditions: Starts only in workspaces with Paradox/mod evidence; defers loading for other workspaces until a game file is opened or manually triggered.
- **[修复] 限制安装配置页自动弹出**：整机仅在 Paradox 工作区自动打开一次，依然支持手动命令打开。
  English: [Fix] Restrict auto-popup of setup page: Opens automatically only once per machine in Paradox workspaces; manual open remains available.

  

## [2.7.9] - 2026-07-01

### 解析器更新 / Parser Updates
- **[解析器] 支持了 inline_scipt 路径上的表达式识别**
  English: Supported parser functionality for inline_scipt expressions on the path.

## [2.7.8] - 2026-07-01

### 解析器更新 / Parser Updates
- **[解析器] 支持了EU5和VIC3的解析器功能**
  English: Supported parser functionality for EU5 and VIC3.

### Local VS Code Tooling / 本地 VS Code 工具
- **[CSV]** Added Paradox CSV language support, row/column edit commands, diagnostics, and quick fixes for malformed row widths.
  中文：新增 Paradox CSV 语言支持、行列编辑命令、诊断，以及行列数异常的快速修复。
- **[Navigation]** Added related localisation, definition, and image lookup commands backed by the workspace index/local files.
  中文：新增关联本地化、定义与图片跳转命令，基于工作区索引和本地文件实现。
- **[Rules]** Added rules source management for remote rules, a user-specified local rules folder, and bundled fallback rules. Remote rules can use a custom Git URL; manual mode reads only the selected local folder; bundled fallback is used only when remote update fails and the cache is older than the bundled rules.
  中文：新增规则来源管理：远程规则、用户指定的本地规则目录、内置备用规则。远程规则支持自定义 Git 链接；manual 模式只读取选定的本地目录；内置备用仅在远程更新失败且缓存落后于内置规则时使用。
- **[Assets & AI]** Added local image conversion helpers, local path/Steam helpers, AI localisation translate/polish commands, and a VS Code-native inspection overview. Stellaris validation rules remain sourced from this project's own local CWTools rules.
  中文：新增本地图片转换、本地路径/Steam 辅助入口、AI 本地化翻译/润色命令，以及 VS Code 原生检查概览；Stellaris 校验规则仍以本项目自己的本地 CWTools 规则为准。
- **[UX]** Added setup-page and editor-title entry buttons for rules, local paths, inspection overview, image conversion/editing, and selected localisation AI actions.
  中文：为规则、本地路径、检查概览、图片转换/编辑，以及选中本地化文本的 AI 操作补充安装页与编辑器标题栏入口按钮。

## [2.7.7] - 2026-06-30

### MCP
- **[MCP] 严格且动态的工作区匹配 (Strict dynamic workspace matching)**：桥接模式现在会从 MCP roots、会话环境变量或 cwd 动态发现客户端工作区，并要求它与扩展宿主 bridge 暴露的 `workspaceRoot` 一致；不一致时返回 `bridge_unavailable`，避免误用另一个项目的诊断、索引和定义。`--workspace` 仅作为无法暴露按项目 root 的客户端的可选覆盖项。
  English: Bridge mode now discovers the client workspace dynamically from MCP roots, session environment variables, or cwd, and requires it to match the extension bridge `workspaceRoot`; mismatches return `bridge_unavailable` to avoid answering from another project. `--workspace` is only an optional override for clients that cannot expose a per-project root.

## [2.7.6] - 2026-06-30

### MCP
- **[MCP] 扩展宿主桥接模式 (Extension-host bridge mode)**：`cwtools-mcp` 现在默认采用轻量级代理模式，通过 `globalStorage/mcp/bridge-manifest.json` 连接到当前活跃的、与 VS Code 兼容的扩展宿主，复用 IDE 语言客户端和“问题”面板诊断信息（Problems diagnostics），从而避免启动第二个 CWTools 服务端（CWTools Server）。传统的自托管 LSP 模式仍可通过 `--standalone` 参数使用。
  English: `cwtools-mcp` now defaults to a lightweight proxy that connects to the active VS Code-compatible extension host through `globalStorage/mcp/bridge-manifest.json`, reusing the IDE language client and Problems diagnostics instead of starting a second CWTools Server. Legacy self-hosted LSP mode is still available with `--standalone`.
- **[文档 / Docs]** `packages/cwtools-mcp/README.md` 现在已支持双语，并包含了 Codex、Claude Code 和 Antigravity 的配置示例。
  English: `packages/cwtools-mcp/README.md` is now bilingual and includes setup examples for Codex, Claude Code, and Antigravity.

## [2.7.5] - 2026-06-30

### ⚙️ 框架升级
- **[迁移] 迁移至NET10**。

## [2.7.4] - 2026-06-30

### 📦 粒子编辑器优化
- **[粒子编辑器] 重力模拟微调**：对粒子编辑器的重力模拟进行了微调。

## [2.7.3] - 2026-06-29

### Marketplace identity
- **[Publish]** Changed the Marketplace extension name to `foreverskywalker-stellaris-cwtools` and added first-run globalStorage migration from legacy IDs (`foreverskywalker.eddy-stellaris-cwt`, `eddy.eddy-stellaris-cwt`).

### 📦 本地化更新
- **[本地化] 中英文本地化支持**：添加了项目主要文档（README.md、CONTRIBUTING.md、ARCHITECTURE.md）的英文版本。

## [2.7.0] - 2026-06-28

### 📦 功能更新
- **[功能] 粒子编辑器**：近似蠢驴粒子编辑器实现效果。

## [2.6.7] - 2026-06-26

### 📦 版本更新与打包
- **[Fix]**: 修复安装更新异常。
- **[功能] Stellaris 粒子特效预览与编辑器**：新增 `cwtools.previewParticle` 命令，可打开 `particle={...}` `.asset` 文件进行 Three.js 实时近似模拟、曲线编辑、子系统/力/属性编辑、贴图预览与写回；Vanilla 文件编辑时会先引导另存为 mod 副本。

## [2.6.6] - 2026-06-26

### Update Fixes
- **[Fix]**: 修复安装更新异常。

### 🛠️ 验证提示
- **[验证] 收紧 Stellaris `scripted_action` 字段顺序检查**：`user_scope` 必须是第一项，`scope` 必须是第二项，并提供中英文诊断提示。

### 📦 功能更新
- **[功能] 支持了修正和node key 的内联文本显示**
- **[功能] 内置 DDS/TGA 贴图预览**：双击 `.dds` / `.tga` 文件可直接在 VS Code 内查看，支持滚轮缩放、黑/白/灰背景切换，`.gfx` 中的贴图路径 Ctrl+Click 也会打开预览。

## [2.6.5] - 2026-06-25

### 🛠️ 验证提示
- **[验证] 收紧 Stellaris `scripted_action` 字段顺序检查**：`user_scope` 必须是第一项，`scope` 必须是第二项，并提供中英文诊断提示。

### 📦 功能更新
- **[功能] 支持了修正和node key 的内联文本显示**
- **[功能] 内置 DDS/TGA 贴图预览**：双击 `.dds` / `.tga` 文件可直接在 VS Code 内查看，支持滚轮缩放、黑/白/灰背景切换，`.gfx` 中的贴图路径 Ctrl+Click 也会打开预览。

## [2.6.4] - 2026-06-23

### 📦 错误修复
- **[修复] 修复了HOI4的本地化载入**

## [2.6.3] - 2026-06-22

### 📦 优化上下文压缩
- **[优化] 优化上下文压缩**

## [2.6.2] - 2026-06-21

### 📦 支持中文路径与中文 Key
- **[优化] 支持中文路径，中文 key**

## [2.6.1] - 2026-06-21

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.6.1**：日常维护与打包

## [2.6.0] - 2026-06-20

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.6.0**：优化升级了模型预览和编辑体验

## [2.5.9] - 2026-06-19

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.5.9**：优化验证功能

## [2.5.8] - 2026-06-18

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.5.8**：冲突检测

## [2.5.7] - 2026-06-18

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.5.7**：优化了 `on_action` 的报错提示

## [2.5.6] - 2026-06-17

### 📦 版本更新与打包
- **[版本] 升级版本号至 2.5.6**：降低了部分情况下参数警告的严重性。

## [2.5.5] - 2026-06-16

### ⚡ events 等脚本目录补全性能优化
- **[优化] 解决采纳/退格时补全无法连续弹出的卡顿问题**：通过将语义 Token 的“延迟性”计算优化推广到所有类型定义的脚本路径（如 `/events/`、`/common/` 等）。在打字和补全激活期间，语义 Token 不再被频繁清空重算，而是由 VS Code 自行平移缓存，从而消除了主线程 CPU 锁竞争与 150ms 读锁超时降级的问题。

## [2.5.4] - 2026-06-16

### 🐞 MCP 规则源修复
- **[修复] `--rules` 自定义规则现在真正生效**：此前 `--rules` 只写入被忽略的 initOption，而 `rules_version: manual` 下 server 实际只读 `rules_folder`（之前硬编码为 globalStorage 公开规则），导致自定义规则被旧公开规则覆盖。现统一解析一次规则路径并同时用于 `bundledRulesPath` 与 `rules_folder`，优先级 `--rules` > 已装插件解压 > dev 目录 > 打包 zip。实测空规则目录→0 类型、真实目录→全类型，证明 `--rules` 为唯一规则源。

## [2.5.2] - 2026-06-14

### 🔌 MCP 易用性与覆盖
- **[功能] Server 自描述指令**：MCP 在连接时下发工作流 `instructions`，引导 Agent 在 Paradox/群星项目中优先用工具验证 ID、查语法、查诊断，而非凭记忆。
- **[功能] 规则源可选**：新增 `--rules <dir|zip>` 显式指定 CWT 规则（zip 自动解压）；优先级 `--rules` > 已装插件解压 > dev 目录 > 打包 zip。
- **[功能] 版本无关稳定路径**：插件激活时把 MCP 同步到 `globalStorage/mcp/cwtools-mcp.cjs`，外部 Agent 指向该稳定路径即自动跟随插件更新，无需随版本号改配置。

## [2.5.1] - 2026-06-14

### 🔌 通用 MCP 服务（随插件分发）
- **[功能] MCP 打包进插件**：`bin/mcp/cwtools-mcp.cjs` 单文件自包含，供 Codex / Claude Code 等外部 Agent 调用，自动探测已安装插件的 LSP server、解压规则与 globalStorage 原版缓存。
- **[功能] 全项目诊断**：新增 `cwtools.ai.getAllDiagnostics` LSP 命令，MCP 的 `get_diagnostics`（不带文件）现返回全工作区真实诊断，而非仅 freshness。
- **[功能] 深层语义工具**：MCP 暴露 `query_scripted_effects`/`query_scripted_triggers`/`query_enums`/`query_static_modifiers`/`query_variables`/`get_entity_info`。
- **[安全] 纯只读面**：MCP 不再暴露写工具，文件写入交由宿主 Agent 环境；非白名单工具一律拒绝。
- **[修复] `getCompletionContext` 只读分类**：补入 `LanguageServer.fs` 的 `isReadCmd`，避免只读补全查询被当成写命令做锁路由。

## [2.5.0] - 2026-06-13
> 本条目汇总自 2.2.3 以来的主要能力演进（按主题归并，非逐提交流水）。

### ⚡ 自定义 scripted 类型增量刷新（本版核心）
- **[功能] 保存即时生效**：编辑并保存 `common/scripted_triggers/`、`common/scripted_effects/`、`common/script_values/` 下的定义文件时，不再触发整库全量 `RefreshCaches`，而是仅增量重建受影响的类型索引并复用同一构造逻辑重建补全/校验/Info 三服务，使自定义触发器、效果、脚本值在其它文件中**保存后近乎瞬时**可补全、可跨文件校验，告别"必须重载项目"。
- **[功能] 删除只更新关联**：删除上述定义文件时按来源文件精确移除其类型条目，并借助类型引用反向索引（`TypeReferenceIndex` / `FindAllRefsByType`）只重新校验真正引用了被删定义的文件。
- **[增强] 关联调用方重校验**：增量成功后会把当前打开的其它文件排入重校验队列，覆盖"新增定义后旧的未定义诊断不清除"的场景。
- **[安全] 全量回退守卫**：增量在游戏状态写锁内执行；遇到异常、非白名单类型或连续 25 次增量后自动回退到全量刷新做校正。`inline_scripts` 等非"叶子类型"仍走全量 + 调用方重校验路径。功能由 `experimental` 开关控制。

### 🤖 AI 多 Agent 编排
- **[功能] Orchestrator 协作框架**：引入 DAG 任务图、拓扑调度、跨 Agent 共享黑板、写意图/实体注册冲突检测和审查-自动修复质量门。
- **[安全] 子 Agent 沙盒**：`enforceSubAgentSafety` 在宿主层拦截越权工具与越界写入，本地化 `.yml` 子任务自动收敛为 `loc_writer` 且只允许 `write_localisation`。
- **[功能] 可选 worktree 隔离**：支持按 Agent 创建独立 git worktree 做并行写入隔离。
- **[增强] 多 Agent 工具集**：统一为 `dispatch_agents` / `query_blackboard` / `merge_results`。

### ⚙️ Runner 执行管线
- **[功能] V2 断点恢复**：为孤儿 `tool_call` 注入合成中断回复，结构化压缩摘要前置，支持中断续跑。
- **[功能] 运行账本与回放**：每次运行落盘为 `AgentRunEvent` JSONL，配套纯函数事件投影 reducer（run 状态 / 工具时间线 / Agent 拓扑 / 缓存统计）与 recorded-tool 回放。
- **[增强] 流式与防循环**：细粒度步骤/Token 增量流式广播；doom-loop 语义检测防止重复无效循环。

### 🛡️ 权限与安全边界
- **[安全] 分层权限引擎**：`policyEngine` 以分层 profile 解析权限（当前 shadow 模式只记录不强制），仅 user/approvals 层可放宽，mode/workflow/role/task 只能收紧。
- **[功能] 自动审查与写模式梯**：只读式 `autoReviewer` 从结构化元数据审批、风险 3 与升级一律转交用户；写模式快速梯 confirm / auto / auto_review / full。
- **[安全] 命令与环境收口**：`run_command` 经 preflight 分词与风险分级，高危/升级命令必须授权；shell 环境变量 allowlist；MCP 工具经 `executeMcpTool` 单点权限收口。

### 🧰 工具系统重构
- **[增强] 模糊编辑原语**：`edit_file` 采用 10 策略递进式模糊替换；`read_file` 行号前缀可被自动剥离回退匹配。
- **[功能] 弱工具调用兼容**：`schemaFlatten` 自动展平深层 schema、`argRepair` 修复参数漂移。
- **[变更] 退役旧写工具**：`apply_patch` / `multi_replace_file_content` / `ast_mutate` 退出模型可见工具集，统一引导至 `edit_file` / `replace_lines` / `edit_pdx_block` / `write_localisation`。
- **[增强] 结构化读取**：`get_pdx_block` / `get_file_context` / `document_symbols` 优先于原始扫描，并接入 ReadTracker 读后写完整性校验。

### 🔌 多 Provider 与成本
- **[功能] Custom 四种线协议**：`customApiFormat` 支持 `openai-chat-completions` / `openai-responses` / `anthropic-messages` / `gemini-generate-content`；endpoint 按 Provider 存储并自动迁移旧全局配置。
- **[功能] 前缀缓存度量**：嗅探多厂商缓存计量字段，应用差异化打折精算省钱金额，前端以"命中/新建/穿透"三柱微图与会话仪表盘高保真呈现。
- **[增强] 作用域定价**：定价与上下文窗口支持 `providerId:model` 作用域键。

### 🧠 项目智能
- **[功能] `/init` 项目档案**：扫描工作区构建 `ProjectProfile`，生成 `CWTOOLS.md` 规则并注入系统提示词。
- **[功能] 多游戏知识与技能**：为 9 款 Paradox 游戏提供 PDXScript 知识块；`SKILL.md` 技能系统按需经 `run_skill` 加载正文；topic 级长期记忆与自动裁剪。

### 🌐 诊断中文化与服务端加固
- **[功能] 诊断增强**：`diagnosticI18n` 在 LSP middleware 中提供中文翻译 + 修复建议，诊断码 `codeDescription` 链接到 `docs/diagnostic-codes.md`，动态参数诊断可延迟预热重发。
- **[增强] 格式化与降级**：服务端实现 `.yml`/PDX 文档格式化；补全请求读锁超时回退 stale-cache 降级结果。
- **[功能] 三平台发布与 fallback 规则**：服务端三平台产物，规则缺失时从内置 `stellaris-rules.zip` 内存读取回退；`rules-sync` 提供 scan/check/update/report。
- **[修复] 脚本效果紧凑可选块误报**：`[[PARAM] … $PARAM$]` 紧凑写法中粘连在值末尾的闭合 `]`（如 `$NAME$]`）会被并入值 token，导致展开后出现 `值]` 形态的假 token，误报 CW100/CW240/CW244。现在 `applyBracketConditionals` 会正确识别并剥离这种粘连闭合，保留真实值继续参与替换与校验。
- **[修复] 本地化引号与不可见/多语言字符误报 (CW268/CW275)**：loc 值解析改为接受任意**非控制字符**(外加 TAB)替代原先总会漏块的 Unicode 白名单——希腊/西里尔/阿拉伯字母、各类符号、全角标点、零宽格式字符、emoji、以及引号后的 TAB/空白不再把值截断而误报 CW275；引号校验改为"外层必须用英文 ASCII 双引号正确开合"——内层引号(全角/半角)自由，而尾随内容、缺失闭合、完全无引号仍正确报告(CW268)。
- **[功能] 本地化全局变量引用**：支持 loc 文本中 `$@scripted_variable$` 形式引用全局 `@` 脚本变量，并按已收集的全局脚本变量集做存在性校验——已定义则通过，未定义才报告（CW225），不再一律误报为未定义本地化键。

### 🪐 可视化预览
- **[功能] 多面板预览**：实体 3D（Three.js）、`.gui` Canvas 预览与拖拽编辑、星系/行星、事件链图、科技依赖图。

## [2.2.3] - 2026-05-26
### 🛠️ 启动机制加固与预备回退机制增强
- **[功能] 启动状态主动自检**：
  - 在插件激活阶段引入完整的语言服务及 LSP 自检机制，能主动验证宿主和沙盒依赖的完整性，极大提升了黑屏或卡死状态下的容错度。
- **[功能] 预置规则回退守卫 (Built-in Fallback Rules)**：
  - 新增内置 Fallback 降级解析规则。当项目缺少完整的游戏解析环境（如未初始化项目 profile 或工作区缺少 CWT 配置规则集）时，自动触发高安全性的内置语义级语法和断言回退，保障基础语言解析能力的连续性。

## [2.2.2] - 2026-05-24
### 🛠️ 服务端三平台发布加固与 vanillaCompare 重塑
- **[功能] 原版文件 Git 风格物理对比强化**：
  - 重塑 `vanillaCompare.ts` 的核心物理对比机制。对存在原版副本的文件，全面引入 Git 风格的物理文件直达比对，彻底解决了长文本与复杂结构直接做块比对解析报错的历史问题。
  - 为无原版副本的纯新增自定义文件保留了安全的 AST 块级级联对比回退机制，确保插件逻辑无盲区。

## [2.2.1] - 2026-05-22
### ⚡ 原版比对迁移性能突破与 QuickPick 交互打磨
- **[功能] 一键批量/选择性还原原版 (`migrateChangedFromVanilla`)**：
  - 在文件级 Diff 或普通编辑界面的标题栏右上角增设绿色对齐勾号按钮。一键自动搜集并比对当前文件所有与原版存在不一致的匹配代码块。
  - 引入 VS Code 交互式 `QuickPick` （`canPickMany`）多选面板，默认**全选**（按 Enter 即可一键完成批量还原），亦支持按需局部挑选块，兼顾效率与细粒度控制。
  - **安全防呆网**：当一次性还原的代码块 $\ge 10$ 个时，会强制弹出模态确认弹窗，严防误读写覆盖大片逻辑。
  - **极速零顿挫**：底层采用 WorkspaceEdit 合并全部变更并在写入前将目标块行号进行**降序（倒序）重排**。保证无论还原多少个块，VS Code 内部都仅重算**一次**全量 Diff，从物理层根治了 VS Code 内置 Diff 编辑器“每点一下卡一下”的卡顿顽疾。
- **[功能] 块级右键定点迁移 (`migrateBlockFromVanilla`)**：
  - 将命令挂载至编辑器右键上下文菜单。允许用户在光标所在代码块内右键一键将其精准变更为原版。
  - 移除了不可达的冗余空校验，引入 TypeScript 的非空断言（`!`）收敛参数类型，实现极致清爽的代码架构。

## [2.2.0] - 2026-05-21
### 🛡️ 安全沙盒机制升级与本地化模式效率重构
- **[安全] Orchestrator 子代理沙盒强效加固**：重构了子代理安全沙盒模型 `subAgentSandbox.ts`，将敏感特权工具 `'run_command'` 正式加入全局工具黑名单，直接物理阻断子代理未经提权直接在终端执行任意脚本的行为。如遇到文件修改需求强制引导其使用带有脏检测的并发写队列结构，或上报 `BLOCKED_FOR_ORCHESTRATOR` 由父级统筹器提权，显著增强了多 Agent 协同任务执行时的系统级环境防护能力。
- **[特权] 本地化与翻译代理模式特权修复**：在工具注册表 `registry.ts` 的本地化运行模式（`LOC_MODES`，包含 `loc_writer` / `loc_translator`）所授权调用的工具集中，显式增设了 `'write_file'` 的运行许可。彻底突破了此前翻译代理只能使用局部逐条 `write_localisation` 覆盖的低效局限，支持其在沙盒限定目录的写约束保障下，对大型本地化翻译文件进行更高效的整块落盘重构与直接生成。
- **[交互] AI 搜索去重调优与时间轴防重纠偏**：
  - **LSP 搜索级联优化**：重塑了 `lspTools.ts` 级联多层搜索算法，增加了零索引跳转精确校准器 `normalizeSearchLine` 并合并了单文件结果去重上限，在保障不同版本 VS Code API 结果高度对齐的前提下，大幅削减了多源级联检索时的冗余 Token 损耗。
  - **分栏与下钻滑入物理阻断**：精修了 `.subagent-fullscreen-view` 在双 Agent 极速分栏滑入时的视觉和手势交互体验，添加了 `overscroll-behavior: contain` 覆盖以在并排模式下彻底阻断背景滚动串透；重构时间轴加载函数 `loadTopic`，过滤丢弃了无用或已处理的异步任务恢复快照，彻底消除了由卡片叠加引发的伪误报。

## [2.1.26] - 2026-05-20
### 🌐 AI 设置本地化与 VSIX 构建链优化
- **[本地化] AI 提供商设置汉化适配**：将 `package.json` 中的新增 AI 服务提供商（谷歌 Gemini、小米 MiMo、MiniMax 额度套餐、OpenCode 等）描述从硬编码文本拆分迁移至 `package.nls.zh.json`，确保 VS Code 配置页面在多语言环境下获得一致的 premium 显示体验。
- **[修复] VSIX 打包构建链加固**：针对部分 Node.js 执行环境下 vsce 在打包阶段可能出现的 ESM 模块引导加载死锁错误，对构建命令进行了分步执行隔离，大幅提升了打包流水线和自动化发布的稳定性。

## [2.1.25] - 2026-05-19
### 🎨 UI 与机制体验优化
- **[界面] 探索过程 UI**：优化了 Agent 执行界面的“探索过程”样式，调整了 CSS 细节与中文本地化。
- **[机制] Diff Summary**：为多文件变更摘要（`diffSummary`）补充了唯一的 `summaryId` 标识，便于后端追踪溯源。
- **[提示词] 内置指令优化**：更新了 `PromptBuilder` 中有关工具调用的约束细则。

## [2.1.24] - 2026-05-18
### 🎨 UI 交互与模型设置调整
- **[界面] 对话框交互**：进一步调整了 ChatPanel 界面的输入框布局与模型快捷选择器的事件机制。
- **[优化] Artifact 控制台模型支持**：增加了对更多后端 AI 模型配置参数集的读取与隔离。

## [2.1.23] - 2026-05-17
### 🛠️ 诊断验证机制加固
- **[优化] 局部文件诊断状态清空**：在修复 LSP 错误时，引入了深层验证缓存强制清除和空诊断补发机制，彻底解决了“修改代码后问题面板仍然残留旧错误”的顽疾。
- **[修复] 新鲜度检测一致性**：对后台服务端相关的缓存结构清空进行了进一步的隔离与加固，保障了多文件并发写入时的准确性。

## [2.1.22] - 2026-05-16
### 🤖 代理模式优化
- **[增强]** 增加了泛用模式，替代问答模式

## [2.1.21] - 2026-05-16
### 🤖 AI Agent 资源校验与协作体验修复
- **[功能] Sprite 资源候选查找**：质量门检测现在会针对 `Expected value of type sprite` 等图片引用错误检索项目与原版 `.gfx` 精灵图定义，并要求 Agent 使用真实候选项完成修复，避免凭空编造 sprite 名称。
- **[功能] Sound 资源候选查找**：新增对 `show_sound`、`sound` 等音效引用的 `.asset` 候选检索能力，AI 修复阶段会先定位可用声音资源再写入脚本。
- **[增强] GUI 专家资源约束**：GUI 子 Agent 现在同样会按 GFX sprite 候选进行资源调用，降低界面文件修复时的贴图引用错误。
- **[优化] 全局任务 Walkthrough**：任务完成后的 walkthrough 报告改为总结本轮用户请求的完整任务，而不再只描述最后一次局部修复。
- **[修复] Artifact 计划/验证筛选**：Artifact 抽屉中的“计划”和“验证”入口恢复可点击筛选，并支持无文件预览卡片展示。

## [2.1.20] - 2026-05-15
### 🌌 星系预览可视化大更
- **[功能] 动态星球类别支持**：现已支持实时解析并引入自定义 Mod 中的动态星球类别（Planet Classes），并在预览面板中正确渲染适配图标和模型预留口。
- **[优化] 分组与智能右键菜单**：星系预览右键菜单及搜索框新增了智能分组逻辑（如：恒星、宜居星球、环世界等），大幅提升了寻找和放置特定天体时的操作体验。
- **[底层] 预加载框架搭建**：为即将到来的 3D 贴图材质与自定义肖像打下基础，在底层渲染管线中添加了图像与材质智能缓存调度（Cache Queue）。

## [2.1.19] - 2026-05-14
### 🤖 AI Agent 架构与工具链重构
- **[重构] 统一文件修改工具**：全面弃用并移除了过时的 `edit_file`、`multiedit` 和 `replace_lines` 工具，统一整合为 `multi_replace_file_content`。这大幅提升了 AI 在处理多块代码编辑时的原子性、稳定性和执行效率，避免了中间状态错误。
- **[功能] 文件级上下文引用支持**：聊天面板及附带上下文机制（Context References）现已正式支持全文件引用（`FileContext`）。用户现在可以将完整文件直接作为上下文附带给大模型，而不再局限于局部代码片段。

## [2.1.18] - 2026-05-14
### ✨ InlayHints 增强与数学表达式求值
- **[功能] 嵌套本地化解析**：增强了悬浮提示与内联提示（InlayHints）功能，现在能够递归解析并显示嵌套的本地化引用（如 `$SOME_KEY$`）。
- **[功能] 脚本变量数学运算求值**：现在内联提示能够直接计算并显示 `@[]` 结构体中的数学运算结果（例如 `@[@base_value * 2]`），极大提升了编写复杂修饰符时的体验。
- **[优化] 提示位置修正**：修复了在行尾有空格或换行时内联提示位置偏移的问题，现在提示会精准贴合在变量或词条的末尾。

## [2.1.17] - 2026-05-14
### ⚡ F# 服务端性能极速优化
- **[性能] 极致消除 GC 压力与内存分配爆炸**：对 F# 后端服务进行了深层改造，通过在 `Program.fs` 中实现原生的 `cachedLocMap` 静态缓存并在悬浮提示(Hover)与内联提示(InlayHints)功能中共享引用，彻底消除了此前每次 LSP 交互时重新实例化数万条本地化词条所导致的高频垃圾回收(GC)卡顿，带来丝滑顺畅的大型 Mod 编写体验。
- **[核心] 更新子模块依赖**：同步升级了底层 CWTools 解析器核心子模块引擎代码。

## [2.1.16] - 2026-05-13
### 🧱 架构重构与稳定性增强
- **[系统] 统一多模型 AI 编排**：完全重构了 `aiService.ts` 与 `orchestrator.ts`，实现了支持多供应商（如 OpenAI, Anthropic, Gemini, DeepSeek 等）底层模型的统一聊天集成。
- **[机制] 增强并行任务稳定性**：增加了针对超大型工程文件的 `MAX_CONTEXT_LENGTH` (50,000 字符) 强截断保护以及 15 分钟级的绝对沙盒超时终结器。

## [2.1.15] - 2026-05-13
### ⚡ 性能优化与网络中断完善
- **[性能] 优化模糊匹配算法性能**：为 `replacerSuite` 中的模糊匹配和替换算法加入了迭代次数上限与快速剪枝策略，有效防止在编辑超大文件（数万行）时导致 Extension Host 死锁卡顿。
- **[系统] 完善外部工具中断链路**：将 `abortSignal` 底层打断机制进一步集成覆盖到所有的外围 Web 搜索工具中（`web_fetch`、`search_web`），确保统筹器发出取消指令时网络资源能够被立刻释放。
- **[机制] 进一步收紧子代权限**：在 Orchestrator 的子代理排除名单中追加了 `codesearch` 工具，确保大规模的本地代码图谱搜索只由核心主控代理完成，降低子代理的推理干扰。

## [2.1.14] - 2026-05-13
### ⚙️ 子代代理 (Sub-Agent) 行为修正与取消机制修复
- **[机制] 禁用子代理网络检索工具**：在 Orchestrator 派发子任务时，通过新增的 `excludeTools` 配置强行移除了 `web_fetch` 和 `search_web` 权限。这彻底切断了子 Agent 在遇到不确定问题时陷入无意义的网络搜索“死亡循环”的可能；如需外部网络资料，现在强制要求主控代理在派发前完成搜索并通过上下文注入。
- **[修复] 彻底修复子代任务无法强制终止的漏洞**：修复了底层模型请求丢失 `abortSignal` 传递的致命 Bug。现在，当用户点击中断或父级统筹器因为超时/错误强制剥夺子节点的执行权时，请求中断信号将直接穿透并终结底层的流式 HTTP 链路，杜绝了 UI 上显示已取消但后台仍在疯狂拉取 Token 扣费的现象。

## [2.1.13] - 2026-05-13
### 🌐 网络请求安全熔断机制升级
- **[系统] 修复 Web 检索导致的事件循环冻结**：为 `web_fetch` 与 `search_web` 工具添加了强制性的响应体积上限防御。在处理超大（如数MB）且缺乏分块的纯文本或异常网页时，原有的 HTML 正则清洗管道会导致 Node.js 主线程事件循环进入长达数十秒的死锁（连超时熔断器都无法触发），现已在执行清洗前强行截断超限内容以保护 Extension Host 的稳定性。

## [2.1.12] - 2026-05-13
### ✨ 语言服务新特性与清理
- **[特性] Semantic Token 支持**：实现了基于 LSP 的高级语义词元提供程序 (Semantic Token Provider)，全面提升了编辑器中各类脚本关键字、变量名与自定义类型的高亮准确度与渲染层级。
- **[系统] 强化 LSP 日志监控**：增强了 F# 服务端核心组件 (`Program.fs`) 的底层诊断日志输出，为今后的通讯链路调试提供更详尽的上下文支持。
- **[维护] 移除诊断文件遗留**：移除了开发阶段残存的 `MemDiag.txt` 与相关任务清单，保持项目根目录的整洁。

## [2.1.11] - 2026-05-13
### 🌐 网络调度防护与检索规范
- **[稳定性] 网络请求超时熔断机制**：为所有的外部 Web 检索工具（`web_fetch`、`search_web`、`codesearch`）增加了硬性的底层 15 秒超时熔断器（AbortController）。彻底解决了当外部网络环境不佳或搜索引擎 API 响应阻塞时，导致整个 Agent 执行主线程被无限期挂起（Hang）的致命死锁问题。
- **[规范] 抑制大模型的外网搜索冲动**：针对部分 LLM 遇到未知代码时不优先查阅本地 CWTools AST 规则，反而试图“走捷径”直接去外网搜索的偷懒行为，在 System Prompt 层级增加了严厉的禁用警告，强制要求 Agent 将本地代码上下文与缓存引擎验证作为依赖分析的绝对第一顺位。

## [2.1.10] - 2026-05-12
### ✨ AST 编辑器与上下文截断升级
- **[新工具] 结构化区块编辑 (Edit PDX Block)**：为 Agent 引入了原生的 `edit_pdx_block` 结构化编辑工具。AI 现在可以直接利用 CWTools 提供的 AST（抽象语法树）精准替换指定的脚本块，彻底摆脱了 `edit_file` 和 `multi_edit_file` 工具频繁因为“多重匹配或字符串上下文不完全对齐”而修改失败的顽疾。
- **[防护] 激进的文件截断警告**：针对大模型喜欢滥用 `read_file` 一次性读取整份几千行代码的低效行为，大幅降低了单次读取行数阈值（YAML 等文件降至 50 行），并在截断信息中加入了强烈的防御性警告（🛑 STOP!），硬性引导 AI 转向使用 `grep` 或 `get_pdx_block` 工具进行精准检索。
- **[体验] 符号未定义自助纠错提示**：当 AI 尝试使用 `query_definition` 查找一个不存在的符号时，系统不再仅仅抛出找不到的错误，而是会将当前文件内真实存在的有效 AST 符号层级树（扁平化前 30 个）直接附在报错信息里，极大提升了 AI 自我修正拼写错误的效率。
- **[系统] 精简 Token 消耗**：全量修剪了 System Prompt 工具定义中的冗长解释说明，在不影响 AI 理解功能的前提下，显著压缩了调度器的固定 Token 占用。

## [2.1.9] - 2026-05-12
### ⚙️ 编排引擎与上下文流转强化
- **[机制] 子代自动上下文注入 (Context Files)**：为 Orchestrator 的 `dispatch_agents` 下发结构引入了全新的 `contextFiles` 数组参数。现在，主控代理不再需要在 JSON 的 `prompt` 字段中硬塞超长的设计蓝图或文件内容（极易导致 JSON 截断失败），只需传入 Blackboard 引用键或目标文件路径，底层引擎会在拉起子 Agent 前自动读取并注入至该子代的上下文顶部，大幅增强了巨型架构规划向下传导的稳定性。

## [2.1.8] - 2026-05-12
### ⚙️ 核心并发引擎修复
- **[稳定性] 修复任务追踪导致的多 Agent 死锁**：将 `todo_write` 工具从文件全局锁（`PartitionedWriteQueue`）拦截列表中剥离为纯内存级只读操作，并为其触发的前端 UI 防抖渲染回调追加了严格的异常隔离沙盒。彻底解决了在 Orchestrator 调度多 Agent 并行执行时，因底层工具锁竞争而引发的进程意外挂起或死锁现象，使得多子代执行环境真正达到生产级稳定。

## [2.1.7] - 2026-05-12
### 🛡️ 代码生成质量防御强化
- **[机制] 逻辑冲突检测与质量门增强**：对底层指令构建器（`PromptBuilder`）和自动审查机制（`QualityGate`）进行了深入强化。Agent 现在不仅会被要求消灭所有的语法和 LSP 报错，还被硬性强制拦截诸如“在一个事件内同时使用 `hide_window = yes` 和 `option` 分支”等自相矛盾的**逻辑冲突**。
- **[规范] 禁止删减逻辑的作弊修复**：针对 AI 过去在修复复杂报错时偶尔会采用“直接掏空出错区块（Gutting）”或“删减逻辑分支”来换取通过验证的不良倾向，现已明确下发了严厉的约束禁令。系统强制 AI 在原有的结构骨架和代码上下文内进行定点修复，坚决保障最终生成代码的业务完整性（Structural Completeness）。

## [2.1.6] - 2026-05-12
### 🪄 对话界面交互增强
- **[交互] 悬浮向导提问卡片 (Question Wizard)**：对 Chat 面板中的交互式提问卡片（Question Cards）进行了重构。现在当 AI 一次性抛出多个连续提问或确认选项时，它们将被自动剥离出对话流并集中提取至全局屏幕悬浮层（Floating Card Queue）中，通过一种类似向导（Wizard）的序列化弹窗逐个呈现，以确保用户的注意力不被长对话历史淹没。

## [2.1.5] - 2026-05-12
### ⚙️ 稳定性与本地化修复
- **[机制] 编排器 Token 防洪与参数阻断**：针对 Orchestrator 在下发子任务时偶尔将超长文件流直接塞入 `prompt` 导致 JSON 截断失败的顽疾，在底层调度器签名中追加了强硬警告，强制其改用 `set_memory` 共享引用传递巨型数据，显著提升多 Agent 调度的存活率。
- **[界面] 补全语言本地化**：为“发送选中内容到对话面板”等新命令补齐了缺失的简体中文本地化映射。

## [2.1.4] - 2026-05-12
### ✨ 编辑器交互与搜索能力升级
- **[新功能] 快捷发送选中代码至 Chat**：新增快捷键绑定（`Ctrl+L` / `Cmd+L`），允许用户在编辑器中选中一段代码后一键将其作为上下文发送至 AI 对话面板，大幅提升交互效率。
- **[新能力] 全局 Grep 搜索工具**：为 Agent 引入了原生的 `grep` 工具支持，补全了底层正则检索能力。Agent 现可对工作区执行自由文本及正则表达式搜索。
- **[增强] 交叉引用查询 (Query References)**：重构了 `queryReferences` 引擎，优先通过 VS Code LSP 的原生工作区符号表及引用解析器（`executeReferenceProvider`）进行高速精准查找，仅在失败时平滑降级至全量文本匹配，极大地提升了重构规划与文件依赖检索的准确性。
- **[增强] 图片元数据读取**：`read_file` 的底层扩展现在能够智能识别并拦截 `.dds` 和 `.tga` 等二进制贴图，转而以 JSON 形式返回图像的基本元数据（宽、高、像素格式、Mipmap 层级），防止乱码文本污染 LLM 上下文。

## [2.1.3] - 2026-05-12
### 🤖 编排器防抖与并发上限保护
- **[机制] 并发任务防爆池**：为防止 `dispatch_agents` 一次性触发过量并发请求导致服务提供商限流甚至 API 超时崩盘，引入了硬性保护逻辑：**一次最多仅允许分派 4 个并行子任务**。超过该数量时系统会果断拦截并建议降级拆分调度策略。
- **[机制] 子代执行生命周期**：补齐了 Orchestrator 与子 Agent 运行图之间的通讯闭环。新增发送 `subtask_complete` 生命周期事件，在失败/异常终止和正常终了三种情况下准确传递至前端界面状态进行标识。
- **[界面] 隔离与状态防误导**：重构了完成态的 UI 构建逻辑，现在子代理运行结束后将保持原有的折叠视图界面而不会错误地融合至主视图，同时移除了最终历史消息中带有误导性的“动态呼吸”思考小球（`think-pulse`），更准确地反映已完成状态。

## [2.1.2] - 2026-05-12

### 🤖 编排器与代理 UI 优化
- **[优化] 黑板储存引导词修正**：为应对部分子 Agent 将超长数据（文件表、AST等）存入 `Blackboard` 后直接卡死在后续步骤的现象，在 `set_memory` 成功截断返回后添加了强制性系统提示（"You MUST now output your final text response to complete your sub-task."），督促 Agent 继续完成任务生命周期。
- **[界面] 代理日志前缀净化**：在 ChatPanel 端对提取自多并发子代的日志渲染进行了优化，自动抹除并隐藏形如 `[explorer_01] ` 的冗余前缀标识，保持对话流界面的清爽与原生感。

## [2.1.1] - 2026-05-12

### 💾 代理间数据流优化
- **[优化] 黑板内存防爆 (Blackboard Auto-Spill)**：由于大容量数据的传递极易撑爆 Prompt Token Budget，`set_memory` 工具现在会对超过 500 个字符的数据实施自动溢出保护，即自动转存到 `.cwtools-ai` 的隐藏本地文件中，而黑板上仅保留其物理路径引用（`file://...`）。
- **[优化] 黑板读取透明解包**：当其它 Agent 或流程通过 `get_memory` 抑或 `query_blackboard` 获取数据时，系统在底层会自动追踪并无缝重组位于外部文件的超长文本，同时出于安全拦截的考虑对其附加 3000 字符的软截断，保护上下文完整。

## [2.1.0] - 2026-05-12

### 🤖 多 Agent 编排器 (Orchestrator) 强化与性能优化
- **[重大特性] 编排器进度可视泳道 (Agent Lane UI)**
  - 新增了详细的编排阶段状态同步（`orchestratorProgress` 载荷），使 Chat 面板能够对并发的各个 Agent 显示清晰的运行泳道和状态（pending / running / done）。
- **[架构级重构] 并发状态线程安全隔离**
  - 全新抽象了 `AgentToolContext` 作为每个工具调用的生命周期执行上下文，避免了并发运行子 Agent 时因状态交叉（特别是 token 累计、事件通知流）导致的数据串扰。
  - 引入了强类型共享黑板结构（`Blackboard`），提供线程安全的多 Agent 信息共享与缓存存取，彻底抛弃了易产生读写冲突的旧版全局 Map 内存实现。
- **[性能与稳定性优化]**
  - 将关键调度器入口工具 `dispatch_agents` 的执行超时宽限值由先前的 30 秒暴增至 **10 分钟 (600,000ms)**，全面适配高并发长耗时的深度思考（Reasoning）子模型的挂机调度。
  - 全面清除了 `package.json` 中的泛型全游戏语言加载占位符（遗留 `activationEvents`），改用精确的文件探测绑定机制以**消除扩展的不必要冷启动时间惩罚**。
  - 为协调器追加了全局的任务清单同步回调挂钩（`onTodoUpdate`），令所有下发至子任务的分工事项均能映射回主视图的待办面板。

## [2.0.1] - 2026-05-11

### 🛠️ 预览增强与界面抛光
- **[优化]** `entityPreview.ts` 中的过滤工具按钮启用了原生纯净 CSS 悬停效果控制。
- **[优化]** 进一步重构了 `chatPanel.ts` 的部分特殊步骤标记，将日志中的系统节点渲染改为清爽的颜色加图标方案。
- **[优化]** 支持通过 `cwtools.ai.orchestrator.agentModels` 分配独立覆盖特定子 Agent 任务的推理模型。

## [2.0.0] - 2026-05-09


### 🎉 2.0 重大更新 (Major Release 2.0)
- **[重大特性] 3D 模型与动画可视化体系全面落成**
  - 完成了对游戏底层模型资产（`.asset`、`.mesh`）的深度解析与 WebGL 3D 可视化渲染。
  - 支持骨骼层级解析与**模型动画可视化**播放，提供沉浸式的实体资产预览体验。
- **[架构重构] 彻底解决中文路径与权限导致的“静默瘫痪”漏洞**
  - 弃用不稳定的扩展目录缓存机制，全面迁移 CWTools 缓存至用户专有的 `globalStorage`。
  - 根治了在中文系统用户名或非管理员权限下，因底层 Git 连环抛错导致的“加载秒完成但无任何规则校验”的恶性 Bug。
  - 增强后台的容灾与主动错误预警机制，不再对 I/O 报错进行静默吞咽。


## [1.9.9] - 2026-05-08

### ✨ 新特性 (Features)
- **[新功能] 3D 实体模型可视化预览 (3D Entity Viewer)**
  - 全新支持 Paradox `.asset` 与 `.mesh` 文件的 3D 可视化预览
  - 点击编辑器标题栏的图标即可直接在 Webview 中渲染实体（Entity）及其关联的 Mesh 模型
  - 支持多光源配置、相机漫游、拖拽旋转缩放等 3D 交互功能
  - 内置 PDX Mesh 专用解析器和 Web Worker 异步加载，确保主线程不阻塞

## [1.9.8] - 2026-05-07

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX Improvements)
- **[修复] `inline_script` 深度补全与跳转导航 (Inline Script Completion & Navigation)**
  - 修复了控制流节点（如 `switch` / `if`）导致深层级（如 `trigger` / `desc`）中调用的 `inline_script` 补全类型降级到根级事件的问题。采用 "Best-of-Both" 双轨解析策略，智能应用最深层精准补全。
  - 修复了从一个 `inline_script` 内部调用另一个 `inline_script` 时上下文丢失的问题，新增级联调用栈追溯（Rule Path Chaining）支持无限嵌套深度的规则解析。
  - 修复了所有文件中 Ctrl+Click 点击 `inline_script = { script = path }` 无法跳转到对应脚本文件定义的问题。通过绕过 AST 展开后的空节点，引入文本感知回退策略重构了代码导航锚点映射。

## [1.9.7] - 2026-05-06

### 🛡️ AI 代理核心逻辑加固与安全提权 (Agent Core & Security Escalation)
- **[新特性] 终端执行沙盒提权机制 (Security Sandbox Escalation)**
  - `run_command` 新增 `requestEscalation` 提权申请参数
  - AI 在触发沙盒拦截（如破坏性指令、管道符、越权目录访问）时不会被硬中断，而是可以向用户发起单次高危操作的授权申请
  - 用户确认后即可一次性越过沙盒完成特定操作
- **[修复] 内部文件写入权限释放**
  - 修复了 `write_file` 会被自身创建的缓存文件阻断的问题
  - 现在 AI 可以无缝地对自己在此轮会话中新建的 `.txt` / 代码文件进行完整重写（覆写）而无需回退到 `edit_file`
- **[机制强化] 错误修复防退化协议 (Anti-Simplification Protocol)**
  - 在 Prompt 级的 Error Fix Protocol 中增加强制规定：禁止 AI 以“简化代码结构”为手段来消除报错
  - 要求 AI 必须在现存结构（如 `on_monthly`, `weight_modifier`, `trigger` 等）内部进行精准修复，保持代码的结构深度和完整逻辑功能
- **[优化] 工具执行超时动态提升**
  - 将 `spawn_sub_agents`（子代理解析）的超时提升至 10 分钟
  - 动态注册的 `mcp_call` 及 MCP Server 工具默认超时时长提升至 120 秒，避免长耗时的网路请求/外部调用被过早截断

## [1.9.6] - 2026-05-06

### 🔄 时间线交织修复 (Chronological Interleaving)
- **[P0 修复] 完成消息丢失交织布局**
  - 修复了 AI 输出时正常交织显示（think→text→tool→think→tool→text），但完成后变为分组排列的 Bug
  - 根因：`flushText()` 把中间文本追加到 `content` 变量延迟到底部渲染，而非在当前位置创建 `msg-bubble`
  - 现在完成消息与流式消息保持一致的时间线交织顺序

### 📁 工具文件名保留 (Tool Args Preservation)
- **[修复] tool_result 更新时丢失文件名**
  - 修复了流式渲染中 `tool_result` 回调创建 `fakeCall` 时使用空 `toolArgs: {}` 导致文件名丢失的问题
  - 新方案：将 `toolArgs` 序列化存储到 `data-call-args` 属性中，`tool_result` 到达时反序列化恢复
  - `read_file`、`edit_file` 等工具现在在结果返回后仍能正确显示操作的文件名

### ❓ 问题卡片重设计 (Question Card Redesign)
- **[UI] Claude Code 风格问题决策卡**
  - 问题卡片使用蓝色边框替代金色，配合脉冲动画吸引注意力
  - 新增「⏳ 等待你的选择…」提示标签
  - 选项按钮增大触控区域和 hover 微动画，提升交互反馈
  - 选项描述增加缩进对齐

## [1.9.5] - 2026-05-05

### 🎨 AI 代理 UI/UX 架构重构 (Agent UI Refactoring)
- **[P0 修复] Thinking/text_delta 路由混淆 Bug**
  - 修复了 `text_delta`（最终回复流）被错误路由到 Thinking 折叠块的严重显示 Bug
  - AI 的推理过程与最终回复现在正确分离显示
- **[新架构] 纯函数渲染模块 `messageRenderer.ts`**
  - 从 167KB 的 `chatPanel.ts` 单体中提取 8 个可测试纯函数
  - 新增 54 个单元测试（`messageRenderer.test.ts`），总测试 85 个全部通过
- **[新特性] Claude Code 风格线性工具时间线**
  - 工具执行从折叠式列表改为线性时间线，每步显示 `1. 2. 3.` 编号
  - 实时显示工具执行耗时（45ms / 2.5s / 2m 5s）
  - `edit_file` 工具显示参数摘要（old/new 内容预览）
- **[新特性] 内联 Diff 预览**
  - 工具执行结果中的代码变更直接内联显示（最多 20 行，超出折叠）
  - 绿色高亮新增行、红色高亮删除行，附带行号
- **[新特性] 权限确认内联化**
  - 权限请求按钮（允许/拒绝/始终允许）直接嵌入工具时间线步骤中
  - 使用事件委托模式，无需为每个按钮单独绑定事件
- **[优化] 进度指示元数据**
  - `AgentStep` 新增 `stepIndex`、`durationMs`、`iterationInfo` 字段
  - `agentRunner` 全局计数器跨迭代跟踪工具调用序号
- **[优化] 空间利用**
  - Todo 面板改为折叠式 `<details>` 元素，默认收起
  - 聊天区域间距紧凑化（gap 20→14px, padding 16→12px）

## [1.9.4] - 2026-05-04

### ✨ 新特性 (Features)
- **[新功能] 原版代码智能对比 (Vanilla Code Comparison)**
  - 支持跨平台解析游戏原版文件（通过 `cwtools.cache.*` 路径设定）
  - 引入 CodeLens 内联提示，直观显示代码块与原版的匹配及修改状态
  - 支持块级差异查看（通过 CodeLens 或右键菜单触发单个代码块 Diff）
  - 支持文件级差异查看（自动搜集并组合所有被修改的代码块展开 Diff）
  - 采用 LRU 高速缓存与基于 tokenizer 的花括号深度解析，保障性能与鲁棒性
  - （可选）新增行级 Gutter Decorations 高亮显示

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX)
- **[修复] 原版对比的跨对象错乱匹配 Bug**（通过严格鉴权提取 `id` 和 `name` 属性，彻底消除无 ID 事件导致的错误合并 Diff）

## [1.9.3] - 2026-05-04

### 🐛 Bug 修复与 UI 重构 (Bug Fixes & UI Refactoring)
- **[重构] 全面迁移 UI 图标至 SVG 系统 (Emoji to SVG Migration)**，解决在不同平台与字体下的渲染不一致问题
- **[修复] `guiPanel` 与 `solarSystemPanel` 编辑模式静默失效 (Maximum call stack size exceeded) 的严重漏洞**（修复了因 `_saveSnapshot` 无限递归导致的编辑器崩溃问题）


## [1.9.2] - 2026-05-02

### ✨ AI Agent Skills 管理系统本地化隔离 (Local Agent Skills Isolation)
- **[重构] 本地化技能存储**
- **[新功能] 技能可视化 UI 面板**

## [1.9.1] - 2026-05-02

### ✨ 体验优化 (UX Improvements)
- **[修复] AI 提供商注册引导链接 (Provider Hint)**

## [1.9.0] - 2026-05-02

### 🛡️ AI 补全系统硬核重构 (Completion Architecture Refactor)
- **[安全升级] FIM 能力白名单严格过滤**
- **[架构重组] 抛弃聊天模拟 FIM (Legacy Chat Fallback Removal)**

## [1.8.9] - 2026-05-02

### 🐛 Bug 修复与体验优化 (Bug Fixes & UX Improvements)
- **[修复] Minimax 模型内联补全被误拦截**
- **[优化] 内联补全的错误诊断体验**

## [1.8.8] - 2026-05-02

### 🛡️ AI 代理可靠性与技术债务修复 (Audit Hardening)
- **[修复] Claude SSE Thinking Token 路由错误**
- **[清理] AI 核心工具流代码净化**
- **[优化] 代理资源池配置隔离**
- **[完善] 上下文预算池单元测试**

## [1.8.7] - 2026-04-30

### ✨ 用户体验与性能优化 (UX & Performance)
- **精准的 AI 报错白名单审查机制**
- **智能报错隐匿报告 (Smart Negatives Reversal)**

## [1.8.6] - 2026-04-30

### ✨ 新特性 (Features)
- **行级 Diff 可视化**
- **快速修复与代码解释 (CodeActionProvider)**
- **跨会话持久记忆 (Persistent Memory)**

### 🐛 Bug 修复与清理
- **移除上游遗留流水线**
- **修复 Gitee 同步发布 Bug**

## [1.8.5] - 2026-04-29

### ✨ 新特性 (Features)
- **科技树与事件链全景可视化**
  - **新增科技树可视化（Tech Tree Visualizer）**
  - **事件链系统大成**

### 🐛 Bug 修复与体验优化
- **[重大修复] 星系轨道漂移 Bug**

## [1.8.4] - 2026-04-29

### ✨ 新特性 (Features)
- **强化事件链解析能力**
## [1.8.3] - 2026-04-29

### ✨ 新特性 (Features)
- **新增了事件预览相关内容**
## [1.8.2] — 2026-04-28

### 🐛 Bug 修复与体验优化

- **[修复] 预缓存界面持续挂起 Bug**

## [1.8.1] — 2026-04-28

### ⚡ 性能优化 (Performance)

- **[重大优化] CodeLens 零阻塞零 I/O 预加载**

## [1.8.0] — 2026-04-28

### ⚡ 性能优化与 LSP 增量流 (Performance & LSP Delta)

- **[重大优化] SemanticTokens 增量解析下发 (`full/delta`)**
- **[重大优化] F# 后端无锁安全并发**
- **[系统升级] 自适应智能内存防溢出淘汰策略**
- **[架构级重构] 后端数据驱动流路由**

## [1.7.0] — 2026-04-28

### ✨ 用户体验与稳定性优化 (UX & Stability)

- **[重大优化] Chat 滚动条体验升级**
- **[重大优化] 交互卡片生命周期管束**
- **[安全扩容] 写入工具降级授权**
- **[系统升级] 执行守卫系统提示**

## [1.6.9] — 2026-04-27

### 🤖 多智能体架构加固与原子化事务 (Multi-Agent Concurrency Hardening)

- **[重大更新] 挂载 VFS 事务管理器**
- **[重大更新] VFS 异步互斥锁逻辑**
- **[增强] 子任务自愈机制 (Node-Level Self-Healing)**
- **[新功能] 语义化 Blackboard 内存检索**
- **[修复] `ExternalToolContext` 类型对齐**

## [1.6.8] — 2026-04-27

### 🛡️ 核心工具层隐患排除与体验优化 (Agent Resilience & Quality of Life)

- **[P0 安全] 封禁 `write_file` 覆写越权**
- **[P1 安全] 阻断动态 SSRF 内网穿透**
- **[P1 修复] 毁灭震荡打断 (Doom-Loop)**
- **[优化] 搜寻爆破硬截断机制**
- **[优化] `astMutate` 智能排版融合**
- **[优化] LSP 污染警报器降噪处理**

## 1.6.7
- **架构与修复**
  - 重构了 `AgentRunner` 执行管线，解决由于写入队列错误引发的重复执行和丢失子代理快照的漏洞。
  - 修复 `fileTools.ts` 中的局域文件读取缓存脏污染漏洞，禁止对被指定 `endLine` 裁剪的内容进行错误全局缓存。
  - 在 `promptBuilder.ts` 中恢复了 Paradox Namespace、Entity IDs 的强制压缩保护层，防止因为多轮对话长记忆被遗忘。
  - 下载和更新链接中的镜像代理域名升级为最新的 `gh-proxy.org` 及相关加速网络。

## 1.6.6
  - 通过将服务可释放物绑定到 VSCode 扩展垃圾回收生命周期，消除了 MCP 客户端状态持久性问题，确保在编辑器重新加载时优雅地拆除模型上下文协议。
  - 重新调整了多代理循环的内部调度模式子类型边界，以便正确路由 `build` 命令。

## [1.6.5] — 2026-04-26

### 🛡️ 安全加固与缺陷修复 (Audit Hardening)

- **[P0 修复] `multiEdit` TOCTOU 竞态消除**
- **[P0 修复] 9-Slice Canvas DOM 泄漏**
- **[P1 修复] LSP 超时定时器泄漏**
- **[P1 修复] `retractMessage` 硬编码 `-2` 偏移**
- **[P1 修复] `applyPatch` 快照时机**
- **[P1 修复] `contentToString` 去重**

### ⚡ 性能优化

- **Levenshtein 滚动数组**
- **CJK 自适应 Token 估算**

### 🔧 改进

- **命令安全白名单 (P2-11)**
- **增量验证 (C3)**
- **子代理任务隔离 (C5)**


### 🐛 Bug 修复与体验优化

- **[修复] AI 模型列表界面空白**
- **[修复] AI 设置强制刷新导致的代码冻结**
- **[优化] 模块编译可视化提示**
- **[优化] 版本更新进度条显示**
- **[修复] Token 数据防呆清空阻断**

## [1.6.2] — 2026-04-26

### 🤖 Agentic 2.0 架构升级与新特性

- **[重大升级] 引入 AST Mutator 前端修饰器**
- **[重大升级] 并发子代理 (Sub-Agent Orchestration)**
- **[修复] UI 上下文满血解封 (L9)**
- **[修复] 上下文压缩条显示对齐 (UI)**
- **[优化] 启动规则与更新校验提前**

## [1.6.1] — 2026-04-25

### 🏗️ 架构与维护性优化 (Architecture & Maintainability)

- **[重构] F# LSP 后端多态重构**
- **[重构] AI Agent 调度器拆解**

## [1.6.0] — 2026-04-23

### 🤖 AI Agent — 新功能与深度集成

- **[新功能] 会话 JSON 完整导出/导入 (Feature 1)**
- **[新功能] 多文件 Diff 预览 (Feature 2)**
- **[新功能] MCP (Model Context Protocol) 客户端 (Feature 3)**
- **[增强] Sub-Agent 并行编排 (Feature 4)**
- **[增强] 全项目本地化索引 (Feature 5)**
- **[新功能] Review Mode 代码审查 (Feature 6)**
- **[新功能] 性能监控 Dashboard (Feature 7)**
- **[新功能] 多游戏 AI 知识库与 Prompt 支持**
- **[新功能] 上下文窗口智能化 (Smart Windowing)**
- **[增强] 打字机流式输出体验**
- **[增强] AI 对话全文快速检索引擎**
- **[增强] AI 常用命令全局快捷键**
- **[增强] 子任务 (Sub-Task) 执行进度投屏**
## [1.5.0] — 2026-04-21

### 🔒 LSP 服务端 — 稳定性与并发

- **[修复] Tokenizer CRLF 安全性**
- **[修复] Tokenizer Content-Length 守卫**
- **[修复] LanguageServer 进程队列无界化**
- **[修复] LanguageServer ReaderWriterLockSlim 并发**
- **[修复] LanguageServer 请求 ID 原子递增**
- **[修复] LanguageServer 响应通道泄漏**
- **[修复] Program.fs UNC/符号链接路径**
- **[修复] Program.fs 孤儿命令响应**
- **[修复] Program.fs GC 压力**
- **[性能] DocumentStore O(n)→O(1) 范围查找**

### 🤖 AI Agent — 可靠性与正确性

- **[修复] AbortController 并发安全 (C1)**
- **[修复] 并行 tool_call 索引碰撞 (M1)**
- **[修复] 默认 max_tokens 提升至 8192 (M5)**
- **[新功能] Claude SSE 流式传输 (L4)**
- **[修复] Doom-loop 检测 (M2)**
- **[修复] 最终 API 调用前中止信号检查 (C2)**
- **[修复] `validate_code` 串行执行 (M6)**
- **[修复] 子 Agent token 用量传播 (L8)**
- **[修复] 压缩过滤系统消息 (L3)**
- **[修复] 压缩截断限制 (M4)**
- **[修复] PDXScript 启发式假阳性 (L2)**
- **[修复] Fence 模式去重 (L1)**
- **[修复] `multiedit`/`patch` 纳入写工具集 (L6)**
- **[修复] Claude ContentPart[] 系统提示序列化 (L5)**
- **[修复] 动态 provider 导入移除 (M3)**

### 1.4.0
#### 新功能
* **AI 助手 Agent 架构升级** — 工具栏与 Chat Panel 完成双模式升级与深层 Agent 增强体验：
  - **Build / Plan 双模式**
  - **上下文智能压缩**
  - **任务看板工具 (TodoWrite)**
  - **工作区深层检索**
* **模型与性能体验** — 参数配置面板迎来全面革新：
  - **Ollama 本地接入**
  - **自定义上下文上限**

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
