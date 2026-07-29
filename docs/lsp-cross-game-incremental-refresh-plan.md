# LSP 跨游戏类型与本地化增量刷新实施计划

## 1. 文档状态

- 状态：已完成（2026-07-28）
- 范围：CWTools F# 核心、LSP、VS Code Language Client、Standalone MCP watcher、测试与架构文档
- 最终验收：所有当前支持的游戏模式全部完成并通过统一验收门

> 本计划中的阶段只表示依赖顺序和施工批次，不是可单独验收、发布或宣告完成的交付物。
> 项目只有在 Stellaris 回归以及 HOI4、EU4、EU5、CK2、CK3、Imperator、VIC2、VIC3、Custom/Generic
> 全部满足本文 Definition of Done 后，才算完成。

### 实施结果

- 十种游戏适配器统一实现 `IIncrementalTypeIndex`、`IIncrementalLocalisation` 和
  `ISemanticDeltaProvider`，共享 CWT `pathOptions` 驱动的 type key 发现与 staged commit。
- scripted trigger/effect/value 参数、类型重命名和删除均进入共享增量服务；prepare/commit
  失败与 guard supersede 使用稳定原因码回退到 staged full refresh。
- 本地化新增、重命名和删除维护 provider、processed map、反向引用与受影响诊断；CK2 使用
  CSV/Windows-1252，VIC2 的正常解析 key 索引遗漏已修复。
- LSP、VS Code 与 Standalone MCP watcher 已按活动 profile/capability 路由，批次顺序确定，
  Custom/Generic 使用独立保守 profile，不再继承 Stellaris-only 能力。
- 跨游戏等价性 harness 实际构造十种 game model，对比 type index、scripted services、
  类型删除、本地化重命名/删除与全量刷新结果；仓库完整验证命令全部通过。

## 2. 目标

将当前主要由 Stellaris 使用的类型索引、scripted services 和本地化增量刷新能力扩展到所有
LSP 游戏模式，同时保持以下性质：

1. 普通文件修改继续只更新单文件 ResourceManager 资源。
2. 类型定义修改只重建受影响的 type key；未变化的索引、trie 和验证数组继续共享。
3. scripted trigger/effect/value 等动态语义修改只重建必要的规则、补全和信息服务。
4. 本地化新增、修改和删除只重算受影响 key、定义文件、引用文件和诊断。
5. 任何无法证明安全的变更都保留确定性的 staged full refresh 兜底。
6. 增量结果必须与相同输入上的全量刷新结果语义等价。
7. 不牺牲现有的 cancellation、latest-wins、读写锁、epoch guard、诊断 freshness 和内存边界。

## 3. 覆盖范围

### 3.1 必须完成的游戏模式

| 游戏模式 | 游戏家族 | 类型增量 | Scripted services 增量 | 本地化增量 | 删除增量 | 全量等价测试 |
| --- | --- | --- | --- | --- | --- | --- |
| Stellaris | Legacy/Clausewitz | 必须回归 | 必须回归 | 必须回归 | 必须回归 | 必须 |
| Hearts of Iron IV | Legacy/Clausewitz | 必须 | 必须 | 必须 | 必须 | 必须 |
| Europa Universalis IV | Legacy/Clausewitz | 必须 | 必须 | 必须 | 必须 | 必须 |
| Europa Universalis V | Jomini/Modern | 必须 | 必须 | 必须 | 必须 | 必须 |
| Crusader Kings II | Legacy/Clausewitz | 必须 | 必须 | 必须，含 CSV | 必须 | 必须 |
| Crusader Kings III | Jomini/Modern | 必须 | 必须 | 必须 | 必须 | 必须 |
| Imperator: Rome | Jomini/Modern | 必须 | 必须 | 必须 | 必须 | 必须 |
| Victoria II | Legacy/Clausewitz | 必须 | 必须 | 必须，含旧编码 | 必须 | 必须 |
| Victoria 3 | Jomini/Modern | 必须 | 必须 | 必须 | 必须 | 必须 |
| Custom/Generic Paradox | 配置驱动 | 必须 | 必须 | 必须 | 必须 | 必须 |

