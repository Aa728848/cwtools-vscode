---
name: stellaris-targeting-weights
description: >-
  Stellaris 4.5.2 舰船索敌与开火目标权重机制知识库。用于回答索敌 / 目标权重 / target weight / targeting / 开火目标（fire target）选择、舰船主目标（ship main target）、盾甲仇恨（shield & armor aggro）传言、`target_weights` 与 `ship_target_weight_mult` 怎么写、以及 `ai_weight` 与战斗索敌权重的区别等一切问题。内置两阶段乘法链公式与 10/50 tick 节流、19 个 defines 速查、原版与 CWT 规则取证路径、十条常见误区。凡出现"为什么我的船不打那个目标""怎么让 AI 优先打小型舰""索敌权重怎么调"之类提问，先加载本技能再回答。
allowed-tools: query_cwt_schema, query_rules, search_rule_capabilities, explain_scope, query_project_knowledge, explore_pdx_project, compare_definition_with_vanilla, grep, read_file
capability-domain: both
---

# Stellaris 舰船索敌权重机制技能 (Stellaris Targeting Weights Skill)

本技能内置 Stellaris 4.5.2（Cygnus，二进制 hash `32709cf254181b032b1b309a6ea09776`）的舰船索敌机制解读，覆盖 Stage 1 舰船层权重 `W(ship)`、Stage 2 武器层分数 `S(weapon)`、节流周期、`use_ship_main_target` 分派、全部脚本可调点与取证路径。

一手来源为反编译分析整理稿《群星索敌权重计算公式 4.5.2》，本仓库内的机制文档见 [docs/stellaris-targeting-weight-4.5.2.md](../../../docs/stellaris-targeting-weight-4.5.2.md)，伤害侧姊妹篇见 [docs/better_stellaris/16_combat_damage_resolution.md](../../../docs/better_stellaris/16_combat_damage_resolution.md)。

> **阅读约定**：引擎内部使用定点数，`F = 100000`（脚本中的 1.0），除法为 C 风格向零截断。本文公式一律给出**归一化形式**（把定点除法当实数除法）。"修正后的量"指经 modifier 系统计算后的值。行号与偏移以 4.5.2 dump 为准，**游戏更新后行号整体失效**，因此本文只记函数名与行为，不把行号当契约。

---

## 1. 机制精要

### 1.1 总览：两阶段、取最大值、带错峰节流

索敌是 **argmax（取最大值而非加权抽签）** 的两阶段过程：

```text
敌方候选船（同星系、可攻击、非 FTL/隐身）
        │
        ▼
┌─ Stage 1 舰船层 ─────────────────────────────┐
│ CShipTargeting::ComputePotentialTargetScore  │
│ W(ship) = 尺寸项 × 闪避项 × 距离项 × 预置权重 │
│           × 残血项 × 无武装/星基项 × 随机扰动 │
│ （含"打不中即整目标剔除"的否决条件）           │
└──────────────────────────────────────────────┘
        │  CShipTargeting::CalcBestTarget → 舰船主目标（argmax + 节流）
        ▼
┌─ Stage 2 武器层 ─────────────────────────────┐
│ CWeaponComponentTargeting::ComputePotential… │
│ S(weapon) ≈ 期望伤害 ΣD × 命中率 p × 预置权重 │
│             × 斩杀加成 × 无武装降权 ＋ wk      │
└──────────────────────────────────────────────┘
        │  最终：当前目标 ×1.1 / 近期目标 ×0.3 后 argmax
        ▼
   每门武器各自的开火目标
```

- **Stage 1 回答"这个目标好不好打、值不值得打"**；
- **Stage 2 回答"这门武器打它能造成多少有效伤害"**；
- 两者**不是**相乘，而是各自 argmax 之后叠加粘性项再比较。武器模板写 `use_ship_main_target = yes` 时武器直接沿用舰船主目标（需在射程与射界内），**Stage 2 不生效**；`ENERGY_LANCE`（泰坦光矛）写的恰恰是 `no`，所以它完全按武器层分数自选目标。

### 1.2 Stage 1：舰船层乘法链 W(ship)

