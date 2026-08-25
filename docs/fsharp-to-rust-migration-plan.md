# CWTools F# 到 Rust 全项目迁移执行方案

> 状态：实现已迁移至 Rust，验收仍在进行。本文基于根仓库、三个一级 Git 子模块，以及 `cwtools-mcp` 内嵌规则子模块的静态审计。
>
> 本文保留迁移执行历史；实现现状和最终证据要求见 `docs/rust-migration-acceptance.md`。实施进度以各阶段交付物和门禁为准；已落地项目使用 `[x]` 标记，未完成项目使用 `[ ]` 标记。
>
> 核心策略：**兼容优先、绞杀式迁移、F#/Rust 双跑差分、按门禁切流、随时可回退；禁止一次性重写。**

## 1. 执行摘要

本项目的 F# 后端不是一个可直接翻译的语言服务器，而是两层语义平台：

- 根仓库 `src/LSP/` 与 `src/Main/`：52 个 F#/FSX 文件，约 25,766 行；
- `submodules/cwtools/CWTools/`：107 个 F# 文件，约 43,980 行；
- `submodules/cwtools/CWToolsTests/`：17 个 F# 测试文件，约 10,947 行；
- 上游 CLI、文档、性能工具、维护脚本另约 3,000 行。

完整迁移实际包含：LSP transport、文档覆盖层、Paradox parser/domain tree、CWT 规则解释器、scope、localisation、validation、workspace/index、多个游戏模型、Shader、缓存、CLI 与兼容 API。真正困难的是 CWTools 语义与增量一致性，而不是 JSON-RPC framing。

### 1.1 目标定义

迁移分为两个可发布终点：

1. **中期终点：Rust LSP host + F# semantic worker**。Rust 接管 stdio、JSON-RPC、取消、生命周期和部分纯功能，语义请求仍可代理到 F#。
2. **最终终点：纯 Rust 后端**。Rust 覆盖 parser、rules、validation、game model、Shader、cache 和全部 LSP/MCP 命令，VSIX 不再携带 .NET runtime。

正式目标应是第二种，但第一种是降低风险、持续发布和验证工具链所必需的中间架构。2–4 人团队建议按 12–18 个月规划；单人建议按 18–30 个月规划。日期不是切换依据，阶段门禁才是。

### 1.2 必须保持不变的外部契约

- LSP/JSON-RPC 2.0 over stdio 与 `Content-Length` framing；
- 迁移期二进制目录和默认名称：`release/bin/server/<rid>/CWTools Server[.exe]`；
- initialize/config key、game id、capabilities、semantic token legend；
- 全部 `workspace/executeCommand` 命令名、参数、结果和错误 JSON；
- `cwtools.ai.getValidationStatus` 的 readiness、epoch、freshness 语义；
- diagnostics、completion、URI、UTF-16 Position/Range 语义；
- CWT DSL、重复 key、`##` 指令、规则热替换、last-known-good、CWT900/901；
- MCP bridge/standalone 和只读安全约束；
- 编码/BOM、路径大小写、规则 ZIP、vanilla/mod/DLC 覆盖顺序。

### 1.3 不应机械保留的内部结构

Rust 不应逐文件翻译 F#，也不应复制进程级 singleton、反射 serializer 和 1.2 万行组合根。目标设计围绕三个稳定边界：

1. **Syntax boundary**：字节或文本 → loss-aware CST → 有序 domain edit；
2. **Catalog boundary**：CWT/config/docs → immutable RuleCatalog + ScopeUniverse + GameProfile；
3. **Snapshot boundary**：workspace resources → immutable semantic snapshot，以 prepare + epoch-checked commit 更新。

---

## 2. 当前系统和仓库边界

### 2.1 运行时拓扑

`client/extension/` 启动并监督语言服务器；Webview 只通过 Extension Host 消息通信。F# server 通过 stdio LSP 提供 Paradox、CWT 和 Shader 语义。独立发布的 MCP 默认通过扩展 bridge 复用 LSP，也可 standalone 启动同一 server binary。

| 仓库或目录 | 当前职责 | Rust 迁移动作 |
| --- | --- | --- |
| 根 `src/LSP/` | JSON-RPC/LSP、DTO、DocumentStore、调度、锁 | 迁至 Rust LSP binary；先代理 F#，后接 Rust engine |
| 根 `src/Main/` | feature、命令、加载、诊断、增量状态、知识图谱 | 按纯模块→查询→写状态→游戏加载迁移 |
| `submodules/cwtools/` | parser、rules、validation、scope、localisation、game、Shader、cache | 在该独立仓库建立 Cargo workspace |
| `submodules/cwtools-stellaris-config/` | Stellaris CWT 规则数据 | 不改格式，作为真实 conformance corpus |
| `submodules/cwtools-mcp/` | npm MCP、bridge、standalone host | 保持 TS，只适配平台和 discovery contract |
| MCP 内嵌规则子模块 | standalone 测试和开发规则 | 与根规则指针做同步验证 |
| `client/extension/` | server 发现、进程管理、LSP client、bridge | 增加 implementation flag 和回退 |
| `package.ps1`、CI、`release/` | 三平台构建和 VSIX | 过渡期双产物，最终改 Cargo build/sign/package |

子模块仍保持独立所有权：先在 `submodules/cwtools` 或 `submodules/cwtools-mcp` 内提交、测试和发布，再更新根指针。规则数据和引擎代码不得混成一个提交。

### 2.2 根 F# 后端模块

`src/LSP/`：

- `Tokenizer.fs`、`Parser.fs`：stdio framing 与 JSON-RPC method routing；
- `Types.fs`、`Ser.fs`：LSP DTO 和 wire JSON 形状；
- `DocumentStore.fs`：open-document overlay、版本、增量 edit、line-offset cache；
- `Locking.fs`、`LanguageServer.fs`：read/write/lock-free 分类、取消、队列、fallback、反向请求；
- `Log.fs`：stderr logging，避免 stdout 污染。

`src/Main/`：

- `Program.fs`：具体 `ILanguageServer`、所有 LSP handler、自定义命令和状态机；
- `GameLoader.fs`：rules/cache/vanilla/mod 与多游戏构造；
- `CwtLanguageFeatures.fs`：CWT-only、project index、candidate activation；
- `Completion*.fs`、`SemanticGraph.fs`、`InlineGraph.fs`、`PdxFlowAnalysis.fs`：编辑器和 AI 语义；
- `ProjectKnowledge.fs`：SQLite knowledge export/query；
- `SemanticDelta.fs`、`DiagnosticMerge.fs`、`OverlayValidation.fs`：增量、诊断所有权和受限验证。

### 2.3 CWTools 核心依赖层

自底向上为：

1. path/range/string intern/game constants；
2. Paradox CST parser 和规范化 printer；
3. `Node/Leaf/Child/ValueClause` 可编辑 domain tree；
4. CWT parser、schema、Rule IR、project index、activation；
5. workspace/FileManager/ResourceManager/Compute/Lookup；
6. rules validation/info/completion、scope、localisation；
7. ValidationManager、RulesManager、LocalisationManager；
8. `IGame` 和 `GameObject` facade；
9. Custom、Jomini、传统游戏、Stellaris adapter；
10. cache、Shader、CLI、文档、C# facade。

