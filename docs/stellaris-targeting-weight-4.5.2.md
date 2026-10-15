# Stellaris 4.5.2 舰船索敌权重机制解读与功能路线图

**整理日期**：2026-10-13 · **状态**：设计文档（机制解读 + 差距分析 + 功能路线图，未实施）

**一手来源**：[《群星索敌权重计算公式 4.5.2》](群星索敌权重计算公式_4.5.2.pdf)（古明地瓜/KKoishi_ 反编译分析整理，地砖 & 清流蛋糕 rt 辅助数据验证）。该文基于 Stellaris 4.5.2（Cygnus，二进制 hash `32709cf254181b032b1b309a6ea09776`）的反编译产物 `stellaris_4.5.2_source.cpp`，文中行号与结构偏移均以该版本为准。

**姊妹篇**：[16_combat_damage_resolution.md](better_stellaris/16_combat_damage_resolution.md)（伤害结算，同一 dump 来源，其 §15 有武器字段 ↔ 结构偏移对照表）；索敌节流在 [04_fleet_pathfinding_ai.md](better_stellaris/04_fleet_pathfinding_ai.md) 只有一行提及——本文档补齐这一不对称。

> **阅读约定**：引擎内部使用定点数，`F = 100000`（即脚本中的 1.0），除法为 C 风格向零截断。本文公式一律给出**归一化形式**（把定点除法当作实数除法），便于分析；需要定点精度的场合会单独注明。"修正后的量"指经 modifier 系统计算后的值。

---

## 1. 机制总览

索敌是**两阶段、argmax（取最大值而非加权抽签）、带错峰节流**的过程：