前置条件：候选与自己同星系、可被攻击、不在跳跃/隐身位掩码中，否则直接无效。

```text
σ′ = min(σ, σmax)                σ = 候选船 size_multiplier，σmax = 10
Ŵ1 = 1 / (1 + σ′·κsize)          κsize = 0.03          尺寸项（单调递减，赋值非累乘）

τ  = atrk·κtrk                    κtrk = 2.0            攻击方追踪放大
ε  = 候选闪避（0..1，上限 SHIP_MAX_EVASION = 0.9）
Δ  = ε − τ
Ŵ2 = Δ > 0 ? Ŵ1 / (1 + Δ·κev) : Ŵ1   κev = 2.0        追踪–闪避项（Δ ≤ 0 时无惩罚）

Ŵ3 = Ŵ2 × max(1 − d·κd, dmin)    κd = 0.002，dmin = 0.10   距离项（d ≥ 450 触下限）

Ŵ4 = Ŵ3 × ŵtgt                   ŵtgt = ship_target_weight_mult 修正值 + (1 + ρ)，ρ ∈ [0, 1)

Ŵ5 = Ŵ4 × (h < θh ? κh : 1)      θh = 0.5，κh = 1.5           残血目标更优先（收人头）
       × (目标无伤害能力 ? κun : 1)  κun = 0.005
       × (恒星基地/巨构且非当前主目标 ? κsb : 1)  κsb = 0.75

Ŵ(ship) = Ŵ5 × (1 + r·κr)        r ∈ [0, 1)，κr = 3.0  → 乘数 ∈ [1, 4)
```

要点：

- **尺寸项是赋值不是累乘**，值域 (0, 1]。护卫舰 σ=5 得 0.870；泰坦级 σ≥10 封顶得 0.769。
- **ŵtgt 里的 ρ 是开战瞬间每艘船各掷一次的随机量**（`CShip::OnCombatStarted` 写入，整场战斗不变，战后复位）。所以两条设计完全相同的船，每场战斗也会被赋予不同的"被偏爱度"（实测 1.326/1.486 vs 1.561/1.379）。
- **随机扰动 κr = 3.0 幅度极大**（最高 4 倍），是"为什么索敌看起来不稳定"的主因之一。`CalcBestTarget` 默认传 `useRandom = true`。
- `ship_target_weight_mult` 是**船级 modifier**（ModifierType 0x6e），来源包括 ship_sizes 定义与光环类组件（原版例子：`00_dsc_auras.txt` 的 0.50、`29_nomads_dlc_ships.txt` 的 −0.5）。

### 1.3 整目标否决条件（不是低权重，是剔除）

```text
Δ > 0 ∧ σatt ≥ 8 (σavoidmin) ∧ Δ ≥ 0.7 (Tavoid)
    ∧ 目标舰队中存在至少一艘"可命中"（εq − τ < Tavoid）的船
      → 直接 return 0（整目标从候选中剔除）
```

即：**大船对高闪避小船"懒得追"**，只要对方舰队里还有打得中的目标，就把打不中的那艘直接踢出候选。它不参与 argmax，不是"排最后"。

### 1.4 节流：10 / 50 tick 错峰

- 舰船**已有有效主目标**时，只在 `(TotalTicks + shipID) mod fp == 0` 的 tick 重算权重；**没有有效主目标时才立刻重算**。
- `fp = 50` 当 `targetFocus = 1`，否则 `fp = 10`。
- **索敌权重不是每 tick 重算的**。改 define 或改 modifier 不会"立即生效于每一帧"，实测复现时要按 tick 粒度对齐。
- `targetFocus` 取自设计（ship design）growth stage +0x128，IsConfused 时为 1（此时节流周期拉长到 50 tick 且失去当前目标粘性）。规则层对应字段是武器组件的 `target_focus = enum[component_target_focus] { single, spread }`——**枚举值到引擎 0/1 的映射未证实**（见未证实项 V2）。

### 1.5 Stage 2：武器层分数 S(weapon)

