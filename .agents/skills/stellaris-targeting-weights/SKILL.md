---
name: stellaris-targeting-weights
description: >-
  Stellaris 4.6.0 舰船索敌与开火目标权重机制知识库（一手反编译源码核验版）。用于回答索敌 / 目标权重 / target weight / targeting / 开火目标（fire target）选择、舰船主目标（ship main target）、盾甲仇恨（shield & armor aggro）传言、`target_weights` 与 `ship_target_weight_mult` 怎么写、`target_focus` single/spread 区别、以及 `ai_weight` 与战斗索敌权重的区别等一切问题。内置两阶段乘法链公式与 10/50 tick 节流、19 个 defines 速查（含 4.6 新增不活跃强制脱战）、原版与 CWT 规则取证路径、十条常见误区。凡出现"为什么我的船不打那个目标""怎么让 AI 优先打小型舰""索敌权重怎么调"之类提问，先加载本技能再回答。
allowed-tools: query_targeting_weight, query_cwt_schema, query_rules, search_rule_capabilities, explain_scope, query_project_knowledge, explore_pdx_project, compare_definition_with_vanilla, grep, read_file
capability-domain: both
---

# Stellaris 舰船索敌权重机制技能 (Stellaris Targeting Weights Skill)

本技能内置 **Stellaris 4.6.0**（Corona Borealis `5d0adbc59353f1e9b085e0a2c4cb3d1a`）一手反编译源码核验后的舰船索敌机制解读，覆盖 Stage 1 舰船层权重 `W(ship)`、Stage 2 武器层分数 `S(weapon)`、节流周期、`target_focus` (`single`/`spread`) 行为、`use_ship_main_target` 分派、全部脚本可调点与取证路径。

本仓库内的完整机制文档见 [docs/better_stellaris/17_ship_targeting_weights.md](../../../docs/better_stellaris/17_ship_targeting_weights.md)，伤害侧姊妹篇见 [docs/better_stellaris/16_combat_damage_resolution.md](../../../docs/better_stellaris/16_combat_damage_resolution.md)。

> **阅读约定**：引擎内部使用定点数，`F = 100000`（脚本中的 1.0），除法为 C 风格向零截断。本文公式一律给出**归一化形式**（把定点除法当实数除法）。"修正后的量"指经 modifier 系统计算后的值。本技能记录函数名与已核验行为，不把跨版本易漂移的 dump 行号当契约（4.6.0 具体行号与偏移见 17 号文档附录 B）。

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
│           × 残血项 × (无武装或星基互斥项)     │
│           × 随机扰动                         │
│ （含"打不中即整目标剔除"的否决条件）           │
└──────────────────────────────────────────────┘
        │  CShipTargeting::CalcBestTarget
        │  → single: 当前×1.1 / spread: 记忆×0.3 → argmax + 节流 → 舰船主目标
        ▼
┌─ Stage 2 武器层 ─────────────────────────────┐
│ CWeaponComponentTargeting::ComputePotential… │
│ S(weapon) = 期望伤害 ΣD × 命中率 p × 预置权重 │
│             × 斩杀加成(Dh>=Vtgt) × 无武装降权 │
│             ＋ wk (target_weights 加法)       │
└──────────────────────────────────────────────┘
        │  CalcBestWeaponComponentTarget
        │  → single: 当前×1.1 / spread: 记忆×0.3 → argmax
        ▼
   每门武器各自的开火目标
```

- **Stage 1 回答"这个目标好不好打、值不值得打"**；
- **Stage 2 回答"这门武器打它能造成多少有效伤害"**；
- 两者**不是**相乘，而是各自独立 argmax（均按 `target_focus` 施加 `Mcur` 或 `Mrec`）。武器模板写 `use_ship_main_target = yes` 时武器直接沿用舰船主目标（需在射程与射界内），**Stage 2 不生效**；`ENERGY_LANCE`（泰坦光矛）写的恰恰是 `no`，所以它完全按武器层分数自选目标。

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

# 无武装与星基为 if / else if 互斥分支（4.6.0 源码一手证实）：
if 目标无伤害能力 (¬CanDoDamage):
    Ŵ6 = Ŵ5 × κun (0.005)
else if 恒星基地/巨构且非当前有效主目标:
    Ŵ6 = Ŵ5 × κsb (0.75)
else:
    Ŵ6 = Ŵ5

Ŵ(ship) = Ŵ6 × (1 + r·κr)        r ∈ [0, 1)，κr = 3.0  → 乘数 ∈ [1, 4)
```

