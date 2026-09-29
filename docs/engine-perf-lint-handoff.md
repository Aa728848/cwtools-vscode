# 引擎事实驱动的 Lint 与性能工具：剩余工作交接文档

本文档记录 better_stellaris 分析（`docs/better_stellaris/`，Stellaris 4.5 反编译性能/正确性审查）
转化为本项目规则配置与插件功能的**已完成部分**与**剩余工作**，供后续开发者或 AI 代理接续。

## 设计原则（已确立，后续工作必须遵守）

1. **事实住规则文件，后端只做分类**：命令开销、机制、证据以 `## cost` / `## engine` / `## engine_evidence`
   注释写在 `submodules/cwtools-stellaris-config/config/*.cwt`；LSP/后端从 `Lookup.configRules`
   动态读取（见 `engineCostMap`，`submodules/cwtools/CWTools/Validation/Stellaris/STLValidation.fs:1262`），
   **禁止在后端硬编码命令级事实表**。后端只允许持有"哪些 cost 等级算贵"这类分类逻辑。
2. **严重级别纪律**：性能类一律 Information（蓝色）；error 只给确定产生破坏的（如 design flag 写全局表）；
   warning 给次要正确性风险。用户明确确认过此策略。
3. **诊断码**：新码在 `submodules/cwtools/CWTools/Validation/Validation.fs` 的 `ErrorCodes` 定义
   （CW279–281 已占用，下一个可用 **CW282**），并在 `docs/diagnostic-codes.md` 登记、
   `client/extension/diagnosticI18n.ts` 补中文翻译（zh 函数支持正则捕获插值）。
4. **提交顺序**：先在各子模块内 commit/push，再更新根仓库子模块指针；
   `cwtools`（库）与 `cwtools-stellaris-config`（规则数据）的改动不得混在一个提交里。
5. 每个非平凡变更要按 `.agents/notes/README.md` 的 6 类分类法写简体中文 Agent Note，
   并遵守 Owning Note 纪律。

## 已完成快照（勿重做）

| 内容 | 位置 | 提交 |
|---|---|---|
| CW279 高频上下文全银河级开销告警（Information） | `STLValidation.fs:1300` `validateHotContextCost` | cwtools `7ee07f2f` |
| CW280 MTTH 带 modifier 块告警（Information） | `STLValidation.fs:1357` | 同上 |
| CW281 动态名数字结尾撞名告警（Warning） | `STLValidation.fs:1388` | 同上 |
| `set_design_flag`/`has_design_flag` error 级禁用 | effects.cwt:5430 / triggers.cwt:4046 | cwtools-stellaris-config `a913b31` |
| 26 处 `## engine` 追加 Cheaper 替代建议 | triggers/effects/scope_changes.cwt | 同上 |
| 12 个全银河迭代器标 `o(n)_galaxy` | scope_changes.cwt | 同上 |
| hover 开销展示（更早完成） | `src/Main/HoverPerformance.fs` | 既有 |

CW279 当前识别的高频宿主：岗位 `weight`/`possible`（common/jobs）、决议 `potential`/`allow`、
宣战理由 `potential`、buildings/districts 的 `triggered_*` 块、事件 MTTH 的 `modifier` 块。
昂贵等级集合：`{"o(n)_galaxy", "o(n^2)", "combat"}`（`STLValidation.fs:1249`）。

---

## 剩余任务 A：714 条笼统 `o(n)` 的细分（优先级最高，纯配置活，CW279 立刻受益）

**现状**：`triggers.cwt`/`effects.cwt` 中 714 条 `## cost = o(n)` 由
`tools/engine-cost/extract-engine-cost.cjs` 静态提取，粒度粗（凡见到循环就标 o(n)），
无法区分"遍历自己容器的小循环"与"全银河扫描"。CW279 只对三个等级告警，所以大量真正的贵命令
（`opinion`、`habitability`、国家作用域 `num_ships` 等）目前不触发告警。

**数据源**：`docs/better_stellaris/14_trigger_cost_catalog.md`（约 100 个 trigger 的分级表，
区分容器规模 C=殖民地/G=人口组/N=国家/S=舰船，标注 ✅ 人工复核）和 `10_effect_side_costs.md`
（约 40 个 effect）。

**两条路径**：

1. **工具重跑（推荐）**：扩展 `tools/engine-cost/extract-engine-cost.cjs` 的分级逻辑，
   让它输出更细的等级（owned/galaxy/script-eval），用 Ghidra dump 重新跑一遍批量更新。
2. **手工核对**：按 14 号文逐条改。量约百级，适合分批做。

**需要先扩展词汇表**：现有 `## cost` 取值（`src/Main/HoverPerformance.fs:35-65` 的
`tryParseClass`）没有"贵常数/脚本求值"类。`opinion`（约 20 个 modifier 的脚本求值 +
构建 CGameText）、`habitability`（逐特质求值 triggered modifier）这类不是遍历但依然很重的命令
无处安放。建议新增等级，如 `script_eval`（求值脚本/重算派生状态）与 `scope_copy`
（带深拷贝作用域）。改动点：