Custom/Generic 的能力必须从已加载 CWT、游戏设置和本地化服务推导；不得默认套用 Stellaris
目录或 `.yml` 语义。若自定义配置缺少支持增量所需的元数据，必须报告明确的 capability
状态并使用 staged full refresh，不能静默保留陈旧索引。

### 3.2 不在本计划内

- 改变 CWT 规则语言本身的语义。
- 为某个游戏新增与增量刷新无关的验证器或编辑器功能。
- 取消全量刷新路径。
- 把增量刷新建立在硬编码游戏 ID、目录名或 type key 列表之上。
- 以“多数游戏完成”“Jomini 完成”或“Legacy 完成”作为最终验收。

## 4. 当前基线与主要缺口

### 4.1 已有通用能力

- `GameObject` 已支持单文件 prepare/commit/validate。
- `RulesManager` 已支持 staged type index、scripted services 和完整规则缓存刷新。
- staged commit 已有 lookup identity、resource epoch、type/rules/localisation epoch guard。
- `LocalisationManager` 已维护文件 API、key provider 计数、processed localisation 引用索引和
  `LocalisationDelta`。
- `ValidationManager` 已支持按 key 查找引用文件、按文件验证本地化以及合并缓存诊断。
- LSP 已具备 latest-wins、debounce、读写锁、诊断 freshness 和全量回退调度。

### 4.2 必须修复的缺口

1. `SemanticDelta.fs` 的 type-defining 路径是 Stellaris 偏向的硬编码表，不能覆盖所有游戏。
2. 只有 Stellaris 实现 `IIncrementalTypeIndex`、`IIncrementalLocalisation` 和精细语义签名。
3. 其他游戏适配器的 scripted refresh 方法仍返回 `false`/`None`。
4. 游戏特有 full-refresh hooks 生成 modifier、landed title、state/country links、动态 enum
   等派生数据，普通 type stage 尚未声明这些依赖。
5. LSP 多处把本地化文件硬编码为 `.yml`。
6. VS Code watcher 没有覆盖 CK2 `.csv`，也没有从游戏 profile 推导 watcher。
7. 本地化文件删除缺少对 API、provider 计数、processed map 和反向引用的完整增量清理。
8. 外部磁盘更新需要统一使用游戏声明的本地化编码，不能依赖无参数 `File.ReadAllText`。
9. 现有增量/全量等价测试主要集中在 Stellaris，其他游戏没有覆盖。

## 5. 设计原则与不变量

### 5.1 能力驱动，不以游戏名分支

LSP 应询问当前 game model：

- 文件是否可能贡献类型；
- 涉及哪些 type key；
- 是否影响动态 enum、core links、scope 或 scripted services；
- 本地化扩展名和编码；
- 本地化全局验证由哪些组成部分构成。

游戏适配器可以提供特有能力，但 LSP 不应继续增加 `activeGame = ...` 的目录判断。

### 5.2 准备与提交分离

- 解析、type 提取、service 构建和本地化影响集计算在锁外或读锁内进行。
- 共享模型替换只在短写锁内发生。
- commit guard 失败时丢弃 stage，由最新文件版本重新决定，不在写锁内做重建。

### 5.3 全量结果是语义基准

所有增量测试必须采用以下形式：

1. 从同一初始 fixture 构建两个 game model。
2. 一个执行目标增量操作。
3. 另一个应用相同文件内容后执行完整刷新。
4. 比较规范化后的类型、enum、links、补全、定义、引用和诊断。

不能只断言“包含新值”；必须同时验证旧值被移除、未受影响数据保持一致、重复 provider
和覆盖顺序正确。

### 5.4 保守回退必须可观察

每次 full fallback 必须带稳定原因码，例如：

- `capability_unavailable`
- `path_contribution_unknown`
- `derived_hook_requires_full`
- `stage_prepare_failed`
- `stage_guard_superseded`
- `localisation_format_unsupported`

性能日志和验证状态必须能区分成功增量、语义 no-op、主动全量回退和异常失败。

## 6. 目标架构

### 6.1 通用类型增量能力

在 CWTools 通用层引入游戏无关的文件贡献查询和 stage 入口，至少表达：

```text
File
  -> existing indexed type keys
  -> current entity matched CWT pathOptions
  -> game-derived/synthetic contribution descriptors
  -> TypeIndexOnly | ScriptedServices | FullRefresh(reason)
```

