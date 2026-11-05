# Agent Note: Stellaris v4.5.x 规则同步与 CWT 规则补全

Status: implemented

## Problem

在 Stellaris v4.5.0 规则检查中，`rules-sync` 报告（`.rules-sync/stellaris/report/rules-sync-report.json`）发现当前脚本文档基线及 CWT 规则库存在以下漂移与未覆盖字段：

1. **游戏脚本文档命令漂移**：
   - **Triggers**：12 项新增（`can_add_random_non_blocker_deposit`, `can_spawn_random_anomaly`, `has_ethos`, `has_overclock`, `pop_ethic_amount`, `trade_action_value` 等），3 项移除，16 项变更；
   - **Effects**：19 项新增（AI 装甲/护盾/武器偏好设置与重置命令、`pop_force_remove_ethic`、`pop_force_transfer_ethic`、`set_overclock`、`transfer_resources_to_empire` 等），1 项移除，15 项变更；
   - **Modifiers**：7 项新增，4 项移除，11 项分类变更（归入 `Ships`）。
2. **命令参数类型严谨性问题**：
   - 部分新增条目初期使用了 `scalar` 通用占位符，未强类型绑定至原版对应的规则定义（如超频模式 `<mega_overclock>`、舰船角色 `value[ship_size_ship_roles]`、交易行动 `<tradable_actions>`）。
3. **Common 字段级参数未覆盖（共 47 个）**：
   - 缺少类型覆盖目录：`common/policy_categories`（政策分类，6 项定义）、`common/resource_regions`（资源区域，4 项定义）；
   - 缺失 Subtype：`common/game_rules` 缺失 `can_pop_group_auto_migrate_abroad`；`common/on_actions` 缺失 `on_cosmogenesis_exodus_fleet_reached`；
   - 缺少字段定义：`common/megastructure_overclock_types`（3 项）、`common/megastructures`（4 项）、`common/planet_classes`（2 项）、`common/policies`（1 项）、`common/pop_faction_types`（3 项）、`common/ship_sizes`（1 项）、`common/starbase_modules`（1 项）、`common/defines`（28 项）。

## Decision

严格按照两阶段与深入原版定义查验的原则执行同步与重构：

1. **阶段一（Log 文档基线同步）**：
   - 仅针对 report 报告的条目，精确同步 `config/logs/trigger_docs.log`、`config/logs/modifiers.log` 与 `config/logs/localizations.log`（补全 `GetPopsGuidingEthic`），不整量替换以避免引入原版日志格式噪音。
2. **阶段二（CWT 强类型化与字段级全面覆盖）**：
    - **全面清除残余 `scalar` 引用，强化原版类型校验**：
      - `has_overclock` 与 `set_overclock` 强绑定 `<mega_overclock>`；
      - `is_ai_ship_role` 与 `set_ai_ship_roles` 强绑定 `value[ship_size_ship_roles]`；
      - `trade_action_value` 强绑定 `<tradable_actions>`；
      - `AGREEMENT_PRESET_DEFAULT`（`defines.cwt`）强绑定 `<agreement_preset>`，并移动到 `AGREEMENT_PRESET_VASSAL` 相邻位置；
      - `overclock_group`（`megastructures.cwt`）强绑定 `value_set[megastructure_overclock_group]`；
      - `overclock_loc_key`（`megastructures.cwt`）强绑定 `localisation`；
      - `icon`（`policy_categories.cwt`）移除冗余的 `icon = scalar`，保留 `icon = <sprite>`。
    - **纠正巨构（`megastructures.cwt`）字段层级**：
      - 将误嵌在 `overclock_types = { ... }` 内的顶层字段（`nomad_reactivatable`、`custom_tooltip_with_modifiers`、`overclock_loc_key`、`overclock_cooldown`）移至 `megastructure` 顶层属性，`overclock_types` 内仅保留模式引用 `<mega_overclock>`。
    - **补全缺失的 CWT 目录定义**：
      - 新建 `common/policy_categories.cwt`，定义 `type[policy_category]` 与图标配置；
      - 新建 `common/resource_regions.cwt`，定义 `type[resource_region]` 与资源上限参数。
    - **补齐 Subtype 过滤**：
      - `common/game_rules.cwt` 补充 `can_pop_group_auto_migrate_abroad`（作用域：`this = pop_group, root = colony`）；
      - `common/on_actions.cwt` 补充 `on_cosmogenesis_exodus_fleet_reached`。
    - **补齐 47 个未覆盖字段定义**：
      - `common/megastructures.cwt`：补齐 `mega_overclock` 的 `overclock_group`, `system_modifier`, `megastructure_modifier`，以及 `megastructure` 的 `nomad_reactivatable`, `custom_tooltip_with_modifiers`, `overclock_loc_key`, `overclock_cooldown`；
      - `common/planet_classes.cwt`：补齐 `can_be_capital`, `inherit_country_district_modifiers`；
      - `common/policies.cwt`：补齐 `category` 引用 `<policy_category>`；
      - `common/pop_faction.cwt`：补齐 `use_guiding_ethic_as_growth_factor`, `pop_ethics_filter`, `pop_attraction_tag`；
      - `common/ship_sizes.cwt`：补齐 `use_ai_design_role_from = <ship_size>`；
      - `common/starbases_consolidated.cwt`：补齐 `triggered_component_set`；
      - `common/defines.cwt`：在 `NGraphics`、`NCombat`、`NGameplay`、`NAI` 各模块补齐 28 项全局参数。

