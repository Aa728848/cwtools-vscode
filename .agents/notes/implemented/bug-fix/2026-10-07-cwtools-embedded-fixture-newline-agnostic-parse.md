# Agent Note: CWTools 内嵌夹具解析必须与行尾约定无关

Status: implemented

## Problem
`submodules/cwtools` 的 `embedded` 测试用例（`CWToolsTests/EmbeddedResourceTests.fs`）会读取入库夹具 `CWToolsTests/testfiles/embeddedtest/embedded/vanilla_files_test.csv`，用 `String.Split(Environment.NewLine)` 切分成"原版文件清单"，再把这些路径喂给 `STLGame` 的嵌入文件设置并断言不得产生校验错误。

该切分隐含假设了**宿主平台的换行约定**。而 `submodules/cwtools/.gitattributes` 声明了 `* text=auto eol=lf`，即入库文本按 LF 规范化：

- Linux CI：`Environment.NewLine` 为 `"\n"`，恰好匹配，测试通过。
- Windows 全新克隆：夹具以 LF 落盘，而 `Environment.NewLine` 为 CRLF，`Split` 切不开，整个 CSV 被当成一条路径，测试报出 `File gfx/FX/buttonstate_onlydisable.lua not found, this is case sensitive` 等三条并不存在的错误。

该问题在 Windows 开发机上长期不可见，因为既有工作区是在 `.gitattributes` 生效之前检出的，磁盘上仍是 CRLF，`Split(Environment.NewLine)` 恰好成立。一旦换机器重新 `clone`，测试立刻变红。

实测确认因果：全新 LF 克隆下为 `失败 1`；仅把该 CSV 改回 CRLF 后为 `失败 0`。

## Decision
`EmbeddedResourceTests.fs` 读取内嵌夹具后，统一按 `\n` 切分，并剔除残留的 `\r`，同时过滤空白行：

```fsharp
(new StreamReader(f))
    .ReadToEnd()
    .Split([| '\n' |], StringSplitOptions.None)
|> Array.map (fun line -> line.Trim([| '\r'; '\n' |]))
|> Array.filter (fun line -> not (String.IsNullOrWhiteSpace line))
```

测试夹具的解析口径由此从"跟随宿主平台约定"改为"对行尾不敏感"：LF 与 CRLF 两种落盘形态产生完全相同的文件清单。过滤空白行同时消除了文件尾部换行造成的空串路径。

该修复仅作用于测试夹具解析，不改变 `CWTools` 库本身的任何解析、校验或打印行为。

## Alternatives considered
1. **回退 `submodules/cwtools/.gitattributes` 的 `eol=lf` 或为该 CSV 单独声明 CRLF**：
   - *未采纳原因*：该 `.gitattributes` 是子模块自身的行尾规范化决策（对应父仓库 [2026-09-09-normalize-repository-line-endings-to-lf.md](../../implemented/process/2026-09-09-normalize-repository-line-endings-to-lf.md) 中"子模块独立管理"的边界）。为迁就一个测试的切分口径而逆转整个仓库的行尾策略，会重新引入混合行尾，代价远大于收益。
2. **在测试里改用 `ReadAllLines`**：
   - *未采纳原因*：`ReadAllLines` 内部同样按 `\n` / `\r\n` / `\r` 识别换行并返回无换行符的字符串，行为上可行，但它会掩盖"夹具文本本身如何切分"这一事实，且需要额外重写 StreamReader 的读取方式。当前显式切分加 trim 的写法更直白，也便于后续阅读者一眼看出这里刻意做了行尾归一。
3. **在 CI 上补一个 Windows 矩阵来暴露该问题**：
   - *未采纳原因*：这是治标。夹具解析本就不应依赖平台约定，补矩阵只能更早发现问题，不能让错误的解析逻辑变为正确。当前测试流水线为 `ubuntu-latest`，保持不变。

## Consequences
- `submodules/cwtools` 的测试套件在 Windows 全新克隆下与 Linux CI 下结果一致，不再出现因工作区检出时机不同而时红时绿。
- 测试夹具不再隐式依赖 `Environment.NewLine`，后续新增同类"按行切分入库夹具"的用例有统一范式可循。
- 仓库内其余 `Environment.NewLine` 用法（`Tests.fs`、`FolderValidationTests.fs`、`ContractTests.fs`）经核查均为内存内自造字符串的自洽切分，不涉及落盘夹具，因此未做改动。
- 本次变更不触及 `CWTools` 库运行时代码，父仓库通过 `submodules/cwtools` 指针同步获得该修复。
