# cwtools PDX AI 能力 MCP 化落地计划

## 当前仓库快照

- 仓库位置：`C:\Users\A\Documents\cwtools-vscode`
- 当前分支：`main`，跟踪 `origin/main`
- 当前工作区状态：仅 `submodules/cwtools-stellaris-config` 显示 dirty；diff 显示 submodule 指针未变，仅子模块内部有未提交改动。
- 现有根结构：
  - `src/Main`、`src/LSP`：F#/CWTools Language Server 与相关主程序工程。
  - `client/extension`：VS Code extension adapter，也是当前 Agent tools 的事实运行入口。
  - `client/extension/ai/tools/definitions.ts`：当前 Agent tool schema 的事实源。
  - `client/extension/ai/tools/registry.ts`：tool 分类、读写权限、风险等级、并发分类、mode 绑定。
  - `client/extension/ai/tools/lspTools.ts`：`query_scope`、`query_types`、`query_rules`、index 查询、PDX block 读写等 LSP/语义工具实现。
  - `client/extension/ai/tools/fileTools.ts`：文件读写、本地化写入、YML guard。
  - `client/extension/ai/agentTools.ts`：VS Code 侧 AgentToolExecutor，聚合各 handler。
  - `client/extension/ai/gameKnowledge.ts`、`client/extension/ai/projectProfile.ts`、`client/extension/ai/prompt/sections`：当前 Agent 侧游戏知识、项目画像、诊断/工作流提示与 PDX 写作规范来源。
  - `client/extension/indexing`：当前 VS Code 侧增量 workspace/localisation index。
  - `submodules/cwtools`、`submodules/cwtools-stellaris-config`：CWTools 与 Stellaris 规则配置来源。
  - `docs`：当前只有 `diagnostic-codes.md`。
- `packages/` 目录当前不存在，且 `.gitignore` 中已有 `packages/` 规则。开始实现子包前必须调整 ignore 规则，否则新包源码会默认被 Git 忽略。
- 根 npm 当前是单包模式，无 `workspaces` 字段；TypeScript 根配置的 `rootDir` 是 `client`，`include` 只有 `client`。引入子包需要新增 package-level tsconfig 和测试入口，不能直接塞进现有 extension tsconfig。

## 已确认目标

MCP 不作为独立复制项目维护，而是在本仓库内作为子包/适配层维护。`cwtools-vscode` 继续作为事实源：

- LSP 与 `cwtools.ai.*` 命令来自 `src/Main`、`src/LSP`。
- Agent tool schema 与 registry 规则来自 `client/extension/ai/tools`。
- Agent 侧 PDX 工作流、安全策略、游戏知识、项目画像与诊断路由来自 `client/extension/ai`。
- VS Code 运行时能力来自 `client/extension`。
- CWTools 与 Stellaris 规则来自现有 submodule。

MCP 的产品定位是“通用 PDX Agent 能力服务”，而不是只给某一个客户端复制一套 VS Code Agent。它要把本项目已形成的 PDX AI 支持能力平台化：

- 后端 LSP 提供验证、诊断 freshness、补全上下文、解析、符号、作用域、规则、类型查询等语义能力。
- Agent 侧提供 tool registry、安全写入策略、诊断分析、项目画像、索引查询、PDX block 编辑、本地化写入等可组合工具。
- 游戏知识平台提供 Stellaris/PDX 规则经验、目录/语言/编码画像、常见诊断路由、模式化工作流提示。
- MCP 对外提供稳定、通用、客户端无关的工具能力，让 Codex、Claude Desktop、自研 Agent、CI 机器人或其他 MCP client 都能调用同一套 PDX 能力。

首期 MCP 暴露工具：

- 只读语义/索引：`query_types`、`query_rules`、`query_scope`、`get_diagnostics`、`analyze_diagnostic_error`、`query_project_profile`、`query_workspace_index`、`query_localisation_index`、`get_pdx_block`
- 写入能力：`write_localisation`、`edit_pdx_block`

首期之后的通用 LSP/解析能力扩展：

