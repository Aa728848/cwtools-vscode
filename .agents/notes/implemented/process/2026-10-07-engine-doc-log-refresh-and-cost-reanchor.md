# Agent Note: 引擎文档日志刷新与反编译成本重锚（4.5.2）

Status: implemented

## Problem

`docs/better_stellaris/` 与 `## cost` 标注体系在 4.5.0 建立后，有三处随时间失效：

1. **成本标注锚在旧构建**。`tools/engine-cost/extract-engine-cost.cjs` 从 4.5.0 Linux dump 提取，规则里的 `## engine_evidence` 只有函数名，没有任何行号；游戏升到 4.5.2 后，**没有任何机制能证明这些函数仍然存在、仍然含有当初那个循环**。
2. **引擎自带文档的审计口径错误**。语言服务读随规则分发的 `config/logs/*.log`（`STLGame.fs:2286` 读 `modifiers.log`，`RulesLoader.fs:24` 读 `trigger_docs.log`）。曾误判 `modifiers.log` 为"滞后"并整体重生成，**已回滚**；该文件是**刻意裁剪**的，因为项目会动态生成大量 modifier 键。详见同目录 [2026-10-07-engine-doc-log-generated-boundary.md](2026-10-07-engine-doc-log-generated-boundary.md)。
3. **没有任何工具能发现上面两件事**。没有漂移审计，也没有跨版本行号对照。

## Decision

### 1. 成本提取改为携带行号，并用保守合并代替覆盖

`extract-engine-cost.cjs` 的每条记录新增 `line`（证据函数在 dump 中的签名行），使结论可被人工复核。

新增 `tools/engine-cost/merge-engine-cost.cjs` 取代直接覆盖，理由是**提取器只能证明"存在循环"，无法区分"遍历自身容器"与"全银河扫描"**，也无法表达脚本重求值。维护中的规则带有这些细分，直接覆盖会**降级**正确事实。合并策略：

| 情形 | 处理 |
|---|---|
| 规则无 cost、提取有 | 采纳 |
| 两者相同 | 保留，补行号 |
| 提取更具体（`o(1)` → `o(n)`） | 采纳 |
| 规则更具体（`o(n)_galaxy` 等） | 保留规则值 |
| 两者都具体但冲突 | 保留规则值并报告，交人工 |

执行结果：**adopted 3 / refreshed 1186 / upgraded 7 / keptRefinement 22 / conflicts 14 / unverified 23**。7 处升级是提取发现的真实漏标（`has_trait`、`has_ethic`、`has_civic`、`has_edict`、`has_planet_modifier`、`free_jobs`、`has_policy_flag`），其中 `CHasTrait::ActualEvaluate` 已人工复核为线性扫描循环。14 处冲突全部保留维护值（`opinion`/`habitability` 等的 `script_eval` 是提取器看不到的语义）。

合并后 **1,224 条 `## engine_evidence` 携带 `dump L<行号>`**。

### 2. 随包引擎文档：审计而非整体替换

`config/logs/modifiers.log` **未改动**（保持 3,149 条裁剪基线）。曾按"游戏有 45,583 条"整体重生成，后确认该文件是刻意裁剪的——项目通过 CWT 类型模式与 `addGeneratedModifiers` 动态生成 modifier 键，已回滚。`trigger_docs.log` 与 `scopes.log` 经审计**本就同步**（2044/2044、99/99）。

### 3. 新增两个可复现的审计/分析工具

- `tools/engine-cost/audit-config-logs.cjs`：对比随包 `config/logs` 与游戏实时日志，把差集分为 **generated**（CWT 类型模式/硬编码生成器可解释，属预期缺失）、**missing**（真缺口）、**removed**（游戏已移除）。**只读**。第一版把差集一律报成 missing，正是本次误判的根源，已修正口径。
- ~~`tools/perf/analyze-game-startup.mjs`~~：曾加入一个解析游戏 `time.log`/`setup.log` 的启动耗时工具，**已移除**。`tools/perf/` 的既有职责是分析**本扩展 LSP 自身**的性能（`README-lsp.md`、`capture-lsp-trace.ps1`、`lsp-memory-profile.mjs`），把游戏启动分析放进去属于归类错误。保留的 `test:perf` 脚本顺带把原本从未接入任何套件的 `analyze-performance-log.test.mjs`（7 个测试）跑了起来。

### 4. 反编译侧：4.5.2 清单、锚点漂移表与 Windows 符号化

见 `anti_stellaris` 仓库的同批变更（`scripts/dump_inventory.py`、`docs/linux-4.5.2-function-inventory.json`、`docs/anchor-drift-450-452.md`、`_analysis/stellaris_4.5.2_win_symbolized.cpp`）。

## Alternatives considered

