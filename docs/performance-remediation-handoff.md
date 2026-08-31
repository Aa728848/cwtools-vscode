# 性能修复实施交接文档（当前工作树）

> 本文是当前工作树的恢复与交付入口，取代旧版“总体完成度 96%–97%”叙述。  
> 只记录本轮实际源码状态、已执行检查和剩余实现，不把旧日志或阶段性结果冒充当前验收。  
> 原始事故日志 `docs/test.log` 是未跟踪的用户输入，必须原样保留，禁止覆盖、格式化或提交。

## 1. 当前结论

- **核心性能实施包（含 staged file deletion 闭环）与伴随功能修复已在当前工作区全部实现落地，构建与全套自动化测试均已恢复绿色基线。**
- rules replacement、CWT activation、inline caller、localisation fallback 以及 type/script 文件删除的 staged publication 均已在 CWTools 核心层、所有 8 种游戏适配器与 `src/Main/Program.fs` 中闭环接入。
- **自动化验证结论**：
  - CWTools 库与 `CWToolsTests` 编译通过（0 error，**276 个测试全部通过，0 失败**）。
  - `src/Main` 编译通过（0 error，0 warning）。
  - TypeScript 类型检查（`npm run typecheck:test`）0 error。
  - 单元测试（`npm run test:unit`）全部通过：**主测试套件 2246 passing + rules-sync 35 passing**。
  - Main/LSP 下的核心锁定、刷新协调、诊断失效与发布集成等 11 个 FSI 测试脚本全部通过。
  - 性能日志分析脚本测试（`tools/perf/analyze-performance-log.test.mjs`）7 passing。
  - 双语文档生成（`npm run build:docs`）与发布质量门禁（`npm run check:release`）验证通过。
- **状态界定**：当前已完成**功能实施与全套自动化回归闭环**。关于根写锁 ≤100ms 等指标的“性能整改验收”，仍需在真实生产演练中生成独立性能日志并完成 old/new 对照。
- 根仓库和 CWTools 子模块均有明确的改动边界。提交时请注意：CWTools 子模块代码必须先在子模块内提交并推送，再在根仓库更新 gitlink。

## 2. 原始事故基线

来源：`docs/test.log`。以下数字只描述事故严重度，不代表当前树的运行结果。

| 指标 | 旧基线 |
|---|---:|
| 全局刷新次数 | 21 |
| 最大根写锁持有 | 46,377 ms |
| 最大 prepare | 142,159 ms |
| 最大 pending | 5,658 |
| 最大托管堆 | 26,895 MB |
| 最大专用内存 | 29,101 MB |
| 单周期分配 | 102,232 MB |
| RequestTrace | 81 条，含 `read-fallback` / `lock-timeout-fallback` |

新验收必须在最终组合树上生成独立日志，并与 old baseline 使用同一版本的 `tools/perf/analyze-performance-log.mjs` 分析。

## 3. 最新绿色检查点（已全量验证）

### 3.1 核心构建与测试执行记录

以下验证均在当前最新组合树上全部执行并通过：

- `dotnet build submodules/cwtools/CWToolsTests/CWToolsTests.fsproj --no-restore`：0 error。
- `dotnet test submodules/cwtools/CWToolsTests/CWToolsTests.fsproj --no-build`：**276 passed, 0 failed, 2 skipped**。
- `dotnet build src/Main/ --no-restore`：0 error, 0 warning。
- `npm run typecheck:test`：通过（0 error）。
- `npm run test:unit`：**主套件 2246 passing + rules-sync 35 passing**。
- FSI 回归测试脚本（共 11 个，全部通过）：
  - `src/Main/RefreshLockPhases.Tests.fsx`：通过。
  - `src/Main/RefreshLockIntegration.Tests.fsx`：通过。
  - `src/Main/CwtActivation.Tests.fsx`：通过。
  - `src/Main/RefreshCoordinator.Tests.fsx`：通过。
  - `src/Main/DiagnosticInvalidation.Tests.fsx`：通过。
  - `src/Main/WorkspacePublication.Tests.fsx`：通过。
  - `src/Main/PathIdentity.Tests.fsx`：通过。
  - `src/Main/SymbolIndex.Tests.fsx`：通过。
  - `src/LSP/Locking.Tests.fsx`：通过。
  - `src/LSP/DocumentStore.Tests.fsx`：通过。
  - `src/LSP/LanguageServer.Terminal.Tests.fsx`：通过。