高风险全局状态包括 `StringResource.stringManager`、`scopeManager`、file index table、全局 glob 选项、logger 和若干无界 memo cache。Rust 内部应改成 session/snapshot ownership，但兼容 shim 需要保持可观察行为。

### 2.4 规则和 MCP 子模块

- Stellaris config 是 Paradox 风格 CWT DSL，不是 JSON Schema；当前约 108 个 `.cwt/.log` 文件。
- MCP 是 Node/TypeScript npm workspaces：`cwtools-shared` 提供协议/schema/host contracts，`cwtools-mcp` 提供 transport、bridge 和 standalone LSP host。
- MCP schema 从根 TS tool definitions 生成，不能手改 `generated/mcpTools.ts`。
- 默认 MCP bridge 不关心实现语言；standalone 对 binary 名称、目录、initialize payload 和 readiness 有强契约。

---

## 3. 兼容契约清单

Phase 0 必须把本节转为机器可执行 contract；没有 contract 不得大规模替换。

### 3.1 Wire protocol 与生命周期

- stdout 只能输出 `Content-Length: N\r\n\r\n<payload>`；日志只能进 stderr；
- 支持 `initialize → initialized → shutdown → exit`、stdin EOF、`$/cancelRequest`；
- 保持 server→client request 和 response correlation；
- 保持 `--stdio` 与 `CWTOOLS_SERVER_INSTANCE_ID`；
- restart/force-kill 后无孤儿进程；
- malformed header、无效 JSON、截断 UTF-8、超大 frame 必须受控失败。

Rust LSP 框架应先做 spike。若现成框架妨碍特殊调度、readiness lock-free 或 wire parity，应使用自建薄 transport，不能为框架改变协议。

### 3.2 初始化与配置

冻结 initialization options：`language`、`uiLanguage`、`isVanillaFolder`、`rulesCache`、`bundledRulesPath`、`rules_version`、`defaultRepoPath`、`repoPath`、`diagnosticLogging`。

冻结 game id：`stellaris`、`hoi4`、`eu4`、`ck2`、`imperator`、`vic2`、`ck3`、`vic3`、`eu5`、`cwt`、`paradox`。冻结 `stellarisLanguageServices` 配置、watch patterns 和 full/cwt-only/none 启动模式。

### 3.3 标准 LSP

覆盖 document sync、completion/resolve、hover、signature、definition/references/highlight、symbols、code action/lens、inlay hints、links、format、rename、semantic full+delta、folding、selection、call hierarchy。semantic token type/modifier 顺序是整数 ABI，禁止重排。completion trigger 当前为 `. | $ =`，并须保持 insert/replace capability 分支。

### 3.4 自定义命令和通知

建立 command manifest，覆盖：

- `cwtools.ai.*` 的 scope、completion context、types/definition、graph/flow/localisation、knowledge、catalog/overlay、scripted services、diagnostics/readiness/revalidate/fragment、Shader 查询；
- `cwtools.findTypeReferences`、`cwtools.exportTypes`、`typeGraphInfo`、`getFileTypes`、`getDataForFile`、`getTypesForFile`；
- legacy rules/cache/code-edit 命令。

manifest 应生成或校验三处：server advertise、read/write effect 分类、TS/MCP contract。迁移期间继续对照 `src/LSP/LanguageServer.fs` 的 `isReadCmd`。

冻结自定义通知：`loadingBar`、`debugBar`、`createVirtualFile`、`promptReload`、`forceReload`、`vanillaCacheGenerated`、`cwtools/serverReady`、`promptVanillaPath`、`updateFileList`、`monitorLog`、`cwtools/validationComplete`、`completionRefresh`。

### 3.5 Parser、domain、rules 语义

- LSP Position/Range 使用 UTF-16 code unit；内部 byte offset 必须精确转换；
- token 字符集含大量特殊符号和 Unicode；保存 9 种 operator；
- `yes/no` 大小写敏感；前导零数字保留为 String；支持 int64/decimal；
- escaped quote/backslash、comment、nested/unclosed clause 的错误位置不漂移；
- printer 会规范化空格、Tab、换行，不是普遍 lossless printer；应比较规范化输出和语义 CST，而不是任意输入字节一致；
- `ProcessCore.BaseProcess` 的三项滑窗会识别 ValueClause 和带 KeyPrefix/ValuePrefix 的 Node，不得简化为普通 key/value tree；
- `AllChildren` getter 返回副本；`SetTag` 替换首项，缺失时头插；
- PosKeyValue 相等忽略 range，裸 Statement.Value 包含 range；
- lower token 存在 current-culture `ToLower()` 历史行为，不能在迁移时顺手统一；token ID 仅在所属 manager 内有效；
- Rule IR 的 alias/subtype/cardinality/severity/scope/quote/dynamic type/conditional parameter、展开顺序和 diagnostics 都是契约；
- 旧 parse API 的失败降级空模型与新 detailed API 的结构化错误分别保留；
- Stellaris scripted expansion 的现有硬编码深度/轮次上限应按入口锁定，不能改为无界 fixed point。

### 3.6 文件、路径和 localisation

- CP1252、UTF-8、BOM、CRLF/LF；
- YAML、CK2 CSV、VIC2 CSV 与语言列；
- Windows case handling 和 POSIX case handling；当前内部行为不完全一致，不在迁移中顺手修正；
- URI 编解码和 slash normalization；
- root/mod/vanilla/DLC/zip/embedded 的发现和覆盖优先级；
- PLS metadata、command scope、recursive alias 上限。

### 3.7 缓存和持久化

旧 `.cwb` 是 FsPickler 对象图，还会恢复全局 string/file tables，Rust 不应承诺直接解析。策略：

1. 迁移期由受控 F# converter 读取旧 cache，导出版本化中间格式；
2. Rust 新格式包含 magic、schema、game id、rules/config hash、source fingerprint、compression；
3. 解析失败安全回退 full rebuild；
4. 至少一个稳定版本保留 converter，再依据使用率移除。

`ProjectKnowledge` SQLite schema/manifest/freshness 单独版本化，不与 game cache 合并。

---

## 4. Rust 目标架构

建议在 `submodules/cwtools` 建 Cargo workspace，根仓库只放下游 LSP adapter/binary。

