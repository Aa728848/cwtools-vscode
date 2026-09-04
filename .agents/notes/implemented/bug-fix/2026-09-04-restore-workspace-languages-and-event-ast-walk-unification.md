# Agent Note: Restore Workspace Languages and Unify EventAstWalk

Status: implemented

## Problem
在后端工作区状态维护与 AST 遍历分析中，存在两项显著的问题与回归缺陷：
1. **工作区语言设置丢失回归**：在工作区重新加载或发布配置更新时（`src/Main/Program.fs`），`prepared.languages` 未正确回填给活跃工作区实例，导致重载后多语言关联断开，影响本地化解析。
2. **AST 事件主体抽取逻辑分歧**：在 `EventAstWalk.fs` 及其使用者（`InlineGraph.fs`、`PdxFlowAnalysis.fs`、`ProjectKnowledge.fs`）之间，存在重复且略有分歧的 AST 节点主体解析实现，并残留了多个未被引用的死函数（如 `isConditionBranchKey` 等）。
3. **遗留 RulesCache 调用残留**：代码中仍有已弃用的 `RulesCache` 调用。

## Decision
1. **恢复 `languages` 属性回填**：
   - 确保在工作区初始化与重载阶段，`languages <- prepared.languages` 严格生效，保障多语言上下文状态的连续性。
2. **收纳统一 `EventAstWalk` 抽取逻辑**：
   - 将各个分析模块的主体抽取逻辑归一化为 `subjectFromNodeWith` 纯函数，三方统一接入。
   - 彻底删除 `EventAstWalk.fs` 内的 3 个废弃死函数，将该模块大幅精简收敛至 48 行。
3. **彻底剔除 RulesCache 废弃调用**：
   - 移除失效缓存调用，跟进现代规则加载管线。

## Alternatives considered
- **允许三方分析模块各自保留私有 AST 提取实现**：
  - *未采纳原因*：事件 AST 结构的解析直接决定了流程图和事件依赖分析的准确度。三套不同步的提取实现容易导致同一段脚本在流程图和知识库中呈现不同结果；统一定义能保证语义判定的一致性。
- **保留死函数以备未来可能扩展**：
  - *未采纳原因*：Git 历史已完整保存所有变更，未使用的死代码只会干扰静态分析和阅读理解，应坚决剪除。

## Consequences
- 彻底修复了重新加载后语言环境丢失的 Bug。
- 事件遍历核心代码行数缩减，各高级分析工具间的数据提取口径达成绝对一致。