```
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

**一句话**：Stage 1 回答"这个目标好不好打、值不值得打"；Stage 2 回答"这门武器打它能造成多少有效伤害"；两者相乘后取最大。**如果武器模板写了 `use_ship_main_target = yes`，武器直接沿用舰船主目标**（需在射程与射界内），Stage 2 不生效；`ENERGY_LANCE`（泰坦光矛）写的恰恰是 `no`，所以它完全按武器层分数自选目标。

**节流**：舰船已有有效主目标时，只在 `(TotalTicks + shipID) mod fp == 0` 的 tick 重算权重（`fp = 50` 当 targetFocus=1，否则 10）；**没有有效主目标时才立刻重算**。索敌权重不是每 tick 重算的。

---

## 2. Stage 1：舰船层权重 W(ship)

对应 `CShipTargeting::ComputePotentialTargetScore`。前置条件：候选与自己同星系、可被攻击、不在跳跃/隐身位掩码中，否则直接无效。乘法链各项（归一化形式，vanilla define 值见 §5 表）：

### 2.1 尺寸项（基准项，单调递减）
```
σ′ = min(σ, σmax)          σ = 候选船 size_multiplier，σmax = 10
Ŵ1 = 1 / (1 + σ′·κsize)     κsize = 0.03
```
目标越大权重越低：护卫舰（σ=5）得 0.870，泰坦级（σ≥10 封顶）得 0.769。**注意是赋值不是累乘**，值域 (0, 1]。

### 2.2 追踪–闪避项（含整目标否决）
```
τ = atrk·κtrk   （攻击方追踪 × 2.0）
ε = 候选闪避（0..1，受 SHIP_MAX_EVASION = 0.9 上限约束）
Δ = ε − τ
```
- **否决条件（整目标剔除）**：`Δ > 0 ∧ σatt ≥ 8（σavoidmin）∧ Δ ≥ 0.7（Tavoid）∧ 目标舰队中存在至少一艘"可命中"（εq − τ < Tavoid）的船` → **直接返回 0**。即：大船对高闪避小船"懒得追"，只要对方舰队里有打得中的目标就把这艘踢出候选。
- 未被否决且 Δ > 0：`Ŵ2 = Ŵ1 / (1 + Δ·κev)`，κev = 2.0；Δ ≤ 0 时 Ŵ2 = Ŵ1（追踪盖过闪避则无惩罚）。

### 2.3 距离项
```
Ŵ3 = Ŵ2 × max(1 − d·κd, dmin)     κd = 0.002，dmin = 0.10
```
d 为候选距离（引擎单位）。线性衰减，d ≥ 450 时触下限 0.10。

### 2.4 目标预置权重 wtgt（modder 的主要抓手）
```
Ŵ4 = Ŵ3 × ŵtgt
ŵtgt = ship_target_weight_mult 修正值 + (1 + ρ)，ρ ∈ [0, 1)
```
- `ship_target_weight_mult` 是**船级 modifier**（ModifierType 0x6e），来源包括 ship_sizes 定义与光环类组件（原版例子：`00_dsc_auras.txt` 的 0.50、`29_nomads_dlc_ships.txt` 的 −0.5）。
- **ρ 是开战瞬间每艘船各掷一次的随机量**（`CShip::OnCombatStarted` 写入，整场战斗不变，战后复位）。所以两条设计完全相同的船，每场战斗也会被赋予不同的"被偏爱度"（实测 1.326/1.486 vs 1.561/1.379）。

### 2.5 残血 / 无武装 / 星基
```
h < θh (0.5)            → ×κh  (1.5)     残血目标更优先（收人头）
目标无伤害能力          → ×κun (0.005)   几乎不再打（按面板 DPD 判定，非真实伤害）
恒星基地/巨构(类型枚举10)
且非当前主目标          → ×κsb (0.75)
```

### 2.6 随机扰动
```
Ŵ(ship) = Ŵ6 × (1 + r·κr)     r ∈ [0, 1)，κr = 3.0  →  乘数 ∈ [1, 4)
```
默认开启（`CalcBestTarget` 传 `useRandom = true`）。**这一项幅度极大**（最高 4 倍），是"为什么索敌看起来不稳定"的主因之一。

---

## 3. Stage 2：武器层分数 S(weapon)

对应 `CWeaponComponentTargeting::ComputePotentialTargetScore`。

### 3.1 期望伤害 ΣD 与命中率 p
- 伤害取**已套修正的**武器模板值（攻击方 + 控制方 + 目标三方 modifier 就地改写 `SAttackInfo`），基础伤害取区间中点（索敌路径 `useRandom = false`）。
- `NCombatRules::CalcDamage` 按护盾/装甲/船体三层分摊，各层乘武器模板的 `shield_damage`(ms) / `armor_damage`(ma) / `hull_damage`(mh) 倍率；穿透减去目标硬化后夹 [0,1]。**ΣD = Ds + Da + Dh**。细节与字段偏移对照见 [16_combat_damage_resolution.md](better_stellaris/16_combat_damage_resolution.md) §3–§5、§15。
- **关键反直觉点**：层分量不被该层存量夹住（只有从剩余伤害里扣减的量才被 min 夹住），所以**带盾/带甲的目标算出来的 ΣD 反而更大**——实测同一门武器对"225 盾+225 甲+240 船体"目标的 ΣD 是对"720 船体 0 盾 0 甲"目标的 1.58×~2.65×。这就是"盾甲吸引仇恨"传言的根因；**唯一有效反制是高闪避**（压低 p）。
- 命中率：`p = clamp(accw − clamp(evasion − τw, 0, 1), 0, 1)`（accw/τw 为武器模板命中率/追踪率字段；引擎对这两个字段有 "should be between 0.0 and 1.0" 的报错文案）。
- `size_damage_factor`：仅当 > 0 时按目标尺寸放大伤害（clamp(σ, 1, 100)，上限 MAX_DAMAGE_SCALING = 100）。

### 3.2 基础分数与修正
```
S0 = ΣD × p × ŵtgt              （ŵtgt 即 Stage 1 的预置权重，含开战随机 ρ）
Vtgt ≤ Dh（船体分量可单发斩杀） → S1 = 1.5 × S0
目标无还手能力（面板 DPD ≤ 0）  → S2 = κun (0.005) × S1
S(weapon) = S2 + wk              wk = target_weights 表中该目标船尺寸名对应的值
```
> 注：斩杀判据在 PDF 内部存在记法矛盾——§2.3 公式写作 `Vtgt ≤ D2`，但其附录 C 的返回值表写明船体分量 Dh（sret +0x08）才是判据。本文采 Dh 读法；该点留作 dump 核验项（17 号文 §8 V2）。

**`target_weights` 是加法项而非乘法项**——写在武器模板里的"优先打某类目标"可以盖过整条乘法链（例：给 `target_weights = { <某小船> = 一个很大的数 }` 即可强制优先）。

---

## 4. 调用端与节流细节

**舰船主目标** `CShipTargeting::CalcBestTarget`：枚举敌方候选 → 逐个算 W(ship) → **argmax**（不是加权抽签）。节流见 §1。`Mcur`（当前目标 ×1.1）只在 targetFocus = 0 时施加（舰船层与武器层一致）。

**武器选目标** `CWeaponComponentTargeting::CalcBestTarget` 按序分派：
1. 组件模板标记为舰载机/打击机（模板 +0x12e0 == 2）→ `CStrikeCraftTargeting::CalcBestTarget`；
2. `use_ship_main_target` 置位 → 沿用舰船主目标（前提：在射程与射界内）；
3. 否则 → 每门武器自己按 S(weapon) argmax。

**最终比较**（`CalcBestWeaponComponentTarget`）：
```
候选 == 当前主目标（且 targetFocus = 0）→ ×Mcur (1.1)
候选在"最近目标记忆"（10 个）中且非最新一项 → ×Mrec (0.3)
```
targetFocus 取自设计 growth stage +0x128，IsConfused 时为 1（此时节流周期拉长到 50 tick 且失去当前目标粘性）。规则层对应字段为武器组件的 `target_focus = enum[component_target_focus] { single, spread }`——**枚举值到引擎 0/1 的映射未证实**。

---

## 5. 脚本可调点全景（modder 视角）

### 5.1 defines（`common/defines/00_defines.txt`，NCombat / NShip）
| 符号 | define | vanilla | 环节 | 规则覆盖 |
|---|---|---|---|---|
| κsize | `COMBAT_SHIP_TARGETING_SIZE_MULT` | 0.03 | 尺寸项斜率 | float，无文档（defines.cwt:3780） |
| σmax | `COMBAT_SHIP_TARGETING_SIZE_MAX` | 10 | 尺寸封顶 | 同上 :3782 |
| κtrk | `COMBAT_SHIP_TARGETING_TRACKING_MULT` | 2.0 | 追踪放大 | 同上 :3784 |
| κev | `COMBAT_SHIP_EVASION_TARGETING_WEIGHT` | 2.0 | 闪避惩罚斜率 | 同上 :3786 |
| θh | `COMBAT_SHIP_LOW_HEALTH_THRESHOLD` | 0.5 | 残血阈值 | 同上 :3788 |
| κh | `COMBAT_SHIP_LOW_HEALTH_TARGETING_WEIGHT` | 1.5 | 残血倍率 | 同上 :3790 |
| κd | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT` | 0.002 | 距离衰减 | 同上 :3792 |
| dmin | `COMBAT_SHIP_DISTANCE_TARGETING_WEIGHT_MIN` | 0.10 | 距离下限 | 同上 :3794 |
| κun | `COMBAT_SHIP_UNARMED_TARGETING_WEIGHT` | 0.005 | 无武装降权 | 同上 :3796 |
| κsb | `COMBAT_SHIP_STARBASE_TARGETING_WEIGHT` | 0.75 | 星基降权 | 同上 :3798 |
| σavoidmin | `COMBAT_SHIP_EVASION_AVOID_MIN_SHIP_SIZE` | 8 | 否决的攻击方尺寸门槛 | 同上 :3800 |
| Tavoid | `COMBAT_SHIP_EVASION_AVOID_THRESHOLD` | 0.7 | 否决的 Δ 门槛 | 同上 :3802 |
| κr | `RANDOM_TARGETING_WEIGHT` | 3.0 | 随机扰动幅度 [1, 1+κr) | 同上 :3776 |
| Mcur | `SHIP_CURRENT_TARGET_MULTIPLIER` | 1.1 | 当前目标粘性 | 同上 :3770 |
| Mrec | `SHIP_RECENT_TARGET_PENALIZER` | 0.3 | 近期目标惩罚 | 同上 :3772 |
| — | `NUMBER_OF_TARGETS_TO_REMEMBER` | 10 | 近期记忆长度 | 同上 :3774 |
| — | `SHIP_MAX_EVASION`（NShip） | 0.9 | 闪避上限 | NShip 块 |
| — | `MAX_DAMAGE_SCALING`（NShip） | 100 | size_damage_factor 放大上限 | NShip 块 |
| — | `MISSILE_RETARGET_CHANCE_START/_REDUCTION` | — | 导弹重索敌（本文未展开） | defines.cwt:3825/3827 |

