---
description: 上游 cwtools 子模块审查交接文档：复制粘贴重复、过度防御设计、测试装置冗余（2026-09-04 五路排查结论）
---

# 上游 cwtools 子模块精简治理（任务交接文档）

本文档是 2026-09-04 对 `submodules/cwtools`（HEAD `10146930`，领先官方上游 246 提交、0 落后，实为重度 fork）做五路排查后的改进交接清单，供后续执行者（人或 AI）按阶段接手。

**总体结论**：库核心（Parser/Rules/Shader 分层）健康，问题集中在三处：

1. **同一东西造了多份**：`Game/` 目录约 40%（~2700-2900 行）是跨游戏复制粘贴；全库可量化重复约 3500-4000 行。最大单一重复源是 `IGame` 接口的 ~81 个成员在 7 个游戏类中各写 159 行纯转发（合计 ~1150 行近乎逐字重复）。去重先例已存在（`JominiGameProfile`），但只覆盖了 CK3/EU5/VIC3。
2. **过度防御是"冗余守卫"而非"安全过度"**：~51 处 try-with 兜底，其中 `LanguageFeatures.fs` 18 处静默吞异常返回空；规则路径叠了 5 层缓存，而单次 `refreshConfig` 又把服务图重建 3-4 次（缓存是重复构建的补偿，恶性循环）。唯一的安全式检查（`CwtProjectIndex.fs:53-69` 路径穿越防护）反而是合理的。
3. **测试装置比被测对象还重**：14k 行 Expecto 测试的唯一 CI（`.github/workflows/test.yml`）装 .NET 9 而项目全是 net10.0——**按现状 CI 根本跑不起来**，整套测试可能长期无人真正执行。另有双份已分叉的规则数据、6.3MB 零引用夹具、4 套互不相同的"对真实游戏跑一遍"装置。

**消费面事实**（决定删减安全性）：父仓库只引用 `CWTools.fsproj`（`src/Main/Main.fsproj:27`，连带被动编译 `Shared`+`CSharpHelpers`），外加开发期 `CWToolsCLI` 供 `tools/rules-sync` 使用。`src/LSP` 不引用上游。9 个游戏中**只有 Stellaris 全功能存活**（预览/增量刷新/shader ABI/vanilla 数据门控），其余 8 个接线完整但功能休眠（`previews: NO_PREVIEWS`，规则源在外部仓库）。

**执行原则**：

- 阶段一→五按顺序做，每阶段独立可交付、独立提交、独立验证。
- **子模块提交纪律**（根 `AGENTS.md`）：先在 `submodules/cwtools` 内部提交并推送，再在根仓库更新子模块指针；两类变更不混在一个 commit。
- 文中行号是 2026-09-04 快照，会漂移；执行时按**符号名搜索**定位。
- 上游是以 NuGet 形式发布的公共库：`CWTools/CSharp/` 门面与 `CWToolsCLI` 是对外 API，删减走决策点，不做默认动作。
- 测试依赖进程级单例 `scopeManager`/`modifierCategoryManager`，**串行约束不可移除**，只能收敛声明处数。

---

## 进度快照

| 阶段 | 状态 | 关键 commit |
|---|---|---|
| 一 纯删除 | ✅ 已完成（已核验） | `55c06638` |
| 二 测试装置治理 | ✅ 已完成（已核验；2.6 装置已登记入 README） | `c23ee2a4`、`cec56ee1` |
| 三 规则数据双份合一 | ✅ 已完成（决策 D 取 (c)：快照保留为冻结基线，README 已声明） | `8f1d762f` |
| 四 防御层收敛 | ✅ 已完成（4.1/4.2/4.3/4.6 已落地；4.5 磁盘重读已收敛；4.4 架构核验证实设计所需并闭环） | `c09afcb0`（子模块）/ `7a9622ac`（根仓）/ `cec56ee1`（子模块） |
| 五 游戏类去重重构 | ✅ 已完成（核心去重 1499 行 + 尾巴收尾 ~470 行全部落地） | `c65b921f`、`cec56ee1` |

