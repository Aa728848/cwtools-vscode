# 多 Agent 团队协作系统 — 实施计划

> 基于分析报告，采用「流水线并行」架构。Orchestrator 使用 DeepSeek V4 Pro，子 Agent 使用 DeepSeek V4 Flash。

---

## 模型策略

| 角色 | 模型 | 理由 |
|------|------|------|
| Orchestrator / Architect | `deepseek-v4-pro` | 需要强元推理能力进行任务分解和结果综合 |
| Explorer / Builder / Reviewer | `deepseek-v4-flash` | 执行具体工具调用，低延迟高吞吐 |
| LocWriter / AssetGen | `deepseek-v4-flash` | 模板化任务，无需深度推理 |

---

## 阶段 1：基础层（预计 2 周）

### [NEW] `client/extension/ai/orchestrator/types.ts`

多 Agent 专用类型定义：

```typescript
// 任务节点
interface TaskNode {
    id: string;
    agentType: AgentMode;
    prompt: string;
    dependencies: string[];       // 前置任务 ID
    priority: 'critical' | 'normal' | 'low';
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    result?: unknown;
    assignedModel?: string;       // 指定模型覆盖
    retryCount: number;
    maxRetries: number;
}

// 任务图
interface TaskGraph {
    id: string;
    nodes: Map<string, TaskNode>;
    metadata: { userPrompt: string; createdAt: number; };
}

// Blackboard 条目
interface BlackboardEntry {
    key: string;
    value: string;
    type: 'file_snapshot' | 'scope_info' | 'diag_result' | 'entity_registry' | 'free_text';
    version: number;              // 乐观锁
    authorAgentId: string;
    timestamp: number;
}

// Agent 实例描述
interface AgentInstance {
    id: string;
    type: AgentMode;
    taskNodeId: string;
    status: 'idle' | 'running' | 'done' | 'failed';
    tokenUsage: TokenUsage;
}
```

---

### [NEW] `client/extension/ai/orchestrator/blackboard.ts`

增强版黑板系统，替代现有 `sharedMemory`：

- **类型化条目** — 每个条目携带 `type` 标签
- **乐观锁写入** — `write(key, value, expectedVersion)` 失败时返回冲突
- **前缀订阅** — `watch(prefix, callback)` 监听变更
- **分区容量** — 全局区 500 + 每 Agent 分区 200
- **溢出持久化** — 超限条目写入 `.cwtools-ai/{topicId}/blackboard.json`

关键方法：
```typescript
class Blackboard {
    read(key: string): BlackboardEntry | undefined;
    write(key: string, value: string, type: EntryType, agentId: string, expectedVersion?: number): boolean;
    watch(prefix: string, cb: (entry: BlackboardEntry) => void): Disposable;
    queryByType(type: EntryType): BlackboardEntry[];
    getEntityRegistry(): Map<string, string>;  // entityId → creatorAgentId
    snapshot(): SerializedBlackboard;           // 序列化用于检查点
}
```

**与现有代码的关联**：
- 替换 `agentTools.ts:184` 的 `sharedMemory` Map
- `set_memory` / `get_memory` / `search_memory` 工具路由改为调用 `Blackboard` 实例

---

### [NEW] `client/extension/ai/orchestrator/agentRegistry.ts`

Agent 类型注册表 — 定义每种角色的能力、模型、工具权限：

```typescript
const AGENT_REGISTRY: Record<string, AgentProfile> = {
    explorer:  { mode: 'explore',        model: 'deepseek-v4-flash', maxIterations: 20, toolBudget: 'read_only' },
    architect: { mode: 'plan',           model: 'deepseek-v4-pro',   maxIterations: 15, toolBudget: 'plan' },
    builder:   { mode: 'build',          model: 'deepseek-v4-flash', maxIterations: 40, toolBudget: 'full' },
    locWriter: { mode: 'loc_writer',     model: 'deepseek-v4-flash', maxIterations: 20, toolBudget: 'loc' },
    reviewer:  { mode: 'review',         model: 'deepseek-v4-flash', maxIterations: 15, toolBudget: 'read_only' },
    assetGen:  { mode: 'build',          model: 'deepseek-v4-flash', maxIterations: 10, toolBudget: 'media_only' },
};
```

---

### [NEW] `client/extension/ai/orchestrator/orchestrator.ts`

协调器核心 — 自身也是一个 Agent，拥有元级工具：

**专有工具**（需在 `definitions.ts` + `agentTools.ts` + `types.ts` 三位一体注册）：
1. `decompose_task` — 将用户请求分解为 TaskGraph
2. `dispatch_agents` — 按 DAG 拓扑序启动子 Agent
3. `merge_results` — 汇总子 Agent 输出为最终交付物