- `node --test tools/perf/analyze-performance-log.test.mjs`：**7 passed, 0 failed**。
- `npm run build:docs`：通过。
- `npm run check:release -- --skip-compile --skip-test`：通过。

## 4. 已完成的性能基础设施

以下能力已经落在当前工作树，不应回滚：

### 4.1 LSP 与根锁治理

- `src/LSP/Locking.fs`：根读写锁与 RequestTrace/终态治理。
- `src/LSP/DocumentStore.fs`：文档生命周期和非重叠语义。
- `src/LSP/LanguageServer.fs`：请求锁边界、fallback 与终态发布。
- 新增回归：
  - `DocumentStore.Tests.fsx`
  - `LanguageServer.Terminal.Tests.fsx`
  - 扩展的 `Locking.Tests.fsx`

### 4.2 Main 协调与索引模块

- `PathIdentity.fs`：统一路径身份。
- `RefreshCoordinator.fs`：刷新域、pending、完成和唤醒协调。
- `DiagnosticInvalidation.fs`：按域/目标失效，避免无差别全工作区重置。
- `SymbolIndex.fs`：workspace/shader/type-reference 索引与缓存。
- `RefreshLockPhases.fs`：prepare/commit/follow-up 决策与外围写锁预算。
- `PreparedWorkspace` / publication tests：工作区锁外准备与 guarded publication。

### 4.3 CWTools staged 能力

- staged editor update：`PrepareUpdateFileInteractive` / `CommitUpdateFileInteractive`。
- staged type index 与 scripted types：prepare 在锁外，commit 使用引用/epoch guard。
- staged full cache refresh：`PrepareRefreshCaches` / `CommitRefreshCaches`。
- staged localisation journal、validation 与 immutable publication candidate。
- lookup snapshot 和 ValidationManager 生命周期优化（含 `ResetValidationManager` 规则重载缓存重置）。
- cross-game incremental capability/equivalence 测试基础。

## 5. 已完成的锁外收口

### 5.1 Rules replacement / CWT activation

CWTools 新增：

- `StagedRulesReplacement`
- `IGame.PrepareConfigRules`
- `IGame.CommitConfigRules`
- `RulesManager.PrepareConfigRules` / `CommitConfigRules`

已接入：

- CWT activation：锁外解析和构造规则/服务，根写锁内只重检 game、snapshot generation 并提交。
- 后台远程 rules completion：锁外选择规则源和 prepare，锁内 guarded commit。
- 手动 `reloadrulesconfig`：锁外 prepare，短锁 commit。
- `ForceRecompute()` 已从 rules commit 内移到锁外 follow-up。
- Stellaris 成功提交后继续失效 carrier scope resolver 和 shader rule catalogs。
- 加入了 staged rules 回归，覆盖 prepare 不改变 live state、commit 后规则生效。

### 5.2 Inline-script caller refresh

已加入：

- `StagedInlineScriptCallers`
- `PrepareInlineScriptCallers`
- `CommitInlineScriptCallers`

昂贵的 caller 展开在锁外完成；提交阶段校验 resource epoch 后替换实体 map。`Program.fs` 已改用 staged 接口。

### 5.3 Localisation capability fallback

当 adapter 没有可用的 staged localisation candidate 时，生产路径不再在根写锁内调用 legacy `RefreshLocalisationCaches()`。当前行为是：

- 保留 pending；
- 记录可观察错误；
- 等待显式 reload 或支持 staged capability 的 adapter 恢复。

不得把 legacy 全量 localisation 刷新重新放回根写锁。

### 5.4 Delete 前置只读扫描

`Program.fs` 删除事件的 definition snapshot 与 reference discovery 已移到写锁前。

## 6. 已实现的 Staged File Deletion 架构与语义规范

### 6.1 架构设计与执行语义

#### 1. Prepare 阶段（锁外）
- 捕获 live `resourceEpoch`。
- 构造排除待删文件的只读 `IResourceAPI` 视图（`resourcesExcluding`）。
  - **平台大小写折叠规则**：在 Windows 上进行路径大小写折叠（`ToLowerInvariant()`），在 Linux/macOS 上严格区分大小写，防止错误误伤大小写不同的同名文件。
