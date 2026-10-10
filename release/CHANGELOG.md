# Changelog

## [Unreleased]

### PTC 模式移除与 NATIVE 统一 / PTC Mode Removal and Native Unification
- **[架构] 彻底移除 PTC（程序化工具调用）模式（Remove PTC mode）**：
  - PTC 自 v2.20.0 起是默认呈现模式：模型可见面收窄为 `run_code`，其余 90 余个工具收敛为 QuickJS/WASM 沙箱内的能力池。其唯一收益是每轮省下原生工具 Schema 的 token，代价却由宿主长期承担，并持续暴露四类结构性问题：工具结果在进入模型前被 `budgetToolResult` 按键去重与分段裁剪且 `totalMatches` 只统计入列条数、脚本把沙箱不可用等失败当作数据继续执行（`exitCode` 不在失败判据内）、3000 余行自研运行时（`runCode.ts` + 2618 行手写词法类型擦除器）缺陷密度高、`RUN_CODE_BLOCKED_TOOLS` 使 16 个工具在 PTC 下不可达。真正省 token 的机制是与 PTC 无关的动态工具披露，因此 PTC 的边际收益不抵其维护与缺陷成本。
  - 现统一为 **NATIVE 标准函数调用**单一路径：删除 `run_code` 工具与 QuickJS 沙箱、`ToolPresentationMode` 类型及在配置/话题/面板/运行选项上的全部字段、`PTC_DIRECT_TOOLS` 直连拦截与 SDK 提示词注入、`quickjs-emscripten` 依赖及其 5 个传递依赖，净删除约 3000 行。
  - 界面同步协调移除：输入栏的「工具调用模式」触发器与下拉、设置面板的「工具调用模式」三选一、`release/package.json` 的配置贡献项与三个 NLS 文件的词条、PTC 子调用徽标与缩进样式；历史话题里已存的 `run_code` 与子调用行在渲染前被过滤，不再显示。
  - 旧数据安全降级：`readStoredTopic` 是白名单式重建，历史 JSON 中残留的 `"ptc"` / `"hybrid"` 既不报错也不会被写回，下次保存自然消失，无需迁移脚本。
  - English: [Architecture] Remove PTC (Programmatic Tool Calling) entirely and unify on NATIVE standard function calling. PTC was the default since v2.20.0: the model saw only `run_code` while every other tool became a capability pool inside a QuickJS/WASM sandbox. Its only benefit was saving per-turn schema tokens, while it kept producing four structural defects — tool results were deduplicated and segmented by `budgetToolResult` before reaching the model with no true total, scripts treated a missing sandbox backend as data because `exitCode` is not a failure signal, the ~3000-line in-house runtime (including a 2618-line hand-written lexical type eraser) carried a high defect density, and `RUN_CODE_BLOCKED_TOOLS` made 16 tools unreachable. Dynamic tool disclosure is the mechanism that actually saves tokens and it is unrelated to PTC. The codebase now has a single native path: the `run_code` tool, the QuickJS sandbox, the `ToolPresentationMode` type and all its config/topic/panel/runner fields, the direct-call guard, the injected SDK prompt, and the `quickjs-emscripten` dependency tree are gone. The UI is removed in step — composer mode trigger, settings dropdown, the contributed configuration entry with its NLS strings, and the PTC subcall badge/styling — and historical `run_code` steps are filtered out before rendering. Old topics degrade silently: `readStoredTopic` rebuilds by whitelist, so leftover `"ptc"`/`"hybrid"` values neither fail nor get written back.

## [2.28.0] - 2026-10-10

### 原版读取链路修复 / Vanilla Read Path Fixes
- **[修复] PTC 模式提问与原版脚本读取（PTC Questions & Vanilla Reads）**：
  - **PTC 模式下无法提问**：三道闸门同时关掉了 `ask_user_question`——面向模型的工具面收窄到只剩 `run_code`、PTC 直调守卫拒绝其它工具、`RUN_CODE_BLOCKED_TOOLS` 又把它排除在 `run_code` 能力池外。第三道必须保留：该工具等待人类、没有超时，而 `run_code` 有 300 秒预算，塞进程序里会掐断用户的长考。改为把它暴露为第二个直调工具，`PTC_DIRECT_TOOLS` 成为投影与守卫共用的唯一真相来源。
  - **原版文件搜得到读不到**：grep 从 `getConfiguredGameRoots()` 解析自己的根并返回相对路径，而 `read_file` 把相对路径锚在工作区根，绝对根在 `GrepResult` 投影时被丢弃；同时已配置的原版根只下发给委派的子代理，主 Agent 只能猜盘符然后收到 ENOENT。这从来不是沙箱拒绝——`resolveReadablePathInput` 接受任何可读本地路径。现在原版命中返回绝对路径并附上扫描根，主 Agent 的提示词也会陈述由 cwtools 自己解析出的根。
  - English: [Fix] PTC user questions and vanilla read paths. `ask_user_question` was unreachable in PTC mode (the default) because three independent gates each closed it; the `run_code` exclusion must stay (a human wait has no timeout while `run_code` has a 300s budget), so it is now a second direct-call tool with `PTC_DIRECT_TOOLS` as the single source of truth. Separately, vanilla files could be searched but never read: grep returned paths relative to roots that `read_file` does not anchor to, and the configured game roots reached delegated children only. Vanilla matches now carry absolute paths plus the scanned roots, and the main agent prompt states the roots cwtools itself resolved. This was never a sandbox refusal.

### 设置页草稿保护 / Settings Draft Preservation
- **[修复] 登录刷新不再重置未保存的设置草稿（Draft-Safe Repaint）**：
  - 为订阅线路登录时，设置页会退回已保存的供应商：负责重绘的签名把账号状态和表单输入混在一起，因此一次只改账号状态的推送也会用 `current` 重建整个表单，把供应商下拉、Endpoint、模型、上下文窗口与推理档位一起冲掉。
  - 现在把「重建表单」与「重绘账号卡」拆开：`keepDraft` 在一处判定（`!reloadForm && !settingsSavePending && settingsHasUnsavedDraft()`）并在写入任何字段前短路，草稿、字段值与未保存基线一并保留；只重绘账号卡，且按当前选中的线路绘制而非已保存的线路。
  - 同时修掉同一渲染路径上的两个相邻缺陷：内联补全供应商把 `current.inlineCompletion?.provider` 与 `''` 比较，导致「- 与对话相同 -」永远选不中；页面的显示/隐藏逻辑原本重复在两处，现由 `presentSettingsPage` 共用。
  - English: [Fix] Keep the settings draft when a sign-in refresh repaints. The re-render signature mixed account state with the form's own inputs, so a push that changed only account state rebuilt the whole form from `current` — resetting the provider, endpoint, model, context window and reasoning effort together. The form rebuild is now split from the account repaint, with `keepDraft` decided in one place and short-circuiting before any field is written. Two adjacent defects are fixed with it: "- Same as chat -" could never be selected for inline completion, and the page's show/hide was duplicated across two call sites.

