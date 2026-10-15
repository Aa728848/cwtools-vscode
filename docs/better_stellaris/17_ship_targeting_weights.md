**群星舰船索敌权重计算公式——Stellaris 4.5.2**

整理日期：2026-10-13。转写与脚本层核对日期：2026-10-13。

依据：《[群星索敌权重计算公式 4.5.2](../群星索敌权重计算公式_4.5.2.pdf)》（古明地瓜 / KKoishi_ 反编译分析整理，地砖 & 清流蛋糕 rt 辅助数据验证）。该文基于 Stellaris 4.5.2（Cygnus，二进制 hash `32709cf254181b032b1b309a6ea09776`）的反编译产物 `stellaris_4.5.2_source.cpp`，**文中行号与结构偏移均以该 dump 为准**。

> **核验状态（2026-10-13）——请先读这一段**
>
> **本文字段级公式与全部反编译行号，均为【转写自上述 PDF】，未经本仓库对 `stellaris_4.5.2_source.cpp` 的独立逐条核验。** 本仓库当前**没有**该 dump 的可访问副本，因此无法比对行号、无法确认分支条件、无法复核结构偏移。凡本文出现的 `行 1577xxx`、`ship + 0x590`、`模板 +0x12e0 == 2` 之类断言，一律按"二手转述"对待。
>
> 这与姊妹篇 [16_combat_damage_resolution.md](16_combat_damage_resolution.md) 的状态**不同**：16 号是对 dump 逐条比对、约 60 项断言零反驳的**一手核验**文档（其 §15 有武器字段 ↔ 结构偏移对照表）。**引用本文时请一并引用该限定**；若两者冲突，以 16 号的一手结论为准。
>
> **本文实际做过独立核验的，只有脚本层（vanilla 文本）与规则层（CWT）**，逐项列在下方"本次独立核验清单"；未列入的一律是转写。
>
> **游戏版本**：`D:\Steam\steamapps\common\Stellaris`，`common/defines/00_defines.txt` 经本文实读核对（见 §5 表的"vanilla 行号"列）。姊妹篇 04 号引用的 `CShipTargeting::CalcBestTarget`（1477471）出自 **4.5** 的 870 万行 dump，与本文 PDF 的 **4.5.2**（行 1577208）不是同一份，行号不可混用。

**本次独立核验清单（2026-10-13，本文作者实读原版脚本与规则文件）**

| # | 核验对象 | 方法 | 结论 |
|---|---|---|---|
| N1 | 19 项 defines 的 vanilla 值 | 实读 `common/defines/00_defines.txt` | 全部一致，行号见 §5 表 |
| N2 | `target_weights` 的键集合 | 遍历 6 个原版 `component_templates/*.txt` 的全部 `target_weights = {}` 块 | 18 个去重键，**全部是 `common/ship_sizes` 的 id**（§3.3） |
| N3 | 键的语义 | 实读 `000_documentation.txt:81` | 原版注释明确"键为舰船尺寸名，见 common/ship_sizes" |
| N4 | `use_ship_main_target` 默认值 | 实读 `000_documentation.txt:182` | 注释"default no" |
| N5 | 算例中两条船的尺寸倍率 | 实读 `common/scripted_variables/03_scripted_variables_ships.txt` | `@corvette_size_multiplier = 5`、`@frigate_size_multiplier = 8`，与 PDF 表的 σ=5.00 / 8.00 吻合 |
| N6 | `ship_target_weight_mult` 的原版取值样本 | 全 `common/` 检索 | 6 处命中（见 §5.3），比 PDF 列举的多 4 处 |
| N7 | CWT 规则侧行号 | 实读 `defines.cwt` / `components_consolidated.cwt` / `ship_sizes.cwt` / `logs/modifiers.log` | 与设计文档 `docs/stellaris-targeting-weight-4.5.2.md` §5.1/§5.2 所引行号一致（§8） |

**阅读约定**

引擎内部使用定点数，`F = 100000`（脚本里的 1.0）。引擎的除法是 **C 风格定点整数除法（向零截断）**，PDF 记作 ⌊x⌋。本文公式一律给出**归一化形式**（把定点除法视作实数除法，`，` 处隐含除以 `F`），便于分析；需要定点精度的场合会单独注明。"修正后的量"指经 modifier 系统计算后的值。

**姊妹篇**

- [16_combat_damage_resolution.md](16_combat_damage_resolution.md)：伤害结算，本文 §3.1 的 ΣD 三层分摊细节、字段 ↔ 偏移对照、23 组算例全部在那里；本文只引用不重复。
- [04_fleet_pathfinding_ai.md](04_fleet_pathfinding_ai.md)：索敌节流原本只有一行提及，已改为指向本文。
- 设计输入：[docs/stellaris-targeting-weight-4.5.2.md](../stellaris-targeting-weight-4.5.2.md)（机制解读 + 差距分析 + 功能路线图，其 P1-3 即本文）。

阅读导航：