### 5.2 武器组件模板（`common/component_templates/`，规则 subtype `weapon_component_template`）
| 字段 | 进入公式的位置 | 规则现状 |
|---|---|---|
| `min_damage` / `max_damage` | ΣD 基础（区间中点） | float（CSV 反填批，components_consolidated.cwt:586 注释） |
| `hull_damage` / `shield_damage` / `armor_damage` | mh/ms/ma 三层倍率 | float（:590-598 等），无公式文档 |
| `shield_penetration` / `armor_penetration` | 穿透（减硬化后夹 [0,1]） | float，无文档 |
| `accuracy` / `tracking` | p 与 τw；引擎要求 0..1 | float（:604-608），无范围诊断 |
| `size_damage_factor` | 按目标尺寸放大（上限 100） | float（:624） |
| `use_ship_main_target` | 选目标分派（§4 第 2 支） | bool（:118），无文档 |
| `target_weights = { … }` | S 的加法项 wk（§3.2） | **键为 `scalar = float`，无类型无文档**（:566-569） |
| `targetable_ship_sizes = { … }` | 候选过滤（前置） | **`<ship_size>` 强类型**（:629-632）——与上行不对称 |
| `target_focus` | 节流周期 / Mcur 生效（映射未证实） | enum[component_target_focus]（:394, :778-781） |
| `firing_arc` / `min_range` / `range` | 沿用主目标时的射程/射界约束 | float（firing_arc :558、min_range :560、range :604） |

