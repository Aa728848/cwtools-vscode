<!-- GENERATED FILE — run `npm run baseline:ai-context` to regenerate. -->
# AI 静态上下文基线 / AI Static-Context Baseline

对应 [ai-agent-reliability-efficiency-plan.md](./ai-agent-reliability-efficiency-plan.md) §9 阶段 0（测量基线），表格与 §2.1 同构。

- 生成时间：2026-07-22T04:53:43.807Z
- 生成时基础 Commit：f09003fa（工作树：dirty；报告可能包含尚未提交的测量输入）
- 测量输入 SHA-256：c799389ec8135f8e6e2c1f0e
- Token 估算：仓库自身 `estimateTokenCount`（`client/extension/ai/agentRunner.ts`），适合相对比较，不等同于供应商计费。
- Fixture：空临时 workspace（无 CWTOOLS.md、project profile、project knowledge、记忆、已安装技能），languageId 固定为 `stellaris`。
- 工具 Schema 按 mode 过滤后，再按当前 build stage 过滤并以 `JSON.stringify` 估算。
- 不含动态上下文（编辑器状态、用户输入、对话历史、注入的记忆/blueprint）；真实项目 workspace 的数字只会更大。

## 与 §2.1 同构的基线数字（Stellaris build 模式）

| 项目 | 估算 token |
| --- | ---: |
| 系统提示词 | 2,515 |
| 13 个工具定义 | 2,862 |
| 首轮静态输入合计 | 5,377 |
| slim build 静态输入（13 个工具） | 3,589 |
| 8 个并行 slim builder 的首轮静态输入 | 最差约 28,712 |
| `write_design_blueprint` 单个工具 Schema | 146 |

## 分模式明细

| 模式 | 工具数 | 系统提示词 | 工具 Schema | 静态合计 |
| --- | ---: | ---: | ---: | ---: |
| build | 13 | 2,515 | 2,862 | 5,377 |
| plan | 15 | 2,054 | 3,320 | 5,374 |
| explore | 14 | 1,889 | 3,139 | 5,028 |
| review | 14 | 2,269 | 3,323 | 5,592 |
| build (slim) | 13 | 727 | 2,862 | 3,589 |

## Build 阶段化工具明细

| 阶段 | 主 Agent 工具数 | 主 Agent 静态合计 | slim 工具数 | slim 静态合计 |
| --- | ---: | ---: | ---: | ---: |
| discovery | 13 | 5,377 | 13 | 3,589 |
| design | 15 | 5,490 | 15 | 3,702 |
| validation | 15 | 5,355 | 15 | 3,567 |
| write | 14 | 5,660 | 14 | 3,872 |
| finalize | 12 | 5,315 | 12 | 3,527 |

## 只读模式阶段化工具明细

| 模式 | 阶段 | 工具数 | 系统提示词 | 工具 Schema | 静态合计 |
| --- | --- | ---: | ---: | ---: | ---: |
| plan | discovery | 15 | 2,054 | 3,320 | 5,374 |
| plan | design | 15 | 2,054 | 2,975 | 5,029 |
| plan | validation | 15 | 2,054 | 2,474 | 4,528 |
| plan | finalize | 9 | 2,054 | 1,557 | 3,611 |
| explore | discovery | 14 | 1,889 | 3,139 | 5,028 |
| explore | validation | 15 | 1,889 | 2,971 | 4,860 |
| explore | finalize | 9 | 1,889 | 1,785 | 3,674 |
| review | discovery | 14 | 2,269 | 3,323 | 5,592 |
| review | validation | 14 | 2,269 | 2,738 | 5,007 |
| review | finalize | 9 | 2,269 | 2,053 | 4,322 |

## 与 §6.1 目标预算的差距

| Agent 类型 | 目标 | 当前基线 |
| --- | ---: | ---: |
| 主 Agent（build 静态合计） | 约 8,000 | 5,377 |
| slim/专职子 Agent（slim build 静态合计） | ≤4,000 | 3,589 |
