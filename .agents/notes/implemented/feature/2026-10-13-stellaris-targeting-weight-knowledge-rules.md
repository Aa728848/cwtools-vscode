# Agent Note: 索敌权重知识层落地（机制文档、规则文档与类型化、Agent 技能）

Status: implemented

## Problem

索敌（目标选择权重）机制在本项目此前只有一行文档（better_stellaris/04 :97），与伤害结算侧的 1047 行源码级文档严重不对称；规则数据层 19 个索敌 define 与武器索敌字段全部裸 `float` 无 `###` 文档，`target_weights` 的键为裸 `scalar`（错键不报错、无补全）；agent 侧无机制知识技能。

## Decision

2026-10-13 落地（一手来源：《群星索敌权重计算公式_4.5.2.pdf》，4.5.2 Cygnus 反编译分析）：

- **设计文档** `docs/stellaris-targeting-weight-4.5.2.md`：机制解读 + 脚本可调点全景 + 差距分析 + P0–P4 路线图；§6 算例经独立复算（0.528/0.524/1.76× 全部吻合）。
- **机制文档** `docs/better_stellaris/17_ship_targeting_weights.md`（545 行，10 节），README 目录与 04 号文同步链接；诚实标注「转写自 PDF，未经本仓库 dump 核验」，并声明与 16 号冲突时以 16 号为准。
- **规则子模块**（cwtools-stellaris-config `bcccad4`，已推送）：
  - `target_weights` 键 `scalar = float` → `<ship_size> = float`（V1 已 vanilla 证实：25 处用法去重 18 键全部是 ship_size id，`000_documentation.txt:81` 官方注释佐证）；
  - 15 个武器字段 + 20 个 NCombat/NShip define + `shipsize_$_target_weight_mult` 别名的英文 `###` 公式文档（vanilla 值逐条实读 `00_defines.txt` 核对）；
  - V6 结论：`fire_rate`/`burst_*`/`damage_degrade_per_tier` 等 6 个字段在 4.5.2 vanilla 不存在，不补规则。
- **Agent 技能** `.agents/skills/stellaris-targeting-weights/SKILL.md`：机制知识 + 取证路径 + 误区十条；allowed-tools 9 个全部命中 registry 且均为只读（`query_blackboard` 因 effect=none 命中 ORCHESTRATION 而非只读，被剔除并在正文 §3.3 留档）。
- 规则报告门禁：`folders with findings: 0`、trigger/effect/modifier/scope 零变动，与基线一致。

## Alternatives considered

- **机制内容直接入 better_stellaris 系列而省略 docs/ 根设计文档**：设计文档承载路线图与差距分析，与系列"引擎内部分析"定位不同，两者分工（设计文档 → 17 号机制文）。
- **技能放 built-in `client/extension/resources/skills`**：该目录不存在且 VSIX 打包未证实（V5），先放项目级 `.agents/skills/`。
- **给字段挂 `## engine`/`## engine_evidence`**：`engine_evidence` 行号禁止手改（merge-engine-cost.cjs 纪律），且字段级渲染支路当时未接线——由姊妹笔记（2026-10-13-targeting-weight-tooling）的 fix A 补齐。
- **modifiers.log 手写修饰符描述**：log 是生成物，重生成会被冲掉，不做。

## Consequences

- defines 与武器字段的 `###` 走 RulesParser.fs:367-371 的 description 路径，hover/补全立即可见；`shipsize_$_target_weight_mult` 那条 `###` 走 parseModifier → TypeModifier.documentation 支路，需姊妹笔记的 RulesHelpers 接线后才可见（已通）。
- 技能已被扩展的技能扫描链路实时接受（目录自动刷新）。
- 未证实项收敛：V1/V6 已解决；V2（target_focus 枚举到引擎 0/1 映射）、V3/V4/V5 仍留待验证，登记于设计文档 §10 与 17 号文 §8。