### 5.3 船级与修饰符
- `ship_target_weight_mult`（modifier，类别含 Military Ships 等，modifiers.log:119）；按船级的别名 `shipsize_$_target_weight_mult`（ship_sizes.cwt:85）。→ 直接进入 ŵtgt（§2.4）。vanilla 共 6 处取值样本（含 PDF 未列的 nomads、biogenesis 4 处，见 [17 号文](better_stellaris/17_ship_targeting_weights.md) §5.3）。
- `ship_sizes` 的 `combat_size_multiplier`、`default_behavior = <ship_behavior>`；`ship_behaviors` 的 `preferred_attack_range` / `attack_move_pattern` 等控制走位（影响距离项 d 的分布，间接影响索敌）。

### 5.4 规则层其它相关开关
`game_rules.cwt` 的 `calc_planet_specific_war_attack_priority` 等（战争层面优先级，与本公式不同层）；effects 的 `set_ai_*_weapon_preference` 系列（AI 配船偏好，**不是战斗索敌**）。

---

## 6. 数值算例复核（对 PDF §7 的独立复算）

场景：两条船 + 一门 `ENERGY_LANCE`（acc 0.85、trk 0；mh 1.5 / ms 0.5 / ma 2.0）。

| 量 | 护卫舰 | 雷击舰 | 复算 |
|---|---|---|---|
| W1 尺寸 | 0.8696 | 0.8065 | 1/(1+5×0.03) ✓；1/(1+8×0.03) ✓ |
| 闪避因子 | 0.4545 | 0.5411 | 1/(1+0.6×2) ✓；1/(1+0.424×2) ✓（PDF 表该行是**单因子**，非累计） |
| W3 距离因子 | 0.856 | 0.871 | 1−72×0.002 ✓；1−64.5×0.002 ✓ |
| W(ship) | 0.528 | 0.524 | 0.8696×0.4545×0.856×1.561 ✓；0.8065×0.5411×0.871×1.379 ✓ |
| p 命中率 | 0.250 | 0.426 | 0.85−0.6 ✓；0.85−0.424 ✓ |

结论复核成立：舰船层两条船基本持平（0.99），武器层护卫舰高 1.76×（ΣD 被盾甲顶高 2.65×，盖过闪避带来的 p 劣势）。因 `ENERGY_LANCE` 的 `use_ship_main_target = no`，实际按武器层走 → 优先打带盾甲的护卫舰。

---

## 7. 常见误区（写给 modder，也写给未来的实现者）