### WorkBuddy 离线模型表与推理档位 / WorkBuddy Offline Catalog & Reasoning Depth
- **[特性] 登录前即可选择模型、并暴露推理深度（Offline Model Table & Thinking Depth）**：
  - **模型列表为空**：此前 `defaultModel: ''` 且 `models: []`，设置页又把网关上实时拉取的 `/v3/config` 目录当成唯一来源，于是网关不可达或尚无凭据时下拉框空空如也。新增随包发出的离线表（网关目录逐字转录：30 个国区、25 个国际区、8 个共享，共 47 个唯一 id），并让每次查找都「实时缓存优先、离线表兜底」。
  - **区域语义**：无区域信息时返回两区并集（两区列表并非嵌套）；凭据给出区域后按区过滤——向一个不提供该模型的区域请求会返回 400 code 11102。
  - **推理深度被隐藏**：`getModelReasoningCapability` 没有 workbuddy-subscription 分支，回落到 `NO_REASONING`，Webview 据此渲染成 `display:none`。新增分支复用与请求路径相同的解析器，保证卡片与请求对某一档位的判断永远一致；只有网关声明可跳过思考的模型才提供 `none`，非推理模型仍然不显示控件。
  - **两处实测陷阱**：13 条随包条目在自己的 low/high/max 阶梯之外声明了 `medium` 默认值，因此在读取时收敛默认值（不收敛就发送会丢掉该字段，网关随即返回空的 `reasoning_content`）；两个来源都不认识的 id 现在返回 `undefined`，而不是把一个未经验证的档位放行。
  - English: [Feature] WorkBuddy offline model table and reasoning depth. The dropdown was empty before sign-in because the shipped provider had no models and the settings page treated the live gateway catalog as its only source; a verbatim transcription of that catalog (47 unique ids) now backs every lookup as a fallback. A region-less lookup yields the two-region union, and once a credential names the region the list is filtered, since asking a region for a model it does not serve answers 400 code 11102. The thinking-depth control was hidden because the capability resolver had no branch for this line and fell through to `NO_REASONING`; it now shares the request path's resolver, so the card and the request can never disagree. Two measured traps are handled rather than transcribed away: 13 entries declare a `medium` default outside their own ladder (converged at read time, since sending it unconverged drops the field), and an unknown id now returns `undefined` instead of passing an unvalidated level through.

### 引擎成本与规则锚定 / Engine Cost & Rule Anchoring
- **[修复] 成本注解重新锚定到 4.5.2 dump 并防止被规则同步冲掉（Re-anchored With Line Evidence）**：
  - `extract-engine-cost.cjs` 现在记录证据函数所在的签名行，每条断言都能在 dump 里打开核对，而不是按类名取信。
  - 新增 `merge-engine-cost.cjs` 作为 `## cost:` 的唯一写入方：逐命令比较，当提取器更粗糙时保留人工维护值（提取器能证明是循环，但分不清「全银河扫描」与「只扫描作用域对象的容器」）。
  - 子模块提升到重新锚定后的规则（1,224 条注解带行级证据）；新增回归测试锁定精选基线，让未来的日志 dump 大声失败而不是静默漂移。
  - English: [Fix] Re-anchor cost annotations to the 4.5.2 dump with line evidence. `extract-engine-cost.cjs` now records the evidence function's signature line so each claim can be opened in the dump instead of trusted by class name, and the new `merge-engine-cost.cjs` is the only writer for `## cost:`, keeping the maintained value whenever the extractor is coarser. The submodule is bumped to 1,224 re-anchored annotations, and a new regression test pins the curated baseline so a future log dump fails loudly. Also removes a one-off `test-server-initialize.cjs` probe and wires the perf tool tests into `test:perf`, which were never in any suite.

### 文档 / Documentation
- **[文档] Stellaris 战斗伤害结算文档（Combat Damage Resolution）**：新增 `docs/better_stellaris/16_combat_damage_resolution.md`（1,047 行）并接入文档索引。
  - English: [Docs] Add the combat damage resolution reference for Stellaris and link it from the documentation index.

### AI 设置保存健壮性 / AI Settings Save Resilience
- **[修复] 单个未注册配置项不再中断整次保存（Per-Key Configuration Writes）**：
  - **解决什么**：Linux 用户点「保存设置」后只看到输出通道里的 `Error handling webview message 'saveSettings'`，既没有「设置已保存」，其余设置也没有落盘，设置页卡在「正在保存…」。根因是保存流程由四十余次直写串成且没有 try：VS Code 只接受**已注册**的配置键写入，未注册的键会抛 `ERROR_UNKNOWN_KEY`，于是一行失败就带走了整次保存。
  - **补上缺失的注册**：`stellarisLanguageServices.ai.reasoningKey`（推理字段名覆盖，此前界面可改却写不进 `settings.json`）与 `stellarisLanguageServices.ai.endpoint`（历史单端点键的清理壳）此前未在扩展清单中声明，现已注册并补齐中英三份本地化描述。
  - **逐键容错**：每条配置写入各自 try/catch，失败只跳过该键并在输出通道点名报出，其余设置照常保存、成功提示照常给出。
  - **SecretStorage 写入刻意不吞**：钥匙串真的拒绝写入 API Key 时保存仍然中止——不能让用户以为供应商已经配置好。
  - English: [Fix] Per-key AI configuration writes. Saving settings used to be one un-guarded chain of `workspace.getConfiguration().update()` calls, so a single unregistered key (`ai.reasoningKey`, `ai.endpoint`) threw VS Code's `ERROR_UNKNOWN_KEY` and aborted the whole save — no success notification, no persisted settings, and a settings page stuck on "Saving…". Both keys are now registered with English and Chinese descriptions, every configuration write is individually guarded and reports the offending key in the output channel, and only the SecretStorage write for the API key is still allowed to abort the save so a keyring failure can never look like success.

## [2.27.0] - 2026-10-08