**核心流程**：
```
1. 接收用户请求
2. 调用 LLM (deepseek-v4-pro) 分析请求复杂度
3. 简单请求 → 直接走现有 AgentRunner 单 Agent 流程
4. 复杂请求 → 生成 TaskGraph → 按阶段调度：
   Phase 1: Explorer 并行扫描 → Blackboard
   Phase 2: Architect 串行规划 → TaskGraph 细化
   Phase 3: Builder×N 半并行 → 按文件分区
   Phase 4: LocWriter 并行 → 按语言分区
   Phase 5: Reviewer 串行 → 质量门
5. 汇总报告 → 用户
```

**与现有代码的关联**：
- 复用 `AgentRunner.run()` 执行每个子 Agent
- 复用 `PromptBuilder.buildSystemPromptForMode()` 生成角色提示词
- 通过 `AgentRunnerOptions.providerId/model` 覆盖模型选择

---

### [MODIFY] `client/extension/ai/agentRunner.ts`

需要暴露的接口：

```typescript
// 新增：供 Orchestrator 调用的子 Agent 入口
async runAsSubAgent(
    taskNode: TaskNode,
    blackboard: Blackboard,
    parentAccumulator: TokenUsage,
    abortSignal: AbortSignal,
    onStep: (step: AgentStep) => void,
): Promise<SubAgentResult>
```

修改点：
- `reasoningLoop` 增加 `blackboard` 参数，子 Agent 可在循环中读写黑板
- `AgentRunnerOptions` 新增 `blackboard?: Blackboard` 和 `agentId?: string`
- 每个 `AgentStep` 新增 `agentId` 字段用于日志隔离

---

### [MODIFY] `client/extension/ai/types.ts`

新增类型：
- `TaskNode`, `TaskGraph`, `BlackboardEntry`, `AgentInstance`, `SubAgentResult`
- `AgentMode` 新增 `'orchestrator'`
- `AgentToolName` 新增 `'decompose_task' | 'dispatch_agents' | 'merge_results'`
- `AgentStep` 新增 `agentId?: string`

---

### [MODIFY] `client/extension/ai/tools/definitions.ts`

新增 3 个工具的 JSON Schema 定义：
- `decompose_task` — 输入用户请求文本，输出 TaskGraph JSON
- `dispatch_agents` — 输入 TaskGraph，输出执行状态
- `merge_results` — 输入子 Agent 结果数组，输出合并报告

---

### [MODIFY] `client/extension/ai/agentTools.ts`

- `executeInternal` switch 新增 3 个 case
- `sharedMemory` 替换为 `Blackboard` 实例引用
- 现有 `set_memory`/`get_memory`/`search_memory` 路由改为委托 Blackboard

---

## 阶段 2：调度层（预计 2 周）

### [NEW] `client/extension/ai/orchestrator/taskGraphEngine.ts`

DAG 任务图引擎：

```typescript
class TaskGraphEngine {
    // 拓扑排序 — 确定执行层级
    topologicalSort(graph: TaskGraph): TaskNode[][];

    // 获取下一批可执行节点（所有依赖已完成）
    getReadyNodes(graph: TaskGraph): TaskNode[];

    // 标记节点完成并检查是否触发新的就绪节点
    markComplete(graph: TaskGraph, nodeId: string, result: unknown): TaskNode[];

    // 标记节点失败并级联取消下游依赖
    markFailed(graph: TaskGraph, nodeId: string, error: string): string[];

    // 循环依赖检测
    detectCycles(graph: TaskGraph): string[][] | null;
}
```

---

### [NEW] `client/extension/ai/orchestrator/parallelExecutor.ts`

并行执行器 — 管理 Agent 实例池：

```typescript
class ParallelExecutor {
    // 最大并发数 = min(4, CPU_CORES)
    private readonly maxConcurrency: number;

    // 全局 Token 预算（超限后降级为串行）
    private tokenBudget: number;

    // 执行一批无依赖的 TaskNode
    async executeBatch(
        nodes: TaskNode[],
        runner: AgentRunner,
        blackboard: Blackboard,
        tokenAccumulator: TokenUsage,
        abortSignal: AbortSignal,
    ): Promise<Map<string, SubAgentResult>>;

    // 执行完整 TaskGraph（按层级调度）
    async executeGraph(graph: TaskGraph, ...): Promise<OrchestratorResult>;
}
```

**资源管理策略**：
- 使用 `Promise.allSettled` 并行执行同层节点，`p-limit` 控制并发上限
- 每个 Agent 的 `tokenAccumulator` 合并到父级（已有 `parentTokenAccumulator` 机制）
- 超出全局 Token 预算时自动降级：取消低优先级节点，剩余节点串行执行