### v4.5.2 增量同步

```mermaid
flowchart LR
    A["script_documentation 4.5.2"] --> B["rules-sync report"]
    B --> C["阶段一：logs 仅改差异项"]
    C --> D["阶段二：triggers/effects/localisation/common CWT"]
    B -. "误报" .-> E["修扫描器 + 回归测试"]
    D --> F["report 全零"]
    E --> F
```

- **命令**：新增 `pop_ethics_divergence`、`is_preferred_platform_weapons` 与 6 个 `set_/clear_ai_platform_*` effect，类型与同族 starbase 命令一致（`enum[weapon_type]`、`value_field[0.0..1.0]`、`bool`）。`ethos` 原版仍可解析，仅在描述中标注废弃，不删除。
- **作用域收窄只改 log**：`is_archetype`、`is_ship_category/class/size`、`prevent_anomaly` 的 `Supported Scopes` 变化只写入 `trigger_docs.log`，CWT alias 不加 `## scopes`，保持由 log 驱动。
- **本地化**：`GetPopsGuidingEthic` 迁至 `pop_faction`；`Faction` 提升不再接受 `pop_group`（原版文档与本地化均无此用法）。`localisation.cwt` 中手工维护的 `GetIcon = any` 与宽范围 `GetNamePlural` 保留，因为原版大量使用 `[job.GetIcon]` 等职业目标写法；`config/logs/localizations.log` 只作为 report 的 diff 基线，按原版文档同步，不参与运行时校验（详见 v4.5.3 增量）。
- **Common**：`on_actions.cwt` 补 `on_arkship_knights_detox{,_start,_cancelled}`（`this/root = planet, from = fleet`）；`defines.cwt` 补 `NShip.DESIGNER_STARBASE_WEAPON_PREF_MUL = float`；`num_buildings` 补可选 `category = any | enum[building_categories]`。
- **扫描器误报改修工具而不是改规则**：
  - `report.ts` 字段扫描跨行追踪双引号状态：`inline_script` 的 `TRIGGER = "...{` 多行字符串曾让括号深度少算一层，把 `AMOUNT` 及若干修饰符误报为建筑/职业字段。只跨行携带 `"`，避免裸撇号吞掉后续内容。
  - `scope-contracts.ts` 中“中心名词 + 关系从句”（`starbase that changed controller`）优先解析为中心名词，不再因从句中的 `controller` 被判为 `country`；现有 `on_starbase_occupied` 的 `from = starbase` 本就正确。

### v4.5.3 增量同步

v4.5.2 → 4.5.3 是小版本更新，Trigger / Effect / Modifier / Scope 四类命令与 Common 字段级覆盖均无漂移（`folders with findings: 0`），实际变动只有基线与作用域契约两处：