### Steam 创意工坊上传文件过滤 / Steam Workshop Upload File Filtering
- **[特性] 按忽略规则过滤上传内容（Ignore-Aware Upload Filtering）**：
  - **解决什么**：此前上传会把 Mod 文件夹里的每个文件一并交给 Steam——包括 `.git` 对象库、编辑器目录和构建产物，导致工坊物品体积虚胖甚至超出 Steam 限制。
  - **为何不能交给 Steam**：Steam 的内容接口只接受目录、没有逐文件过滤参数，也不读取任何忽略文件，因此过滤必须在扩展侧完成：先按忽略规则生成一份暂存副本，再把副本目录交给 Steam。
  - **gitignore 语义**：Mod 自带的 `.gitignore` 与 `.steamignore` 按 git 自身规则生效，支持否定规则（`!keep.log`）与按目录作用域（子目录的 `.steamignore` 只影响自身所在目录）。版本控制与编辑器元数据（`.git`、`.github`、`.vscode`、`.idea` 等）始终排除。
  - **零拷贝快路径**：没有任何内容需要排除时直接上传原目录，完全不做拷贝——无忽略文件的 Mod 行为与成本与该功能存在前完全一致。
  - **可见与可控**：上传结果报告实际上传与排除的数量；符号链接等无法逐字复制的条目会被跳过并在结果中列出，而非静默损坏。暂存副本在上传结束、失败或取消后必定清理。
  - **新设置项**：`workshop.useIgnoreFiles`（默认开启）与 `workshop.extraIgnorePatterns`（补充构建产物等忽略文件未覆盖的规则）。
  - English: [Feature] Ignore-aware Workshop upload filtering. Steam's content API only accepts a directory and applies no filtering of its own, so the extension now builds a filtered staging copy first. The mod's `.gitignore` and `.steamignore` are honoured with git semantics, including negation and per-directory scoping, and VCS/editor metadata (`.git`, `.github`, `.vscode`, `.idea`) is always excluded. A mod with nothing to exclude is uploaded directly with no copy at all. The result reports how many files were uploaded and excluded, symlinks are skipped and surfaced rather than silently corrupted, and the staging copy is always cleaned up. Adds `workshop.useIgnoreFiles` (on by default) and `workshop.extraIgnorePatterns`.

### 代码清理 / Code Cleanup
- **[工程] 移除未使用的文件与目录结构整理（Unused File Removal）**：清理仓库中未被引用的冗余文件。
  - English: [Chore] Remove unused files and tidy up directory structure.

## [2.26.0] - 2026-10-07

### Steam 创意工坊 Mod 上传 / Steam Workshop Mod Upload
- **[特性] 扩展内创意工坊直传面板（In-Extension Workshop Upload Panel）**：
  - **解决什么**：此前 Mod 创作者新建或更新工坊物品必须依赖外部工具或官方启动器，扩展内仅具备工坊路径感知能力，缺乏直接发布的闭环。
  - **全流程集成**：集成 `steamworks.js` 原生 SDK（Node-API 稳定绑定），提供独立的侧边栏上传视图（活动栏专属容器 `cwtools-workshop-panel`）与命令面板入口（`cwtools.workshop.upload`）。支持创建新工坊条目或更新既有条目，涵盖标题、描述、可见性、标签集、更新说明及内容目录的完整发布。
  - **双向同步与智能预填**：更新已有条目时通过 Steam UGC API 读回工坊上的实时长文本描述并预填表单；首次创建成功后自动将新分配的 `remote_file_id` 原子回写至 `descriptor.mod`。
  - **上传状态与可靠性保障**：支持详细阶段划分（配置就绪、内容预备、内容上传、缩略图上传、最终提交）与字节级传输进度百分比，具备进程内单飞行互斥与错误码语义化解析，且通过按需懒加载（Lazy Require）确保原生库不影响扩展常规激活性能。
  - English: [Feature] In-extension Steam Workshop upload panel. Mod authors can now create and update Steam Workshop items directly within VS Code without switching to external tools. Powered by `steamworks.js` (Node-API bindings), the new dedicated sidebar panel and `cwtools.workshop.upload` command support editing titles, descriptions, visibility, tags, change notes, and content folders. Existing items automatically prefill with their current Steam description via UGC APIs, and newly created item IDs are atomically written back to `descriptor.mod`. Features multi-stage progress reporting (configuration, content preparation, content upload, preview upload, and committing) with single-flight mutex protection and lazy-loaded native bindings.

### 底层 CWTools 引擎与 CLI / CWTools Core & CLI Fixes
- **[修复] CLI 解析与列表子命令输出（CLI Parse & List Subcommands）**：
  - 将 CLI `parse` 子命令正确接入 `CKParser`，修复此前命令未触发实际解析的问题；
  - 调整 `list` 子命令的输出管道，确保其扫描到的文件清单与条目能够被调用方完整捕获与观测。
  - English: [Fix] CLI parse and list subcommands. Wires the `parse` CLI subcommand into `CKParser` for actual file parsing, and fixes the output stream of the `list` subcommand to ensure scanned files and entries are fully observable.
- **[工程] 子模块构建与元数据对齐（Submodule Build & Metadata Alignment）**：
  - 将 `cwtools` 子模块的发布流水线对齐至 `.NET 10` SDK，消除版本漂移引起的构建中断；
  - 修复 LF 换行格式下测试 fixture 的解析兼容性；
  - 同步 fork 仓库相关元数据与文档说明。
  - English: [Chore] Submodule build and metadata alignment. Updates the `cwtools` submodule release workflow to `.NET 10` SDK, resolves LF line-ending test fixture parsing differences, and aligns fork repository metadata and documentation.

## [2.25.0] - 2026-10-06

### AI 订阅账号池与供应商扩展 / Subscription Account Pools & Provider Expansion
- **[特性] 多账号订阅账号池（Multi-Account Subscription Pools）**：
  - **解决什么**：此前每条订阅线路只认一个登录账号，凭据一旦 401 / 429 就只能干等冷却；而且**登录按钮在已有账号后被隐藏**，第二个账号根本无从添加——恰好只有 WorkBuddy 与 MiniMax 两条线保留着按钮，也恰好只有它们能加第二个账号。
  - **统一内核**：新增与供应商无关的账号池内核与共享 OAuth 凭据工厂，所有线路共用一套**轮换、冷却与账号保留**规则：顺序 / 轮询 / 粘性三种调度策略、429 冷却故障转移、401 强制刷新、凭据吊销后停用账号、桌面账号幂等入池，并在设置中提供策略、主账号、冷却时长与移除项。
  - **第二个账号可达**：所有线路的登录按钮保持可用并改标为「添加另一个账号」；Codex 登录也正式注册入池（此前是唯一未注册的线路）；同一凭据槽上的两个 provider id 共享同一池实例，不再用两份文档抢一个存储。
  - English: [Feature] Multi-account subscription pools. Every subscription line now runs on one provider-agnostic pool kernel plus a shared OAuth credential factory, so rotation, cooldown and account-retention rules are identical everywhere: sequential / round-robin / sticky scheduling, 429 cooldown failover, 401 forced refresh, parking a revoked account, idempotent desktop-account seeding, and settings for strategy, primary account, cooldown and removal. The sign-in control stays visible and is relabelled "add another account" — previously every line hid it once an account existed, which is exactly why only WorkBuddy and MiniMax could add a second one — and Codex sign-in now registers into its pool (it was the only line that did not).