- 补全/上下文：`get_completion_at` 或新的 `cwtools.ai.getCompletionContext`，用于让外部 Agent 在指定位置知道可用 trigger/effect/property/value。
- 解析/结构：`document_symbols`、`workspace_symbols`、`query_definition`、`query_definition_by_name`、`query_references`，用于 AST 结构、定义跳转、引用分析。
- 深层游戏语义：`query_scripted_effects`、`query_scripted_triggers`、`query_enums`、`query_static_modifiers`、`query_variables`、`get_entity_info`。
- 游戏知识：项目 profile、目录/语言/编码约定、diagnostic code knowledge、workflow cards、PDX/Stellaris prompt guards，以 MCP resources 或 read-only tools 暴露。

默认 read-only；写能力必须显式开启。本地化 `.yml` 只能通过 `write_localisation` 写入。

## 通用 Agent 能力面

为了支持通用 Agent，MCP 能力面按层设计：

1. LSP semantic core：验证、诊断、completion context、hover/definition/reference、document symbols、workspace symbols、scope chain、rules、types、PDX AST/block 边界。凡是依赖 CWTools 语义的能力都优先落到 `cwtools.ai.*` LSP command。
2. Agent tool layer：把现有 Agent 工具抽象成 MCP tools，包括 `query_*`、`get_*`、`analyze_*`、安全写入工具，以及后续可扩展的 asset/gui/workflow 工具。
3. Game knowledge layer：输出项目画像、游戏 profile、规则配置来源、诊断解释、目录约定、localisation 语言/编码、Stellaris/PDX 经验性 guard。它不替代 LSP 判定，只给 Agent 提供上下文和工作流约束。
4. Safe mutation layer：统一所有写入策略。默认 read-only，显式启用后也只开放 allowlisted 写工具；localisation `.yml` 强制走 `write_localisation`；PDX block 编辑走 AST/symbol 边界。
5. MCP adapter layer：把上述能力转换为 MCP `tools/list`、`tools/call`、stdio/Streamable HTTP、结构化错误和稳定结果 schema。

通用 Agent contract：

- 工具 schema 必须自描述，不能依赖 VS Code UI、prompt 私有上下文或某个 Agent runner 的内部状态。
- 结果必须包含足够的状态信息，例如 `ok/status`、`freshness`、`source`、`indexedAt`、`warnings`、`nextSteps`，让外部 Agent 能自己组织验证循环。
- LSP 或 index 未 ready 时返回 `loading`/`unavailable`/`stale`，不能用空结果冒充成功。
- 写工具失败要给出稳定的机器可读原因，例如 `read_only`、`writes_disabled`、`outside_workspace`、`localisation_requires_write_localisation`、`lsp_unavailable`。
- MCP 不依赖交互式 VS Code confirmation。权限由启动参数、配置文件和 tool allowlist 决定。

## 现有 LSP 命令对照

动工前已核对：`src/Main/Program.fs` 已注册并实现一批 `cwtools.ai.*` command，`src/LSP/LanguageServer.fs` 也已将这些命令转发到主程序。这会显著降低 Phase 1/1.5 的 F# 新增工作量；首期重点从“补大量 LSP 命令”调整为“接线、稳定结果 schema、定义 freshness 语义、补少量缺口”。