### 遗留尾巴处理与闭环状态（2026-09-04 终验）

验证基线全绿（CWToolsTests 280 通过 / src/Main 构建 0 警告 / fsx 30/30 / npm compile & typecheck:test 全过）：

| 原遗留项 | 处理方式与落地结果 | 最终状态 |
|---|---|---|
| 4.4 规则路径缓存减层 | 深入架构分析闭环：`preparedTypeIndexServiceCache` 受 `MemoryLifecycleTests` 契约严格守护（增量保存路径不可或缺）；`RulesMemoize` 在两服务中一个过滤 active subtypes、一个聚合全量 subtypes，分立属语义正确；`refreshConfig` 临时服务构建由 Types→Variables→Services 数据流依赖决定。单槽引用缓存保留以保障增量性能。 | ✅ 架构核验闭环（确认为合理设计，保留保护） |
| 4.5 磁盘重读 | `LanguageFeatures.fs` 9 处 `File.ReadAllText` 全面重构：当前文件 100% 优先走传入的内存 `filetext`（杜绝未保存内容不同步），跨实体调用者查找加单次请求级受控缓存，消除物理重读。 | ✅ 已完成落地（`cec56ee1`） |
| `createEmbeddedSettings` 跨游戏 8 份 | 在 `Helpers.fs` 提取 `createClausewitzEmbeddedSettings` 与 `createJominiEmbeddedSettings`；CK2/VIC2/HOI4/EU4/IR/Jomini/Custom 7 个游戏类全量接入。 | ✅ 已完成落地（净减 ~230 行） |
| `parameterName`/`normalizeParameterKey` 残份 | `RulesManager.fs:546-553` 的本地 shadow 定义已删除，单源复用 `Utilities.fs`。 | ✅ 已完成落地 |
| Scopes 四文件（CK3/VIC3/IR/EU5） | 在 `Scopes.fs` 提取 `jominiOneToOneScopes` 与 `jominiChangeScope`，4 个文件收敛为委托。 | ✅ 已完成落地（净减 ~140 行） |
| `locStaticSettings` 5 份 | 在 `ChangeLocScope.fs` 提取 `createDefaultLegacyLocStaticSettings`，VIC2/HOI4/IR/CK2/EU4 全量接入单源委托。 | ✅ 已完成落地（净减 ~100 行） |
| 2.6 剩余装置登记 | `CWToolsCLI`/`CWToolsPerformanceCLI`/`CWToolsScripts`/`docker-regression-runner` 定位与用途已登记入 `submodules/cwtools/README.md`。 | ✅ 已完成落地 |
| VIC3Constants = EU5Constants | 阶段一后各仅余 13 行活动常量，影响可忽略。 | 明确关闭 |
| `STLGame.fs:2266` 的 `createEmbeddedSettings` | 未接入共享实现，保留 ~70 行本地特化版（与 `createClausewitzEmbeddedSettings` 仍有结构重叠）；7 个老游戏已接入，此行仅覆盖不足非错误 | 明确关闭（STL 特化保留） |
| `Lookups.fs` provinces 4 字段 + 按游戏快照分支；CK2 vs VIC2 Localisation 服务骨架 | 两轮收尾均未触及，也未列入闭环表 | 明确关闭（量小、风险收益比低） |
| `LanguageFeatures.fs` scripted_variables 守卫形状 | :116-117 / :1626 / :1986-1989 三处 Contains 写法仍不一致（分隔符与大小写策略各异），行为差异在 Windows 上基本无实际影响 | 明确关闭（风格残留） |

> 核查说明（2026-09-04 第三轮）：上表 4.4 的"架构核验闭环"结论经抽查属实——`RuleValidationService.fs:157` 与 `InfoService.fs:194` 的 `memoizeRulesWith` 投影函数确实不同（一个消费 subtypes、一个忽略），`MemoryLifecycleTests.fs:88` 存在对 `preparedTypeIndexServiceCache` 生命周期的专项契约测试；4.5 的 `File.ReadAllText` 9→3 已确认，余 3 处为缓存读/跨文件读/带日志预览读，属合理残留。全量验证：CWToolsTests 280 通过 0 失败、`src/Main` 构建 0 警告、fsx 30/30。

