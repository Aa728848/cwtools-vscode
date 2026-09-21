# Agent Note: 类型擦除对抗夹具的转义写法必须通过 ESLint 门禁

Status: implemented

## Problem

`2026-09-19-ptc-type-erasure-and-plan-router-removal.md` 引入的对抗性夹具 `client/test/unit/toolPresentationMode.test.ts` 中有 6 处在字符串字面量内部对双引号写了不必要的反向转义（`\"`）。这些转义在 JavaScript 语义上等价于裸 `"`，运行时行为完全正确，但 `eslint.config.mjs` 继承的 `eslint:recommended` 以 **error** 级别启用 `no-useless-escape`。

`npm run verify` 的第一段就是 `npm run lint`，因此该错误在 `lint` 阶段即以 6 个 error 中止整个流水线：

```
client/test/unit/toolPresentationMode.test.ts
  821:76  error  Unnecessary escape character: \"  no-useless-escape
  895:76  error  Unnecessary escape character: \"  no-useless-escape
 1028:24  error  Unnecessary escape character: \"  no-useless-escape
 ...
✖ 41 problems (6 errors, 35 warnings)
```

CI 自 `bc702b12` 之后的每一次 push 都在此失败，且**失败发生在 lint 阶段，`test:unit` 根本没有执行**——类型擦除、扩展宿主集成、.NET 与 MCP 四类 job 中只有 TypeScript 一个 job 红，其余全绿，症状上很容易被误判为“单测不稳”。修复前基线为 `npm run verify` 退出码 1。

## Decision

在同一测试文件中删除这 6 处不必要的转义，仅改动字符串**字面量内部的书写形式**，被擦除器实际处理的源文本逐字节不变：

| 行 | 修改前 | 修改后 |
| --- | --- | --- |
| 821 | `.replace(/\"/g, '\"\')` | `.replace(/"/g, '\"\')` |
| 895 | `.replace(/\"/g, 'y')` | `.replace(/"/g, 'y')` |
| 1028 | `'(e?{}[\"\"] : 2).v;'` | `'(e?{}[""] : 2).v;'` |
| 1029 | `[false \| -1,\"\"];'` | `[false \| -1,""];'` |

选择“改夹具”而非“放宽规则”：`no-useless-escape` 属于 `eslint:recommended` 的既有基线，为单个测试文件的书写习惯削弱全仓静态门禁不划算；且被断言的目标不是“源码里必须有反斜杠”，而是“正则字面量中的引号不会让模板字符串跳过器失步”，裸 `"` 已经完全覆盖该语义。

未触及任何生产代码、测试断言与既有测试语义（`toolPresentationMode.test.ts` 仍为 113 项）。

## Alternatives considered

1. **在测试文件上为 `no-useless-escape` 加 eslint-disable 或对该目录降级规则**：否决。`client/test/**` 的规则放宽已经集中在 `eslint.config.mjs` 里，只为 4 行的书写冗余再开一个豁免口子，会让后续真实的无用转义继续潜伏；而该规则恰好是这次门禁唯一的拦截者。
2. **把测试文件移出 `npm run lint` 的扫描范围（`eslint client/` 改为只扫 `client/extension`）**：否决。测试套件是仓库里体量最大、最容易被生成的代码，把它移出静态门禁等于永久放弃对它的检查，风险远大于收益。
3. **改写断言以使用 `String.raw` 或显式构造字符串**：否决。夹具刻意写成接近真实 PTC 源码的形态，改成拼接或 `String.raw` 会削弱“这段源码原样送入擦除器”的可读性；而反斜杠本身并非断言目标。

## Consequences

- `npm run verify` 恢复全绿：`npm run lint` 0 error（仅剩 35 条既有告警）、`compile`、`typecheck:test`、`test:unit`（2567 passing）、`check:release` 全部通过，退出码 0；`npm run check:mcp-schema` 仍报 `MCP tool schema is up to date (36 tools)`。
- 被这 6 行覆盖的断言在实际执行中保持通过并逐字节恒等：`keeps a regex containing a quote inside a template substitution`（两项）与 `keeps a ternary whose consequent indexes an object literal` 均绿。
- 记录一条可复用的排障线索：CI 红在 TypeScript job 但其余 job 全绿、且日志里只有 `✖ N problems (M errors, W warnings)` 时，应优先怀疑**测试文件本身**的 lint，而不是被测试的行为；`test:unit` 在该路径上根本不会运行。
- 已知的既有噪声保持不变、与本次改动无关：`npm run test:unit` 在整机高负载并行时，`agentToolSafety.test.ts` 的 `starts and controls a captured command in the background` 会触达 2s 默认超时并连带 `after each` 的 Windows 临时目录 `EPERM` 清理失败；单独运行该文件为 105 passing，重跑全量套件亦为 2567 passing。