| crate | 职责 |
| --- | --- |
| `cwtools-source` | SourceId、encoding、byte/UTF-16 line index、Range、路径策略 |
| `cwtools-intern` | session-owned string arena、normal/lower token、metadata |
| `cwtools-script-syntax` | lexer/parser/CST/operator/comment/rgb/hsv/规范化 printer |
| `cwtools-domain` | Node/Leaf/Child/ValueClause、三项滑窗转换、有序 edit/trivia |
| `cwtools-scope` | ScopeUniverse、ScopeContext、Effect/link、change-scope |
| `cwtools-localisation` | YAML、CK2/VIC2 CSV、encoding |
| `cwtools-localisation-semantics` | legacy/Jomini command、PLS、依赖校验 |
| `cwtools-cwt-syntax` | CWT syntax、directive、单文件 meta-model、project index |
| `cwtools-rules-ir` | TypeDefinition/NewField/Options/immutable RuleCatalog |
| `cwtools-rules-engine` | alias/subtype/cardinality/field validation/info/completion |
| `cwtools-workspace` | root/mod/vanilla/DLC/zip/embedded、glob、覆盖、I/O trait |
| `cwtools-index` | resource/type/enum/ref/var/localisation index、fingerprint、delta |
| `cwtools-validation` | validation stages、cache、diagnostic、cancellation |
| `cwtools-game-core` | GameSession facade，对齐 `IGame` 能力 |
| `cwtools-game-clausewitz` | CK2/VIC2/EU4/HOI4 共享能力 |
| `cwtools-game-jomini` | IR/CK3/VIC3/EU5 共享能力 |
| `cwtools-game-stellaris` | Stellaris 超集和增量特例 |
| `cwtools-shader` | syntax/preprocess/HLSL/project/runtime/features |
| `cwtools-cache` | 版本化 cache 和旧格式 import DTO |
| `cwtools-protocol` | custom LSP/MCP wire DTO 与 schema version |
| `cwtools-ffi-dotnet` | 过渡期 .NET/C# facade 或 worker IPC |
| 根 `cwtools-lsp` | stdio JSON-RPC、DocumentStore、调度、server adapter |

### 4.1 并发模型

- `Arc<SemanticSnapshot>` 提供无锁或短读锁查询；
- writer 在 snapshot 外 prepare，以短写锁或原子 swap commit；
- commit 比较 base epoch/hash，陈旧结果丢弃并重试或 full fallback；
- document overlay 独立同步，不被长 game rebuild 阻塞；
- cancellation token/epoch 贯穿 parser→validation→index，取消时结果整体丢弃；
- 外部集合显式 stable sort；限制并发、cache、文件数和输入大小。

### 4.2 推荐依赖原则

可评估 `serde/serde_json`、`tokio`、`parking_lot`、`indexmap`、`globset`、`petgraph`、`rusqlite`、`encoding_rs`、`zip`、`bzip2/zstd`、`tracing`、`proptest`、`criterion`。所有依赖需经过 license、安全、native 和跨平台审计；只有确需共享写状态处才使用并发 map。

---

## 5. 分阶段执行计划

每阶段统一流程：**先 contract → Rust 实现 → F#/Rust differential → shadow mode → 小比例切流 → 默认 Rust → 保留回退一个版本。**

### Phase 0：治理、基线和契约冻结（4–6 周）

交付：

- [x] ADR：目标、非目标、crate 边界、cache、兼容和回退（`docs/adr/0001-rust-backend-migration.md`）；
- [x] machine-readable command/notification/capability manifest（`contracts/lsp-manifest.json`，由 `npm run check:lsp-contract` 校验 F# advertise/handler/effect、initialize、trigger 和 semantic ABI）；
- [x] F# reference server transcript recorder/replayer（`tools/lsp-transcript/`，首个 lifecycle golden 已可确定性重放）；
- [x] parser/CWT/diagnostics/completion/ref/token/knowledge 跨实现 corpus（`corpus/manifest.json`，6 条 F# golden 已连续确定性重放；Rust candidate 将从 Phase 1 起复用同一 harness）；
- [x] cold/warm load、completion、validation、RSS、binary/VSIX size baseline（runner/schema/manifest 已落地；固定 sample workspace 的 3-run F# reference 摘要已审阅并保存在 `benchmarks/reference/`，VSIX size 在未提供包时显式为 null）；
- [x] Rust fmt/clippy/test/audit/deny CI，同时保留现有门禁（core 与 LSP adapter 独立 jobs；本地 fmt/test/clippy 已通过，audit/deny 由 CI 安装执行）；
- [x] 迁移期 selector 已完成其过渡职责并删除；扩展只解析 canonical `release/bin/server/<rid>/CWTools Server[.exe]`，不存在 F# selector 或自动 fallback。

退出门禁：manifest 覆盖 100%；corpus 可稳定重放；baseline 连续三次可解释；无“先实现后补 contract”。

### Phase 1：Rust LSP transport sidecar（4–6 周）

只迁 framing、JSON-RPC、取消、生命周期、stderr logging、request routing；语义经版本化 length-prefixed IPC 代理 F# worker。禁止把 CLR embedding/PInvoke 当长期架构。

- [x] Rust strict framing/JSON validation、stdio 双向透明代理、worker 路径解析及显式 `CWTOOLS_FSHARP_WORKER`；
- [x] initialize/shutdown/exit/cancel 和全部反向 request/notification 经同一双向 frame proxy 透传；
- [x] malformed header、truncated payload、invalid JSON、clean EOF 受控测试；
- [x] F# 6-case corpus 经 Rust sidecar 重放 100% 等价；
- [x] release sidecar staging 和 exact binary release checks；`auto` 直接选择 Rust，不自动回退 F#；
- [x] 优化构建 500-frame transport gate：0.214ms/frame < 2ms。

门禁：transcript 结构 100% 等价；malformed/EOF/shutdown/cancel/反向请求通过；TS/MCP 无特判；transport p95 overhead <2ms；可回退直接 F#。

### Phase 2：source、DocumentStore 和纯叶模块（5–7 周）

迁 `cwtools-source`、UTF-16 line index、incremental edit，再迁 folding、CompletionText/FallbackPolicy、SemanticDirectoryCatalog、部分 LocalisationPreview/Overlay admission。

- [x] `cwtools-source` UTF-16/byte line index（含 CRLF 行端和 surrogate boundary）；
- [x] 原子 incremental edit、strict range/rangeLength、版本检查和 full replacement；
- [x] DocumentStore open/change/save/close 与 `Arc<RwLock>` 共享并发封装；
- [x] 200 组确定性 Unicode/CRLF 序列及 32 writer 并发一致性测试；
- [x] CompletionFallbackPolicy、CompletionText、SemanticDirectoryCatalog、Overlay admission、PdxFolding 纯 Rust 迁移；
- [x] Unicode didOpen/change/save/close corpus 由 F# 录制并经 Rust sidecar 稳定重放；
- [ ] 24h edit soak 与长期内存/死锁报告（runner 和 smoke 已落地；不得提前运行。仅在全部迁移完成、迁移期/被 Rust 替代/无用文件清理完成、最终非长时全量验收全部通过后，才执行最终 24h lane）；
- [x] LocalisationPreview 有界递归/循环保护纯核心；Pdx folding 与普通 `.txt` formatting 使用 Rust DocumentStore/CST；CWT、游戏语义、AI/knowledge 与 Shader 已接入 standalone Rust LSP，不再存在 compatibility worker。