| MCP 能力/工具 | 现有 LSP command | 当前判断 |
| --- | --- | --- |
| `query_scope` | `cwtools.ai.getScopeAtPosition` | 已有，MCP 侧接线 |
| completion/context | `cwtools.ai.getCompletionContext` | 已有，Phase 1.5 接入并稳定输出 schema |
| `query_types` | `cwtools.ai.queryTypes` | 已有，MCP 侧接线 |
| `query_definition` | `cwtools.ai.queryDefinition` | 已有，Phase 1.5 接入 |
| `query_definition_by_name` | `cwtools.ai.queryDefinitionByName` | 已有，Phase 1.5 接入 |
| `query_scripted_effects` | `cwtools.ai.queryScriptedEffects` | 已有，后续深层语义工具 |
| `query_scripted_triggers` | `cwtools.ai.queryScriptedTriggers` | 已有，后续深层语义工具 |
| `query_enums` | `cwtools.ai.queryEnums` | 已有，后续深层语义工具 |
| `query_static_modifiers` | `cwtools.ai.queryStaticModifiers` | 已有，后续深层语义工具 |
| `query_variables` | `cwtools.ai.queryVariables` | 已有，后续深层语义工具 |
| `get_entity_info` | `cwtools.ai.getEntityInfo` | 已有，后续深层语义工具 |
| diagnostics freshness | `cwtools.ai.getDiagnosticsFresh`、`cwtools.ai.waitDiagnosticsFresh`、`cwtools.ai.getValidationStatus` | 已有入口，但 MCP 等价 freshness 语义是 Phase 1 的第一个真实集成探针 |
| fragment parsing | `cwtools.ai.parseFragment` | 已有，可作为 MCP 解析/预检能力候选 |
| `query_rules` | 未发现专门 `cwtools.ai.queryRules`；当前 VS Code handler 读取/解析 CWT 与 logs 聚合 | Phase 1 真实缺口：优先加 LSP command 或从 LSP 暴露 rules metadata，不在 MCP 复制 VS Code handler |
| `get_pdx_block` / `edit_pdx_block` 边界 | 可由 document symbols / LSP block 边界能力承接 | 需要确认是否补 dedicated command |
| `query_workspace_index` | 当前主要来自 VS Code `IndexService` | Phase 0/1 前必须决定 LSP index command 或 MCP 瘦 Node index |
| `query_localisation_index` | 当前主要来自 VS Code `IndexService` | Phase 0/1 前必须决定 LSP index command 或 MCP 瘦 Node index |

这张表应在 Phase 1 开工前扩展成 contract checklist：每个工具必须标注来源、fallback、freshness 字段、错误码和测试 fixture。

## 目标包结构

```text
packages/
  cwtools-shared/
    package.json
    tsconfig.json
    src/
      index.ts
      tools/
        names.ts
        schema.ts
        registry.ts
        mcpSchema.ts
      host/
        hostServices.ts
        diagnostics.ts
        filesystem.ts
        lsp.ts
        indexing.ts
      safety/
        paths.ts
        localisation.ts
        writes.ts
      project/
        profile.ts
      knowledge/
        gameKnowledge.ts
        diagnosticRouting.ts
        workflowHints.ts
      test/
        schema.contract.test.ts
        localisation.contract.test.ts
        pathSafety.contract.test.ts
  cwtools-mcp/
    package.json
    tsconfig.json
    src/
      index.ts
      cli.ts
      server.ts
      config.ts
      mcp/
        transportStdio.ts
        transportHttp.ts
        toolRegistrar.ts
        toolHandlers.ts
      hosts/
        nodeHostServices.ts
        lspProcessHost.ts
      test/
        mcpSchema.contract.test.ts
        readonlyPolicy.contract.test.ts
        toolRouting.contract.test.ts
```

第一步实现时可以只创建 `stdio` transport，并保留 `transportHttp.ts` 为空实现/占位接口；Streamable HTTP 等到 stdio contract 稳定后再接。

## `cwtools-shared` 边界

`cwtools-shared` 的职责是抽出无 VS Code 依赖的 Agent 工具核心。它不直接 import `vscode`、`vscode-languageclient/node`、webview、SecretStorage、VS Code commands 或 extension context。

应迁入或映射的内容：

- Tool name、首期工具白名单、读写分类、风险等级、并发分类。
- 从 upstream registry 生成 MCP tool schema 的纯函数。
- `ToolDefinition`、首期工具 args/result 类型中可共享的结构。
- 路径安全、workspace 根目录校验、`.cwtools-ai` scratch 路由限制。
- localisation `.yml` 写入规则中不依赖 VS Code 的部分：路径约束、language header、BOM 策略、key update/upsert 策略、批量大小约束。
- project profile 的纯读取/裁剪逻辑，输入为 `HostServices.readTextFile` 或直接传入 JSON。
- game knowledge、diagnostic routing、workflow hints 中不依赖 UI 的知识卡片和查询逻辑。
- diagnostic analysis 中可纯化的分类规则；需要 LSP fallback 的部分通过 HostServices 注入。

不应迁入的内容：

