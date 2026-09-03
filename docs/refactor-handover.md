---
description: 代码库精简改进交接文档：冗余清理、重复类型合并、安全层收敛、测试治理（2026-09-03 全库审查结论）
---

# 代码库精简与重复治理（任务交接文档）

本文档是 2026-09-03 对全库做六轮排查后的改进交接清单，供后续执行者（人或 AI）按阶段接手。

**总体结论**：问题集中在 `client/extension/ai/`（占 extension 源码 71%）。F# 后端、传统扩展功能、`client/shared/` 共享层均健康。核心病灶是 AI 子系统被分批叠加开发、从未整体校验过一致性：同一防护判断最多写了 7 份、同一类型最多有 4 份定义、若干安全设施是零生产者的死代码。

**执行原则**：

- 阶段一→五按顺序做，每阶段独立可交付、独立提交 commit、独立验证。
- 文中行号是 2026-09-03 审查时的快照，会漂移；执行时按**符号名搜索**定位。
- 开始前 `git status --short` 保护现场；遵守根 `AGENTS.md` 全部约束（见文末）。

---

## 进度快照（2026-09-03 第二轮核查后更新）

| 阶段 | 状态 | 关键 commit |
|---|---|---|
| 一 纯删除 | ✅ 完成 | `ffcb37aa`（另：.vscode-test 旧存档、根 packages/ 等均已清） |
| 二 死代码 | ✅ 完成（决策点 A 取保守项：policyEngine 维持越界硬拒） | `295b285b` |
| 三 类型合并 | ✅ 代码完成；⚠️ **子模块 `1bec582` 未推送、npm 未发布** | `7a6c5adc` + 子模块 `1bec582` |
| 四 安全层收敛 | ✅ **全部完成（4.1 ~ 4.8 均已闭环落地）** | `8cb02b3e`、`b2101cd8`、`533df5aa`、`92c8fb15` |
| 五 测试治理 | ✅ 5.1/5.2/5.4；⬜ 5.3；5.5 可选 | `75f52f09`、`5204744a`、`0811f3ec`、`908ebe0c`、`952e8b01` |
| 六 大重构 | 按计划未启动 | — |

验证基线：compile / typecheck:test / test:unit（2314 通过）/ `npm test`（Extension Host 19 用例离线集成）全部绿灯通过。

**阶段四执行记录（2026-09-03 全面收官）**：
- **4.8 砍层简化**（Commit `8cb02b3e`）：将 `PolicyLayerId` 收敛为实际生效的 `global-defaults | user` 两层，彻底移除 6 个空层与跨层竞速死代码，单测重写保持 28 个全绿。
- **4.6 读路径沙箱收敛**（Commit `b2101cd8`）：在 `lspTools.ts` 补齐统一的 `guardReadablePath` 沙箱检验；从 `agentTools.ts` 移除 `READ_PATH_ARGUMENTS` 外层重复拦截门，消除双查。
- **4.3 双 learned-rule 规则库合一**（Commit `533df5aa`）：在 `PermissionPolicyStore` 中增加 `toPolicyRules()` 并支持 `pathGlob`，无缝并入 `policyEngine` user 层规则，保持 `checkpoint.ts` 恢复兼容。
- **4.7 审批决策单源化**（Commit `92c8fb15`）：提取统一纯函数 `shouldBypassWriteConfirmation` 集中判定 4 开关与 `vfsOverlay`，覆盖全分支笛卡尔积测试（26 用例全绿）。

---

## 阶段一：纯删除（零风险，立省约 4.4 GB）

全部为 git 未跟踪或 gitignored 内容，无源码依赖。