门禁：随机 Unicode/CRLF/edit sequence property tests；open/change/save/close 和并发 race 对齐；24h edit soak 无泄漏或死锁。

### Phase 3：Paradox parser、printer、domain（8–12 周）

先 `parseString`，再显式文件 decoder；保留 CST comment/trivia/order/operator/range，随后实现可编辑 domain。

- [x] bounded 16MiB lexer、256 depth guard、UTF-16 error position 和 EOF-safe recovery；
- [x] comments/trivia/token raw/range、ordered multi-root CST、nested clause 和全部 9 个 F# operators；
- [x] quoted `\"`/`\\` escape、Unicode token、Int64 raw preservation 和 normalized printer 稳定性；
- [x] 10,000 组确定性 malformed-input fuzz，无 panic 且 token range 有界（release smoke 676ms）；
- [x] typed Int64/decimal/bool（含前导零字符串）、RGB(A)/HSV(A)/hsv360 与显式 UTF-8/CP1252 decoder；
- [x] editable ordered domain、重复 key/comment/order/range 保留、UTF-8 boundary/non-overlap edits 与 edit→reparse；
- [x] ParserTests/ProcessTests 中 7 组纯 script contracts（simple/Unicode/Int64/重复 key/quoted/empty block/error）已转为 Rust fixture 并通过；
- [x] Stellaris docs/modifier CP1252 parsers：真实 short/long docs 与 4,639 modifier fixture 通过，含 16MiB/100k entry bounds；
- [x] parser 256 层硬边界；257/10,000 层线性消费并返回错误，不继续递归；
- [x] F#/Rust versioned structural projection + canonical printer：10 组 valid（order/comment/typed/Unicode/operator/RGB-HSV/process/quoted/CRLF）100% 对齐；
- [x] 同 workload parser performance gate：100,000 次，最新复跑 Rust 14.56 MB/s vs F# 10.96 MB/s（1.33x）；Rust peak RSS 4,063,232 vs F# 46,850,048 bytes（0.087x），门禁通过；
- [x] RGB/RGBA/HSV/HSVA/hsv360 已进入 CST Assignment value、typed editable domain、printer 与 structural differential；
- [x] 6 组 malformed（quote/clause/rbrace/missing value/Unicode/colour）稳定 code + line/UTF-16 column 100% 对齐，unclosed clause 去重；
- [x] SetupLog、Jomini links/trigger/effect metadata 与 DataTypes parsers：CP1252、16MiB/100k bounds、15 个 valid/malformed/duplicate tests；
- [x] 通用 Process domain：Node/Leaf/LeafValue/ValueClause/Comment、query/clone/canonical-reparse、order/range/operator 与 1M-node/256-depth bounds（16 tests）；
- [x] STLProcess 纯核心：参数/default substitution、used/saved/exists/global event targets、fired on_action、modifier category；
- [x] 通用 scopes engine：ROOT/PREV/THIS/FROM/FROMFROM relative/fixed、scope stack、event_target/variable/wildcard、@[] dotted path 与 256 path bound（21 tests）；
- [x] supported-game scope catalogs：CK2/CK3/EU4/EU5/HOI4/IR/VIC2/VIC3/Stellaris 逐游戏 ordered keys/effect counts F#/Rust differential 9/9，含 exact effects、transition 与 STL source-scope tests（17）；

**Phase 3 状态：完成。** parser/process 全部 fixture、error position/CST/printer、fuzz、性能/内存与 scope catalog 门禁通过。

门禁：全部 parser/process fixture 双跑；parser success/error position 与 normalized CST 100%；规范化 printer 输出 100%；fuzz 不 panic/超时/无界分配；throughput 和 peak memory 不劣于 F#。

### Phase 4：CWT syntax、Rule IR、CWT-only（8–10 周）

迁 CWT parser/schema、TypeDefinition/NewField/Options、language service、project index 和 candidate activation。先只做 CWT-only，不构造 game model。

当前进度：

- [x] 独立 `cwtools-cwt-syntax`：loss-aware CWT CST、CWT001、UTF-16 position、UTF-8/BOM、16MiB/256-depth bounds；
- [x] CWT dialect 完整支持 `<type>`、`prefix<type>suffix`、`int[-inf..inf]` 等无空白 field expressions，普通 script lexer/operator ABI 不变；
- [x] `CWToolsTests` 全部 vendored `.cwt` 语法解析通过（有界递归扫描、确定排序），10 组 malformed 与 invalid UTF-8/size diagnostics 通过；
- [x] `cwtools-rule-ir`：F# Options/1..1 defaults、NewField/ValueType、RuleKind/RootRule、TypeDefinition/Subtype、directives/ranges/comments/order（23 unit + 4 real-fixture tests）；
- [x] enum/complex-enum/value IR 与 typed metadata 容器、显式 subtype-only extraction；
- [x] `cwtools-cwt-service` 单文档层：CWT001/101/102/104/110/111/112/113/200/201、symbols/references/completion arguments/injects、context-aware completion（12 focused tests）；
- [x] `cwtools-cwt-project`：2,000 files/5MB-per-file bounds、symbol index、CWT301/302/401、safe inject path/cycle、FNV content identity、last-known-good activation 和 success epoch（34 tests）；
- [x] 迁移期 CWT service projection oracle/CLI：7 组 syntax/directive/types/enums/values/aliases/scopes/links/modifier/ref fixtures 的 diagnostic code+key+phase、symbols、references、completion arguments 100% 对齐；
- [x] service 改为真实 bracket declaration grammar（不再依赖 `type = foo` 伪语法），project/index 34 个真实语法与 activation/LKG regressions；
- [x] differential 升级为 0-based UTF-16 ranges，并扩充到 15 组 fixtures：CWT001/101/102/104/110/111/112/113/200/201 的 code、message key、phase、range，以及 symbols/references ranges 全部对齐；
- [x] project-mode F#/Rust projection 与 7 组 differential：CWT301 kind-gated undefined reference、CWT302 same-file duplicate（跨文件合法）、canonical `## inject = path@selector` CWT401 cycle/acyclic、clean/builtin cases 对齐；
- [x] position completion F#/Rust projection与7组 differential：`##` directive、root prefix、RHS完整 field-expression catalog、跨文件concrete type/enum、UTF-16 cursor均对齐（稳定比较label/kind；snippet text不作为语义ABI）；
- [x] Rule IR新增4个真实STL fixture contracts（types/complex enums/single aliases/value fields），覆盖path_file、多skip roots、subtype metadata、date/datetime、±inf ranges等；
- [x] definition/reference navigation APIs与F#/Rust projection，7组跨文件type、complex-enum、unknown、Unicode、end-exclusive cursor differential对齐；
- [x] ExtendedMetadata六类root section extraction：typed recursive fields、quoted/Unicode keys、duplicate priorities、ByteRanges与ordinary-rule isolation（6 schema fixture tests，25+ assertions；仓库无单一真实聚合metadata fixture）。

**Phase 4 状态：完成。** vendored CWT syntax、Rule IR真实contracts、CWT001–401、symbols/references/completion/navigation、project index及candidate activation门禁全部通过。