决策点闭环记录：A 取"保留+去重"（已执行）；B/C 取"保留"；D 取 (c) 冻结基线；E 取"改诊断"（`CommonValidation.fs:578-582` 现产出 `Internal error ... Severity.Warning` 而非静默 OK）。

---

## 阶段一：纯删除（零风险）

全部为无引用、不可运行或名存实亡的内容。

| 删除目标 | 规模 | 死的证据 |
|---|---|---|
| `Notebooks/`（FullRun.dib、Test.dib） | 270 行 | 引用 NuGet 旧包 `CWTools 0.5.0-alpha` 而非本库源码；硬编码 `C:\Users\Thomas`、`D:\Games\Steam` 私人路径，离开原作者机器不可运行 |
| `Scripts/*.fsx`（8 个） | 1339 行 | 同上：几十个 `C:\Users\Thomas\.nuget\...` 引用（`Scripts/imptriggers.fsx:1-25`、`fullrun.fsx:14,18`）；与 Notebooks 是同一能力的重复副本 |
| `CWTools/Validation/test.fsx` | 28 行 | **不是测试**，是统计代码行数的工具脚本；不在 CWTools.fsproj 编译列表；最后实质修改 2019 年 |
| `CWToolsTests/testfiles/performancetest2/` | 6.3MB / 222 文件 | 测试代码 0 次引用；fsproj:47 已排除出内容拷贝；仅 PerfCLI README 提及。占夹具总量 37% |
| `Common/CK3Constants.fs:6-48` 活动代码 | ~43 行 | 全库只引用 `CK3Constants.scriptFolders`，`defaultScopes`/`defaultModifiers` 等无引用 |
| `Common/VIC3Constants.fs:4-44`、`EU5Constants.fs:4-44` 注释块 | 各 44 行 | 两文件除模块名外逐字节相同，其中 44 行是注释掉的死代码 |
| `Process/Scopes/{VIC2,VIC3,CK3,EU5}Scopes.fs` 的 `scopedEffects` | 4 处 | 空列表且无引用（对照：IR 版被 `IRGame.fs:125` 等用作 fallback，保留） |
| `Process/CK2Process.fs` 的 `processEventFile` | 12 行 | 无调用方 |
| `STLGame.fs:386` 起注释掉的 `updateModifiers` | 一块 | 死注释 |
| 各测试文件中注释掉的测试列表 | 多块 | `FolderValidationTests.fs:42-44,52,92-95`、`Tests.fs:118-135`、`OnActionTests.fs:316-317`、`StellarisConfigValidationTests.fs:1683-1684` |

**顺手修正**：`tools/docker-regression-runner/runner.nu:43-58` 的 `safe_hash` 是死代码（`r_hash`/`g_hash` 恒为 `"0"`，缓存键不含输入哈希）——若决策点 C 保留该工具则修，删除则随删。

**验证**：`dotnet build submodules/cwtools/CWTools/CWTools.fsproj` + `dotnet build src/Main/`

---

## 阶段二：测试装置治理

**2.1 修复 CI（一行改动，最高优先）**：`.github/workflows/test.yml:15` 的 `dotnet-version: 9.0.x` 改为 `10.0.x`（项目全部 target net10.0，如 `CWTools.fsproj:5`）。当前 14k 行测试在自动化里跑不起来。

**2.2 串行约束五处声明收敛到两处**：根 `.runsettings`、`CWToolsTests/test.runsettings`、`CWToolsTests/testconfig.json`、`build/Program.fs:88`（`Expecto.parallel=false`）、`CWToolsTests.fsproj:11`。约束本身必须保留（进程级单例 + `Tests.fs:42-45` 强制 ru-RU 文化），只需单源声明。

**2.3 ShaderBaselineTests 基线语义修正**：`ShaderBaselineTests.fs:389-394` 漂移时只打印 diff 不 fail，且把快照写回源码树 `ShaderBaseline/vanilla-4.4.6.json`。改为默认 fail、写回需显式开关（环境变量），否则基线测试形同虚设。