```text
ΣD = Ds + Da + Dh                三层期望伤害分摊之和（Ds/Da/Dh 各自乘 ms/ma/mh 倍率）
p  = clamp(accw − clamp(evasion − τw, 0, 1), 0, 1)     命中率（accw/τw 为武器模板字段）

S0 = ΣD × p × ŵtgt               ŵtgt 即 Stage 1 的预置权重，含开战随机 ρ
Vtgt ≤ Dh（船体分量可单发斩杀）  → S1 = 1.5 × S0
目标无还手能力（面板 DPD ≤ 0）  → S2 = κun (0.005) × S1
S(weapon) = S2 + wk              wk = target_weights 表中该目标船尺寸名对应的值
```

- 伤害取**已套修正的**武器模板值（攻击方 + 控制方 + 目标三方 modifier 就地改写 `SAttackInfo`），基础伤害取区间中点（索敌路径 `useRandom = false`）。
- `NCombatRules::CalcDamage` 按护盾/装甲/船体三层分摊，穿透减去目标硬化后夹 [0,1]。细节与武器字段 ↔ 结构偏移对照见 16 号文档 §3–§5、§15。
- `size_damage_factor`：仅当 > 0 时按目标尺寸放大伤害（clamp(σ, 1, 100)，上限 MAX_DAMAGE_SCALING = 100）。
- **关键反直觉点**：层分量不被该层存量夹住（只有从剩余伤害里扣减的量才被 min 夹住），所以**带盾/带甲的目标算出来的 ΣD 反而更大**——实测同一门武器对"225 盾 + 225 甲 + 240 船体"目标的 ΣD 是对"720 船体 0 盾 0 甲"目标的 1.58×~2.65×。这就是"盾甲吸引仇恨"传言的根因；**唯一有效反制是高闪避**（压低 p）。

### 1.6 use_ship_main_target 三路分派

`CWeaponComponentTargeting::CalcBestTarget` 按序分派：

1. 组件模板标记为舰载机/打击机（模板 +0x12e0 == 2）→ `CStrikeCraftTargeting::CalcBestTarget`；
2. `use_ship_main_target` 置位 → **沿用舰船主目标**（前提：在射程与射界内，即满足 `firing_arc` / `min_range` / `range`）；
3. 否则 → 每门武器自己按 S(weapon) argmax。

因此：**舰船层只决定"主目标是谁"，管不到 `use_ship_main_target = no` 的武器**（泰坦光矛正是这一类）。

### 1.7 最终粘性与近期惩罚

`CalcBestWeaponComponentTarget` 在 argmax 前施加两项乘数：

```text
候选 == 当前主目标（且 targetFocus = 0）→ ×Mcur (1.1)
候选在"最近目标记忆"（10 个）中且非最新一项 → ×Mrec (0.3)
```

舰船层与武器层口径一致：`Mcur` 只在 targetFocus = 0 时施加。

---

## 2. modder 可调点速查

### 2.1 defines（`common/defines/00_defines.txt`，NCombat / NShip 块）

下表 19 条即"索敌可调 defines"全集，规则侧位于 `submodules/cwtools-stellaris-config/config/common/defines.cwt:3754-3836`，目前全部仅有 `float` 声明、**无 `###` 公式文档**。