门禁：vendored 规则全解析；CWT0xx/1xx/2xx/3xx/4xx、completion、symbols、definition/ref 对齐；invalid candidate 不换 active rules、不提升成功 epoch；修复后自动升级；rules contracts 通过。

### Phase 5：单文件 rules engine（10–14 周）

实现 ScopeUniverse、compiled RuleCatalog、alias/subtype、specific field、cardinality、field validators、conditional/parameter、local validation/info/completion。先不可变 catalog，不同时实现增量。

当前进度：

- [x] 新增 immutable `cwtools-rules-engine` foundation：100,000-rule/256-depth compile bounds、ordinary/alias/single-alias/type/enum indexes；
- [x] 单文件 recursive Node/Leaf shape、cardinality、bool/int/float/percent/Paradox date+datetime/enum/specific validators，稳定 RULE001/101/102/103/110/111/120/130/140/150 diagnostics与source ranges；
- [x] alias group:name与single-alias cycle-safe expansion、required-scope validation、基础local completion/info；
- [x] 68个foundation contracts与full workspace strict tests/Clippy通过；
- [x] `$parameter`/`$parameter_value`/`$localisation_parameter` typed fields，simple/complex type expansion、missing/cycle handling、TypeDefinition validation rules与nested required-scope checks；
- [x] advanced rules contracts扩展至102个，全workspace tests与strict Clippy通过；
- [x] conditional subtype groups：`subtype[name]` silent-probe activation、`subtype[!name]` inverse branch、nested/multiple subtype merge、cardinality及completion/info traversal；
- [x] `push_scope`与`replace_scope(s)` Rule IR parsing，含this/root、ordered from/fromfrom与prev/prevprev、quoted/case-insensitive values及subtype only_if_not metadata；
- [x] rules-engine contracts扩展至123个；subtype/scope parser与全workspace tests/strict Clippy通过；
- [x] recursive `ScopeFrame` runtime flow：initial/root/current/from/prev、push-before-child、replace slots、push precedence、parent-required-before-transition、sibling isolation及alias/type/subtype传播；
- [x] recursive compile-time scope-universe checks与`scope[...]` literal/current/root/from/prev validation；rules-engine contracts扩展至152个，全workspace tests/strict Clippy通过；
- [x] canonical Rust rules projection CLI（validation/completion/info，16MiB/2000-doc bounds、strict JSON、structured errors）及18个contract tests；
- [x] migration-only F# single-file validation oracle成功构建（0 warning/error），初始7个scalar/bool/int/unknown/value/cardinality classification fixtures跨实现通过；
- [x] differential扩展至31个primitive/shape/cardinality/Unicode/CRLF/multiline fixtures：23 exact、8个明确批准的“F# whole assignment vs Rust precise token/overflow range”差异、0未批准差异；
- [x] Rust canonical diagnostics同时输出byte与0-based UTF-16 ranges，含CRLF/surrogate/EOF 10个range contracts；
- [x] 单文件validation进程级p95门禁通过：200 fields/assignments，20轮，Rust 28.52ms vs F# 259.56ms，ratio 0.110 < 1.10；
- [x] migration-only F# oracle扩展validation/completion/info三模式；completion递归Node/Leaf/Subtype、prefix/sort/dedup，info提供case-insensitive field lookup；
- [x] completion/info首批9个cross-implementation fixtures通过（6 completion、3 info）；validation 31 fixtures仍保持0未批准差异；
- [x] cancellation/no-partial-publication门禁：公共ValidationOutcome、parse/root/node/rule/alias/type/subtype/depth polling，Cancelled不暴露partial diagnostics；24个取消contracts通过；
- [x] 从ScopeRegression/StellarisConfigValidation/FolderValidation提取12个可移植single-file fixtures，validation differential扩至43项（33 exact、10明确range差异、0未批准差异）；
- [x] canonical diagnostic mapping contract：10个RULE codes→稳定messageKey、legacy F# code关联与明确range policy；Rust Diagnostic及projection JSON均携带messageKey，43-fixture differential强制检查；
- [x] cursor-aware contextual completion/info foundation：deepest clause导航、direct-child isolation、prefix/sort/dedup、max-cardinality过滤、subtype children、case-insensitive direct info、UTF-8 boundary/query errors；15新contracts，engine共193、projection共30；
- [x] contextual RHS completion：specific、enum、simple/complex type candidates，prefix/sort/dedup与unknown type安全空集；completion改用loss-aware CST，支持unclosed/nested clauses及stray close；engine 202、projection 32 contracts；
- [x] migration oracle已实际构造F# CompletionService并通过magic cursor marker+Entity+type path执行；首批2个root cursor fixtures与Rust contextual completion一致；
- [x] migration oracle已实际构造F# InfoService；Rust Rule IR补齐legacy `###` description（保留历史前导空格）；Rust cursor query可识别并解包F# oracle所需synthetic root wrapper，真正CompletionService的root+nested共4项及真正InfoService的root/nested/case-insensitive/missing-description共4项与Rust一致；
- [ ] 扩展真正F# CompletionService RHS/type cursor differential、真正InfoService type/subtype cursor differential，以及三套upstream suites其余可移植单文件语义；跨文件/incremental语义归入后续project/runtime phases。

门禁：ScopeRegression、StellarisConfigValidation、FolderValidation 的单文件场景逐 code/range/message 对齐；completion 对齐；取消不发布部分状态；validation p95 不劣于 F# 10%。

### Phase 6：workspace/resource/full snapshot（10–14 周）

迁 FileManager、glob/encoding/zip/DLC/embedded、override precedence、ResourceStore、compute 和全量 indexes。先只保证 full rebuild。