要点：

- **尺寸项是赋值不是累乘**，值域 `(0, 1]`。护卫舰 `σ=5` 得 `0.8696`；泰坦级 `σ≥10` 封顶得 `0.7692`。
- **无武装与星基降权互斥**：一座无武装的恒星基地只乘 `0.005`，**不会**再叠乘 `0.75`。
- **`ŵtgt` 里的 `ρ` 是开战瞬间每艘船各掷一次的随机量**（`CShip::OnCombatStarted` 写入 `ship + 0xf48`，整场战斗不变，`OnCombatEnded` 复位为 `1.0`）。所以两条设计完全相同的船，每场战斗也会被赋予不同的"被偏爱度"。
- **随机扰动 `κr = 3.0` 幅度极大**（最高 4 倍），是"为什么索敌看起来不稳定"的主因之一。`CalcBestTarget` 默认传 `useRandom = true`，且**只作用于阶段一**。
- `ship_target_weight_mult` 是**船级 modifier**（4.6.0 ModifierType `0x71`），来源包括 `ship_sizes`、静态修正与光环类组件（原版例子：`00_dsc_auras.txt` 的 `0.50`、`29_nomads_dlc_ships.txt` 的 `−0.5`、`25_static_modifiers_nomads.txt` 的 `10`）。

### 1.3 整目标否决条件（不是低权重，是剔除）

```text
Δ > 0 ∧ σatt ≥ 8 (σavoidmin) ∧ Δ ≥ 0.7 (Tavoid)
    ∧ 目标舰队中存在至少一艘"可命中"（εq − τ < Tavoid）的船
      → 直接 return 0（整目标从候选中剔除）
```

即：**大船对高闪避小船"懒得追"**，只要对方舰队里还有打得中的目标，就把打不中的那艘直接踢出候选。它不参与 argmax，不是"排最后"。

### 1.4 节流与 `target_focus`（4.6.0 源码一手证实）

- 舰船**已有有效主目标**时，只在 `(TotalTicks + shipID) mod fp == 0` 的 tick 重算权重；**没有有效主目标时才立刻重算**。
- **`target_focus` 枚举映射已实证**：`0 = single`，`1 = spread`；`CShip::IsConfused` 为真时强制视为 `1 (spread)`。
  - 舰船层 `CShipTargeting::GetTargetFocus` 读舰船设计 growth stage `+0x128`；
  - 武器层 `CWeaponComponentTargeting::GetTargetFocus` 读武器模板 `+0x8d0`（对应脚本字段 `target_focus = single | spread`）。
- **`fp = 50`** 当 `targetFocus == 1 (spread)` 或 `IsConfused`，否则 **`fp = 10`**（`single`）。
- **索敌权重不是每 tick 重算的**。改 define 或改 modifier 不会"立即生效于每一帧"，实测复现时要按 tick 粒度对齐。

### 1.5 Stage 2：武器层分数 S(weapon)

```text
ΣD = Ds + Da + Dh                三层期望伤害分摊之和（Ds/Da/Dh 各自乘 ms/ma/mh 倍率）
p  = clamp(accw − clamp(evasion − τw, 0, 1), 0, 1)     命中率（accw/τw 为武器模板字段）

S0 = ΣD × p × ŵtgt               ŵtgt 即 Stage 1 的预置权重，含开战随机 ρ
Dh >= Vtgt（船体分量可单发斩杀） → S1 = 1.5 × S0
目标无还手能力（面板 DPD <= 0）  → S2 = κun (0.005) × S1
S(weapon) = S2 + wk              wk = target_weights 表中该目标船尺寸名对应的值
```