- **直接覆盖 `## cost`**：否决。会把 `o(n)_galaxy`、`script_eval` 等人工细分降级为 `o(n)`，属于**信息损失**；实测会回退 22 条细分 + 制造 14 条错误值。
- **提高提取器的复杂度判定能力**（例如按容器类型推断 galaxy 级）：否决。提取器无法知道某个容器运行时有多大，这类判断必须由人写入规则；强行推断会制造看似精确的错误结论。
- **让语言服务直接读游戏 `script_documentation` 目录**：否决。语言服务需要在没有游戏安装（纯规则仓库）时也能工作，且 `CWTools` 的解析入口就是 `configs` 列表；正确做法是刷新随包副本，而不是增加一条运行期依赖。
- **在测试里对完整 4.5.2 `modifiers.log` 做全量断言**：改为先初始化 modifier 分类再解析。原因见下。

## Consequences

- `## engine_evidence` 现在可被逐条复核；规则审阅者可直接跳到 dump 的对应行。
- 跨版本重锚有了可复现工具：`dump_inventory.py` 已用 4.5.0 的 `game_rules` 字段做 **7/7 精确回归**（`CGameRules::InitInstance` 368848 等），确认口径一致后才用于 4.5.2。
- 新增测试 `src/Main/StellarisConfigLogs.Tests.fsx` 必须在解析前初始化 modifier 分类：否则每条记录都触发 `logError`，约 1 MB 的 stderr 会撑爆测试运行器的 `spawnSync` 默认缓冲区并以 **`ENOBUFS`** 失败（现象是测试单独通过、在套件里失败，且失败详情为空）。这是一个容易被误判为"偶发"的坑，已在测试内注释说明。
- 4.5.0→4.5.2 行号漂移**不均匀**（低地址 +6k~+16k，高地址 +540k~+643k），因此**不能对旧行号整体加偏移**，必须逐条重新解析。

### 待人工复核清单（合并报告，勿丢）

合并报告写在 `.rules-sync/engine-cost-merge.json`（该目录被 gitignore），以下为需要人看的稳定清单：

**14 处冲突**（保留规则值，提取器给出不同结论）：

| 命令 | 保留 | 提取器 | 证据 |
|---|---|---|---|
| `has_relation_flag` | `o(log n)` | `o(n)` | `CHasFlagTrigger::ActualEvaluate` |
| `has_valid_civic` | `script_eval` | `o(n)` | `CHasValidCivicTrigger::ActualEvaluate` |
| `pop_amount_percentage` | `script_eval` | `o(n)` | `CPopAmountPercentageTrigger::GetTriggerValue` |
| `used_naval_capacity_percent` | `script_eval` | `o(1)` | `CUsedNavalCapacityPercentTrigger::GetTriggerValue` |
| `exists` | `scope_copy` | `o(n)` | `CEventTarget::ValidateScope` |
| `opinion` | `script_eval` | `o(1)` | `COpinionTrigger::GetTriggerValue` |
| `is_designable` | `semantics` | `o(n)` | `CIsDesignableTrigger::ActualEvaluate` |
| `max_naval_capacity` | `script_eval` | `o(n)` | `CCountry::CalcNavalCapacity` |
| `their_opinion` | `script_eval` | `o(1)` | `CTheirOpinionTrigger::GetTriggerValue` |
| `opinion_level` | `script_eval` | `o(1)` | `COpinionLevelTrigger::ActualEvaluate` |
| `num_researched_techs` | `script_eval` | `o(n)` | `CTechnologyStatus::CalcTotalTechLevels` |
| `num_researched_techs_of_tier` | `script_eval` | `o(n)` | `CTechnologyStatus::CalcNumTechsOfTier` |
| `save_global_event_target_as` | `o(log n)` | `o(n)` | `CGameState::SaveEventTarget` |
| `set_update_modifiers_batch` | `refresh_batch` | `o(1)` | `CSetUpdateModifiersBatch::ExecuteActual` |

**23 处 unverified**（规则有标注但提取器未定位到实现，多为别名/薄封装）：`habitability`、`ethos`、`num_owned_planets`、`has_ascension_perk`、`has_citizenship_type`、`has_living_standard`、`log`、`resource_stockpile_compare`、`compare_distance`、`is_background_planet`、`can_spawn_random_anomaly`、`multiply_variable`、`modulo_variable`、`round_variable_to_closest`、`add_deposit`、`enable_special_project`、`create_cluster`、`create_point_of_interest`、`set_planet_entity`、`set_cloaking_active`、`destroy_astral_rift`、`enable_mission`。

> 冲突项**不是错误**：`script_eval` 表达"重新求值脚本或派生状态"，`o(1)`/`o(n)` 只描述容器扫描，两者正交。提取器看不到脚本求值，因此保留规则值是正确的。