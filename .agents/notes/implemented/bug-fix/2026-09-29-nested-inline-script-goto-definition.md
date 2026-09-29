# Agent Note: 嵌套 inline_script 引用跳转修复

Status: implemented

## Problem

用户反馈：`inline_script` 的快速跳转（Go to Definition）只对普通脚本文件中第一层的
`inline_script = { script = ... }` 引用有效；当引用出现在另一个 inline script 文件
（`common/inline_scripts/**`）内部时（即嵌套 inline），跳转到 `script = some/path`
目标文件失败。

根因（两层）：

1. 主路径失效：`getInfoAtPos` 的主路径依赖 `InfoService.GetInfo`（`submodules/cwtools/CWTools/Rules/InfoService.fs`
   中 `fLeaf` 对 `leaf.Key = "inline_script" || leaf.Key = "script"` 的兜底分支产出
   `FileRef("common/inline_scripts/" + value)`）。但 `foldWithPos` 先按
   `CheckPathDir` 过滤 typedef，而规则配置中**没有任何 typedef 覆盖
   `common/inline_scripts` 路径**（仅 `override_modes.cwt` 有一条 `DUPL` 记录），
   因此 inline script 文件内 `GetInfo` 恒为 `None`，主路径不会产出 `FileRef`。
2. 兜底失效：`LanguageFeatures.getInfoAtPos`（`submodules/cwtools/CWTools/Game/LanguageFeatures.fs`）
   的 `inlineScriptFallback` 只识别**光标所在行同时包含 `inline_script =` 与
   `script = <path>`** 的单行写法。多行块中光标位于独立的 `script = ...` 行时，该行不含
   `inline_script`，兜底直接返回 `None`；随后的 `wordLookupFallback` 把
   `buildings/xxx` 当类型名查找也找不到，最终无定义。

## Decision

扩展 `inlineScriptFallback`（仍只在主路径 `GetInfo` 无结果后触发），覆盖三种形态：

```text
形态 A（原有）单行块：  inline_script = { script = a/b ... }   ← 光标行同含两者
形态 B（新增）多行块：  inline_script = {                     ← 向上花括号深度扫描确认
                            script = a/b        ← 光标在此行
                        }
形态 C（新增）裸路径：  inline_script = a/b                    ← 无花括号直接引用
```

- 形态 B 通过向上扫描确认光标处于 `inline_script = {` 块内：与补全侧
  `tryInlineScriptCompletion` 的 `findInlineScriptContext` 相同的括号深度语义——
  要求命中行 `braceDelta > 0 && braceDepth = 0 && maxDepth = 0`，`maxDepth` 守卫
  保证光标位于兄弟块（如 `nested = { script = ... }`）时不会误判为 inline 引用；
  扫描跳过整行注释（`#` 开头）。
- 形态 C 用 `inline_script\s*=\s*([^\s{}|]+)` 提取裸路径；`\bscript` 词边界保证不会
  把 `inline_script` 中的 `script` 子串误匹配（`inline_script = a/b` 行先试
  `script =` 模式失败后再试裸路径模式）。
- 三种形态统一走 `resolveScriptPath`：跳过含 `$` 的参数化路径（无法静态解析），
  值去引号、`\` 归一为 `/`，在 `AllEntities` 中按
  `logicalpath` 尾匹配 `common/inline_scripts/<path>[.txt]` 定位目标文件。
- 回归测试（`submodules/cwtools/CWToolsTests/FolderValidationTests.fs` 的
  `goToDefinitionRegressionTests`）：嵌套多行块可跳转到目标 inline 文件；裸路径形式
  可跳转；兄弟块内的 `script =` 键**不**跳转（守卫 `maxDepth` 语义）。

## Alternatives considered

- **为 `common/inline_scripts` 新增 typedef 规则让主路径生效**：inline script 是模板文件，
  其内容语法取决于调用点上下文（effect/trigger/任意类型片段），没有固定的类型规则可归属；
  且展开阶段明确跳过该目录。用 typedef 覆盖会把模板文件纳入错误的验证/信息体系，拒绝。
- **在展开后的 AST 上通过 `Trivia.originalSource` 反查调用点**：展开只发生在非 inline
  文件上，嵌套场景的问题恰恰是 inline 文件自身没有展开、也没有 typedef，方向不符，拒绝。
- **复用 `wordLookupFallback` 做路径后缀匹配**：把文件路径词当类型 id 查表，语义错误且
  命中率低，拒绝。

## Consequences

- inline script 文件内的嵌套 `inline_script` 引用（多行块与裸路径两种写法）现在都能
  Ctrl+Click / F12 跳转到目标文件；普通文件内行为不变（主路径优先）。
- 兜底仍只在主路径无结果时执行，单行匹配之外新增一次向上的括号扫描（与补全侧同款，
  最坏 O(文件行数)，交互请求量级可接受）。
- 约束：含 `$PARAM$` 的参数化路径依旧不跳转（静态无法解析，与既有行为一致）；
  括号扫描对「注释行内含花括号」的行不做词法剔除（与补全侧已知限制一致）。
