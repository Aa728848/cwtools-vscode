# Agent Note: 共享可视化编辑器解析与纯浏览器构建通道

Status: implemented

## Problem
VS Code 与 DSH 需要同一套 PDX 编辑器语义，但解析器位于 Extension Host，直接复用会把 VS Code/Node 依赖带入 Webview；复制解析器又会产生永久漂移。

## Decision
- 将纯 tokenizer、表达式、科技树、恒星系、实体、事件链、静态银河、GUI 解析、粒子资产解析、粒子分类及纯契约（`protocolValidation`、`guiPreview`、`particleTypes`）实现迁入 `cwtools-shared/editors`，原路径保留兼容 shim。
- GUI 解析的 Host 日志通过可选 `setGuiParserDebugSink` 注入，shared 实现不含 `vscode`/Node 依赖。
- `cwtools-shared/editors` 作为独立 browser-safe 子路径导出；根 tsconfig paths 与 Rollup resolver 只解析该子路径，禁止 Webview 经 shared 根 barrel 拉入 Host。
- 静态银河 shim 显式使用 editors 子路径，消除 Rollup unresolved external。
- `entityAssetParser` 的 locator 仅对块字段允许省略 `=`，兼容原版 `rotation { ... }`；state 内标量 animation 名保持原语义，真实 `_infernal_01_galactic_crucible.asset` 不再触发 Ship catalog 解析 warning。
- GUI 与 particle 资产定义（含 `guiParser`、`particleAssetParser`、`guiPreview`、`protocolValidation`、`particleTypes`）已完成迁移，均为单源实现加原路径兼容 shim。

## Alternatives considered
- 复制解析器到 DSH：违反单源，否决。
- Webview 从 `cwtools-shared` 根 barrel 导入：会产生 unresolved external 或 Node 污染，否决。
- 为每个 bundle 写不同别名：容易漂移，采用继承 paths 与同一 resolver。

## Consequences
- shared 全量契约测试与根 compile 全部 Webview 通过，且无 unresolved shared 警告。
- `gui_draft` 以 AST 元素行身份更新 position/size，复用候选事务验证、锁、漂移检查与回滚。
- DSH 可基于共享结果实现原生 Tech/Event/Galaxy/Solar/Entity 视图。
- 解析器 shim 的公共路径保持不变，现有 Host consumer 与测试无需批量改写。
## Ship / Static Galaxy 纯数据与候选写回（2026-11 追加）

### Decision
- 舰船设计解析与保格式编辑（`designDocument`、`definitionNodes`、纯数据契约 `shipDesignProtocol` 子集）迁入 `cwtools-shared/src/editors/shipDesign/`；原 `client/extension/shipDesign/{designDocument,definitionNodes}.ts` 保留单源 shim。`ShipDesignDraftSession` 一并迁入（纯内存草稿状态，无 Host 依赖），`shipDesignPanel` 的 save 写盘路径不变。
- 静态银河写回构建器迁入 `cwtools-shared/src/editors/staticGalaxyEditBuilder.ts`，原 `client/extension/staticGalaxyEditBuilder.ts` 保留单源 shim。
- 新增 `cwtools-shared/src/tools/shipGalaxyDraft.ts`：`shipDesignDraftWithHost` / `staticGalaxyDraftWithHost` 组合纯构建器与既有 `pdxWrites` 候选事务（begin 解析并以 baseline 哈希 stage；apply 以 `candidate.baseHash` 链式 stage，陈旧 span 被拒；validate/commit/discard/status 委托候选事务的排序多文件锁与回滚）。浏览器侧只读构建器结果，绝不裸写。
- `shipIconDefinitions`、`targetWeightExtract`、`definitions`、`slots`、`stats` 已迁入 shared `editors/shipDesign`，`resources`/`sprites` 已迁入 `cwtools-node`；原 VS Code 路径均保留兼容 shim。分层文件数据源仍属 Host，DSH 与 VS Code 复用同一 catalog/stats/resource 实现。

### Integration point
- `client/shared/shipDesignProtocol.ts` 已从 shared re-export 全部纯数据类型、资源类型和 `shipDesignModelNodeKeys`，自身只保留 Request/Response、EnvironmentPreset 与 Webview 消息校验；不再维护重复纯类型子集。

### Consequences
- `cwtools-shared` 构建通过、`test:contracts` 全绿（151 项）；`cwtools-node` 77 项契约通过；根 `tsc --noEmit`、`npm run compile` 与 `client/test/unit` 904 项全绿。
- `webviewSmoke` 的 `buildNebulaRadiusEdit`/`radiusWritable` 断言改指 shared 构建器源文件（实现已单源迁出）。