| # | 符号 | define 名 | vanilla | 作用环节 |
|---|---|---|---|---|
| 1 | κsize | `COMBAT_SHIP_TARGETING_SIZE_MULT` | 0.03 | 尺寸项斜率（defines.cwt:3780） |
| 2 | σmax | `COMBAT_SHIP_TARGETING_SIZE_MAX` | 10 | 尺寸封顶（:3782） |
| 3 | κtrk | `COMBAT_SHIP_TARGETING_TRACKING_MULT` | 2.0 | 追踪放大（:3784） |
| 4 | κev | `COMBAT_SHIP_EVASION_TARGETING_WEIGHT` | 2.0 | 闪避惩罚斜率（:3786） |
| 5 | θh | `COMBAT_SHIP_LOW_HEALTH_THRESHOLD` | 0.5 | 残血阈值（:3788） |
| 6 | κh | `COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT` | 1.5 | 残血倍率（:3790） |
| 7 | κd | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT` | 0.002 | 距离衰减（:3792） |
| 8 | dmin | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN` | 0.10 | 距离下限（:3794） |
| 9 | κun | `COMBAT_SHIP_UNARMED_TARGETING_WEIGHT` | 0.005 | 无武装降权（:3796） |
| 10 | κsb | `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT` | 0.75 | 星基/巨构降权（:3798） |
| 11 | σavoidmin | `COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE` | 8 | 否决判据的攻击方尺寸门槛（:3800） |
| 12 | Tavoid | `COMBAT_SHIP_EVASION_AVOID_THRESHOLD` | 0.7 | 否决判据的 Δ 门槛（:3802） |
| 13 | κr | `RANDOM_TARGETING_WEIGHT` | 3.0 | 随机扰动幅度，末项乘数 ∈ [1, 1+κr)（:3776） |
| 14 | Mcur | `SHIP_CURRENT_TARGET_MULTIPLIER` | 1.1 | 当前目标粘性（:3770） |
| 15 | Mrec | `SHIP_RECENT_TARGET_PENALIZER` | 0.3 | 近期目标惩罚（:3772） |
| 16 | — | `NUMBER_OF_TARGETS_TO_REMEMBER` | 10 | 近期目标记忆长度（:3774） |
| 17 | — | `SHIP_MAX_EVASION`（NShip 块） | 0.9 | 闪避上限 |
| 18 | — | `MAX_DAMAGE_SCALING`（NShip 块） | 100 | size_damage_factor 放大上限 |
| 19 | — | `MISSILE_RETARGET_CHANCE_START` / `_REDUCTION` | — | 导弹重索敌（defines.cwt:3825/3827，本文未展开） |

### 2.2 船级与修饰符

- `ship_target_weight_mult`（modifier，类别含 Military Ships 等，`config/logs/modifiers.log:119`）→ 直接进入 ŵtgt，与开战随机 ρ **相加**。
- 按船级的别名 `shipsize_$_target_weight_mult`（`ship_sizes.cwt:85`）。
- `ship_sizes` 的 `combat_size_multiplier`（σ）、`default_behavior = <ship_behavior>`；`ship_behaviors` 的 `preferred_attack_range` / `attack_move_pattern` 控制走位，**间接影响距离项 d 的分布**，从而影响索敌。

### 2.3 武器组件模板（`common/component_templates/`，规则 subtype `weapon_component_template`）

| 字段 | 进入公式的位置 | 规则现状（components_consolidated.cwt 行号） |
|---|---|---|
| `min_damage` / `max_damage` | ΣD 基础（区间中点） | float（:586 注释，CSV 反填批） |
| `hull_damage` / `shield_damage` / `armor_damage` | mh / ms / ma 三层倍率 | float（:590-598 等），无公式文档 |
| `shield_penetration` / `armor_penetration` | 穿透（减硬化后夹 [0,1]） | float，无文档 |
| `accuracy` / `tracking` | p 与 τw；引擎要求 0..1（有 "should be between 0.0 and 1.0" 报错文案） | float（:604-608），**无范围诊断** |
| `size_damage_factor` | 按目标尺寸放大（上限 100） | float（:624） |
| `use_ship_main_target` | 选目标分派（§1.6 第 2 支） | bool（:118），无文档 |
| `target_weights = { … }` | S 的**加法项** wk（§2.4） | **键为 `scalar = float`，无类型无文档**（:566-569） |
| `targetable_ship_sizes = { … }` | 候选过滤（前置条件） | **`<ship_size>` 强类型**（:629-632）——与上行不对称 |
| `target_focus` | 节流周期 / Mcur 是否生效（映射未证实） | `enum[component_target_focus]`（:394, :778-781） |
| `firing_arc` / `min_range` / `range` | 沿用主目标时的射程/射界约束 | float（:558-560） |

### 2.4 `target_weights` 是加法项，不是倍率

```text
S(weapon) = S2 + wk          wk = target_weights 表中该目标船尺寸名对应的值
```

**写在武器模板里的"优先打某类目标"可以盖过整条乘法链**：给 `target_weights = { <某小船> = 一个很大的数 }` 即可强制优先。用法与直觉的"倍率"**相反**——直觉会写成 0.1/10，实际是"加多少"。

