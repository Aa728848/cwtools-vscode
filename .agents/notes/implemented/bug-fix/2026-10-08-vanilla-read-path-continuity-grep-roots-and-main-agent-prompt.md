# Agent Note: 原版文件读取链路断裂——grep 透传扫描根 + 主 Agent 注入原版只读根

Status: implemented

## Problem

模型能在 vanilla 目录里 grep 到定义，却读不出那个文件，表现为 `read_file` ENOENT。根因不在沙箱，而是两条通道各说各话：

1. **grep 投影丢弃扫描根**：`searchPdxText` 对每条命中都带回了 `searchedRoot`（`lspTools.ts` 内 `PdxTextSearchResult`），但外层 `searchText` 投影成 `GrepResult` 时只保留 `file/line/content`，`searchedRoot` 连同 `GrepResult` 类型一起被丢掉。vanilla 命中的 `logicalPath` 是 `path.relative(vanillaRoot, file)`，例如 `common/scripted_effects/00_x.txt`——它只在 vanilla 根下有意义。模型把它原样喂给 `read_file`，`workspaceSandbox.resolveReadablePathInput` 会把相对路径锚到工作区根（`path.resolve(path.join(workspaceRoot, input))`），于是 ENOENT。
2. **主 Agent 从不知道原版根在哪**：`subAgentSandbox.ts` 把 `getConfiguredGameRoots()` 的结果注入 delegated 子代理的 `DelegationScopeFacts.readScope`，主 Agent 的 system prompt 里完全没有。主 Agent 只能 `run_command` 猜盘符、翻目录。

需要澄清的事实：读不到原版文件**不是沙箱拦截**。`resolveReadablePathInput` 在 `workspaceSandbox.ts` 末尾无条件 `return { ...resolution, isWithinReadableRoot: true }`，因此放宽策略不是、也不该是本次的修复点。真正的断裂在「模型构造不出那个路径」。

## Decision

两处都修，让 grep → read_file 链路自洽（主控已批准方案 Q2A）：

1. **`GrepResult.searchedRoots?: string[]`**（`types.ts`）：沿用既有 `searchedRoot` 语义的 optional 字段，承载本次实际扫描过的绝对根（排序 + 去重）。
2. **vanilla 命中改为绝对路径**：`searchPdxText` 的每条 vanilla 命中新增内部字段 `searchRoot`（记录该 `logicalPath` 所相对的原版根）；`searchText` 投影时用 `path.join(searchRoot, logicalPath)` 还原成绝对路径。绝对路径 + `searchedRoots` 同时给出，模型在 `searchContext="both"`（工作区根与原版根混排）下也不必猜这条命中属于哪个根。mod 命中的 `file` 保持工作区相对，不变。
3. **`_hint` 追加一句**：命中 vanilla 时说明这些 `file` 是原版根下的绝对路径，应原样传给 `read_file` / `document_symbols` / `get_pdx_block`。
4. **主 Agent system prompt 注入原版只读根**：新增 `prompt/sections/gameRoots.ts`，措辞与 `prompt/sections/delegationScope.ts` 对齐（中英双语、排序去重、有界、无时间戳），由 `PromptBuilder.buildSystemPromptForMode` 在 paradox domain 追加。探测来源只有 `getConfiguredGameRoots()`（配置键 `stellarisLanguageServices.cache.<gameId>`，键模板见 `gameProfiles.getCacheSettingKey`）——不硬编码盘符、不 `run_command` 猜目录、不新增 LSP 命令。
5. **`PROMPT_TEMPLATE_VERSION` 5 → 6**：system prompt 结构变了，冻结缓存必须失效，否则旧构建的缓存条目会被复用。
6. **文档漂移修正**：根 `AGENTS.md` 里把读路径策略说成 `client/extension/ai/pathScope.ts`（该文件不存在）。真实情况是 `client/extension/pathScope.ts` 只有纯原语，承担策略的是 `client/extension/ai/workspaceSandbox.ts`，已原地补正。
7. **冻结 prompt 指纹纳入已配置原版根**：`promptBuilder.computeFrozenPromptFingerprint` 增加 `gameRootsHash` 组件（`computeGameRootsHash()` 对 `getConfiguredGameRoots()` 的 `gameId|root` 列表取 shortSha256；未配置任何根时取字面量 `'none'`），并在 `classifyFrozenPromptMiss` 里以 `game_roots_changed` 单独归因。general domain 恒为 `'none'`——该 domain 不注入原版根段落，Paradox 安装路径变化不应让它 miss。

## Alternatives considered

