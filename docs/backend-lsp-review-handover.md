# 后端与 LSP 协议层审查报告 + 执行交接方案

> 审查日期:2026-06-06。审查对象:`src/LSP/`(协议层,约 2900 行)、`src/Main/`(后端实现,约 2.9 万行,其中 Program.fs 占 1.3 万)、约 30 个 `*.Tests.fsx` 测试脚本,以及与 `client/extension/`、`submodules/cwtools` 的跨层重复。
> 所有结论均已按 文件:行号 抽查核实。本文档既是审查报告,也是分阶段执行交接方案:每个阶段给出具体操作、风险与验证命令,可由任意工程师或 AI 按序接手。

## 总体判断

代码骨架(手写 JSON-RPC 栈 → 分发循环 → cwtools 库)移植自 fsharp-language-server 原型后,叠加了约三轮"性能/可观测性/AI 命令"攻坚,每层各自合理但从未回头清理。**死特性、双份实现、为测试而生的抽象层约占 src/LSP 总量的 1/4~1/3;Program.fs 中机械重复的命令样板约 700-900 行(全文 6-7%)**。

不存在"后端重新实现上游 cwtools 库"的问题(PosHelper/Serialize/Parser 均为薄适配或互补);问题集中在 F# 内部自我重复、F#↔TS 双份手写漂移、防御性死代码、测试脚手架复制。

---

## 一、最严重发现 Top 10(按风险排序)

| # | 发现 | 位置 | 类别 |
|---|------|------|------|
| 1 | `responseAgent` 超时清理只删 Map 不 Reply,`PostAndAsyncReply` 等待方(如 ApplyWorkspaceEdit)**永久挂起泄漏** | src/LSP/LanguageServer.fs:247-274, 299-309 | 真实 bug |
| 2 | `"[[CANCEL]]"` 魔法字符串当跨层控制流信号,编进序列化后的 JSON 响应,5 处字符串比较;真实响应撞串即误判取消 | src/LSP/LanguageServer.fs:509-510, 718, 857, 868 | 设计失误 |
| 3 | 诊断分类启发式 **F#/TS 两份完整实现**:9 类目、子串判断、repairHint 文案、提取正则逐字相同,无任何同步机制;类目清单在 TS 侧第三次硬编码 | src/Main/Program.fs:2732-2831 vs client/extension/ai/tools/diagnosticMetadata.ts:17-143 | 双份构造(已漂移风险高) |
| 4 | `cwtools.ai.*` 响应形状双份手写且**已实际脱钩**:TS `QueryTypesResult` 声明了 F# 从不发送的 `subtypes`,缺 `line`/`vanilla`/`ok` | src/Main/Program.fs:11409-11445 vs client/extension/ai/types.ts:490-498(148 个手写 interface) | 双份构造 |
| 5 | `cwtools.*` 命令名清单 F# 内 3 处 + TS + MCP 各 1 处,**已漂移**:6 个命令(analyzePdxFlow/exploreInlineGraph/queryLocalisationAudit/compareDefinitionWithVanilla/getAllDiagnostics/revalidateFiles)已分类但未通告,严格客户端会拒绝 | src/Main/Program.fs:7020-7066 vs src/LSP/LanguageServer.fs:520-576 vs Program.fs:11395+ | 双份构造 |
| 6 | override winner 解析两份、**同名同串不同语义**(LIOS 时 SemanticGraph 偏好 workspace,ProjectKnowledge 取 tryLast);`RuntimeMetadata` 六字段记录两处完全相同 | src/Main/ProjectKnowledge.fs:848-881, 31 vs src/Main/SemanticGraph.fs:587-616, 24 | 双份构造(语义分歧) |
| 7 | "Phase 0 可观测性"脚手架 ~300 行固化在协议热路径:每请求 10 字段可变追踪记录 + 6 字段计时子记录 + 每 100ms heartbeat 线程 + 13 指标线程池采样,产出仅是自定义 `monitorLog` 通知;`ioThreads` 等字段计算后从未输出(纯死字段) | src/LSP/LanguageServer.fs:46-104, 322-401; src/LSP/Locking.fs:69-120 | 过度设计 |
| 8 | PrepareRename / Rename 逐字重复 ~200 行(10 个局部 helper 各写两遍) | src/Main/Program.fs:9106-9294 vs 9296-9689 | 双份构造 |
| 9 | 路径归一化 **≥6 份实现、3 种大小写语义**:F# 用 ToUpper、cwtools/TS 用 lowercase、另有 ~20 处内联 `replace(/\\/g,'/')` 绕过 pathScope;无同步机制 | src/Main/PathIdentity.fs:13; src/LSP/DocumentStore.fs:11; submodules/cwtools/CWTools/Rules/CwtProjectIndex.fs:36; client/extension/pathScope.ts:12 等 | 双份构造 |
| 10 | 手写 JSON 栈(Tokenizer/Parser/Ser 共 718 行,含静默产出非法 JSON 的深度守卫、字节/字符混算的分帧 hack)**零测试**;而 138 行测试给了锁计时琐事 | src/LSP/Ser.fs:86-87; src/LSP/Tokenizer.fs:62-72; src/LSP/Locking.Tests.fsx:73-100 | 测试错配 |

