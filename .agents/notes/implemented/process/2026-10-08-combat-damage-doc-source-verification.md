# Agent Note: 伤害结算文档的逐条源码核验与归档

Status: implemented

## Problem

`docs/群星伤害结算逻辑_4.5.2.md` 是一份未经核验的反编译分析文档（未跟踪文件），声称覆盖 Stellaris 4.5.2 的伤害结算与武器计算过程。它位于 `docs/` 下，但存在四个未被察觉的问题：

1. **无任何验证**。全部行号锚定在一份外部 dump（`anti_stellaris/stellaris_4.5.2_source.cpp`，355MB / 9,364,545 行）上，仓库内没有任何机制能证明这些行号仍然有效。
2. **三条死链**。文首引用的 `00_defines.txt`、`stellaris_damage_reference.py`、`stellaris_damage_example.json` 全盘搜索均不存在；`[D01]`–`[D08]` 八条配置值因此无法核验。
3. **命名与位置不合规**。中文文件名放在 `docs/` 根目录，与 `better_stellaris/` 下 `01`～`15` 的既有命名体系脱节，也没有进索引。
4. **该文档填补的是本项目唯一的空白层**。CWT 规则只描述**合法性**（字段叫什么、什么作用域、什么类型），不描述运行时行为——`cwt-rule-config.md` 明写「CWT rules do not describe game runtime behavior directly」，而 `gameKnowledge.ts` 刻意保持 policy-only（头注释：Current-game facts intentionally do not live here）。而 mod 作者最常用的武器字段在规则里全是一行 `= float`。

## Decision

### 1. 归档为 `docs/better_stellaris/16_combat_damage_resolution.md`

并入 `better_stellaris/` 既有体系（该目录已有非性能内容先例：15 号明确标注「不是性能问题」），索引加一行。

### 2. 逐条回源码核验，约 60 项断言零反驳

核验结果：**0 反驳、0 行号错位、1 处结论被推翻**。纠正的易错点：

| 易错点 | 正确答案 |
|---|---|
| `param_12` 是穿透结构 | 是**减伤**结构（`f` 在 `+0`、`r` 在 `+0x08`）；穿透在攻击结构 `+0x28`/`+0x30` |
| `defense+0x10` 是武器 `size_damage_factor` | 是**目标尺寸**（`CShipSize+0x630`）；武器侧是攻击结构 `+0x38` |
| `SDefenseInfo` 按 8 字节索引 | 是 **4 字节索引**（3813707 护盾硬化写 `param_1+6`、3813685 甲硬化写 `param_1+8`，步长 8 字节） |

定点口径系统性偏差 5 处：源码判定的是 `raw < 1`（真实值 < 0.00001）而非 `0`，涉及尺寸门槛 `c`、层存在判定 `L`、三层归零、击毁判定 `hull`、护盾恢复条件。已在正文统一标注。

### 3. 推翻「次级目标按自己的当前防御重新结算」

这是本次唯一被推翻的结论。原文称溅射/连锁的目标会按自己的当前盾甲重跑三层公式。证据链：

1. 次级目标确为 `CShip`（2107752～2107765 从 `TPdxRef<CShip>::_pDatabase` 取出并校验世代号）；
2. 槽 `+0x68` 是 `TakeDamage`（其返回值被 2107698 `ApplyPostDamageValues` 消费，那是 `CalcDamage` 的产物）；
3. 一个虚函数只占一个槽，故 `+0x80` 不是 `TakeDamage`；且 `CShip::TakeDamage` 全 dump 零直接调用点，只能经虚表到达；
4. `CalcDamage` 全 dump 仅 4 个真实调用点，均不在 `+0x80` 路径上。

**新结论**：溅射、连锁与 `deal_damage` 脚本效果（6418428）共用槽 `+0x80` 的**脚本伤害路径**，不执行三层分配模型。由此得到三条可行动事实：三者都不触发吸血；其伤害区间来自溅射参数而非武器 `min_damage`/`max_damage`；不能用主炮公式外推。

### 4. 补两节新内容

- **§15 武器字段 ↔ 引擎偏移对照**：CWT 字段 / 模板偏移（Linux 与 Win）/ 攻击结构偏移全表。`size_damage_factor → 模板 0x1200 → 攻击 +0x38` 由引擎自身的硬编码校验串（3878215，Size Damage Factor should not be less than 0.0）坐实，不依赖推断。
- **§16 modder 语义陷阱** 10 条，含：`ship_size_damage_factor` 修饰器是**加到** `c` 上而非相乘（3814024～3814025，全 dump 唯一读取点）；`size_damage_factor` 无上界；`ship_size_multiplier` 触发器向上取整到 1.0 倍率而 tooltip 显示原值。

### 5. `[D01]`–`[D08]` 改标游戏安装目录并补 dump 读取点

配置值改为对照 `D:\Steam\steamapps\common\Stellaris\common\defines\00_defines.txt`（`v4.5.2 (9776) Cygnus`）核验，8/8 值与行号全部一致；同时补上每个 define 在 dump 中的**注册读取点与实际使用点**，使配置值本身也可复核。

## Alternatives considered

- **不核验直接归档**：否决。文档位于 `docs/` 且会被当作规格使用，未经核验的断言一旦被工具或规则引用，错误会被固化。
- **把这些语义写进 CWT 规则的 field description**：否决。两个原因——`cwt-rule-config.md` 已明确规则不描述运行时行为；且 `submodules/cwtools-stellaris-config` 是独立 submodule，需单独提交、发版并回推根仓库指针，成本远大于收益。
- **写进 `gameKnowledge.ts`**：否决。该文件刻意保持 policy-only 且跨规则版本可缓存，加入版本相关事实会破坏该决策。
- **把核验报告单独存一份文件**：否决。证据与结论同源，分开会立刻失同步；改为文档内附录 A（修订清单）与附录 B（逐项核验记录 + 已排除的候选路径）。
- **为闭合 `+0x80` 身份而下载 Linux ELF**：暂缓，理由见 Consequences。

## Consequences

- 该文档现在是**可信的伤害模型规格**，可直接作为 `calculate_combat_damage` 工具的边界：§1～§8、§10～§13 全在可信区间内，§12 的 23 组算例已手算复核自洽，可直接当黄金用例。
- §9 需读者特别注意：范围/连锁**不走**标准结算。任何基于本文做伤害平衡的工具或文档，都必须显式排除溅射、连锁与 `deal_damage`。
- **仍未闭合**：槽 `+0x80` 的具体函数身份。Linux dump 只导出函数不含 data section，Windows PE 侧未能正确定位 CShip 主虚表（候选表主虚表仅 6 槽而 Linux 侧 93 槽，且其槽 `+0x68` 指向无 `.pdata` 条目的 16 字节跳板）。定案需 Linux ELF 本体读 `.data.rel.ro`；本机无 ELF（`anti_stellaris/README.md` 已记载）。因不影响上述可用区间，未阻塞本次归档。
- 附录 B 记录了**已排除的候选路径**，供后续复核者省时——本次有两次因反编译类型噪声得出错误映射（`param_12`、`defense+0x10`），不记录会重复踩坑。

## Related

- 同目录 [2026-10-07-engine-doc-log-refresh-and-cost-reanchor.md](2026-10-07-engine-doc-log-refresh-and-cost-reanchor.md) 拥有「反编译证据必须可逐条复核、跨版本不得整体加偏移」的决策，本文继承该纪律。
- [2026-09-23-stellaris-v4.5-rules-sync-and-cwt-updates.md](../feature/2026-09-23-stellaris-v4.5-rules-sync-and-cwt-updates.md) 拥有规则同步 SOP。