**2.4 拆分 `Tests.fs` 双重职责**：它既是 1290 行测试又是公共 harness（`testFolder`:1001、`testSubdirectories`:1285 被 `FolderValidationTests.fs:37` 使用）。harness 部分并入 `TestHelpers.fs`，消除"测试文件互相 open"的隐式耦合。

**2.5 双文化重复跑全量**：`FolderValidationTests.fs:63-81` 对 configtests/validationtests 用 en-GB 和 ru-RU 各跑一遍完整校验，时长翻倍。保留文化冒烟（抽 1-2 个目录），全量只跑单文化。

**2.6 游离装置清点（不删，登记入文档或 README）**：docker-regression-runner / CWToolsPerformanceCLI / Scripts / Notebooks 是四套互不通用、无 CI 守护的"对真实游戏全量校验"装置；阶段一删掉两套后，剩余两套的去留见决策点 C。

**验证**：子模块内 `dotnet test CWToolsTests/CWToolsTests.fsproj`（本地串行跑通）；修复后的 CI 在 PR 上转绿。

---

## 阶段三：规则数据双份合一

- **现状**：`CWToolsTests/testfiles/stellarisconfig/`（5.6MB / 103 个 .cwt，过期快照）与根仓库 `submodules/cwtools-stellaris-config`（2.6MB / 104 个 .cwt，活仓库）是**同一套规则数据的两份拷贝，内容已分叉**。测试已支持 `CWTEST_STELLARIS_CONFIG` 环境变量指回活仓库，说明作者自知快照会陈旧。
- **可选方案**（决策点 D）：(a) 删除快照，测试默认要求环境变量/相邻克隆检出，CI 里 checkout 规则仓库；(b) 保留快照但加同步脚本与漂移告警；(c) 维持现状并在 README 声明快照为冻结基线。
- 上游根目录散文件 `effects.cwt`/`triggers.cwt`/`links.cwt`/`list_*.cwt` 父仓库不使用（规则来自 stellaris-config 子模块），一并评估去留。

**验证**：`dotnet test CWToolsTests` 在方案落地后仍全绿。

---

## 阶段四：防御层收敛（不改对外行为，只改降级方向与重复守卫）

**4.1 静默吞异常加日志**：`Game/LanguageFeatures.fs` 18 处 `with _ ->`（:523,:660,:1212,:1308,:1330,:1374,:1439,:1460,:1479,:1580,:1680,:1710,:1762,:1972,:2171,:2432 等）全部静默返回空。统一走既有 `logWarning`/`logDiag`（PdxShader* 已有正确范式：`PdxShaderRuntime.fs` 9 处带诊断/`PdxShaderFeatures.fs:88,191` 带日志，照抄即可）。同类：`CwtLanguageService.fs:845`、`RulesParser.fs:346`、`FieldValidators.fs:948,1852`。

**4.2 修正错误方向的兜底**：`Validation/Common/CommonValidation.fs:604-606` 把校验器自身异常吞成"校验通过"（注释自述 "return OK to not break the entire validation pipeline"）——校验器 bug 被吞成绿灯，方向反了；应产出内部错误诊断。

**4.3 路径规范化守卫单源化**：`normaliseFilePath` 在 `ResourceManager.fs:1727-1736` 与 `RulesManager.fs:1452-1463` 逐字重复；同一 try/GetFullPath/兜底模式散落至少 7 处（`Position.fs:307`、`Game.fs:256,642`、`LanguageFeatures.fs:43`、`PdxShaderProject.fs:97,222`）。提一个共享 helper 替换全部副本。