### 2.5 不同层的其它开关（不要混用）

- `game_rules.cwt` 的 `calc_planet_specific_war_attack_priority` 等：**战争层面**优先级，与本公式不同层。
- effects 的 `set_ai_*_weapon_preference` 系列：**AI 配船偏好**，不是战斗索敌。
- `ai_weight`：AI 建造/决策权重，出现在 traits / zones / starbases 等规则里，**与索敌无关**（见误区 2）。

---

## 3. 取证路径

### 3.1 CWT 规则文件（本仓库内，只读）

| 用途 | 路径 |
|---|---|
| 19 个 defines 声明 | `submodules/cwtools-stellaris-config/config/common/defines.cwt`（:3754-3836） |
| 武器组件字段 | `submodules/cwtools-stellaris-config/config/common/components_consolidated.cwt`（:118 / :394 / :566 / :586 / :604-608 / :624 / :629-632 / :778-781） |
| 船级权重别名 | `submodules/cwtools-stellaris-config/config/common/ship_sizes.cwt`（:85） |
| 走位行为 | `submodules/cwtools-stellaris-config/config/common/ship_behaviors.cwt` |
| 修饰符来源 | `submodules/cwtools-stellaris-config/config/logs/modifiers.log`（:119） |

### 3.2 原版（vanilla）目录

`D:\Steam\steamapps\common\Stellaris\common` —— 反查强类型、补 `###` 文档、验证未证实项时的**一手事实来源**：

- `common/defines/00_defines.txt` → 19 个 define 的原版真实取值；
- `common/component_templates/*.txt` → 武器字段原版写法、`use_ship_main_target`、`target_weights` 的合法键集合（已证实：ship_size id）、`target_focus` 枚举取值（V2）；
- `common/ship_sizes/*.txt` → `combat_size_multiplier`、光环类 `ship_target_weight_mult`。

### 3.3 本技能可用的只读工具（allowed-tools 核对表）

| 工具 | 用途 | registry.ts 行号（联合类型 / 分组 / 只读依据） |
|---|---|---|
| `query_cwt_schema` | 查 CWT 规则 schema（字段类型、alias） | 联合类型 :7；BASE_READ :338；PDX_RULE_TOOLS :386 → effect `workspace_read`（:506-514）→ isReadOnly |
| `query_rules` | 查规则定义内容 | 联合类型 :7；BASE_READ :338；PDX_RULE_TOOLS :386 → 同上 |
| `search_rule_capabilities` | 搜索规则能力/触发器效果 | 联合类型 :7；BASE_READ :338；PDX_RULE_TOOLS :387 → 同上 |
| `explain_scope` | 解释 scope 与支持域 | 联合类型 :7；BASE_READ :338；PDX_RULE_TOOLS :387 → 同上 |
| `query_project_knowledge` | 查项目内策展知识包（机制说明入口） | 联合类型 :8；BASE_READ :339；PDX_PROJECT_TOOLS :381 → 同上 |
| `explore_pdx_project` | 跨文件结构化探索 mod 工程 | 联合类型 :8；BASE_READ :338；PDX_PROJECT_TOOLS :382 → 同上（lsp-limited） |
| `compare_definition_with_vanilla` | mod 定义 vs 原版定义对比（字段改动核对） | 联合类型 :8；BASE_READ :338；PDX_PROJECT_TOOLS :383 → 同上（lsp-limited） |
| `grep` | 全文检索 mod 与规则文件 | 联合类型 :10；BASE_READ :339；NAVIGATION_TOOLS :395；ALWAYS_DISCLOSED :407 → 同上 |
| `read_file` | 读取具体文件/行区间 | 联合类型 :12；BASE_READ :341；NAVIGATION_TOOLS :395；ALWAYS_DISCLOSED :407 → 同上 |

判定依据：`registry.ts:579-583` —— `isReadOnly = !MODE_CONTROL && name !== 'ask_user_question' && (effect === 'workspace_read' || effect === 'network' || (effect === 'none' && !mutating && !ORCHESTRATION && !TEAM) || team_task_list || team_members)`。上表 9 个工具全部命中 `BASE_READ` 分支 → `effect = 'workspace_read'` → `isReadOnly = true`。