| 删除目标 | 大小 | 死的证据 |
|---|---|---|
| `client/webview-next/` 整个目录 | 105M | React 重写 UI 的烂尾脚手架：src 下 5 个空目录、0 源文件、无 package.json/vite.config，全仓库 0 引用，git 未跟踪 |
| `.vscode-test/vscode-win32-x64-archive-*`（4 个旧版本） | ~3.3G | 5 套 vscode-test 配置全部 pin `1.93.1`，这 4 个（1.117/1.118/1.128/1.135）无一在用；删后下次测试只重下 1.93.1 |
| `.vscode-test/extensions` 里旧 copilot-chat | 76M | 4 月残留 |
| 根 `packages/` 整个目录 | 566K | MCP 拆分子模块（commit `55eb20ed`）后的陈旧 dist 残留；与子模块 dist 已分叉且更旧，全仓库 0 引用 |
| `artifacts/warshipgirl-*.json`（4 个） | 690K | 一次性 LSP 调试转储；其中 2 个 MD5 逐字节相同 |
| `release/bin/client/test/unit/` | 1.5M | 旧测试配置编译输出残留；现行 `tsconfig.test-build.json` 已 `exclude: unit/**` |
| `release/*.vsix`（可选） | 153M | 本地打包产物，发布走 GitHub Release |
| `client/common/` 空目录 | 0 | graph 功能删除（`abbf7320`）后的残留；顺手清 `rollup.config.mjs` 里 9 处 `"client/common/**"` exclude |
| `client/webview/cytoscape-qtip.d.ts` | 31B | graph 删除的漏网之鱼，全仓库 0 引用 |
| `runs/`、`.tmp-test/` | 300K | runner smoke 与被杀进程的测试残留，均 gitignored |

**验证**：`npm run compile && npm run typecheck:test`

---

## 阶段二：死代码删除（低风险）

| # | 任务 | 位置与证据 |
|---|---|---|
| 2.1 | 删 `capabilityLease.ts` 整个模块（41 行）及消费点 | `client/extension/ai/runner/capabilityLease.ts`；消费点 `agentTools.ts:1150`（`consumeCapabilityLease` 永远拿到 undefined）、声明点 `agentRunner.ts:613`。**全仓库无任何代码签发过 lease** |
| 2.2 | 删 `fileTools` 的 `vfsLocks`/`executeWithLock` 死锁层 | `fileTools.ts:86, 226-244`；`ctx.vfsLocks` 全仓库无赋值点，首行永远 noop 直通。真正的锁是 L2 的 PartitionedWriteQueue（`writeCoordinator.ts`） |
| 2.3 | 删 `toolScheduler.acquireLock` 对写工具的 noop 分支及二次 acquire | `toolScheduler.ts:208-211` 对 per-file-write 直接放行；`agentRunner.ts:3877` 在 writeQueue 内再 acquire 一次 |
| 2.4 | 合并 `agentRunner.runNestedToolStep` 与主循环重复的 write-queue 序列 | `agentRunner.ts:875-934` 与 `:3861-3930` 两份复制，注释都强调顺序不能反——提取公共函数 |
| 2.5 | 删死命令 `startcustomgame` | `release/package.json:498` contributes；client 无 registerCommand、服务器 `Program.fs:7017+` 命令列表无、全仓库大小写搜索 0 命中。顺手清 3 个 nls 文件里的标题字符串 |
| 2.6 | （小）`usageTracker.ts:4` 改为走 `ai/pricing.ts` facade | 其余消费者（agentRunner.ts:42、providerCallUsage.ts:10、compaction.ts:5）都走 facade，只有它绕过直 import `providers/models/pricing` |
| 2.7 | （可选）删 `ai/index.ts` 单消费者 barrel | 仅 `extension.ts:28` 用到 7 个导出；ai/ 内部全部直接互 import |

**⚠️ 决策点 A（阶段二/四共用，先定再动手）——越界写语义二选一**：

- 现状矛盾：`policyEngine.ts:348-353` 对 writableRoots 外的写目标**硬拒绝且不给审批路径**（`canEscalate` 排除 `outside_writable_roots`，:382-384）；而 `fileTools.ts:444-469` 精心实现了"越界写/跨工作区写可申请用户升级"。由于 enforcePolicy 先于工具执行，fileTools 那两段是**不可达死代码**。
- 选项 a（保守，推荐）：维持硬拒绝，删 fileTools:444-469 死代码。
- 选项 b：支持升级，把 policyEngine 硬拒改 ask，删 fileTools 重复实现。
- 两者只留一个语义，无论选哪个都消除了矛盾。