通用 type key 发现顺序：

1. 从旧 `lookup.typeDefInfo` 找到该文件已有的 type key，覆盖重命名和删除。
2. 从当前实体与 `TypeDefinition.pathOptions` 找到新增或仍存在的 type key。
3. 合并游戏适配器声明的 synthetic/derived type key。
4. 排序、去重后创建 stage。

禁止在通用层写死 `scripted_trigger`、`state`、`landed_title` 等游戏内容。必要的兼容映射由
游戏适配器提供，并由测试证明与 CWT 结果一致。

### 6.2 派生语义依赖描述

为 full-refresh hook 增加可增量表达的依赖描述，区分：

- 仅依赖某些 type key；
- 依赖某类文件的动态参数；
- 依赖 modifier/province/state/country 等游戏索引；
- 依赖全项目资源集合，当前不能安全局部化。

每个游戏必须审计以下 hooks：

- `loadConfigRulesHook`
- `refreshConfigBeforeFirstTypesHook`
- `refreshConfigAfterFirstTypesHook`
- `refreshConfigAfterVarDefHook`
- `afterUpdateFile`
- `afterInit`

可局部化的 hook 进入 stage；暂不能局部化的 hook 返回明确 full-refresh reason。最终验收不要求
每一种文件永不全量刷新，但要求所有可支持的类型与本地化增量场景完成，且任何回退都正确、
有界、可解释。

### 6.3 通用本地化增量能力

将 Stellaris 适配器中的增量验证编排下沉为通用 helper，输入包括：

- localisation 文件扩展名集合；
- 文件读取编码；
- localisation API/syntax 验证策略；
- processed localisation 验证器；
- 游戏特有的文件级验证器；
- 游戏特有的 global localisation 验证器；
- 受影响 key 和初始文件集合。

通用输出继续使用 `IncrementalLocalisationResult`，并保证：

- 只替换 affected files 的缓存错误；
- 保留未受影响文件的错误；
- 删除最后一个 provider 后正确传播 missing-localisation；
- 覆盖关系变化时重新计算 effective provider；
- key 引用的传递影响通过正反索引扩展。

### 6.4 本地化删除

为 `LocalisationManager` 增加删除操作，原子完成：

1. 移除该文件所有语言的 API。
2. 更新 provider 计数和 tagged key set。
3. 重新计算受影响 key 的 effective provider。
4. 更新 processed localisation map。
5. 更新 processed reference 正反索引。
6. 产生包含 changed keys 和 affected files 的 delta。
7. 移除该文件的缓存诊断。

ResourceManager 文件删除与 LocalisationManager 删除必须在同一 LSP 更新周期中提交，不能出现
一个已删除文件仍被查询到的中间已发布状态。

### 6.5 LSP 路由

移除以下硬编码：

- `.yml` 等价于 localisation；
- 固定的 type-defining 目录列表；
- 固定的 scripted definition 目录列表；
- 所有游戏共享同一编码。

替换为 game capability 查询。创建、修改、保存和删除必须进入同一套语义决策：

```text
didChange/didSave/watched change
  -> prepare single-file resource
  -> commit resource
  -> query contribution delta
  -> prepare type/localisation stage
  -> guarded commit
  -> targeted revalidation
  -> publish exact-version diagnostics
```

### 6.6 Client 与 Standalone MCP watcher

- VS Code watcher 根据所有已注册 game profiles 生成目录和扩展名集合。
- 活跃游戏确定后，可以缩窄 watcher，但切换游戏时必须正确 dispose/recreate。
- CK2 `.csv` 必须覆盖 create/change/delete。
- Standalone MCP 的 Chokidar 过滤器必须与 LSP capability 使用相同的扩展名来源。
- watcher 输出顺序必须确定，批次必须去重，删除优先级保持现有语义。

## 7. 实施工作包

以下工作包有依赖顺序，但任何单个工作包完成都不构成项目验收。

### 工作包 A：基线、观测与测试骨架

1. 为每个游戏建立最小规则、脚本和本地化 fixture。
2. 建立增量/全量规范化比较 helper。
3. 为 refresh decision、受影响 type key、affected files 和 fallback reason 增加结构化测试观测。
4. 记录当前每个游戏的全量刷新次数、耗时和增量保存锁占用作为基线。