- **[特性] 订阅线路大幅扩展（Subscription Provider Expansion）**：
  - **claude-subscription（新增）**：Claude Pro/Max OAuth 登录、逐模型思考形态、必需的 Claude Code 身份头、独立 PKCE 状态。
  - **workbuddy-subscription（新增）**：仅流式、前置 system prompt、分区域凭据、`/v3/config` 模型目录、桌面凭据扫描与原子回写；模型下拉现由网关目录填充（此前目录只被用来取上下文窗口）。
  - **minimax-code（新增）**：Anthropic Messages + 仅 Bearer 鉴权、内置模型目录（其 `/v1/models` 不对订阅流量开放）、三态思考；**默认模型改为 M3.1 Flash**，供应商上下文上限随之跟进。
  - **commandcode（增强）**：浏览器 OAuth（loopback 回调）、实时模型目录，以及按**精确模型 id**（而非名称）转录的能力表（图像支持与思考阶梯）。
  - **codex-chatgpt（增强）**：真实模型目录（实时列表 + 快照）、`x-codex-turn-state` 续接、按目录决定 verbosity，默认不再发送 reasoning summary，GPT-6 系上下文拆分，新增 `openai-beta` 请求头。
  - **kimi-code-plan（增强）**：RFC 8628 设备码登录、令牌生命周期、K3 保留思考；**模型列表与上下文窗口改为读实时目录**（按实际请求所用的账号取键，因为该目录按账号划分），并补上此前遗漏、但服务端真实提供的 **k3-256k**。
  - English: [Feature] New and expanded subscription lines: **claude-subscription** (Claude Pro/Max OAuth, per-model thinking forms, the mandatory Claude Code identity header, independent PKCE state), **workbuddy-subscription** (stream-only, leading system prompt, regional credentials, the `/v3/config` catalog, desktop credential scan with atomic write-back), **minimax-code** (Anthropic Messages with bearer-only auth, a hardcoded catalog because its `/v1/models` route is not open to subscription traffic, three-state thinking, now defaulting to M3.1 Flash), **commandcode** (browser OAuth over a loopback callback, a live catalog, and a capability table transcribed by exact model id rather than name), **codex-chatgpt** (real catalog with live listing plus snapshot, `x-codex-turn-state` continuation, catalog-driven verbosity, GPT-6 context split, `openai-beta` header), and **kimi-code-plan** (RFC 8628 device-code sign-in, token lifecycle, K3 preserved thinking, a live catalog read as the authority on both the model list and each window, and the previously unreachable k3-256k).
- **[特性] 每账号配额展示与 WorkBuddy 每日签到（Per-Account Quota & WorkBuddy Check-In）**：
  - **解决什么**：配额此前**完全没有渲染**——WorkBuddy 的配额元素存在却无人写入，任何池行都不带用量。用户只能看到「登录了」，看不到「还剩多少」。
  - **各线路在自身行下展示本线路各账号的额度**，端点取自参考实现的实测结果：WorkBuddy billing/meter、Kimi coding 主机上的 `/v1/usages`、Claude `/api/oauth/usage`（返回百分比，与同名的 0-1 头不同）、Codex 与 Command Code 复用账号状态、MiniMax `coding_plan/remains`（只带 Bearer——官方客户端的第一方归因头不是我们该伪造的）。**只有分子没有分母的计量按陈述值绘制**，而不是编造一个比例。
  - **配额是呈现而非路由状态**：不写入池文档，区块上屏后按需读取一次、按账号缓存；读取失败只让该行没有数字，而不是停用账号。
  - **WorkBuddy 每日签到已实现并接线**：请求契约、幂等调度器、原子日状态存储，以及卡片上的一行与手动运行入口。按设计**仅限中国区账号**——国际账号没有可领取的活动。
  - English: [Feature] Per-account quota and the WorkBuddy daily check-in. Quota was never rendered, so a signed-in account gave no hint of what remained; each line now draws its own accounts' allowance under its row. Quota is presentation, not routing state: it is absent from the pool document, read once when the section is on screen, cached per account, and a failed read leaves that row without numbers rather than parking the account. Endpoints are the ones the reference implementation measured, and a meter that reports an amount with no denominator is drawn as a stated value instead of an invented fraction. The WorkBuddy check-in ships with its request contract, an idempotent scheduler, an atomic day-state store, and a card row with a manual run; it is CN-only by design, because an international account has no activity to claim.

### AI 账号身份、轮换与登录可达性修复 / Account Identity, Rotation & Sign-In Reachability Fixes
- **[修复] 账号池区块此前对多条线路不可见或张冠李戴（Account Pool Section Fixes）**：
  - **入池种子只扫描桌面凭据文件**，于是插件托管的登录读出来是个空池：卡片显示已登录，池区块却把自己藏了，账号从未进入调度。WorkBuddy 与 MiniMax Code 现在同时从两个来源入池，按身份合并，重复登录仍只更新同一行。
  - **载荷只带已保存 provider 的池**，不保存就切换下拉框时屏幕上仍是上一条线路的账号；现在所有线路的池一起下发，区块跟随所选值。**池操作作用于已保存的 provider 而非正在查看的线路**，编辑草稿会改动另一条线路的池。**区块在 Codex 分支的提前 return 之后渲染**，对 Codex 完全不可达——四处独立缺陷全部修复。
  - English: [Fix] The account-pool section had four independent defects. Seeds scanned only the desktop credential files, so a plugin-managed sign-in read as an empty pool — the card showed the account while the pool hid itself and the account was never scheduled; WorkBuddy and MiniMax Code now seed from both sources, merged by identity. The payload carried only the saved provider's pool, so switching the dropdown without saving left the previous line's accounts on screen. Pool actions acted on the saved provider rather than the line being viewed. And the section was rendered after the Codex branch's early return, making it unreachable for Codex.