- 基于排除视图准备：
  - 普通 type 文件：`StagedTypeIndex`；
  - dynamic/scripted 文件：`StagedScriptedTypes` 以及更新的 services。
- prepare 阶段为纯读操作，不删除 live resource，不修改 live lookup，不清理 live cache。

#### 2. Commit 阶段（持有根写锁，严格 Preflight 预检与受控顺序提交）
- **Preflight 1 (Epoch Guard)**：校验 `ResourceManagerEager.currentResource () = staged.resourceEpoch`。
- **Preflight 2 (Resource Existence)**：校验待删文件全部存在于当前资源集合中，确保后续 resource deletion 必定能成功删除。
- **Preflight 3 (Reference Identity & Semantic Guards)**：校验 `lookup.typeDefInfo`、`enumDefs`、`scriptedVariables` 以及全部 semantic guards（`configRules`、`allCoreLinks`、`onlyScriptedEffects`、`onlyScriptedTriggers`）与 staged base 严格一致。
- **受控提交**：
  - 若任一 Preflight 校验失败，立即返回 `false`，不执行任何 live mutation，确保零发布；
  - 校验全部通过后，依次提交 index/services 与 resource map delta；若 index 提交失败，绝对不执行资源删除；
  - 清理文件级缓存（`LanguageFeatures`、`validationManager`、`errorCache`）。

### 6.2 适配器与调用链接入
- `IGame` 抽象成员：`PrepareFileDeletion` 与 `CommitFileDeletion`。
- `GameObject` 统一实现 `PrepareFileDeletionForFiles` 与 `CommitFileDeletionForFiles`。
- 全部 8 类游戏适配器（STL, HOI4, EU4, CK2, IR, VIC2, Jomini, Custom）均已实现接入（Stellaris 提交后失效 `carrierScopeResolver`）。
- `src/Main/Program.fs` 删除事件已全部升级为写锁外 `game.PrepareFileDeletion` + 锁内短锁 `game.CommitFileDeletion`。

### 6.3 回归测试覆盖
- `ContractTests.fs`：跨游戏 `PrepareFileDeletion` / `CommitFileDeletion` 等价性契约测试。
- `FolderValidationTests.fs`：
  - prepare 纯读无副作用测试；
  - commit 删除文件与对应定义测试；
  - 并发 resource epoch 变动时拒绝提交测试；
  - 资源不存在/缺失时的 Preflight 原子性拦截测试；
  - 平台大小写敏感性路径测试。

## 7. 伴随功能修复（均已完成）

### 7.1 Scope 诊断误报

- 规则 alias 的 scope metadata lookup 改为直接使用原始 `StringTokens` 查 `EffectMap`，避免先通过全局 string table 把 token ID 反解成错误命令。
- 修改位置包括 `CWTools/Game/Hooks.fs` 和 `CWTools/Game/Stellaris/STLGame.fs`。

### 7.2 同文件封装常量算术

- 新增 `CW278`：`common/scripted_variables` 中，派生常量在 `@[ ... ]` 内引用**同一文件**中的另一个常量时报错。
- 跨文件引用保持合法。已加入同文件报错/跨文件合法的回归和中英文诊断文档。

### 7.3 Agent 供应商与工具别名

- 新增内置基元律动（Token Rhythm）供应商，官方 endpoint 为 `https://tokenrhythm.studio/v1`。
- 对 Token Rhythm 按模型控制 reasoning replay，减少 400 错误。
- Agent 执行入口把常见 `glob` 别名规范化为 canonical `glob_files`。
- package 文案中英文均已同步。

## 8. 当前工作树与提交边界

### 8.1 根仓库改动

- `src/LSP/`：根读写锁、文档存储、终端回归测试与接口更新；
- `src/Main/`：路径身份、刷新协调、诊断失效、符号索引、锁定阶段与删除短锁化接入；
- `client/`：Agent provider/tool 修复及单测；
- `docs/diagnostic-codes.md` 与双语 release package 配置；
- `tools/perf/`：性能日志分析脚本与测试；
- 本交接文档 `docs/performance-remediation-handoff.md`；
- **未跟踪（未暂存）的 `docs/test.log`**（原始事故日志原样保留）。

### 8.2 CWTools 子模块改动

