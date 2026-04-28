# AI Agent 架构优化改进计划 · 最终方案

本文档汇总了对 CWTools VS Code 扩展 AI 代理系统的优化评估与实施计划。所有更改旨在修复严重的 Promise 异步死锁、资源泄露风险、提升并发能力，并解决类型与逻辑的不一致性。

---

## 核心运行时 (Agent Runner)

### [MODIFY] `client/extension/ai/agentRunner.ts`

#### 1. 解决 WriteQueue 死锁问题

**问题**：如果任何一个入队的写入操作被拒绝（reject），`this.queue` 会变成一个已拒绝的 Promise。之后所有 `enqueue()` 调用都会将 `.then()` 链接到已拒绝的 Promise 上，导致整个写入系统永久死锁，直到扩展被重新加载。

**修复**：在队列层面捕获拒绝，确保链式调用始终继续：
```typescript
enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        this.queue = this.queue
            .then(() => fn().then(resolve, reject))
            .catch(() => { /* 吞掉错误以保持队列存活 */ });
    });
}
```

#### 2. 完善死循环检测：签名对 + 归一化结果哈希

**问题**：当前检测使用单个签名的频率计数，无法识别 A-B-A-B 交替模式。同时，简单的签名对检测可能误伤合法的 read→edit→verify→fix 迭代工作流。

**修复**：两阶段检测机制——
- **阶段一（签名对检测）**：跟踪 (prevSig, currSig) 对。当同一对出现 ≥ 4 次时进入阶段二验证。
- **阶段二（归一化结果哈希验证）**：在阶段一触发后，比较相邻同名调用的返回体关键字段哈希。若哈希完全相同（"原地打转"），确认真死循环并立即截断；若哈希不同（"逐步攻克"），则是有意义的迭代，放行继续。

**归一化哈希按工具类型选择性提取**：

| 工具 | 哈希字段 |
|------|----------|
| `read_file` | 文件 content |
| `edit_file` / `write_file` | 写入后的内容 |
| `query_scope` | thisScope + prevChain |
| `validate_code` | 诊断 code+message 集合（排除行列号） |
| `lsp_operation` | 返回 JSON 结构（排除位置信息） |
| 通用 fallback | 整个返回体的前 256 字符 |

开销：每个哈希子串 32 字节，50 轮推理循环累积约 1.6KB，可忽略。

#### 3. 接入会话 Token 预算保护

**问题**：`AIService.reportUsage()` 已实现但在整个代码库中从未被调用，1.5M 令牌预算形同虚设。

**修复**：在主推理循环中，每次累积令牌后调用 `this.aiService.reportUsage(totalTokens)`。同时将累积总量传递给子代理，确保整个代理树统一执行预算。

#### 4. 子代理上下文摘要注入

**问题**：子代理从干净的 `[system, user]` 消息对开始，父代理已收集的上下文（读取的文件、作用域链、验证结果）全部丢失，子代理浪费迭代次数重新发现。

**修复**：在 `runSubAgent` 发起前，从父代理对话中提取简短摘要（已读文件列表、当前作用域、关键发现），注入到子代理的初始用户消息中。

---

## 工具层 (Agent Tools)

### [MODIFY] `client/extension/ai/agentTools.ts`

#### 5. 添加工具调用超时

**问题**：没有任何工具执行有超时限制。`readFile` 在网络文件系统上挂起或 LSP 请求死锁时，整个推理循环无限期阻塞。

**修复**：用 `Promise.race` 包装每个工具执行，文件操作默认 30 秒超时，LSP 操作默认 15 秒。超时后返回错误结果，让模型尝试替代方案。

```typescript
const result = await Promise.race([
    this.executeInternal(name, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('工具执行超时')), timeout))
]);
```

#### 6. 重构 Switch 为注册表模式 (Registry Pattern)

**问题**：40 个 case 的 switch 语句脆弱且不一致——内存工具以内联方式处理，其余委托给处理器。

**修复**：转换为 `Map<string, ToolHandler>` 注册表。每个处理器为 `(args: Record<string, unknown>) => Promise<string>`。在构造函数中注册，便于动态添加/移除工具。

---

## 并发写入调度 (Partitioned Write Queue)

### [NEW] `client/extension/ai/agentRunner.ts` — 全局大锁 → 分区锁

#### 7. 将全局串行 WriteQueue 重构为按文件路径的分区锁

**问题**：当前 `globalWriteQueue` 是单个 Promise 链，所有写入操作（包括操作完全不同文件的子代理）全部串行化。在多子代理并发环境下，这直接将"多线程"退化回"单线程"。

**修复**：将单一 WriteQueue 重构为 `Map<string, WriteQueue>` 分区调度中心：