- **[修复] 账号身份判定与轮换竞态（Account Identity & Rotation Races）**：
  - **WorkBuddy 身份改从访问令牌的 `sub` claim 解析**，在解析凭据时完成、早于任何账号键计算。账号接口只是尽力而为的请求，拿不到它的凭据此前会退化成显示名，把同一账号存成两行。
  - **MiniMax 刷新令牌是单次使用的**：边界上的并发轮次各自消耗一次，除首个外全部拿到 `invalid_grant`，读起来像账号被吊销而实际只是一次竞态。轮换现按令牌单飞，拒绝则记为墓碑而不是立即重试。
  - **统一的失败分类驱动所有池化线路的轮换**：死凭据停用账号，账号级限额按计费周期尺度冷却，无法归因的 429 保持全局（否则对着它轮换会把整个池烧掉）。Claude 线路此前**完全没有**账号级处理。
  - **同一账号两次登录写出两行**：给托管凭据加身份键只能阻止**新增**重复，已经写成两行的文档原封不动；内核现在在读取时按去重键折叠行——主标记移到幸存行，指向被丢弃行的粘性指针被清理——旧文档在下一次写入时自愈。
  - English: [Fix] Account identity and rotation. WorkBuddy identity now comes from the access token's `sub` claim, resolved as the credential is parsed and before any account key is computed; the account endpoint is only a best-effort request, so a credential without it previously fell back to a display name and the same account was stored twice. MiniMax's refresh token is single-use, so concurrent turns at the boundary each spent it and all but the first got `invalid_grant` — which reads as a revoked account after what was really a race; rotations are now single-flighted per token and a refusal is a tombstone instead of an immediate retry. One shared failure classification now drives rotation for every pooled line: a dead credential parks the account, an account-scoped limit cools it for a billing-cycle scale, and an unlabelled 429 stays global; the Claude route previously had no account-scoped handling at all. Finally, giving the managed credential an identity key only stops NEW duplicates, so the kernel now collapses rows that share a dedupe key on read and a stale document repairs itself on the next write.
- **[修复] 各线路登录与传输细节（Provider Sign-In & Transport Details）**：
  - **Kimi 的 OAuth 主机按区域区分，而登录被钉在中国大陆那台**，全球区账号根本无法授权；区域现为每次登录的参数，卡片上配有选择器。
  - **WorkBuddy 身份头现带 `accept: application/json`**，因为目录读取是普通 JSON GET；把它们合并到流式请求上是向一个正在流式返回正文的网关索要 JSON。
  - **Codex loopback 回调服务器此前只用 `close()` 拆除**，闲置的 keep-alive 套接字仍挂着；添加第二个账号要重绑 1455 端口，可能以 EADDRINUSE 失败——现在持有中的套接字随服务器一起释放。
  - **Kimi 账号身份改从令牌 claims 读取**（该 API 无档案接口），此前每次重新登录都新建一行只有「Account N」的池行。
  - English: [Fix] Provider sign-in and transport details. Kimi's OAuth host is per region but the sign-in was pinned to the mainland one, so a global account could not be authorized at all; the region is now a per-login argument with a selector on the card. The WorkBuddy identity headers now carry `accept: application/json` because the catalog read is a plain JSON GET. The Codex loopback callback server releases held keep-alive sockets instead of tearing down with `close()` alone, so adding a second account can no longer fail with EADDRINUSE on port 1455. Kimi account identity comes from the token's claims, since this API has no profile endpoint.

### AI 请求健壮性与参考实现对齐 / AI Request Robustness & Reference Parity
- **[修复] 参考实现逐项对齐审计的 12 项硬失败（Twelve Hard Failures from the Parity Audit）**：
  - **Claude 订阅**：自适应思考形态从不携带 `block_binding`，尽管条目已声明该模型把思考绑定到前缀；一旦压缩、工具列表变更或图片卸载改动了这段前缀，opus-5-5 在每次重试上都回 400。
  - **Command Code**：`max_completion_tokens` 从未发送，该线路上每个 GPT 系模型都因沿用旧字段而 400。
  - **Kimi**：计划声称已完成的 2 MB 请求体保护**根本不存在**；k3 按 1M 预算而计划权益是 256K（越界后服务端回 401）；Kimi 自己的溢出措辞未被识别，溢出变成失败而不是触发压缩；并且在拒绝 `temperature` 的路由上强传显式温度，每轮白白多一次必然 400 的往返。
  - **MiniMax**：声明的刷新余量从未作用于账号池，且该线路没有 401 刷新重放，一小时的令牌边界直接让这一轮失败而不是轮换。
  - **WorkBuddy**：被拒绝的刷新现在携带状态，账号池得以停用该账号；该线路终于请求 usage trailer——此前完全没有令牌计量。
  - **Codex**：新增线级守卫，把 GPT-6 系被拒绝的思考档位映射到该族下限。
  - **潜在工具调用 bug**：工具名用 `+=` 累积，网关在后续 delta 中重复它时就会产出匹配不到任何工具、因而永不派发的名字。
  - English: [Fix] Twelve findings from a feature-by-feature audit against the reference implementation - each requiring a real file:line on both sides - are fixed. Claude's adaptive thinking form never carried `block_binding` although the entry declares the model binds thinking to the prefix, so once compaction, a tool-list change or an image offload edited that prefix opus-5-5 answered 400 on every retry. Command Code never sent `max_completion_tokens`, 400-ing every GPT-family model on that line. Kimi's 2 MB body guard did not exist at all, k3 was budgeted at 1M against a 256K entitlement (401 past it), Kimi's own overflow wording was unrecognised so an overflow failed instead of compacting, and an explicit `temperature` was forced onto a route that rejects it. MiniMax's declared pre-expiry refresh margin was never applied to the pool and the line had no 401 refresh-and-replay. WorkBuddy's rejected refresh now carries its status so the pool can park the account, and the line finally asks for a usage trailer. Codex maps a rejected GPT-6 effort rung onto the family floor. Also fixes a latent tool-call bug where the name was accumulated with `+=`, so a gateway repeating it in a later delta produced a name that matched no tool and never dispatched.