- **放宽 `resolveReadablePathInput` 的可读根判断**：主控已澄清这不是拦截点，且放宽策略会削弱凭据路径等既有防护，否决。
- **把原版根硬编码进 prompt 模板或在配置里预扫描盘符**：与用户实际安装位置脱节，等同于引入第二个真相来源，否决。
- **让模型用 `run_command`（`dir`/`ls`）自行定位原版目录**：多一次易错的往返、跨平台命令差异、还要过命令预检，否决。
- **新增一条 LSP 命令把原版绝对路径回填给 grep**：`client/extension/ai/tools/lspTools.ts` 已能在本地算出根，跨到 F#（`src/`）会牵连语言服务器与子模块，收益不成比例，否决。
- **只加 `searchedRoots` 不动 `file`**：单根场景够用，但 `searchContext="both"` 时工作区相对路径与原版相对路径混排，模型仍要靠猜决定拼哪个根，否决。
- **把原版根写进 `definitions.ts` 的工具描述**：会触发 `generate:mcp-schema` 并需要进子模块独立提交与发版，链路太长，否决。
- **把注入点放进 `modePrompts.ts`**：该模块刻意不依赖 `vscode`（`chatModels` / `executePlanHandoff` / `planModePrompts` 三个测试在无 vscode stub 的情况下静态 import 它），一旦引入 `getConfiguredGameRoots()` 会在这些测试里 MODULE_NOT_FOUND，否决。
- **顺带给 slim 子代理也注入同一段**：slim 只用于 side-question / quality-gate / 子代理，这些路径已经通过 delegation scope 拿到根，重复注入只是噪音，否决。
- **配置变更时调 `clearFrozenPromptCache()` 兜底**：`vanillaCompare.ts:723-729` 监听 `stellarisLanguageServices.cache.*` 变更时只清 `vanillaFileCache`，没有任何监听器碰 promptBuilder。该方案是全局清理，会把**所有模式/所有 provider** 的冻结条目一起丢掉（代价远高于只失效身份相同的那一条），而且要为此在边界外新接一个持有 promptBuilder 实例的监听点。指纹组件方案改动面只在 `promptBuilder.ts` 内，且与既有「组件变化 → 新条目 → 可归因」的设计同构，故采纳组件方案（详见 Decision 7）。

## Consequences

- vanilla grep 命中现在开箱即读：模型把 `file` 原样传给 `read_file` 即可命中，回归测试直接跑通了「grep → read_file」这一跳。
- 未配置任何原版根时行为不变：`vanillaRoots` 为空 → 不存在带 `searchRoot` 的命中 → `searchedRoots` 字段整体不出现、`_hint` 不追加、`file` 仍是工作区相对路径；system prompt 侧 `buildGameRootReadScopeStatement([])` 返回空串，整段不注入。
- `verify_pdx_identifier` 走的是 `searchPdxText` 而非 `searchText` 投影，仍消费 `logicalPath`，语义未变。
- general domain 不注入该段：该 domain 下 `searchText` 直接转 `grep()`，根本没有 vanilla 搜索路径，注入原版根只会把 Paradox 事实漏进普通仓库编码提示词。
- 已知成本：一条 vanilla grep 结果的每条命中会多带一段原版根前缀（limit ≤ 50 文件，可接受）。
- 回归覆盖：`client/test/unit/vanillaGrepRootScope.test.ts`（3 例：透传根 + 绝对路径、grep 结果直接喂 read_file、未配置根时的 no-op）与 `client/test/unit/promptGameRoots.test.ts`（5 例：注入、缺根不注入、general domain 不注入、zh-cn 双语、空/缺省根列表不产文本）。
- **冻结缓存契约（新增）**：凡是被烘焙进 system prompt 的配置都必须是 `computeFrozenPromptFingerprint` 的一个组件。漏一个，用户改设置后指纹不变，`buildFrozenSystemPrompt` 直接吐旧字符串，症状是「功能看起来还在，但一改设置就静默失效」——原版根这一条曾让模型拿着已失效的安装路径去 `read_file` 并 ENOENT。新增此类配置时，必须同时补：`gameRootsHash` 式的组件 + `classifyFrozenPromptMiss` 的独立 miss 原因 + 「未配置时逐字节不变、不产生额外 miss」的回归用例。
- `PROMPT_TEMPLATE_VERSION` 保持 6：本次只改指纹组成，prompt 文本一个字没动；指纹组件集合变化本身就让每个旧键不可达（缓存是进程内 `Map`，跨版本不残留），再 bump 只会多给出一个并不存在的「模板结构变化」理由。
- **测试隔离契约（新增，务必遵守）**：这两个测试各自显式在共享 fixture 的 vscode stub 下重载 `configuredGameRoots` / `lspTools` / `promptBuilder`，并在结束时把进程级 require 缓存**还原成原样**。原因是 require 缓存决定了这些模块最终读到哪一份 vscode stub——若某个更早加载的 suite 抢先绑定过 `configuredGameRoots`（例如在文件顶层永久替换 `Module._load` 的 suite），后跑的 fixture 注入会**静默失效**，表现为「配了原版根却搜不到任何命中」，而非任何显式报错。因此这两个测试**不得依赖文件加载顺序**，也不得依赖别的 suite 已经建立过缓存状态。