**验证**：`npm run compile && npm run typecheck:test && npm run test:unit`

---

## 阶段三：重复类型/协议合并（"同一个东西造了好几份"）

`client/shared/` 是正确样板（`staticGalaxyProtocol.ts` 真正贯穿 Host↔Webview），方向是把重复类型往那里收，而不是再造新层。

| # | 任务 | 位置与证据 |
|---|---|---|
| 3.1 | `ToolEffect`/`ToolConcurrencyClass` 双定义合一 | `ai/types.ts:2837-2855` vs `ai/tools/registry.ts:25-43` 逐字相同。留一份（建议留 tools/registry.ts），另一处 re-export。导入方需统一：`runner/toolInvocation.ts:1`、`toolScheduler.ts:11` 从 `../types`；`capabilityLease.ts:2` 从 `../tools/registry`（阶段二删掉后少一处） |
| 3.2 | 修复 MCP 子模块已漂移的 3 处镜像 | ① `submodules/cwtools-mcp/packages/cwtools-shared/src/tools/registry.ts:1-18` ToolEffect 缺 `'process'` 成员；② diagnostic severity 词汇：extension 用 `'info'`（`types.ts:1980`，映射在 `lspTools.ts:2887-2890`），子模块 `host/diagnostics.ts:4` 用 `'information'`；③ `DocumentSymbolInfo.range`：`types.ts:1276` vs 子模块 `tools/symbols.ts:36` 多 startColumn/endColumn。**流程**（AGENTS.md 强制）：改 `client/extension/ai/tools/definitions.ts` → `npm run generate:mcp-schema` → 子模块内 `npm run build && npm run test:contracts` → 子模块内提交推送 → 根目录 bump 指针 → 从子模块仓库发布新版 cwtools-mcp |
| 3.3 | 长期：把 extension→cwtools-shared 的手工镜像类型纳入生成流程 | 目前只有 schema 由 `tools/generate-mcp-schema.cjs` 生成，args/result TS 类型是手抄（已漂移 3 处）。至少在子模块契约测试里加类型级断言 |
| 3.4 | `types.ts` 内部 3 份匿名内联 Topic 类型提为具名 | `:2574`（topicList）、`:2615`（topicSearchResults）、`:2642`（managerSnapshot.topics）同一文件内三连复制；stats 同理 |
| 3.5 | Run 事件信封 3 份 webview 副本合一 | 原件 `AgentRunEvent`（`runner/runLedger.ts:115`）；副本 `webview/chat/agentTrace.ts:3`、`webview/chat/runTimeline.ts:11`、`messages.manager.ts:67` 内联。信封类型移 `client/shared/`，三处改 import |
| 3.6 | 移入 `client/shared/`：`ArtifactRecord`、`ManagerSchedulingStateView`、workflow 线格式 DTO | `webview/chat/artifacts.ts:3,16` vs `types.ts:2271,2312`（10/10 字段 100% 相同）；`messages.manager.ts:15` vs `types.ts:40`（13/13 字段相同）；`types.ts:2578-2579` 匿名 DTO vs `webview/chat/workflows.ts:1-31`（100% 同形） |
| 3.7 | `messages.manager.ts` 改 import `client/shared/agentTranscript.ts:52` | 它内联重抄了 `AgentTranscriptSnapshot`（~85% 重合）且 metrics 已缺 9 个后加字段——共享层有现成类型却绕开自建 |
| 3.8 | `agentManagerContracts.test.ts:77` 的字符串包含弱断言升级为编译期类型断言 | 参照既有模式 `client/test/unit/chatProtocol.test.ts:6-12` |

**可接受、不动**：HostMessage/WebViewMessage 与各自 validator 双份（`types.ts:2485/2564` vs `webview/chat/hostProtocol.ts:41-129`、`ai/chat/webviewProtocol.ts:99-173`）有编译期消息名同步，属合理层边界。