- **[修复] 分线路的图片预算、缓存断点与出站文本（Per-Line Image Budgets, Cache Breakpoints & Outbound Text）**：
  - 图片预算改为**按线路分别计算**：Anthropic 8 MB 并带 8000px / 超 20 张后 2000px 的长边规则，Kimi 1.5 MB（其请求体上限 2 MB），Antigravity 12 MB。**长边规则最关键**：历史会保留每一张图片，会话一旦越过收紧后的线，此后每一轮都是本地无法恢复的 400。
  - **Claude 缓存断点移到最后一个 user 轮**：放在倒数第二个时，它会在下一轮变成最后一个，整段历史被当作全新输入重新计费——命中率归零而界面毫无异常。
  - **出站文本被清洗**：一个 NUL 或一个孤立代理字符会让整个请求体成为非法 JSON，而孤立代理字符还会留在历史里，于是之后每一次请求都以同样方式失败。
  - English: [Fix] Image budgets are now per line - Anthropic 8 MB with the 8000px/2000px-past-20-images long-edge rule, Kimi 1.5 MB against its 2 MB body, Antigravity 12 MB - and the long-edge rule matters most because history keeps every image, so a session that crosses the tightened line becomes permanently unrequestable. The Claude cache breakpoint moved onto the LAST user turn: on the second-to-last it becomes the last next round, and that whole span of history is re-billed as fresh input with a zero hit rate and nothing visibly wrong. Outbound text is sanitized, because a NUL or a lone surrogate makes the whole body invalid JSON and - for the surrogate - stays in history, so every later request fails the same way.
- **[修复] 缓存标记、终帧用量、停止原因与思考预算（Cache Markers, Terminal Usage, Stop Reasons, Thinking Budgets）**：
  - **MiniMax 此前完全没有提示缓存标记**：断点供应商集合被声明却从未被读取，没有任何分支回应它——在该端点上标记是产生缓存命中的**唯一**途径。死集合已删除，每个成员现在都有显式分支。
  - **Anthropic 终帧现在携带完整用量计数**而非只有 `output_tokens`：若干部署在 `message_start` 发送清零用量、真实数字放在 `message_delta`，只读开始事件会让每轮都报约 0 令牌并误判压缩规模；`output_tokens` 是替换而非累加。
  - **拒绝或上下文超限的一轮不再报成干净的停止**：干净停止会把这一轮当作成功收尾，若旁边有 `tool_use` 还会执行被拒绝那一轮的工具调用；上下文超限现映射为 length 以便压缩恢复。
  - **思考预算落在 `max_tokens` 之内**而不是超出它；MiniMax 强制思考模型获得实测的 512 令牌下限——低于它服务端只返回思考块而没有正文。Claude 订阅的思考请求 `display: summarized`，避免令牌照计而思考界面空白。
  - English: [Fix] MiniMax had no prompt-cache markers at all - the breakpoint provider set was declared and never read, so no branch answered for it, and on that endpoint markers are the only thing that creates a cache hit. The Anthropic terminal frame now carries the usage counters rather than just `output_tokens`: several deployments send a zero-filled usage on `message_start` and the real numbers in `message_delta`, so reading only the start event reported ~0 tokens every turn and mis-sized compaction. A refusal or a context-exceeded turn no longer reports as a clean stop, which would end the turn as if it worked and - beside a `tool_use` - run the refused turn's tool calls; the context-exceeded case maps to length so compaction can recover it. Thinking budgets now fit inside `max_tokens`, MiniMax's forced-thinking models get the measured 512-token floor, and Claude subscription thinking requests `display: summarized` so the thinking UI is not silently empty while the tokens are billed.
- **[修复] Codex 模型目录只剩审查 slug（Codex Review-Only Catalog Fix）**：
  - Codex 选择器此前**只有一个模型** `codex-auto-review`，那是代码审查 slug，永远无法回答对话轮。目录接受任意 slug，而「非空列表优先」的规则让一份纯审查列表占据了整个选择器。审查 slug 现已排除；一份**无法回答选择器**的列表也不再被当作账号可调用范围的缩窄视图——改用内置表兜底，读取失败仍保留内置表而不是清空选择器。
  - English: [Fix] The Codex picker offered exactly one model, `codex-auto-review`, which is a code-review slug and can never answer a chat turn. The catalog accepted every slug and the "non-empty listing wins" rule made a review-only listing the whole picker. Review slugs are now excluded, and a listing that cannot answer the picker is not a narrower view of what the account may call - the shipped table answers instead, while a failed read keeps that table rather than emptying the picker.

### 规则同步工具与内置规则 / Rules-Sync Tooling & Bundled Rules
- **[特性] 规则同步的作用域契约提取与报告（Scope Contract Extraction & Reporting）**：
  - **相对从句不再被误判为所有权**：`starbase that changed controller` 这类注释此前会因从句里的「controller」被判成 `country`，产生假不一致；现在先按中心名词解析作用域，多态作用域（`planet|ship`、`astral_rift|planet` 等）也不再因为描述以第一个类型开头就被选成那个类型。
  - **跨行字符串被正确识别**：PDX 字符串可以跨行（`inline_script TRIGGER = "owner = {\n...}"`），逐行扫描的字段统计此前把字符串内容当成键；现在引号状态在行间传递，且只在未加引号的 token 里遇到游离撇号时才继续截断。报告与字段级统计的入口同时导出以便回归测试。
  - English: [Feature] Scope-contract extraction and reporting for the rules sync. A relative clause now resolves against its head noun, so `starbase that changed controller` is no longer read as `country` from the ownership word inside the clause, and a polymorphic contract is not selected merely because the description starts with the first type. Multi-line PDX strings (`inline_script TRIGGER = "owner = {\n...}"`) are handled by carrying the open-quote state between lines, so string content is never counted as a field key, while a stray apostrophe in an unquoted token does not swallow the rest of the file. The report and field-scan entry points are exported for regression coverage.
- **[维护] 内置规则与子模块同步（Bundled Rules & Submodule Sync）**：
  - 同步 `submodules/cwtools-stellaris-config`（Stellaris 规则数据）与 `submodules/cwtools-mcp`（只读 MCP 服务器）子模块指针。
  - English: [Maintenance] Synced the `cwtools-stellaris-config` (Stellaris rules data) and `cwtools-mcp` (read-only MCP server) submodule pointers.

## [2.24.0] - 2026-09-30