- **本地化文档基线**：4.5.3 原版 `localizations.log` 把 `GetIcon` 与 `GetNamePlural` 从 Country 段移除（`GetNamePlural` 仅保留在 Species 段），`config/logs/localizations.log` 随之删除两行，其余内容与头部时间戳保持原样。
- **`config/localisation.cwt` 不变**：`GetIcon = any` 与宽范围 `GetNamePlural` 继续兜底。原版当前本地化仍有 341 处 `[xxx.GetIcon]` 调用（如 `[enforcer.GetIcon]`、`[coordinator.GetIcon]`），命令本身未被废弃，只是文档不再列出；按废弃删除会产生大量假阳性。
- **作用域契约**：`common/game_rules.cwt` 的 `species_has_uncapped_habitability_on_planet` 与 `species_has_uncapped_habitability_on_ship` 补 `from = country`，与 4.5.3 原版 `#Root/#From/#This` 注释及其体内 `from? = { is_mutation_authority = yes }` 调用一致。
- **Shader ABI 随扫描自动重锚**：`config/shader/` 三份目录由 `shader-abi-sync` 自动改写，471 条 catalog 全部 carried（added=0、dropped=0），13 条 renderer contract 全部保留，差异只有版本戳与 exe 指纹。

### 参数级漂移：扫描器补上命令块参数比对

4.5.3 公告写明 `transfer_pop_amount` 新增 `keep_automodding` 参数，但扫描器当时报 `effect: +0 -0 ~0`。原因是两层：

1. **原版文档根本没更新**：4.5.3 的 `script_documentation/effects.log` 中 `transfer_pop_amount` 仍只有 source / target / amount / percentage / random / growth_category，`keep_automodding` 在文档与脚本中均不存在——Paradox 只改了引擎与 changelog。
2. **扫描器结构上也不可能发现**：`diffKind` 只比对 name / scopes / targetScopes / category / description，`DocRule` 没有 parameters 字段，纯参数变化在任何版本都不可见。

修法与落地：

- `report.ts` 新增 `extractBlockParameters`（导出，供回归测试）：以字符级状态机扫描命令块第一层花括号内的 `key =`，跳注释与引号内容，忽略 `or/and/not/nor/nand` 这类语法词；同一行并列多个块（`{ owner } or { id event_chain owner }`）合并取并集。
- `DocRule.parameters` 与 `addDocRule` 的并集合并负责多段重复条目的累积；`diffKind` 输出独立的 `parameterDrift` 列表，控制台打印 `trigger parameters: ~N` / `effect parameters: ~N`，HTML 报告新增"参数变更"筛选。
- 参数漂移**不进** `changed`，也不作为必须清零的硬门禁：基线日志是人工维护的镜像，允许比原版文档更全，逐条复核比强制归零更符合事实。
- 新增 5 条回归测试（`tools/rules-sync/report.test.ts`）：块内第一层键收集、同一行并列块并集（`is_point_of_interest` 的 `{ owner } or { id event_chain owner }` 形态）、嵌套块与语法词过滤、纯参数变化只进 `parameterDrift`、参数一致时静默。

启用后立刻暴露 5 条历史漏检，逐条处置：

| 条目 | 漂移 | 处置 |
| --- | --- | --- |
| `total_system_workforce_with_job_tag` | 原版文档与脚本（`07_script_values_shroud.txt`）均有 `limit`，规则缺失 | **补规则**：`limit = { alias_name[trigger] = alias_match_left[trigger] }`，与同族 `num_neighbor_systems` 一致；这是玩家照原版书写会被误报的真实缺陷 |
| `create_country` | 4.5.3 文档块被重写：新增 `ruler`、`day_zero_contact`、`exclude_day_zero_contact`、`default_ships`、`randomize_ethos`、`ignore_initial_colony_error`、`released_by/from_country`、`use_hostilities_from`、`origin` 与 flag 内 `use_ship_color`；移除 `nomadic`/`ship_kinds`/`room`/等（原版脚本仍在用，规则保留） | **补规则**：`ruler = scalar \| random`（自由字符串，与同块 `name`/`ship_prefix` 同写法）、flag 内 `use_ship_color = bool`；基线块同步为 4.5.3 原文 |
| `modify_species` | `add_random_trait` → `add_random_species_trait`（含描述） | 基线同步；规则本已正确 |
| `spawn_random_anomaly` | 新增 `surveyor` | 基线同步；规则本已正确 |
| `is_point_of_interest` | 解析器只取第一组花括号，漏掉 `{ } or { }` 第二组 | 修解析器（并列块并集），规则本已正确 |
| `transfer_pop_amount` | 公告新增 `keep_automodding`，文档与脚本均无 | **补规则**：`keep_automodding = bool`（可选），保留在 `alias[effect:transfer_pop_amount]` 内 |

