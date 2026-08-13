# CWT Language Support Delivery / CWT 语言支持交付文档

> - 状态:核心 MVP 已交付并完成并发/激活安全加固;Phase 3 增强项仍有遗留
> - 本档:面向后续维护者的完整交接,覆盖架构、交付清单、诊断码、测试矩阵、
>   设计决策与踩坑记录、遗留事项
> - 规划依据:[cwt-language-support-handoff.md](cwt-language-support-handoff.md)

## 1. 目标与达成状态

为 `.cwt` 规则文档提供独立、可靠、可测试的补全与验证能力。核心原则
(handoff §1)已经达成;完整分阶段规划中的增强项见第 6 节:

| 原则 | 状态 |
| --- | --- |
| CWT 文档不依赖 `game.Complete`/`game.ValidateFile` | ✅ `.cwt` 在 lint/completion/definition/references 全部走 CWT 管线 |
| 无 vanilla/游戏模型时基础诊断可用 | ✅ CWT-only mode 不构建游戏模型 |
| 语言定义来自内置元模型,不用规则自我验证 | ✅ `CwtLanguageSchema`(schemaVersion=1) |
| 本地诊断快速;跨文件用版本化、可取消、确定性快照 | ✅ 快照不可变 + 可取消防抖 + 最新请求版本门禁 + 确定性排序 |
| 候选规则验证成功才替换;失败保留 last-known-good | ✅ 所有 Error 阻断 + `CwtActivation` 状态机 + 写锁原子替换 |
| 路径/配置按不可信输入处理 | ✅ inject 路径包含性校验、真实路径枚举边界、链接循环保护 |

## 2. 架构总览

```
.cwt 文档(overlay 优先)
   │
   ├─ lint ──► CKParser ──► CWT001 族(语法/结构)
   │              │
   │              ▼
   │         CwtLanguageService.analyzeRootPublic ──► CWT1xx/CWT2xx(结构/指令/表达式)
   │
   ├─ 索引重建(didOpen/change/save/close/watcher 触发,150ms debounce)
   │      │
   │      ▼
   │  CwtProjectIndex.buildSnapshot ──► 不可变快照(version/symbols/诊断)
   │      │                                  │
   │      │                                  ├─ CWT3xx(未定义引用/重复 type)
   │      │                                  ├─ CWT4xx(inject 循环)
   │      │                                  └─ 跨文件补全/definition/references
   │      ▼
   │  CwtActivation.decideActivation ──► 写锁内 ReplaceConfigRules(仅 full mode + 匹配的 manual rules 根)
   │                                        拒绝 → CWT900;异常 → CWT901;保留 last-known-good
   └─ Completion.fs ──► CwtLanguageFeatures.complete(永不走 game.Complete)
```

### 组件归属

| 层 | 文件 | 职责 |
| --- | --- | --- |
| CWTools 子模块 | `Rules/CwtLanguageTypes.fs` | 领域类型(CwtDiagnostic/CwtSymbol/CwtReference/CwtDocumentModel/快照),命名空间 `CWTools.CwtLanguage` |
| | `Rules/CwtLanguageSchema.fs` | 版本化元模型:17 根块、23 指令、54 字段表达式族 |
| | `Rules/CwtLanguageService.fs` | 解析、语义诊断、符号/引用提取、上下文补全 |
| | `Rules/CwtProjectIndex.fs` | 快照构建、跨文件诊断、路径安全 |
| | `Rules/CwtActivation.fs` | 激活状态机(contentHash/usable/decide) |
| | `Rules/RulesParser.fs` | `parseConfigWithMetadataDetailed`;failwith→受控回退 |
| 根仓库 | `src/Main/CwtLanguageFeatures.fs` | LSP 适配、索引生命周期、激活协议、导航 |
| | `src/Main/Program.fs` | lint/补全/definition/references 路由、写锁激活 handler |
| | `src/Main/Completion.fs` | `.cwt` 补全路由(CWT-only 与 full 均不触 game) |
| | `client/extension/*` | `cwt` language id、启动模式、诊断 i18n |

## 3. 诊断码(全部已发布,稳定)