完成条件：

- 十个游戏模式都能进入同一比较 harness。
- 测试失败能指出差异属于 types、enums、links、completion、references 或 diagnostics。

### 工作包 B：通用类型贡献与 stage API

1. 把 Stellaris 的通用 type key 发现逻辑移动到 CWTools 通用层。
2. 从 CWT `pathOptions` 推导文件贡献，保留旧索引键以支持删除和重命名。
3. 增加 synthetic/derived contribution 扩展点。
4. 让 LSP 通过 game capability 判断候选文件，而不是使用固定目录。
5. 为创建、修改、删除分别实现 staged prepare/commit。
6. 保持 unchanged trie、validation array 和 lookup 字段的引用共享。

完成条件：

- 所有游戏都可构造 `StagedTypeIndex`。
- 未知贡献明确回退，不允许成功返回但遗漏类型。

### 工作包 C：Scripted services 与游戏 hooks

1. 为所有游戏适配器实现 `PrepareScriptedTypes`、`CommitScriptedTypes` 和删除。
2. 审计每个游戏的动态 enum、core links、scope inference 和 scripted parameter 来源。
3. 将可局部化 hook 纳入 lookup clone stage。
4. 为每个游戏增加 `ISemanticDeltaProvider`，或者提供等价的保守贡献签名。
5. 签名无法证明无变化时必须选择 `ScriptedServices`，不能误判为 no-op。

游戏特有检查：

- HOI4：state、country tag、scripted trigger/effect、event-target links。
- EU4：scripted params、modifier、government、customizable localisation。
- CK2：landed titles、province、modifier、event-target links。
- CK3/VIC3/EU5：Jomini script value、dynamic enum、data links。
- Imperator：Jomini compute 与 IR lookup 特有 enum/link。
- VIC2：legacy params、modifier 和旧规则元数据。
- Custom：只使用配置声明的类型和 hook，不借用 Stellaris 默认值。

完成条件：

- 所有游戏 scripted definition 新增、重命名、正文语义变化和删除均与全量结果一致。

### 工作包 D：通用本地化增量与删除

1. 提取通用 affected-files 计算和错误合并。
2. 参数化游戏的全局、语法、processed 和文件级本地化验证。
3. 实现 `RemoveLocalisationFile`。
4. 修复 duplicate provider、覆盖优先级和删除最后 provider 的 delta。
5. 把本地化扩展名、编码和语言集合纳入 game capability。
6. 确保 full localisation 尚未建立初始错误缓存时安全回退。

完成条件：

- 十个游戏模式的 key add/change/delete 和引用传播均与全量结果一致。
- CK2 CSV、VIC2/CK2 旧编码有独立测试。

### 工作包 E：LSP、VS Code 与 MCP 端到端接入

1. 替换 LSP 中 `.yml`、type path 和 scripted path 的硬编码。
2. 更新 create/change/delete watcher 路由。
3. 更新 VS Code `fileEvents`。
4. 更新 Standalone MCP watcher。
5. 保持保存回声去重、latest-wins、debounce、取消和短写锁行为。
6. refresh status 暴露增量类型、本地化和 fallback reason。

完成条件：

- IDE 保存与外部文件系统修改得到相同模型结果。
- VS Code 与 Standalone MCP 使用相同语义。

### 工作包 F：全矩阵验证、性能与文档

1. 运行全部游戏的增量/全量等价矩阵。
2. 运行并发编辑、连续保存、stage supersede 和删除风暴测试。
3. 验证缓存有界、无已删除文件残留、无 stale diagnostics 发布。
4. 更新 `ARCHITECTURE.md` 英文和中文部分。
5. 更新 `README.md` 中关于 `experimental`、支持范围和回退语义的英文及中文描述。
6. 更新必要的贡献指南与诊断/性能日志说明。

完成条件：

- 第 10 节 Definition of Done 全部满足。

## 8. 游戏实施顺序

建议按共享代码程度降低返工，但顺序不改变最终全量验收要求：

