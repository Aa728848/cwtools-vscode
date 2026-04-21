# Changelog

## [1.5.0] - 2026-04-21

### AI Agent — 架构全面重构

#### 并发架构（LSP 服务端）
- **读写锁并发**：引入 `ReaderWriterLockSlim`，只读请求（Hover、Completion、AI 查询等）线程池并发执行，写操作（DidChange、UpdateFile）串行独占执行
- **validateCode 竞态修复**：`cwtools.ai.validateCode` 命令内的 `UpdateFile` 调用现在持有写锁保护，防止并发验证产生 AST 状态竞争

#### 8 个新增 AI 专用 LSP 命令（Program.fs）
所有新命令均注册为只读并发命令，不阻塞 LSP 主线程：

| 命令 | 功能 | 底层 API |
|------|------|---------|
| `cwtools.ai.queryDefinition` | 按坐标跳转定义 / 查找引用 | `GoToType` + `FindAllRefs` |
| `cwtools.ai.queryDefinitionByName` | **按名称**直接定位符号定义，无需知道坐标 | `AllEntities` AST 搜索 |
| `cwtools.ai.queryScriptedEffects` | 列出所有 scripted_effect 及 scope 约束 | `ScriptedEffects()` |
| `cwtools.ai.queryScriptedTriggers` | 列出所有 scripted_trigger 及 scope 约束 | `ScriptedTriggers()` |
| `cwtools.ai.queryEnums` | 查询枚举合法值 | `GetEmbeddedMetadata().enumDefs` |
| `cwtools.ai.queryStaticModifiers` | 列出所有 static modifier 及类别 | `StaticModifiers()` |
| `cwtools.ai.queryVariables` | 列出所有 `@variable` 定义 | `ScriptedVariables()` |
| `cwtools.ai.getEntityInfo` | 获取文件的引用类型、定义变量、effect/trigger 块、event_target | `ComputedData` 缓存 |

#### TypeScript 客户端增强（agentTools.ts）
- 8 个新工具的完整定义（tool schema）、dispatch 注册和实现方法
- **5秒 TTL 缓存**：`cachedLspRead<T>()` 通用缓存，ScriptedEffects/Triggers/Enums/StaticModifiers 重复调用直接命中缓存，大幅降低 LSP 轮询频率
- `AgentToolName` 联合类型同步更新（types.ts）

#### AI 系统提示强化（promptBuilder.ts）
- **反幻觉强制检查规则**（Build 模式）：使用 scripted_effect/trigger/@variable/modifier 前**必须**先调用对应 AST 查询工具
- **深层 API 工具表格**（所有模式 STELLARIS_KNOWLEDGE）：明确各工具使用时机，AST 工具优先于文件系统搜索
- **Explore 模式**：区分文件级工具与 AST 级工具，标注 AST 工具更快且具 scope 感知能力

---

## [1.4.0] - 2026-04-19

- 移除"事件流程图"功能（graph.ts / graphPanel.ts / graphTypes.ts）
- 星系可视化预览（Solar System Preview）功能稳定化

## [1.3.0] - 2026-04-18

- 新增星系可视化预览功能（solarSystemParser / solarSystemPanel / solarSystemPreview）
- 移除性能分析器（performanceHints.ts）