## 二、分类清单

### A. 相同的东西构造了好几份

F# 内部:
- 事件 AST 遍历两份逐行对应(phaseOf/conditionPath/subjectFromNode/collectEventCalls):PdxFlowAnalysis.fs:387-574 vs ProjectKnowledge.fs:1407-1736
- 资源表(`game.AllFiles()` → path/logicalPath/overwrite/scope)建两遍 + `configuredLoadOrderForFile/Path` 逐行相同:SemanticGraph.fs:488-494, 110 vs ProjectKnowledge.fs:347-373, 440
- `convRangeToLSPRange` 与 `toLspRange` 逐行相同;`filePathToUri` 两份且行为不同(拼字符串 vs Uri):LanguageServerFeatures.fs:32, 47 vs CwtLanguageFeatures.fs:278, 282;另有 `int x.StartLine - 1` 内联散落 Program.fs 6+ 处
- `GraphTypes.fs` 全文(91 行)是 CWTools `GraphDataItem` 的逐字段翻版,全仓仅 Program.fs:11107-11128 一处使用;SemanticGraph.fs:171 `nodeJson` 又把同数据序列化第三遍
- `SymbolIndex.fs:9-12` 重复定义 Position/Range(与 LSP.Types 仅大小写不同),导致 Program.fs:2037-2041 手工逐字段转换
- `isDynamicExpansionDiagnostic` vs `isDynamicParameterError` 同一判定两份:DiagnosticMerge.fs:24-32 vs Program.fs:2859-2864
- `monitorLog` 双重实现(完全相同的 JSON 发往同一方法):src/LSP/LanguageServer.fs:311-320 vs src/Main/Program.fs:1009-1019
- ExecuteCommand 3300 行内:JSON 参数访问 helper 逐字重定义 ~8 次(9781/11626/11705/11804/11842/11894/12552,而 shader 系 9856 已共享一套);severity→string 6 处(10614 与 12590 逐字相同);createVirtualFile 通知样板 8 处;"读打开文档否则读磁盘" 9 处;`try FileInfo(x).FullName with _ -> x` 8 处;coverage/freshness JSON envelope 手抄 ~10 处(SG:410/652/663、InlineGraph:708/789、PK:826/3205/3427 等)
- 10 游戏(STL/HOI4/EU4/CK3/…)枚举全文件 ~12 处:dispatcher(1863)、fieldClearers(1878)、vanillaPathMap(1914)、Initialize 两处 match(6900/6920)、gameConfig(5911)、load match(6283)、publish 校验(6431-6456)、`gameName` 同函数内两遍(11936/12035)
- 刷新脏状态跟踪 5 套并存(1567/3055/3139/3046/1485 + RefreshCoordinator);缓存失效 5 套并存(内容 hash+LRU / TTL / count-clear-all / Epoch+SingleFlight / locCache),且缓存 key 空间不统一(LocalPath vs FullName)迫使 `clearFileCaches`(2300)每缓存删两种 key