1. CK3、VIC3、EU5：验证 Jomini 共用实现。
2. Imperator：验证 Jomini compute 与独立 lookup 的组合。
3. VIC2：验证 legacy 规则和旧编码。
4. EU4、HOI4：验证复杂派生 enum、core links 和 scripted 参数。
5. CK2：完成 CSV、编码和 synthetic landed-title 类型。
6. Custom/Generic：验证完全配置驱动的能力与安全回退。
7. Stellaris 全矩阵回归。

任何批次通过后都只能标记为“内部工作包完成”，不能把功能状态标记为完成，也不能关闭总任务。

## 9. 测试与验证矩阵

### 9.1 类型与服务

每个游戏都必须覆盖：

- 新建一个类型定义文件。
- 在已有文件中新增定义。
- 重命名定义。
- 删除单个定义。
- 删除整个定义文件。
- body-only 修改。
- range/comment/format-only 修改。
- subtype、validate、localisation property 修改。
- scripted trigger/effect/value 参数新增和删除。
- 对旧 ID 和新 ID 的 definition/reference 查询。
- 引用文件的定向重新验证。
- 受影响和未受影响 type trie 的引用共享。
- stage 被更新版本 supersede。
- prepare 或 commit 失败后的全量回退。

比较对象至少包括：

- `Types()` / `TypeDefs()`
- `enumDefs`
- `allCoreLinks`
- scripted triggers/effects
- completion
- info/hover
- go-to-definition
- find-references/type-reference index
- 当前文件与反向引用文件诊断

### 9.2 本地化

每个游戏都必须覆盖：

- 新增 key。
- 修改 value。
- 重命名 key。
- 删除 key。
- 删除文件。
- 同 key 多 provider 的新增、覆盖和删除。
- 被其他 localisation key 引用。
- 被脚本定义引用。
- required type localisation。
- 语法错误新增和修复。
- 多语言配置。
- overwritten/validate=false 文件。
- 外部 watcher 更新与编辑器保存。

额外要求：

- CK2：CSV 解析、创建、修改、删除、Windows-1252 字符。
- VIC2：声明编码下的非 ASCII 内容。
- Jomini 游戏：`localization/` 目录。
- Stellaris：`localisation/`（`localisation_synced/` 已废弃且游戏中不再存在）。

### 9.3 并发与生命周期

- completion 持读锁时保存定义文件。
- prepare 期间第二次编辑使旧 stage 失效。
- 连续创建/修改/删除同一路径的 watcher 合并。
- 关闭文档后 watcher 更新。
- 游戏配置切换和 game object 替换。
- 完整项目重载期间到达的文件变更。
- idle full refresh 与 active completion 竞争。
- Standalone MCP 启动、停止和 watcher dispose。

### 9.4 性能门槛

性能测试使用固定 fixture 和重复运行，记录中位数及 P95：

- 单文件 type-index-only 更新不得扫描所有项目实体来重建全部 type map。
- 未受影响 type trie 必须保持引用共享。
- 增量 localisation 不得调用 `UpdateProcessedLocalisation()` 全表重建。
- 增量成功路径不得增加 `RefreshCaches` 计数。
- prepare 可执行重工作，但 commit 写锁仅允许字段交换、有限索引更新和缓存失效。
- 内存不得随编辑文件数量无限增长；新增缓存必须有界或基于当前模型生命周期释放。

具体毫秒阈值应由工作包 A 的跨平台基线确定，并在测试环境中设置合理容差，避免以开发机绝对耗时
作为唯一判断。

## 10. Definition of Done：唯一最终验收标准

只有以下条件全部满足，项目才可标记完成：

### 10.1 功能完整性

- [x] Stellaris、HOI4、EU4、EU5、CK2、CK3、Imperator、VIC2、VIC3、Custom/Generic
      全部实现类型增量能力。
- [x] 上述所有游戏全部实现 scripted services 增量或对无法局部化的具体贡献提供明确、安全的
      staged full fallback。
- [x] 上述所有游戏全部实现本地化新增、修改和删除增量。
- [x] 所有游戏的编辑器保存和外部 watcher 更新行为一致。
- [x] VS Code 与 Standalone MCP 行为一致。
- [x] 没有基于 Stellaris 目录、type key、本地化扩展名或编码的隐式默认泄漏到其他游戏。

### 10.2 正确性

