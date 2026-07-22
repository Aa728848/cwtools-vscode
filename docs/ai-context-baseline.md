<!-- GENERATED FILE — run `npm run baseline:ai-context` to regenerate. -->
# AI 静态上下文基线 / AI Static-Context Baseline

对应 [ai-agent-reliability-efficiency-plan.md](./ai-agent-reliability-efficiency-plan.md) §9 阶段 0（测量基线），表格与 §2.1 同构。

- 生成时间：2026-07-22T01:24:27.216Z
- Commit：32b02edb
- Token 估算：仓库自身 `estimateTokenCount`（`client/extension/ai/agentRunner.ts`），适合相对比较，不等同于供应商计费。
- Fixture：空临时 workspace（无 CWTOOLS.md、project profile、project knowledge、记忆、已安装技能），languageId 固定为 `stellaris`。
- 工具 Schema 按 mode 过滤后，再按当前 build stage 过滤并以 `JSON.stringify` 估算。
- 不含动态上下文（编辑器状态、用户输入、对话历史、注入的记忆/blueprint）；真实项目 workspace 的数字只会更大。

## 与 §2.1 同构的基线数字（Stellaris build 模式）

| 项目 | 估算 token |
| --- | ---: |
| 系统提示词 | 4,329 |
| 13 个工具定义 | 2,934 |
| 首轮静态输入合计 | 7,263 |
| slim build 静态输入（13 个工具） | 5,503 |
| 8 个并行 slim builder 的首轮静态输入 | 最差约 44,024 |
| `write_design_blueprint` 单个工具 Schema | 146 |

## 分模式明细

| 模式 | 工具数 | 系统提示词 | 工具 Schema | 静态合计 |
| --- | ---: | ---: | ---: | ---: |
| build | 13 | 4,329 | 2,934 | 7,263 |
| plan | 15 | 3,845 | 3,410 | 7,255 |
| explore | 14 | 3,731 | 3,230 | 6,961 |
| review | 14 | 4,100 | 3,399 | 7,499 |
| build (slim) | 13 | 2,569 | 2,934 | 5,503 |

## Build 阶段化工具明细

| 阶段 | 主 Agent 工具数 | 主 Agent 静态合计 | slim 工具数 | slim 静态合计 |
| --- | ---: | ---: | ---: | ---: |
| discovery | 13 | 7,263 | 13 | 5,503 |
| design | 15 | 7,577 | 15 | 5,817 |
| validation | 15 | 7,437 | 15 | 5,677 |
| write | 14 | 7,714 | 14 | 5,954 |
| finalize | 12 | 7,384 | 12 | 5,624 |

## 只读模式阶段化工具明细

| 模式 | 阶段 | 工具数 | 系统提示词 | 工具 Schema | 静态合计 |
| --- | --- | ---: | ---: | ---: | ---: |
| plan | discovery | 15 | 3,845 | 3,410 | 7,255 |
| plan | design | 15 | 3,845 | 3,248 | 7,093 |
| plan | validation | 15 | 3,845 | 2,732 | 6,577 |
| plan | finalize | 9 | 3,845 | 1,717 | 5,562 |
| explore | discovery | 14 | 3,731 | 3,230 | 6,961 |
| explore | validation | 15 | 3,731 | 3,243 | 6,974 |
| explore | finalize | 9 | 3,731 | 1,946 | 5,677 |
| review | discovery | 14 | 4,100 | 3,399 | 7,499 |
| review | validation | 14 | 4,100 | 2,935 | 7,035 |
| review | finalize | 9 | 4,100 | 2,221 | 6,321 |

## 与 §6.1 目标预算的差距

| Agent 类型 | 目标 | 当前基线 |
| --- | ---: | ---: |
| 主 Agent（build 静态合计） | 约 8,000 | 7,263 |
| slim/专职子 Agent（slim build 静态合计） | 4,000–6,000 | 5,503 |