1. **"盾甲吸引仇恨"是结果不是机制**：根因是 ΣD 的三层分摊不夹各层存量（§3.1），不是引擎写了"优先打盾甲船"。
2. **`ai_weight` ≠ 索敌权重**：`ai_weight` 是 AI 建造/决策权重（出现在 traits/zones/starbases 等规则里）；战斗索敌的脚本抓手是 `ship_target_weight_mult`、`target_weights` 和 §5 的 defines。
3. **索敌不是每 tick 重算**：10/50 tick 错峰 + 无有效主目标才立即重算（§1）。改 define 不会"立即生效于每一帧"。
4. **`target_weights` 是加法项**：可以碾压乘法链（§3.2），用法与直觉的"倍率"相反。
5. **同设计不同命运**：开战随机量 ρ ∈ [0,1) 让同设计舰船每场战斗的 wtgt 都不同（§2.4）。
6. **打不中的小船会被大船整体无视**：满足否决条件即 return 0（§2.2），不是低权重是**剔除**。
7. **斩杀加成看船体分量**：判据是 Dh ≥ 当前船体 Vtgt，不是总伤（§3.2）。
8. **`use_ship_main_target = no` 的武器完全自选目标**：舰船层只决定"主目标是谁"，管不到它（§4）。
9. **CanDoDamage 看面板 DPD**：是设计界面显示的数字，不是真实伤害（§3.2）。
10. **随机扰动幅度极大**：κr = 3.0 意味着最后一项乘数 ∈ [1,4)（§2.6），调试索敌行为时先把它关掉再谈。

---

## 8. 本项目现状差距分析（调研证据）

> 调研方法：两个只读子代理分别普查插件侧（规则/LSP/扩展/webview/MCP）与 agent 侧（skills/工具/数据面/编排），关键结论由协调者独立抽查复核（字段行号均亲自核对过）。