- VS Code Problems panel 读取、`vscode.workspace.findFiles`、`vscode.execute*Provider`。
- LanguageClient 实例和 VS Code command bridge。
- UI confirmation、webview、AgentRunner、orchestrator、Blackboard。
- provider/model/chat/prompt runtime。
- 面向 VS Code UI 的 prompt 拼接与 webview 展示；shared 只保留可被 MCP client 消费的结构化知识。

## HostServices adapter 设计

用 `HostServices` 统一表达 “工具核心需要宿主提供什么”，由 VS Code extension 和 MCP server 分别实现 adapter。

建议接口：

```ts
export interface HostServices {
  workspaceRoot: string;
  readonlyMode: boolean;
  writesEnabled: boolean;
  lsp: LspHost;
  diagnostics: DiagnosticsHost;
  filesystem: FilesystemHost;
  indexing?: IndexHost;
  projectProfile?: ProjectProfileHost;
  knowledge?: GameKnowledgeHost;
  completion?: CompletionHost;
  now(): number;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}
```

关键子接口：

- `LspHost.executeCommand(command, args, options)`：唯一语义入口；MCP 需要新语义能力时先在 LSP 增加 `cwtools.ai.*` 命令，再由这里调用。
- `DiagnosticsHost.getDiagnostics(filter)`：VS Code adapter 可读 Problems/LSP diagnostics；MCP adapter 优先从 LSP 或诊断缓存读取。
- `FilesystemHost.readTextFile/writeTextFile/list/glob`：强制 workspace sandbox；写入前检查 `writesEnabled`。
- `IndexHost.queryWorkspace/queryLocalisation/ensureReady`：首期可先由现有 `IndexService` 适配；MCP 可先用轻量 Node index 或通过 LSP 命令代理，避免复制 VS Code-only 实现。
- `CompletionHost.getCompletionContext(position)`：对通用 Agent 暴露补全候选、可用 trigger/effect/property/value、作用域上下文和结果来源，底层应来自 LSP。
- `GameKnowledgeHost.queryProfile/queryHints/queryDiagnosticKnowledge`：提供项目画像、游戏知识、诊断路由和工作流 guard；它只能补充语义证据，不能覆盖 LSP 判定。

现有 VS Code 侧 `AgentToolExecutor` 可逐步改成 `VsCodeHostServices + shared tool dispatcher`。首期可先保持 VS Code executor 不动，只让 MCP 使用 shared 的 schema/安全模块；后续再收敛 runtime 实现。

## MCP server 边界

`cwtools-mcp` 是薄适配层：

- 命名上必须明确：现有 `client/extension/ai/mcpClient.ts` 是 VS Code extension 作为 MCP client 去消费外部 MCP server；本计划新增的 `packages/cwtools-mcp` 是 MCP server，对外暴露本项目 PDX/LSP/Agent/game knowledge 能力。二者方向相反、互不冲突。
- 负责解析 CLI/config/env。
- 启动 MCP server，首期只支持 stdio。
- 注册首期工具。
- 将 MCP `callTool` 转成 shared dispatcher 调用。
- 将 LSP 验证、补全、解析和 Agent/game knowledge 能力统一包装为通用 MCP tools/resources。
- 管理 `readonly` / `writesEnabled`。
- 管理 LSP 进程或连接现有 LSP 的方式。
- 输出结构化错误，不泄露绝对路径以外的敏感 env。

建议 CLI：

```text
cwtools-mcp --workspace <path> [--game stellaris] [--stdio]
cwtools-mcp --workspace <path> --enable-writes
cwtools-mcp --workspace <path> --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block
```

默认策略：

- 未传 `--enable-writes`：所有工具按 read-only 注册；`write_localisation`、`edit_pdx_block` 要么不注册，要么注册后调用时返回明确拒绝。首期建议仍注册但 fail closed，方便客户端看到完整能力和错误原因。
- 传 `--enable-writes`：只开放显式允许的写工具；若未传 `--allow-tool`，可默认开放首期两个写工具，但仍保持 `.yml` guard。
- 任意 `.yml` 写入：只接受 `write_localisation`。
- 任意非 workspace 路径写入：拒绝。

## Schema 生成策略

