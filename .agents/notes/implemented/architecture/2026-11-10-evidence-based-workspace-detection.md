# Agent Note: 基于证据分级的 Paradox/CWT 工作区识别

Status: implemented

## Problem

扩展与 MCP 曾把单个 `common/`、`events/`、任意 `.mod` 或 `metadata.json` 当作 Paradox 证据，普通项目因此可能启动语言服务。MCP 父目录扫描还会按枚举顺序选择第一个子项目；Standalone 在未指定游戏时隐式使用 Stellaris 规则与缓存。非支持项目虽然可在调用时拒绝，但仍披露全部工具和资源，无法消除外部 Harness 的固定上下文成本。

## Decision

### 证据与身份分层

`client/extension/workspaceGameDetection.ts` 是无 VS Code 依赖的检测真源，输出 `mod | vanilla | cwt-only | unsupported | ambiguous`、可选 `gameId`、实际匹配根、证据和排序后的候选项。支持判断与游戏识别分开：路径文本和游戏分数只在结构证据已经成立后选择具体游戏。

- 强证据包括 `descriptor.mod`、有效且根路径一致的 V4 项目 Profile、游戏专属嵌套目录、已知 Workshop App ID，以及当前工作区等于或位于已验证游戏数据路径内部。
- 非标准 `.mod` 必须解析出名称及路径/支持版本字段；`.metadata/metadata.json` 因没有可靠 schema，只能与内容目录和真实 PDX 文件共同构成组合证据。
- 单个通用目录不再通过。至少两个不同内容目录且存在有界查找到的 PDX 脚本/本地化文件，才构成组合证据。
- CWT 聚簇要求至少六个规则/日志文件且包含真实 `.cwt`，扫描排序、有界并忽略依赖与构建目录。祖先查找禁用递归 CWT 聚簇，避免扫描无关兄弟目录。
- 祖先只接受非递归 Mod/原版强证据；子目录检测收集全部结果，唯一匹配才使用其 `matchedAt` 作为 Standalone 工作区根，多个匹配返回 `ambiguous`。

### 扩展与 MCP 数据流

扩展启动、语言推断、项目画像和 MCP Bridge 都调用同一检测器。`determineServerStartMode` 接受项目类别：Mod/原版在无法确定游戏时进入 generic full 模式，CWT 聚簇进入 `cwt-only`，无证据项目保持 `none`。目录名叫 `game` 不再单独证明原版身份。Project Profile V4 的结构不变，只修正 `workspaceKind` 与游戏字段。

主扩展的 TypeScript `rootDir` 不能引用子仓库源码，因此 `tools/generate-mcp-detection.cjs` 将检测器、Workshop 适配和静态 Profile 证据表生成到 `cwtools-shared/src/generated/`。`generate:mcp-detection` 与 `check:mcp-detection` 分别更新和只读校验生成物；Standalone 只依赖生成后的共享包，Bridge 直接使用扩展真源。

### 能力门禁与降级

`TOOL_REGISTRY.mcpSupportsCwtOnly` 是 CWT 工具能力的真源，并随 MCP schema 生成。CWT-only 只披露 `get_diagnostics`、`analyze_diagnostic_error`、`get_completion_at`、`document_symbols`、`workspace_symbols`、`go_to_definition`、`find_references`，资源只保留诊断路由。

非支持/歧义项目的工具和资源和列表均为空，Standalone 不创建 LSP。扩展 Bridge 与 Standalone 都在调用/资源读取时再次检查，旧客户端缓存的工具不能绕过。代理在正常 Bridge 中使用扩展结论，连接旧扩展或扩展不可用时才使用本地生成检测器；工作区不匹配仍返回 `bridge_unavailable`，不会静默回退 Standalone。

Standalone 的语言初始化为显式 `--game`、无歧义检测结果、`cwt` 或 `paradox`。通用/CWT 模式不借用 Stellaris 规则或缓存。`--force-start` 只允许无证据根进入 generic 模式，不伪造游戏，也不从多个子项目中任选一个。默认只读与领域写入授权保持不变。

## Alternatives considered

1. **继续扩充顶层目录名单**：否决。目录名在普通软件项目中过于常见，无法解决误判。
2. **复制一份近似检测到 MCP 并各自维护**：否决。规则会漂移；采用主仓库真源、生成物和 `--check` 保持同一实现。
3. **让扩展直接运行时 import 子仓库或新增 npm 依赖**：否决。会破坏当前 `rootDir` 构建边界，并把独立发布周期耦合进扩展。
4. **非支持项目仍列出全部工具，仅在调用时拒绝**：否决。无法降低 Harness 上下文占用；空披露与调用门禁必须同时存在。
5. **游戏不明继续默认 Stellaris**：否决。generic `paradox` 明确承认不确定性，不错误套用游戏规则。
6. **父目录找到多个项目时按名称选第一个**：否决。确定性排序不等于正确选择，必须返回歧义并要求明确 `--workspace`。
7. **CWT-only 保留完整只读工具面**：否决。无游戏模型的工具会产生无效调用和额外 schema；只披露已验证的七项能力。

## Consequences

- 普通项目只有通用目录或元数据文件时不再触发 CWTools；特殊项目仍可通过 `--force-start`、`--game` 和 `--workspace` 显式指定。
- 扩展、Bridge 与 Standalone 对相同根目录共享证据语义；祖先不使用递归 CWT 证据，打开 CWT 仓库内部的孤立子目录时需要打开规则根或显式指定工作区。
- 唯一样本子项目会成为 Standalone 的实际路径沙箱根；多项目父目录不再被错误视为单个 Mod。
- 检测与 CWT 工具能力的生成物均须在子模块内测试、提交和发布，再更新根指针；不得手改生成文件。
- 本次不改变 F# 语义、Bridge 工作区身份匹配或 Project Profile V4 结构，也没有 UI 变更。后续默认写入策略由 [领域写入默认激活 Note](2026-11-10-default-domain-write-activation.md) 接管。
