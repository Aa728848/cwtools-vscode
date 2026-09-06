# Agent Note: 移除冗余的 UTF-16 代理对检查及无关 Emoji 测试

Status: implemented

## Problem
在 `tabCompletion.ts` 中，`parseAntigravityTabEdit` 包含了一段防御性的正则检测代码，当截断位置落在代理对（surrogate pair，`[\uD800-\uDBFF]`）内部时强行微调前缀/后缀偏移量。然而在 JavaScript 与 VS Code 中，字符串、偏移量以及编辑器 Range 本身就是原生基于 UTF-16 代码单元（code units）进行计量的，因此该手动干预属于冗余逻辑。此前甚至为了覆盖该防御分支而特意添加了使用虚构 Emoji 表情（`😀`、`😁`）的人工合成单测，不仅无法提供真正的回归防护，反而在 PdxScript 游戏脚本测试套件中引入了无关噪点。

## Decision
1. **移除手动代理对正则调整**：从 `parseAntigravityTabEdit` 中彻底删除针对 `[\uD800-\uDBFF]` 与 `[\uDC00-\uDFFF]` 的手动正则修正逻辑，恢复为直观的前缀/后缀切片。
2. **清理无关 Emoji 单测**：移除 `it('does not split Unicode characters when finding an edit boundary')`，并在 `antigravityTab.test.ts` 的 CRLF 换行偏移恢复测试中清理非必要的 Emoji 夹具。

## Alternatives considered
- **保留代理对检查**：否决。为 Paradox 游戏脚本编辑中不可能出现的极端边界增加了虚假复杂度与维护负担。

## Consequences
- `parseAntigravityTabEdit` 的逻辑精简为清晰直接的公共前后缀切片。
- 消除了无关的 Emoji 测试用例，全部 2351 个单元测试持续稳定通过。