- `HoverPerformance.fs`：`PerfClass` 联合 + `tryParseClass` + `classToken` + `classInfo`（中英描述）
- `src/Main/HoverPerformance.Tests.fsx`、`EngineCostRuleParsing.Tests.fsx` 同步补用例
- 决定是否把新等级加入 CW279 的 `hotContextExpensiveCosts` 集合
- `docs/cwt-rule-config.md` 中 `## cost` 的取值文档同步

**细分时的重点命令清单**（出自 14 号文 1.3/1.4 表，全部应高于 `o(n)`）：

- 银河级：`any_neighbor_country`（O(N log N)，已标）、`any_species_pop_group`（已标）、
  `any_galaxy_planet`/`random_galaxy_planet` 等（已标）；漏网检查：`intel`（O(N) 情报扫描）、
  `has_claim`（国家目标时 O(目标星系数×宣称数)）
- 国家自有级（`o(n)_owned`）：国家作用域 `num_buildings`/`num_districts`/`num_assigned_jobs`/
  `num_unemployed`/`num_ships`（O(F·S) 逐船虚调用）、`count_used_naval_cap`、
  `any_owned_pop_group`（国家层面无现成数组要现场拼）
- 脚本求值级（新等级）：`opinion`/`their_opinion`/`opinion_level`、`habitability`、
  `has_valid_civic`、`max_naval_capacity`/`used_naval_capacity_percent`（O(M·附庸) + game_rule 每次重算）、
  `num_researched_techs(_of_tier)`（O(T) 全扫已研究数组）、`ethos`（星球，三层循环）
- effect 侧（10 号文）：`modify_species`（O(S·T²) 查重 + 全帝国重分组）、`create_country`
  （最重单个 effect）、`add_building`/`add_district`/`set_controller`（同步整星球岗位重排）、
  `spawn_system`（每次同步 O(N²) 距离重建，除非批处理）

**已知坑**：`pop_amount`/`sapient_pop_amount` 是原版 scripted_trigger，config 中没有 alias 条目，
`## cost` 无处可挂。可选方案：查 CWTools 是否支持对 scripted_trigger 定义本身标注
（`lookup.onlyScriptedTriggers`），或在 `common/scripted_triggers` 的规则上想办法；也可能只能放弃
对该名的 hover/告警，仅在文档中提示。

**验收**：`grep -c "## cost = o(n)$" config/*.cwt` 显著下降；`dotnet fsi EngineCostRuleParsing.Tests.fsx`
全过；CW279 对含 `opinion` 的岗位 weight 测试用例出告警。

---

## 剩余任务 B：结构反模式校验器（第二梯队未完成部分）

均为 `STLValidation.fs` 新 validator + 新 CW 码（CW282 起）+ diagnostic-codes.md 登记 +
diagnosticI18n.ts 中译 + 回归测试（参考 `CWToolsTests/FolderValidationTests.fs` 既有夹具，
`validateHotContextCost` 的 13 个用例是现成模板）。性能类一律 Information。

### B1. 同步重排岗位的 effect 出现在 `every_owned_planet`/`while` 循环内（建议 Warning）

**事实**（10 号文 ✅）：`add_building`/`remove_building`/`add_district`/`remove_district`/
`set_controller`/`create_pop_group` 每次调用**同步**重跑整星球岗位分配流水线
（`EnsurePopJobsAreUpToDate`）。

**前置依赖——副作用事实需要新的注释通道**：`## cost` 表达的是开销等级，表达不了
"同步触发岗位重排"这种语义事实。建议在 `RulesTypes.fs` 的 `Options` 加一个字段
（如 `## sync_effect = pop_jobs`），在 `RulesParser.fs:482-523` 附近仿照 cost/engine 的解析，
在 effects.cwt 给上述 6 个 effect 标注。validator 从 `configRules` 读该元数据（同 CW279 的
`engineCostMap` 模式）。这正是"事实住规则文件"原则的延伸。

**检测**：`every_owned_planet`/`while`/`for_each_*` 块内（任意深度）出现带该标注的 effect。

### B2. `create_country` 在循环内（建议 Warning，循环嵌套两层以上可 error）

最重 effect（约 2000 行：新建国家 + 对全部国家 Contact + 强制同步 `UpdateDatabaseArrays`）。
事实标注同 B1 的新通道（如 `## sync_effect = heavy`）。

### B3. O(G²) 嵌套迭代器（Information）

人口组/星球级迭代器内再写国级迭代器（如 `every_owned_pop_group = { owner = { any_owned_pop_group ... } }`），
每个 `any_`/`every_`/`count_` 块还深拷贝事件目标+变量容器（02 号文 S3/S7）。
检测：迭代器块内出现 `owner`/`overlord` 等上行 scope 切换、其内再含同族迭代器。

### B4. 权重块里堆 `modifier = { factor = 0 ... }`（Information）

factor=0 后**不提前退出**，剩余 modifier 照常求值（02 号文 S8）。硬性排除应放 potential/allow/limit。
**先查重**：CW235 已是"modifier 值为 0"的 Info 提示（`Validation.fs` 既有），确认覆盖面后决定
是新码还是扩展旧码。

