**群星舰船索敌权重计算公式——Stellaris 4.6.0 反编译核验版**

初版整理日期：2026-10-13（基于 4.5.2 PDF）。**一手源码全量核验日期：2026-11-28（Stellaris 4.6.0）**。

一手源码依据：`anti_stellaris` 仓库的 `stellaris_4.6_source.cpp`（Corona Borealis v4.6.0 `5d0adbc59353f1e9b085e0a2c4cb3d1a`，Linux 版 Ghidra 反编译，9,363,893 行，141,524 个函数块）与原版 `common/defines/00_defines.txt`（v4.6.0 `3d1a`）。原始算例与公式骨架参考《[群星索敌权重计算公式 4.5.2](../群星索敌权重计算公式_4.5.2.pdf)》（古明地瓜 / KKoishi_，地砖 & 清流蛋糕 rt）。

> **核验状态（2026-11-28）——全部机制与旧未证实项 V1–V5 已以 4.6.0 源码一手闭合**
>
> 1. **本文全部公式、分支条件、函数行号、结构偏移与枚举映射，已对 `stellaris_4.6_source.cpp` 逐函数逐行完成一手核验**，不再属于“二手转写”。
> 2. **已纠正 4.5.2 PDF 转写阶段的 3 处偏差**（均在正文与 §8.1 标出）：
>    - **`SHIP_RECENT_TARGET_PENALIZER` (`Mrec = 0.3`) 的生效条件与范围**：源码中**仅在 `targetFocus == 1 (spread)` 或 `IsConfused` 时施加**，`single (0)` 模式根本不执行；且对记忆数组中**全部记住的目标**生效（含最新项），PDF 误把负步长计数读成“排除最新项 `R \ {r0}`”。
>    - **无武装降权与星基降权互斥**：`CShipTargeting::ComputePotentialTargetScore`（L1723534–L1723561）是 `if / else if` 互斥分支，无武装星基只乘 `0.005`，不会再叠乘 `0.75`。
>    - **Stage 1 与 Stage 2 对称施加 `Mcur` / `Mrec`**：`CShipTargeting::CalcBestTarget`（L1723010 & L1723030）在舰船层同样对 `single` 施加 `Mcur`、对 `spread` 施加 `Mrec`。
> 3. **旧未证实项 V1–V5 全部闭合**：`target_weights` 键集（V1）、斩杀判据取船体分量 `Dh >= Vtgt`（V2）、`target_focus` 枚举 `0 = single / 1 = spread` 且舰船层/武器层各自独立读取（V3）、全套 4.6 行号与偏移（V4）、记忆数组在 `UpdateTarget` 选出目标时推入而非开火时（V5）。
> 4. **版本说明**：文中行号与 GCC 结构偏移均以 **Stellaris 4.6.0** Linux dump 为准（相对 4.5.2，武器组件模板 `CWeaponComponentTemplate` 偏移整体左移 `0x58`，`CShipSize.size_multiplier` 从 `+0x630` 移至 `+0x668`，`MOD_SHIP_TARGET_WEIGHT_MULT` 从 `0x6e` 移至 `0x71`，开战随机量 `ρ` 从 `ship + 0xe88` 移至 `ship + 0xf48`）；原版 19 项索敌 defines 的数值在 4.6.0 **全部未变**，行号整体后移 +86 行，并新增 `SHIP_DISENGAGE_INACTIVITY_DAYS = 150`。

**本次独立核验清单（2026-10-13 脚本层 + 2026-11-28 4.6.0 源码一手核验）**

| # | 核验对象 | 方法 | 结论 |
|---|---|---|---|
| N1 | 19 项索敌 defines + 新增不活跃脱战 define | 实读 4.6.0 `common/defines/00_defines.txt` | 19 项数值与 4.5.2 完全一致，行号整体 +86；新增 `SHIP_DISENGAGE_INACTIVITY_DAYS = 150`（L2004） |
| N2 | `target_weights` 的键集合 | 遍历原版 `component_templates/*.txt` 全部块 | 18 个去重键，**全部是 `common/ship_sizes` 的 id**（§3.3） |
| N3 | 武器模板文档语义 | 实读 `000_documentation.txt` | 明确 `target_weights` 键为 `ship_size`、`use_ship_main_target` 默认 `no` |
| N4 | 算例中两条船的尺寸倍率 | 实读 `common/scripted_variables/03_scripted_variables_ships.txt` | `@corvette_size_multiplier = 5`、`@frigate_size_multiplier = 8` |
| N5 | `ship_target_weight_mult` 的原版取值样本 | 全 `common/` 检索 | 6 处命中（§2.4） |
| N6 | CWT 规则侧与共享计算器 | 实读 `defines.cwt` / `components_consolidated.cwt` / `ship_sizes.cwt` / `targetingWeights.ts` | 全部 defines `###` 文档、`<ship_size>` 强类型、`CW290` 范围诊断及 4.6 纠偏均已对齐 |
| N7 | 4.6.0 引擎源码全链（17 个核心函数） | 实读 `stellaris_4.6_source.cpp` | 闭合 V1–V5，纠正 PDF 3 处偏差，同步全套 4.6 行号与偏移（附录 B） |

**阅读约定**

引擎内部使用定点数，`F = 100000`（脚本里的 1.0）。引擎的除法是 **C 风格定点整数除法（向零截断）**，记作 ⌊x⌋。本文公式一律给出**归一化形式**（把定点除法视作实数除法，隐含除以 `F`），便于分析；需要定点精度的场合会单独注明。"修正后的量"指经 modifier 系统计算后的值。

**姊妹篇**

- [16_combat_damage_resolution.md](16_combat_damage_resolution.md)：伤害结算（同为 4.6.0 一手核验版），本文 §3.1 的 ΣD 三层分摊细节、字段 ↔ 偏移对照、23 组算例全部在那里；本文只引用不重复。
- [04_fleet_pathfinding_ai.md](04_fleet_pathfinding_ai.md)：索敌节流已改为指向本文。
- 实施记录：见 [知识层 Note](../../.agents/notes/implemented/feature/2026-10-13-stellaris-targeting-weight-knowledge-rules.md)、[工具链 Note](../../.agents/notes/implemented/feature/2026-10-13-targeting-weight-tooling.md) 与 [4.6 反编译复核 Note](../../.agents/notes/implemented/process/2026-11-28-stellaris-4.6-engine-decompilation-audit-and-sync.md)。

阅读导航：