### 引擎事实驱动的性能反模式静态检查（CW279-CW289）/ Engine-Fact-Driven Performance Anti-Pattern Lint
- **[特性] 新增 11 条引擎事实驱动的脚本性能诊断（Engine-Fact-Driven Performance Diagnostics）**：
  - **解决什么**：2.23.0 标注了每条命令的引擎开销，但**标注只是知识**——引擎对「哪些写法真的会掉帧」的反常识行为仍完全不可见：岗位重排 effect 在循环内同步重跑整星球分配、`create_country` 在循环内同步联络全银河并重建数据库数组、权重块里的 `factor = 0` 根本不会提前退出、高频块里没加 `?` 的作用域跳转失效时会把整个作用域序列化进错误日志。
  - **CW279 高频块中的高开销命令 / CW280 带 modifier 块的 MTTH**：把「全银河级开销」（`o(n)_galaxy` / `o(n^2)` / `combat` / 新增的 `script_eval` 沉重求值类）落进引擎高频求值的位置——岗位 `weight`/`possible`、决议 `potential`/`allow`、宣战理由 `potential`、建筑/区段 triggered modifier、`mean_time_to_happen` 的 modifier 块，并**新增** `pop_faction_types`、`edicts`、`special_projects`、`situations`、`archaeological_site_types`、`technology`、`colony_automation`、`game_rules` 八个高频宿主。
  - **CW282 循环内岗位同步 effect / CW283 循环内 `create_country`**：新增 `## sync_effect` 规则通道（`pop_jobs` / `heavy`），后端只做分类与匹配。**事实住规则文件**，新增或调整副作用标注无需改代码、无需发版。两层及以上嵌套循环内的 `create_country` 会升级为 **Warning**。
  - **CW284 嵌套作用域迭代 / CW285 权重块 `factor = 0` 不短路 / CW286 循环内跨作用域读变量 / CW287 重复链式作用域跳转 / CW288 高频上下文未加 `?` 的作用域切换 / CW289 `inline_script` 高复用次数**：分别对应 $O(N^2)$ 嵌套迭代、硬性排除写错块、每次迭代深拷贝事件作用域、重复构造 1.8KB 栈帧、失效作用域刷错误日志、每个调用点重复复制并重解析整棵 AST。
  - **分级克制**：性能类一律 Information，次要风险 Warning，**不设 Error**——强阻断日常编写；`create_country` 单层循环为 Information，仅深层嵌套升级为 Warning；`inline_script` 复用阈值取 20 而非 5，因为十余次模板复用在正常 mod 中很常见。
  - English: [Feature] 11 new engine-fact-driven script performance diagnostics (CW279-CW289). 2.23.0 annotated each command's engine cost, but an annotation is only knowledge: the counter-intuitive engine behaviour that actually causes frame drops was still invisible - pop-job re-assignment effects re-run the whole planet's job pipeline synchronously inside a loop, `create_country` synchronously contacts every galactic country and rebuilds the database arrays, `factor = 0` in a weight block does not early-exit at all, and a scope switch without `?` in a hot block serialises the entire scope into the error log on every tick. **CW279** flags galaxy-scale cost commands (`o(n)_galaxy` / `o(n^2)` / `combat`, plus the new `script_eval` class) placed in a high-frequency host, and extends that host list with eight new contexts (`pop_faction_types`, `edicts`, `special_projects`, `situations`, `archaeological_site_types`, `technology`, `colony_automation`, `game_rules`); **CW280** flags an MTTH with `modifier` blocks, where the engine evaluates the whole trigger before rolling. **CW282/CW283** cover the synchronous pop-job (`EnsurePopJobsAreUpToDate`) and `create_country` effects inside iteration loops, through a new `## sync_effect` rule channel (`pop_jobs` / `heavy`) so the facts stay in the rules and annotating another effect needs no code change and no release; a `create_country` in two or more nested loops escalates to **Warning**. **CW284-CW289** cover nested scope iteration ($O(N^2)$), `factor = 0` not short-circuiting in a weight block, cross-scope variable reads inside a loop (a deep copy of the event scope per iteration), repeated identical scope chaining (1.8KB frames rebuilt each time), an unsafe scope switch in a hot context, and high `inline_script` reuse (every call point duplicates and re-parses the whole AST with no instance sharing). Severity is deliberately restrained: performance findings are Information, secondary risk is Warning, and nothing is Error, b... (line truncated to 2000 chars)
- **[修复] 动态名以数字结尾会撞名（Dynamic Name Collision Fix）**：
  - **CW281**（Warning）：动态 flag / 事件目标名是「基础名 + 十进制 ID」**无分隔符**拼接（`name@123`），因此以数字结尾的基础名会撞名——`a1@23` 与 `a12@3` 生成完全相同的名字。请让基础名部分不以数字结尾。
  - English: [Fix] **CW281** (Warning) - dynamic flag/event-target names are formed as `base + decimal ID` with no separator (`name@123`), so a base name ending in a digit can collide: `a1@23` and `a12@3` produce the same name.
- **[优化] 引擎开销分类细分与两处反直觉结论修正（Engine Cost Class Refinement）**：
  - 新增 `script_eval`（复杂脚本求值）与 `scope_copy`（作用域深拷贝）两个开销类别，使 `opinion`、`habitability`、`has_valid_civic` 等真正沉重的命令不再逃逸 CW279 检查；`triggers.cwt` / `effects.cwt` / `scope_changes.cwt` 中笼统的 `o(n)` 细分为 `script_eval`、`o(n)_galaxy`、`o(n)_owned`、`o(n^2)`、`o(1)`、`o(log n)`。
  - `log` 此前被标注为 O(n)，实为 **O(1)**：`CTextBase::ProcessString` 确实被调用（dump L6035613）但循环遍历的是字符串字符而非游戏容器，且 `CLogEffect`/`CLogTrigger`（L6035532 / L6880834）内根本无循环。`extract-engine-cost.cjs` 随之排除文本/格式化工具的容器扫描证据，避免该误判复发。
  - CW282 与 CW283 初版定为 Warning/Error，复核后按实操体验降为 Information（嵌套 `create_country` 仍为 Warning），移除了阻塞性的 Error。
  - English: [Optimization] Added the `script_eval` and `scope_copy` cost classes so genuinely heavy commands (`opinion`, `habitability`, `has_valid_civic`) are no longer missed by CW279, and refined the coarse `o(n)` annotations in `triggers.cwt` / `effects.cwt` / `scope_changes.cwt` into `script_eval`, `o(n)_galaxy`, `o(n)_owned`, `o(n^2)`, `o(1)` and `o(log n)`. Corrected `log` from O(n) to **O(1)**: `CTextBase::ProcessString` is called (dump L6035613) but loops over string characters rather than a game container, and `CLogEffect`/`CLogTrigger` (L6035532 / L6880834) contain no loop at all; `extract-engine-cost.cjs` now excludes text/formatting utilities from container-scan evidence so the false positive cannot recur. CW282/CW283 were also lowered from Warning/Error to Information (nested `create_country` stays Warning), removing the blocking Error.

