# Agent Note: cwtools-node 宿主包、取消、后端能力握手与共享索敌权重

Status: implemented

## Problem

两个结构性问题在同一时期暴露：

1. **宿主能力绑死在 MCP 包里**。六个 Node 宿主模块（`nodeHostServices`、`lspProcessHost`、`projectDetect`、`projectSettings`、`revalidation`、`vscodeCache`）住在 `cwtools-mcp` 内，任何想在自己的进程里跑 CWTools 语义的宿主（编辑器扩展、CLI、测试桩）都必须先引入 `@modelcontextprotocol/sdk`，尽管这些模块与该 SDK 毫无关系。
2. **索敌权重有两份来源**。`client/extension/ai/targetingWeights.ts` 是公式的唯一实现，但 MCP 侧的 `query_targeting_weight` 只登记了工具名（`names.ts`）与 schema，dispatcher 里没有对应 case —— 也就是说 MCP 面对该工具的声明与行为是脱节的，而任何想复用的宿主都只能复制公式。

另外三处缺口：`LspCommandOptions` 只有 `timeoutMs`，没有取消通道，且 `LspProcessHost.executeCommand` 把所有异常统一转成 `unavailable`，调用方无法区分「后端不存在」和「我取消了」；后端没有版本/能力握手，宿主无法在付出加载代价之前判断对面是不是它能驱动的构建。

## Decision

2026-11-10 落地。子模块的依赖图改为严格单向：`cwtools-shared` ← `cwtools-node` ← `cwtools-mcp`。