- [x] 建立纯 Rust `cwtools-workspace` full-snapshot resource core；按 logical path 分组并对齐 F# `No/Overwrote/Overwritten`、embedded 最低优先级、空 scope sentinel、ordinal scope precedence、active/validated 过滤和确定性输出顺序；
- [x] 对齐 FileManager logical-path admission 纯核心：slash 归一化、workspace-root ordinal 截断、`gfx/` fast path、最早 script-folder segment、大小写敏感扩展名分类、extensionless inline script、decimal MB entity size bound，以及 entity/content/file 三类资源；
- [x] Rust filesystem discovery：确定性递归枚举、absolute-path ignore glob、路径去重、metadata/admission 联合过滤、稳定排序，以及默认100万文件/256目录深度硬边界与结构化I/O/glob/limit错误；
- [x] 有界 text resource reader：复用共享decoder支持严格UTF-8与Windows-1252，剥离UTF-8 BOM，明确拒绝UTF-16/32 BOM，metadata+stream双重64MiB硬边界，并保留invalid UTF-8 byte offset；
- [x] Rust DLC ZIP discovery：不落盘读取、entry name slash归一化、`uri:/archive/entry`稳定身份、logical-path/admission复用、UTF-8/CP1252/BOM一致解码、binary file资源保留、稳定排序；拒绝absolute/drive/`..`路径，并设置10万entry、64MiB单项、512MiB总解压硬边界；
- [x] DLC目录选择/fallback：仅检查DLC root直接子目录和各自直接文件，ZIP扩展名大小写不敏感；对目录/文件先稳定排序后选首个ZIP，否则回退目录输入并保留F#父DLC路径scope；missing root返回空，DLC目录数有界且I/O错误不吞；
- [x] Rust full-snapshot compute基础：排除Overwritten source，按logical/path稳定排序，严格parser全量处理；生成顶层definition、标量reference、scripted variable及parse-error确定性索引，保留byte range/path/logical path，并设置source/node硬边界；
- [x] RuleCatalog diagnostics full index：由per-source root resolver驱动，保留code/message_key/key/args/byte range/path/logical path，稳定排序；设置diagnostic硬边界，并采用临时结果完整计算后原子替换，失败不污染已有snapshot；resolver可明确跳过尚未admit的source；
- [x] TypeDefinition metadata驱动的typed definitions/references基础：支持path/path_file、name_field、type_per_file、starts_with（ordinal-ignore-case）、type_key_filter、type_key_regex（ignore-case，invalid pattern安全不匹配）及大小写不敏感known-ID引用解析；支持skip_root_key specific/any/nested path和重复`=`/`!=`集合语义，定义不误计为引用，结果稳定排序、有界并原子发布；补齐此前未映射的conditions/type_key_regex/root_completion_from_subtypes/key_prefix/should_be_referenced/unknown_key_handling IR字段，并以精确SkipRootKey IR保留operator语义；
- [x] Typed subtype snapshot基础：补齐subtype `type_key_field`/`type_key_regex` directive IR，按field/starts_with/regex和简单required leaf/node rules分类，应用only_if_not互斥；以`type.subtype`稳定索引definition occurrence，并与definition/reference共享硬边界及原子发布；审计确认当前F# parser始终将TypeDefinition `conditions`置None且无consumer，故不虚构运行语义；
- [x] RuleCatalog上下文精确typed references：复用active subtype、nested node和alias rule选择，只从实际匹配的simple/complex type RHS提取引用，complex prefix/suffix剥离后再按known definition大小写不敏感解析；标量同名和未知字段不再产生false positive，结果确定排序/去重、有界且snapshot原子替换；
- [x] Game-neutral computed-data基础：以显式bounded profile映射assignment key→variable kind、saved event target、effect/trigger block；递归提取并保留path/logical path/byte range，复刻F# `variable`的`@`/last-dot/`?`归一化，结果稳定排序且共享occurrence硬边界；该层承载CK2/HOI4/VIC2通用ComputedData形状，不把具体游戏key硬编码到workspace核心；
- [x] RuleCatalog驱动computed-data：IR支持`value_set[kind]`和incoming/outgoing reference label directives；复用active subtype/nested/alias路径提取VariableSet并由`alias[effect]`/`alias[trigger]`规则识别blocks，消除assignment-name heuristic误报；workspace聚合后执行F#变量归一化、确定排序和共享硬边界；
- [x] Scope-aware saved target/reference details：`value_set[event_target|global_event_target]`同时支持规则左右侧与node key，沿`push_scope`/`replace_scope`上下文保存current scope；typed reference支持规则左右侧、exact/fuzzy、incoming/outgoing label，workspace以原子有界pass发布稳定排序的详细引用索引；
- [x] ValueScope动态TypeRef基础：IR精确保留`value_field`/`int_value_field`及`[]`/`()`边界；RuleCatalog提供caller resolver并按F#语义在`|`前解析动态TypeRef，保留reference label与associated type；workspace允许按source注入game-specific resolver并继续执行known-definition canonicalization、确定排序、共享硬边界和原子发布；
- [x] RuleValidationService等价subtype applicator：selector支持ordinal-ignore-case `type_key_field`/`starts_with`与case-insensitive regex；以完整RuleCatalog validator探测cardinality、scalar/node shape、value、alias/type和scope，仅忽略F#同样忽略的missing-cardinality诊断；对完整pre-filter集合执行case-insensitive `only_if_not`并保留首个subtype scope transition；workspace bounded pass按精确clause token范围原子替换typed subtype索引；
- [x] Jomini `type_key_prefix`：script CST将`prefix key = value`解析为boxed可选prefix token并在loss-aware/canonical printer中无损保留，且不误吞`@variable = value`前的bare项；IR兼容规范`type_key_prefix`与旧`key_prefix`；typed definition/subtype pass按F# optional-pair规则执行ordinal-ignore-case精确匹配并把prefix保留到snapshot occurrence，同时维持256层深度门禁；
- [x] ValueScope完整game resolver：`cwtools-scopes`以caller硬边界构建确定性link/value-trigger/wildcard-link/variable/static-values catalog，支持`hidden:`、`parameter:`、`@`、Jomini event target、变量prefix、`|`fallback、group内点号、optional `?`、scope admission与Type/Enum/Loc/File reference hints；RuleCatalog向resolver传递活动rule scope，workspace将TypeRef结果接入known-definition canonicalization和原子typed-reference publication；
- [x] EU4/Stellaris game-specific computed data：`GameComputedData`增加按source保存的scripted effect/trigger参数与script-value参数；提供EU4及Stellaris确定性profile，按logical path ordinal-ignore-case admission扫描`$PARAM|fallback$`及`[[PARAM]`/`[[!PARAM]`语法，覆盖key、Jomini keyPrefix、leaf value与嵌套clause，结果排序去重并与variables/targets/blocks共享caller硬边界；
- [x] 真实workspace资源差分基础：新增临时F# FileManager oracle、Rust有界projection CLI及统一`cwtools.workspace-projection/v1` schema；runner对physical-relative path、logical path、scope、resource kind和validate执行确定排序及精确差分，设置1万文件/120s/16MiB输出硬边界；STL keyPrefix真实fixture（1文件）及performance workspace（167文件）均零差异；
- [x] multi-root/mod/override真实差分：projection schema接受显式有界root+scope数组，F# oracle复用FileManager多root展开及ResourceManager live precedence，Rust聚合各root discovery并用ResourceSnapshot产生No/Overwrote/Overwritten；multiplemodtests显式mod3 lane（16文件）及embedded/test覆盖lane（3文件、3个override状态）均零差异；
- [x] ZIP真实workspace差分：projection schema接受显式ZIP path/scope及F# oracle所需的有界entry text数组；Rust直接执行不落盘`discover_zip`的entry/size/total/path/decode门禁，双端统一canonical `zip:<logicalPath>`身份并比较entity/content/file admission及override；确定性fixture覆盖events、scripted effects、localisation、DDS和ignored扩展，共4个admitted资源、2个entity override状态零差异，运行后清理临时ZIP；
- [ ] 继续扩展definitions/references/types/diagnostics真实workspace差分，并完成cold-load/RSS与cache-release门禁。

门禁：loaded files/logical paths/override modes 一致；definitions/references/types/diagnostics snapshot 对齐；Windows/POSIX fixtures 通过；真实 workspace cold load/RSS 不劣化；snapshot 释放所有有界 cache。

