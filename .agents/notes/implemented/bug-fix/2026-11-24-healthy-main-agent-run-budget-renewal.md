# Agent Note: 健康主 Agent 的软运行时预算自动续窗

Status: implemented

## Problem

主 Agent 的软运行时预算默认窗口为 64 次模型调用、20 分钟与 300000 个未缓存输入 token。原续窗逻辑对子 Agent 允许以健康活动续窗，但主 Agent 只把持久写入、待办完成或诊断改善计为进展。纯读取、检索、交叉索引和分析任务因此会在仍有有效产出时暂停，并显示“continue the task to resume”；截图中的 64/64 调用并非 512 次硬上限。

## Decision

`client/extension/ai/runner/runBudget.ts` 将 `SubAgentActivityBudgetState/shouldAutoExtendSubAgentBudget` 统一为 `RunActivityBudgetState/shouldAutoExtendRunActivity`：主 Agent 与子 Agent 在出现新迭代、连续工具错误为 0 且阻塞校验问题为 0 时，都可自动续一个软预算窗口。`agentRunner.ts` 在续窗前强制保存恢复快照，并记录 healthy run activity 验证事件。

绝对硬预算不续窗；重复工具签名与结果不变的 doom-loop 检测、连续工具失败停止、阻塞校验和显式取消保持原样。持久写入、待办完成与诊断改善仍通过 `shouldAutoExtendRunBudget` 记录，不改变其语义。

## Alternatives considered

- **只提高默认调用/token 软上限**：否决。只推迟暂停，仍会让长只读分析任务误停，并削弱异常run的及时保护。
- **完全移除软预算**：否决。软窗口检查点与固定硬上限仍是失控任务的安全边界。
- **把每次工具结果都视为持久写入**：否决。活动续窗只回答“是否健康推进”，不伪造文件变化或诊断改善。

## Consequences

- 健康只读主 Agent 不再在首个 64 调用软窗口暂停；无新迭代、连续错误或阻塞校验时仍暂停。
- `client/test/unit/runBudget.test.ts` 覆盖健康主 Agent、无新迭代与连续错误场景；与 `webviewSmoke.test.ts` 合计 55 项针对性回归通过，测试 TypeScript 类型检查通过。