- [1. 两阶段总览](#part1)
- [2. Stage 1：舰船层权重 W(ship)](#part2)
- [3. Stage 2：武器层分数 S(weapon)](#part3)
- [4. 调用端、节流与记忆数组](#part4)
- [5. defines 与脚本字段全表](#part5)
- [6. 数值算例：护卫舰 vs 雷击舰](#part6)
- [7. modder 误区十条](#part7)
- [8. 4.6.0 闭合核验与规则层现状](#part8)
- [附录 A：符号表](#appendix-a)
- [附录 B：4.6.0 源码与脚本证据索引](#appendix-b)
<a id="part1"></a>

## 1. 两阶段总览

索敌是**两阶段、argmax（取最大值，而不是加权抽签）、带错峰节流**的过程。**阶段一回答"这个目标好不好打、值不值得打"，阶段二回答"这门武器打它能造成多少有效伤害"；两层互不相乘，而是各自独立 argmax（均带 `Mcur` / `Mrec` 修正），仅在 `use_ship_main_target = yes` 时直接沿用阶段一结果。**

```text
 敌方候选船（同星系 · 可被攻击 · 非 FTL/隐身）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 1  舰船层        CShipTargeting::ComputePotentialTargetScore
│                        (stellaris_4.6_source.cpp L1723150)   │
│                                                              │
│   W(ship) = 尺寸项 W1                                        │
│           × 追踪-闪避项 W2/W1   （含"打不中即整目标剔除"否决）│
│           × 距离项   W3/W2                                   │
│           × 预置权重 W4/W3   （ŵtgt = ship_target_weight_mult + 1 + ρ）│
│           × 残血项   W5/W4                                   │
│           × 无武装 / 星基互斥项 W6/W5（无武装优先，不叠乘）  │
│           × 随机扰动 (1 + r·κr)      ← 乘数 ∈ [1, 4)          │
│                                                              │
│   结算（CShipTargeting::CalcBestTarget, L1722922）：          │
│     single(0): 当前目标 ×Mcur(1.1)                           │
│     spread(1) 或 IsConfused: 记忆内目标 ×Mrec(0.3)            │
│     → argmax → 舰船主目标（10/50 tick 错峰节流）              │
└──────────────────────────────────────────────────────────────┘
        │  （use_ship_main_target = yes 的武器在此直接短路）
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 2  武器层      CWeaponComponentTargeting::ComputePotentialTargetScore
│                      (stellaris_4.6_source.cpp L1724367)     │
│                                                              │
│   S(weapon) = ΣD × 命中率 p × 预置权重 ŵtgt                   │
│             × 斩杀加成 (×1.5，当船体分量 Dh >= 目标当前船体)  │
│             × 无还手降权 (×0.005)                            │
│             + wk   （target_weights 表命中项，加法）          │
│                                                              │
│   结算（CalcBestWeaponComponentTarget, L1724214）：           │
│     single(0): 当前目标 ×Mcur(1.1)                           │
│     spread(1) 或 IsConfused: 记忆内目标 ×Mrec(0.3)            │
│     → argmax → 每门武器各自的开火目标                         │
└──────────────────────────────────────────────────────────────┘
```

**短路分支**：武器模板写了 `use_ship_main_target = yes` 时，武器直接沿用**舰船主目标**（前提：主目标在射程与射界内），Stage 2 整段不参与。`ENERGY_LANCE`（泰坦光矛）写的恰恰是 `no`，所以它完全按武器层分数自选目标（`common/component_templates/00_weapons_extra_large.txt:15`）。

**节流**：舰船已有有效主目标时，只在 `(TotalTicks + shipID) mod fp == 0` 的 tick 重算权重（`fp = 50` 当 `targetFocus == 1 (spread)` 或 `IsConfused`，否则 `10`）；**没有有效主目标时才立刻重算**。**索敌权重不是每 tick 重算的。**详见 §4.1。

<a id="part2"></a>

## 2. Stage 1：舰船层权重 W(ship)

对应 `CShipTargeting::ComputePotentialTargetScore`（`stellaris_4.6_source.cpp` L1723150）。

**前置条件（不满足直接返回无效）**：候选与自己同星系、可被攻击、不处于跳跃/隐身位掩码中。

整体是一条**乘法链**：

```text
W(ship) = W1 · (W2/W1) · (W3/W2) · (W4/W3) · (W5/W4) · (W6/W5) · (1 + r·κr)
```

> ⚠️ 归一化形式下的除法在定点实现里是 `F·prev / F` 的整数除法（向零截断），逐级截断。乘法链中每一步单独列出的数字是**单步因子**（不是累计值）——见 §6，这一点最容易读错。

### 2.1 尺寸项（基准项，单调递减）

```text
σ′ = min(σ, σmax)              σ = 候选船 CShipSize.size_multiplier (+0x668)，σmax = 10
W1 = 1 / (1 + σ′·κsize)        κsize = 0.03
```

**注意这是赋值而不是累乘**：σ → 0 时 W1 → 1，值域 `(0, 1]`，随尺寸单调递减。护卫舰（σ=5）得 `0.8696`，泰坦级（σ=80 原版值，远超封顶）取 σ′=10 得 `0.7692`。

> **脚本层核验（N4）**：`@corvette_size_multiplier = 5`、`@battleship_size_multiplier = 40`、`@titan_size_multiplier = 80`，定义在 `common/scripted_variables/03_scripted_variables_ships.txt`。也就是说 **vanilla 主力舰的 σ 全部 ≥ σmax = 10**，尺寸项对主力舰之间几乎没有区分度（`0.7692` 一律），真正拉开差距的只有护卫舰/巡防舰这一档。这也解释了为什么"大船之间互相转移仇恨"看起来是随机的——见 §2.6。

### 2.2 追踪–闪避项（含整目标否决）

```text
τ = atrk · κtrk                 κtrk = 2.0，atrk = 攻击方追踪字段
ε = 候选闪避（0..1，受 SHIP_MAX_EVASION = 0.9 上限约束）
Δ = ε − τ
```

**否决条件（整目标剔除，不是低权重）**：

```text
Δ > 0  ∧  σatt ≥ σavoidmin (8)  ∧  Δ ≥ Tavoid (0.7)
        ∧  ∃ q ∈ F_tgt : ε_q − τ < Tavoid     ⇒  return 0
```

其中 `F_tgt` 是候选目标所在舰队的舰船集合，`σatt` 是攻击方尺寸（`CShipSize + 0x668`，L1723202 / L1723289）。即：**大船对高闪避小船"懒得追"——只要对方舰队里还打得中，就把打不中的那艘整个踢出候选集**。这是"高闪避小船被无视"传言的真正机制。

**闪避惩罚**（未被否决且 Δ > 0 时）：

```text
W2 = W1 / (1 + Δ·κev)      κev = 2.0
W2 = W1                   Δ ≤ 0（追踪盖过闪避，无惩罚）
```

### 2.3 距离项

```text
D  = max(1 − d·κd, dmin)      κd = 0.002，dmin = 0.10
W3 = W2 · D
```

`d` 为候选距离（引擎单位）。线性衰减，**`d ≥ 450` 时触到下限 `0.10`**，此后再远也不再减分。

### 2.4 目标预置权重 wtgt（modder 的主要抓手）

```text
W4 = W3 · ŵtgt
ŵtgt = wmult + (1 + ρ)
```

- `wmult = GetModifierValue(shipSize, 0x71)`（4.6.0 为 `0x71`，4.5.2 为 `0x6e`），即 **ModifierType `MOD_SHIP_TARGET_WEIGHT_MULT`**，规则名 `ship_target_weight_mult`。这是**船级 modifier**，按船级的别名是 `shipsize_$_target_weight_mult`（`ship_sizes.cwt:86`；原版脚本未使用该别名，属引擎/规则层约定）。
- **ρ 是开战瞬间每艘船各掷一次的随机量**：`CShip::OnCombatStarted`（L3873857，写入点 L3873868）用 `CRandom::GetFixedPointForMacro` 写入 `ship + 0xf48`（4.5.2 为 `+0xe88`），**整场战斗保持不变**，`CShip::OnCombatEnded`（L3873879）时复位为 `1.0`。因此两条设计完全相同的船，每场战斗也会被赋予不同的"被偏爱度"。
- 取值来源 `CShip::GetTargetWeightFactor`（L3869039，读 ModifierType `0x71` 于 L3869052）。

> **脚本层核验（N5）**：原版 `common/` 中 `ship_target_weight_mult` 共 6 处命中：
>
> | 值 | 位置 | 语义 |
> |---|---|---|
> | `0.50` | `component_templates/00_dsc_auras.txt:23` | 光环类组件 |
> | `−0.5` | `ship_sizes/29_nomads_dlc_ships.txt:14` | Nomads 系船级 |
> | `10` | `static_modifiers/25_static_modifiers_nomads.txt:139` | Nomads 静态修正 |
> | `0.10` / `0.25` / `0.50` | `static_modifiers/23_static_modifiers_biogenesis.txt:832/838/844` | 生物生成 |
>
> 注意 `10` 这一条：`ŵtgt` 是个**加法量**而非倍率上限，写大了会让该船在任何比较里都压过全场。

### 2.5 残血 / 无武装 / 星基（4.6 源码纠偏：无武装与星基互斥）

```text
h < θh (0.5)                                      → ×κh  (1.5)    残血目标更优先（"收人头"）

if (¬ CanDoDamage(tgt))                           → ×κun (0.005)  几乎不再打
else if (σclass = 10 且 ¬(tgt = mainTarget ∧ valid)) → ×κsb (0.75)   恒星基地/巨构降权
```

- **4.6.0 一手核验纠偏**：在 `CShipTargeting::ComputePotentialTargetScore`（L1723534–L1723561）中，无武装降权与星基降权是 **`if / else if` 互斥分支**——**一座无武装星基只乘 `0.005`，不会再叠乘 `0.75`**（原 PDF 将两项并列写成独立累乘，已纠正；本仓库共享计算器 `targetingWeights.ts` 已同步修正）。
- `σclass` 是舰船类型枚举，`10` 表示恒星基地/巨构。星基分支的判定是：不是当前有效主目标时才降权（一旦已经锁定星基为当前主目标，不再施加 `0.75`）。
- `CanDoDamage` 只看面板 DPD（Damage Per Day）是否 `> 0`，且这个 DPD 是**舰船设计界面显示的数字，不是真实伤害数据**。它同时出现在 Stage 1（`×0.005`）和 Stage 2（`×0.005`）。

### 2.6 随机扰动

```text
W(ship) = W6 · (1 + r·κr)       r ∈ [0, 1)，κr = 3.0   ⇒   乘数 ∈ [1, 4)
```

`r` 同样由 `CRandom::GetFixedPointForMacro` 给出。`CShipTargeting::CalcBestTarget` **默认传 `useRandom = true`**。

**这一项幅度极大（最高 4 倍），是"为什么索敌看起来不稳定"的主因之一。** 原版注释写得很直白："The higher this is, the more random ship targeting will be. **Only affects ship's main target**"——它只作用于阶段一，阶段二的武器自选目标不受它影响。调试索敌行为时，先想办法压低这一项，再谈其他（误区十条的第 10 条）。

<a id="part3"></a>

## 3. Stage 2：武器层分数 S(weapon)

对应 `CWeaponComponentTargeting::ComputePotentialTargetScore`（`stellaris_4.6_source.cpp` L1724367）。

### 3.1 期望伤害 ΣD 与命中率 p

**计算顺序（4.6.0 源码已逐行核实）**：

1. 把武器模板的 `SAttackInfo`（4.6.0 位于模板 `+0x1170` 起，相对 4.5.2 左移 `0x58`）拷到栈上。区间编码为 `(min, max − min)`：`+0x1170` 是最小伤害，`+0x1178` 是**跨度**，均值 = `min + 跨度/2`。
2. `CShip::ApplyModifier`（L3855963 / L3856105）就地改写这份拷贝——修正集合由**攻击方 + 控制方 + 目标**三方组成。**所以用的是修正加成后的伤害，不是模板基础值。**
3. `NCombatRules::CalcDamage`（L2144137）拿这份"已修正"的 `SAttackInfo` 与目标的 `SDefenseInfo` 算出三个伤害分量。
4. `NCombatRules::CalcChanceToHit`（L2144467）算命中率。

```text
ΣD = Ds + Da + Dh          三层伤害分量之和
p  = clamp( accw − clamp( ε_tgt − τw, 0, 1), 0, 1 )
```

**ΣD 的细节、三层分摊模型、穿透/硬化、溢出、以及武器字段 ↔ 结构偏移对照，全部见 [16_combat_damage_resolution.md](16_combat_damage_resolution.md) §3–§5 与 §15。** 本文只保留与索敌解读直接相关的三点：

1. **索敌路径 `useRandom = false`**，基础伤害取区间中点，不做随机抽取。
2. **关键反直觉点——层分量不被该层存量夹住**。只有"从剩余伤害里扣减的量"才被 `min` 夹住，`Cs` / `Ca` 由剩余伤害折算而来，**可以远大于该层当前的盾/甲量**。因此**带盾/带甲的目标算出来的 ΣD 反而更大**（算例中为 `1.95× ~ 2.65×`）。这就是"盾甲吸引仇恨"传言的根因——**它不是机制，是 ΣD 的算术副作用**。**唯一有效的反制是高闪避**（压低 `p`）。
3. `size_damage_factor`：仅当 `> 0` 时按目标尺寸放大伤害，`sz = clamp(σ, 1, 100)`，上限即 `MAX_DAMAGE_SCALING`（`NShip = 100`）。

命中率字段 `accw` / `τw`（4.6.0 模板 `+0x1150` / `+0x1158`）在引擎里有 `"Accuracy / Tracking should be between 0.0 and 1.0"` 的校验（L3917704 / L3917716）；CWTools 已通过 **`CW290`** 诊断在规则侧提供 `[0, 1]` 范围检查。

### 3.2 基础分数、斩杀加成、无还手降权

```text
S0 = ΣD · p · ŵtgt                       ŵtgt 就是 Stage 1 的预置权重（含开战随机 ρ）
S1 = 1.5 × S0                            若 Dh >= Vtgt（单发船体分量可打穿目标当前船体）
S2 = κun (0.005) × S1                    目标无还手能力（面板 DPD <= 0）
S(weapon) = S2 + wk                      wk = target_weights 表中该目标船尺寸名对应的值
```

- **斩杀判据（4.6.0 源码一手闭合 V2）**：在 `CWeaponComponentTargeting::ComputePotentialTargetScore` L1724475，条件明确写作 `*(long *)(this + 0xb28) <= local_60`，其中 `local_60` 是 `SDamageResult + 0x08`（**船体伤害分量 `Dh`**），`this + 0xb28` 是目标当前船体 `Vtgt`。命中时执行 `lVar4 + (lVar4 * 50000) / 100000`（精确 `×1.5`）。彻底排除 PDF §2.3 把符号错写成 `D2` 的歧义。
- `CanDoDamage` 同样是面板 DPD 判定，不是真实伤害。

### 3.3 `target_weights`：加法项，不是倍率

`wk` 来自武器模板的 `SShipSizeNameTargetWeightPair` 表（4.6.0 位于模板 `+0x8b8`、数量 `+0x8c4`，相对 4.5.2 左移 `0x58`），**键为舰船尺寸名**。

> **脚本层与规则层闭合（N2/N3，闭合 V1）**：遍历原版 `component_templates/*.txt` 中的全部 `target_weights = {}` 块，去重后共 **18 个键**，**全部是 `common/ship_sizes/*.txt` 中定义的 `<ship_size>` id**。原版注释（`000_documentation.txt:81`）明确："This increases the weight to target a specific ship size, see common/ship_sizes for options."
> 本仓库 `components_consolidated.cwt:577` 已将其建模为 `<ship_size> = float` 强类型，与相邻的 `targetable_ship_sizes`（`:657`）对称。

**正因为它是加法项**，写在武器模板里的"优先打某类目标"可以**盖过整条乘法链**。vanilla 实例（`00_weapons_extra_large.txt:55-61`，`ENERGY_LANCE_1`）：

```text
target_weights = {
    titan            = 3
    battleship       = 2
    stinger_stage_1  = 1.5
    stinger_stage_2  = 2
    stinger_stage_3  = 2
}
```

`titan` 直接加 `3` 分——而整条乘法链在典型值下往往只有零点几到几十分量级。**用法与直觉的"倍率"完全相反。**

<a id="part4"></a>

## 4. 调用端、节流与记忆数组

### 4.1 舰船主目标：`CShipTargeting::CalcBestTarget`（L1722922）

枚举敌方候选船 → 逐个调 `ComputePotentialTargetScore` 拿 `W(ship)` → 施加 `Mcur` / `Mrec` → **取最大值（argmax，不是加权抽签）**。两个关键行为：

**① 错峰节流**：

```text
若已有有效主目标：  (TotalTicks + shipID) mod fp ≠ 0  ⇒  保留当前主目标，跳过整轮权重计算
fp = 50（当 targetFocus == 1 或 IsConfused），否则 10
```

有效主目标 = 同星系、存活、非 disabled/cloak。

**② 舰船层同样施加 `Mcur` 与 `Mrec`（4.6.0 源码一手证实）**：

- `targetFocus == 0` (`single`) 且候选等于当前主目标（L1723010）：分数 `× Mcur (1.1)`。
- `targetFocus == 1` (`spread`) 或 `IsConfused` 且记忆数组非空（L1723030）：若候选出现在最近目标记忆数组 `R` 中，分数 `× Mrec (0.3)`。

### 4.2 武器选目标：`CWeaponComponentTargeting::CalcBestTarget`（L1724078）

按顺序分派：

1. **组件模板 `+0x1288 == 2`（舰载机/打击机，4.5.2 为 `+0x12e0`）** → `CStrikeCraftTargeting::CalcBestTarget`（L1723743）；
2. **`use_ship_main_target` 置位**（4.6.0 模板 `+0x88` bit2） → `GetShipMainTargetIfValid`：**直接沿用舰船主目标**，前提是主目标在射程与射界内；
3. **否则** → `CalcBestWeaponComponentTarget`（L1724214），每门武器自己按 `S(weapon)` 取 argmax。

原版注释（`000_documentation.txt:182`）明确："if yes, overrides target_type and target_focus when ship's main target is within range, **default no**"。

### 4.3 最终比较：`CalcBestWeaponComponentTarget`（L1724214）— 4.6 源码重要纠偏

设候选集合为 `C`，当前既定目标为 `c★`，最近目标记忆数组为 `R`（最大长度 `NUMBER_OF_TARGETS_TO_REMEMBER = 10`）：

```text
if (targetFocus == 0):                                     // single 模式
    S̃(c) = S(weapon)(c) · Mcur   若 c == c★ 且当前目标有效
    S̃(c) = S(weapon)(c)          否则
                                                            // ← single 模式不执行 Mrec！

else if (targetFocus == 1 或 IsConfused):                  // spread 模式
    S̃(c) = S(weapon)(c) · Mrec   若 c ∈ R（全部记忆项，含最新项！）
    S̃(c) = S(weapon)(c)          否则
                                                            // ← spread 模式不执行 Mcur！

c★ = argmax_{c ∈ C} S̃(c)
```

> **4.6.0 源码一手纠偏（修正 PDF §4 转述错误）**：
> 1. **`Mcur` 与 `Mrec` 严格按 `targetFocus` 互斥生效**：`CalcBestTarget`（L1723010 / L1723030）与 `CalcBestWeaponComponentTarget`（L1724295 / L1724315）均为 `if (targetFocus == 0)` 走 `Mcur`，`if ((targetFocus == 1) && count > 0)` 走 `Mrec`。**`single` 模式下 `Mrec` 完全不执行**（与 `00_defines.txt` 注释 *"of ships and components that spread their fire among enemies"* 严丝合缝）。
> 2. **惩罚范围是全部记忆项 `R`（含最新项），不是 `R \ {r0}`**：反编译循环中索引变量 `lVar6` 从 `0` 每次递减 1（`0, -1, -2, ...`），`-lVar6` 对应正向数组下标 `i`，未命中时 `lVar6 = 1`（对应 `i = -1`）。因此 `if ((int)lVar6 != 1)` 等价于 `index != -1`——**只要目标在记忆数组中（包括 `[0]` 与末尾最新项）一律乘以 `Mrec = 0.3`**。PDF 误将负步长计数读成"排除索引 0"。

### 4.4 `target_focus` 枚举映射与记忆数组更新时机（闭合 V3 & V5）

**① `target_focus` 枚举映射（闭合 V3）**：

- `GetLocalizedTargetFocusFromEnum`（L473380）：`0 → "TARGET_FOCUS_SINGLE"`，`1 → "TARGET_FOCUS_SPREAD"`（其他值回退 single）。
- `EnumToToken<ETargetFocus>`（L473346）：`0 → 0x44f5`，`1 → 0x44f6`；`TokenToEnum<ETargetFocus>`（L473366）：`*param_1 == 0x44f6`。
- **结论**：**`0 = single`、`1 = spread`**；当 `CShip::IsConfused` 为真时，引擎强制将 `targetFocus` 视作 **`1 (spread)`**。
- **两层独立来源**：
  - 舰船层 `CShipTargeting::GetTargetFocus`（L1723081）：读取舰船设计 growth stage `+0x128`（非武器字段）。
  - 武器层 `CWeaponComponentTargeting::GetTargetFocus`（L1724137）：读取武器组件模板 `+0x8d0`（对应脚本字段 `target_focus = single | spread`）。

**② `NUMBER_OF_TARGETS_TO_REMEMBER` 记忆数组更新时机（闭合 V5）**：

- **更新时机是在 `UpdateTarget` 选出目标时推入，而不是开火时推入**！
- **舰船层 `CShipTargeting::UpdateTarget`（L1722776，记忆写入 L1722846–L1722885）**：调用 `CalcBestTarget` 得到有效目标后，**仅当 `IsConfused || targetFocus == 1 (spread)` 且新目标 ≠ 当前目标**时，将新目标写入记忆数组；若已满 `NUMBER_OF_TARGETS_TO_REMEMBER`（10），先整体左移丢弃最老的 `[0]`，再把新目标追加到尾部。
- **武器层 `CWeaponComponentTargeting::UpdateTarget`（L1723958，记忆写入 L1724000–L1724045）**：调用 `CalcBestTarget` 得到有效目标后，**仅当 `IsConfused || targetFocus == 1 (spread)`** 时推入记忆数组（不要求新目标 ≠ 上一目标）；满 10 条同样左移挤掉最老项并在尾部追加。

### 4.5 Stellaris 4.6.0 新增：不活跃舰船强制脱战

4.6.0 在 `NCombat` 新增 `SHIP_DISENGAGE_INACTIVITY_DAYS = 150`（`00_defines.txt` L2004）：

- 战斗中每当舰船在武器射程内持有有效目标，或有敌舰瞄准它时，调用 `CShip::RegisterCombatActivity`（L3858542）刷新活动时间戳 `ship + 0xdc4`。
- `CFleetCombatManager::DailyUpdateSerial`（L3584223）每日调用 `CFleetCombatManager::ForceDisengageInactiveShips`（L3584242）：当 `SHIP_DISENGAGE_INACTIVITY_DAYS > 0` 且舰船连续无活动天数达到该阈值时，直接执行 `CShip::SetIsDisengaged(ship, true)` 强制脱战（填 `<= 0` 关闭）。

<a id="part5"></a>

## 5. defines 与脚本字段全表

### 5.1 系数表（19 项索敌 defines + 4.6 新增不活跃脱战）

**全部条目已于 2026-11-28 对 4.6.0 原版 `common/defines/00_defines.txt` 与本仓库 `defines.cwt` 逐条实读核对**，19 项数值与 4.5.2 完全一致。

| # | 符号 | define | 4.6.0 值 | vanilla 行号 | 环节 | CWT 规则行号 |
|---|---|---|---|---|---|---|
| 1 | κsize | `COMBAT_SHIP_TARGETING_SIZE_MULT` | 0.03 | 1972 | 尺寸项斜率 | defines.cwt:3941 |
| 2 | σmax | `COMBAT_SHIP_TARGETING_SIZE_MAX` | 10 | 1973 | 尺寸封顶 | defines.cwt:3944 |
| 3 | κtrk | `COMBAT_SHIP_TARGETING_TRACKING_MULT` | 2.0 | 1974 | 追踪放大 | defines.cwt:3947 |
| 4 | κev | `COMBAT_SHIP_EVASION_TARGETING_WEIGHT` | 2.0 | 1975 | 闪避惩罚斜率 | defines.cwt:3950 |
| 5 | θh | `COMBAT_SHIP_LOW_HEALTH_THRESHOLD` | 0.5 | 1976 | 残血阈值 | defines.cwt:3953 |
| 6 | κh | `COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT` | 1.5 | 1977 | 残血倍率 | defines.cwt:3956 |
| 7 | κd | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT` | 0.002 | 1978 | 距离衰减 | defines.cwt:3959 |
| 8 | dmin | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN` | 0.10 | 1979 | 距离下限 | defines.cwt:3962 |
| 9 | κun | `COMBAT_SHIP_UNARMED_TARGETING_WEIGHT` | 0.005 | 1980 | 无武装降权（与星基互斥） | defines.cwt:3965 |
| 10 | κsb | `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT` | 0.75 | 1981 | 武装星基/巨构降权 | defines.cwt:3968 |
| 11 | σavoidmin | `COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE` | 8 | 1982 | 否决的攻击方尺寸门槛 | defines.cwt:3971 |
| 12 | Tavoid | `COMBAT_SHIP_EVASION_AVOID_THRESHOLD` | 0.7 | 1983 | 否决的 Δ 门槛 | defines.cwt:3974 |
| 13 | κr | `RANDOM_TARGETING_WEIGHT` | 3.0 | 1968 | 随机扰动幅度，乘数 ∈ [1, 4) | defines.cwt:3936 |
| 14 | Mcur | `SHIP_CURRENT_TARGET_MULTIPLIER` | 1.1 | 1962 | 当前目标粘性（仅 `single(0)` 生效） | defines.cwt:3927 |
| 15 | Mrec | `SHIP_RECENT_TARGET_PENALIZER` | 0.3 | 1964 | 近期目标惩罚（仅 `spread(1)` / 困惑生效，作用于全部记忆项） | defines.cwt:3930 |
| 16 | — | `NUMBER_OF_TARGETS_TO_REMEMBER` | 10.0 | 1966 | 近期记忆长度（`UpdateTarget` 选目标时写入） | defines.cwt:3933 |
| 17 | — | `SHIP_MAX_EVASION`（NShip） | 0.9 | 1871 | 闪避上限 | defines.cwt:3797 |
| 18 | — | `MAX_DAMAGE_SCALING`（NShip） | 100 | 1873 | `size_damage_factor` 放大上限 | defines.cwt:3800 |
| 19 | — | `MISSILE_RETARGET_CHANCE_START` / `_REDUCTION` | 100 / 35 | 1996 / 1997 | 导弹重索敌（本文未展开） | defines.cwt:3998 / 4001 |
| + | — | `SHIP_DISENGAGE_INACTIVITY_DAYS`（4.6 新增） | 150 | 2004 | 无射程目标且无人瞄准达到该天数后强制脱战（≤0 关闭） | defines.cwt:3912 |

原版注释里几条值得直接引用的方向性说明：

- `COMBAT_SHIP_TARGETING_SIZE_MULT`：越高越倾向先打**小而脆**的船。
- `COMBAT_SHIP_TARGETING_TRACKING_MULT`：*needed to ensure high-tracking ships target high-evasion ships*——追踪放大正是为了补偿闪避惩罚。
- `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT`：*the less likely ships are to target Starbases over military ships & defense platforms*。
- `RANDOM_TARGETING_WEIGHT`：***Only affects ship's main target***——只作用于阶段一。

**规则层现状**：以上全部 defines 在 `defines.cwt` 中均已补齐 `###` 公式注释与 4.6.0 精确语义，编辑器悬停与补全可直接查看。

### 5.2 武器组件模板（`common/component_templates/`，规则 subtype `weapon_component_template`）

| 字段 | 进入公式的位置 | 规则与诊断现状（`components_consolidated.cwt`） |
|---|---|---|
| `damage`（`min` / `max`） | ΣD 基础（取区间中点，原版走 CSV） | `damage = { min = float max = float }`（:601），已补 `###` 文档 |
| `shield_damage` / `armor_damage` / `hull_damage` | `ms` / `ma` / `mh` 三层倍率 | `float`（:604 / :613 / :610），已补 `###` 文档 |
| `shield_penetration` / `armor_penetration` | 穿透（减硬化后夹 `[0,1]`） | `float`（:607 / :616），已补 `###` 文档 |
| `accuracy` / `tracking` | `p` 与 `τw`；引擎要求 `[0, 1]` | `float`（:627 / :631），已补 `###` 文档 + **`CW290`** `[0, 1]` 范围诊断 |
| `size_damage_factor` | 按目标尺寸放大（上限 100） | `float`（:649），已补 `###` 文档 + `CW290` `>= 0` 诊断 |
| `use_ship_main_target` | 选目标分派短路（§4.2 第 2 支） | `bool`（:121），已补 `###` 文档 |
| `target_weights = { … }` | `S` 的**加法**项 `wk`（§3.3） | **`<ship_size> = float` 强类型**（:577），已补 `###` 文档 |
| `targetable_ship_sizes = { … }` | 候选过滤（前置） | **`<ship_size>` 强类型**（:657） |
| `target_focus` | 枚举 `single(0)` / `spread(1)`，控制 10/50 tick 与 `Mcur`/`Mrec` | `enum[component_target_focus]`（:400），已补 4.6 实证 `###` 文档 |
| `firing_arc` / `min_range` / `range` | 沿用主目标时的射程/射界约束 | `float`（:565 / :568 / :623），已补 `###` 文档 |

### 5.3 船级与修饰符

- `ship_target_weight_mult`：4.6.0 ModifierType **`0x71`**（4.5.2 为 `0x6e`），类别含 Orbital Stations / Space Stations / **Military Ships** / Civilian Ships / Science Ships / Transport Ships / Ship Design Stats（`logs/modifiers.log:119`）→ 直接进入 `ŵtgt`（§2.4）。原版取值样本 6 处见 §2.4。
- 按船级的别名 `shipsize_$_target_weight_mult`（`ship_sizes.cwt:86`）：原版脚本未使用，属规则层/引擎层约定，已补 `###` 文档。
- `ship_sizes` 的 `size_multiplier`（`σ`，见 §2.1）、`default_behavior = <ship_behavior>`；`ship_behaviors` 的 `preferred_attack_range` / `attack_move_pattern` 等控制走位，**间接决定距离项 `d` 的分布**，从而影响索敌。

### 5.4 不要混入的其它权重

`game_rules.cwt` 的 `calc_planet_specific_war_attack_priority` 等属于**战争层面的优先级**，与本公式不同层；effects 的 `set_ai_*_weapon_preference` 系列是 **AI 配船偏好**，**不是战斗索敌**。同样，武器模板里的 `ai_weight`（`ENERGY_LANCE_1` 带 `ai_weight = { weight = 1 }`）是 AI 建造/决策权重，与索敌无关。

<a id="part6"></a>

## 6. 数值算例：护卫舰 vs 雷击舰

场景（沿用原实测算例，公式已在 4.6.0 源码确认完全不变）：两条船 + 一门 `ENERGY_LANCE`（伤害区间 `600–1500`，`mh 1.5 / ms 0.5 / ma 2.0`，`acc 0.85`，`trk 0`）。

| 量 | 护卫舰 | 雷击舰 |
|---|---|---|
| σ（`size_multiplier`） | 5.00 | 8.00 |
| ε（闪避） | 0.600 | 0.424 |
| 船体 / 盾 / 甲 | 240 / 225 / 225 | 720 / 0 / 0 |
| d | 72.0 | 64.5 |
| ŵtgt（本场实录） | 1.561 | 1.379 |

> **脚本层核验（N4）**：`σ = 5.00` 与 `8.00` 分别对应 vanilla 的 `@corvette_size_multiplier` 与 `@frigate_size_multiplier`（`03_scripted_variables_ships.txt:59/74`）。算例把 `σ = 8` 那条称为"雷击舰"，与 vanilla `frigate = { … default_behavior = torpedo … }` 吻合。

### 6.1 阶段一复算（每项独立核对通过）

| 量 | 护卫舰 | 雷击舰 | 复算 |
|---|---|---|---|
| W1 尺寸 | 0.8696 | 0.8065 | `1/(1+5×0.03)=0.8696` ✓；`1/(1+8×0.03)=0.8065` ✓ |
| 闪避因子 | 0.4545 | 0.5411 | `1/(1+0.6×2)=0.4545` ✓；`1/(1+0.424×2)=0.5411` ✓ |
| 距离因子 | 0.856 | 0.871 | `1−72×0.002=0.856` ✓；`1−64.5×0.002=0.871` ✓ |
| **W(ship)** | **0.528** | **0.524** | `0.8696×0.4545×0.856×1.561 = 0.528` ✓；`0.8065×0.5411×0.871×1.379 = 0.524` ✓ |
| p 命中率 | 0.250 | 0.426 | `0.85−0.6=0.25` ✓；`0.85−0.424=0.426` ✓ |

> ⚠️ **最容易读错的一点**：表格里的"闪避因子 `0.4545`"是**单步因子** `1/(1+Δ·κev)`，**不是累计值**（累计值应是 `0.8696×0.4545 = 0.395`）。同理"距离因子 `0.856`"也是单步因子。

**否决条件检查**：`τ = atrk × 2.0`。`trk = 0` 的光矛 `τ = 0`，两条船 `Δ = ε > 0`。但否决还要求 `σatt ≥ 8`——测试对象不是大船，故不触发，两条船都在候选集内。

### 6.2 阶段二：ΣD 与最终分数

实测记录的 ΣD 相对值为 **2.648 : 1.00**，`S(weapon)` 相对值 **1.76 : 1.00**。

**独立复算（零穿透、零硬化、无 modifier）**，按 16 号 §5 的三层模型逐步走：

- 基础伤害 `D = (600+1500)/2 = 1050`；`size_damage_factor = 0`，不做尺寸放大。
- 护卫舰：盾层 `s=0` → `Cs = 1050`，`D ← 1050 − min(1050, 225) = 825` → `Ds = 0.5×1050 = 525`；甲层 `a=0` → `Ca = 825`，`D ← 825 − min(825, 225) = 600` → `Da = 2.0×825 = 1650`；船体 `Dh = 1.5×600 = 900`。**`ΣD = 3075`**。
- 雷击舰：无盾无甲 → `Dh = 1.5×1050 = 1575`。**`ΣD = 1575`**。
- **比值 = `3075 / 1575 = 1.95×`**。

> **偏差说明**：实测 `2.648×` 与零穿透零硬化手算 `1.95×` 方向完全一致（带盾甲 → ΣD 更大），差额来自实测存档中未记录的 `ApplyModifier` 三方加成及穿透/硬化。

用 `1.95×` 复算武器层（斩杀加成两条船都命中：`Dh 900 ≥ 240`、`1575 ≥ 720`，双方同乘 `1.5`，比值不变；`ENERGY_LANCE_1` 的 `target_weights` 两条船都未命中，`wk = 0`）：

```text
S ∝ ΣD · p · ŵtgt
护卫舰：1.952 × 0.250 × 1.561 = 0.762
雷击舰：1.000 × 0.426 × 1.379 = 0.587      ⇒ 比值 ≈ 1.30
（用实测 2.648 代入：2.648 × 0.25 × 1.561 / (1 × 0.426 × 1.379) = 1.76 ✓）
```

### 6.3 结论

**阶段一两船基本持平（`0.528 : 0.524`，约 `1.01:1`）；阶段二护卫舰领先。** 由于 `ENERGY_LANCE` 的 `use_ship_main_target = no`（`00_weapons_extra_large.txt:15`），**实际按阶段二走 → 优先打带盾甲的护卫舰**。

**原因不是"盾甲吸引仇恨"，而是 ΣD 被盾甲顶高了 `1.95×~2.65×`，盖过了它高闪避带来的 `p` 劣势（`1/1.70`）。**

<a id="part7"></a>

## 7. modder 误区十条

1. **"盾甲吸引仇恨"是结果不是机制**。根因是 ΣD 的三层分摊中**层分量不被该层存量夹住**（§3.1、16 号 §5），不是引擎写了"优先打盾甲船"。
2. **`ai_weight` ≠ 索敌权重**。`ai_weight` 是 AI 建造/决策权重；战斗索敌的脚本抓手是 `ship_target_weight_mult`、`target_weights` 和 §5 的 defines。
3. **索敌不是每 tick 重算**。10/50 tick 错峰 + 无有效主目标才立即重算（§4.1）。改 define 不会"立即生效于每一帧"，观察行为变化要等一个完整节流周期。
4. **`target_weights` 是加法项**。可以碾压整条乘法链（§3.3），用法与直觉的"倍率"相反。vanilla 的 `ENERGY_LANCE_1` 给 titan 加 3 分就是这么用的。
5. **同设计不同命运**。开战随机量 `ρ ∈ [0,1)` 让同设计舰船每场战斗的 `ŵtgt` 都不同，整场不变、战后复位（§2.4）。复现 bug 时必须考虑这个量。
6. **打不中的小船会被大船整体无视**。满足否决条件即 `return 0`（§2.2），**是剔除不是低权重**——调 `κev` 根本救不回来，能救的只有 `σavoidmin` / `Tavoid`。
7. **斩杀加成只看船体分量 `Dh`**。4.6 源码（L1724475）已实证判据是 `Dh >= 目标当前船体 Vtgt`，不是三层总伤 `ΣD`（§3.2）。
8. **`use_ship_main_target = no` 的武器完全自选目标**。阶段一只决定"主目标是谁"，管不到它（§4.2）。想统一全舰队集火，必须让武器写 `yes` 并保证主目标在射程与射界内。
9. **`CanDoDamage` 看的是面板 DPD，且与星基降权互斥**。它是设计界面显示的数字，不是真实伤害；且无武装星基只乘 `0.005`，不会再乘 `0.75`（§2.5、§3.2）。
10. **随机扰动幅度极大，且 `Mcur` / `Mrec` 受 `target_focus` 控制**。`κr = 3.0` 意味着阶段一末项乘数 `∈ [1,4)`（仅影响舰船主目标，§2.6）；同时 `single (0)` 只用 `Mcur (1.1)`、不触发 `Mrec`，而 `spread (1)` / 困惑状态禁用 `Mcur`、改用 `Mrec (0.3)` 惩罚全部近期记忆目标（§4.3–§4.4）。

<a id="part8"></a>

## 8. 4.6.0 闭合核验与规则层现状

### 8.1 原未证实项 V1–V5 的闭合结果

| # | 原未证实项 | 4.6.0 实证结论 | 源码证据（`stellaris_4.6_source.cpp`） |
|---|---|---|---|
| V1 | `target_weights` 合法键集合 | ✅ **已闭合**：全部为 `common/ship_sizes` 的 `<ship_size>` id，CWT 已改为强类型 `<ship_size> = float` | `000_documentation.txt:81`、`components_consolidated.cwt:577` |
| V2 | 斩杀判据取 `Dh` 还是 PDF §2.3 的 `D2` | ✅ **已闭合**：取 `SDamageResult + 0x08`（**船体伤害分量 `Dh`**），满足 `Vtgt <= Dh` 时乘 `1.5` | `CWeaponComponentTargeting::ComputePotentialTargetScore` L1724475 |
| V3 | `target_focus` 枚举 `single/spread` 到引擎 `0/1` 映射 | ✅ **已闭合**：`0 = single`，`1 = spread`；`IsConfused` 强制视作 `1`；舰船层读设计 growth stage `+0x128`，武器层读武器模板 `+0x8d0` | `EnumToToken<ETargetFocus>` L473346、`TokenToEnum` L473366、`GetLocalizedTargetFocusFromEnum` L473380、`CShipTargeting::GetTargetFocus` L1723081、`CWeaponComponentTargeting::GetTargetFocus` L1724137 |
| V4 | 全部反编译行号与结构偏移 | ✅ **已闭合**：已全部核对并更新为 Stellaris 4.6.0 一手行号与偏移（见附录 B） | 17 个核心函数全量审读 |
| V5 | `NUMBER_OF_TARGETS_TO_REMEMBER` 记忆数组更新时机 | ✅ **已闭合**：在 **`UpdateTarget` 选出目标时**推入（非开火时），仅当 `IsConfused \|\| targetFocus == 1 (spread)` 时写入；满 10 条左移挤掉最老 `[0]` | `CShipTargeting::UpdateTarget` L1722846–L1722885、`CWeaponComponentTargeting::UpdateTarget` L1724000–L1724045 |

### 8.2 规则层与工具链同步状态

1. **`defines.cwt`**：19 项索敌 defines 与 4.6 新增的 `SHIP_DISENGAGE_INACTIVITY_DAYS` 全部配齐 `###` 公式文档（`:3797`–`:4001`，`:3912`）。
2. **`components_consolidated.cwt`**：`target_weights` 已升级为 `<ship_size> = float` 强类型（`:577`）；`target_focus`（`:400`）已写明 `single(0) / spread(1)` 映射与 `Mcur`/`Mrec` 语义；武器伤害/穿透/射程字段均已补齐 `###` 文档。
3. **范围诊断 `CW290`**：已校验 `accuracy` / `tracking` ∈ `[0, 1]` 与 `size_damage_factor >= 0`。
4. **共享计算器与预览面板**：`submodules/cwtools-mcp/packages/cwtools-shared/src/tools/targetingWeights.ts`（供 `query_targeting_weight` 工具与 VS Code **Analyze Targeting Weights** 面板共用）已按 4.6.0 一手源码同步修正无武装/星基互斥与 `spread`-only `Mrec`。

### 8.3 脚本侧原版取证路径（只读）

| 主题 | 原版路径 |
|---|---|
| 19 项 defines + 不活跃脱战 | `common/defines/00_defines.txt`（行号见 §5.1） |
| 武器组件字段语义注释 | `common/component_templates/000_documentation.txt`（:81 `target_weights`、:182 `use_ship_main_target`、:184 `target_focus`） |
| `target_weights` 原版用例 | `00_weapons_extra_large.txt:55`、`00_biogenesis_weapons.txt`、`00_weapons_archaeotechnology.txt`、`00_biogenesis_crisis_components.txt`、`00_weapons_critters_cutholoids.txt` |
| `ship_target_weight_mult` | `component_templates/00_dsc_auras.txt:23`、`ship_sizes/29_nomads_dlc_ships.txt:14`、`static_modifiers/25_static_modifiers_nomads.txt:139`、`static_modifiers/23_static_modifiers_biogenesis.txt:832/838/844` |
| 尺寸倍率 σ | `common/scripted_variables/03_scripted_variables_ships.txt` |
| 走位（影响 d） | `common/ship_sizes/*.txt` 的 `default_behavior`、`common/ship_behaviors/*.txt` |

<a id="appendix-a"></a>

## 附录 A：符号表

| 符号 | 含义 | 来源 |
|---|---|---|
| F | 定点单位 = 100000（脚本 1.0） | `CFixedPoint` |
| ⌊x⌋ | C 风格定点整数除法（向零截断） | 引擎算术 |
| σ / σ′ | 候选尺寸倍率 `size_multiplier`（`CShipSize+0x668`） / `min(σ, σmax)` | `ship_sizes` |
| σatt | 攻击方尺寸 | 攻击方 |
| σclass | 舰船类型枚举（`10` = 恒星基地/巨构） | `CShipSize` |
| atrk / τ | 攻击方追踪字段 / 归一化追踪 = `atrk·κtrk` | 攻击方 |
| ε / Δ | 候选闪避（`0..1`，上限 `0.9`） / `ε − τ` | 候选 |
| d / D | 候选距离 / 距离因子 `max(1−d·κd, dmin)` | 战斗状态 |
| wmult / ŵtgt | `ship_target_weight_mult`（ModifierType `0x71`） / 预置权重 = `wmult + (1+ρ)` | modifier + 开战随机 |
| ρ | 开战随机量 `∈ [0,1)`，存 `ship+0xf48`，整场不变，战后复位 | `CShip::OnCombatStarted` |
| r | 每轮扰动随机量 `∈ [0,1)` | `GetFixedPointForMacro` |
| h / θh | 目标血量百分比 / 残血阈值 `0.5` | `CShipTargeting` |
| ΣD / Ds / Da / Dh | 三层期望伤害和 / 护盾·装甲·船体分量 | `CalcDamage`（见 16 号） |
| p | 命中率 = `clamp(accw − clamp(εtgt − τw, 0,1), 0,1)` | `CalcChanceToHit` |
| accw / τw | 武器模板命中率（`+0x1150`） / 追踪率（`+0x1158`） | 武器模板 |
| mh / ms / ma | `hull_damage` / `shield_damage` / `armor_damage` 倍率 | 武器模板 |
| Vtgt | 目标当前船体（`this+0xb28`，斩杀判据 `Vtgt <= Dh`） | 目标 |
| wk | `target_weights` 表命中项（`+0x8b8`，**加法**） | 武器模板 |
| Mcur / Mrec | 当前目标 `1.1`（仅 `single(0)`） / 近期目标 `0.3`（仅 `spread(1)` / 困惑） | defines |
| fp | 节流周期，`10`（`single`）或 `50`（`spread` / 困惑） | `CShipTargeting::CalcBestTarget` |
| targetFocus | `0 = single` / `1 = spread`；舰船层读设计 `+0x128`，武器层读模板 `+0x8d0`；`IsConfused` 强制为 `1` | `ETargetFocus` |

<a id="appendix-b"></a>

## 附录 B：4.6.0 源码与脚本证据索引

**引擎一手源码（`stellaris_4.6_source.cpp`，Corona Borealis v4.6.0 `5d0adbc59353f1e9b085e0a2c4cb3d1a`）**

| 函数 | 行号 | 验证内容 |
|---|---|---|
| `EnumToToken<ETargetFocus>` / `TokenToEnum<ETargetFocus>` | 473346 / 473366 | `0 -> 0x44f5`, `1 -> 0x44f6` 双向映射 |
| `GetLocalizedTargetFocusFromEnum` | 473380 | `0 -> TARGET_FOCUS_SINGLE`, `1 -> TARGET_FOCUS_SPREAD` |
| `CShipTargeting::UpdateTarget` | 1722776（记忆写入 1722846–1722885） | `spread` / 困惑下选出新目标时写入记忆数组 |
| `CShipTargeting::CalcBestTarget` | 1722922（Mcur 1723010 / Mrec 1723030） | 10/50 tick 错峰节流、舰船层 `Mcur`/`Mrec` 互斥施加与 argmax |
| `CShipTargeting::GetTargetFocus` | 1723081 | 读舰船设计 growth stage `+0x128` |
| `CShipTargeting::ComputePotentialTargetScore` | 1723150（无武装/星基互斥 1723534–1723561） | Stage 1 乘法链、否决条件、无武装与星基 `if / else if` 互斥 |
| `CStrikeCraftTargeting::CalcBestTarget` | 1723743 | 舰载机独立选目标入口 |
| `CWeaponComponentTargeting::UpdateTarget` | 1723958（记忆写入 1724000–1724045） | `spread` / 困惑下武器选目标时写入记忆数组 |
| `CWeaponComponentTargeting::CalcBestTarget` | 1724078 | 打击机 (`+0x1288==2`) / `use_ship_main_target` (`+0x88 bit2`) / 自选三路分派 |
| `CWeaponComponentTargeting::GetTargetFocus` | 1724137 | 读武器模板 `+0x8d0` |
| `CWeaponComponentTargeting::CalcBestWeaponComponentTarget` | 1724214（Mcur 1724295 / Mrec 1724315） | 武器层 `Mcur` (`single`) / `Mrec` (`spread` 全部记忆项) 互斥施加 |
| `CWeaponComponentTargeting::ComputePotentialTargetScore` | 1724367（斩杀判据 1724475） | Stage 2 `ΣD·p·ŵtgt`、`Dh >= Vtgt` ×1.5、`CanDoDamage`、`+ wk` |
| `CFleetCombatManager::DailyUpdateSerial` / `ForceDisengageInactiveShips` | 3584223 / 3584242 | 4.6 新增 `SHIP_DISENGAGE_INACTIVITY_DAYS` 强制脱战 |
| `CShip::RegisterCombatActivity` | 3858542 | 写战斗活跃日 `ship + 0xdc4` |
| `CShip::GetTargetWeightFactor` | 3869039（ModifierType `0x71` 于 3869052） | `ŵtgt = wmult + (1 + ρ)` |
| `CShip::OnCombatStarted` / `OnCombatEnded` | 3873857（写 `ship+0xf48` 于 3873868） / 3873879 | 开战随机量 `ρ` 掷骰与战后复位 |

**脚本层与规则层（2026-11-28 实读核对）**

- 原版 4.6.0：`common/defines/00_defines.txt`（行号见 §5.1）、`common/component_templates/000_documentation.txt`、`00_weapons_extra_large.txt`、`common/scripted_variables/03_scripted_variables_ships.txt`、`common/ship_sizes/00_ship_sizes.txt`、`common/static_modifiers/23_static_modifiers_biogenesis.txt`、`25_static_modifiers_nomads.txt`、`common/component_templates/00_dsc_auras.txt`、`common/ship_sizes/29_nomads_dlc_ships.txt`。
- 本仓库规则：`submodules/cwtools-stellaris-config/config/common/defines.cwt`（:3797 / :3800 / :3912 / :3927–:4001）、`components_consolidated.cwt`（:121 / :400 / :565–:657）、`ship_sizes.cwt`（:86）、`logs/modifiers.log`（:119）。
- 系列内：[16_combat_damage_resolution.md](16_combat_damage_resolution.md)、[04_fleet_pathfinding_ai.md](04_fleet_pathfinding_ai.md)、[README.md](README.md)。