**验证**：`npm run compile && npm run typecheck:test && npm run test:unit`；涉及 3.2 加跑子模块 `npm run build && npm run test:contracts`

---

## 阶段四：安全层收敛（中风险，每步单独提交）

**背景**：一次 `write_file` 落盘要过 5 层约 16 道检查。真正不可或缺的边界只有 3 个，收敛时**保留**它们：

1. `client/extension/pathScope.ts:21` 的 `isPathInsideOrEqual`（唯一权威路径原语）
2. `agentTools.ts:1827 execute()` 分发总闸
3. `run_command` 的 OS 沙箱（`sandboxBroker.ts` bubblewrap/seatbelt/windows-helper）

| # | 任务 | 位置与证据 |
|---|---|---|
| 4.1 | ✅ "工作区内"判断 7 份收 1 份 | 内联复制全部换成 `pathScope.isPathInsideOrEqual`（Commit `75a22297`） |
| 4.2 | ✅ 落实决策点 A（见阶段二） | 消除 policyEngine 硬拒 vs fileTools 升级的语义矛盾（Commit `295b285b`） |
| 4.3 | ✅ 双 learned-rule 库合一 | `PermissionPolicyStore` 并入 `policyEngine` user 层（`toPolicyRules()` + 支持 `pathGlob`），保持 `checkpoint.ts` 兼容（Commit `533df5aa`） |
| 4.4 | ✅ 命令前缀匹配 3 份合 1 份 | 收拢至 `policyEngine.ts` `commandMatchesPrefix`（Commit `30c99b31`） |
| 4.5 | ✅ 静态能力门去重 | 合并 `isToolAllowedForMode` 薄包装（Commit `30c99b31`） |
| 4.6 | ✅ 读路径双查留一处 | `lspTools.ts` 补齐统一沙箱包含校验（`guardReadablePath`），从 `agentTools.ts` 移除 `READ_PATH_ARGUMENTS` 重复拦截（Commit `b2101cd8`） |
| 4.7 | ✅ 审批决策单源化 | 统一写确认 4 开关决策逻辑至纯函数 `shouldBypassWriteConfirmation`，覆盖笛卡尔积测试（Commit `92c8fb15`） |
| 4.8 | ✅ policyEngine 砍层简化 | 削减为实际生效的 `global-defaults | user` 两层，移除 6 个幽灵层与跨层竞速代码（Commit `8cb02b3e`） |

**验证**：每步 `npm run compile && npm run test:unit`；4.2/4.7 涉及行为变化，补跑 `npm test`（Extension Host 套件）并手动走一次"写文件触发审批"的冒烟。

---

## 阶段五：测试治理

| # | 任务 | 位置与证据 |
|---|---|---|
| 5.1 | 拆 `client/test/unit/agentToolSafety.test.ts`（3,570 行） | 名不副实的"厨房水槽"：内含 fileTools、externalTools、agentTools、agentRunner、lspTools、HeadTailTextBuffer、sprite 候选契约、topic artifacts、进度/中止等 7 个不相关 describe。按被测模块归位，并与 policy 簇其余 14 个文件（共 5,901 行测同一条策略链）去重 |
| 5.2 | 测试临时目录改用 `os.tmpdir()` | `evidenceGate.test.ts:18`、`runLedger.test.ts:19` 的 `TEMP_BASE` 目前在仓库内建 `.tmp-test/`，进程被杀就残留（现有残留即此因）。正确示例：`aiServiceTimeout.test.ts` 已用 `os.tmpdir()` |
| 5.3 | 审视 runner 状态/resume 测试簇 | 7 个文件 2,165 行（agentRunnerState/agentResumeState/resumeStateV4/dispatchResume/reducers/runLedger/agentRunnerToolRepair）围绕同一 reducer/ledger 模块组，合并重复基建 |
| 5.4 | 夹具瘦身 | `client/test/sample/` 里 1.7M 的 `faction_room.dds` 和 6 份 32K 同构本地化 yml；确认测试实际需要的分辨率/语言数后裁剪 |
| 5.5 | （可选，改动大）5 套 vscode-test 配置合并 | cwt/cwt-game/shader 三套可考虑并为一个多 suite 配置；`test:overlay-e2e` 每次全量 `dotnet publish --self-contained`（数百 MB），考虑产物缓存 |