- [x] 每个游戏的完整类型测试矩阵均与全量刷新语义等价。
- [x] 每个游戏的完整本地化测试矩阵均与全量刷新语义等价。
- [x] 创建、重命名和删除不会留下旧类型、旧 key、旧引用或旧诊断。
- [x] latest-wins、document version 和 model epoch 阻止旧结果发布。
- [x] 所有 full fallback 都有稳定原因码并保持诊断 freshness。

### 10.3 性能与稳定性

- [x] 成功增量路径不触发全量 `RefreshCaches`。
- [x] 类型增量只重建受影响 type key。
- [x] 本地化增量只处理影响闭包内的 key 和文件。
- [x] 写锁持有范围符合短提交设计。
- [x] 缓存和 watcher 队列有界。
- [x] 连续编辑、删除风暴和 game reload 无死锁、泄漏或陈旧发布。

### 10.4 仓库验证

- [x] CWTools 子模块针对所有游戏的新增测试通过。
- [x] `dotnet build src/LSP/` 通过。
- [x] `dotnet build src/Main/` 通过。
- [x] Extension TypeScript compile 通过。
- [x] LSP/Extension/Standalone MCP 相关单元和 contract 测试通过。
- [x] `npm run test:unit` 通过。
- [x] MCP schema、shared、MCP build 和 contract tests 在涉及协议变化时全部通过。
- [x] `npm run verify` 通过。
- [x] 英文和中文架构及用户文档同步更新。
- [x] CWTools 子模块提交与根仓库 submodule pointer 更新分开提交。

如果任一游戏、任一删除场景、任一全量等价测试或任一必需验证未完成，只能报告“实施中”或
“存在阻塞”，不得将本计划或总任务标记为完成。

## 11. 风险与应对

| 风险 | 后果 | 应对 |
| --- | --- | --- |
| 游戏 hook 存在未声明的全局依赖 | 增量结果遗漏派生类型或 links | hook 依赖审计；未知即 full fallback；全量等价测试 |
| CWT pathOptions 不完整 | 新文件无法发现 type key | 合并旧索引、当前规则和适配器 contribution；报告 capability 原因 |
| 本地化覆盖顺序变化 | 删除 provider 后 value/诊断错误 | 保存 provider 计数与 effective entry 前后快照 |
| CSV/旧编码误读 | CK2/VIC2 非 ASCII 数据损坏 | 使用游戏声明编码；字节级 fixture |
| stage 期间模型变化 | 提交旧索引 | identity/epoch/version guard；失败后最新请求重试 |
| 为追求增量扩大写锁 | completion/hover 卡顿 | prepare/commit 分离；写锁性能断言 |
| 跨游戏复制代码 | 修复不一致和长期漂移 | 通用 helper + 小型游戏策略对象；禁止复制 Stellaris 编排 |
| 测试只检查新增、不检查移除 | 陈旧数据长期残留 | 所有场景同时断言旧值消失和全量等价 |

## 12. 回滚与故障策略

- 保留现有 staged full refresh 作为每次变更的安全兜底。
- capability 可以按游戏或具体贡献类型关闭，但关闭必须返回原因并进入全量刷新。
- 不允许在失败时继续发布“看似成功”的部分 type/localisation model。
- 增量 commit 失败不得在写锁内同步执行重型 full refresh。
- 回滚某一游戏能力不改变其他游戏数据结构，但总任务状态仍为未完成，直到该游戏重新达到
  Definition of Done。

## 13. 预期主要改动位置

CWTools 子模块：

- `CWTools/Game/GameTypes.fs`
- `CWTools/Game/Game.fs`
- `CWTools/Game/RulesManager.fs`
- `CWTools/Game/LocalisationManager.fs`
- `CWTools/Game/ValidationManager.fs`
- 各游戏 `*Game.fs`
- `CWToolsTests/`

根仓库：

- `src/Main/SemanticDelta.fs`
- `src/Main/Program.fs`
- `src/Main/GameLoader.fs`
- `client/extension/gameProfiles.ts`
- `client/extension/extension.ts`
- `packages/cwtools-mcp/src/hosts/lspProcessHost.ts`
- 对应 LSP、Extension 与 MCP 测试
- `ARCHITECTURE.md`
- `README.md`

实际修改应以实现时的 CodeGraph 调用链和测试影响范围为准，避免无关重构。
