# Agent Note: 诊断总数、就绪状态与工具失败信号的失真修复

Status: implemented

## Problem

2026-11-10 一次真实 mod 工作区的工具审计（14 个工具）暴露了四类「假信号」，全部可在日志里复算：

1. **假的零错误**。全区 1337 条诊断、其中 578 条 error；`severity:"error"` 在 limit 5/40/50 下返回 0 条而 `totalCount` 分别是 573/538/528 —— 恰好都是 `578 - limit`。原因是 `applyDiagnosticIgnoreList` 只对分页后的当页做忽略匹配，却用「当页被吞掉的条数」去减全库匹配数：总数因此随 `limit` 变化，而被吞掉的条目没有任何可见说明。
2. **假的就绪**。`createToolCallHandler` 的 `ready` 标志一旦为真就永久缓存；后端进程消失后 `grep` 不到复检，`readiness.ready` 仍为 `true`。同时全区诊断分支把 `status` 写死为 `fresh`，忽略服务端真实的新鲜度。
3. **假的成功**。LSP 命令返回 `ok:false`（符号不存在、类型名拼错）时，`go_to_definition`/`query_types` 被包成 `ok:true, status:"ready"`，失败藏进 `data.ok/error`；而 `get_pdx_block` 同样情形直接抛错，两类工具契约相反。
4. **假的交叉引用**。`find_references` 的词法回退标 `status:"ready"`，警告塞在 `data._warning`，调用方只读 `total` 就当成语义引用。

另外三处聚合层缺口：同一诊断被存两份（`exe_policies.txt:462` 与 `:468` 各出现两次），`totalCount` 因此不是问题数；`file` 参数在 schema 里写着「路径子串」，实现却按精确路径解析，传符号名时静默返回 `stale` 空结果；`query_types` 对未知类型名返回 `totalCount:0`，与「类型存在但没有实例」不可区分。

## Decision

- **忽略清单只标注、不改总数**（`cwtools-node/src/hosts/projectSettings.ts`）：`suppressedCount` 继续累加，`totalCount` 保持服务端全库匹配数；`get_diagnostics` 在顶层 `warnings` 说明「当页有 N 条被工作区忽略清单隐藏，它们仍计入 totalCount」。
- **计数与新鲜度原样透出**（`cwtools-node/src/hosts/nodeHostServices.ts`、`cwtools-shared/src/host/diagnostics.ts`）：全区结果带 `errorCount`/`warningCount` 与 `freshness`；服务端（`src/Main/Program.fs` 的 `cwtools.ai.getAllDiagnostics`）新增 `freshness`/`pendingGlobalKinds`，按 loading/validation/pending 状态计算，不再由客户端硬编码。
- **未知文件是错误不是空**（同上）：`file` 解析不到磁盘文件时返回 `{ok:false, code:"file_not_found"}`，schema 描述改为「绝对路径或工作区相对路径」，删掉不存在的子串语义。
- **severity 恢复为精确过滤**（`src/Main/Program.fs`）：与文档「Filter by severity」和扩展内实现一致，不再做累计阈值（`warning` 不再连带 error）。
- **聚合去重**（`src/Main/Program.fs`）：`getAllDiagnostics` 先按「小写文件 + 行 + 列 + code + message」去重，再计数与分页；同一位置只出现一次。
- **命令级失败即工具级失败**（`cwtools-shared/src/tools/toolHandlers.ts`、`tools/symbols.ts`）：`record.ok === false` 映射为 `ok:false`（码 `lsp_command_failed` / `definition_not_found`），`error.message` 取命令自带文本。
- **词法回退值得标注**（`tools/symbols.ts`）：`status:"partial"`、顶层 `warnings`、`data.evidence:"lexical"`。
- **未知类型名可区分**（`src/Main/Program.fs`）：`queryTypes` 两个分支都返回 `typeKnown`。
- **参数校验**（`tools/toolHandlers.ts`）：`explore_pdx_project` 的 `exact` 必须是布尔且需要非空 `query`，否则 `invalid_arguments`（此前字符串被静默当作 false，空 query 退化成按类型模糊遍历）。
- **就绪状态会失效**（`cwtools-shared/src/host/readiness.ts`、`tools/callHandler.ts`）：缓存命中在结果 `status:"unavailable"` 时强制复检；`reason === "lsp_unavailable"` 的结果保留原失败/回退状态，不再被改写成 `loading`。

## Alternatives considered

1. **在忽略清单层重算 totalCount（减去全部被抑制条目）**：否决。宿主只看到一页，无法知道未返回页面里被抑制的数量；修正后总数至少不再随 `limit` 漂移，完整口径由服务端 `errorCount` 提供。
2. **保留累计阈值并只改文档**：否决。扩展内实现与文档都是精确过滤，两面对同一参数给出不同数量比文档歧义更糟。
3. **把 `file` 实现成真正的子串匹配**：否决。多文件命中时语义不明确，且会导致无法界定返回哪个文件的分区；显式报错比模糊匹配更易于调用方纠正。
4. **让 `ok:false` 命令继续返回成功包**：否决。调用方据此得出「查询成功且没有结果」的结论，正是本次审计里最难发现的误导。

## Consequences

- 审计中的四个数字现在自洽：`errorCount` 为 578、`severity:"error"` 的 `totalCount` 也是 578（与 limit 无关），当页被抑制时返回空但带 `suppressedCount` 与 `warnings`。
- 工具契约变化：`query_types` 增加 `typeKnown`；`find_references` 词法回退从 `ready` 变 `partial`；`go_to_definition` 缺符号从 `ok:true` 变 `ok:false`；`get_diagnostics` 的 `file` 不再接受子串。
- 验证：`cwtools-mcp` 契约测试 195 项（shared 95 / node 76 / mcp 24）通过；新增 `failureSignals.contract.test.ts` 五项覆盖命令失败、词法回退、`exact` 校验与掉线就绪；`dotnet build src/Main/` 0 警告 0 错误。
- 未覆盖：真实 LSP 宕机的主机级复现仍依赖外部进程，本次以注入 `active_unavailable` 的桩验证；F# 聚合去重未加 `dotnet fsi` 回归脚本，依赖契约测试与构建。