`client/extension/ai/tools/definitions.ts` 和 `registry.ts` 仍是 upstream 事实源。第 0 阶段不手写 MCP schema。

推荐路线：

1. 在 `packages/cwtools-shared/src/tools/upstream.ts` 或构建脚本中只读引用 upstream definitions/registry。
2. 增加 `tools/generate-mcp-schema.ts`，从 `TOOL_DEFINITIONS` 中筛选首期工具。
3. 将 OpenAI function schema 转为 MCP input schema：
   - `function.name` -> MCP tool `name`
   - `function.description` -> MCP tool `description`
   - `function.parameters` -> MCP tool `inputSchema`
4. 同步 registry 元数据：
   - `isWrite`
   - `isReadOnly`
   - `effect`
   - `riskLevel`
   - `concurrencyClass`
5. 输出到 `packages/cwtools-shared/src/generated/mcpTools.ts`，并在文件头写明 generated source。
6. contract test 校验 generated schema 与 upstream registry 完全一致，禁止手改漂移。

实现初期如果不想提交 generated 文件，也可以运行时直接从 shared adapter 生成。但建议提交 generated 文件，便于 MCP 包独立编译、发布和 diff review。

## 第 0 阶段工作拆解

### 0.1 Workspace 与包底座

- 修改 `.gitignore`，取消忽略 `packages/` 源码，只忽略 `packages/*/dist`、`packages/*/coverage`、`packages/*/node_modules` 等产物。
- 在根 `package.json` 增加 npm workspaces：
  - `packages/cwtools-shared`
  - `packages/cwtools-mcp`
- 新增脚本：
  - `build:shared`
  - `build:mcp`
  - `test:contracts`
  - `generate:mcp-schema`
- 保持现有 `compile`/`verify` 可运行；不要让子包 tsconfig 破坏 extension 的 `rootDir: client`。

### 0.2 `cwtools-shared` 初始能力

- 建立纯 TypeScript package，输出 CJS 或 ESM 需与 MCP SDK 选择一致；为最小改动，首期建议 CJS。
- 抽出工具名、首期白名单、schema 类型、registry metadata 类型。
- 增加 `HostServices` 类型，不绑定具体实现。
- 抽出安全模块：
  - workspace path normalize
  - inside workspace check
  - localisation directory check
  - `.cwtools-ai` scratch write block
  - write enable gate
- 抽出 `write_localisation` 的纯文本 upsert 算法，并保留文件 IO 在 HostServices。

### 0.3 `cwtools-mcp` 初始 server

- 使用 MCP SDK 建立 stdio server。
- 从 shared 读取首期 schema 并注册工具。
- 实现 `NodeHostServices`：
  - workspace root 解析
  - filesystem sandbox
  - read-only/write gate
  - project profile 读取 `.cwtools-ai/project/profile.json`
- LSP 能力首期采用最小可用策略：
  - `get_diagnostics`、`query_scope`、`query_types`、`query_rules` 等先走 LSP process/command adapter。
  - 若某项当前只能由 VS Code API 获得，先返回 `unavailable` + 明确原因，并开 LSP `cwtools.ai.*` 补齐任务。
- `query_workspace_index`、`query_localisation_index` 首期优先通过 LSP/Node index，不能复制 `IndexService` 的 VS Code 依赖代码。
- 在 Phase 0 结束前做 IndexService 架构决策记录：
  - 路线 A：增加 LSP index 查询 command，让 VS Code 与 MCP 都走 LSP。
  - 路线 B：MCP 侧实现独立瘦 Node index，只做 query_workspace_index/query_localisation_index 所需的最小索引。
  - 不允许路线 C：复制 VS Code `IndexService` 并长期维护两个实现。

### 0.4 VS Code adapter 对齐

- 保持 `client/extension` 现有 Agent 工具行为不变。
- 新增 `VsCodeHostServices` 的薄 adapter 作为后续迁移目标，不强行一次性替换 `AgentToolExecutor`。
- 对 `definitions.ts`/`registry.ts` 的变更需要同时通过 extension 单测与 shared contract test。

### 0.5 Contract tests

最少需要以下测试：