- 伤害取**已套修正的**武器模板值（攻击方 + 控制方 + 目标三方 modifier 就地改写 `SAttackInfo`），基础伤害取区间中点（索敌路径 `useRandom = false`）。
- 斩杀判据已由 4.6.0 源码实证为 **`Dh >= Vtgt`**（读 `SDamageResult + 0x08` 船体伤害分量与目标当前船体 `this + 0xb28` 比较，触发 `×1.5`）。
- `NCombatRules::CalcDamage` 按护盾/装甲/船体三层分摊，穿透减去目标硬化后夹 `[0,1]`。细节与武器字段 ↔ 结构偏移对照见 16 号文档 §3–§5、§15。
- `size_damage_factor`：仅当 `> 0` 时按目标尺寸放大伤害（`clamp(σ, 1, 100)`，上限 `MAX_DAMAGE_SCALING = 100`）。
- **关键反直觉点**：层分量不被该层存量夹住（只有从剩余伤害里扣减的量才被 `min` 夹住），所以**带盾/带甲的目标算出来的 ΣD 反而更大**——算例中同一门武器对"225 盾 + 225 甲 + 240 船体"目标的 ΣD 是对"720 船体 0 盾 0 甲"目标的 `1.95×~2.65×`。这就是"盾甲吸引仇恨"传言的根因；**唯一有效反制是高闪避**（压低 `p`）。

### 1.6 `use_ship_main_target` 三路分派

`CWeaponComponentTargeting::CalcBestTarget` 按序分派：

1. 组件模板标记为舰载机/打击机（4.6.0 模板 `+0x1288 == 2`）→ `CStrikeCraftTargeting::CalcBestTarget`；
2. `use_ship_main_target` 置位（模板 `+0x88` bit2）→ **沿用舰船主目标**（前提：在射程与射界内，即满足 `firing_arc` / `min_range` / `range`）；
3. 否则 → 每门武器自己按 `S(weapon)` argmax。

因此：**舰船层只决定"主目标是谁"，管不到 `use_ship_main_target = no` 的武器**（泰坦光矛正是这一类）。

### 1.7 最终粘性、近期惩罚与记忆数组写入时机（4.6.0 源码重要纠偏）

舰船层 `CShipTargeting::CalcBestTarget` 与武器层 `CalcBestWeaponComponentTarget` 在 argmax 前对称地按 `targetFocus` 互斥施加两项乘数：

```text
if targetFocus == 0 (single):
    候选 == 当前有效目标          → ×Mcur (1.1)     # single 下不施加 Mrec！
else (targetFocus == 1 spread 或 IsConfused):
    候选在"最近目标记忆"（10 个）中 → ×Mrec (0.3)     # 惩罚全部记忆项（含最新项），不施加 Mcur！
```

- **记忆数组更新时机**：在 **`UpdateTarget` 选出有效目标时**推入（**不是开火时**），且仅当 `IsConfused || targetFocus == 1 (spread)` 时写入（舰船层还要求新目标 ≠ 当前目标；武器层直接推入）；满 `NUMBER_OF_TARGETS_TO_REMEMBER`（10）时左移丢弃最老项 `[0]` 并在尾部追加新目标。

---

## 2. modder 可调点速查

### 2.1 defines（`common/defines/00_defines.txt`，`NCombat` / `NShip` 块）

下表 19 条即"索敌可调 defines"全集（加附 4.6.0 新增不活跃强制脱战），规则侧位于 `submodules/cwtools-stellaris-config/config/common/defines.cwt`，均已补齐 `###` 公式文档（悬停与补全可见）。

