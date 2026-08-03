# Contribution Guide / 贡献指南

[English](#english) | [中文](#zh-cn) | [Project Overview / 项目介绍](README.md) | [Architecture / 架构文档](ARCHITECTURE.md) | [CWT Rule Guide / CWT 规则指南](docs/cwt-rule-config.md) | [Diagnostic Codes / 诊断码](docs/diagnostic-codes.md) | [AI Agent Guide](AGENTS.md)

<a id="english"></a>

## English

### Contribution Guide

Thank you for your interest in **Stellaris Language Serves**. This document is for contributors, explaining how to set up the environment, run the project, submit changes, and verify your code. For architectural background, see [ARCHITECTURE.md](./ARCHITECTURE.md); for the AI Agent quick check sheet, see [AGENTS.md](./AGENTS.md). Claude Code can also use the compatibility entry at [CLAUDE.md](./CLAUDE.md).

#### Environment Requirements

| Tool | Recommended Version | Purpose |
| --- | --- | --- |
| Node.js | 20.x or higher | TypeScript compilation, Rollup Webview bundling |
| npm | 10.x or higher | Dependency installation and scripts execution |
| .NET SDK | 10.0.x | F# Language Server and `CWTools Server` build |
| VS Code | 1.90 or higher | Extension development host and testing |
| Git | Latest stable | Source code and submodule management |

The repository's `global.json` currently specifies .NET SDK version `10.0.301` and allows `latestMinor` roll-forward.

#### Clone and Install

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

If you have already cloned but submodules are missing:

```bash
git submodule update --init --recursive
```

The default F# build uses `submodules/cwtools`. If you need to point to a local CWTools repository, you can create a local configuration in `src/Main/cwtools.local.props`:

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

Change `CwtoolsPath` to your actual path. Do not commit this local path configuration.

#### Submodule Responsibilities

This repository has two important submodules:

- `submodules/cwtools/`: upstream CWTools F# library. It owns core parser,
  validator, game model, shader, and scripted-type semantics used by
  `src/Main/`. If you change it, commit inside the submodule first, then commit
  the updated submodule pointer in the root repository.
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rule configuration data.
  It is the development/fallback rules baseline used by rules sync reports and
  packaging. Treat changes here as rules-data updates, not extension runtime
  code changes.

When a change touches both submodules, explain the boundary clearly in the PR.

For CWT rule authoring details, see [CWT Rule Configuration Guide](./docs/cwt-rule-config.md).

#### Common Commands

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile TS extension and bundle Webview with Rollup |
| `npm run lint` | Run ESLint 9 checks on `client/` |
| `npm run test:unit` | Run unit tests under `client/test/unit/**/*.test.ts` |
| `npm run test` | Compile and run VS Code integration tests |
| `npm run check:release` | Verify release package metadata and necessary output |
| `npm run verify` | Integrated local validation: lint, compile, unit tests, release gate |
| `npm run generate:mcp-schema` | Regenerate MCP tool schema from upstream `definitions.ts`+`registry.ts` (writes into `submodules/cwtools-mcp`) |
| `npm run build` / `test:contracts` (inside `submodules/cwtools-mcp`) | Build the MCP packages and run MCP contract tests (schema drift, read-only policy, tool routing, deep tools) |
| `dotnet build src/LSP/` | Build LSP protocol and parsing layers |
| `dotnet build src/Main/` | Build `CWTools Server` |

`npm run compile` performs:

1. `tsc -p ./.config/tsconfig.extension.json`
2. `rollup -c`

Rollup currently bundles 8 Webview entry points:

- `client/webview/chatPanel.ts`
- `client/webview/agentManager.ts`
- `client/webview/guiPreview.ts`
- `client/webview/solarSystemPreview.ts`
- `client/webview/eventChainPreview.ts`
- `client/webview/techTreePreview.ts`
- `client/webview/entityPreview.ts`
- `client/webview/particlePreview.ts`

Stellaris rules synchronization scripts:

```bash
npm run rules:stellaris
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
```

`rules:stellaris:report` compares the latest game `script_documentation` log, vanilla `common/`, and the CWT config baseline, generating a self-contained HTML report (`tools/rules-sync/report.ts`, automatically opens in the browser by default, disable with `--no-open`). For details, see [tools/rules-sync/README.md](./tools/rules-sync/README.md).

When a Stellaris install is available, `rules:stellaris:report` also parses the `gfx/FX` corpus through CWTools, fingerprints `stellaris.exe`, and auto-merges the Shader ABI files (`config/shader/abi-catalog.json`, `abi-audit.json`, `renderer-contracts.json`) before rendering the report. Reviewed catalog entries carry forward while their declarations still exist; every other scanned Effect declaration is registered with `automatic_inventory` evidence, and entries or renderer contracts whose declarations vanished are removed. Pass `--no-shader-abi` for a fully read-only report.

#### Run and Debug

1. Open the repository root directory with VS Code.
2. Press `F5` or execute `Run and Debug: Start Debugging`.
3. VS Code will open a new Extension Development Host window.
4. After editing code, restart the debug session or reload the window.

To debug Webviews:

1. Open the target panel in the Extension Development Host.
2. Execute `Developer: Open Webview Developer Tools`.
3. Inspect DOM, console, network requests, and breakpoints inside DevTools.

#### Project Structure Quick Look

```text
client/
  extension/                  VS Code Extension Host
    ai/                       AI assistant — full subsystem
      chat/                   Webview ↔ Host communication bridge
      orchestrator/           Multi-agent DAG, blackboard, sandbox, conflict & quality gates
      runner/                 Execution pipeline: compaction, checkpoint, scheduling,
                              permissions, ledger, reducers, replay, read tracking, memory
      tools/                  Tool schemas, registry, permissions, arg repair, handlers,
                              diagnostic metadata, fuzzy replacer suite, schema flattening
      prompt/
        sections/             Base system prompt and per-mode prompt sections
      providers/
        models/               Default model configs, capabilities, pricing
      agentRunner.ts          Main reasoning loop
      agentTools.ts           Tool dispatch hub
      aiService.ts            Multi-provider AI client
      promptBuilder.ts        Prompt construction facade
      projectProfile.ts       /init project scanning and profile
      chatInit.ts             /init command handler
      gameKnowledge.ts        Per-game PDXScript knowledge blocks (9 games)
      skills.ts               SKILL.md index (built-in/user/project) + run_skill body loading
      memoryParser.ts         Private structured long-term memory and bounded consolidation
      workspacePaths.ts       AI storage root, topic/scratch dirs
      workspaceSandbox.ts     Path sanitization and scope classification
      runnerPolicy.ts         Mode-based tool filtering and iteration limits
      planModeGuard.ts        Plan-mode write guard (plan + artifact files only)
      usageTracker.ts         Cumulative token usage and cost tracking
      diffEngine.ts           Structural diff engine
      fileCache.ts            Bounded file content cache
      errorReporter.ts        Structured error reporting
      toolCallParser.ts       Non-standard tool call parsing
      jsonRepair.ts           Incomplete JSON repair
      inlineProvider.ts       AI inline (FIM) completion for PDXScript
      mcpClient.ts            MCP stdio/SSE client
      types.ts                All AI type definitions
      workflowRegistry.ts     Workflow metadata and tool policies
      workflowI18n.ts         Workflow localization
    indexing/                 Shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           Multi-game profile registry
    extension.ts              Activation and command registration
    diagnosticI18n.ts         Client-side diagnostic Chinese translation + fix advice
    fileExtensions.ts         Case-insensitive extension matching helpers
    fsCaseInsensitive.ts      Case-insensitive path resolution (Linux/macOS)
    pathScope.ts              Shared isPathInsideOrEqual / foldPathCase helpers
    vanillaCompare.ts         Vanilla file diff and block migration
  webview/                    Browser-sandboxed Webview scripts
    chat/                     Extracted chat and Agent Manager modules (22 files)
    messageRenderer.ts        Message rendering (cache sparkline, annotations)
    svgIcons.ts               High-fidelity SVG icon library
    *Preview.ts               GUI, solar system, event chain, tech tree, entity previews
  test/
    unit/                     ts-mocha unit tests (60 files)
    suite/                    VS Code integration tests

src/
  LSP/                        Reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  Resource strings
  CSharpExtensions/           Helper project

docs/
  diagnostic-codes.md         CWxxx diagnostic code reference (codeDescription targets)

packages/
  cwtools-shared/             Read-only MCP core: generated schema, HostServices,
                              path/rules safety, vanilla-cache + readiness, knowledge
  cwtools-mcp/                MCP stdio/HTTP server: CLI, NodeHostServices,
                              LspProcessHost, vscodeCache detection, esbuild bundle

tools/
  rules-sync/                 Stellaris rules scan/check/update/report tooling
  generate-mcp-schema.cjs     Generates MCP tool schema from upstream definitions

submodules/
  cwtools/                    Upstream CWTools F# library
  cwtools-stellaris-config/   Stellaris CWT config data
```

#### Development Guidelines

##### TypeScript and Extension Host

- Reuse existing module styles and local helpers. Avoid introducing new abstractions for minor modifications.
- Avoid using `any` without a reason in production code. Prefer `unknown` and type guards for unknown data.
- Pay attention to ESLint 9 async rules: `no-floating-promises`, `no-misused-promises`, and `prefer-promise-reject-errors`.
- For extension/AI error reporting, prefer `ErrorReporter` over bare `console.error`.
- Put user-visible Chinese text in the existing message/i18n modules where practical:
  `client/extension/ai/messages.ts`, `client/extension/ai/workflowI18n.ts`, and `client/webview/chat/i18n.ts`.
- Make localized, verifiable changes when modifying large files. Avoid unrelated formatting and restructuring.

##### Webview

Webviews run inside a browser sandbox:

- **Do NOT** import `vscode`, `fs`, `path`, or any Node.js-only API.
- Do NOT use `require()`.
- Communication with the Extension Host must go through `postMessage`.
- CSS must use VS Code theme variables, e.g., `var(--vscode-editor-background)`.
- Animations should support `prefers-reduced-motion`.
- Three.js/WebGL panels must release the renderer, geometries, materials, textures, workers, event listeners, and animation loops on disposal.
- When adding new chat UI logic, follow the pattern in `client/webview/chat/`.
- Chat panel and Agent Manager share host-side state; check `AgentUiBroadcaster`, `AgentSessionCoordinator`, `ArtifactStore`, and `ai/chat/bridge.ts` for cross-surface sync.
- **Sandbox & I/O Isolation Boundary (ReadTracker)**: Do NOT perform file operations or fetch file trees/metadata directly in the Webview. I/O tracking logic (like `ReadTracker`) executes only in the Extension Host. The frontend strictly acts as a data display layer, delegating all file accesses to the Host via `postMessage`.
- **Prompt Cache Sparkline**: When the model supports caching and hits or creates prefix caches (e.g. DeepSeek, Claude), the backend emits `cache_stats` events. The frontend `messageRenderer.ts` renders these as a three-bar sparkline card (Green for hit / Blue for create / Orange-Yellow for miss). If modifying cache discount rates or persistence, verify `pricing.ts`, `UsageTracker`, and the rendering logic in `agentManager.ts` / `chatPanel.ts` synchronously.
- **UI Icon Guidelines**: Do not use bare emojis (e.g. ⚡) in critical UI areas like the Token Dashboard. Use SVGs with inline styling supporting `stroke="currentColor"` for theme adaptability and vertical alignment.

##### Platform and Indexing

- Put new game-specific differences in `client/extension/gameProfiles.ts` instead of scattering hardcoded values.
- Reuse `IndexService` for new localization, symbol, and asset queries. Avoid duplicate workspace scanning.
- Keep pure logic of `IndexService` in `locParser.ts` / `workspaceSymbolParser.ts` for unit testing.
- When adding query dimensions, consider workspace/vanilla sources, freshness / `fileVersion` metadata, limits, and caching boundaries.

##### AI Agent

When adding or changing an AI tool, update the coordinated surfaces together:

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts` (if access policies change)
5. `client/extension/ai/agentTools.ts`

Key constraints for tools:

- `tools/registry.ts` is the single source of truth for mode gating, read/write classification, and sub-agent availability; it derives `effect`, `riskLevel`, and `concurrencyClass`.
- Every model-visible tool must pass the enforced `runner/policyEngine.ts` boundary before its handler. Do not add shadow-only permission paths or handler-local policy bypasses.
- Structure reading is preferred over shell commands: prioritize `query_workspace_index`, `document_symbols`, `get_pdx_block`, and `get_file_context`.
- `run_command` must be classified by `runner/commandPreflight.ts` risks. Extra cwd/network approvals keep the OS sandbox enabled; only the explicit `unsandboxed` field may request a one-shot bypass. `networkHosts` is approval/audit metadata: current shell backends enforce broad network allow/deny, not hostname filtering. Captured background commands return a `processId`; process control uses `list_processes`, `read_process`, `write_process_stdin`, and `terminate_process`.
- `runner/permissionPolicy.ts` only allows low-risk pre-approved rules; `cwdScope` validation must use `path.relative`, not prefix tests.
- File writes go through `PartitionedWriteQueue` in path dictionary order.
- Localisation `.yml` files must use `write_localisation`, not generic text writes.
- Multi-agent collaboration uses `dispatch_agents`, `query_blackboard`, and `merge_results`; sub-agent dispatches must be sandboxed by `orchestrator/subAgentSandbox.ts`.
- Skills: `SKILL.md` (built-in/user/project) is indexed by `skills.ts`. The prompt builder only injects a slim index. Full skill contents are loaded on demand via `run_skill` to save prompt tokens.
- Plan mode writes are guarded by `planModeGuard.ts`: only implementation plans and plan/blueprint/walkthrough output files are write-authorized; all other writes are blocked.
- Read-only modes (plan, explore, review, script_reviewer, orchestrator, script) only allow `status` and `diff` for `git_ops`, guarded by `planModeGuard.ts`'s `validateGitOpsForMode` before execution.
- `write_file`, `edit_file`, and `replace_lines` are the complete shared source-editing surface for General and Paradox execution. For PDXScript, obtain exact context with `get_pdx_block`, then make the smallest guarded `edit_file` or `replace_lines` change so untouched comments and text remain stable.
- The executable tool paths for `apply_patch`, `multi_replace_file_content`, and `edit_pdx_block` have been removed; Webview-only historical rendering may still recognize their old names. `ast_mutate` remains retired; `agentTools.execute()` redirects it to `edit_file`/`replace_lines`/`write_localisation`.
- Concurrent reads of a file with an in-flight write are queued after it via `writeCoordinator.afterCurrentWrites`. Target paths for `read_file`/`get_pdx_block`/`get_file_context`/`edit_file` are resolved inside `getAgentToolTargetFiles`.
- `get_file_context`/`get_pdx_block` marks reads and returns 1-indexed line spans. Query errors return an `error` field to distinguish from empty results. `read_file` lines are prefixed with `N | `. `replacerSuite.ts`'s `stripLineNumberPrefixes` automatically strips pasted prefixes when matching fails.
- Diagnostic repair hints are cataloged in `tools/diagnosticMetadata.ts` for `analyze_diagnostic_error`. Update `diagnosticMetadata.test.ts` accordingly.
- Record new steps via `runner/runLedger.ts`. Per-run writes must stay serialized, run snapshots must use atomic replacement, and large/full context belongs in referenced artifacts rather than bounded event payloads. New events must update `runTimeline.ts`, `runInspector.ts`, and `runReducers.ts`.
- Fuzzy matching strategies reside in `tools/replacerSuite.ts` (`fuzzyReplace`). It has 10 strategies (Exact, Unicode norm, Line trim, Block anchor, Whitespace norm, Indentation elasticity, Escape norm, Boundary trim, Context awareness, Jaccard similarity). Update `editFileReplacer.test.ts` on modifications.
- For weak tool calling providers, `tools/schemaFlatten.ts` flattens schemas and `nestArguments()` restores them before execution.
- `runner/readTracker.ts` tracks files in Extension Host via mtime + SHA-256 to prevent out-of-date writes.
- `runner/runReducers.ts` provides pure-function event projection reducers to reconstruct run statistics and topologies from events.
- `runner/contextTranscript.ts` is the shared transcript-integrity boundary for compaction and resume. Preserve leading system instructions and complete assistant-tool groups when changing it.
- `runner/checkpoint.ts` writes atomic V3 resume state and transcript checksums while retaining V2 read compatibility. Never persist or restore `sessionOnly` approvals.
- `runner/runReplay.ts` enables recorded-tool replays (Mode A) answering tool calls from the ledger; full original prompts must be resolved from checksummed `prompt.json` artifacts after restart.
- `workspacePaths.ts` resolves `.cwtools/` paths, topics, and scratch dirs.
- `workspaceSandbox.ts` handles path input sanitization, workspace folder resolution, and sandbox scope categorization.
- `runnerPolicy.ts` manages mode-based tool filters, iteration limits, and output budgets.
- `projectProfile.ts` scans the workspace during `/init`, extracting localization language, sampling namespaces, and determining games.
- `gameKnowledge.ts` stores game-specific PDXScript rules (9 games total).
- `memoryParser.ts` manages private topic memory under VS Code workspace storage, with provenance, confidence, expiry, secret redaction, usage tracking, and a ~12000-character prompt bound. Project-shareable rules belong in `AGENTS.md` or explicit workflows.
- Agent mutations, shell, network, Git, media, and MCP tools must honor VS Code Workspace Trust. Captured commands must use `runner/sandboxRunner.ts`; never label direct `child_process.spawn` as sandboxed. Backend order is native Windows helper when explicitly installed, WSL2 + Bubblewrap on Windows, Bubblewrap on Linux/Dev Containers, and Seatbelt on macOS; unavailable enforced backends fail closed.
- For sub-tasks modifying only `.yml` localization files, the agent is automatically promoted to `loc_writer`, and general write tools are disabled.
- Custom Provider uses `cwtools.ai.customApiFormat` to support 4 network protocols. Custom endpoints are stored in `cwtools.ai.providerEndpoints`.
- `usageTracker.ts` persists token usage and costs across sessions.

##### MCP Server (`submodules/cwtools-mcp/`)

`submodules/cwtools-mcp/` is a separate repository vendored as a submodule; it holds the read-only MCP packages `cwtools-shared` and `cwtools-mcp`. The extension VSIX does not bundle the MCP server — external agents install it standalone (`npx -y cwtools-mcp`). Commit MCP changes inside the submodule first, then bump the root pointer.
- **Do not write schema by hand**: Generated to `cwtools-shared/src/generated/mcpTools.ts` via `tools/generate-mcp-schema.cjs` from `definitions.ts` + `registry.ts`. Keep `cwtools-shared/src/tools/names.ts` and the script whitelist in sync. Verify using `npm run generate:mcp-schema` (root) and `npm run test:contracts` (inside the submodule).
- **Enforce Read-Only**: Reject non-whitelist tools inside `cwtools-mcp`'s `createToolCallHandler`.
- Add new capabilities as a `cwtools.ai.*` LSP command first (and check `LanguageServer.fs` `isReadCmd` for reads), then route inside `cwtools-shared/src/tools/toolHandlers.ts`. Do not duplicate parser logic inside MCP.
- `cwtools-shared` cannot import `vscode` or extension contexts. Inject dependencies via `HostServices`.
- Annotate vanilla-dependent queries with `vanillaCache` or `readiness.ready` to prevent incomplete game loading reports.
- Deliver MCP changes to extensions by bumping versions and running `npm run pack:install -- -Version <x>`.

##### F#, Shader, and Vanilla Compare

- Shader support spans `src/Main/Program.fs`, `src/Main/GameLoader.fs`, and `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`.
- Use brace depth counts to parse nested shader blocks instead of single-layer regexes.
- Cache high-frequency shader semantics via text hashes and lazy built-ins.
- Handle escaped quotes `\"` in string scans.
- Apply `WorkspaceEdit` replacements **bottom-up (back-to-front)** in `client/extension/vanillaCompare.ts` to avoid coordinate shifting.
- **Incremental Scripted-Type Refresh**: Save/edit under `scripted_triggers/effects/values` updates only modified files via `IGame.RefreshScriptedTypes` without full Cache Refreshes. It precision-replaces `typeDefInfo` and rebuilds completion/validation. Delete calls go to `RemoveScriptedTypes`. Gated by `experimental` under `gameStateLock` writing lock. Retries full refresh after 25 consecutive incremental updates or errors.

#### Testing and Verification

Choose tests based on your modifications:

| Modification Area | Suggested Verification |
| --- | --- |
| Documentation | Check links, paths, and commands validity |
| Extension TS | `npm run compile` and `npm run test:unit` |
| AI Tools / Prompts / Workflows | Specific tests, then `npm run test:unit` |
| AI Runner Pipeline | `durableStorage.test.ts`, `contextTranscript.test.ts`, `contextCompaction.test.ts`, `runLedger.test.ts`, `resumeStateV2.test.ts`, `reducers.test.ts` |
| AI Tool Execution | `editFileReplacer.test.ts`, `argRepair.test.ts`, `toolInvocation.test.ts` |
| Diagnostics i18n / ReadTracker / Command Safety | `diagnosticI18n.test.ts`, `readTracker.test.ts`, `runCommandReadonly.test.ts`, `commandPreflight.test.ts` |
| Project Profile / `/init` | `projectProfile.test.ts` |
| MCP Services | `npm run generate:mcp-schema` (root) and `npm run test:contracts` (inside `submodules/cwtools-mcp`) |
| IndexService / GameProfile | Related unit tests |
| Webview | `npm run compile`, check console in host |
| F# LSP | `dotnet build src/LSP/` |
| Server Main / Release | `dotnet build src/Main/`, then `npm run verify` |
| Incremental Refresh | `dotnet build src/Main/`, test incremental saves in extension host |
| General pre-release check | `npm run verify` |

#### Pull Request Checklist

Ensure the following before submitting:

- [ ] Relevant builds or tests have run, or reasons explained.
- [ ] User-visible text has been localized into the proper message/i18n module.
- [ ] Webview modifications contain no direct Node.js or VS Code API calls.
- [ ] New AI tools have updated definitions, types, registries, and dispatches.
- [ ] New AI tools have correct `effect` / `riskLevel` / `concurrencyClass` metadata.
- [ ] MCP modifications have run schema generation, verified contracts, and remain read-only.
- [ ] Write operations go through `PartitionedWriteQueue`.
- [ ] Localisation writes use `write_localisation`.
- [ ] New game profiles are added in `gameProfiles.ts`.
- [ ] New queries utilize `IndexService` where possible.
- [ ] WebGL/Three.js assets release memory correctly.
- [ ] Cache schemas preserve backwards compatibility.
- [ ] Sub-agent runs execute inside `SubAgentSandbox`.
- [ ] New events are projected in `runReducers.ts`.
- [ ] Modified fuzzy strategies update `editFileReplacer.test.ts`.
- [ ] No unrelated formatting or file changes.

#### Packaging

See [.agents/workflows/package.md](./.agents/workflows/package.md) for full instructions.
We recommend using the root `package.ps1` script:
```bash
# Package everything
npm run pack

# Package and force install locally
npm run pack:install

# Quick package (TypeScript/Webview compilation only, skip F# build)
npm run pack:quick
```
Or manually run `npx @vscode/vsce package` inside `release/`.
The generated package will be at `release/eddy-stellaris-cwt-<version>.vsix`.
Updating the MCP server requires a version bump, since VS Code will not update files for same-version reinstallations.
The fallback configuration is zipped automatically to `release/rules/stellaris-rules.zip`.

---

<a id="zh-cn"></a>

## 中文

### 贡献指南

感谢你关注 **Stellaris Language Serves**。这份文档面向贡献者，说明如何准备环境、运行项目、提交改动和选择验证方式。架构背景见 [ARCHITECTURE.md](./ARCHITECTURE.md)，AI Agent 工作速查见 [AGENTS.md](./AGENTS.md)；Claude Code 兼容入口见 [CLAUDE.md](./CLAUDE.md)。

#### 环境要求

| 工具 | 推荐版本 | 用途 |
| --- | --- | --- |
| Node.js | 20.x 或更高 | TypeScript 编译、Rollup Webview 打包 |
| npm | 10.x 或更高 | 依赖安装和脚本运行 |
| .NET SDK | 10.0.x | F# 语言服务器和 `CWTools Server` 构建 |
| VS Code | 1.90 或更高 | 扩展开发宿主和测试 |
| Git | 最新稳定版 | 源码和子模块管理 |

仓库的 `global.json` 当前指定 .NET SDK `10.0.301`，并允许 `latestMinor` roll-forward。

#### 克隆和安装

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
npm install
```

如果已经克隆但缺少子模块：

```bash
git submodule update --init --recursive
```

默认 F# 构建使用 `submodules/cwtools`。如果需要指向本地 CWTools 仓库，可在 `src/Main/cwtools.local.props` 创建本机配置：

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

把 `CwtoolsPath` 改成你的实际路径。不要提交本机路径配置。

#### 子模块职责

本仓库有两个重要子模块：

- `submodules/cwtools/`：上游 CWTools F# 库，负责 `src/Main/` 复用的核心解析、校验、游戏模型、Shader 和 scripted type 语义。如果修改它，需先在子模块内部提交，再回到根仓库提交更新后的 submodule 指针。
- `submodules/cwtools-stellaris-config/`：Stellaris CWT 规则配置数据，是规则同步报告和打包 fallback 规则的开发基线。这里的改动应视为规则数据更新，而不是扩展运行时代码改动。

如果一个改动同时触碰两个子模块，请在 PR 中清楚说明边界。

CWT 规则编写细节见 [CWT 规则配置开发指南](./docs/cwt-rule-config.md)。

#### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run compile` | 编译扩展 TypeScript，并用 Rollup 打包 Webview |
| `npm run lint` | ESLint 9 检查 `client/` |
| `npm run test:unit` | 运行 `client/test/unit/**/*.test.ts` |
| `npm run test` | 编译后运行 VS Code 集成测试 |
| `npm run check:release` | 检查发布包元数据和必要产物 |
| `npm run verify` | 本地综合验证：lint、compile、unit、release gate |
| `npm run generate:mcp-schema` | 从上游 `definitions.ts`+`registry.ts` 重生成 MCP 工具 schema（写入 `submodules/cwtools-mcp`） |
| `npm run build` / `test:contracts`（在 `submodules/cwtools-mcp` 内执行） | 构建 MCP 子包并运行 MCP 合约测试（schema 漂移、只读策略、工具路由、深层工具） |
| `dotnet build src/LSP/` | 构建 LSP 协议/解析层 |
| `dotnet build src/Main/` | 构建 `CWTools Server` |

`npm run compile` 会执行：

1. `tsc -p ./.config/tsconfig.extension.json`
2. `rollup -c`

Rollup 当前打包 8 个 Webview 入口：

- `client/webview/chatPanel.ts`
- `client/webview/agentManager.ts`
- `client/webview/guiPreview.ts`
- `client/webview/solarSystemPreview.ts`
- `client/webview/eventChainPreview.ts`
- `client/webview/techTreePreview.ts`
- `client/webview/entityPreview.ts`
- `client/webview/particlePreview.ts`

Stellaris 规则同步脚本：

```bash
npm run rules:stellaris
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
```

`rules:stellaris:report` 会把最新游戏 `script_documentation` 日志、原版 `common/`
与 CWT 配置基线做对比，并生成自包含 HTML 报告
（`tools/rules-sync/report.ts`，默认自动在浏览器打开，可用 `--no-open` 关闭）。
详见 [tools/rules-sync/README.md](./tools/rules-sync/README.md)。

检测到 Stellaris 安装目录时，`rules:stellaris:report` 还会通过 CWTools 解析
`gfx/FX`、记录 `stellaris.exe` 指纹，并在生成报告前自动合并 Shader ABI 文件
（`config/shader/abi-catalog.json`、`abi-audit.json`、`renderer-contracts.json`）：
已审核条目在声明仍存在时自动结转，其余扫描到的 Effect 声明以
`automatic_inventory` 证据自动收录，声明已消失的条目与渲染器契约会被移除。
传入 `--no-shader-abi` 可恢复为完全只读的报告。


#### 运行和调试

1. 用 VS Code 打开仓库根目录。
2. 按 `F5` 或执行 `Run and Debug: Start Debugging`。
3. VS Code 会启动新的 Extension Development Host 窗口。
4. 修改代码后，重新运行调试会话或重载开发宿主。

调试 Webview：

1. 在 Extension Development Host 中打开相关面板。
2. 执行 `Developer: Open Webview Developer Tools`。
3. 在 DevTools 中检查 DOM、控制台、网络请求和断点。

#### 项目结构速览

```text
client/
  extension/                  VS Code Extension Host
    ai/                       AI assistant — full subsystem
      chat/                   Webview ↔ Host communication bridge
      orchestrator/           Multi-agent DAG, blackboard, sandbox, conflict & quality gates
      runner/                 Execution pipeline: compaction, checkpoint, scheduling,
                              permissions, ledger, reducers, replay, read tracking, memory
      tools/                  Tool schemas, registry, permissions, arg repair, handlers,
                              diagnostic metadata, fuzzy replacer suite, schema flattening
      prompt/
        sections/             Base system prompt and per-mode prompt sections
      providers/
        models/               Default model configs, capabilities, pricing
      agentRunner.ts          Main reasoning loop
      agentTools.ts           Tool dispatch hub
      aiService.ts            Multi-provider AI client
      promptBuilder.ts        Prompt construction facade
      projectProfile.ts       /init project scanning and profile
      chatInit.ts             /init command handler
      gameKnowledge.ts        Per-game PDXScript knowledge blocks (9 games)
      skills.ts               SKILL.md index (built-in/user/project) + run_skill body loading
      memoryParser.ts         Private structured long-term memory and bounded consolidation
      workspacePaths.ts       AI storage root, topic/scratch dirs
      workspaceSandbox.ts     Path sanitization and scope classification
      runnerPolicy.ts         Mode-based tool filtering and iteration limits
      planModeGuard.ts        Plan-mode write guard (plan + artifact files only)
      usageTracker.ts         Cumulative token usage and cost tracking
      diffEngine.ts           Structural diff engine
      fileCache.ts            Bounded file content cache
      errorReporter.ts        Structured error reporting
      toolCallParser.ts       Non-standard tool call parsing
      jsonRepair.ts           Incomplete JSON repair
      inlineProvider.ts       AI inline (FIM) completion for PDXScript
      mcpClient.ts            MCP stdio/SSE client
      types.ts                All AI type definitions
      workflowRegistry.ts     Workflow metadata and tool policies
      workflowI18n.ts         Workflow localization
    indexing/                 Shared localisation + workspace-symbol knowledge layer
    gameProfiles.ts           Multi-game profile registry
    extension.ts              Activation and command registration
    diagnosticI18n.ts         Client-side diagnostic Chinese translation + fix advice
    fileExtensions.ts         Case-insensitive extension matching helpers
    fsCaseInsensitive.ts      Case-insensitive path resolution (Linux/macOS)
    pathScope.ts              Shared isPathInsideOrEqual / foldPathCase helpers
    vanillaCompare.ts         Vanilla file diff and block migration
  webview/                    Browser-sandboxed Webview scripts
    chat/                     Extracted chat and Agent Manager modules (22 files)
    messageRenderer.ts        Message rendering (cache sparkline, annotations)
    svgIcons.ts               High-fidelity SVG icon library
    *Preview.ts               GUI, solar system, event chain, tech tree, entity previews
  test/
    unit/                     ts-mocha unit tests (60 files)
    suite/                    VS Code integration tests

src/
  LSP/                        Reusable F# LSP layer
  Main/                       CWTools Server executable
  Languages/                  Resource strings
  CSharpExtensions/           Helper project

docs/
  diagnostic-codes.md         CWxxx diagnostic code reference (codeDescription targets)

packages/
  cwtools-shared/             Read-only MCP core: generated schema, HostServices,
                              path/rules safety, vanilla-cache + readiness, knowledge
  cwtools-mcp/                MCP stdio/HTTP server: CLI, NodeHostServices,
                              LspProcessHost, vscodeCache detection, esbuild bundle

tools/
  rules-sync/                 Stellaris rules scan/check/update/report tooling
  generate-mcp-schema.cjs     Generates MCP tool schema from upstream definitions

submodules/
  cwtools/                    Upstream CWTools F# library
  cwtools-stellaris-config/   Stellaris CWT config data
```

#### 开发规范

##### TypeScript 和 Extension Host

- 优先复用现有模块风格和本地 helper，不为小改动引入新抽象。
- 生产代码避免无理由的 `any`；未知数据优先用 `unknown` 和类型守卫。
- 关注 ESLint 9 的异步安全规则：`no-floating-promises`、`no-misused-promises`、`prefer-promise-reject-errors`。
- Extension/AI 错误报告优先使用 `ErrorReporter`，不要裸用 `console.error`。
- 用户可见中文文本尽量放入现有 message / i18n 模块：
  `client/extension/ai/messages.ts`、`client/extension/ai/workflowI18n.ts`、`client/webview/chat/i18n.ts`。
- 修改大文件时优先做局部、可验证的变更，避免无关格式化和重排。

##### Webview

Webview 运行在浏览器沙盒中：

- 不要导入 `vscode`、`fs`、`path` 或任何 Node.js-only API。
- 不要使用 `require()`。
- 与扩展宿主通信必须通过 `postMessage`。
- CSS 使用 VS Code 主题变量，例如 `var(--vscode-editor-background)`。
- 动画应支持 `prefers-reduced-motion`。
- Three.js/WebGL 面板必须在销毁时释放 renderer、geometry、material、texture、worker、事件监听器和动画循环。
- 新增 chat UI 逻辑时，优先沿用 `client/webview/chat/` 的拆分模式。
- Chat 面板和 Agent Manager 面板共享 host-side state；涉及跨 surface 同步时检查 `AgentUiBroadcaster`、`AgentSessionCoordinator`、`ArtifactStore` 和 `ai/chat/bridge.ts`。
- **沙盒与 I/O 隔离边界 (ReadTracker)**：不要在 Webview 端直接操作文件或绕过 IPC 抓取文件树与文件元数据。I/O 跟踪逻辑（如 `ReadTracker`）只在 Extension Host 中执行，前端仅做数据展现，所有文件访问通过 `postMessage` 委托给 Host。
- **前缀缓存度量卡片 (Prompt Cache)**：模型支持缓存并命中或新建前缀缓存（如 DeepSeek、Claude）时，后端会发射 `cache_stats` 事件，前端 `messageRenderer.ts` 将其渲染为三柱微图卡片（绿色命中 / 蓝色新建 / 橙黄穿透，Cache Sparkline）。改动缓存折扣率（如 DeepSeek/Claude 的 0.1× 优惠）或其持久化时，需同步查验 `pricing.ts`、`UsageTracker` 与前端 `agentManager.ts` / `chatPanel.ts` 的渲染区块。
- **UI 图标规范**：Token 使用看板等 UI 区域不要使用裸 Emoji（如 ⚡），改用带内联样式的 SVG 矢量图标（支持 `stroke="currentColor"` 主题色自适应与垂直对齐）。

##### 平台与索引层

- 新的游戏差异优先放入 `client/extension/gameProfiles.ts`，不要在消费者里继续散落硬编码。
- 新的 localisation、symbol、asset 查询优先复用 `IndexService`；只有共享索引无法回答时才新增额外扫描逻辑。
- `IndexService` 的纯逻辑尽量留在 `locParser.ts` / `workspaceSymbolParser.ts`，便于单元测试。
- 新增查询维度时同步考虑 workspace 与 vanilla 来源、freshness / `fileVersion` 元数据、limit 和缓存边界。

##### AI Agent

新增或修改 AI 工具时，请同步维护：

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts`（如果访问策略变化）
5. `client/extension/ai/agentTools.ts`

工具设计注意点：

- `tools/registry.ts` 是模式门控、读写分类和子 Agent 可用性的事实来源；同时派生 `effect`、`riskLevel`、`concurrencyClass`。
- 所有模型可见工具必须先通过强制执行的 `runner/policyEngine.ts` 再进入领域 handler；不得新增仅 shadow 的权限路径或 handler 本地绕过。
- 结构化读取优先于原始命令读取：先考虑 `query_workspace_index`、`document_symbols`、`get_pdx_block`、`get_file_context`。
- `run_command` 必须经过 `runner/commandPreflight.ts` 风险分级；增加 cwd/network 权限后仍须保留操作系统沙箱，只有显式 `unsandboxed` 字段可以请求单次绕过。`networkHosts` 仅用于审批范围与审计；当前 shell 后端强制的是广泛网络允许/禁止，而不是按域名过滤。captured 后台命令会返回 `processId`，进程控制统一使用 `list_processes`、`read_process`、`write_process_stdin`、`terminate_process`。
- `runner/permissionPolicy.ts` 只放行低风险预批准命令；`cwdScope` 校验必须保留 `path.relative` 形式，不要退回 `startsWith`。
- 写文件工具由 `PartitionedWriteQueue` 按文件路径串行化；多文件写入按路径字典序获取锁。
- `.yml` 本地化文件必须用 `write_localisation`，不要用通用写入或替换工具直接写。
- 多 Agent 协作使用 `dispatch_agents`、`query_blackboard`、`merge_results`；子 Agent 分派必须经过 `orchestrator/subAgentSandbox.ts`。
- 技能系统：`SKILL.md` 文件（built-in / user / project 三类作用域）由 `skills.ts` 建立索引，`promptBuilder.ts` 只注入精简的技能索引；完整技能正文通过 `run_skill` 工具按需加载，避免撑大基础 prompt。
- 计划模式写入受 `planModeGuard.ts` 约束：仅允许写入实现计划（`implementation_plan.md`）与 plan/blueprint/walkthrough 等产物文件，其余写操作一律拦截。
- 只读导向模式（plan/explore/review/script_reviewer/orchestrator/script）下的 `git_ops` 只放行 `status`/`diff`，变更性 action 由 `planModeGuard.ts` 的 `validateGitOpsForMode` 在 `agentRunner`/`agentTools` 执行前拦截。
- `write_file`、`edit_file`、`replace_lines` 是通用与 Paradox 执行域共享的完整源码编辑面。修改 PDXScript 时，先用 `get_pdx_block` 取得精确上下文，再通过最小化且带守卫的 `edit_file` 或 `replace_lines` 修改，避免改动未触及的注释和文本。
- `apply_patch`、`multi_replace_file_content`、`edit_pdx_block` 的可执行工具路径已彻底移除，Webview 仅可为历史消息保留旧名称识别；`ast_mutate` 继续保持退役状态，`agentTools.execute()` 会引导改用 `edit_file`/`replace_lines`/`write_localisation`。
- 同一文件的读操作会经 `writeCoordinator.afterCurrentWrites` 排在在途写入之后；`getAgentToolTargetFiles` 已为 `read_file`/`get_pdx_block`/`get_file_context`/`edit_file` 补齐路径提取。
- `get_file_context`/`get_pdx_block` 现会 `markRead` 并返回 1 基 `startLine`/`endLine`，可直接衔接 `replace_lines`；读/搜索工具出错时返回 `error` 字段以区别于"空结果"。`read_file` 输出带 `N | ` 行号前缀，`replacerSuite.ts` 的 `stripLineNumberPrefixes` 会在 `edit_file` 匹配失败时剥离模型误粘贴的行号前缀。
- 诊断修复元数据集中在 `tools/diagnosticMetadata.ts`：为 `analyze_diagnostic_error` 提供诊断分类（`DiagnosticAnalysisCategory`）与修复提示，修改时同步更新 `diagnosticMetadata.test.ts`。
- 新增用户可见运行步骤时，通过 `runner/runLedger.ts` 写事件。per-run 写入必须保持串行，run snapshot 使用原子替换，大型/完整上下文应进入带引用的 artifact，不放进有界事件负载；新增事件类型时同步 `runTimeline.ts`、`runInspector.ts` 和 `runReducers.ts`。
- 文件编辑的模糊匹配策略集中在 `tools/replacerSuite.ts`（`fuzzyReplace`），由 `tools/fileTools.ts` 的 `replace()` 辅助方法消费，用于 `edit_file` 工具与内部 hunk 应用（`replace_lines` 完全按行号替换）。它包含 10 种递进式匹配算法（直接匹配、Unicode 归一化、行级 trim、块锚定、空白归一化、缩进弹性、转义归一化、边界 trim、上下文感知、Jaccard 相似度）。修改替换策略时请同步更新 `editFileReplacer.test.ts`。
- 面向弱工具调用能力的 Provider，`tools/schemaFlatten.ts` 可自动将深层嵌套 schema 展平；执行工具前由 `nestArguments()` 反向还原。
- `runner/readTracker.ts` 在 Extension Host 中跟踪文件的读取状态（mtime + SHA-256 hash），防止 Agent 未读即写或写入已被外部修改的文件。
- `runner/runReducers.ts` 提供纯函数式的事件投影 reducer，用于从 JSONL 事件流重建 run 状态、工具时间线、Agent 拓扑图和缓存统计快照。新增事件类型时必须更新对应 reducer。
- `runner/contextTranscript.ts` 是 compaction 与 resume 共用的 transcript 完整性边界；修改时必须保留前置 system 指令和完整 assistant-tool 调用组。
- `runner/checkpoint.ts` 原子写入 V3 resume state 与 transcript 校验和，并兼容读取 V2；绝不能持久化或恢复 `sessionOnly` 审批。
- `runner/runReplay.ts` 提供运行回放功能：模式 A (recorded-tool) 使用原始 ledger 的工具结果回答工具调用，模式 B (full-replay) 暂缓。完整原始 prompt 必须在重启后从带校验和的 `prompt.json` artifact 读取；`ReplaySession` 按规范化参数索引工具结果。
- `workspacePaths.ts` 负责解析 AI 存储根目录（`.cwtools/`）、topic 目录和 scratch 目录，支持多 workspace folder 场景。
- `workspaceSandbox.ts` 负责路径输入清洗、作用域分类（`project`/`ai`/`workspace`/`outside`）和信任判定。
- `runnerPolicy.ts` 集中管理模式级工具过滤、每种模式的迭代次数上限、slim sub-agent 输出预算。
- `projectProfile.ts` 处理 `/init` 命令的项目扫描：目录检测、本地化语言/编码检测、命名空间/标识符采样、游戏检测、prompt card 生成和 `queryProjectProfile` 工具处理器。
- `gameKnowledge.ts` 按 languageId 提供 9 款游戏的 PDXScript 知识块，由 `promptBuilder.ts` 动态选择注入。
- `memoryParser.ts` 在 VS Code workspace storage 中管理 topic 级私有结构化记忆，记录来源、置信度、过期、使用次数并做 secret 脱敏，提示词注入上限约 12000 字符；需要项目共享的规则应写入 `AGENTS.md` 或显式工作流。
- Agent 的写入、命令、网络、Git、媒体和 MCP 工具必须遵守 VS Code Workspace Trust；captured 命令必须经过 `runner/sandboxRunner.ts`，不得把直接 `child_process.spawn` 标记为沙箱执行。后端顺序为：显式安装的 Windows 原生 helper、Windows 上的 WSL2 + Bubblewrap、Linux/开发容器中的 Bubblewrap、macOS Seatbelt；缺少强制后端时必须失败关闭。
- 多 Agent 协作中，`plannedFiles` 全部为本地化 `.yml` 的子任务会被自动升级为 `loc_writer` 角色，且沙盒会屏蔽通用写工具，只允许 `write_localisation`。
- Custom Provider 通过 `cwtools.ai.customApiFormat` 支持四种线协议（`openai-chat-completions`、`openai-responses`、`anthropic-messages`、`gemini-generate-content`）；endpoint 按 Provider 存储在 `cwtools.ai.providerEndpoints`，旧的全局 `cwtools.ai.endpoint` 由 `migrateLegacyEndpoint()` 自动迁移，不要重新引入。
- `usageTracker.ts` 跨会话持久化累计 token 用量、成本和缓存统计数据。

##### 通用 MCP 服务（`packages/`）

`submodules/cwtools-mcp/` 是独立仓库以 submodule 形式挂回，内含**只读** MCP 包 `cwtools-shared` 与 `cwtools-mcp`，供 Codex / Claude Code 等外部 Agent 调用。扩展 VSIX 不再随包携带 MCP——外部 Agent 独立安装（`npx -y cwtools-mcp`）。MCP 改动先在 submodule 内提交推送，再更新根仓库指针。开发约定：

- 工具 schema **不手写**：由 `tools/generate-mcp-schema.cjs` 从上游 `definitions.ts` + `registry.ts` 生成到 `cwtools-shared/src/generated/mcpTools.ts`。首期工具白名单同时存在于 `cwtools-shared/src/tools/names.ts` 与生成脚本，两处必须一致。改动后运行 `npm run generate:mcp-schema`（根仓库），并在 submodule 内用 `npm run test:contracts` 验证无漂移。
- **保持只读**：不要在 MCP 暴露写工具；`cwtools-mcp` 的 `createToolCallHandler` 会对任何非白名单工具返回 `tool_not_available`。文件写入交给宿主 Agent。
- 新语义能力先在 `src/LSP`/`src/Main` 增加 `cwtools.ai.*` 命令（只读命令同时加入 `LanguageServer.fs` 的 `isReadCmd`），再在 `cwtools-shared/src/tools/toolHandlers.ts` 的 dispatcher 接线，不要在 MCP 内重写 CWTools 语义。
- `cwtools-shared` 禁止 import `vscode`/`vscode-languageclient`/webview/extension context；宿主能力经 `HostServices` 注入。
- 受 vanilla / 加载状态影响的工具结果须经 `host/vanillaCache.ts`、`host/readiness.ts` 标注；新增此类工具时把它加入对应依赖集。
- 交付到已装插件需升版本号（VS Code 同版本号重装不替换文件）：同步根 `package.json`、`release/package.json`、`release/CHANGELOG.md`，再 `npm run pack:install -- -Version <x>`。

##### F#、Shader 和 Vanilla Compare

- Shader 支持涉及 `src/Main/Program.fs`、`src/Main/GameLoader.fs` 和 `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`。
- 解析嵌套 shader 块时优先使用花括号深度计数，不要用只能匹配单层的 `[^}]+` 正则。
- 高频 shader 语义计算应复用已有 hash 缓存与 lazy built-in 集合，避免把大量顶级定义塞回 `Program.fs`。
- 字符串区间扫描要保留对转义双引号 `\"` 的处理。
- `client/extension/vanillaCompare.ts` 的块级迁移应按起始行从后往前应用 `WorkspaceEdit`，避免替换导致行号偏移。
- **自定义 scripted 类型增量刷新**接入点跨多个层：`src/Main/Program.fs` 的 lint 路径（`isIncrementalScriptedPath` 判定 + 写锁内调 `IGame.RefreshScriptedTypes` / `RemoveScriptedTypes`），上游 `RulesManager.RefreshScriptedTypes`（按 `range.FileName` 滤旧条目、单趟 `getTypesFromDefinitions`、仅对改动 typeKey 增量重建 `tempTypeMap` 而非整表 `typeMapFromTypeDefInfo`）、`ResourceManager.RemoveFile` 与各游戏 `IGame` 实现（仅 Stellaris 真增量，其余返回 `false` 回退全量）。改动横跨 `submodules/cwtools` 这个**独立 git submodule**，须先在 submodule 内提交，再回根仓库提交其指针。该增量路径无上游测试覆盖，修改时务必保证逐键产出与全量一致（可临时对比增量与全量的 `typeDefInfo`）。详见 [AGENTS.md](./AGENTS.md) 的「Incremental Scripted-Type Refresh」。