**曾被剔除的候选**：`query_blackboard` 虽在联合类型（:21）与 ORCHESTRATION（:361）中存在，但 effect 为 `'none'` 且被 ORCHESTRATION 排除，按 :581 的判定式 `isReadOnly = false`，**不是只读工具**，故不在本技能白名单内。写本技能时不要把它加回来。

### 3.4 机制文档

- 本技能主文档：`docs/stellaris-targeting-weight-4.5.2.md`（机制解读 + 差距分析 + 路线图）
- 伤害结算：`docs/better_stellaris/16_combat_damage_resolution.md`（ΣD 三层分摊、武器字段 ↔ 结构偏移对照）
- 舰队寻路 AI：`docs/better_stellaris/04_fleet_pathfinding_ai.md`（:97 仅一行提及索敌节流，本文补齐）
- 规则维护 SOP：`.agents/skills/stellaris-rules-sync/SKILL.md`（原版反查 → 强类型 → 验证门禁）

---

## 4. 常见误区十条（按设计文档 §7）

1. **"盾甲吸引仇恨"是结果不是机制**：根因是 ΣD 的三层分摊不夹各层存量（§1.5），不是引擎写了"优先打盾甲船"。
2. **`ai_weight` ≠ 索敌权重**：`ai_weight` 是 AI 建造/决策权重（出现在 traits/zones/starbases 等规则里）；战斗索敌的脚本抓手是 `ship_target_weight_mult`、`target_weights` 和 §2.1 的 defines。**回答时必须显式区分这两者。**
3. **索敌不是每 tick 重算**：10/50 tick 错峰 + 无有效主目标才立即重算（§1.4）。改 define 不会"立即生效于每一帧"。
4. **`target_weights` 是加法项**：可以碾压整条乘法链（§2.4），用法与直觉的"倍率"相反。
5. **同设计不同命运**：开战随机量 ρ ∈ [0,1) 让同设计舰船每场战斗的 wtgt 都不同（§1.2）。
6. **打不中的小船会被大船整体无视**：满足否决条件即 return 0（§1.3），不是低权重是**剔除**。
7. **斩杀加成看船体分量**：判据是 Dh ≥ 当前船体 Vtgt，不是总伤（§1.5）。
8. **`use_ship_main_target = no` 的武器完全自选目标**：舰船层只决定"主目标是谁"，管不到它（§1.6）。
9. **CanDoDamage 看面板 DPD**：是设计界面显示的数字，不是真实伤害（§1.5）。
10. **随机扰动幅度极大**：κr = 3.0 意味着末项乘数 ∈ [1,4)（§1.2）；调试索敌行为时先把它关掉再谈。

---

## 5. 工作纪律

1. **先查规则与 vanilla，再回答。** 任何"某 define 是什么值""某字段叫什么""目标是不是这样选"的断言，都必须先在 `submodules/cwtools-stellaris-config/config/**` 或 `D:\Steam\steamapps\common\Stellaris\common` 里找到出处；找不到就说"未证实"，**不要凭印象给数字**。
2. **区分层次，不要跨层归因。** 战争优先级（`calc_planet_specific_war_attack_priority`）、AI 配船偏好（`set_ai_*_weapon_preference`）、AI 决策权重（`ai_weight`）与战斗索敌是四套东西。
3. **数值问题走 §2 速查表 + 取证复核双确认**：先按公式算出量级，再用 `read_file` / `grep` 核对 vanilla 的真实取值，最后才下结论。
4. **给出可复现的实验条件**：涉及节流（10/50 tick）、开战随机 ρ、随机扰动 κr 时，必须说明"结果依赖 tick 对齐与战斗内随机量"，不要把单次观测当结论。
5. **未证实项要显式标注**：`target_focus` 枚举到 targetFocus 0/1 的映射（V2）当前**仍未证实**，引用时必须带上"未证实"标签或先去原版反查。（V1/V6 已于 2026-10-13 解决，见附录 B）
6. **规则改动走 stellaris-rules-sync SOP**：要新增/补全规则定义（给 define 加 `###` 公式文档、给 `target_weights` 键做 `<ship_size>` 强类型）时，按 `.agents/skills/stellaris-rules-sync/SKILL.md` 的原版反查 → 强类型 → 验证门禁流程执行；**严禁滥用 `scalar`**。
7. **本技能只读。** 需要新增分析能力（`query_targeting_weight` 之类工具）时，那是扩展层任务，走路线图 P2-2 的五处同步（definitions / registry / agentTools / toolPhrases / test），不要在回答里假装已有该工具。