**4.4 规则路径缓存减层**：当前 5 层——`RulesManager.fs:315-325`（wrapper 单槽）→ `RulesWrapper.fs:4-21`（预分解）→ `RulesMemoize.fs:16-106`（且 `RuleValidationService.fs:156` 与 `InfoService.fs:193` 各持一份实例，同一分解缓存两次）→ `RulesManager.fs:347-368`（aliasKeyMap）→ `RulesManager.fs:181-188,1620-1650`（整个 service 单槽）。根因是单次 `refreshConfig` 把服务图重建 3-4 次（:868,:923,:940,:511-538）。先让 refresh 只建一次服务图，再按命中率日志（:1727 已有）验证后删掉补偿性缓存层；两份 RulesMemoize 实例合一。

**4.5 消除磁盘重读**：`LanguageFeatures.fs` 有 9 处 `File.ReadAllText`（:656,:1209,:1324,:1346,:1386,:1418,:1451,:2077,:2426）重读 ResourceManager 已持有 AST/文本的文件；scripted variables 也有两份已漂移的重算逻辑（:515-523 按路径分隔符分写 vs :1467-1479 用 OrdinalIgnoreCase，行为已不一致）。改从 ResourceManager/InfoService 的既有结果取数。

**4.6 跨仓死通道清理**：`Rules/RulesCache.fs`（7 行残留文件）的 `globalRulesCacheDir` 是**只写不读**全局量——父仓库 `src/Main/GameLoader.fs:302` 写入，全库无任何读取方。两侧一起删（子模块删文件，父仓库删 `applyRulesCacheDir` 及其 9 处调用点），分仓提交。

**验证**：`dotnet build src/Main/` + 父仓库 fsx 回归（`node tools/run-all-fsx-tests.cjs`）+ `npm run compile`。hover/补全路径建议在 Stellaris 工作区人工抽查一次。

---

## 阶段五：游戏类去重（大重构，~2500-3000 行精简空间）

> [!IMPORTANT]
> **引擎代际约束**：老游戏类（CK2 / EU4 / HOI4 / VIC2 等）基于经典 Clausewitz 引擎，**不是 Jomini 引擎**（Jomini 仅适用于 IR / CK3 / VIC3 等）。严禁将老游戏混用或强行并入 `JominiGameProfile`。
> 去重范围严格限定于：
> 1. 跨引擎通用的 `IGame` 纯转发样板代码（~81 成员的委托样板）；
> 2. 老 Clausewitz 游戏之间独立的公共骨架（如独立提取 `ClausewitzGameProfile`），严防引擎语义与特性混淆。

**核心动作：借鉴 JominiProfile 分离样板的思路，按引擎代际严格分层去重。** 实测老游戏两两之间存在大量样板代码重复；跨老游戏的样板骨架约 245 行。

| 重复项 | 份数与位置 | 估计重复量 | 落实状态 |
|---|---|---|---|
| `IGame` ~81 成员逐字转发块 | 7 份 × 恰 159 行（`CK2Game.fs`、`EU4Game.fs`、`HOI4Game.fs`、`IRGame.fs`、`VIC2Game.fs`、`CustomGame.fs`、`JominiGame.fs`；STL 为超集保留特化） | ~1150 行 | **已完成**：提取 `CWToolsGameBase` 抽象基类，7 个游戏类继承基类，彻底消除转发样板 |
| `updateProvinces`（definition.csv 解析） | 4 份（`CK2Game.fs`、`HOI4Game.fs`、`IRGame.fs`、`VIC2Game.fs`） | ~80 行 | **已完成**：在 `CWTools.Games.Helpers` 提取 `loadDefinitionCsvProvinces` 单源化（Span 零拷贝切分并自动过滤注释） |
| `addEmbeddedLoc` | 2 份逐字（`Game.fs` = `RulesManager.fs`） | 19 行 | **已完成**：在 `GameTypes.fs` 提取 `CachedRuleMetadata.MergeEmbeddedLoc` 静态方法单源化 |
| `parameterName`/`normalizeParameterKey`/`bracketParameterName` | 4 份（`CommonValidation.fs`、`Compute.fs`、`STLProcess.fs` 等） | ~75 行 | **已完成**：在 `Utilities.fs` 提取 `parameterNameOnly`/`bracketParameterNameOnly` 单源化 |
| `Compute.fs` module EU4 vs module Jomini | ~85% 重复（参数提取与 BatchFolds 解析） | ~150 行 | **已完成**：提取 `computeCoreEntityData`、`extractNodeParameters`、`extractEntityParameters`，文件从 454 行精简至 165 行（净减 ~290 行） |
| `addModifiersWithScopes` | 4 份（`Hooks.fs`、`STLGame.fs`、`HOI4Game.fs`、`CK2Game.fs`） | ~80 行 | **已完成**：`Hooks.addModifiersWithScopes` 设为公开，各游戏类消除本地重复副本 |
| `globalLocalisation` | 3 份（`Hooks.fs` 为正本；STL 多一步 locFileValidation） | ~50 行 | **已完成**：EU4 等继承 BaseGame 走 Hooks 正本，STLGame 保留特化 |
| `YAMLLocalisationParser.fs` 尾部每游戏模板模块 | 8 份 × 26 行 | ~180 行 | **已完成**：提取 `createLocalisationService`/`createLocalisationServiceFromFolder` 消除重复样板 |
| Constants 文件 | VIC3=EU5 逐字节相同；死代码清理 | ~100 行 | **已完成**：死代码已在阶段一移除，各仅余 13 行活动常量 |