#### 测试和验证

根据改动范围选择验证：

| 改动范围 | 建议验证 |
| --- | --- |
| 文档 | 检查链接、路径和命令是否存在 |
| Extension TypeScript | `npm run compile`，必要时 `npm run test:unit` |
| AI 工具 / Prompt / Workflow / Orchestrator | 相关单测，再视范围执行 `npm run test:unit` |
| AI Runner Pipeline (context/resume/replay/ledger) | `durableStorage.test.ts`、`contextTranscript.test.ts`、`contextCompaction.test.ts`、`runLedger.test.ts`、`resumeStateV2.test.ts`、`reducers.test.ts` |
| AI Tool Execution (replacer/arg repair) | `editFileReplacer.test.ts`、`argRepair.test.ts`、`toolInvocation.test.ts` |
| 诊断 i18n / ReadTracker / 命令安全 | `diagnosticI18n.test.ts`、`readTracker.test.ts`、`runCommandReadonly.test.ts`、`commandPreflight.test.ts` |
| Project Profile / `/init` | `projectProfile.test.ts` |
| 通用 MCP 服务 (`submodules/cwtools-mcp/`) | `npm run generate:mcp-schema`（如改工具，根仓库）+ submodule 内 `npm run test:contracts`；真实验证跑 submodule 构建出的 `cwtools-mcp` CLI |
| IndexService / GameProfile | 相关单测 + `npm run test:unit` |
| Webview | `npm run compile`，在开发宿主中打开对应面板检查控制台 |
| F# LSP | `dotnet build src/LSP/` |
| 服务端入口 / 发布 | `dotnet build src/Main/`，必要时 `npm run verify` |
| 自定义 scripted 类型增量刷新 | `dotnet build src/Main/`；行为验证需在扩展开发宿主开启 `experimental`，手测脚本定义文件的增/改/删是否即时生效且无重复/丢失 |
| 发布前总检 | `npm run verify` |