| # | 符号 | define 名 | 4.6.0 值 | 作用环节 |
|---|---|---|---|---|
| 1 | κsize | `COMBAT_SHIP_TARGETING_SIZE_MULT` | 0.03 | 尺寸项斜率 |
| 2 | σmax | `COMBAT_SHIP_TARGETING_SIZE_MAX` | 10 | 尺寸封顶 |
| 3 | κtrk | `COMBAT_SHIP_TARGETING_TRACKING_MULT` | 2.0 | 追踪放大 |
| 4 | κev | `COMBAT_SHIP_EVASION_TARGETING_WEIGHT` | 2.0 | 闪避惩罚斜率 |
| 5 | θh | `COMBAT_SHIP_LOW_HEALTH_THRESHOLD` | 0.5 | 残血阈值 |
| 6 | κh | `COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT` | 1.5 | 残血倍率 |
| 7 | κd | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT` | 0.002 | 距离衰减 |
| 8 | dmin | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN` | 0.10 | 距离下限 |
| 9 | κun | `COMBAT_SHIP_UNARMED_TARGETING_WEIGHT` | 0.005 | 无武装降权（与星基互斥） |
| 10 | κsb | `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT` | 0.75 | 武装星基/巨构降权 |
| 11 | σavoidmin | `COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE` | 8 | 否决判据的攻击方尺寸门槛 |
| 12 | Tavoid | `COMBAT_SHIP_EVASION_AVOID_THRESHOLD` | 0.7 | 否决判据的 Δ 门槛 |
| 13 | κr | `RANDOM_TARGETING_WEIGHT` | 3.0 | 随机扰动幅度，末项乘数 `∈ [1, 1+κr)`（仅 Stage 1） |
| 14 | Mcur | `SHIP_CURRENT_TARGET_MULTIPLIER` | 1.1 | 当前目标粘性（仅 `single(0)` 生效） |
| 15 | Mrec | `SHIP_RECENT_TARGET_PENALIZER` | 0.3 | 近期目标惩罚（仅 `spread(1)` / 困惑生效，作用于全部记忆项） |
| 16 | — | `NUMBER_OF_TARGETS_TO_REMEMBER` | 10 | 近期目标记忆长度（`UpdateTarget` 选目标时写入） |
| 17 | — | `SHIP_MAX_EVASION`（`NShip` 块） | 0.9 | 闪避上限 |
| 18 | — | `MAX_DAMAGE_SCALING`（`NShip` 块） | 100 | `size_damage_factor` 放大上限 |
| 19 | — | `MISSILE_RETARGET_CHANCE_START` / `_REDUCTION` | 100 / 35 | 导弹重索敌（本文未展开） |
| + | — | `SHIP_DISENGAGE_INACTIVITY_DAYS`（4.6 新增） | 150 | 战斗中无射程目标且无人瞄准达此天数后强制脱战（`<= 0` 关闭） |

### 2.2 船级与修饰符

- `ship_target_weight_mult`（modifier，4.6.0 ModifierType `0x71`，类别含 Military Ships 等，`config/logs/modifiers.log`）→ 直接进入 `ŵtgt`，与开战随机 `ρ` **相加**。
- 按船级的别名 `shipsize_$_target_weight_mult`（`ship_sizes.cwt`，已配 `###` 文档并接入 hover）。
- `ship_sizes` 的 `size_multiplier`（`σ`）、`default_behavior = <ship_behavior>`；`ship_behaviors` 的 `preferred_attack_range` / `attack_move_pattern` 控制走位，**间接影响距离项 `d` 的分布**，从而影响索敌。

### 2.3 武器组件模板（`common/component_templates/`，规则 subtype `weapon_component_template`）