跨层(F# ↔ TS ↔ cwtools):
- LOCALISATION_CODES 双份(两侧有"keep in sync"人工注释,但 TS 侧注释指针仍指向 Program.fs,代码已搬到 DiagnosticMerge.fs):DiagnosticMerge.fs:36-40 vs diagnosticI18n.ts:525-531
- 缓存文件名 `stl.cwb/hoi4.cwb/…` 双份:src/Main/Serialize.fs:15-23 vs client/extension/gameProfiles.ts:528-550
- 诊断消息翻译表(diagnosticI18n.ts 663 行)按 CW 码+英文正则镜像 cwtools Validation.fs 文案,属设计使然但无自动校验,消息改措辞翻译静默失效
- TS 侧还有一批 PDX 解析的跨语言重实现(pdxTokenizer/workspaceSymbolParser/locParser/guiParser),属"客户端索引为 AI 工具服务"的刻意架构,但 ARCHITECTURE.md 未写明权威次序(应以服务器为准)

### B. 过度冗余设计 / 死代码

src/LSP:
- 整块死掉的"服务器→客户端"类型化通道:`ServerNotification`/`ServerRequest` 两个 DU 从未被构造(Types.fs:826-842);`WatchKind`/`RegisterCapability`/`Registration*` 整块未启用(Types.fs:795-817);`serializeRegistrationParams`/`serializeLoadingBarParams`/`serializeGetWordRangeAtPosition`/`serializeCreateVirtualFileParams` 四个序列化器只有定义没有调用(LanguageServer.fs:209-222);`RealClient.RegisterCapability` 无调用方(436-446)。Main 实际走 `CustomNotification` + 手写 JsonValue.Record——同一 wire format 两条并行路径,类型化路径完全闲置
- no-op 桩的完整六层表面积:WillSaveTextDocument/WillSaveWaitUntil/RangeFormatting/OnTypeFormatting/DidChangeWorkspaceFolders/ResolveDocumentLink(Program.fs:7416-7421, 9102-9104, 8692)每个都消耗"类型+Raw 类型+解析器+序列化器+接口成员+分发分支";其中 `optionsMap` 字段(Types.fs:378/383/389)每次请求构造 Map 但**全仓零读取方**;`InitializeParams.trace` 同理
- 杂项死代码:`defaultInitializeParams`(Types.fs:184-190)、`parseDiagnostic`(Parser.fs:222)、`MarkedString` 旧版遗产体系(Types.fs:616-635,Main 始终用 MarkupContent)、4 个不可达 writer(Types.fs:109-122)、`ExecuteCommandResponse = JsonValue` 无信息量别名(Types.fs:406)、`FSharp.Collections.ParallelSeq` 包引用零使用(LSP.fsproj:21)、`runReadLocked` 仅被测试引用(Locking.fs:182-188)、CSharpExtensions 49 行取词函数独占一个 C# 项目

src/Main:
- `GuardVector`/`CommitPlan`/`tryApplyCommitPlan`/`mergeLocalisationDiagnosticReplacements`/`assertWithinCommitBudget` 生产零调用,仅被 .Tests.fsx 引用,且 `GuardVector` 与 `RefreshCoordinator.Ticket` 是同构纪元概念的第二份实现:RefreshLockPhases.fs:250-322, 111
- `nonincrementalLocalisationGuard` 恒为 None → 其后 ~56 行 match 死代码,连同 RefreshLockPhases.fs:91 helper 传递性死亡:Program.fs:4837, 5104-5159
- `getValidationStatus` 三处分发,Program.fs:12912 的 match 臂不可达(9827 已拦截;第三处在 LanguageServer.fs:733)
- 11 处已在 `| Some game ->` 分支内又 `match gameObj` 并带不可达 None 分支("LSP server not ready" ×12);重读 mutable 槽位还导致两个引用可能不一致:Program.fs:11219/11404/12176/12252 等
- `discardPreparedWorkspace`(6462)空体 no-op 被 4 处调用;`getSTLVanillaPath`(1910)、`parseUri`(6879)、`MonitorLogKind.Cache`(957)死代码;注释残留 3665、6961-6968、10960、13032
- `PdxFragmentValidation.fs`(5 行)与 `CompletionFallbackPolicy.fs`(13 行)各占一文件一测试,存在理由仅是 .fsx 用 `#load` 加载;后者还带被忽略的 `_validationInProgress` 哑参数
- `DiagnosticMerge.preserveWhilePending`(92)恒等函数,Program.fs:3166/3193 两处调用为纯噪音
- `FileDiagnosticState.version` 恒等于 `validatedVersion`(1368-1369, 2984);`DefinitionInjectionKeyInfo` 中 `keyStart==modeStart`、`keyEnd==targetEnd` 恒等(336-345)
- `sendDiagnostics` helper(3031)仅用 1 次,其余 9 处直接调 `client.PublishDiagnostics`——helper 形同虚设
- Completion.fs 内部:`paramExtractPattern`(22)与 `macroParamPattern`(40)正则串相同;`varExtractPattern`(17)与 LanguageServerFeatures.fs:21 重复;`getLineAt`(53)重复 CompletionText.fs:42
- `processRequest` 中 None 的三种序列化约定并存(LanguageServer.fs:490-515);`thenMap`/`thenSome` 是 Async.map 重复造轮子(403-409)

### C. 过度安全设计 / 防御性隐患

- Ser.fs:86-87:序列化深度 ≥20 时返回 `fun _ -> ""`,静默产出**非法 JSON**——要么抛异常要么不检查,空串是最差选项
- Tokenizer.fs:62-72 `readLength`:注释自认"should never be exercised"的空白跳过 hack,且把解码后字符数与原始字节数混算,非 ASCII 首字符会截断 body;`parseHeader` 三 case 只用 Content-Length
- Parser.fs:120:error 响应被吞成 `ResponseMessage(id, JsonValue.Null)`,客户端拒绝 workspace/applyEdit 时服务器无感知;Parser.fs:152 `"exit"` 分支不可达(流层面已截断)
- DocumentStore.Change 的 double-checked TryGetValue(135-138)防御一个不存在的并发者(DidOpen/DidChange 在 processQueue 单消费者线程串行)
- 单文件 6 种并发机制并存(ReaderWriterLockSlim/Lock/MailboxProcessor/2×ConcurrentDictionary/BlockingCollection);`gameStateWriterActivityCount` vs `gameStateWriterActiveCount` 双计数器,后者仅供 tracing;`pendingRequests` 与 `requestTraces` 同键两本账应合并
- `tryTerminalizeRequest(tryClaim, emit)` 三层泛型间接(Locking.fs:21-45)存在的唯一理由是让 fsx 测试不依赖 BinaryWriter
- `lint` 内 `lintSnapshotStillCurrent()` 检查 ~8 次,叠加 requestGeneration+文档版本+modelEpoch+admission+game identity 五重 guard
- `with _ -> ""`/`with _ -> None` 吞错误 ~20 处(外层已有 catchError:6863);SemanticGraph.fs:359 静默吞一切异常(违反 AGENTS.md"不静默吞错");Git.fs:67-78 嵌套 catch+递归重试,恢复分支只认 `origin/master`(71)与主流程接受 main|master(52)不一致
- `getEntityInfo` 手写 10 槽 `Option.orElse` 链且外层 `_g` 未用(12529-12538),`gameDispatcher`(1860)就是为此存在

### D. 过度测试 / 测试脚手架重复

- **无共享测试 helper**:断言 helper 4 种方言(check/equal/assertEqual/assertTrue/throws)逐字复制到 ~20 个文件,含结尾 summary/exit-code 块整段复制
- `ProjectKnowledge.Tests.fsx` 内同一份 19 表 SQLite schema 复制粘贴 3 遍(162-181/248-267/354-386,~120 行 DDL),已开始漂移(graph_version 7/7/6,第三份拆出 inlineTables);insert helper 也 3 份
- **源码字符串 grep 式测试 ~160 行**:RefreshLockIntegration.Tests.fsx:290-332, 369-390, 424-439 与 WorkspacePublication.Tests.fsx:125-155 对同一段 Program.fs 做近乎相同的 required/forbidden 文本匹配——重命名局部变量即假失败;ProjectKnowledge.Tests.fsx:25-38 对源码做正则计数
- `RefreshLockIntegration.Tests.fsx:392-419` 测的是 BCL 的 ReaderWriterLockSlim 和测试自己的 mock,生产零覆盖
- RefreshLockPhases.Tests 与 RefreshLockIntegration.Tests 纯函数断言重叠 ~40 行(tryApplyCommitPlan/resolvePreparedCommitOutcome/MeasureCommitScope 三组,Phases 多为超集);`guard` helper 两边各一份
- CwtLanguageService.Tests(Phase 0)与 CwtLanguageSemantics.Tests(Phase 2)大面积重叠:同一 fixture 语料、harness、corpusRoot/readFixture 逐字复制;Service 独有价值仅 fixture 漂移守卫/inject 拼接/jomini metadata
- 琐碎/恒真断言:CwtProjectIndex.Tests.fsx:86 `check ... (true)`;CwtLanguageSemantics.Tests.fsx:193-194 两行断言表达式完全相同(复制后忘改)
- DiagnosticMerge.Tests.fsx:1-9 本地 stub 假 LSP.Types 再 `#load` 真实现——真类型加字段时 stub 静默漂移,应改 `#r LSP.dll`
- ProjectKnowledge.Tests.fsx:466-480 在回归脚本里做 p95 <250ms 硬断言,CI 抖动风险,应移到 tools/perf/ 或只打印不断言
- 覆盖重叠可接受(有意双层):fsx 快单元 + client/test 慢 E2E 对 CWT 码的同码断言;但 Phase 0 的 Service.Tests 是第三层,可裁
- 13 行实现配 34 行测试(CompletionFallbackPolicy)、5 行实现配 32 行测试(PdxFragmentValidation,其中还在测上游 CKParser 行为)——比例失衡源于"文件为测试而存在",随 B 类合并一并处理

### 合理、不建议动的部分

- 手写 JSON-RPC 栈整体自洽可用(问题只在零测试与个别守卫),重写为 System.Text.Json/StreamJsonRpc 收益不抵风险
- 刷新/锁/诊断三家族理论边界清晰;DiagnosticInvalidation/SymbolIndex/CwtActivation 等测试比例合理
- `scanBraceIssuesWithPrefix`(Program.fs:3332)是 CKParser 失败时的位置补充,互补非重复

---

## 三、执行交接方案(分 6 阶段,按"风险低 → 收益大"排序)

每阶段完成后运行对应验证命令再进下一阶段。通用验证:

```bash
dotnet build src/LSP/ && dotnet build src/Main/
# .fsx 回归脚本:在各脚本所在目录运行(节选,改动到哪个模块跑哪个)
cd src/Main && dotnet fsi RefreshLockPhases.Tests.fsx && dotnet fsi ProjectKnowledge.Tests.fsx
cd ../src/LSP && dotnet fsi DocumentStore.Tests.fsx && dotnet fsi Locking.Tests.fsx
# 涉及 TS 侧(阶段 4/5)再跑:
npm run compile && npm run typecheck:test && npm run test:unit
# 全量闸门(阶段收尾):
npm test   # 含 completion/hover/folding/extension 集成套件;需 Stellaris vanilla 数据或 stl.cwb
```

### 阶段 0:纯删除(零风险,预计 -800~-1000 行)

1. 删 src/LSP 死代码:ServerNotification/ServerRequest DU(Types.fs:826-842)、WatchKind/Registration 整块(795-817)、4 个死序列化器(LanguageServer.fs:209-222)、`RealClient.RegisterCapability` 调用面(436-446)、`defaultInitializeParams`、`parseDiagnostic`、MarkedString 体系(Types.fs:616-635)、4 个不可达 writer、`optionsMap` 字段及其解析(Types.fs:378/383/389 + Parser.fs:255-258)、`InitializeParams.trace`、`runReadLocked`(Locking.fs:182-188,同步删测试引用)、LSP.fsproj 的 FSharp.Collections.ParallelSeq
2. 删 src/Main 死代码:GuardVector/CommitPlan/tryApplyCommitPlan 等(RefreshLockPhases.fs:250-322, 111,同步从两个 .Tests.fsx 删对应用例)、nonincrementalLocalisationGuard 死分支(Program.fs:4837, 5104-5159 + RefreshLockPhases.fs:91)、getValidationStatus 不可达 match 臂(12912)、discardPreparedWorkspace no-op 及 4 处调用(6462)、getSTLVanillaPath/parseUri/MonitorLogKind.Cache、preserveWhilePending 及两处调用
3. 删冗余字段:FileDiagnosticState.version、DefinitionInjectionKeyInfo 恒等字段、`ioThreads`/`maxIoThreads` 死字段、writerActiveCount 计数器
4. 删测试:CwtProjectIndex.Tests.fsx:86 恒真断言、CwtLanguageSemantics.Tests.fsx:194 重复断言、RefreshLockIntegration.Tests.fsx:392-419(BCL 测试)
- 风险:仅 `.fsx` 的 `#load` 顺序可能受影响;逐文件构建确认。
- 验证:`dotnet build` 两个项目 + 受影响 .fsx 全过。

### 阶段 1:修真实 bug(高优先)

1. **responseAgent 泄漏**(LanguageServer.fs:247-309):Expire 分支向 channel `Reply` 超时哨兵(如 JsonValue.Null + 日志),让 PostAndAsyncReply 等待方正常结束;补一个"超时后等待方返回"的 .fsx 用例。
2. **`[[CANCEL]]` 魔法字符串**:`processRequest` 改为返回 `Choice<string, RequestTerminalCause>`(或 SemanticTokens 处理器返回显式取消标记),在 `terminalizeRequest` 单点转换,删 5 处字符串比较(509-510/718/857/868);同时统一 None 的三种序列化约定(490-515)。
3. **Ser.fs 深度守卫**(86-87):深度超限改抛异常(或记录并截断为合法 JSON);**Tokenizer readLength**(62-72)删空白跳过 hack;**Parser.fs:120** error 响应至少记日志。
4. **SemanticGraph.fs:359** 吞异常改记日志;**Git.fs:67-78** 恢复分支复用主流程分支名单。
5. **Program.fs 11 处 Some 分支内重复 match gameObj**(11219/11404/12176/12252 等):直接用外层 `game`,删 12 个不可达 "not ready" 分支。
- 验证:build + Locking/DocumentStore/LanguageServer.Terminal .fsx + `npm test` 全量。

### 阶段 2:提取共享 helper(收益最大、风险低)

1. **新建 `src/TestHelpers.fsx`**(断言 4 方言统一 + 临时目录 + harness + summary/exit 块),~25 个测试文件各删 5-15 行。DiagnosticMerge.Tests.fsx 改 `#r LSP.dll` 删 stub。
2. **ProjectKnowledge.Tests.fsx 内**提取 `createKnowledgeSchema connection` + `insertMetadata`,删 ~100 行重复 DDL(注意三份已漂移,以生产 schema 为准)。
3. **Program.fs 命令样板**:JSON 参数访问 helper 提为模块级(照抄 shader 系 9856 那套),统一 severity→string、`readDocumentText`(读打开文档否则磁盘)、`fullPathOr`(FileInfo.FullName 兜底)、`showVirtualFile`(createVirtualFile 通知 ×8)、coverage/freshness envelope。预计 -500 行。
4. **PrepareRename/Rename** 10 个局部 helper 上提为 Server 级私有 helper,-200 行。
5. **sendDiagnostics** 要么全用要么删掉(9 处直调改为走 helper)。
- 验证:build + 全部 .fsx + `npm test`。

### 阶段 3:合并重复实现(需要判断语义分歧)

1. **override winner 解析合一**(ProjectKnowledge.fs:848-881 vs SemanticGraph.fs:587-616):先确认 LIOS 语义分歧哪个正确(对照 cwtools 上游 overwrite 规则),合并为单一 resolver 放共享模块;`RuntimeMetadata` 提为共享类型删一份。
2. **GraphTypes.fs 删除**:Program.fs:11107-11128 直接复用 SemanticGraph 的 nodeJson(或 CWTools GraphDataItem 映射)。
3. **LspConvert 模块**:合并 convRangeToLSPRange/toLspRange/filePathToUri 两份 + 吸收 PosHelper.fs,替换 Program.fs 内联 `int x.StartLine - 1`;SymbolIndex 改用 LSP.Types.Position/Range,删逐字段转换(Program.fs:2037-2041)。
4. **PathOps 收口**:F# 侧以 PathIdentity 为唯一实现(DocumentStore.fs:11 私有副本通过项目引用消除,或把 PathIdentity 移到 LSP 工程);区分"比较键(折叠大小写)"与"显示路径(不折叠)"两类函数;Program.fs 41 处散落 Replace 逐步收编。**跨层大小写方向差异(F# ToUpper vs TS lowercase)写进 ARCHITECTURE.md**,并统一 SemanticDelta.fs:70/InlineGraph.fs:125 的目录约定常量。
5. **EventAstWalk 共享模块**:抽 PdxFlowAnalysis 与 ProjectKnowledge 的事件遍历,两侧只做投影。
6. **isDynamicExpansionDiagnostic** 抽 `(code -> message -> relatedMessages -> bool)` 纯函数放 DiagnosticMerge,Program.fs:2859-2864 适配调用。
7. **微文件合并**:PdxFragmentValidation(5 行)+ CompletionFallbackPolicy(13 行,删 `_validationInProgress` 哑参数)+ PathIdentity + PosHelper 并入 PureDecisions 之类单模块;CSharpExtensions 49 行并入 DocumentStore.fs 后删 C# 项目与 ProjectReference。
- 验证:build + 受影响 .fsx + `npm test`;3.1 需与上游行为对照(可用 `dotnet fsi CwtLanguageBaseline.fsx` 基线)。

### 阶段 4:跨层单一事实来源(F# ↔ TS)

1. **诊断分类启发式**:服务器现在总是附带 `data`(Program.fs:2790-2850),把 TS 回退 diagnosticMetadata.ts:82-143 缩减为仅 `unknown` 兜底(优先方案);若必须保留,把类目+正则+hint 表做成 JSON 由一侧生成。删 diagnosticMetadata.ts:17-34 第三次硬编码。修正 diagnosticI18n.ts:525 过时注释指针。
2. **命令清单单一来源**:F# 侧建一张 `(name * isReadOnly)` 表驱动能力通告(Program.fs:7020-7066)、isReadCmd(LanguageServer.fs:520-576)、dispatch 三处;补齐 6 个未通告命令。MCP 侧按 AGENTS.md 流程:`npm run generate:mcp-schema` → submodule 内 `npm run build && npm run test:contracts` → 提交推送 submodule → bump 根指针 → 发版。
3. **cwtools.ai.* 响应契约**:二选一——(a) 加真实服务器契约测试(fixture 服务器逐命令校验 TS interface 键集,现有 MCP 契约测试只跑 mock 不够);(b) F# 侧定义响应记录类型并生成 JSON Schema/d.ts。至少先修 QueryTypesResult 脱钩(types.ts:490-498)与 ValidationStatusSnapshot 全可选字段(types.ts:2003-2035)。
4. **LOCALISATION_CODES / 缓存文件名**:加单测断言两侧集合相等;缓存文件名改由服务器 initialize 结果下发。
- 验证:`npm run compile && npm run typecheck:test && npm run test:unit` + MCP 契约流程 + `npm test`。

### 阶段 5:结构性收敛(大改,单独 PR)

1. **10 游戏枚举 ×12 处**:收敛为单一 `PreparedTypedGameRefs option` + 一张 game→名字/loader 表(Program.fs 1860-1930 区、6900/6920、5911、6283、6431-6456、11936/12035)。
2. **刷新脏状态 5 套 → Tracker+Coordinator 两套**,字符串域改 DU;**缓存失效 5 套**统一 key 空间与失效框架(clearFileCaches 不再删两种 key)。
3. **tracing 子系统收敛**(LanguageServer.fs:46-104, 322-401 + Locking.fs:69-120):feature flag 门控或收敛为"慢请求单行日志",删 heartbeat 线程;pendingRequests 与 requestTraces 两账合一;monitorLog 删 LSP 层私有实现改走 ILanguageClient.CustomNotification;`tryTerminalizeRequest` 泛型间接内联(测试改经 LSP.dll 公共表面)。
4. **CSharpExtensions 项目下线**(若阶段 3.7 未做)。
- 验证:全量 `npm run verify` 前手动重点测:大工作区 lint 取消、规则热重载、增量刷新(对照全量刷新结果,见 AGENTS.md 增量刷新约束)。

### 阶段 6:测试重组

1. 合并源码 grep 式测试到单一 "source invariant" 文件(RefreshLockIntegration:290-332/369-390/424-439 + WorkspacePublication:125-155 + ProjectKnowledge:25-38),或改行为测试;删 Phases↔Integration 重叠的纯函数断言 ~40 行。
2. CwtLanguageService.Tests 裁至 parser/corpus 契约(~120 行),其余交给 Semantics;删/并 PdxFragmentValidation.Tests;合并两个 Completion 微测试。
3. **补 src/LSP JSON 栈测试**:Tokenizer 分帧(含非 ASCII)、Ser 转义/深度、Parser round-trip 与畸形输入——这是当前风险最高且零覆盖的 718 行。
4. ProjectKnowledge.Tests:466-480 p95 断言移到 tools/perf/ 或只打印。
- 验证:全部 .fsx + `npm test`。

## 四、预估收益与风险

| 阶段 | 预计缩减 | 主要风险 |
|------|---------|---------|
| 0 | -800~-1000 行死代码 | 极低,.fsx `#load` 顺序 |
| 1 | 修 1 个泄漏 + 1 个控制流隐患 | 中,取消语义需实测 VS Code 客户端 |
| 2 | -700 行样板 | 低 |
| 3 | -400 行 + 消除 3 处语义分歧 | 中,override 语义需对照上游 |
| 4 | 消除 4 处跨层漂移源 | 中,MCP 发版流程跨仓库 |
| 5 | 结构性减负(难量化) | 高,务必小步提交 |
| 6 | -400 行测试 + 补齐 718 行高危零覆盖 | 低 |

**给接手者的三条忠告**:① 每阶段独立 PR,Program.fs 改动用 `git diff --stat` 控制在审阅友好范围;② 涉及 Stellaris 增量刷新的改动(阶段 5)必须对照全量刷新结果(AGENTS.md 明示);③ 不要顺手"重写 JSON 栈/换 StreamJsonRpc"——自洽可用的旧代码重写收益不抵风险,补测试即可。

---

## 复核记录(阶段 0–4 落地后,2026-06-06)

复核方式:三路并行核对清单 + 关键结论人工复验 + 全量验证(`dotnet build` LSP/Main 0 错误、服务器 initialize 实测、29/29 .fsx 通过、`npm run compile` 通过)。

### 复核中发现并已修复的两个缺陷(工作区未提交)

1. **P0 启动崩溃(已修复)**:阶段 0 删除"死 writer"时误删了活写入器 `writeTextDocumentSyncKind` 的注册(`src/LSP/LanguageServer.fs` customWriters),而 `ServerCapabilities.change: TextDocumentSyncKind` 是纯 DU、Ser.fs 无 union 序列化路径,模块急求值初始化即在 Ser.fs:168 抛 `TypeInitializationException`,**服务器进程启动即崩**。"build 全绿 + fsx 全过"天然抓不到反射期失败。修复:恢复该 writer 注册(1 行),实测 initialize 正常返回。
   - 教训:阶段 6 补 JSON 栈测试时应包含 `serializerFactory<InitializeResult>` 构造即断言的 smoke 测试。
2. **测试失败被静默 PASS(已修复)**:`src/TestHelpers.fsx` 的 `TestHarness.Summary()` 返回 int 但脚本未接 `exit`,实证 `dotnet fsi` 丢弃脚本末尾值(末尾 `1` 仍 exit 0)。4 个 harness 制脚本(CwtActivation/CwtProjectIndex/CwtLanguageService/CwtLanguageSemantics)断言失败时进程仍 exit 0,新 runner `npm run test:fsx` 纯靠 exit code 判定。该缺陷重构前就存在(旧脚本末尾 `if failures = 0 then 0 else 1` 同样无效),重构原样保留并被 runner 放大。修复:Summary() 失败分支改 `exit 1`(1 行),实测失败探测脚本 exit=1,4 个 harness 套件真实通过。

### 阶段落地评分

- **阶段 0**:删除清单基本全部落地(grep 无残留);代价是上述 P0。另有 3 个真死 writer 定义残留(Types.fs:47/70/476,全仓 0 调用)。
- **阶段 1**:responseAgent 泄漏修复正确(Expire 现 Reply Null,单循环无新竞态)但**超时测试未补**;`[[CANCEL]]` 五处全消、改显式 `RequestResult` DU ✅,但引入 3 处新死代码(外层 `fixedLockFallback` 被内层同名遮蔽、2 个未使用 Option 序列化器);Ser 超限改返回 "null"(合法但静默,未按方案记录日志);Tokenizer 空白跳过 hack 未删(改为字节安全版,注释已过时);Git.fs 恢复分支仍内联复制未复用新 helper。
- **阶段 2**:TestHelpers/schema 提取/PrepareRename/fullPathOr/showVirtualFile/freshness ✅;残留:JsonArgs 只接线 3 处(还有 ~5 处内联)、`severityName` 仍逐字两份(Program.fs:10368 vs 12244)、readDocumentText 内联残留 ~12 处、runner 无每脚本超时。
- **阶段 3**:OverrideResolver 合一(语义裁决与上游 ResourceManager.fs:687-713 一致 ✅,注意三处行为变化:SG 报 cwtools_single_active、PK 文案换措辞、极端 load-order 下 LIOS 命中变化)、GraphTypes.fs 删除 ✅、isDynamicExpansion 合一 ✅、CSharpExtensions 下线(F# 移植比旧 C# 更安全)✅;**未做**:EventAstWalk(事件遍历仍两份,PdxFlowAnalysis:130/431/489 vs ProjectKnowledge:1440/1452/1462/1512,另有 InlineGraph:229 第三份)、Completion.fs 内部三处重复、SymbolIndex Position/Range 重复(有 Struct 比较阻力)、normalizePath 仍 4 份 lowercase 副本、ARCHITECTURE.md 未写跨层大小写约定、filePathToUri 合并对 CwtLanguageFeatures 有低风险行为变化(去 GetFullPath/转义)。
- **阶段 4**:Commands.fs 单一表驱动通告+isReadCmd ✅、6 个漂移命令补齐 ✅、LOCALISATION_CODES 双向相等测试 ✅、MCP 无需同步 ✅;**残留**:①通告 ⊋ dispatch,4 条幻影命令无处理器(`cwtools.exportTypes` 前缀别名、`typeGraphInfo`、`getDataForFile`、`getTypesForFile`,后 3 条是本次新增,TS 侧零调用,建议从 Commands.fs 删除);②TS classifyDiagnosticFallback 未缩减,另发现 agentTools.ts:3089-3104 第三套 regex 启发式与 3321-3342 第四处分类字面量硬编码;③QueryTypesResult 幽灵字段 `subtypes` 仍在、ValidationStatusSnapshot 仍全可选,响应形状仍无运行时/schema 级校验(新增契约测试只是静态 regex 扫描且只测 ⊆);④缓存文件名防漂移靠测试而非服务器下发。

### 给阶段 5/6 的增量忠告

- 每完成一个子项,除 build + fsx 外,**必须实测一次服务器 initialize**(本次 P0 的教训:反射期失败只有运行期能抓)。
- `npm run test:fsx` 现可信任(exit code 已修复);建议给 runner 加每脚本超时。

---

## 终审记录(阶段 0–6 全部落地后,2026-06-06)

全量验证:`dotnet build` LSP/Main 0 错误、TS compile + typecheck:test 通过、**30/30 .fsx 通过**(新增 JsonRpcProtocol.Tests.fsx)、服务器 initialize 冒烟正常。

### 终审中又发现并修复一个回归(工作区未提交)

3. **publish 丢失 `languages` 更新(已修复)**:阶段 5(192c0215)收敛 10 游戏槽位时删掉了 publish 路径的 `languages <- prepared.languages`(旧 Program.fs:6431),导致该字段只剩 DidChangeConfiguration 一个写入点;游戏切换/初始发布时 `languages` 为旧游戏解析结果或空,`getOrBuildLocMap`(Program.fs:1976)的多语言优先级合并失效(hover/inlay 本地化管理退化为默认解析),直到下一次配置变更。伴随症状:`PreparedWorkspace.languages` 沦为只写死字段。已在 publish(Program.fs:6401)恢复该行,build + initialize + 相关 fsx 全过。当时同步放宽的两个源码断言测试(WorkspacePublication/RefreshLockIntegration)恰好放过了这个遗漏——源码 grep 式测试的固有弱点再次实证。

### 阶段 5 评分(192c0215)

- ✅ unified active requests:requestTraces+pendingRequests 两账合一为 activeRequests,取消/超时/终止门语义经逐路径核对保持。
- ✅ cache key 空间统一:normaliseCachePath 幂等,读写闭环一致;残留 locCache 裸 key。
- ⚠️ 10-game slots:存储收敛为单一 `PreparedTypedGameRefs` ✅ 且 publish 新增引用一致性校验;但 game→名字/loader 表未做,10/11 臂枚举点几乎没降(gameName 仍逐字两遍),并附带上述 languages 回归。
- ❌ 刷新脏状态 5 套整项未动;tracing 只收敛一半(heartbeat 已删、两账合一;monitorLog 双份、tryTerminalizeRequest 泛型间接、计时脚手架仍在)。

### 阶段 6 评分(5a3821f9 + cec87896)

- ✅ JsonRpcProtocol.Tests.fsx:非 ASCII 分帧、转义、畸形输入、**`serializerFactory<InitializeResult>` 构造即断言 smoke(P0 教训已落实)**。
- ✅ 幻影命令 4 条删除,注册表与 dispatch 双向核对一致。
- ✅ 死 writer/死序列化器清理正确(writeTextDocumentSyncKind 不删是对的);severityName/readDocumentText 残留已收口。
- ✅ p95 硬断言改打印;runner 加 60s 每脚本超时 + 自动发现。
- ⚠️ EventAstWalk 半成品:phaseOf/conditionPathOf 已统一且等价;但 `subjectFromNode` 仍 3 份语义分歧实现,且新模块引入 3 个 0 调用死函数(subjectFromNode/isConditionBranchKey/isBranchConditional,语义与现存任何一份都不同,误接即改行为);模块体异常缩进。
- ❌ 测试重组主体未做:源码 grep 式测试仍在 3 个文件原位、Phases↔Integration 重叠断言未删、CwtLanguageService.Tests 未裁、PdxFragmentValidation/Completion 微文件微测试未并——提交信息声称 "complete phase 6" 名不副实。

### 收口清单(供后续小步跟进,按优先级)

1. EventAstWalk:删掉 3 个 0 调用死函数,或完成 subjectFromNode 三方统一(先裁决语义)。
2. responseAgent 超时测试(连续两轮复核未补;修复在 LanguageServer.fs:244-252,零覆盖)。
3. Tokenizer readLength 截断风险(跳字节后只读 byteLength-1)+ Ser.fs:86 超限静默 "null" 无日志;新测试恰好都没覆盖这两处。
4. 散项:normalizePath 4 份 lowercase 副本、types.ts `QueryTypesResult.subtypes` 幽灵字段、agentTools.ts:3089-3104 与 3321-3342 两套硬编码、ARCHITECTURE.md 跨层大小写约定、SymbolIndex Position/Range 重复、JsonArgs 2 处内联(Program.fs:11410/11509)、Git.fs 恢复分支 helper 复用、微文件合并。
5. 测试重组主体(阶段 6 A1/A2)。

### 总结

六阶段累计:删死代码/重复约 2600+ 行,修复 1 个泄漏 + 1 个控制流隐患,命令表/override resolver/缓存 key/请求生命周期等核心重复已收敛,测试基建(TestHelpers + runner + JSON 栈覆盖)从无到有。三轮复核共抓出 3 个落地期引入的缺陷(2 个 P0 级:启动崩溃、测试静默通过;1 个窄回归:languages),均已当场修复。**遗留均为低优先级卫生项,无阻塞性问题;当前工作区 1 个未提交修改(Program.fs languages 修复),建议提交后收尾。**