- `schema.contract.test.ts`：首期 MCP 工具集与 upstream `TOOL_DEFINITIONS` 名称、description、parameters 一致。
- `registry.contract.test.ts`：首期 read/write、risk、effect、concurrency metadata 与 upstream `TOOL_REGISTRY` 一致。
- `readonlyPolicy.contract.test.ts`：默认 read-only 下 `write_localisation`、`edit_pdx_block` fail closed。
- `localisation.contract.test.ts`：
  - 只允许 `.yml`
  - 只允许 `localisation/`、`localisation_synced/`、`localization/`
  - 保留/创建 BOM 与 language header
  - existing key update，新 key append
- `pathSafety.contract.test.ts`：
  - 拒绝 `..` 越界
  - 拒绝 workspace 外绝对路径
  - 拒绝 `.cwtools-ai` scratch localisation 写入
- `mcpSchema.contract.test.ts`：MCP `tools/list` 返回首期工具和 JSON schema。
- `toolRouting.contract.test.ts`：MCP `callTool` 参数被传入对应 shared handler，错误格式稳定。
- `knowledge.contract.test.ts`：项目画像、诊断知识、workflow hints 能以结构化、无 VS Code 依赖的格式返回。

可复用 `client/test/sample` 作为 fixture；子包测试不要依赖 VS Code runtime。

## 分阶段交付计划

### Phase 0：同步底座与 contract

目标：仓库能编译两个新包，MCP schema 来自 upstream registry，默认安全策略和合约测试就位。

交付物：

- `packages/cwtools-shared` 与 `packages/cwtools-mcp` 初始目录。
- 根 workspace/test/build 脚本。
- generated MCP schema。
- `HostServices` 接口与 Node/VS Code adapter 骨架。
- read-only/write gate。
- game knowledge/resource skeleton。
- contract tests。

验收：

- `npm run generate:mcp-schema`
- `npm run build:shared`
- `npm run build:mcp`
- `npm run test:contracts`
- 现有 `npm run test:unit` 不因新增包失败。

### Phase 1：只读语义与知识工具可用

目标：stdio MCP 能在真实 Stellaris/PDX mod workspace 中提供只读语义能力和 Agent 可消费的项目/游戏知识。第一个真实集成探针必须是 diagnostics freshness，因为它决定 MCP 进程能否在没有 VS Code Problems panel 的情况下建立等价的 loading/stale/ready 语义。

交付物：

- `query_types`
- `query_rules`
- `query_scope`
- `get_diagnostics`
- `analyze_diagnostic_error`
- `query_project_profile`
- `query_workspace_index`
- `query_localisation_index`
- `get_pdx_block`
- project/game knowledge resources 或 read-only query tools
- diagnostic routing knowledge

验收：

- 先接 `cwtools.ai.getDiagnosticsFresh` / `waitDiagnosticsFresh` / `getValidationStatus`，定义 MCP 侧 `freshness`、`pendingKinds`、`validatedVersion`、`epoch`、`updatedAt`、`diagnostics` 的稳定返回形态。
- MCP client 通过 stdio `tools/list` 看到首期工具。
- MCP client 能通过 resources 或 tools 获取项目画像、localisation profile、诊断路由和 workflow hints。
- 在 `client/test/sample` 或真实 workspace 上能返回稳定结构。
- LSP 未 ready 时返回可行动的 `unavailable/loading`，不假装成功。

### Phase 1.5：补全、解析、定义与引用能力

目标：把后端 LSP 的补全和解析能力作为通用 MCP 能力开放，让外部 Agent 不依赖 VS Code UI 也能理解当前位置、AST 结构和跨文件关系。

交付物：

- `get_completion_at` 或 `query_completion_context`
- `document_symbols`
- `workspace_symbols`
- `query_definition`
- `query_definition_by_name`
- `query_references`
- diagnostics freshness/status command

验收：

- completion/context 结果包含当前位置 scope、候选 kind、候选来源和 LSP freshness。
- symbol/block 结果可被 `get_pdx_block` / `edit_pdx_block` 复用，不要求 Agent 全文读取大文件。
- definition/reference 结果能区分 workspace、vanilla、generated/index source。
- 无对应 LSP command 的能力先补 LSP，不在 MCP 包里重写语义。