- **`cwtools-node`（新建，0.1.0）**：`git mv` 迁入上述六个宿主模块与六个对应契约测试，导出传输无关的 `CwtoolsNodeHostOptions` 与 `createNodeHostServices(options)`。选项只含 `workspaceRoot`/`game`/`serverPath`/`serverArgs`/`gamePath`/`cachePath`/`rulesPath`/`enableWrites`/`allowedTools`/`forceStart`/`startupTimeoutMs`/`requestTimeoutMs`/`debug`/`logger`，**不含** stdio/http/MCP 传输字段。依赖闭包只有 `cwtools-shared`、`chokidar`、`vscode-jsonrpc`（契约测试断言依赖清单里没有 MCP SDK 字段）。未配置的路径由宿主自行补齐：`gamePath` 为空时 `detectGameInstall()` 依 `GAME_INSTALL_LAYOUT` 从 Steam 库（Windows 注册表 → 常见路径 → `libraryfolders.vdf` 追加库）发现原版目录，要求目标含 `common/`，CK3/VIC3/Imperator 取 `game` 子目录、Victoria 2/Imperator 兼容别名；规则目录由 `rulesDirectoryCandidates()` 依次尝试工作区、调用方 cwd 与检出根下的 `release/rules/<game>/config` 与 `submodules/cwtools-<game>-config/config`；解析后的 game path 同时进入 vanilla 缓存探针与 LSP `caches.<game>` 配置。诊断按工作区配置的过滤列表过滤（`.vscode/settings.json` → `stellarisLanguageServices.ai.ignoredDiagnostics`，消息子串匹配），被过滤条目计入 `suppressedCount`；`honourWorkspaceIgnoreList` 默认 true 并允许宿主关闭，DSH 插件显式启用它与 VS Code 扩展保持一致。`buildCwtoolsConfiguration()` 另接受 `errorIgnoreCodes` / `errorIgnoreFiles` / `localisationDiagnosticFilter` 三个选项，分别写入 `errors.ignore` / `errors.ignorefiles` / `errors.localisationFilter`，原版错误固定 `errors.vanilla = false`。`cwtools-mcp` 的 `index.ts` 与六个 `hosts/*` 深路径保留兼容 re-export，旧导入不受影响。
- **`cwtools-shared`（0.3.0）**：新增 `tools/callHandler.ts`，把原先住在 MCP 包的 `createToolCallHandler`（写策略门禁 + generic 警告 + vanilla 溯源 + 加载就绪标注）上移为传输无关实现，返回 `handler(name, args?, context?)`；`toMcpCallToolResult` 留在 MCP 包。`host/lsp.ts` 增加 `signal?: AbortSignal` 与 `isAbortError`/`createAbortError`/`throwIfAborted`/`rethrowIfAborted`；`SharedToolDispatcher` 增加可选的第四个参数 `context`，旧的三参调用保持兼容。
- **诊断复验同样可取消**：`DiagnosticsHost.getDiagnostics(filter, { signal })`、`RevalidationCoordinator.ensureFresh(absFile, signal)` 与其 drain 轮询都传播 abort；复验里的 `catch` 用 `rethrowIfAborted` 放行中止，避免把一次取消变成「空但 fresh」的诊断结果。
- **取消不被吞，且真的取消后端**：`LspProcessHost.executeCommand`/`sendRequest`/`request` 接受 `signal`；每次请求都建一个 `vscode-jsonrpc` 的 `CancellationTokenSource`，把 AbortSignal 与 deadline 都接到它的 `cancel()`，因此 abort 或超时会向语言服务发出真正的 `$/cancelRequest`，而不是只放弃 Promise。脚本化后端 fixture 会记录收到的取消，测试据此断言「后端自己观察到取消」。AbortError 直接抛出，不转成 `unavailable`；`throwIfAborted` 在 dispatcher 与每次 LSP 调用前短路。timer 与 abort listener 都在 `finally` 释放。
- **原生活跃宿主复用**：扩展在既有 manifest 中增加 `cwtoolsNativeRpcUrl`/`cwtoolsNativeHealthUrl`，通过独立 `/cwtools/*` 路由只转发必需只读命令与五个文档/导航 LSP 方法，不暴露 MCP 方法。`NativeBridgeLspHost` 实现同一 `LspHost`，注入 `createNodeHostServices` 后不创建子进程；发现严格校验外部 manifest、pid、精确工作区、健康与协议。缺失/畸形/失效/不匹配/未活跃/连接失败或超时允许独立回退，取消不被吞；协议或能力不兼容返回 `backend_incompatible`，绝不双开。
- **后端能力握手**：新增只读命令 `cwtools.ai.getHostCapabilities`（`src/LSP/Commands.fs` 的 `HostCapabilitiesProtocolVersion = 1` 与命令表；`src/Main/Program.fs` 里与 `getValidationStatus` 同级、`gameObj` 匹配之前直接返回，因此游戏加载前可答）。`serverVersion` **不是**手写常量：优先读取离服务端最近的 `release/package.json`，开发构建与 VSIX 共用这一版本来源；只有清单缺失时才回退到程序集 InformationalVersion/AssemblyVersion（裁掉 `+` 后元数据）。`package.ps1` 另外用同一 release 版本的 `-p:Version=` 保证发布程序集回退一致。它不是模型可见工具，不进任何 MCP/Agent schema。Node 宿主在 **initialize 之后、`initialized`/`workspace/didChangeConfiguration` 之前**握手——后者才是触发游戏模型加载的通知，因此不兼容的后端在加载开始前就被拒绝。`parseHostCapabilities` 区分 `legacy`（不答或答 unavailable）/`malformed`（字段类型错）/`protocol`（版本不匹配）/`incomplete`（空命令表或缺必需命令），任一失败都先 `dispose()` 释放子进程、记录 `incompatible` 阻止后续 respawn，并让调用返回 `backend_incompatible`（`executeCommand` 与 `sendRequest` 形状一致）。
- **必需命令集**：`REQUIRED_BACKEND_COMMANDS` 共 29 条，覆盖 37 个只读工具实际用到的全部 LSP 命令（诊断/复验、补全与导航、语义模型、项目图、本地化审计、scripted 类型与枚举、七个 Shader 命令），`cwtools.ai.getHostCapabilities` 自身不在其中。契约测试扫描 `cwtools-shared` 与 `cwtools-node` 的真实调用点，断言「必需集 == 调用集」，并逐条删除任一命令证明后端会被拒。
- **索敌权重唯一实现**：`targetingWeights.ts` 与其 9 项算例测试 `git mv` 进 `cwtools-shared/src/tools` 与 `src/test`，dispatcher 新增 `query_targeting_weight` case（纯计算，无宿主无 IO）。VS Code 侧的 `agentTools.ts` 与 `targetWeightPanel.ts` 改从 `cwtools-shared` 导入；根与 release 的 `package.json` 声明该依赖，`package.ps1` 把构建产物 stage 进 `release/node_modules/cwtools-shared`，`release/.vscodeignore` 只剔掉 `src` 与 `tsconfig*.json`。
- **启动与请求预算**：两层选项都增加 `startupTimeoutMs`（默认 30s，只约束 spawn + initialize + 握手）、`requestTimeoutMs`（默认 20s，覆盖后续请求与诊断复验）和 `debug`（默认仍尊重 `CWTOOLS_MCP_DEBUG`）；`serverArgs` 从 Node 宿主透传到 LSP 宿主，支持 `node server.js` 形式的脚本后端。
- **过期启动防护**：`LspProcessHost` 维护 `generation`，`dispose()` 自增；异步启动捕获自己的 generation，握手通过、安装 watcher、记录 exit、写入不兼容状态前都校验它，因此 `dispose()` 之后迟到的启动不会复活 watcher，已释放的子进程也不会被误记为新一代的启动失败。
- **中性别名**：`cwtools-shared` 的 `mcpSchema` 新增 `listCwtoolsToolSchemas`/`isCwtoolsToolAvailable`/`getCwtoolsToolSchema`，与 MCP 命名指向同一实现（契约测试断言两者输出一致），供不涉及 MCP 的宿主使用。
- **非递归 staging**：`package.ps1` 不做任何递归目录删除，Webview、规则与共享依赖均按名称合并 staging；只有明确点名的旧文件才单独清理，避免 junction/symlink 把清理带到目标目录。
- **版本**：`cwtools-shared` 0.3.0、`cwtools-node` 0.1.0、`cwtools-mcp` 0.3.0；只改包元数据，未发布。