### 文档扩充与 CI 子模块修复 / Documentation & CI Submodule Fix
- **[修复] CI 检出失败修复（CI Checkout Fix）**：
  - 自 `364646df` 起每次 CI 运行都在 `actions/checkout` 失败：内层工作副本把 `cwtools-mcp` 的规则子模块固定到一个重复且**未推送**的 commit（`979a7060`，与已推送的 `4c88434` 树与父提交完全相同），而按 SHA 的浅拉取恰好报出 CI 看到的错误。`cwtools-mcp` 现指向 `650d119`，固定的是已推送的副本。
  - 经验：**绝不要从嵌套工作副本提交嵌套子模块指针**，否则会固定一个别人无法拉取的 commit。
  - English: [Fix] CI had failed at `actions/checkout` on every run since `364646df` with `upload-pack: not our ref 979a7060f...`. A nested working copy had pinned `cwtools-mcp`'s bundled rules submodule to a duplicate **unpushed** commit (`979a7060`, identical tree and parent to the already-pushed `4c88434`), and a shallow fetch by SHA fails with exactly that error. `cwtools-mcp` now points at `650d119`, which pins the pushed copy. Lesson recorded: never commit a nested submodule pointer from a nested working copy, or it pins a commit nobody else can fetch.
- **[维护] 新增 Stellaris 4.5 引擎性能与正确性分析文档（Stellaris 4.5 Engine Analysis）**：
  - 新增 `docs/better_stellaris/` 16 篇反编译分析（UI 每帧开销、脚本引擎、人口与经济修正、舰队寻路 AI、核心与存档、模组作者指南、良好设计范式、flag/target/规则/战斗、内联脚本、effect 副作用成本、种族与外交、AI 自动化、日常子系统、触发器开销目录、14 处静默损坏 bug），以及 `docs/stellaris-engine-performance-scan.md` 全量开销清单（trigger 658/892、effect 590/774）与剩余引擎事实 lint 工作交接文档。
  - English: [Maintenance] Added `docs/better_stellaris/` (16 decompilation analyses: per-frame UI cost, script engine, pops and economy modifiers, fleet pathfinding and AI, engine core and save/load, modder guide, good designs, flags/targets/rules/combat, scripted triggers and inline scripts, effect side costs, species/leaders/diplomacy, AI economy automation, daily subsystems, trigger cost catalog, and 14 silent-corruption bugs) plus `docs/stellaris-engine-performance-scan.md` (full cost inventory: trigger 658/892, effect 590/774) and a handoff document for the remaining engine-fact lint work.

## [2.23.0] - 2026-09-28

### 脚本命令引擎开销悬停与静态银河编辑修复 / Engine Cost Hover & Static Galaxy Edit Fix
- **[特性] 悬停显示脚本命令的引擎开销与硬编码行为（Engine Cost Hover）**：
  - **解决什么**：悬停此前只展示规则能描述的**语法**，不展示**引擎实现**。于是 `has_tradition` 与 `num_ships` 写法几乎一样、引擎代价却相差一个数量级，写进逐日 `on_action` 后性能后果完全不同；同时 `set_update_modifiers_batch` 的 begin/end 语义、`is_designable` 对自动设计生成的门控、`has_any_flag` 只读计数不做搜索这类反常识行为对作者完全不可见。
  - **覆盖范围**：为 **1248 / 1657** 条 trigger/effect 标注引擎开销（`O(n)` 718、`O(1)` 523、`O(n²)` 2、`O(log n)` 2、其余 3）。悬停额外显示开销等级、硬编码行为一句话，以及**已确认时的引擎函数与 dump 行号**。
  - **事实写在 CWT 而非代码里**：新增 `## cost` / `## engine` / `## engine_evidence` 三个规则指令，事实由规则维护者拥有，**新增条目无需改代码、无需发版**。`## cost` 取值非法时只会退化为"无标注"，不会输出错误结论；无 `## engine_evidence` 的条目显式标注"未确认，仅作提示"。
  - **推导可复现**：新增 `tools/engine-cost/extract-engine-cost.cjs`，从反编译结果链接命令与其引擎实现类、按花括号深度统计循环嵌套，且**只在有正面证据时才给出等级**。它排除日志/计时器等基础设施自身循环与 mod 自撰的事件目标链，并跳过 `if`/`switch`/`while` 等控制流关键字（其 "n" 是嵌套子句数，不是引擎扫描的容器）。
  - **纠正了流传的结论**：`has_tradition` 实为 **O(n)**（`CCountry::HasTradition` 线性扫描，dump L2079989），并非 O(1)；`num_researched_techs` 亦为 **O(n)**（`CalcTotalTechLevels`，L1504171）；`has_any_flag` 才是 **O(1)**（只比较数组长度，L6773819）；所有 `*_flag` 命令共用同一实现，作用域家族只决定虚调用返回哪个数组。
  - **未覆盖的部分**：其余 409 条命令保持未标注——dump 中其注册虚表不含类名，无法定位实现，猜测一个等级比留白更糟。
  - English: [Feature] Hover now shows reverse-engineered engine cost and hardcoded behaviour for the command under the cursor. Hover previously described only syntax, so it was impossible to tell that `has_tradition` is O(n) while `has_technology` is O(1), or that `has_any_flag` merely reads the flag count. **1248 of 1657** triggers/effects are annotated (O(n) 718, O(1) 523, O(n²) 2, O(log n) 2, 3 other); hover adds the cost class, a one-line behaviour note, and - when confirmed - the engine function and dump line. Facts live in CWT (`## cost` / `## engine` / `## engine_evidence`), so adding more needs no code change and no release; an unrecognised `## cost` value degrades to no annotation rather than a wrong claim, and entries without `## engine_evidence` are explicitly marked unconfirmed. `tools/engine-cost/extract-engine-cost.cjs` derives them from the decompilation, linking each command to its implementation class and tracking loop nesting by brace depth, and only emits a class with positive evidence - excluding logging/profiling infrastructure and mod-authored event-target chains that would otherwise mark nearly everything O(n), and skipping control-flow keywords whose "n" is the number of nested clauses. Corrects the record: `has_tradition` is O(n) (linear scan, dump L2079989), `num_researched_techs` is O(n) (L1504171), `has_any_flag` is O(1) (L6773819), and all `*_flag` commands share one implementation. The remaining 409 commands stay undeclared because the dump labels their registration vtables without a class name.
- **[修复] 静态银河新增连线的 ID 引号形式（Static Galaxy ID Quoting Fix）**：
  - 预览/编辑器右键新增 Hyperlane 时，此前写出裸整数（`add_hyperlane = { from = 3215 to = 2834 }`），与官方 `static_galaxy_example.txt` 的带引号形式不一致；现统一按 vanilla 风格写出 `from = "3215"`。仅改"写出"而非"解析"，重新解析后 ID 仍归一化为数字，端点匹配与"重连不产生重复声明"的既有契约不变。