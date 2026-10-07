# CWTools 核心仓库（submodules/cwtools）审查与修复交接文档

本文档记录 \`submodules/cwtools\`（独立 F# 规则内核仓库）作为**可独立运行的第三方仓库**接受的一次系统审查与两轮修复，
包括已修复项、实测证据，以及**尚未修复**的遗留项，供后续开发者或 AI 代理接续。

审查日期：2026-10-07　　审查基线：\`64638117\` → 当前 \`3584d674\`

## 仓库关系（先读这一节）

\`submodules/cwtools\` 是本项目的 Git 子模块，但**它本身是自包含的独立仓库**：

- 拥有自己的解决方案（\`cwtools.slnx\`，9 个工程）、自己的 GitHub Actions、自己的版本发布
- \`cwtools.slnx\` 中**没有任何**指向父仓库的 \`ProjectReference\`
- 测试夹具全部随仓库自带（\`CWToolsTests/testfiles\`，含冻结的 \`stellarisconfig\` 112 个文件），不是嵌套子模块
- 与父仓库的耦合是**单向**的：父仓库 \`src/Main/Main.fsproj:27\` 引用其 \`CWTools.fsproj\`，\`tools/rules-sync/stellaris-rules-sync.js:265\` 调用其 \`CWToolsCLI.fsproj\`

**已实测验证**：在 \`%TEMP%\` 下 \`git clone\` 出独立副本后 \`dotnet build cwtools.slnx\` 成功、
\`CWToolsCLI --help\` 正常、测试套件可运行。这验证了「脱离父仓库也能工作」这一前提。

> ⚠️ **不要把父仓库的规矩套到子模块上**：子模块有自己的 \`.gitattributes\`（\`* text=auto eol=lf\`）、
> 自己的 CI SDK 版本线、自己的提交节奏。跨仓库无差别修改会造成子模块工作区脏污。

## 使用方式速查

| 方式 | 入口 | 说明 |
|---|---|---|
| 作为库 | \`CWTools.fsproj\` → 构造 \`STLGame(settings)\` | 父仓库写法见 \`src/Main/GameLoader.fs:509-529\`；最小模板见子模块 \`CWToolsTests/TestHelpers.fs:41\` 的 \`emptyStellarisSettings\` |
| 作为 CLI | \`CWToolsCLI.fsproj\` | 见下节 |
| 打包发布 | \`build.cmd PackTools\` / \`build.sh\` → \`pkg/*.nupkg\` | \`CWToolsCLI\` 带 \`PackAsTool\`，装完即全局 \`cwtools\` 命令。**当前发布链断裂**，见遗留观察 P4 |

### CLI 调用铁律

**全局参数必须写在子命令前面**（Argu 的 \`[<Inherit>]\` + \`[<Last>]\` 约束），否则报错：

\`\`\`powershell
# ✅ 正确
cwtools --game stl format path/to/file.txt
# ❌ ERROR: missing argument '--game'
cwtools format path/to/file.txt --game stl
\`\`\`

**\`--directory\` 要指向游戏/mod 目录本体**（直接含 \`common\`/\`localisation\`/\`events\` 等脚本子目录的那个）。
目录分类启发式（\`FileManager.fs\` \`classifyDirectory\`）只认「自身像游戏目录」或「含 \`mod\`/\`mods\` 子目录」两种形态；
把 \`--directory\` 指到游戏目录的**父目录**会得到静默的空结果（folders 空、localisation 空、files CSV 空），无任何报错。

可用子命令：\`validate\`、\`list\`、\`parse\`、\`format\`、\`shader-abi-inventory\`、\`serialize\`。
全局参数：\`--directory\`、\`--game\`、\`--scope\`、\`--modfilter\`、\`--rulespath\`、\`--cachefile/--cachetype\`、
\`--docspath\`、\`--compression\`。\`--game\` 对所有子命令**必选**（\`CWToolsCLI.fs\` 用 \`GetResult <@ Game @>\` 读取全局参数，
含本不需要游戏模型的 \`parse\`/\`format\`）。
\`validate\` 与 \`parse\` **有新错误/解析失败时退出码为 1**，无错为 0。

### list 子命令（修复后现状）

\`list\` 是**加载可观测性**工具——\`validate\` 给结论，\`list\` 给**证据**。
可用类型：\`folders\` / \`files\` / \`triggers\` / \`effects\` / \`localisation\`（\`--sort\` 可选，目前只有 \`path\` 一种）。
\`technology\`/\`types\` 两个从未接线的死枚举已摘除，传它们会被 Argu 以未知参数拒绝（usage + 退出 1）。

**\`list files\` → \`serialize\` 两步协议（刻意设计，勿删）**：

\`\`\`text
① cwtools --game stl --directory <游戏目录> list files
     └→ 写出 cwtools-files.csv 到 **CWD**（剥掉 --directory 前缀，存相对路径），stderr 有确认行
② cwtools --game stl --directory <游戏目录> serialize metadata
     └→ CWTools/Serialization/Serializer.fs 从 <游戏目录>/cwtools-files.csv 读回，Set.union 进 metadata 缓存
\`\`\`

①写 **CWD**、②读 **\`--directory\`**，两个路径必须一致（通常在游戏目录内跑）。
CSV 的用途：\`CachedRuleMetadata.files\` → \`RulesManager.fs\` union → \`RuleValidationService.fs\` 的 \`FrozenSet<string>\` →
\`FieldValidators.fs\` 的 checkFilepathField/checkFilenameFieldNE/checkIconField，
回答「这个文件在磁盘上存在吗」且**不 stat 磁盘**。整条链路的目的是把「原版游戏目录里究竟有哪些文件」
预烘焙进缓存，让校验器在没有原版数据挂载时也能判断文件字段是否存在——与父仓库 \`hasStellarisVanillaData\`
（\`src/Main/GameLoader.fs:246\`）依赖 vanilla 目录或 \`stl.cwb\` 缓存是同一件事。

> ⚠️ \`serialize\` 的缓存类型是**位置参数**：\`serialize [--outputcachefile <f>] <full|metadata>\`。
> 不存在 \`--outputcachetype\` 标志（写了会被 Argu 拒绝）。本文档旧版曾写错，以此为准。

---

## 第一轮修复（已完成，勿重做）

### 修复 1：发布流水线 SDK 版本漂移（\`3cf9e3b7\`）

\`submodules/cwtools/.github/workflows/release.yml\` 的 \`dotnet-version\` 停留在 \`9.0.x\`，
而该仓库**全部工程**（含作为 \`build.sh\` 入口的 \`build/build.fsproj\`）都是 \`net10.0\`。
该缺陷长期未暴露，因为 \`release.yml\` 是 \`workflow_dispatch\` 手动触发，不在 PR 门禁上，
而门禁用的 \`test.yml\` 早已是 \`10.0.x\`。已改为 \`10.0.x\`。

### 修复 2：Windows 全新克隆测试失败（\`3cf9e3b7\`）

\`CWToolsTests/EmbeddedResourceTests.fs:75\` 原本用 \`String.Split(Environment.NewLine)\` 切分入库夹具
\`testfiles/embeddedtest/embedded/vanilla_files_test.csv\`，隐含假设宿主平台换行约定。
但子模块 \`.gitattributes\` 声明 \`eol=lf\`：Windows **全新克隆**下 LF 落盘切不开，整个 CSV 变成一条路径，
报出三条不存在的错误。既有工作区之所以绿，是因为它在 \`.gitattributes\` 生效**之前**检出，磁盘上仍是 CRLF。
已改为按 LF 切分 + 去 \`\r\` + 过滤空行。

> 注意：\`Tests.fs\`、\`FolderValidationTests.fs\`、\`ContractTests.fs\` 中另有 14 处 \`Environment.NewLine\`，
> 经核查**均为内存内自造字符串的自洽切分**，不涉及落盘夹具，**不要动**。

---

## 第二轮修复（2026-10-07，全部完成并推送）

三个任务按 B（无风险）→ C（中低）→ D（中高）的风险评估，在独立 worktree 并行实施，cherry-pick 回 master 后推送。

### 任务 B：README 与发布元数据失真（\`f83f4326\`）

README 曾写 \`targets .net standard 2.0\`（实际 8 个工程中 7 个 net10.0，仅 \`Shared\` 是 netstandard2.0），
且 README 贡献链接、nuspec 的 projectUrl/licenseUrl/iconUrl、fsproj 的
PackageIconUrl/PackageLicenseUrl/RepositoryUrl 全部指向上游 \`tboby\`——fork 发布的 NuGet 包会显示他人主页。
已全部对齐到 \`Aa728848\` fork；\`Authors\` 保持 \`tboby\`（署名归属事实，发布者身份由 NuGet 账号决定）。

验证除构建外，直接执行 FAKE 打包链实际调用的 \`dotnet pack\` 并解包 nupkg 逐字确认发布元数据。

### 任务 C：\`list\` 子命令输出不可用（\`e71a5dc0\`）

修复了五类问题（实测证据见「验证记录」与「list 子命令」节）：

1. **闭包 bug ×3**：\`Validator.fs\` 的 \`folders\`/\`scriptedTriggerList\`/\`scriptedEffectList\`
   把 IGame 的 \`unit -> X\` 方法存成函数值，打印 \`<fun:-ctor@...>\`。全部改为调用。
2. **\`localisation\` 空分支**：ErrorGame 新增 \`allLoadedLocalisation()\`（转发 IGame 现成的
   \`AllLoadedLocalisation()\`，返回 \`lang, file, keyCount\` 摘要），分支逐行打印。
3. **\`--sort\` 事实必选**：声明为可选却用 \`GetResult\` 读取，不带 \`--sort\` 一律退出 1。
   改 \`TryGetResult |> Option.flatten\`（\`None\` 与 \`Some Path\` 本就同分支，可选是作者本意）。
4. **\`files\` 静默写 CSV**：逻辑一行未动（是 \`serialize\` 的输入，见两步协议），仅补 stderr 确认行。
5. **\`Technology\`/\`Types\` 死枚举**：实现整段被注释、跑到即崩溃。已摘除枚举值并删除死代码，
   帮助信息随之诚实（决策：摘枚举而非补实现——补实现需先定义输出结构，属功能开发非修复）。

### 任务 D：\`parse\` 子命令崩溃（\`3584d674\`）

\`| Parse results -> failwith "subcommand"\` 导致一跑即未处理异常崩溃（退出码 \`-532462766\`）。
已接线：\`GetResult <@ ParseArgs.File @>\` 取必填参数 → \`CKParser.parseFile\` →
成功静默退出 0 / 失败 stderr + 退出 1（与 \`validate\` 退出码语义一致；\`format\` 已覆盖「看解析结果」，
\`parse\` 的独有价值是只判成败，供 CI 批量筛查）。同文件从未被调用的死函数 \`parse\` 已删除。
其余 9 个 \`failwith "subcommand"\` 是顶层 \`Arguments\` union case 的防御分支，未动。

**实现陷阱（已处理）**：\`<@ File @>\` 不加限定会被 F# quotation 按声明顺序**静默解析到 \`FormatArgs.File\`**
（两者载荷都是 string，编译报 FS0041 才暴露）。必须写 \`<@ ParseArgs.File @>\`。
\`format\` 分支的 \`TryGetResult <@ File @>\` 存在同样的声明顺序依赖（当前恰好生效，行为正确但脆弱），
留作后续收敛候选。

### 验证记录（合并后 master，\`3584d674\`）

| 检查 | 结果 |
|---|---|
| \`dotnet build cwtools.slnx\`（子模块） | 0 错误，79 警告（全在测试工程，FS0760） |
| \`dotnet test CWToolsTests/\` | 313 通过 / 0 失败 / 2 跳过 |
| \`dotnet build src/Main/\`（父仓库下游） | 0 错误 |
| 行为抽查（合并后 DLL） | folders/triggers/effects 打印真实内容；localisation 打印 \`lang, file, keyCount\`；不带 \`--sort\` 正常；technology 被 Argu 拒绝（退出 1）；parse 合法 0 静默 / 非法 1+消息；files 写 CSV + stderr 确认 |

### 提交与笔记

| 仓库 | 提交 | 内容 |
|---|---|---|
| \`Aa728848/cwtools\` | \`64638117..3cf9e3b7\` | 第一轮两个修复（SDK 漂移、LF 夹具） |
| \`Aa728848/cwtools\` | \`3cf9e3b7..3584d674\` | 第二轮三个修复（B 元数据 / C list / D parse），已推送 |
| \`cwtools-vscode\` | \`cd7bcca4..dc6b076a\` | 第一轮指针 + 两篇 Agent Note |
| \`cwtools-vscode\` | 本轮指针提交 | 指针 \`3cf9e3b7\`→\`3584d674\` + 三篇 Agent Note + 本文档 |

Agent Note（第一轮）：
- \`.agents/notes/implemented/process/2026-10-07-cwtools-release-workflow-sdk-alignment.md\`
- \`.agents/notes/implemented/bug-fix/2026-10-07-cwtools-embedded-fixture-newline-agnostic-parse.md\`

Agent Note（第二轮）：
- \`.agents/notes/implemented/process/2026-10-07-cwtools-readme-and-package-metadata-fork-alignment.md\`
- \`.agents/notes/implemented/bug-fix/2026-10-07-cwtools-cli-list-observable-output.md\`
- \`.agents/notes/implemented/bug-fix/2026-10-07-cwtools-cli-parse-subcommand-wiring.md\`

同时在 \`2026-09-09-normalize-repository-line-endings-to-lf.md\` 补了交叉链接——该笔记曾刻意把子模块排除在行尾规范化范围外，第一轮补上其未知后果。

---

## 执行纪律（必须遵守）

1. **提交顺序**：先在 \`submodules/cwtools\` 内 commit **并 push**，再在根仓更新子模块指针。
   库语义（\`cwtools\`）与规则数据（\`cwtools-stellaris-config\`）**不得混在一个提交里**。
2. **每个非平凡变更都要写 Agent Note**，按 \`.agents/notes/README.md\` 的 6 类封闭分类法
   （\`feature\`/\`bug-fix\`/\`simplification\`/\`architecture\`/\`process\`/\`testing\`），
   简体中文撰写，遵守 Owning Note 纪律（更新既有笔记优先，禁止同质化重复）。
3. **每步验证门禁**：

\`\`\`bash
cd submodules/cwtools
dotnet build cwtools.slnx          # 必须 0 错误
dotnet test CWToolsTests/          # 必须 313 通过 / 0 失败
cd ../.. && dotnet build src/Main/ # 下游集成
\`\`\`

4. **退出码判断**：即使摘要显示「失败 0」，\`dotnet test\` 仍可能返回 1
   （Expecto 的 \`[E]\` 级日志计数，如 \`trigger_docs.log was not found\`）。
   **判断成败请看摘要行，不要看 \`$LASTEXITCODE\`**。
5. 想对着活的规则仓库跑测试（而非仓库内冻结基线）时：
   \`CWTEST_STELLARIS_CONFIG=<cwtools-stellaris-config/config>\`。

---

## 遗留观察（非本次缺陷，记录备查）

- **2 个 shader baseline 用例被跳过**：需要 vanilla 4.4.6 数据，本地无该数据即跳过。
- **79 个编译警告**：全部在测试工程，全是 FS0760（\`IDisposable\` 对象用作函数值）。
- **P3 · 退出码与结果自相矛盾**：\`dotnet test\` 摘要「失败 0」但退出码 1（见执行纪律第 4 条）。
  根因是 Expecto 的错误级日志计数。修法要么在测试端做退出码映射，要么在 FAKE 层
  （\`submodules/cwtools/build/Program.fs:84\`）处理——影响面比看上去大，未处理。
- **P4 · 发布流水线断裂（任务 B 实测查明）**：\`build.cmd PackTools\` 卡在依赖目标 \`CheckFormat\`
  （全仓约 90 个 .fs 文件 fantomas 格式漂移），Test→PackLibs→PackTools 整链不动；
  且非发版上下文的兜底版本号 \`LocalBuild\` 不是合法 semver，即便格式修好本地 PackTools 仍会失败。
  另有打包弃用警告 NU5125（licenseUrl → license 表达式）与 NU5048（PackageIconUrl → 内嵌 PackageIcon）。
  整修发布链是独立议题，需单独决策。
- **P5 · \`cwtoolscli.nuspec\` 是死模板**：fsproj 无 \`NuspecFile\` 引用、FAKE 脚本不消费它，
  发布的 NuGet 包实际**没有 projectUrl**。要让包带主页需在 fsproj 加 \`<PackageProjectUrl>\`。
  任务 B 已把模板内容对齐 fork（消除两轨矛盾），但模板本身仍无人消费。
- **P6 · CLI 无行为测试宿主**：CWToolsTests 不覆盖 CLI 进程，本轮 list/parse 的验证均为手工跑 DLL
  的行为证据。要为退出码与枚举面建常驻回归需新建调用 CLI 的测试工程，成本独立评估。
- **P7 · \`ErrorGame.recompute()\` 已无调用点**（死枚举删除后），因属公开成员保留未动。
- **P8 · \`format\` 分支 \`<@ File @>\` 依赖声明顺序**（见任务 D 实现陷阱），建议后续收敛为
  \`<@ FormatArgs.File @>\`。
- **TODO 遗留若干**：\`CompletionService.fs\` 有 5 处最集中。
- 验证用临时目录仍在 \`%TEMP%\`（\`cwtools-standalone-223826\`、\`cwtools-cli-review\`、
  \`cwtools-merge-verify\`、\`cwt-verify\`、\`cwt-parse-verify\`），均为几个小文本文件。
  按仓库的**递归删除禁令**未做清理，需人工确认后自行处理。
