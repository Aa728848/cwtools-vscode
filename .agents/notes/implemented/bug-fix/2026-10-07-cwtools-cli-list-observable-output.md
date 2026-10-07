# Agent Note: CWToolsCLI list 子命令输出可用化

Status: implemented

## Problem
`list` 是 CWToolsCLI 的加载可观测性入口——`validate` 给结论，`list` 给证据（写规则、调路径前缀、排查补全缺失时依赖它）。审查实测其多处输出不可用：

1. `folders`/`triggers`/`effects` 打印 `<fun:-ctor@...>` 闭包而非内容：`Validator.fs` 的 ErrorGame 把 `game.Folders`/`ScriptedTriggers`/`ScriptedEffects` 这三个 `unit -> X` 方法（`GameTypes.fs` 的 IGame 抽象）以 `member val` 存成了函数值。
2. `localisation` 分支是 `| ListTypes.Localisation -> ()`：静默返回 0，无法区分「没加载」与「功能缺失」。
3. `--sort` 声明为可选（`Sort of ListSort option`），实际用 `GetResult` 读取导致任何不带 `--sort` 的 `list` 都报 `missing argument '--sort'` 退出 1。
4. `files` 静默把 `cwtools-files.csv` 写进 CWD，无提示无文档。
5. `Technology`/`Types` 枚举值声明了但实现整段被注释，跑到即 `failwith` 未处理异常崩溃，帮助信息误导。

## Decision
子模块提交 `e71a5dc0`（`fix(cli): make list subcommand output observable`）：

- 三处 `member val` 改为调用（`game.Folders()` 等），保留 `member val` 形式，调用点不变。
- ErrorGame 新增方法风格成员 `member __.allLoadedLocalisation() = game.AllLoadedLocalisation()`（延迟求值，与 `validationErrorList()` 同风格；IGame 已有该抽象，返回 `lang, file, keyCount` 摘要），`localisation` 分支逐行打印。
- `--sort` 改 `TryGetResult |> Option.flatten`：`| None | Some ListSort.Path ->` 本就同分支，证明可选是作者本意。
- `files` 写 CSV 的**逻辑一行未动**，仅补一行 stderr 确认（写明写到 CWD、`serialize` 从 `--directory` 读回、两者必须同目录）。
- 摘掉 `Technology`/`Types` 死枚举并删除整段注释死代码，`| _ -> failwith "Unexpected list type"` 防御分支保留；帮助输出随之诚实。
- README 新增 `### CWToolsCLI list` 双语小节，写明 files→serialize 两步协议。

**关键保护项**：`list files` 写 CSV 不是随手副作用，而是 `serialize metadata` 的预烘焙输入——`Serializer.fs` 从 `--directory` 读回并 union 进 `CachedRuleMetadata.files`，经 `RulesManager.fs` 进入 `RuleValidationService` 的 `FrozenSet<string>`，供 `FieldValidators.fs` 的 checkFilepathField/checkFilenameFieldNE/checkIconField 在不 stat 磁盘的情况下回答「这个文件存在吗」。删除该副作用会破坏缓存模式下文件字段校验。

**一并纠正的文档错误**：缓存类型是 `serialize` 的**位置参数**（`serialize <full|metadata>`），此前文档写的 `--outputcachetype Metadata` 标志形式会被 Argu 拒绝；README 与 stderr 提示均按真实语法书写。

## Alternatives considered
1. **删除 `files` 写 CSV 的副作用、改为打印到 stdout**：否决。CSV 是 `serialize metadata` 的输入（链路见上），删除会破坏功能；真实缺陷只是无提示，用 stderr 确认解决。
2. **补实现 `Technology`/`Types`**：否决。需先定义「Types 输出什么结构」，是功能开发而非修复；摘枚举让 CLI 参数面诚实，代价是被摘的两项从帮助中消失。
3. **保持 `--sort` 事实必选、只改文档**：否决。`None` 与 `Some Path` 同分支证明可选是原设计意图，一行 `TryGetResult` 即恢复，行为收益大于文档妥协。
4. **`allLoadedLocalisation` 用 `member val` 立即求值**：否决。方法风格延迟求值与 `validationErrorList())/`localisationErrorList()` 一致，避免构造期即固化本地化目录。

## Consequences
- `list` 的全部存活类型（folders/files/triggers/effects/localisation）输出真实证据；`--sort` 恢复可选；`technology`/`types` 被 Argu 以未知参数拒绝（usage + 退出 1）而非崩溃。
- `ErrorGame.recompute()` 在死代码删除后已无调用点，因属公开成员予以保留。
- 本仓库没有 CWToolsCLI 行为测试宿主（CWToolsTests 不覆盖 CLI 进程），本次验证为手工跑 DLL 的行为证据；若要为退出码与枚举面建常驻回归，需新建 CLI 测试工程，留作后续。
- 父仓库通过子模块指针同步获得该修复。