常见单测文件（60 个）包括：`agentToolSafety.test.ts`、`agentRunnerState.test.ts`、`agentRunnerFallback.test.ts`、`agentRunnerToolRepair.test.ts`、`agentResumeState.test.ts`、`agentSessionCoordinator.test.ts`、`agentUiBroadcaster.test.ts`、`agentManagerContracts.test.ts`、`agentManagerRunSnapshot.test.ts`、`aiServiceTimeout.test.ts`、`approvalBoundary.test.ts`、`argRepair.test.ts`、`artifactPanelModel.test.ts`、`artifactStore.test.ts`、`chatFormatters.test.ts`、`chatModels.test.ts`、`commandPreflight.test.ts`、`contextBudget.test.ts`、`contextMemory.test.ts`、`diagnosticI18n.test.ts`、`diagnosticMetadata.test.ts`、`diffEngine.test.ts`、`editFileReplacer.test.ts`、`gameKnowledge.test.ts`、`gameProfiles.test.ts`、`graphicsFeatures.test.ts`、`indexService.test.ts`、`jsonRepair.test.ts`、`locatorDuplicate.test.ts`、`mcpPermissions.test.ts`、`memoryParser.test.ts`、`messageRenderer.test.ts`、`orchestrator.test.ts`、`pdxIndentFormatter.test.ts`、`pdxshader-grammar.test.ts`、`permissionPolicy.test.ts`、`planModeGuard.test.ts`、`policyEngine.test.ts`、`pricing.test.ts`、`projectProfile.test.ts`、`promptBuilderContext.test.ts`、`promptBuilderSnapshot.test.ts`、`promptBuilderSprite.test.ts`、`providers.test.ts`、`readTracker.test.ts`、`reducers.test.ts`、`resumeStateV2.test.ts`、`runCommandReadonly.test.ts`、`runLedger.test.ts`、`runnerPolicy.test.ts`、`subAgentSandbox.test.ts`、`toolCallParser.test.ts`、`toolDefinitions.test.ts`、`toolInvocation.test.ts`、`toolScheduler.test.ts`、`webviewSmoke.test.ts`、`workflowRegistry.test.ts`、`workflowViewModel.test.ts`、`workspaceSymbolParser.test.ts`、`worktreeManager.test.ts`。

