# Agent Note: CWToolsCLI parse 子命令接线

Status: implemented

## Problem
`parse` 子命令的定位是单文件语法体检：不加载游戏模型、不读配置目录，只调 `CKParser.parseFile`，服务于 CI 批量筛查或本地排除语法嫌疑（与需要完整 game 模型的 `validate` 形成对照）。

实际上它从未接通：`CWToolsCLI.fs` 的 `GetSubCommand` 分发里 `| Parse results -> failwith "subcommand"`，任何 `parse` 调用以未处理异常崩溃（退出码 `-532462766`）。同文件 :486 附近还存在一个定义了但从未被调用的死函数 `parse`（返回 `(bool * string)` 表达「能否解析 + 失败原因」），证明作者有此设计意图但没接完线。

## Decision
子模块提交 `3584d674`（`fix(cli): wire parse subcommand to CKParser`）：

- 删除死函数（grep 确认无调用方；全仓其余 `parse` 命中均为 `PdxShaderSyntax.parse`/`DocsParser.parseDocs`/测试局部函数，无关）。
- 分发处直接接线：`parseResults.GetResult <@ ParseArgs.File @>` 取必填主命令参数（`[<MainCommand; ExactlyOnce; Last>]` 保证缺失时 Argu 自行报错，故用 `GetResult` 而非 `TryGetResult`），`CKParser.parseFile` 成功则静默退出 0，失败则 `eprintfn` 解析消息后退出 1——与 `validate` 的退出码语义一致（有错 1、无错 0）。
- 其余 9 个 `failwith "subcommand"` 分支（Directory/Game/Scope/ModFilter/CacheFile/CacheType/RulesPath/Compression/DocsPath）原样保留：它们是顶层 `Arguments` union case 的防御分支，只有畸形输入才可能落入。

**实现期发现并处理的陷阱**：`<@ File @>` 不加限定会**静默解析到后声明的 `FormatArgs.File`**（两者载荷都是 string，F# quotation 引用按声明顺序取后者，编译报 FS0041 揭示真实类型）。必须写 `<@ ParseArgs.File @>`。同一脆弱点存在于 `format` 分支的 `TryGetResult <@ File @>`（恰好生效的是 FormatArgs.File，行为正确但同样依赖声明顺序），本次按范围纪律未动，留作收敛候选。

## Alternatives considered
1. **成功时打印解析结果或摘要**：否决。`format` 已覆盖「看解析结果」；`parse` 的独有价值是「只判成败」，静默 + 退出码才能无噪声地嵌入 CI 批量筛查。
2. **顺手让 `--game` 对 `parse`/`format` 可选**：否决。`main` 里 `results.GetResult <@ Game @>` 使所有子命令都被迫要求 `--game`；改它要动全局默认值，属独立行为变更，记录为已知限制而非夹带修改。
3. **保留死函数并调用它**：否决。它返回元组需要调用方再拆，直接在分发处 match 更直白；保留死代码只会继续误导。
4. **为退出码契约新建 CLI 进程测试工程**：未采纳。仓库无 CLI 行为测试宿主，接入成本超出修复范围；本次以手工跑 DLL 的实际输出作为验证证据（合法文件退出 0 静默；语法错误退出 1 并带解析消息；`format` 回归正常）。

## Consequences
- `parse` 从「一跑即崩溃」变为可用的 CI 语法筛查入口，退出码语义与 `validate` 对齐。
- CLI 剩余 `failwith "subcommand"` 分支均为防御性死代码，再无真实可达的崩溃路径。
- `format` 分支 `<@ File @>` 的声明顺序依赖与 CLI 测试宿主缺失，成为记录在案的后续收敛项。
- 父仓库通过子模块指针同步获得该修复。