---

### [NEW] `client/extension/ai/orchestrator/conflictDetector.ts`

冲突检测器：

```typescript
class ConflictDetector {
    // 检查 Agent 的写入意图是否与其他运行中 Agent 冲突
    checkWriteConflict(agentId: string, filePath: string, blackboard: Blackboard): ConflictResult;

    // Agent 写入前声明意图
    declareIntent(agentId: string, filePaths: string[], blackboard: Blackboard): void;

    // Agent 完成后清除意图
    clearIntent(agentId: string, blackboard: Blackboard): void;
}
```

---

## 阶段 3：专家 Agent 与质量门（预计 2 周）

### [NEW] `client/extension/ai/orchestrator/qualityGate.ts`

```typescript
class QualityGate {
    // Builder 完成后自动触发 Reviewer
    async reviewOutput(
        builderResult: SubAgentResult,
        runner: AgentRunner,
        blackboard: Blackboard,
    ): Promise<QualityGateResult>;
    // 最多 3 轮修复循环
}
```

### [MODIFY] `client/extension/ai/promptBuilder.ts`

- 新增 `buildOrchestratorPrompt()` — 元级提示词，专注任务分解
- 现有各 mode prompt 增加 `blackboard` 使用指引段落
- 子 Agent prompt 精简版：移除冗长的通用规则，仅保留角色专属指令

---

### [MODIFY] `client/extension/ai/chatPanel.ts`

UI 展示多 Agent 进度：
- 新增 `multiAgentProgress` 消息类型
- Orchestrator 的每个阶段作为可折叠组
- 子 Agent 步骤默认折叠，仅显示 Orchestrator 高层汇总
- 实时显示全局 Token 消耗和各 Agent 分项

---

## 阶段 4：集成测试（预计 1 周）

### [NEW] `client/test/unit/orchestrator.test.ts`

- TaskGraph 拓扑排序正确性
- 循环依赖检测
- Blackboard CAS 写入冲突处理
- 并行执行器并发上限遵守
- Token 预算超限降级行为

### 端到端验证场景

| 场景 | 预期 Agent 链 | 验证点 |
|------|-------------|--------|
| 创建 3 文件考古遗址 | Explorer → Architect → Builder×2 → LocWriter → Reviewer | 文件引用一致性、零 LSP 错误 |
| 全项目代码审查 | Explorer → Reviewer×3 (按目录分区) | 诊断计数准确、无重复 |
| 翻译 5 个本地化文件 | Explorer → LocWriter×5 (并行) | 所有 key 翻译完整、格式正确 |

---

## 文件清单总览

| 操作 | 文件 | 预计行数 |
|------|------|---------|
| **新增** | `ai/orchestrator/types.ts` | ~120 |
| **新增** | `ai/orchestrator/blackboard.ts` | ~250 |
| **新增** | `ai/orchestrator/agentRegistry.ts` | ~80 |
| **新增** | `ai/orchestrator/orchestrator.ts` | ~400 |
| **新增** | `ai/orchestrator/taskGraphEngine.ts` | ~200 |
| **新增** | `ai/orchestrator/parallelExecutor.ts` | ~300 |
| **新增** | `ai/orchestrator/conflictDetector.ts` | ~100 |
| **新增** | `ai/orchestrator/qualityGate.ts` | ~150 |
| **修改** | `ai/agentRunner.ts` | +80 行 |
| **修改** | `ai/types.ts` | +60 行 |
| **修改** | `ai/tools/definitions.ts` | +90 行 |
| **修改** | `ai/agentTools.ts` | +40 行 |
| **修改** | `ai/promptBuilder.ts` | +200 行 |
| **修改** | `ai/chatPanel.ts` | +100 行 |
| **新增** | `test/unit/orchestrator.test.ts` | ~200 |
| **合计** | **8 新增 + 6 修改** | **~2370 行** |

---

## 执行顺序

```
Week 1: types.ts → blackboard.ts → agentRegistry.ts
Week 2: orchestrator.ts → 修改 agentRunner/agentTools/definitions/types
Week 3: taskGraphEngine.ts → parallelExecutor.ts → conflictDetector.ts
Week 4: qualityGate.ts → 修改 promptBuilder/chatPanel
Week 5: 单元测试 → 端到端验证 → Bug 修复
```

> [!IMPORTANT]
> **阶段 1 完成后**需进行一次里程碑验证：用最简单的 Explorer→Builder 两步流水线跑通一个"创建单文件事件"任务，确认 Blackboard 通信和子 Agent 调度机制正常工作后再进入阶段 2。