- `CWTools/Game/`：staged rules、inline callers、staged deletion 闭环、`ResetValidationManager` 缓存重置；
- `CWTools/Validation/`：CW278 同文件常量算术验证器；
- 各游戏适配器（STL, HOI4, EU4, CK2, IR, VIC2, Jomini, Custom）`PrepareFileDeletion`/`CommitFileDeletion` 接线；
- `CWToolsTests/`：staged deletion、跨游戏契约与失败原子性回归测试。

### 8.3 禁止事项

- 禁止 `git clean`、`git reset --hard` 或覆盖整个工作树。
- 禁止提交 `docs/test.log`。
- 禁止先提交根 gitlink、后提交子模块。
- 禁止把 `cwtools-stellaris-config` rules data 当作 CWTools 代码修改。

## 9. 最小验证顺序

在提交或验证工作树时按以下顺序执行：

1. CWTools 编译与测试：
```powershell
dotnet build submodules/cwtools/CWToolsTests/CWToolsTests.fsproj --no-restore
dotnet test submodules/cwtools/CWToolsTests/CWToolsTests.fsproj --no-build
```

2. Main 编译与 FSI 脚本：
```powershell
dotnet build src/Main/ --no-restore
cd src/Main
dotnet fsi RefreshLockPhases.Tests.fsx
dotnet fsi RefreshLockIntegration.Tests.fsx
cd ../..
```

3. TypeScript 类型检查与单元测试：
```powershell
npm run typecheck:test
npm run test:unit
```

4. 性能分析脚本与发布门禁：
```powershell
node --test tools/perf/analyze-performance-log.test.mjs
npm run build:docs
npm run check:release -- --skip-compile --skip-test
```

## 10. 性能验收标准（针对独立性能日志）

| 项目 | 标准 |
|---|---|
| 根写锁 | 每个连续持锁段硬预算 ≤100ms；目标 p95 <25ms |
| 全局刷新 | 同一稳定编辑序列不出现重复 global refresh storm |
| lock fallback | 稳态 `lock-timeout-fallback` 为 0 |
| pending | 有界并收敛，不反复重置全工作区 |
| stale candidate | 不发布、不确认错误队列前缀、不清 pending |
| 增量等价 | 强制 full refresh 后，规范化诊断/类型/localisation/引用结果等价 |
| symbols | 热路径 <200ms；冷路径 <1s |
| 内存平台 | warmup 后增长 ≤ `max(1GB, 10%)`，否则需独立数据说明 |

## 11. 交付与待办状态确认

### 已完成的交付内容（功能与自动化回归 100% 绿色）
- [x] Staged file deletion 闭环实现（含 Unix 大小写路径语义与 Preflight 失败原子性保证）。
- [x] 全部 8 种游戏适配器与 `src/Main/Program.fs` 接线。
- [x] CWTools 全量单测（276 passed, 0 failed）。
- [x] Main 语言服务器编译（0 error, 0 warning）。
- [x] TypeScript 类型检查（0 error）。
- [x] 全量单元测试（2246 passing + 35 passing）。
- [x] 11 个 Main/LSP FSI 回归脚本与性能分析脚本测试（全部通过）。
- [x] 移出 `docs/test.log` 的暂存状态，保留工作区原文件未跟踪。
- [x] 双语文档生成与 release quality gate 验证通过。

### 待执行的上线演练与发布流程
- [ ] **生产演练数据采集**：在最终部署环境生成独立 new performance log，并使用 `tools/perf/analyze-performance-log.mjs` 完成 old/new 对照，以提供真实的性能指标达标证据。
- [ ] **分步提交发布**：
  1. 先在 `submodules/cwtools` 内完成 commit 并 push；
  2. 再在根仓库更新 gitlink 与根仓库改动；
  3. 确认暂存区不含 `docs/test.log`。

## 12. 后续验收与维护建议

1. **子模块提交优先**：子模块 `submodules/cwtools` 为独立仓库，必须在子模块内先完成 commit 并推送到远端，然后更新根仓库中的 submodule commit 指针。
2. **独立性能日志演练**：
   - 运行语言服务器并捕获生产/压力日志；
   - 执行分析对照：
     ```powershell
     node tools/perf/analyze-performance-log.mjs <new-log-path> --baseline docs/test.log
     ```
   - 确认根写锁持有时间、refresh storm 消除情况与 pending 收敛趋势。
3. **保持文档与发布门禁一致**：每次修改双语文档后运行 `npm run build:docs`。