- [1. 两阶段总览](#part1)
- [2. Stage 1：舰船层权重 W(ship)](#part2)
- [3. Stage 2：武器层分数 S(weapon)](#part3)
- [4. 调用端与节流](#part4)
- [5. defines 全表](#part5)
- [6. 数值算例：护卫舰 vs 雷击舰](#part6)
- [7. modder 误区十条](#part7)
- [8. 未证实项与脚本侧取证](#part8)
- [附录 A：符号表](#appendix-a)
- [附录 B：证据索引](#appendix-b)
<a id="part1"></a>

## 1. 两阶段总览

索敌是**两阶段、argmax（取最大值，而不是加权抽签）、带错峰节流**的过程。**阶段一回答"这个目标好不好打、值不值得打"，阶段二回答"这门武器打它能造成多少有效伤害"；两者相乘后取最大。**

```
 敌方候选船（同星系 · 可被攻击 · 非 FTL/隐身）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 1  舰船层        CShipTargeting::ComputePotentialTargetScore
│                                                              │
│   W(ship) = 尺寸项 W1                                        │
│           × 追踪-闪避项 W2/W1   （含"打不中即整目标剔除"的否决）
│           × 距离项   W3/W2
│           × 预置权重 W4/W3   （wtgt = ship_target_weight_mult + (1+ρ)）
│           × 残血项   W5/W4                                  │
│           × 无武装 / 星基项 W6/W5                            │
│           × 随机扰动 (1 + r·κr)      ← 乘数 ∈ [1, 4)          │
│                                                              │
│   结算：argmax → 舰船主目标（带 10/50 tick 错峰节流）           │
└──────────────────────────────────────────────────────────────┘
        │  （use_ship_main_target = yes 的武器在此直接短路）
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Stage 2  武器层      CWeaponComponentTargeting::ComputePotentialTargetScore
│                                                              │
│   S(weapon) = ΣD × 命中率 p × 预置权重 ŵtgt                   │
│             × 斩杀加成 (×1.5，单发可打穿船体时)               │
│             × 无还手降权 (×0.005)                            │
│             + wk   （target_weights 表命中项，加法）          │
│                                                              │
│   结算：当前目标 ×Mcur(1.1) / 近期目标 ×Mrec(0.3) 后 argmax    │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
 每门武器各自的开火目标
```

**短路分支**：武器模板写了 `use_ship_main_target = yes` 时，武器直接沿用**舰船主目标**（前提：主目标在射程与射界内），Stage 2 整段不参与。`ENERGY_LANCE`（泰坦光矛）写的恰恰是 `no`，所以它完全按武器层分数自选目标——这一点在原版模板里可以直接读到（`common/component_templates/00_weapons_extra_large.txt:15`，本文已核）。

**节流**：舰船已有有效主目标时，只在 `(TotalTicks + shipID) mod fp == 0` 的 tick 重算权重（`fp = 50` 当 targetFocus = 1，否则 `10`）；**没有有效主目标时才立刻重算**。**索敌权重不是每 tick 重算的。**详见 §4.1。

<a id="part2"></a>

## 2. Stage 1：舰船层权重 W(ship)

对应 `CShipTargeting::ComputePotentialTargetScore`（PDF 记行 1577446，**转写，未核**）。

**前置条件（不满足直接返回无效）**：候选与自己同星系、可被攻击、不处于跳跃/隐身位掩码中。

整体是一条**乘法链**：

```
W(ship) = W1 · (W2/W1) · (W3/W2) · (W4/W3) · (W5/W4) · (W6/W5) · (1 + r·κr)
```

> ⚠️ 归一化形式下的除法在定点实现里是 `F·prev / F` 的整数除法（向零截断），逐级截断。PDF 把乘法链写成 W2 = W1 / (…) 的递推形式，实测算例中每一步单独给出的是**单步因子**（不是累计值）——见 §6，这一点最容易读错。

### 2.1 尺寸项（基准项，单调递减）

```
σ′ = min(σ, σmax)              σ = 候选船 size_multiplier，σmax = 10
W1 = 1 / (1 + σ′·κsize)         κsize = 0.03
```

**注意这是赋值而不是累乘**：σ → 0 时 W1 → 1，值域 (0, 1]，随尺寸单调递减。护卫舰（σ=5）得 0.870，泰坦级（σ=80 原版值，远超封顶）取 σ′=10 得 0.769。

> **本文独立核验（N5）**：`@corvette_size_multiplier = 5`、`@battleship_size_multiplier = 40`、`@titan_size_multiplier = 80`，定义在 `common/scripted_variables/03_scripted_variables_ships.txt`。也就是说 **vanilla 主力舰的 σ 全部 ≥ σmax = 10**，尺寸项对主力舰之间几乎没有区分度（0.769 一律），真正拉开差距的只有护卫舰/巡防舰这一档。这也解释了为什么"大船之间互相转移仇恨"看起来是随机的——见 §2.6。

### 2.2 追踪–闪避项（含整目标否决）

```
τ = atrk · κtrk                 κtrk = 2.0，atrk = 攻击方追踪字段
ε = 候选闪避（0..1，受 SHIP_MAX_EVASION = 0.9 上限约束）
Δ = ε − τ
```

**否决条件（整目标剔除，不是低权重）**：

```
Δ > 0  ∧  σatt ≥ σavoidmin (8)  ∧  Δ ≥ Tavoid (0.7)
        ∧  ∃ q ∈ F_tgt : ε_q − τ < Tavoid     ⇒  return 0
```

其中 `F_tgt` 是候选目标所在舰队的舰船集合，`σatt` 是攻击方尺寸。即：**大船对高闪避小船"懒得追"——只要对方舰队里还打得中，就把打不中的那艘整个踢出候选集**。这是"高闪避小船被无视"传言的真正机制。

**闪避惩罚**（未被否决且 Δ > 0 时）：

```
W2 = W1 / (1 + Δ·κev)      κev = 2.0
W2 = W1                   Δ ≤ 0（追踪盖过闪避，无惩罚）
```

### 2.3 距离项

```
D  = max(1 − d·κd, dmin)      κd = 0.002，dmin = 0.10
W3 = W2 · D
```

d 为候选距离（引擎单位）。线性衰减，**d ≥ 450 时触到下限 0.10**，此后再远也不再减分。

### 2.4 目标预置权重 wtgt（modder 的主要抓手）

```
W4 = W3 · ŵtgt
ŵtgt = wmult + (1 + ρ)
```

- `wmult = GetModifierValue(shipSize, 0x6e)`，即 **ModifierType `MOD_SHIP_TARGET_WEIGHT_MULT` = 0x6e**，规则名 `ship_target_weight_mult`（ModifierType 常量注册处 PDF 记行 958356）。这是**船级 modifier**，按船级的别名是 `shipsize_$_target_weight_mult`（规则层见 `ship_sizes.cwt:85`；**原版脚本未使用该别名**，属引擎/规则层约定）。
- **ρ 是开战瞬间每艘船各掷一次的随机量**：`CShip::OnCombatStarted`（PDF 记行 3830406）用 `CRandom::GetFixedPointForMacro` 写入 `ship + 0xe88`，**整场战斗保持不变**，`OnCombatEnded` 时复位为 1.0。因此两条设计完全相同的船，每场战斗也会被赋予不同的"被偏爱度"（PDF 实测两场分别为 1.326/1.486 与 1.561/1.379）。
- 取值来源 `CShip::GetTargetWeightFactor`（PDF 记行 3824970）。

> **本文独立核验（N6）**：原版 `common/` 中 `ship_target_weight_mult` 共 6 处命中，比 PDF 列举的多——
>
> | 值 | 位置 | 语义 |
> |---|---|---|
> | `0.50` | `component_templates/00_dsc_auras.txt:23` | 光环类组件（PDF 已列） |
> | `−0.5` | `ship_sizes/29_nomads_dlc_ships.txt:14` | Nomads 系船级（PDF 已列） |
> | `10` | `static_modifiers/25_static_modifiers_nomads.txt:139` | Nomads 静态修正（**PDF 未列**） |
> | `0.10` / `0.25` / `0.50` | `static_modifiers/23_static_modifiers_biogenesis.txt:832/838/844` | 生物生成（**PDF 未列**） |
>
> 注意 `10` 这一条：ŵtgt 是个**加法量**而非倍率上限，写大了会让该船在任何比较里都压过全场。

### 2.5 残血 / 无武装 / 星基

```
h < θh (0.5)                      → ×κh  (1.5)    残血目标更优先（"收人头"）
¬ CanDoDamage(tgt)                → ×κun (0.005)  几乎不再打
σclass = 10（恒星基地/巨构）且 tgt ≠ mainTarget → ×κsb (0.75)
```

- `σclass` 是舰船类型枚举，10 表示恒星基地/巨构。第二条分支的判定可以写作取反的合取：`¬(tgt = mainTarget ∧ mainTargetValid)`。
- `CanDoDamage` **只看面板 DPD（Damage Per Day）是否 < 0**，且这个 DPD 是**舰船设计界面显示的数字，不是真实伤害数据**。它同时出现在 Stage 1（×0.005）和 Stage 2（×0.005）。

### 2.6 随机扰动

```
W(ship) = W6 · (1 + r·κr)       r ∈ [0, 1)，κr = 3.0   ⇒   乘数 ∈ [1, 4)
```

`r` 同样由 `CRandom::GetFixedPointForMacro` 给出。`CShipTargeting::CalcBestTarget` **默认传 `useRandom = true`**。

**这一项幅度极大（最高 4 倍），是"为什么索敌看起来不稳定"的主因之一。** 原版注释写得很直白："The higher this is, the more random ship targeting will be. **Only affects ship's main target**"——它只作用于阶段一，阶段二的武器自选目标不受它影响。调试索敌行为时，先想办法压低这一项，再谈其他（误区十条的第 10 条）。

<a id="part3"></a>

## 3. Stage 2：武器层分数 S(weapon)

对应 `CWeaponComponentTargeting::ComputePotentialTargetScore`（PDF 记行 1578737，**转写，未核**）。

### 3.1 期望伤害 ΣD 与命中率 p

**计算顺序**（PDF 称"调用顺序已用 objdump 核对"，**该核对本仓库未复核**）：

1. 把武器模板的 `SAttackInfo`（模板 +0x11c8 起、约 0x84 字节）拷到栈上。区间编码为 `(min, max − min)`：`+0x11c8` 是最小伤害，`+0x11d0` 是**跨度**，均值 = min + 跨度/2。
2. `CShip::ApplyModifier` 就地改写这份拷贝——修正集合由**攻击方 + 控制方 + 目标**（用目标 ship size 构造）三方组成。**所以用的是修正加成后的伤害，不是模板基础值。**
3. `NCombatRules::CalcDamage` 拿这份"已修正"的 `SAttackInfo` 与目标的 `SDefenseInfo` 算出三个伤害分量。
4. `NCombatRules::CalcChanceToHit` 算命中率。

```
ΣD = Ds + Da + Dh          三层伤害分量之和
p  = clamp( accw − clamp( ε_tgt − τw, 0, 1), 0, 1 )
```

**ΣD 的细节、三层分摊模型、穿透/硬化、溢出、以及武器字段 ↔ 结构偏移对照，全部见 [16_combat_damage_resolution.md](16_combat_damage_resolution.md) §3–§5 与 §15。** 本文只保留与索敌解读直接相关的三点：

1. **索敌路径 `useRandom = false`**，基础伤害取区间中点，不做随机抽取。
2. **关键反直觉点——层分量不被该层存量夹住**。只有"从剩余伤害里扣减的量"才被 `min` 夹住，`Cs` / `Ca` 由剩余伤害折算而来，**可以远大于该层当前的盾/甲量**。因此**带盾/带甲的目标算出来的 ΣD 反而更大**：PDF 实测同一门武器对"225 盾 + 225 甲 + 240 船体"的 ΣD 是对"720 船体、0 盾 0 甲"目标的 **1.58× ~ 2.65×**。这就是"盾甲吸引仇恨"传言的根因——**它不是机制，是 ΣD 的算术副作用**。**唯一有效的反制是高闪避**（压低 p）。
3. `size_damage_factor`：仅当 > 0 时按目标尺寸放大伤害，`sz = clamp(σ, 1, 100)`，上限即 `MAX_DAMAGE_SCALING`（NShip = 100）。

命中率字段 `accw` / `τw`（模板 `+0x11a8` / `+0x11b0`）在引擎里有 "Accuracy / Tracking **should be between 0.0 and 1.0**" 的报错文案——**规则层目前无任何对应范围校验**（见 §8）。

### 3.2 基础分数、斩杀加成、无还手降权

```
S0 = ΣD · p · ŵtgt                       ŵtgt 就是 Stage 1 的预置权重（含开战随机 ρ）
S1 = 1.5 × S0                            若可单发斩杀（见下）
S2 = κun (0.005) × S1                    目标无还手能力（面板 DPD ≤ 0）
S(weapon) = S2 + wk                      wk = target_weights 表中该目标船尺寸名对应的值
```

- **斩杀判据**：船体分量能打穿目标当前船体。PDF §2.3 的公式写的是 `Vtgt ≤ D2`，而其附录 C 的 sret 表写明 `+0x08 Dh`（船体分量）"**← 斩杀加成判据用的就是它**"。设计文档采纳的是 **Dh**（§7 误区第 7 条）。本仓库无 dump，**这一处采用设计文档的判读并标注为待核**（见 §8 V2）。
- `CanDoDamage` 同样是面板 DPD < 0 判定，不是真实伤害。

### 3.3 `target_weights`：加法项，不是倍率

`wk` 来自武器模板的 `SShipSizeNameTargetWeightPair` 表（表 +0x910、数量 +0x91c、每项 0x40 字节、键 +0x30、值 +0x38），**键为舰船尺寸名**。

> **本文独立核验（N2/N3）**：遍历原版 6 个 `component_templates/*.txt` 中的**全部** `target_weights = {}` 块，去重后共 **18 个键**：
> `corvette`、`frigate`、`destroyer`、`cruiser`、`battleship`、`titan`、`mauler_stage_1..3`、`weaver_stage_1..3`、`harbinger_stage_1..3`、`stinger_stage_1..3`。
> **18 个全部是 `common/ship_sizes/*.txt` 中定义的 `<ship_size>` id，无一例外。** 原版注释（`000_documentation.txt:81`）也写明："This increases the weight to target a specific ship size, see common/ship_sizes for options."
>
> 这解决了姊妹设计文档 §10 的未证实项 **V1**（在 vanilla 范围内）：键集合 = ship_size id。但要注意 CWT 规则层目前把它声明为 `scalar = float`（`components_consolidated.cwt:566-569`），**错键不报错、无补全**，与相邻 `targetable_ship_sizes` 的 `<ship_size>` 强类型（:629-632）不对称。

**正因为它是加法项**，写在武器模板里的"优先打某类目标"可以**盖过整条乘法链**。vanilla 实例（`00_weapons_extra_large.txt:55-61`，`ENERGY_LANCE_1`）：

```
target_weights = {
    titan            = 3
    battleship       = 2
    stinger_stage_1  = 1.5
    stinger_stage_2  = 2
    stinger_stage_3  = 2
}
```

 titan 得 3 分 —— 而阶段一整条乘法链在典型值下也就落在 0.3~0.6 区间。**用法与直觉的"倍率"完全相反。**

<a id="part4"></a>

## 4. 调用端与节流

### 4.1 舰船主目标：`CShipTargeting::CalcBestTarget`（PDF 记行 1577208，转写）

枚举敌方候选船 → 逐个调 `ComputePotentialTargetScore` 拿 W(ship) → **取最大值（argmax，不是加权抽签）**。两个关键行为：

**① 错峰节流**（PDF 记行 1577268–1577275）：

```
若已有有效主目标：  (TotalTicks + shipID) mod fp ≠ 0  ⇒  保留当前主目标，跳过整轮权重计算
fp = 50（当 targetFocus = 1）否则 10
```

有效主目标 = 同星系、存活、非 disabled/cloak。`targetFocus` 取自设计 growth stage `+0x128`，**`IsConfused` 时为 1**——此时节流周期拉长到 50 tick，且**失去当前目标的粘性**（Mcur 不再施加）。

**② `Mcur` 只在 `targetFocus = 0` 时才施加**（舰船层与武器层一致）。

> **版本提示**：04 号文档记的 `CalcBestTarget` 行号 1477471 来自 **4.5** 的 870 万行 dump；本文 PDF 记的是 **4.5.2** dump 的行 1577208。函数名与行为一致，**行号不可跨 dump 引用**。

### 4.2 武器选目标：`CWeaponComponentTargeting::CalcBestTarget`（PDF 记行 1578480）

按顺序分派：

1. **组件模板 `+0x12e0 == 2`（舰载机/打击机）** → `CStrikeCraftTargeting::CalcBestTarget`；
2. **`use_ship_main_target` 置位**（PDF 记为模板 `+0x10` 的 bit2） → `GetShipMainTargetIfValid`：**直接沿用舰船主目标**，前提是主目标在射程与射界内；
3. **否则** → `CalcBestWeaponComponentTarget`，每门武器自己按 S(weapon) 取 argmax。

规则层的 `use_ship_main_target` 是 bool（`components_consolidated.cwt:118`）。**本文独立核验（N4）**：原版注释（`000_documentation.txt:182`）明确 "if yes, overrides target_type and target_focus when ship's main target is within range, **default no**"。

### 4.3 最终比较：`CalcBestWeaponComponentTarget`（PDF 记行 1578577）

设候选集合为 C，当前既定目标为 c★：

```
S̃(c) = S(weapon)(c) · Mcur     当 c = c★ 且 targetFocus = 0 且主目标有效
S̃(c) = S(weapon)(c)            否则
S̃(c) ← S̃(c) · Mrec             若 c ∈ R \ { r0 }
c★ = argmax_{c ∈ C} S̃(c)
```

- `Mcur = 1.1`（当前目标粘性），`Mrec = 0.3`（近期目标惩罚）。
- `R` 是"最近目标记忆"数组，长度 `NUMBER_OF_TARGETS_TO_REMEMBER` = 10；`r0` 是数组头部（最近一次的目标）。**只有落在记忆里、且不是最新一项的目标才吃 `Mrec`**——这条注释的用途是"spread（散射）时避免来回点火"，与 `target_focus` 的 spread 语义对应。
- 两个修正都只影响 argmax 的比较，不改变 c★ 之外目标之间的排序语义。

### 4.4 targetFocus 与脚本 `target_focus`

引擎侧 `targetFocus` 取自设计 growth stage `+0x128`（`IsConfused` 时为 1），控制两件事：节流周期 10 ↔ 50、以及 Mcur 是否生效。规则层对应字段是武器组件的 `target_focus = enum[component_target_focus] { single, spread }`（`components_consolidated.cwt:394`）。

> ⚠️ **枚举值到引擎 0/1 的映射未证实。** 见 §8 V3。

<a id="part5"></a>

## 5. defines 全表

### 5.1 系数表（19 项）

**全部 19 项已由本文对 `D:\Steam\steamapps\common\Stellaris\common\defines\00_defines.txt`（v4.5.2）逐条实读核对，值与行号一致**（核验 N1）。"vanilla 行号"列指该文件行号。

| # | 符号 | define | vanilla 值 | vanilla 行号 | 环节 | CWT 规则行号 |
|---|---|---|---|---|---|---|
| 1 | κsize | `COMBAT_SHIP_TARGETING_SIZE_MULT` | 0.03 | 1886 | 尺寸项斜率 | defines.cwt:3780 |
| 2 | σmax | `COMBAT_SHIP_TARGETING_SIZE_MAX` | 10 | 1887 | 尺寸封顶 | defines.cwt:3782 |
| 3 | κtrk | `COMBAT_SHIP_TARGETING_TRACKING_MULT` | 2.0 | 1888 | 追踪放大 | defines.cwt:3784 |
| 4 | κev | `COMBAT_SHIP_EVASION_TARGETING_WEIGHT` | 2.0 | 1889 | 闪避惩罚斜率 | defines.cwt:3786 |
| 5 | θh | `COMBAT_SHIP_LOW_HEALTH_THRESHOLD` | 0.5 | 1890 | 残血阈值 | defines.cwt:3788 |
| 6 | κh | `COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT` | 1.5 | 1891 | 残血倍率 | defines.cwt:3790 |
| 7 | κd | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT` | 0.002 | 1892 | 距离衰减 | defines.cwt:3792 |
| 8 | dmin | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN` | 0.10 | 1893 | 距离下限 | defines.cwt:3794 |
| 9 | κun | `COMBAT_SHIP_UNARMED_TARGETING_WEIGHT` | 0.005 | 1894 | 无武装降权 | defines.cwt:3796 |
| 10 | κsb | `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT` | 0.75 | 1895 | 星基降权 | defines.cwt:3798 |
| 11 | σavoidmin | `COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE` | 8 | 1896 | 否决的攻击方尺寸门槛 | defines.cwt:3800 |
| 12 | Tavoid | `COMBAT_SHIP_EVASION_AVOID_THRESHOLD` | 0.7 | 1897 | 否决的 Δ 门槛 | defines.cwt:3802 |
| 13 | κr | `RANDOM_TARGETING_WEIGHT` | 3.0 | 1882 | 随机扰动幅度，乘数 ∈ [1, 4) | defines.cwt:3776 |
| 14 | Mcur | `SHIP_CURRENT_TARGET_MULTIPLIER` | 1.1 | 1876 | 当前目标粘性（应 > 1） | defines.cwt:3770 |
| 15 | Mrec | `SHIP_RECENT_TARGET_PENALIZER` | 0.3 | 1878 | 近期目标惩罚（应在 0~1） | defines.cwt:3772 |
| 16 | — | `NUMBER_OF_TARGETS_TO_REMEMBER` | 10.0 | 1880 | 近期记忆长度 | defines.cwt:3774 |
| 17 | — | `SHIP_MAX_EVASION`（NShip） | 0.9 | 1785 | 闪避上限 | defines.cwt:3643 |
| 18 | — | `MAX_DAMAGE_SCALING`（NShip） | 100 | 1787 | size_damage_factor 放大上限 | defines.cwt:3645 |
| 19 | — | `MISSILE_RETARGET_CHANCE_START` / `_REDUCTION` | 100 / 35 | 1910 / 1911 | 导弹重索敌（**本文未展开**） | defines.cwt:3825 / 3827 |

原版注释里几条值得直接引用的方向性说明（本文实读）：

- `COMBAT_SHIP_TARGETING_SIZE_MULT`：越高越倾向先打**小而脆**的船。
- `COMBAT_SHIP_TARGETING_TRACKING_MULT`：*needed to ensure high-tracking ships target high-evasion ships*——追踪放大正是为了补偿闪避惩罚。
- `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT`：*the less likely ships are to target Starbases over military ships & defense platforms*。
- `RANDOM_TARGETING_WEIGHT`：***Only affects ship's main target***——只作用于阶段一。

**规则层现状**：以上 19 项在 `defines.cwt` 中**全部只是裸 `float` 声明，无 `###` 注释**，hover 上看不到任何公式说明（姊妹设计文档路线图 P0-2 即针对此项）。

### 5.2 武器组件模板（`common/component_templates/`，规则 subtype `weapon_component_template`）

| 字段 | 进入公式的位置 | 规则现状（CWT 行号） |
|---|---|---|
| `min_damage` / `max_damage` | ΣD 基础（取区间中点） | float（:588 `damage = { min max }`；:586 注释说明原版走 CSV） |
| `shield_damage` / `armor_damage` / `hull_damage` | ms / ma / mh 三层倍率 | float（:590 / :596 / :594），**无公式文档** |
| `shield_penetration` / `armor_penetration` | 穿透（减硬化后夹 [0,1]） | float（:592 / :598），无文档 |
| `accuracy` / `tracking` | p 与 τw；**引擎要求 0..1** | float（:606 / :608），**无范围诊断** |
| `size_damage_factor` | 按目标尺寸放大（上限 100） | float（:624） |
| `use_ship_main_target` | 选目标分派短路（§4.2 第 2 支） | bool（:118），无文档 |
| `target_weights = { … }` | S 的**加法**项 wk（§3.3） | **键为 `scalar = float`，无类型无文档**（:566-569） |
| `targetable_ship_sizes = { … }` | 候选过滤（前置） | **`<ship_size>` 强类型**（:629-632）——与上行不对称 |
| `target_focus` | 节流周期 / Mcur 生效 | enum[`component_target_focus`]（:394），映射未证实 |
| `firing_arc` / `min_range` / `range` | 沿用主目标时的射程/射界约束 | float（:604 `range`、:560 `min_range`） |

### 5.3 船级与修饰符

- `ship_target_weight_mult`：ModifierType **0x6e**，类别含 Orbital Stations / Space Stations / **Military Ships** / Civilian Ships / Science Ships / Transport Ships / Ship Design Stats（`logs/modifiers.log:119`，本文实读）→ 直接进入 ŵtgt（§2.4）。原版取值样本 6 处见 §2.4 的核验表。
- 按船级的别名 `shipsize_$_target_weight_mult`（`ship_sizes.cwt:85`，本文实读）：**原版脚本未使用**，属规则层/引擎层约定。
- `ship_sizes` 的 `size_multiplier`（σ，见 §2.1）、`default_behavior = <ship_behavior>`；`ship_behaviors` 的 `preferred_attack_range` / `attack_move_pattern` 等控制走位，**间接决定距离项 d 的分布**，从而影响索敌。

### 5.4 不要混入的其它权重

`game_rules.cwt` 的 `calc_planet_specific_war_attack_priority` 等属于**战争层面的优先级**，与本公式不同层；effects 的 `set_ai_*_weapon_preference` 系列是 **AI 配船偏好**，**不是战斗索敌**。同样，武器模板里的 `ai_weight`（`ENERGY_LANCE_1` 就带 `ai_weight = { weight = 1 }`，见 `00_weapons_extra_large.txt:63-69`）是 AI 建造/决策权重，与索敌无关。

<a id="part6"></a>

## 6. 数值算例：护卫舰 vs 雷击舰

场景（转写自 PDF §7 的实测记录）：两条船 + 一门 `ENERGY_LANCE`（伤害区间 600–1500，mh 1.5 / ms 0.5 / ma 2.0，acc 0.85，trk 0）。

| 量 | 护卫舰 | 雷击舰 |
|---|---|---|
| σ（size_multiplier） | 5.00 | 8.00 |
| ε（闪避） | 0.600 | 0.424 |
| 船体 / 盾 / 甲 | 240 / 225 / 225 | 720 / 0 / 0 |
| d | 72.0 | 64.5 |
| ŵtgt（本场实录） | 1.561 | 1.379 |

> **本文独立核验（N5）**：σ = 5.00 与 8.00 分别对应 vanilla 的 `@corvette_size_multiplier` 与 `@frigate_size_multiplier`（`03_scripted_variables_ships.txt:59/74`）。PDF 把 σ=8 那条称为"雷击舰"，与 vanilla `frigate = { … default_behavior = torpedo … }`（`00_ship_sizes.txt:207/233`）的行为描述吻合——**本文沿用 PDF 的原称呼以保持一致**，读者按 σ=8 的尺寸档理解即可。**闪避、距离、ŵtgt 三列是运行时记录，本仓库未复测。**

### 6.1 阶段一复算（每项独立核对通过）

| 量 | 护卫舰 | 雷击舰 | 复算 |
|---|---|---|---|
| W1 尺寸 | 0.8696 | 0.8065 | 1/(1+5×0.03)=0.8696 ✓；1/(1+8×0.03)=0.8065 ✓ |
| 闪避因子 | 0.4545 | 0.5411 | 1/(1+0.6×2)=0.4545 ✓；1/(1+0.424×2)=0.5411 ✓ |
| 距离因子 | 0.856 | 0.871 | 1−72×0.002=0.856 ✓；1−64.5×0.002=0.871 ✓ |
| **W(ship)** | **0.528** | **0.524** | 0.8696×0.4545×0.856×1.561 = 0.528 ✓；0.8065×0.5411×0.871×1.379 = 0.524 ✓ |
| p 命中率 | 0.250 | 0.426 | 0.85−0.6=0.25 ✓；0.85−0.424=0.426 ✓ |

> ⚠️ **最容易读错的一点**：PDF 表格里的"闪避因子 0.4545"是**单步因子** `1/(1+Δ·κev)`，**不是累计值**（累计值应是 0.8696×0.4545 = 0.395）。同理"距离因子 0.856"也是单步因子。理解错这一层会导致整条链算错一倍量级。

**否决条件检查**：τ = atrk × 2.0。trk = 0 的光矛 τ = 0，两条船 Δ = ε > 0。但否决还要求 σatt ≥ 8——测试对象不是大船，故不触发，两条船都在候选集内。

### 6.2 阶段二：ΣD 与最终分数

PDF 记录的 ΣD 相对值为 **2.648 : 1.00**，S(weapon) 相对值 **1.76 : 1.00**。

**本文的独立复算（假设穿透 = 硬化 = 0、无任何 modifier）**，按 16 号 §5 的三层模型逐步走：

- 基础伤害 D = (600+1500)/2 = **1050**；`size_damage_factor` 未给出，置 0，不做尺寸放大。
- 护卫舰：盾层 s=0 → Cs = 1050，D ← 1050 − min(1050, 225) = 825 → Ds = 0.5×1050 = **525**；甲层 a=0 → Ca = 825，D ← 825 − min(825, 225) = 600 → Da = 2.0×825 = **1650**；船体 Dh = 1.5×600 = **900**。**ΣD = 3075**。
- 雷击舰：无盾无甲 → Dh = 1.5×1050 = **1575**。**ΣD = 1575**。
- **比值 = 3075 / 1575 = 1.95×**。

> **与 PDF 的偏差说明（诚实交代）**：PDF 实测 2.648×，本文零穿透零硬化假设下得 1.95×。**方向完全一致（带盾甲 → ΣD 更大），量级同阶，但数值不等**。差额应来自 PDF 未记录的真实 `shield_penetration` / `armor_penetration` 与目标硬化值，以及 `ApplyModifier` 三方修正后的伤害（本作 `ma = 2.0` 极高，穿透对结果影响显著）。**结论的定性部分稳健，定量倍率必须以实测为准。**

用本文的 1.95× 复算武器层（斩杀加成两条船都命中：Dh 900 ≥ 240、1575 ≥ 720，**双方同乘 1.5，比值不变**；ŵtgt 已知）：

```
S ∝ ΣD · p · ŵtgt
护卫舰：1.952 × 0.250 × 1.561 = 0.762
雷击舰：1.000 × 0.426 × 1.379 = 0.587      ⇒ 比值 ≈ 1.30
（用 PDF 实测的 2.648 代入：2.648 × 0.25 × 1.561 / (1 × 0.426 × 1.379) = 1.76 ✓）
```

> **另注（N2 相关）**：`ENERGY_LANCE_1` 的 `target_weights` 键是 titan / battleship / stinger_stage_*，本算例两条船都不命中，**wk = 0**，不影响比值。

### 6.3 结论

**阶段一两船基本持平（0.528 : 0.524，比值约 1.01:1；PDF 记为 0.99，按雷击/护卫方向）；阶段二护卫舰领先。** 由于 `ENERGY_LANCE` 的 `use_ship_main_target = no`（`00_weapons_extra_large.txt:15`），**实际按阶段二走 → 优先打带盾甲的护卫舰**。

**原因不是"盾甲吸引仇恨"，而是 ΣD 被盾甲顶高了 1.95×~2.65×，盖过了它高闪避带来的 p 劣势（1/1.70）。**

<a id="part7"></a>

## 7. modder 误区十条

1. **"盾甲吸引仇恨"是结果不是机制**。根因是 ΣD 的三层分摊中**层分量不被该层存量夹住**（§3.1、16 号 §5），不是引擎写了"优先打盾甲船"。
2. **`ai_weight` ≠ 索敌权重**。`ai_weight` 是 AI 建造/决策权重（出现在 traits/zones/starbases 以及每个武器模板里）；战斗索敌的脚本抓手是 `ship_target_weight_mult`、`target_weights` 和 §5 的 defines。
3. **索敌不是每 tick 重算**。10/50 tick 错峰 + 无有效主目标才立即重算（§4.1）。改 define 不会"立即生效于每一帧"，观察行为变化要等一个完整节流周期。
4. **`target_weights` 是加法项**。可以碾压整条乘法链（§3.3），用法与直觉的"倍率"相反。vanilla 的 `ENERGY_LANCE_1` 给 titan 加 3 分就是这么用的。
5. **同设计不同命运**。开战随机量 ρ ∈ [0,1) 让同设计舰船每场战斗的 ŵtgt 都不同，整场不变、战后复位（§2.4）。复现 bug 时必须固定这个量。
6. **打不中的小船会被大船整体无视**。满足否决条件即 `return 0`（§2.2），**是剔除不是低权重**——调 `κev` 根本救不回来，能救的只有 `σavoidmin` / `Tavoid`。
7. **斩杀加成看船体分量**。判据是 Dh ≥ 目标当前船体 Vtgt，不是总伤（§3.2；PDF 原文写作 D2，此处按附录 C 的 sret 说明取 Dh，**待核**，见 §8 V2）。
8. **`use_ship_main_target = no` 的武器完全自选目标**。阶段一只决定"主目标是谁"，管不到它（§4.2）。想统一全舰队集火，必须让武器写 `yes` 并保证主目标在射程与射界内。
9. **`CanDoDamage` 看的是面板 DPD**，是设计界面显示的数字，不是真实伤害（§2.5、§3.2）。改武器伤害但没改设计面板 DPD，降权不会跟着变。
10. **随机扰动幅度极大**。κr = 3.0 意味着最后一项乘数 ∈ [1,4)，且**只作用于舰船主目标**（§2.6）。调试索敌行为时先压这一项，再谈其它。

<a id="part8"></a>

## 8. 未证实项与脚本侧取证

### 8.1 本文继承的未证实项

| # | 未证实项 | 来源 | 本仓库可做的验证 |
|---|---|---|---|
| V1 | `target_weights` 合法键集合 | 设计文档 §10 | ✅ **已在 vanilla 范围内证实**：18 个键全部是 ship_size id（§3.3）。仍缺的是"引擎对未知键的行为" |
| V2 | 斩杀判据取 `Dh`（船体分量）还是 PDF §2.3 公式里的 `D2` | PDF 内部不一致 | 需 dump：比对 `ComputePotentialTargetScore` 内读 sret `+0x08` 还是 `+0x10` |
| V3 | `target_focus` 枚举（single/spread）到引擎 targetFocus 0/1 的映射 | PDF §4 只说"取自 growth stage +0x128" | 需 dump 或游戏内实验（困惑状态可间接触发） |
| V4 | 全部反编译行号与结构偏移 | PDF 附录 B | 本仓库无 4.5.2 dump，**全部悬空** |
| V5 | `number_of_targets_to_remember` 记忆数组的更新时机（开火时推入还是选中时推入） | PDF 未展开 | 需 dump |

### 8.2 脚本侧可继续取证的原版路径（本文已核，均只读）

| 主题 | 原版路径 |
|---|---|
| 19 项 defines | `common/defines/00_defines.txt`（行号见 §5.1） |
| 武器组件字段语义注释 | `common/component_templates/000_documentation.txt`（:81 target_weights、:182 use_ship_main_target、:184 target_focus） |
| `target_weights` 原版用例 | `00_weapons_extra_large.txt:55`、`00_biogenesis_weapons.txt:4780/4855/4930`、`00_weapons_archaeotechnology.txt:692/788/875`、`00_biogenesis_crisis_components.txt:81`、`00_weapons_critters_cutholoids.txt:126/177/225` |
| `ship_target_weight_mult` | `component_templates/00_dsc_auras.txt:23`、`ship_sizes/29_nomads_dlc_ships.txt:14`、`static_modifiers/25_…_nomads.txt:139`、`static_modifiers/23_…_biogenesis.txt:832/838/844` |
| 尺寸倍率 σ | `common/scripted_variables/03_scripted_variables_ships.txt`（`@corvette_size_multiplier` …） |
| 走位（影响 d） | `common/ship_sizes/*.txt` 的 `default_behavior`、`common/ship_behaviors/*.txt` |

### 8.3 规则层缺口（与姊妹设计文档 §8 对应）

1. **19 项 define 只有裸 `float`**，无 `###` 公式文档（defines.cwt:3754-3836）。
2. **`target_weights` 键未类型化**（:566-569 的 `scalar = float`），与 `targetable_ship_sizes`（:629-632 的 `<ship_size>`）不对称——**键集合虽已证实，类型建模仍缺**。
3. **无范围诊断**：`accuracy` / `tracking` 引擎要求 0..1（有报错文案佐证），规则层无校验。
4. **`target_focus` 映射未证实**，枚举与引擎值之间无文档。

<a id="appendix-a"></a>

## 附录 A：符号表

| 符号 | 含义 | 来源 |
|---|---|---|
| F | 定点单位 = 100000（脚本 1.0） | PDF §0 |
| ⌊x⌋ | C 风格定点整数除法（向零截断） | PDF §0 |
| σ / σ′ | 候选尺寸倍率 `size_multiplier` / `min(σ, σmax)` | ship_sizes |
| σatt | 攻击方尺寸 | 攻击方 |
| σclass | 舰船类型枚举（10 = 恒星基地/巨构） | — |
| atrk / τ | 攻击方追踪字段 / 归一化追踪 = atrk·κtrk | 攻击方 |
| ε / Δ | 候选闪避（0..1，上限 0.9）/ ε − τ | 候选 |
| d / D | 候选距离 / 距离因子 max(1−d·κd, dmin) | 战斗状态 |
| wmult / ŵtgt | `ship_target_weight_mult` 修正值 / 预置权重 = wmult + (1+ρ) | modifier + 开战随机 |
| ρ | 开战随机量 ∈ [0,1)，整场不变，战后复位 | `OnCombatStarted` |
| r | 每轮扰动随机量 ∈ [0,1) | `GetFixedPointForMacro` |
| h / θh | 目标血量百分比 / 残血阈值 0.5 | — |
| ΣD / Ds / Da / Dh | 三层期望伤害和 / 护盾·装甲·船体分量 | `CalcDamage`（见 16 号） |
| p | 命中率 = clamp(accw − clamp(εtgt − τw, 0,1), 0,1) | `CalcChanceToHit` |
| accw / τw | 武器模板命中率 / 追踪率字段 | 武器模板 |
| mh / ms / ma | `hull_damage` / `shield_damage` / `armor_damage` 倍率 | 武器模板 |
| Vtgt | 目标当前船体（斩杀判据） | 目标 |
| wk | `target_weights` 表命中项（**加法**） | 武器模板 |
| Mcur / Mrec | 当前目标 1.1 / 近期目标 0.3 | defines |
| fp | 节流周期，10 或 50（targetFocus = 1 时为 50） | — |
| targetFocus | 目标焦点，取自 growth stage +0x128，IsConfused 时为 1 | — |
| κ 系列 / dmin / θh / σmax / σavoidmin / Tavoid | 见 §5.1 全表 | defines |

<a id="appendix-b"></a>

## 附录 B：证据索引

**转写来源（本文的公式与行号出处，未经本仓库独立核验）**

- `docs/stellaris-targeting-weight-4.5.2.md`（本文的直接上游：机制解读 + 差距分析 + 功能路线图）
- 《群星索敌权重计算公式_4.5.2.pdf》文本提取件（古明地瓜/KKoishi_，地砖 & 清流蛋糕 rt 验证）：§0 约定、§1 Stage 1、§2 Stage 2、§3 调用端、§4 最终计算、§5 归一化形式、§6 defines、§7 算例、附 A 关键函数地址、附 B 常量行号、附 C `CalcDamage`

**脚本层（本文独立核验，2026-10-13）**

- `D:\Steam\steamapps\common\Stellaris\common\defines\00_defines.txt`（19 项 defines）
- `D:\Steam\steamapps\common\Stellaris\common\component_templates\000_documentation.txt`（:81 / :182 / :184）
- `D:\Steam\steamapps\common\Stellaris\common\component_templates\00_weapons_extra_large.txt`（:15 / :55-61 / :63-69）
- `D:\Steam\steamapps\common\Stellaris\common\scripted_variables/03_scripted_variables_ships.txt`（:59 / :74 / :126 / :143）
- `D:\Steam\steamapps\common\Stellaris\common\ship_sizes\00_ship_sizes.txt`（:120 / :207 / :233）
- `D:\Steam\steamapps\common\Stellaris\common\static_modifiers\23_static_modifiers_biogenesis.txt`（:832/838/844）、`25_static_modifiers_nomads.txt`（:139）
- `D:\Steam\steamapps\common\Stellaris\common\component_templates\00_dsc_auras.txt`（:23）、`common\ship_sizes\29_nomads_dlc_ships.txt`（:14）

**规则层（本仓库，已实读核对行号）**

- `submodules/cwtools-stellaris-config/config/common/defines.cwt`（:3643 / :3645 NShip；:3754-3836 NCombat 块，19 项定位见 §5.1）
- `submodules/cwtools-stellaris-config/config/common/components_consolidated.cwt`（:118 / :394 / :560 / :566-569 / :586-608 / :624 / :629-632）
- `submodules/cwtools-stellaris-config/config/common/ship_sizes.cwt`（:85）
- `submodules/cwtools-stellaris-config/config/logs/modifiers.log`（:119）

**系列内**

- [16_combat_damage_resolution.md](16_combat_damage_resolution.md)：§3–§5（三层分摊）、§15（武器字段 ↔ 偏移对照，一手核验）
- [04_fleet_pathfinding_ai.md](04_fleet_pathfinding_ai.md)：索敌节流一行提及（4.5 dump 行号），已指向本文
- [README.md](README.md)：系列文件目录