| 字段 | 进入公式的位置 | 规则与诊断现状（`components_consolidated.cwt`） |
|---|---|---|
| `damage`（`min` / `max`） | ΣD 基础（区间中点，原版由 `.csv` 提供） | `damage = { min = float max = float }`（:601），已补 `###` 文档 |
| `hull_damage` / `shield_damage` / `armor_damage` | `mh` / `ms` / `ma` 三层倍率 | `float`（:610 / :604 / :613），已补 `###` 文档 |
| `shield_penetration` / `armor_penetration` | 穿透（减硬化后夹 `[0,1]`） | `float`（:607 / :616），已补 `###` 文档 |
| `accuracy` / `tracking` | `p` 与 `τw`；引擎要求 `[0, 1]` | `float`（:627 / :631），已补 `###` 文档，且由 `CW290` 提供 `[0, 1]` 范围警告诊断 |
| `size_damage_factor` | 按目标尺寸放大（上限 100） | `float`（:649），已补 `###` 文档 + `CW290` `>= 0` 诊断 |
| `use_ship_main_target` | 选目标分派（§1.6 第 2 支） | `bool`（:121），已补 `###` 文档 |
| `target_weights = { … }` | `S` 的**加法项** `wk`（§2.4） | **`<ship_size> = float` 强类型**（:577），已补 `###` 文档 |
| `targetable_ship_sizes = { … }` | 候选过滤（前置条件） | **`<ship_size>` 强类型**（:657） |
| `target_focus` | `single(0)` / `spread(1)`，决定节流周期与 `Mcur`/`Mrec` | `enum[component_target_focus]`（:400），已补 4.6 实证 `###` 文档 |
| `firing_arc` / `min_range` / `range` | 沿用主目标时的射程/射界约束 | `float`（:565 / :568 / :623），已补 `###` 文档 |

### 2.4 `target_weights` 是加法项，不是倍率

```text
S(weapon) = S2 + wk          wk = target_weights 表中该目标船尺寸名对应的值
```

**写在武器模板里的"优先打某类目标"可以盖过整条乘法链**：给 `target_weights = { <某小船> = 一个很大的数 }` 即可强制优先。用法与直觉的"倍率"**相反**——直觉会写成 `0.1`/`10`，实际是"加多少"。

### 2.5 不同层的其它开关（不要混用）

- `game_rules.cwt` 的 `calc_planet_specific_war_attack_priority` 等：**战争层面**优先级，与本公式不同层。
- effects 的 `set_ai_*_weapon_preference` 系列：**AI 配船偏好**，不是战斗索敌。
- `ai_weight`：AI 建造/决策权重，出现在 traits / zones / starbases 等规则里，**与索敌无关**（见误区 2）。

---

## 3. 取证路径

### 3.1 CWT 规则文件（本仓库内，只读）

| 用途 | 路径 |
|---|---|
| 19 个 defines + 不活跃脱战 | `submodules/cwtools-stellaris-config/config/common/defines.cwt`（:3797 / :3800 / :3912 / :3927–:4001） |
| 武器组件字段 | `submodules/cwtools-stellaris-config/config/common/components_consolidated.cwt`（:121 / :400 / :565–:657） |
| 船级权重别名 | `submodules/cwtools-stellaris-config/config/common/ship_sizes.cwt`（:86） |
| 走位行为 | `submodules/cwtools-stellaris-config/config/common/ship_behaviors.cwt` |
| 修饰符来源 | `submodules/cwtools-stellaris-config/config/logs/modifiers.log`（:119） |

### 3.2 原版（vanilla）目录

`<Stellaris 安装目录>/common`（通过 `STELLARIS_COMMON` 或扩展配置的游戏路径定位）—— 反查强类型、补 `###` 文档、核对真实取值的**一手事实来源**：

- `common/defines/00_defines.txt` → 19 个 define + `SHIP_DISENGAGE_INACTIVITY_DAYS` 的原版真实取值；
- `common/component_templates/*.txt` → 武器字段原版写法、`use_ship_main_target`、`target_weights`、`target_focus`；
- `common/ship_sizes/*.txt` → `size_multiplier`、光环类 `ship_target_weight_mult`。

### 3.3 本技能可用的只读工具（`allowed-tools` 核对表）