**测试总量不动**：测试/源码比 39% 合理，AGENTS.md "修 bug 加回归测试"策略不变。本阶段只治重复覆盖和超大单体文件。

**验证**：`npm run test:unit && npm run typecheck:test`；动了套件配置再跑对应 `npm test` / `npm run test:shader-lsp` 等。

---

## 阶段六：大重构（仅记录，不建议本期做）

- **God 文件**：`lspTools.ts` 5,415 行、`agentTools.ts` 4,930、`agentRunner.ts` 4,567、`chatPanel.ts` 4,544、`types.ts` 2,874、`fileTools.ts` 2,510、`definitions.ts` 2,252；F# 侧 `src/Main/Program.fs` **13,033 行**、`ProjectKnowledge.fs` 4,307 行。
- **runner 两套并行状态表示**：事件投影 reducer（`runReducers.ts` 695 行）vs 领域状态 store（`state/runtimeModels.ts` 307 行 + `domainStateStore.ts`），同一 run 状态两边各算一份，应合并为事件溯源单一真相。
- **上下文窗口管理散在 9 个模块**：compaction、contextMaintenance、contextBudget、contextTranscript、tokenEstimation、tokenCalibration、contextLimitTracker、contextMemory、liveContext。
- 拆 god 文件优先序：`agentTools.ts`（注册表+策略+证据门+MCP+dispatch 全在一个类）> `agentRunner.ts` > `Program.fs`。

---

## 明确不要动（已审查确认健康）

| 区域 | 结论 |
|---|---|
| `client/shared/` 5 个文件 | 全部有真实消费者，是应推广的样板 |
| `client/webview/`（旧版） | 现役唯一 webview，9 个 rollup 入口全部有宿主加载方；除 `cytoscape-qtip.d.ts` 外无死代码 |
| F# 后端与 `submodules/cwtools` | ProjectReference 引用，无复制分叉；29 个 `*.Tests.fsx` 全部测活代码 |
| 用量追踪四文件（pricing/providerUsage/providerCallUsage/usageTracker） | "价格表→归一化→单次折算→聚合"流水线，不重复 |
| 知识/记忆五模块（gameKnowledge/interfaceKnowledge/projectKnowledge/projectProfile/memoryParser） | 职责边界清晰 |
| `fileWalker.ts` vs `indexing/` | 不同机制不同消费者（预览面板 vs vscode.findFiles+sqlite） |
| `release/node_modules` | vsce 双 package.json 布局的固有代价 |
| `languageServerProcess.ts` / `...Controller.ts` | facade + 实现，均活 |
| contributes 命令其余 60 个 | 抽查双向核对均活（LSP executeCommand 类无需 client 注册） |

---

## 验证命令速查

```bash
npm run compile              # tsc + rollup，删代码后必跑
npm run typecheck:test       # 全 client/ 含测试的严格检查
npm run test:unit            # 单测（190 文件）
npm test                     # Extension Host 集成套件（行为变更后跑）
npm run verify               # 发布级总闸（lint+compile+typecheck+unit+check:release）
cd submodules/cwtools-mcp && npm run build && npm run test:contracts   # 动 MCP 镜像类型时
```

## 仓库约束提醒（来自 AGENTS.md，执行时必须遵守）

- 子模块变更：先在该子模块仓库内提交推送，再 bump 根目录指针；两类变更不混在一个 commit。
- 用户可见的命令/设置/诊断/UI 文案：中英文同步（`messages.ts`、`workflowI18n.ts`、`webview/chat/i18n.ts`）。
- 扩展/AI 代码用 `ErrorReporter`，不要裸 `console.error`。
- 本地化 `.yml` 只能走 `write_localisation`，通用写工具不得写。
- 修 bug/改可观察行为要配针对性回归测试。
- 不引入新的 `any`/未检查的类型断言；外部数据用 `unknown`+类型守卫收窄。