### B5. 高频循环内跨作用域读变量（Information）

`every_owned_*` 循环体内 `check_variable = { value = owner.x }` 或 `which = owner.var`：
每次求值深拷贝一次调用方作用域（08 号文 B3 ✅）。建议外层读一次存临时变量，或先切作用域再查。

### B6. 同一 block 内重复链式作用域跳转（Information）

`prev.prev.from = {...}` 出现 ≥2 次：每段跳转约 1.8KB 栈帧递归构造+拷贝，且每次引用重解析全链
（08 号文 B8 ✅）。建议合并成一个块或嵌套写。

### B7. 可能失败的作用域切换未加 `?`（Information，仅高频上下文）

目标无效且没写 `?` 时，每次求值把整个作用域序列化进错误日志（08 号文 B8-(3) ✅）。
全量扫描误报率高（无法静态知道目标是否可能无效），**建议只在 CW279 的高频宿主上下文内做**，
或做成默认关闭的 experimental validator。

---

## 剩余任务 C：CW279 高频宿主扩展

`validateHotContextCost` 的宿主列表（`STLValidation.fs:1300` 起）目前覆盖 5 类，
以下高频轮询点尚未覆盖（出处：better_stellaris 11/12/13 号文），按同样模式追加即可：

| 宿主 | 文件/块 | 频率 |
|---|---|---|
| 派系 | `common/factions` 的 `can_join_faction`/`is_potential`/`can_pop_group_join_factions` | 每天×人口组×派系类型 |
| 法令 | `common/edicts` 的 potential/allow | 每天每生效法令 3 个 trigger |
| 特殊项目/局势 | abort_trigger/fail_trigger/CanProgress | 每天每国家 |
| 考古遗址 | `visible` | 每天"遗址×全部国家" |
| 科技 | `weight_modifier`/`potential` | 每项研究完成×该领域全部科技×每国家 |
| 星球自动化 | `colony_automation` 的 available/potential | 每月×27 个自动化×殖民地（主线程串行） |
| tooltip | `custom_tooltip`、按钮 potential/allow（interface 文件） | 悬停时每帧 |
| game_rules | `common/game_rules` 全部 80+ 规则（引擎完全不缓存） | 每帧/每次命中 |

注意 game_rules 一条的特殊性：它们被引擎各处直接调用（如 `IsCountryPsionic` 每次武器命中），
值得单独一条文案（"该规则完全不缓存，引擎调用频率极高"）。

---

## 剩余任务 D：inline_script 复用计数提示（Information，global validator）

**事实**（09 号文 ✅）：`inline_script` 每个调用点都复制整份源码 + 每参数全文 ReplaceAll +
完整重新解析，且**不去重**（N 个调用点 = N 棵对象树）；带参数 scripted_* 按参数哈希共享实例。
"把 scripted_trigger 内联提速"是误区（运行时只差 1–2 次虚调用，成本全在加载时）。

**检测**：global validator 统计每个 inline_script 路径的调用点数（含嵌套相乘），
超过阈值（建议 20）报 Information，建议改用带参数的 scripted_trigger/effect 或减少不同参数组合数。
注册进 `STLGame.fs` 的 `globalValidators`。

---

## 明确不做的（避免返工）

- **第四梯队（审计报告视图、MCP 透出 cost 数据、按码调 severity 设置）：用户明确不做。**
- **num_zones** 国家作用域疑似 bug：用户明确说不管。
- 引擎内部问题（tooltip 每帧生成、大纲全量刷新、距离矩阵 O(N²) 重建、modifier 容器线性查找等，
  01/03/04/05 号文）：mod 作者和插件都无法干预，只适合留作知识库。
- 运行时问题（TPdxRef 代号回绕 15-C3、AI 不可复现 15-C6、读档作用域分裂 15-C8、
  flag 名字表 65535 是否真的满）：无法静态检测，只能文档提示。
- 鼓励展开 scripted_trigger：误区，见任务 D 的事实。

## 验证命令速查

```bash
# 子模块库
cd submodules/cwtools && dotnet build cwtools.slnx && dotnet test CWToolsTests
# 根仓库 F#（连带重建子模块源码）
dotnet build src/Main/
# fsx 回归脚本（在各自目录内跑）
cd src/Main && dotnet fsi EngineCostRuleParsing.Tests.fsx && dotnet fsi HoverPerformance.Tests.fsx
# TypeScript
npm run compile && npm run typecheck:test
npx ts-mocha -p tsconfig.json client/test/unit/diagnosticI18n.test.ts
# 文档（README/CONTRIBUTING/ARCHITECTURE 改动时才需要）
npm run build:docs
```

## 相关文档索引

- 分析源：`docs/better_stellaris/`（README 有 Top 18 + 补充发现汇总表）
- 规则语法：`docs/cwt-rule-config.md`；诊断码：`docs/diagnostic-codes.md`
- 设计决策记录：`.agents/notes/implemented/feature/2026-09-29-engine-cost-fact-driven-validators.md`
  及 Owning Note `2026-09-28-hover-engine-cost-and-hardcoded-behaviour.md`