| 工具 | 用途 | 分类（`client/extension/ai/tools/registry.ts`） |
|---|---|---|
| `query_targeting_weight` | 按共享公式（`cwtools-shared`，已对齐 4.6.0）分解舰船层/武器层索敌权重链 | `paradox` / `workspace_read`（`isReadOnly = true`） |
| `query_cwt_schema` | 查 CWT 规则 schema（字段类型、alias） | `paradox` / `workspace_read` |
| `query_rules` | 查规则定义内容 | `paradox` / `workspace_read` |
| `search_rule_capabilities` | 搜索规则能力/触发器效果 | `paradox` / `workspace_read` |
| `explain_scope` | 解释 scope 与支持域 | `paradox` / `workspace_read` |
| `query_project_knowledge` | 查项目内策展知识包（机制说明入口） | `paradox` / `workspace_read` |
| `explore_pdx_project` | 跨文件结构化探索 mod 工程 | `paradox` / `workspace_read`（`lsp-limited`） |
| `compare_definition_with_vanilla` | mod 定义 vs 原版定义对比（字段改动核对） | `paradox` / `workspace_read`（`lsp-limited`） |
| `grep` | 全文检索 mod 与规则文件 | `shared` / `workspace_read`（`always`） |
| `read_file` | 读取具体文件/行区间 | `shared` / `workspace_read`（`always`） |

扩展还提供可视化分析面板 **Analyze Targeting Weights**（`cwtools.targetWeights.open` / `cwtools.targetWeights.openAtCursor`，`client/extension/targetWeightPanel.ts`），与 `query_targeting_weight` 及 MCP 面共用 `submodules/cwtools-mcp/packages/cwtools-shared/src/tools/targetingWeights.ts` 的唯一实现。

### 3.4 机制文档

- 本技能主文档：`docs/better_stellaris/17_ship_targeting_weights.md`（4.6.0 一手核验版）
- 伤害结算：`docs/better_stellaris/16_combat_damage_resolution.md`（ΣD 三层分摊、武器字段 ↔ 结构偏移对照，4.6.0 一手核验版）
- 舰队寻路 AI：`docs/better_stellaris/04_fleet_pathfinding_ai.md`
- 规则维护 SOP：`.agents/skills/stellaris-rules-sync/SKILL.md`

---

## 4. 常见误区十条

1. **"盾甲吸引仇恨"是结果不是机制**：根因是 ΣD 的三层分摊不夹各层存量（§1.5），不是引擎写了"优先打盾甲船"。
2. **`ai_weight` ≠ 索敌权重**：`ai_weight` 是 AI 建造/决策权重；战斗索敌的脚本抓手是 `ship_target_weight_mult`、`target_weights` 和 §2.1 的 defines。**回答时必须显式区分这两者。**
3. **索敌不是每 tick 重算**：10/50 tick 错峰 + 无有效主目标才立即重算（§1.4）。改 define 不会"立即生效于每一帧"。
4. **`target_weights` 是加法项**：可以碾压整条乘法链（§2.4），用法与直觉的"倍率"相反。
5. **同设计不同命运**：开战随机量 `ρ ∈ [0,1)` 让同设计舰船每场战斗的 `ŵtgt` 都不同（§1.2）。
6. **打不中的小船会被大船整体无视**：满足否决条件即 `return 0`（§1.3），不是低权重是**剔除**。
7. **斩杀加成只看船体分量**：4.6 源码已实证判据是 `Dh >= 当前船体 Vtgt`，不是总伤（§1.5）。
8. **`use_ship_main_target = no` 的武器完全自选目标**：舰船层只决定"主目标是谁"，管不到它（§1.6）。
9. **`CanDoDamage` 看面板 DPD，且与星基降权互斥**：是设计界面显示的数字，不是真实伤害；无武装星基只乘 `0.005`，不叠乘 `0.75`（§1.2、§1.5）。
10. **随机扰动幅度极大，且 `Mcur`/`Mrec` 随 `target_focus` 互斥**：`κr = 3.0` 使 Stage 1 末项乘数 `∈ [1,4)`；`single(0)` 仅施加 `Mcur(1.1)`、不触发 `Mrec`，`spread(1)` / 困惑禁用 `Mcur`、仅对全部近期记忆目标施加 `Mrec(0.3)`（§1.7）。

---

## 5. 工作纪律