## Alternatives considered

1. **将 `overclock` / `role` / `action` 保持为 `scalar`**：
   - 被否决。原版 `common/` 目录下存在明确的类型系统支持（`<mega_overclock>`、`<tradable_actions>` 与 `value_set[ship_size_ship_roles]`），使用精确引用才能发挥 LSP 补全与校验的最大价值。
2. **忽略 Common 字段级报告**：
   - 被否决。Common 参数漂移会导致语言服务器报出未知属性假阳性警告，覆盖至 0 findings 能确保规则库与 v4.5.0 原版完全同步。
3. **为 `amount` 等误报字段补 CWT 规则，或为 `on_starbase_occupied` 加 errata**：
   - 被否决。前者会在规则中写入并不存在的定义字段；后者只掩盖单点，同类关系从句注释仍会误判。修正扫描器并加回归测试才能根治。
4. **从 `localisation.cwt` 同步删除 `GetIcon` / 收窄 `GetNamePlural`**：
   - 被否决。原版本地化在职业等动态目标上广泛使用这两个命令，删除会产生大量假阳性。
5. **把参数漂移塞进 `changed`，与描述/作用域变更同等归零**：
   - 被否决。基线是人工维护的镜像，允许比原版文档更全（`create_country` 的 `nomadic`、`ship_kinds` 原版脚本仍在用，文档却不再列出）；强行归零会删掉真实字段或把噪声训练成"看到也不看"。
6. **等原版文档更新后靠扫描器自动发现 `keep_automodding`**：
   - 被否决（也不可能）。4.5.3 文档未更新，扫描器对"只存在于公告与引擎"的变更天然失明，必须按公告人工补规则并记录在案。

## Verification

- 运行 `node tools/rules-sync/stellaris-rules-sync.js report --no-open`：
  - `folders with findings: 0`（所有 47 个字段与未覆盖类型全部清零）；
  - `scope contracts missing: 0`；
  - `effect: +0 -0 ~0`；
  - `modifier: +0 -0 ~0`；
  - `scope: +0 -0 ~0`。
- 运行 `npm run compile`：前端 Webview 与 Extension Host 编译全部通过。
- 运行 `npm run typecheck:test`：全量 TypeScript 类型检查通过。
- 参数级漂移：修好后 `report --no-open` 报 `trigger parameters: ~0`、`effect parameters: ~0`（修前为 `~2` / `~3`，其中 5 条是历史漏检）；`npm run test:rules-sync` 50 项通过（含 4 条新增参数回归）；`dotnet fsi src/Main/StellarisConfigLogs.Tests.fsx` 8 项通过（基线日志仍可被 F# 解析）；`npm run typecheck:test` 通过；规则 diff 中新增的 `scalar` 只有 `create_country.ruler`（自由字符串，与同块 `name`/`ship_prefix` 一致）。
- v4.5.3：`report --no-open` 的 trigger / effect / modifier / scope / localisation_command 全为 `+0 -0 ~0`，`folders with findings: 0`，`scope contracts missing=0 mismatch=0 unresolved=0`，`documented-but-required=0`、`documented-but-unmodeled=0`，shader-abi `carried=471 added=0 dropped=0`、contracts `kept=13 dropped=0`。
- v4.5.2：`report --no-open` 所有 diff 均为 `+0 -0 ~0`，`folders with findings: 0`，`scope contracts missing=0 mismatch=0`，`documented-but-unmodeled=0`；`npm run test:rules-sync` 通过（新增多行字符串字段扫描与关系从句作用域两条回归测试）；规则 diff 中无新增 `scalar`。
