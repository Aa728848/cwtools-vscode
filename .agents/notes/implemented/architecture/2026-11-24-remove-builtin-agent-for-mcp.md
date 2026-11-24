# Agent Note: 移除内置 Agent 并统一 MCP/DSH 语义宿主

Status: implemented

## Problem

内置 Agent 的 Runner、Provider、聊天 UI 与通用 Harness 和外部 Agent 重复；MCP 又依赖 AgentToolExecutor，导致无法单独删除。此前 [PTC 移除与原生统一](2026-10-10-ptc-mode-removal-and-native-unification.md) 因 MCP 能力缺口而否决删除；本次用户明确要求在同一重大版本中彻底移除，并要求 Bridge、Standalone 与 DSH 同步。

## Decision

- 删除 Chat、Agent Manager、Runner、Provider/订阅号池、行内 AI 补全、内置 MCP Client 和关联清单；不删除旧用户数据。
- `cwtools-shared/src/tools/catalog.ts` 取代扩展内 definitions/registry，成为 58 个 Paradox 领域工具的 schema 与元数据事实源；不迁移通用文件、Git、网页、计划或记忆工具，`write_design_blueprint` 明确排除。
- Bridge 改为注入 `HostServices` 与 `createToolCallHandler`，不再构造 Agent 会话。Standalone 与 DSH 复用同一 dispatcher。
- 新增 `initialize_project`：迁移确定性 V4 profile builder 与 V7 LSP SQLite 导出，支持 full/incremental、single-flight、取消、真实 readiness 等待、部分/失败 manifest；CWTOOLS.md 只在缺失时创建。
- 补齐 override、Interface、ID 验证、Scope Bridge、资产、LSP 状态、诊断设置与 Archetype；五项既有 Standalone 写入实现真实执行，媒体使用无 shell 的 spawn 参数数组，部署支持二进制。
- GUI Preview 留在独立 GuiPanel。新增 `capture_gui_preview` 返回有界 PNG/Before/After/Diff artifact 和选择/版本元数据，不恢复 Agent 的自动验证回合。
- DSH 保留默认只读和逐项写授权，目录由 shared 驱动；Native IDE 操作通过显式白名单 RPC 仅在活跃宿主支持时披露。

## Alternatives considered

- 保留 Agent 作为兼容壳：会继续维持 Provider/Runner 与外部 Agent 的重复实现，且本次目标明确要求物理删除。
- 把 schema 继续从扩展生成：删除后生成源不存在，也会让 MCP 与 DSH 再次漂移，因此转为 shared 自有目录。
- 把 GUI 截图重新注入 Agent：违反外部 Agent 自主计划/核对的边界，改为按需 artifact。
- 递归删除旧目录/缓存：违反仓库安全约束；所有删除均使用明确文件名。

## CI 构建顺序

- `cwtools-mcp` 子模块的 `packages/*/dist/` 被 gitignore，扩展的 `import { createNodeHostServices } from 'cwtools-node'` 依赖其类型产物，因此 CI 的每个 TypeScript job 都必须先在工作区构建。
- 统一使用 `npm run build -w cwtools-node`：`cwtools-node` 的 `prebuild` 会先构建 `cwtools-shared`，一次命令覆盖两个包，与 `release.yml` 保持一致。
- 拆分后根仓库不再提供 `check:mcp-schema` 脚本，schema 事实源位于 `cwtools-shared/src/tools/catalog.ts`，由 `submodules/cwtools-mcp` 的 `npm run test:contracts` 覆盖，CI 不再引用该脚本。

## Consequences

- 扩展职责收敛为语言服务、可视化、项目知识与 MCP/Native 宿主；外部 Agent 负责通用 Harness。
- 宿主能力集合参与 tools/list 与调用门禁，Standalone 不再披露固定 unavailable 的 IDE 工具。
- 初始化等待 `loading.phase=ready`，避免 modelReadyForKnowledgeExport 提前为真时导出空响应；真实 Standalone smoke 已生成并查询 110,747,648 字节 V7 数据库。
- 根仓库 compile/typecheck/test:unit、docs/release 校验通过；shared/node/mcp 契约与 DSH 80 项测试、构建通过。