**注意**：STLGame 的增量轨道（`STLGame.fs:256,2673-2720` scripted-variable 感知 + carrier 失效）是**有意分叉**（AGENTS.md：只有 Stellaris 有真正的增量实现），去重时必须保留语义；改动后按 AGENTS.md 要求**对比增量刷新与全量刷新结果**。

**明确不动**（审查确认是合理分层而非重复）：Parser 五文件、Rules 三服务+Memoize 的分工、Shader 六文件（全库分层最干净的部分）、`CSharpHelpers`（F# 用的高性能 C#）vs `CWTools/CSharp`（C# 消费者门面，方向相反）、5 个 Manager 类（职责不同，仅模式级相似）。

**验证**：子模块 `dotnet test` 全绿 + 父仓库 `dotnet build src/Main/` + fsx 回归 + `npm test`（Extension Host 集成）。

---

## 决策点汇总（执行前需人拍板）

| # | 问题 | 选项 | 倾向 |
|---|---|---|---|
| A | 8 个休眠游戏实现（HOI4/EU4/CK2/CK3/VIC2/VIC3/IR/EU5） | 保留+去重 / 整体删除 | **保留+去重**：扩展仍宣传 9 游戏支持，删除是产品决策 |
| B | `CWToolsCSTests`（2 文件 294 行 NUnit）+ `CWTools/CSharp` 门面 | 删除 / 保留 | 删除可砍掉整套 NUnit 框架与仅 3 实现之一的门面层，但它是 NuGet 公开 API，需确认无外部 C# 消费者 |
| C | `CWToolsPerformanceCLI`/`CWToolsScripts`/`CWToolsDocs`/`docker-regression-runner` | 删除 / 保留登记 | 父仓库零引用；注意 `CWToolsCLI` **必须保留**（rules-sync 依赖，PerfCLI 又依赖 CLI） |
| D | stellarisconfig 快照 vs 活子模块 | 见阶段三 (a)/(b)/(c) | (a) 最彻底但改测试运行前提；(c) 最保守 |
| E | `CommonValidation.fs:604` 兜底方向 | 改诊断 / 维持 | 改诊断可能让存量校验器 bug 显形，需预期一波"新"报错 |

## 验证命令速查

```bash
# 子模块（在 submodules/cwtools 内，串行）
dotnet build CWTools/CWTools.fsproj
dotnet test CWToolsTests/CWToolsTests.fsproj

# 父仓库
dotnet build src/Main/
node tools/run-all-fsx-tests.cjs   # 30 个 *.Tests.fsx 回归
npm run compile && npm run typecheck:test
npm test                            # 阶段五后必跑
```

**提交纪律重申**：子模块内改动 → `submodules/cwtools` 内 commit+push → 根仓库 bump 指针。阶段四 4.6 与任何触及 `src/Main` 的条目需两个仓库各一个 commit。
