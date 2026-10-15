# Agent Note: Stellaris 索敌权重机制设计文档与功能路线图

Status: archived — 已实施，由 implemented/feature/2026-10-13-stellaris-targeting-weight-knowledge-rules.md 与 implemented/feature/2026-10-13-targeting-weight-tooling.md 承接

## Problem

索敌（目标选择权重）是 Stellaris 战斗脚本可调的核心机制，但本项目此前只有一行文档（docs/better_stellaris/04 号 :97），与伤害结算侧的 1047 行源码级文档（16 号）严重不对称；规则数据层 19 个索敌 define 与武器索敌字段全部裸 `float` 无文档，`target_weights` 的键为裸 `scalar`（错键不报错、无补全）。用户提供了 4.5.2 反编译分析《群星索敌权重计算公式_4.5.2.pdf》，需要转化为对插件与 agent 的功能指导。

## Proposal


（2026-10-13 归档：路线图已全部实施，验收证据见上述两条 implemented 笔记。）