### 8.1 已就位（可直接借力）
- **规则数据**：索敌三件套 `target_focus` / `target_weights` / `targetable_ship_sizes` 已有声明；19 个相关 define 全部有 `float` 声明；伤害字段全部覆盖。
- **hover 事实管道**：`## cost` / `## engine` / `## engine_evidence` 注释机制全链路可用（RulesParser.fs:483-530 → HoverPerformance.fs → LanguageServerFeatures.fs:329-344），**但目前 1248 条标注 100% 在 triggers/effects alias 上，common/*.cwt 字段级从未验证过**。
- **webview 面板模板**：techTreePanel（Host 解析 → postMessage → 渲染 → 回跳源文件）与 eventChainPanel（链路图）可直接复制；canvas 图表基础设施见 curveEditor.ts（需剥离编辑语义）；chat webview 已有 KaTeX/mermaid。
- **MCP 基座**：36 个全只读工具 + 契约测试 + 生成式 schema 流程。
- **Agent 基座**：skills 扫描根（项目级 `.agents/skills` 即可挂载）、工具注册链路清晰、黑板/多代理可承载批量分析；`interfaceKnowledge.ts` 是"策展知识包"的现成模板。

### 8.2 真正缺的（按不对称程度排序）
1. **索敌公式零文档**：伤害侧有 1047 行源码级文档（16 号），索敌侧此前只有 1 行（04 号 :97）。defines/武器字段/修饰符全部裸 `float` 无 `###` 注释。
2. **`target_weights` 键无类型建模**：`scalar = float` 意味着错键不报错、无补全，与相邻 `targetable_ship_sizes` 的 `<ship_size>` 强类型不对称。键集合需原版反查（未证实）。
3. **无范围诊断**：`accuracy` / `tracking` 引擎要求 0..1（有报错文案佐证），规则层无对应校验。
4. **无任何索敌/战斗专用分析能力**：webview 无图表面板；MCP 36 个工具无战斗类；agent 无机制技能。

---

## 9. 功能路线图（按优先级，影响/成本排序）

> 成本刻度：S ≈ 半天内（纯规则/文档）；M ≈ 1–3 天（TS 单点）；L ≈ 3 天以上（跨层/跨仓库）。所有项均遵循 AGENTS.md 约束（中英双语、MCP 只读、webview 无 Node API、子模块独立提交）。

### P0 — 规则数据层（S，全员立即受益）
| # | 内容 | 挂载点 | 验收思路 |
|---|---|---|---|
| P0-1 | **`target_weights` 键强类型化**：原版反查键集合（预期是 `<ship_size>`）后改规则，消除与 `targetable_ship_sizes` 的不对称 | components_consolidated.cwt:566-569 | 原版 `component_templates/*.txt` 全样本回归；错键出诊断；补全列出合法键 |
| P0-2 | **19 个 define 补 `###` 公式文档**：公式角色、vanilla 值、方向性、定点约定（本文 §5.1 可直接转写） | defines.cwt:3754-3836 | hover 显示公式说明；`npm run test:shader-lsp` 无关、跑规则加载测试 |
| P0-3 | **武器字段补 `###`**：accuracy/tracking（0..1 约束）、伤害/穿透字段（进入 ΣD 的位置）、`use_ship_main_target`、`target_focus`、`target_weights` | components_consolidated.cwt:370-634 | hover 文档可见；键入补全带描述 |
| P0-4 | **修饰符文档**：`ship_target_weight_mult` / `shipsize_$_target_weight_mult` 注明进入 ŵtgt 与 ρ 叠加方式 | modifiers.log:119、ship_sizes.cwt:85 | 补全/悬停可见 |

> P0 全部走 [stellaris-rules-sync](.agents/skills/stellaris-rules-sync/SKILL.md) SOP（原版反查→强类型→验证门禁）；严禁滥用 `scalar`。

### P1 — 校验与证据管道（M）
| # | 内容 | 挂载点 | 验收思路 |
|---|---|---|---|
| P1-1 | **字段级 `## engine` / `## engine_evidence` 管道实测**：先在 common/*.cwt 单字段试点（验证 InfoAtPos 对非 alias 规则的解析），通过后把本文档的反编译证据（函数名/行为，不手钉行号）挂上 hover | RulesParser.fs:483-530、HoverPerformance.fs、LanguageServerFeatures.fs:329-344 | 仿 EngineCostRuleParsing.Tests.fsx 写"解析真实规则文件"的回归；hover 实测截图 |
| P1-2 | **新诊断**：accuracy/tracking 超出 [0,1] 告警；`target_weights` 未知键报错（随 P0-1 落地）；`use_ship_main_target` 与舰载机类型的一致性提示 | OverlayValidation.fs / PureDecisions.fs | 单测覆盖正/反例；与 vanilla 全文回归无误报 |
| P1-3 | **机制文档入系列**：把索敌机制整理为 `docs/better_stellaris/17_ship_targeting_weights.md`（源码锚点体例，对齐 16 号），04 号 :97 的那一行改为链接 | docs/better_stellaris/ | 系列 README 目录更新；与 PDF 逐节核对 |

### P2 — Agent 层（S–M）
| # | 内容 | 挂载点 | 验收思路 |
|---|---|---|---|
| P2-1 | **新技能 `stellaris-targeting-weights`**（零代码）：内置本公式知识、取证路径（哪个 CWT 实体/哪个 vanilla 路径）、§7 误区清单；frontmatter `allowed-tools` 必须命中 registry；注意 `capability-domain` 与打包位置（built-in `resources/skills` 目录当前不存在，VSIX 是否打包未证实——先放项目级 `.agents/skills/`） | .agents/skills/stellaris-targeting-weights/SKILL.md | `run_skill` / `/skill:stellaris-targeting-weights` 可加载；正文 ≤ 30000 字符 |
| P2-2 | **只读工具 `query_targeting_weight`**（方案 A，纯 TS）：输入武器模板 + 目标参数 → 输出乘法链分解（W1..W6、ΣD、p、S、wk），按本文 §2/§3 公式实现；数据经 workspaceSandbox 读工作区/vanilla | 新建 client/extension/ai/targetingWeights.ts + definitions/registry/agentTools/toolPhrases/test 五处 | 单测复算本文 §6 算例（0.528/0.524/1.76×）；注意 toolDefinitions.test.ts 的 96 工具/32000 token 预算 |
| P2-3 | （可选）提示词引导：PARADOX_KNOWLEDGE / modePrompts 加一句索敌知识入口，bump PROMPT_TEMPLATE_VERSION | gameKnowledge.ts:13-40、promptBuilder.ts:83 | 缓存失效路径正确（skills_changed） |

### P3 — 视图与外部接口（L，彼此解耦可并行）
| # | 内容 | 挂载点 | 验收思路 |
|---|---|---|---|
| P3-1 | **"索敌权重分析"面板**：照 techTreePanel 复制 Host→postMessage→webview 闭环；Host 侧解析 mod 武器/船体/defines，webview 画乘法链瀑布/对比条形图（curveEditor.ts 的 canvas 生命周期样板），点击条目回跳源文件行；中英双语 panelText；遵守 webview 全部硬约束 | 新 client/extension/targetWeightPanel.ts + client/webview/targetWeightPreview.ts；命令 `cwtools.targetWeights.*` | 样例 mod 渲染正确； dispose 无泄漏；`npm run compile` + typecheck |
| P3-2 | **LSP 只读命令 + MCP 暴露**：`cwtools.ai.analyzeTargetWeights`（需要引擎级取数时，如批量扫描全 mod 武器）→ definitions/registry → `npm run generate-mcp-schema` → 同步 generate-mcp-schema.cjs:8-45 与 names.ts → cwtools-mcp 子模块提交发版 → bump 根指针 | Program.fs + Commands.fs readCmd + ai/tools/* | 子模块内 `npm run build && npm run test:contracts`；只读契约测试通过 |

### 明确不做（本期）
- ❌ TS 侧解析 `stl.cwb`（二进制反序列化只在 F# 侧，要读走 LSP 命令）；
- ❌ 手改 `generated/mcpTools.ts`；
- ❌ webview 内做文件 I/O（取数一律留 Extension Host）；
- ❌ hook 游戏进程实时取数（PDF 附录 A 的符号表是给外部二进制工具的，与本项目无关）；
- ❌ 把 `ai_weight` 类 AI 决策权重混入索敌功能语义。

---

## 10. 未证实项与验证清单（实施前必须落地）

| # | 未证实项 | 验证方式 |
|---|---|---|
| V1 | `target_weights` 合法键集合 | ✅ 已解决（2026-10-13，SA+SC 双重证实）：原版 25 处用法去重 18 键全部是 ship_size id，`000_documentation.txt:81` 注释证实「键为舰船尺寸名」 |
| V2 | `target_focus` 枚举（single/spread）到引擎 targetFocus 0/1 的映射 | 原版样本 + dump 反查 |
| V3 | 字段级（非 alias）CWT 规则能否携带 `## engine` 并在 hover 渲染 | 单字段试点 + InfoService.fs:630 路径确认 |
| V4 | LSP hover 的 Markdown 是否渲染 LaTeX（chat webview 有 KaTeX，hover 路径未证实） | 实测；不支持则公式用代码块 |
| V5 | `client/extension/resources/skills` 打包是否进 VSIX | 读 release/.vscodeignore 与 package.ps1 |
| V6 | `fire_rate` / `burst_*` / `damage_degrade_per_tier` 等字段是否缺失 | 原版反查（与索敌公式无关但属同字段簇） |

---

## 附录 A：符号表

| 符号 | 含义 | 来源 |
|---|---|---|
| F | 定点单位 = 100000（脚本 1.0） | PDF §0 |
| σ / σ′ | 候选尺寸倍率 size_multiplier / min(σ, σmax) | ship_sizes |
| atrk / τ | 攻击方追踪字段 / 归一化追踪 | 攻击方 |
| ε | 候选闪避（0..1，上限 0.9） | 候选 |
| d | 候选距离 | 战斗状态 |
| ŵtgt | 预置权重 = ship_target_weight_mult + (1+ρ) | modifier + 开战随机 |
| ρ | 开战随机量 ∈ [0,1)，全场不变 | OnCombatStarted |
| h / θh | 目标血量百分比 / 残血阈值 0.5 | — |
| ΣD / p | 三层期望伤害和 / 命中率 | CalcDamage / CalcChanceToHit |
| wk | target_weights 表命中项（加法） | 武器模板 |
| Mcur / Mrec | 当前目标 1.1 / 近期目标 0.3 | defines |
| κ 系列 | 各 define 系数，见 §5.1 | defines |

## 附录 B：证据索引（本仓库内）

- 规则：`submodules/cwtools-stellaris-config/config/common/components_consolidated.cwt`（:118 :394 :566 :586 :604-608 :624 :629）、`defines.cwt`（:3754-3836）、`ship_sizes.cwt`（:85）、`ship_behaviors.cwt`、`logs/modifiers.log`（:119）
- 扩展/LSP：`src/Main/LanguageServerFeatures.fs`（hover 组装 :364-374）、`src/Main/HoverPerformance.fs`、`src/Main/Program.fs`（:7795-7818 能力注册、:2607-2732 codeLens）、`client/extension/techTreePanel.ts`、`client/webview/curveEditor.ts`
- Agent：`client/extension/ai/skills.ts`（:246-265 扫描根）、`client/extension/ai/tools/{definitions,registry}.ts`、`agentTools.ts`、`interfaceKnowledge.ts`、`client/webview/chat/toolPhrases.ts`
- MCP：`submodules/cwtools-mcp/packages/cwtools-shared/src/tools/names.ts`（:1-38）、`tools/generate-mcp-schema.cjs`（:8-45）
- 机制文档：`docs/better_stellaris/16_combat_damage_resolution.md`、`04_fleet_pathfinding_ai.md`（:97）