### Phase 7：GameSession 和薄游戏（8–12 周）

构建 Rust `GameSession` 覆盖 `IGame` 能力。顺序：Custom/generic → Jomini core → CK3/VIC3/EU5 → IR。

- [x] `cwtools-game-core` 提供 `GameSession` 和 Generic/Custom/Jomini/CK2/CK3/EU4/EU5/HOI4/Imperator/VIC2/VIC3/Stellaris/CWT-only profiles；
- [x] standalone Rust LSP 直接依赖 game core，并以同一协议 router 暴露游戏能力，不再存在 worker 或按实现语言切流。

门禁中的真实 real-rules/vanilla 与跨平台执行证据归入最终非长时验收，不是待补代码。

### Phase 8：增量 snapshot 和传统游戏（10–14 周）

- [x] `cwtools-workspace::incremental` 实现 add/edit/remove/rename/open-overlay/change/save/close 的 prepare/commit、fingerprint、epoch stale guard、取消与原子 publication；
- [x] 传统游戏 profiles 与 scope/computed-data 通过统一 `GameSession`/snapshot 模型，不保留游戏专用后端。

full-vs-incremental、取消 SLO 和跨平台矩阵仍须作为最终非长时验收实际执行。

### Phase 9：Stellaris full 和 incremental（12–18 周）

- [x] Stellaris profile、scope catalog、computed data、scripted effect/trigger parameters、saved targets、localisation/graphics/inline-script admission 已进入统一 Rust game/workspace/LSP；
- [x] full 和 incremental 使用同一 snapshot 模型；没有兼容 worker 或另一套 Stellaris runtime。

大型 mod 24h 属于最终长时验收；real vanilla/config/folder/on-action/carrier-event 矩阵属于非长时验收证据。

### Phase 10：AI/knowledge、Shader 和 cache（8–12 周，可部分并行）

- [x] `cwtools-semantic` 提供 bounded graph/inline graph/PdxFlow/SQLite ProjectKnowledge，Rust LSP dispatch `cwtools.ai.*`；
- [x] `cwtools-shader` 覆盖 syntax/preprocessor/include/HLSL/project/runtime queries，并接入 Rust LSP；
- [x] `cwtools-cache` 使用 magic/schema/game/rules/source fingerprint/checksum 的有界原子 envelope，旧或损坏 cache 安全 miss 后 full rebuild；F# `.cwb` converter 已随 .NET sunset 删除。

MCP/Shader/VS Code contract、warm/full 和 corruption 行为仍须作为最终非长时验收实际执行。

### Phase 11：默认切换和移除 .NET（6–8 周）

- [x] 删除 F# server/source、显式 selector、worker/proxy/sidecar/fallback、.NET build/runtime metadata 和旧 converter；
- [x] Extension 与 MCP 使用 canonical Rust server discovery contract；
- [x] README、ARCHITECTURE、CONTRIBUTING、开发依赖、中英文说明、MIT/衍生版权 notice 与 cache rebuild 说明已更新；
- [x] 发布流程改为三平台 native artifact 聚合：缺少 win-x64/linux-x64/osx-x64 任一项时禁止打包和发布，VSIX 归档独立复核 PE/ELF/Mach-O、三份不同哈希、rules/version、无 MCP、无 .NET/迁移 runtime。

剩余均为验收证据：正式 universal VSIX 真机、跨平台 CI、真实游戏 lane、最终非长时门禁和最后的 24h soak。

---

## 6. 测试和差分体系

### 6.1 四层测试

1. Rust unit/property/fuzz：parser、range、edit、rule matcher、cache decoder；
2. 跨实现 conformance：同一 fixture 调 F# 和 Rust，输出 canonical JSON；
3. LSP transcript：黑盒 spawn 两种 server，重放 initialize/edit/query/shutdown；
4. 真实集成/性能：VS Code、MCP、rules、真实 vanilla/mod、跨平台。

### 6.2 Canonical 比较项

- parser：success/error position、semantic CST、规范化 print；
- diagnostics：`uri/range/severity/code/source/message/data/relatedInformation/tags/codeDescription`；
- completion：`label/kind/detail/documentation/sort/filter/insert/textEdit/additionalEdits`；
- definitions/references/symbols/call hierarchy；
- semantic token 完整整数流和 delta 应用结果；
- types/enums/vars/scripted services/graphs；
- file list/override mode/rules hash/model epoch/readiness；
- update 前后 snapshot 和 full-vs-incremental。

无语义顺序的 map 可 canonical sort；用户可见顺序必须 exact。允许差异只能进版本化白名单，并附 owner、原因、期限。

### 6.3 现有门禁

根仓库必须覆盖：

- `npm run compile`、`npm run typecheck:test`、`npm run test:unit`；
- `npm test`、`npm run test:shader-lsp`；
- `npm run test:cwt-lsp`、`npm run test:cwt-game-lsp`；
- `npm run test:overlay-e2e`、`npm run check:mcp-schema`、`npm run verify`。

迁移期继续运行 `dotnet build src/LSP`、`dotnet build src/Main` 和全部 `*.Tests.fsx`，直到 reference 删除。

CWTools 子模块：构建 `cwtools.slnx`，运行 Expecto、C# facade、Shader 和 performance workload；新增 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --workspace`、`cargo audit/deny`。

规则：`rules:stellaris:scan/check/report/contracts`。MCP：生成 schema 后在子模块运行 `npm run build && npm run test:contracts`，并覆盖只读拒绝、workspace/token、readiness、standalone discovery。

### 6.4 测试 lane

必须区分：

- generic/no-vanilla；
- cache-backed；
- real vanilla-backed。

当前无 vanilla/cache 时会退 generic game，只跑现有默认测试不能证明真实 Stellaris parity。真实游戏数据应使用有许可的私有 runner，不能上传游戏文件。

### 6.5 性能 SLO

- completion p95 不劣于 F# 10%；
- busy writer fallback 维持现有约 80ms 预算；
- cancellation/supersede <100ms；
- warm hover/definition/reference 不退化；
- cold load 和 peak RSS 不明显退化，至少一项改善 20% 才形成明确迁移收益；
- VSIX server 体积显著下降；
- 24h soak 无 deadlock、orphan、持续增长 cache/RSS。

---

## 7. CI、打包和发布

### 7.1 过渡期布局

- Rust：`release/bin/server-rust/<rid>/CWTools Server[.exe]`；
- F#：暂保 `release/bin/server/<rid>/...`；
- Extension 根据 env/setting 选择；`auto` 固定 Rust，Rust 启动失败直接报告，不自动回退 F#；
- 最终切换后 Rust 使用主 server 目录；删除 F# source/runtime/server、显式 selector、sidecar 和全部回退代码，最终代码库与产物仅保留 Rust。

MCP 不应自行发明路径；更新共享 binary discovery contract，并兼容旧目录。

### 7.2 平台矩阵