```typescript
class PartitionedWriteQueue {
    private queues = new Map<string, WriteQueue>();

    enqueue(files: string[], fn: () => Promise<void>): Promise<void> {
        // 按文件路径字典序排序，杜绝 AB/BA 环形等待死锁
        const sorted = [...new Set(files)].sort();
        return sorted.reduce(
            (chain, path) => chain.then(() => this.getQueue(path).enqueue(() => Promise.resolve())),
            Promise.resolve()
        ).then(() => fn());
    }

    private getQueue(path: string): WriteQueue {
        let q = this.queues.get(path);
        if (!q) {
            q = new WriteQueue();
            this.queues.set(path, q);
        }
        return q;
    }
}
```

**设计要点**：
- **单文件操作**退化为路径列表长度为 1，零额外开销。
- **多文件操作**（`multiedit`、`ast_mutate`）按统一字典序获取所有路径锁，从数学上杜绝环形等待。
- 每个分区内的 WriteQueue 仍然保留 `.catch()` 防死锁逻辑（改进 1）。
- 操作不同文件的子代理实现真正的并行写入加速。

---

## 外部调用工具 (External Tools)

### [MODIFY] `client/extension/ai/tools/externalTools.ts`

#### 8. 类型修复与对齐

**问题**：`ExternalToolContext.runSubAgent` 声明 mode 为 `'explore' | 'general' | 'build'`，但实际已支持 `'review' | 'gui_expert' | 'script_reviewer'`。

**修复**：替换为引用全局共享的 `AgentMode` 类型，删除对应的 `as 'explore' | ...` 强制类型转换。

#### 9. 清理无效变量

**问题**：`errorMessage` 变量声明后从未被赋值，catch 块中始终回退到 `e`。

**修复**：删除该变量，简化 catch 返回逻辑。

---

## 服务网络层 (AI Service)

### [MODIFY] `client/extension/ai/aiService.ts`

#### 10. 添加 HTTP 重试抖动 (Jitter)

**问题**：重试延迟 `[2000, 4000, 8000]` 无抖动。多并发请求同时遇到 429 时，在完全相同时刻重试，引发雷群效应。

**修复**：添加最多 25% 的随机抖动 `delay + Math.random() * delay * 0.25`。

---

## 上下文切片与预算管控 (Context Budget)

### [MODIFY] `client/extension/ai/contextBudget.ts`

#### 11. 压缩时一致清理 reasoning_content

**问题**：`reasoning_content` 仅从"激进区"（最旧消息）中删除。中间区域保留但它对应的内容可能已被截断，导致不匹配。

**修复**：从所有被压缩的消息中删除 `reasoning_content`，而非仅激进区。

#### 12. 预算扩展键名白名单

**问题**：`extractBudgetableArray` 硬编码数组键列表。新工具返回不同键名（`matches`、`suggestions`）时无法享受智能去重/分段。

**修复**：添加 `'matches'`、`'suggestions'`、`'findings'`、`'errors'`、`'warnings'`。

---

## 改动文件汇总

| 文件 | 改动 | 优先级 |
|------|------|--------|
| `client/extension/ai/agentRunner.ts` | WriteQueue 修复、签名对+哈希死循环检测、会话预算调用、子代理上下文摘要、**分区锁重构** | 严重/高优 |
| `client/extension/ai/agentTools.ts` | 工具超时、Switch→注册表重构 | 高优/中优 |
| `client/extension/ai/aiService.ts` | 重试抖动 | 中优 |
| `client/extension/ai/contextBudget.ts` | reasoning_content 清理、键名白名单扩展 | 中优/低优 |
| `client/extension/ai/tools/externalTools.ts` | 类型修复、无效变量清理 | 低优 |

---

## 架构升级总结

| 维度 | 现状 | 改后 |
|------|------|------|
| 写入并发模型 | 单线程全局互斥锁 | 按文件路径分区锁 + 字典序防死锁 |
| 死循环检测 | 单签名频率计数 (≥3) | 签名对 + 归一化结果哈希双重验证 |
| 会话预算 | 完全未接入（死代码） | 代理树全局统一执行 |
| 子代理上下文 | 完全重置 | 父级发现摘要自动注入 |
| 工具超时 | 无 | 文件 30s / LSP 15s |
| 工具分发 | 40-case switch | Map 注册表 |
| HTTP 重试 | 固定延迟 | 25% 随机抖动 |

---

## 验证方案

### 自动化验证
- `npm run compile` — 全栈 TypeScript 构建通过
- `npm run test` — 所有 AI 组件测试回归正常

### 手动验证
1. **分区锁并发测试**：派发 3 个子代理分别修改 3 个不同文件，确认修改被并行执行（通过时间戳对比）
2. **多文件写入防死锁**：两个子代理同时执行 `multiedit` 修改相同两个文件但顺序相反，确认不会死锁
3. **死循环检测精度测试**：
   - 场景 A：模型对同一文件反复做"无实际修改的 edit_file + validate_code"循环，确认被截断
   - 场景 B：模型逐步修复 3 个不同的 LSP 报错（每次 validate_code 结果不同），确认放行通过
4. **WriteQueue 死锁恢复**：人为触发一次写入拒绝后，继续向同一队列下发任务，确认流程未陷入死机
5. **子代理上下文贯通**：断点子代理启动，检查初始消息是否携带父级发现的压缩化线索