| 码 | 含义 | 严重度 | 相位 |
| --- | --- | --- | --- |
| CWT001(含 _MISSING_CLOSE_BRACE/_UNMATCHED_CLOSE_BRACE/_RECOVERY_SKIPPED_BLOCK/_STRUCTURAL_RECOVERY) | 语法/解析错误 | Error | Syntax |
| CWT101 | 未知 `##` 指令(`name = value` 形式) | Warning | Structure |
| CWT102 / CWT104 | 指令值非法 / 值形式错误 | Error/Warning | Structure |
| CWT110-112 | 根块内非法声明(types/enums/values) | Warning | Structure |
| CWT113 | 空声明名(`type[]`) | Error | Structure |
| CWT200 | 未知字段表达式 | Warning | Expression |
| CWT201 | 已知表达式族参数非法(`int[0..banana]`) | Error | Expression |
| CWT301 | 未定义引用(仅项目定义过的类别) | Warning | Project |
| CWT302 | 同文件重复 `type[x]` | Error | Project |
| CWT401 | `## inject` 循环 | Error | Project |
| CWT900 | 候选被拒,保留旧规则 | Information | Activation |
| CWT901 | 激活失败(异常) | Error | Activation |

设计要点(基于官方 Stellaris 配置实测校准,防误报):
- 重复 enum/alias/subtype 是 CWT 合法多规则写法、跨文件 type 覆盖是 mod 常规做法——**不报**
- `enum[x]` 引用同时匹配 enum 与 complex_enum 定义
- 内置豁免:scope(any/all/none/no_scope)、type(target/modifier)、value_set(项目无定义时不报)
- CWT301 只在快照就绪后发布(lint 层 pending 时静默)

## 4. 测试矩阵

| 测试 | 命令 | 覆盖 |
| --- | --- | --- |
| F# 契约 | `cd src/Main && dotnet fsi CwtLanguageService.Tests.fsx` | Phase 0 金样语料解析契约 |
| F# 语义 | `dotnet fsi CwtLanguageSemantics.Tests.fsx` | 字段表达式表、指令、符号、补全、detailed API |
| F# 索引 | `dotnet fsi CwtProjectIndex.Tests.fsx` | 快照确定性、CWT301/302/401、路径逃逸、边界 |
| F# 激活 | `dotnet fsi CwtActivation.Tests.fsx` | 根目录策略、防抖取消、CWT900、所有 Error 阻断、hash、last-known-good、修复升级 |
| 单测 | `npm run test:unit` | languageSelectors/启动判定等 |
| CWT smoke | `npm run test:cwt-lsp` | CWT-only 启动、CWT0xx/2xx/3xx 诊断、补全、definition(9 项) |
| 激活集成 | `npm run test:cwt-game-lsp` | full mode + manual rules:合法激活 epoch 递增、非法保持、修复升级(2 项) |
| 回归 | `npm test` / `npm run verify` | 游戏脚本主套件 19 项无回归、全量门禁 |

语料:`client/test/fixtures/cwt/`(金样,Phase 0)、`client/test/cwt-sample/`(CWT-only 工作区)、`client/test/cwt-game-sample/`(激活工作区)。

## 5. 关键设计决策与踩坑记录

1. **命名空间隔离(`CWTools.CwtLanguage`)**:CWT 类型若放 `CWTools.Rules` 会与既有
   `ValueType` 用例(`Enum`/`Type`)和 STLGame 的 `Legacy` 冲突,导致无关文件编译失败。
   这是排查后确定的隔离方案,后续新增 CWT 类型必须留在该命名空间。
2. **补全 textEdit 不能为 null**:F# option `None` 序列化为 `null`,vscode-languageclient
   读 `textEdit.range` 崩溃(`Cannot read properties of null`)。CWT 补全项必须生成
   `InsertReplaceEdit`(适配器 `completionEdit`,Symbol 类只替换括号内名字)。
3. **注释树文本 `##` 塌缩为 `#`**:CKParser 把 `## x = y` 存为 `# x = y`。指令识别
   按形式(`name = value` 或已知无值指令名),自由文本(如 `##Checks if ...`)不报。
4. **诊断发布语义分层**:单文件语义诊断(CWT1xx/2xx)由 lint 即时发布;项目诊断
   (CWT3xx/4xx)由快照驱动、只在快照就绪时经 lint 附加;两者都在 `buildSnapshot`
   的 `semanticDiagnosticsByFile` 中用于激活判定但不重复发布。