#### Pull Request 清单

提交前请确认：

- [ ] 相关构建或测试已运行，或在 PR 中说明未运行原因。
- [ ] 新增用户可见文本已放入合适的 message / i18n 模块。
- [ ] Webview 变更没有引入 Node.js 或 VS Code API 直接访问。
- [ ] 新 AI 工具同步更新了 schema、类型、registry 和 dispatch。
- [ ] 新 AI 工具设置了正确的 `effect` / `riskLevel` / `concurrencyClass`。
- [ ] 改动 MCP 工具集后运行了 `npm run generate:mcp-schema`，且 `names.ts` 与生成脚本白名单一致、`npm run test:contracts` 通过；MCP 保持只读。
- [ ] 文件写入逻辑没有绕过 `PartitionedWriteQueue`。
- [ ] 本地化写入使用 `write_localisation`。
- [ ] 新的游戏差异优先进入 `gameProfiles.ts`。
- [ ] 新的 localisation / symbol / asset 查询优先复用 `IndexService`。
- [ ] WebGL/Three.js 资源有明确释放路径。
- [ ] 大型缓存、索引、扫描结果有边界或清理策略。
- [ ] 修改 `AgentResumeState` 或事件 schema 时保持兼容并扩充相关测试。
- [ ] 子 Agent 调度走 `subAgentSandbox`，没有绕过 `enforceSubAgentSafety`。
- [ ] 新事件类型同步更新了 `runReducers.ts` 中的对应 reducer。
- [ ] 修改模糊替换策略时同步更新了 `editFileReplacer.test.ts`。
- [ ] 没有无关格式化、生成文件或大范围重排。

#### 打包

打包详细流程与说明请参见 [.agents/workflows/package.md](./.agents/workflows/package.md)。当前 release 包从 `release/package.json` 生成。

我们强烈推荐在根目录下运行 `package.ps1` 自动化脚本，或直接通过快捷 npm scripts 进行打包和安装：
```bash
# 一键自动完成三平台服务端编译、前端 Webview 编译、资源复制与插件 VSIX 打包
npm run pack

# 自动打包并在打包成功后，强制安装升级至当前系统的 VSCode
npm run pack:install

# 极速打包（跳过重新编译 F# 服务端，仅快速打包 TypeScript 和 Webview 前端并自动安装，耗时约 30 秒）
npm run pack:quick
```

如果不使用自动化脚本，也可以进入 `release/` 目录中手动执行：
```powershell
npx @vscode/vsce package
```
生成的通用 VSIX 插件文件位于 `release/` 文件夹下，例如 `release/eddy-stellaris-cwt-<version>.vsix`（`<version>` 取自 `release/package.json`）。