1. **先查规则与 vanilla，再回答。** 任何"某 define 是什么值""某字段叫什么""目标是不是这样选"的断言，都必须先在 `submodules/cwtools-stellaris-config/config/**` 或原版 Stellaris `common/` 目录里找到出处；找不到就说"未证实"，**不要凭印象给数字**。
2. **区分层次，不要跨层归因。** 战争优先级（`calc_planet_specific_war_attack_priority`）、AI 配船偏好（`set_ai_*_weapon_preference`）、AI 决策权重（`ai_weight`）与战斗索敌是四套东西。
3. **数值问题走 §2 速查表 + `query_targeting_weight` 复核双确认**：先按公式/工具算出精确量级，再用 `read_file` / `grep` 核对 vanilla 的真实取值，最后才下结论。
4. **给出可复现的实验条件**：涉及节流（10/50 tick）、开战随机 `ρ`、随机扰动 `κr` 时，必须说明"结果依赖 tick 对齐与战斗内随机量"，不要把单次观测当结论。
5. **规则改动走 `stellaris-rules-sync` SOP**：要新增/补全规则定义时，按 `.agents/skills/stellaris-rules-sync/SKILL.md` 的原版反查 → 强类型 → 验证门禁流程执行；**严禁滥用 `scalar`**。
6. **本技能只读。** 进行定量权重分解时优先调用 `query_targeting_weight`（或引导用户打开 **Analyze Targeting Weights** 面板），涉及规则修改或代码变更时切换常规工具流并遵循 `stellaris-rules-sync` SOP。

---

## 附录 A：符号表

| 符号 | 含义 | 来源 |
|---|---|---|
| F | 定点单位 = 100000（脚本 1.0） | `CFixedPoint` |
| σ / σ′ | 候选尺寸倍率 / `min(σ, σmax)` | `ship_sizes` |
| atrk / τ | 攻击方追踪字段 / 归一化追踪 | 攻击方 |
| ε | 候选闪避（`0..1`，上限 `0.9`） | 候选 |
| d | 候选距离 | 战斗状态 |
| ŵtgt | 预置权重 = `ship_target_weight_mult` (`0x71`) + `(1 + ρ)` | modifier + 开战随机 |
| ρ | 开战随机量 `∈ [0,1)`，全场不变 | `CShip::OnCombatStarted` |
| h / θh | 目标血量百分比 / 残血阈值 `0.5` | `CShipTargeting` |
| ΣD / p | 三层期望伤害和 / 命中率 | `CalcDamage` / `CalcChanceToHit` |
| wk | `target_weights` 表命中项（**加法**） | 武器模板 |
| Mcur / Mrec | 当前目标 `1.1`（仅 `single`） / 近期目标 `0.3`（仅 `spread` / 困惑） | defines |
| κ 系列 | 各 define 系数，见 §2.1 | defines |
| fp | 节流周期 `10`（`single`）或 `50`（`spread` / 困惑）tick | `(TotalTicks + shipID) mod fp` |

## 附录 B：数值算例（可用于自检公式理解）

场景：两条船 + 一门 `ENERGY_LANCE`（`acc 0.85`、`trk 0`；`mh 1.5 / ms 0.5 / ma 2.0`）。

| 量 | 护卫舰 | 雷击舰 | 复算 |
|---|---|---|---|
| W1 尺寸 | 0.8696 | 0.8065 | `1/(1+5×0.03)` ✓；`1/(1+8×0.03)` ✓ |
| 闪避因子 | 0.4545 | 0.5411 | `1/(1+0.6×2)` ✓；`1/(1+0.424×2)` ✓（**单因子**，非累计） |
| W3 距离因子 | 0.856 | 0.871 | `1−72×0.002` ✓；`1−64.5×0.002` ✓ |
| W(ship) | 0.528 | 0.524 | `0.8696×0.4545×0.856×1.561` ✓；`0.8065×0.5411×0.871×1.379` ✓ |
| p 命中率 | 0.250 | 0.426 | `0.85−0.6` ✓；`0.85−0.424` ✓ |

结论复核成立：舰船层两条船基本持平（`1.01:1`），武器层护卫舰领先（ΣD 被盾甲顶高 `1.95×~2.65×`，盖过闪避带来的 `p` 劣势）。因 `ENERGY_LANCE` 的 `use_ship_main_target = no`，实际按武器层走 → 优先打带盾甲的护卫舰。