先保持 win-x64/linux-x64/osx-x64；协议稳定后增加 win-arm64/linux-arm64/osx-arm64。每个 target 验证 executable bit、codesign/notarization/quarantine、glibc baseline、SQLite、encoding、路径和进程退出。

### 7.3 CI jobs

- `rust-core`：fmt/clippy/test/doc/deny/audit；
- `differential`：Linux 快速 corpus，nightly 全 corpus；
- `platform-lsp`：Windows/Linux/macOS transcript + overlay；
- `real-game-nightly`：私有 runner；
- 现有 TS、VS Code、dotnet、MCP jobs 保留到 Phase 11；
- release job 解包 VSIX，断言 server、rules、version metadata 和默认不含 MCP。

### 7.4 涉及 MCP 的发布顺序

1. 后端实现只读 `cwtools.ai.*`；
2. 更新 TS definitions/registry/dispatcher 和 effect；
3. `npm run generate:mcp-schema`；
4. 在 `submodules/cwtools-mcp` build/contracts、提交，先发 `cwtools-shared` 再发 `cwtools-mcp`；
5. 根更新 MCP submodule 指针；
6. 发布 VSIX。

---

## 8. 团队、里程碑和 PR 纪律

### 8.1 建议团队拆分

- A：syntax/rules/core；
- B：workspace/index/game incremental；
- C：LSP/TS/MCP/packaging/CI；
- QA/performance：至少 0.5–1 人共享。

若只有两人，Shader 和 AI knowledge 后置，不要同时启动超过两个高风险语义面。

### 8.2 PR 纪律

- 每个 PR 只迁一个可差分能力；
- 先 fixture/contract，再 Rust，再切 flag；
- 不在迁移 PR 顺手修复历史语义；先给 F# reference 加回归，再单独决定同步修复；
- 外部输出 deterministic、cache bounded、边界输入经过验证；
- 子模块内部提交在前，根指针提交在后；
- 用户可见配置和文档中英文同步。

### 8.3 里程碑

| 里程碑 | 判定 |
| --- | --- |
| M1 协议冻结 | recorder + manifest + CI differential |
| M2 Rust 外壳 | Extension/MCP 经 Rust sidecar，语义仍可由 F# 提供 |
| M3 Rust 语法 | parser/printer/domain parity |
| M4 CWT-only | 规则仓库完全由 Rust 编辑和诊断 |
| M5 通用语义 | Custom/Jomini profiles 默认 Rust |
| M6 全游戏 | 传统游戏和 Stellaris full/incremental parity |
| M7 全能力 | Shader/AI/cache/MCP standalone parity |
| M8 去 F#/.NET | 删除 F# source/runtime/server/selector/fallback，代码库与产物仅保留 Rust |

---

## 9. 风险登记和停止条件

| 风险 | 级别 | 缓解 |
| --- | --- | --- |
| Big-bang 长期不可发布 | 极高 | sidecar、feature flag、逐能力门禁；禁止整仓翻译 |
| 全局 string/scope/file 状态遗漏 | 极高 | SessionContext、case reset、污染检测 |
| incremental stale 或误判 | 极高 | 每步 full oracle + random edit differential |
| CWT DSL 长尾 | 极高 | Rule IR 先冻结，真实规则全量 corpus |
| FsPickler cache 不可跨语言 | 高 | one-way converter、新格式、full fallback |
| UTF-16/byte、CP1252/BOM 漂移 | 高 | 双索引、原始字节 fixtures |
| 结果顺序变化 | 高 | stable sort + canonical contract |
| path/case/overwrite 差异 | 高 | Windows/POSIX 独立 fixtures，不顺手修正 |
| Stellaris 污染核心架构 | 高 | 独立 extension crate，最后迁移 |
| public mutable/C# ABI 断裂 | 高 | .NET shim/worker 保留过渡版本 |
| MCP 找不到 binary | 高 | 共享 discovery contract 和旧路径兼容 |
| Rust 性能退化 | 中高 | 每阶段 benchmark，未达 SLO 不切默认 |
| 双实现维护过久 | 中高 | 明确 sunset，差异白名单有期限 |

硬停止条件：协议差分不可解释；真实 corpus diagnostics 大面积漂移；incremental 无法由 full oracle 验证；性能连续两个阶段不达标；或双实现妨碍安全修复。触发后暂停切流，保留 F# reference。

---

## 10. 首批 90 天 backlog

### 第 1–2 周

- 建 working group、ADR、owner；
- 固化当前 commit、子模块指针、测试清单；
- 建 Cargo workspace 空骨架和 CI；
- 定义 canonical Range/Diagnostic/Completion/Command DTO。

### 第 3–6 周

- 实现 transcript recorder/replayer；
- 自动提取 capabilities/commands/read-write manifest；
- 转换首批 50–100 个 parser、CWT、diagnostic、completion fixtures；
- 跑三次性能、内存、包体 baseline；
- 增加 implementation flag，但默认不切 Rust。

### 第 7–10 周

- Rust stdio/JSON-RPC/cancel/lifecycle spike；
- 决定 LSP 框架或自建 transport；
- 定义并实现 worker IPC；
- Linux 跑完整 transcript，Windows/macOS 跑 lifecycle smoke。

### 第 11–13 周

- Extension 内部 canary 走 Rust sidecar；
- MCP bridge/standalone contract；
- chaos：worker crash、pipe EOF、cancel、restart、malformed frame；
- M2 go/no-go review。只有 Phase 1 全门禁通过才开始 parser 迁移。

首批 90 天目标不是大量翻译代码，而是建立可证明等价、可回退、可复用的迁移生产线。

---

## 11. Definition of Done

迁移只有同时满足以下条件才完成。最终执行顺序固定为：①完成全部迁移；②删除迁移期临时文件、无用文件及已被 Rust 替代的 F#/.NET/sidecar/fallback/oracle 实现；③在清理后的最终 Rust-only 仓库和发布产物上完成全部非长时全量验收；④只有前述验收全部通过后，最后执行 24h 等特长时间 soak；⑤核验 soak 报告后完成迁移。不得以迁移期双实现或清理前产物执行最终验收/soak。

完成条件：

- Rust 覆盖全部当前游戏、CWT-only、Shader、AI/LSP 命令；
- 标准 LSP、自定义命令/通知、MCP、规则和 cache migration contract 通过；
- full 与 incremental 在固定和随机 corpus 一致；
- 根、CWTools、规则、MCP、VS Code、跨平台、发布门禁全部通过；
- 没有未批准的 diagnostic/completion/reference/token 差异；
- 没有 orphan、deadlock、无界 cache，取消和 shutdown 达到 SLO；

- 性能门槛和 24h soak 通过；
- 迁移期临时文件、无用文件、已替代的 F#/.NET 实现和发布产物全部删除；
- 删除 selector、fallback、sidecar 和差分期临时产物；仓库及发布产物仅包含 Rust 实现。

在这些条件满足前，项目应称为“迁移中”或“Rust-backed with F# compatibility worker”，不能称为已完成纯 Rust 重写。
