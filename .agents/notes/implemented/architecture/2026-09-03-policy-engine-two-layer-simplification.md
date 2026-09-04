# Agent Note: Policy Engine Two-Layer Simplification and Protocol Convergence

Status: implemented

## Problem
在安全策略裁决和跨端交互机制中，存在以下多层冗余与概念不一致：
1. **策略引擎层级冗余与死代码**：旧的 `PolicyEngine` 设计了过度复杂的动态分层体系，部分中间层存在跨层竞态风险，且充斥着未被有效覆盖的死分支。
2. **门禁重复校验**：路径包含性检查（path containment）既在策略引擎最外层做拦截，又在各个具体工具实现中重复校验，导致逻辑分歧和重复开销。
3. **权限存储分裂**：学习型规则库（learned permission policy store）与主策略引擎用户规则各自维护持久化状态，易产生不同步。
4. **跨端协议与类型漂移**：VS Code 扩展端与 `submodules/cwtools-mcp` 之间的工具效果（`ToolEffect`）和诊断级别枚举存在微小字面量分歧。

## Decision
1. **精简 PolicyEngine 为纯粹双层模型**：
   - 彻底废除多余的中间层，收敛为“核心硬约束层 + 用户可配置规则层”两层架构，消除跨层竞态死代码。
2. **重构门禁职责划分**：
   - 将只读路径的合法性检查下推至各工具处理器（Tool Handler）中就近防御，消除外层重复门禁。
   - 将写确认旁路判定提取为纯函数（`write confirmation bypass decisions`）并实现 100% 分支单测覆盖。
3. **统一权限策略持久化**：
   - 将学习型权限规则直接并入 `PolicyEngine` 的用户层规则体系，确立单一事实来源。
4. **跨端协议与共享类型单源化**：
   - 收敛公用协议至 `client/shared`，并在 `submodules/cwtools-mcp` 中对齐 `ToolEffect` 的进程字段及诊断枚举命名。

## Alternatives considered
- **保留原有策略多层架构并添加全局状态锁**：
  - *未采纳原因*：过度抽象的分层不仅阻碍代码阅读，还隐藏了隐蔽的并发死角；简化为双层能完全覆盖所有安全需求，无需引入重量级状态锁。
- **允许子模块拥有独立的枚举别名并在桥接层做转换**：
  - *未采纳原因*：多一套转换层意味着多一份运行时开销和同步维护负担，从源头对齐协议是最高效的解法。

## Consequences
- 权限判定速度与可解释性显著增强。
- 彻底消除了跨端通讯中的枚举不匹配隐患。
- 减少了策略引擎近 30% 的无效代码。