### Phase 2：受控写工具

目标：显式启用后支持安全写入。

交付物：

- `write_localisation`
- `edit_pdx_block`
- 写入前路径/工具权限检查。
- 写后 cache/index invalidation hook。
- 写后诊断建议或自动 `get_diagnostics` 策略。

验收：

- 默认 read-only 拒绝写。
- `--enable-writes` 后仅允许首期写工具。
- `.yml` 只能由 `write_localisation` 写。
- `edit_pdx_block` 使用 LSP/document symbols 边界，不靠全文字符串猜测。

### Phase 3：Streamable HTTP 与发布打包

目标：在 stdio 稳定后添加 HTTP transport 与可发布构建。

交付物：

- Streamable HTTP transport。
- README/usage 示例。
- VS Code extension 内部可选启动 MCP server。
- package artifact 与版本策略。

验收：

- stdio 与 HTTP 使用同一 tool registry。
- HTTP 不绕过 write gate。
- 发布包不包含 VS Code-only runtime。

## LSP 能力补齐原则

禁止在 MCP 包复制或重写 CWTools/LSP 语义。由于现有 `cwtools.ai.*` 已覆盖 completion、scope、types、definition、scripted effects/triggers、enums、modifiers、variables、entity info、diagnostics freshness、validation status、fragment parsing 等能力，Phase 1/1.5 的默认假设是“优先接现有 command”。只有对照表确认缺口后，才新增 LSP command。

如果 MCP 需要新的语义能力：

1. 在 `src/LSP` / `src/Main` 增加或扩展 `cwtools.ai.*` command。
2. 在 VS Code adapter 中调用该命令。
3. 在 shared HostServices 中表达该能力。
4. 在 MCP adapter 中暴露为 tool handler。
5. 增加 contract/integration test。

优先补齐的 LSP command：

- `query_rules` 的 LSP 入口，返回 trigger/effect/scope_change/modifier 规则、scope 过滤、fuzzy suggestion 和规则来源。
- workspace/localisation index 的非 VS Code API 查询入口。
- document symbols / PDX block 边界查询入口。
- diagnostics freshness/status 查询入口。
- completion context 查询入口，返回候选、scope、rule/type source，而不是只返回 VS Code completion item 文本。
- definition/reference 查询入口，能标注 workspace/vanilla/generated/index 来源。
- project/game profile 查询入口，至少能暴露当前游戏、规则版本、配置加载状态和 vanilla cache 状态。

## 风险与注意事项

- `packages/` 当前被 `.gitignore` 忽略，这是第一个必须处理的仓库级阻塞点。
- 现有 `lspTools.ts`、`fileTools.ts` 直接 import `vscode`，不能直接搬到 shared。
- `IndexService` 当前依赖 VS Code workspace/findFiles/disposable。必须早定路线：LSP index command 或 MCP 瘦 Node index，不能复制一份长期分叉的 VS Code `IndexService`。
- `get_diagnostics` 当前语义绑定 VS Code Problems/LSP 状态；MCP 必须用 `getDiagnosticsFresh` / `waitDiagnosticsFresh` / `getValidationStatus` 定义 freshness/loading/stale 的等价来源。这不是普通接线活，是 Phase 1 的第一个硬集成验证点。
- `write_localisation` 是安全边界工具，任何 MCP 泛用写文件能力都不能覆盖它。
- submodule dirty 状态需要在实现前确认是否来自用户同步规则工作；本计划不处理该改动。

## 推荐首个实现 PR 范围

首个 PR 只做 Phase 0，不接真实 LSP 语义：

- 调整 `.gitignore` 与 npm workspace。
- 创建两个 packages。
- 从 upstream definitions/registry 生成首期 MCP schema。
- 实现 HostServices 类型、安全 gate、MCP stdio server skeleton。
- 所有首期工具 handler 先接 mock/dispatcher contract；真实语义工具在 Phase 1 接 LSP。
- 增加 contract tests，确保 schema 和安全策略不会漂移。

这样可以先把“单一事实源 + 子包边界 + 默认安全姿态”钉住，再逐个接入真实语义能力。