## Alternatives considered

- **把 `createToolCallHandler` 放进 `cwtools-node`**：会让纯契约宿主为了调一个工具而拖进 chokidar 与进程管理。放 `cwtools-shared` 后，DSH 这类消费者只需一个零传输依赖的包。
- **`release/package.json` 用 `file:../submodules/...` 声明 cwtools-shared**：实测 `vsce` 的 `npm list --production` 校验会报 `invalid: cwtools-shared@0.3.0` 并中断打包。改为与 `sql.js`/`steamworks.js` 同款做法——声明版本号、由脚本把已构建目录 stage 进去。
- **握手失败后允许重试启动**：会让一个确定不兼容的后端被反复拉起。改为记录 `incompatible` 后永久返回 `backend_incompatible`。
- **握手响应里附带 capabilities 详情**：内部命令只需要「我能不能驱动你」，多带字段等于给未发布的协议开新口子。只返回 `protocolVersion`/`serverVersion`/`commands`。

## Consequences

- 任一宿主（MCP、扩展、DSH、测试桩）现在共用同一份工具调用语义与同一份索敌公式；公式再修一次，三处展示同时变。
- `cwtools-mcp` 的直接依赖少了 `chokidar` 与 `vscode-jsonrpc`（已随宿主模块迁走），这三个包不再是 MCP 包的实现细节。
- 旧后端（不答 `cwtools.ai.getHostCapabilities`）现在会被明确拒绝，而不是在半可用状态下产出空结果。升级 VSIX 与 `npx cwtools-mcp` 需要同步。
- 实测：`cwtools-shared` 90 项、`cwtools-node` 63 项、`cwtools-mcp` 24 项契约测试全绿；`dotnet build src/Main/Main.fsproj` 0 警告 0 错误；`src/Main/HostCapabilities.Tests.fsx` 19 项通过；`npx tsc -p .config/tsconfig.extension.json` 通过；VSIX 包含 65 个 cwtools-shared 文件且不含 `src/`。另经真实 DSH 调用验证 query_types ready、索敌数值、诊断 pending、默认无写入和本地化 BOM/越界行为。