5. **工作区与激活边界**:CWT-only 模式索引当前规则工作区但绝不激活游戏模型;
   full mode 只索引 `rules_version=manual` 指向的 `manualRulesFolder`,且候选根必须
   与当前配置目录一致才可激活。普通游戏工作区不会因打开无关 `.cwt` 而替换规则。
   generation 取快照 version,hash 为 FNV-1a(乱序无关)。
6. **防抖、版本与门禁**:新请求会取消待执行的重建;已进入枚举/构建的旧请求仍须
   通过“版本等于最新请求”门禁。只有成功发布的最新快照可进入激活决策。
7. **阻断规则**:候选中的任何 `Severity.Error` 都会阻止激活,显式 blocker 集仅用于
   将非 Error 诊断提升为阻断项,避免新增错误码(如 `CWT102`)漏过门禁。
8. **真实路径枚举**:目录/file symlink 与 Windows junction 在递归前解析,真实目标
   必须仍位于规则根;visited real-directory/file 集阻止循环与重复扫描。
9. **测试弹窗坑**(集成测试):
   - `syncWorkspaceFileAssociations` 的 consent 弹窗会挂起测试——user settings 需
     预置全部 `*.txt/gui/gfx/asset` 关联使其 `needsUpdate=false`
   - Custom 游戏文件扫描只走 `scriptFolders`(来自 `folders.cwt`)——fixture 必须有
     `folders.cwt`;游戏脚本补全在 Custom 上不返回 enum 值(既有库限制),激活验证
     改用 **rules model epoch**(`cwtools.ai.getValidationStatus`)观察
   - LSP 补全位置越界会让服务端抛异常回退——fixture 行尾位置必须 ≤ 行长度
10. **`parseConfigWithMetadataDetailed`**:结构化 parseError,旧 API 委托保持兼容;
   `## severity` 非法值与畸形 `subtype[` 键不再抛异常。

## 6. 遗留事项与后续方向

- **Phase 3 增强项**:document symbols / workspace symbols、`## inject` 路径补全。
  这些能力不影响当前诊断、上下文补全、definition/references 与安全激活 MVP,
  但完成前不得把完整 Phase 3 标记为全部交付
- **Custom 游戏脚本补全**不返回 enum 值(既有库行为,非本工程引入);激活验证依赖
  epoch 而非补全变化
- **索引重建策略**:当前为变更触发全量重建(带版本控制),可优化为增量失效;
  快照历史未做保留(仅最新),`partial` 状态已显式
- **服务端 initializationOptions 硬性属性访问**(`opt.Item("rulesCache")` 等)对缺失
  属性抛异常——扩展总是传全,但可加固为容错读取
- **CWT001 通用消息**(`CWT syntax error: ...`)客户端未做中文增强(仅结构类变体有)

## 7. 提交与发布指引

- 子模块 `submodules/cwtools` 共 7 个文件改动(`CwtLanguageTypes/Schema/Service/
  ProjectIndex/Activation.fs`、`RulesParser.fs`、`CWTools.fsproj`):在子模块内
  先提交推送,再更新根指针(handoff §14)
- 根仓库按垂直切片提交:Phase 0(fixtures/契约)→ Phase 1(语言 id/启动)→
  Phase 2(语义/补全)→ Phase 3(索引)→ Phase 4(激活)→ Phase 5(文档)
- 发布前:`npm run verify` + `npm test` + 两个 cwt smoke;`package.ps1` 打包
  会重新发布 server 到 `release/bin/server`
- 版本号只以 `package.json`/`release/package.json` 为准,文档不复制

## 8. 验证命令速查

```powershell
dotnet build submodules/cwtools/CWTools/
dotnet build src/Main/
cd src/Main
dotnet fsi CwtLanguageService.Tests.fsx
dotnet fsi CwtLanguageSemantics.Tests.fsx
dotnet fsi CwtProjectIndex.Tests.fsx
dotnet fsi CwtActivation.Tests.fsx
cd ../..
npm run verify
npm test
npm run test:cwt-lsp
npm run test:cwt-game-lsp
npm run build:docs
npm run check:release
```