---

## 附录 A：符号表

| 符号 | 含义 | 来源 |
|---|---|---|
| F | 定点单位 = 100000（脚本 1.0） | 反编译整理稿 §0 |
| σ / σ′ | 候选尺寸倍率 / min(σ, σmax) | ship_sizes |
| atrk / τ | 攻击方追踪字段 / 归一化追踪 | 攻击方 |
| ε | 候选闪避（0..1，上限 0.9） | 候选 |
| d | 候选距离 | 战斗状态 |
| ŵtgt | 预置权重 = ship_target_weight_mult + (1 + ρ) | modifier + 开战随机 |
| ρ | 开战随机量 ∈ [0,1)，全场不变 | `CShip::OnCombatStarted` |
| h / θh | 目标血量百分比 / 残血阈值 0.5 | — |
| ΣD / p | 三层期望伤害和 / 命中率 | `CalcDamage` / `CalcChanceToHit` |
| wk | `target_weights` 表命中项（**加法**） | 武器模板 |
| Mcur / Mrec | 当前目标 1.1 / 近期目标 0.3 | defines |
| κ 系列 | 各 define 系数，见 §2.1 | defines |
| fp | 节流周期 10 或 50 tick | `(TotalTicks + shipID) mod fp` |

## 附录 B：未证实项（引用前必须标注或先反查）

| # | 未证实项 | 验证方式 |
|---|---|---|
| V1 | ~~`target_weights` 合法键集合~~ | ✅ 已解决（2026-10-13）：原版 25 处用法去重 18 键全部是 ship_size id（`000_documentation.txt:81` 注释证实）；CWT 规则已把键收紧为 `<ship_size> = float` |
| V2 | `target_focus`（single/spread）到引擎 targetFocus 0/1 的映射 | 原版样本 + dump 反查 |
| V6 | ~~`fire_rate` / `burst_*` / `damage_degrade_per_tier` 等相邻字段是否缺失~~ | ✅ 已解决（2026-10-13）：6 个字段在 4.5.2 vanilla 全部不存在（`fire_rate` 的 170 处命中均为 modifier 名），属其它版本的字段，无需补规则 |
| — | 逐 tick 权重的实测复现 | 关闭随机扰动（κr 视为 1）并按 shipID 错峰对齐后再取样 |

## 附录 C：数值算例（可用于自检公式理解）

场景：两条船 + 一门 `ENERGY_LANCE`（acc 0.85、trk 0；mh 1.5 / ms 0.5 / ma 2.0）。

| 量 | 护卫舰 | 雷击舰 | 复算 |
|---|---|---|---|
| W1 尺寸 | 0.8696 | 0.8065 | 1/(1+5×0.03) ✓；1/(1+8×0.03) ✓ |
| 闪避因子 | 0.4545 | 0.5411 | 1/(1+0.6×2) ✓；1/(1+0.424×2) ✓（**单因子**，非累计） |
| W3 距离因子 | 0.856 | 0.871 | 1−72×0.002 ✓；1−64.5×0.002 ✓ |
| W(ship) | 0.528 | 0.524 | 0.8696×0.4545×0.856×1.561 ✓；0.8065×0.5411×0.871×1.379 ✓ |
| p 命中率 | 0.250 | 0.426 | 0.85−0.6 ✓；0.85−0.424 ✓ |

结论复核成立：舰船层两条船基本持平（0.99），武器层护卫舰高 1.76×（ΣD 被盾甲顶高 2.65×，盖过闪避带来的 p 劣势）。因 `ENERGY_LANCE` 的 `use_ship_main_target = no`，实际按武器层走 → 优先打带盾甲的护卫舰。
