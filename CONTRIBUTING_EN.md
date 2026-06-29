# Contribution Guide

Thank you for your interest in **Stellaris Language Serves**. This document is for contributors, explaining how to set up the environment, run the project, submit changes, and verify your code. For architectural background, see [ARCHITECTURE.md](./ARCHITECTURE.md); for the AI Agent quick check sheet, see [CLAUDE.md](./CLAUDE.md).

## Environment Requirements

| Tool | Recommended Version | Purpose |
| --- | --- | --- |
| Node.js | 20.x or higher | TypeScript compilation, Rollup Webview bundling |
| npm | 10.x or higher | Dependency installation and scripts execution |
| .NET SDK | 9.0.x | F# Language Server and `CWTools Server` build |
| VS Code | 1.90 or higher | Extension development host and testing |
| Git | Latest stable | Source code and submodule management |

The repository's `global.json` currently specifies .NET SDK version `9.0.300` and allows `latestMinor` roll-forward.

## Clone and Install

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

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile TS extension and bundle Webview with Rollup |
| `npm run lint` | Run ESLint 9 checks on `client/` |
| `npm run test:unit` | Run unit tests under `client/test/unit/**/*.test.ts` |
| `npm run test` | Compile and run VS Code integration tests |
| `npm run check:release` | Verify release package metadata and necessary output |
| `npm run verify` | Integrated local validation: lint, compile, unit tests, release gate |
| `npm run build:shared` / `build:mcp` | Build MCP subpackages (`packages/cwtools-shared` / `cwtools-mcp`) |
| `npm run generate:mcp-schema` | Regenerate MCP tool schema from upstream `definitions.ts`+`registry.ts` |
| `npm run test:contracts` | MCP contract tests (schema drift, read-only policy, tool routing, deep tools) |
| `dotnet build src/LSP/` | Build LSP protocol and parsing layers |
| `dotnet build src/Main/` | Build `CWTools Server` |

`npm run compile` performs:

1. `tsc -p ./.config/tsconfig.extension.json`
2. `rollup -c`

Rollup currently bundles 7 Webview entry points:

- `client/webview/chatPanel.ts`
- `client/webview/agentManager.ts`
- `client/webview/guiPreview.ts`
- `client/webview/solarSystemPreview.ts`
- `client/webview/eventChainPreview.ts`
- `client/webview/techTreePreview.ts`
- `client/webview/entityPreview.ts`

Stellaris rules synchronization scripts:

```bash
npm run rules:stellaris
npm run rules:stellaris:scan
npm run rules:stellaris:check
npm run rules:stellaris:update
npm run rules:stellaris:report
```

`rules:stellaris:report` runs a read-only comparison between the latest game `script_documentation` log, vanilla `common/`, and the CWT config baseline, generating a self-contained HTML report (`tools/rules-sync/report.ts`, automatically opens in the browser by default, disable with `--no-open`). For details, see [tools/rules-sync/README.md](./tools/rules-sync/README.md).

## Run and Debug

1. Open the repository root directory with VS Code.
2. Press `F5` or execute `Run and Debug: Start Debugging`.
3. VS Code will open a new Extension Development Host window.
4. After editing code, restart the debug session or reload the window.

To debug Webviews:

1. Open the target panel in the Extension Development Host.
2. Execute `Developer: Open Webview Developer Tools`.
3. Inspect DOM, console, network requests, and breakpoints inside DevTools.

## Project Structure Quick Look

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
      memoryParser.ts         Topic-scoped .cwtools-ai-memory.md long-term memory
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

## Development Guidelines

### TypeScript and Extension Host

- Reuse existing module styles and local helpers. Avoid introducing new abstractions for minor modifications.
- Avoid using `any` without a reason in production code. Prefer `unknown` and type guards for unknown data.
- Pay attention to ESLint 9 async rules: `no-floating-promises`, `no-misused-promises`, and `prefer-promise-reject-errors`.
- For extension/AI error reporting, prefer `ErrorReporter` over bare `console.error`.
- Put user-visible Chinese text in the existing message/i18n modules where practical:
  `client/extension/ai/messages.ts`, `client/extension/ai/workflowI18n.ts`, and `client/webview/chat/i18n.ts`.
- Make localized, verifiable changes when modifying large files. Avoid unrelated formatting and restructuring.

### Webview

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

### Platform and Indexing

- Put new game-specific differences in `client/extension/gameProfiles.ts` instead of scattering hardcoded values.
- Reuse `IndexService` for new localization, symbol, and asset queries. Avoid duplicate workspace scanning.
- Keep pure logic of `IndexService` in `locParser.ts` / `workspaceSymbolParser.ts` for unit testing.
- When adding query dimensions, consider workspace/vanilla sources, freshness / `fileVersion` metadata, limits, and caching boundaries.

### AI Agent

When adding or changing an AI tool, update the coordinated surfaces together:

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts` (if access policies change)
5. `client/extension/ai/agentTools.ts`

Key constraints for tools:

- `tools/registry.ts` is the single source of truth for mode gating, read/write classification, and sub-agent availability; it derives `effect`, `riskLevel`, and `concurrencyClass`.
- Structure reading is preferred over shell commands: prioritize `query_workspace_index`, `document_symbols`, `get_pdx_block`, and `get_file_context`.
- `run_command` must be classified by `runner/commandPreflight.ts` risks; destructive or escalated commands cannot bypass manual approval.
- `runner/permissionPolicy.ts` only allows low-risk pre-approved rules; `cwdScope` validation must use `path.relative`, not prefix tests.
- File writes go through `PartitionedWriteQueue` in path dictionary order.
- Localisation `.yml` files must use `write_localisation`, not generic text writes.
- Multi-agent collaboration uses `dispatch_agents`, `query_blackboard`, and `merge_results`; sub-agent dispatches must be sandboxed by `orchestrator/subAgentSandbox.ts`.
- Skills: `SKILL.md` (built-in/user/project) is indexed by `skills.ts`. The prompt builder only injects a slim index. Full skill contents are loaded on demand via `run_skill` to save prompt tokens.
- Plan mode writes are guarded by `planModeGuard.ts`: only implementation plans and plan/blueprint/walkthrough output files are write-authorized; all other writes are blocked.
- Read-only modes (plan, explore, review, script_reviewer, orchestrator, script) only allow `status` and `diff` for `git_ops`, guarded by `planModeGuard.ts`'s `validateGitOpsForMode` before execution.
- `edit_file(filePath, oldString, newString, replaceAll?)` is the single-occurrence fuzzy replace primitive. It shares the same checks (ReadTracker, pending-write, etc.).
- `apply_patch`, `multi_replace_file_content`, and `ast_mutate` are retired from model-visible tools. `agentTools.execute()` redirects them to `edit_file`/`replace_lines`/`edit_pdx_block`/`write_localisation`.
- Concurrent reads of a file with an in-flight write are queued after it via `writeCoordinator.afterCurrentWrites`. Target paths for `read_file`/`get_pdx_block`/`get_file_context`/`edit_file` are resolved inside `getAgentToolTargetFiles`.
- `get_file_context`/`get_pdx_block` marks reads and returns 1-indexed line spans. Query errors return an `error` field to distinguish from empty results. `read_file` lines are prefixed with `N | `. `replacerSuite.ts`'s `stripLineNumberPrefixes` automatically strips pasted prefixes when matching fails.
- Diagnostic repair hints are cataloged in `tools/diagnosticMetadata.ts` for `analyze_diagnostic_error`. Update `diagnosticMetadata.test.ts` accordingly.
- Record new steps via `runner/runLedger.ts`. New events must update `runTimeline.ts`, `runInspector.ts`, and `runReducers.ts`.
- Fuzzy matching strategies reside in `tools/replacerSuite.ts` (`fuzzyReplace`). It has 10 strategies (Exact, Unicode norm, Line trim, Block anchor, Whitespace norm, Indentation elasticity, Escape norm, Boundary trim, Context awareness, Jaccard similarity). Update `editFileReplacer.test.ts` on modifications.
- For weak tool calling providers, `tools/schemaFlatten.ts` flattens schemas and `nestArguments()` restores them before execution.
- `runner/readTracker.ts` tracks files in Extension Host via mtime + SHA-256 to prevent out-of-date writes.
- `runner/runReducers.ts` provides pure-function event projection reducers to reconstruct run statistics and topologies from events.
- `runner/runReplay.ts` enables recorded-tool replays (Mode A) answering tool calls from the ledger.
- `workspacePaths.ts` resolves `.cwtools-ai/` paths, topics, and scratch dirs.
- `workspaceSandbox.ts` handles path input sanitization, workspace folder resolution, and sandbox scope categorization.
- `runnerPolicy.ts` manages mode-based tool filters, iteration limits, and output budgets.
- `projectProfile.ts` scans the workspace during `/init`, extracting localization language, sampling namespaces, and determining games.
- `gameKnowledge.ts` stores game-specific PDXScript rules (9 games total).
- `memoryParser.ts` manages topic-scoped `.cwtools-ai/<topicId>/.cwtools-ai-memory.md` files (up to ~4000 characters).
- For sub-tasks modifying only `.yml` localization files, the agent is automatically promoted to `loc_writer`, and general write tools are disabled.
- Custom Provider uses `cwtools.ai.customApiFormat` to support 4 network protocols. Custom endpoints are stored in `cwtools.ai.providerEndpoints`.
- `usageTracker.ts` persists token usage and costs across sessions.

### MCP Server (`packages/`)

`packages/cwtools-shared` and `packages/cwtools-mcp` are read-only MCP services bundled inside the extension.
- **Do not write schema by hand**: Generated to `cwtools-shared/src/generated/mcpTools.ts` via `tools/generate-mcp-schema.cjs` from `definitions.ts` + `registry.ts`. Keep `cwtools-shared/src/tools/names.ts` and the script whitelist in sync. Verify using `npm run generate:mcp-schema` and `npm run test:contracts`.
- **Enforce Read-Only**: Reject non-whitelist tools inside `cwtools-mcp`'s `createToolCallHandler`.
- Add new capabilities as a `cwtools.ai.*` LSP command first (and check `LanguageServer.fs` `isReadCmd` for reads), then route inside `cwtools-shared/src/tools/toolHandlers.ts`. Do not duplicate parser logic inside MCP.
- `cwtools-shared` cannot import `vscode` or extension contexts. Inject dependencies via `HostServices`.
- Annotate vanilla-dependent queries with `vanillaCache` or `readiness.ready` to prevent incomplete game loading reports.
- Deliver MCP changes to extensions by bumping versions and running `npm run pack:install -- -Version <x>`.

### F#, Shader, and Vanilla Compare

- Shader support spans `src/Main/Program.fs`, `src/Main/GameLoader.fs`, and `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`.
- Use brace depth counts to parse nested shader blocks instead of single-layer regexes.
- Cache high-frequency shader semantics via text hashes and lazy built-ins.
- Handle escaped quotes `\"` in string scans.
- Apply `WorkspaceEdit` replacements **bottom-up (back-to-front)** in `client/extension/vanillaCompare.ts` to avoid coordinate shifting.
- **Incremental Scripted-Type Refresh**: Save/edit under `scripted_triggers/effects/values` updates only modified files via `IGame.RefreshScriptedTypes` without full Cache Refreshes. It precision-replaces `typeDefInfo` and rebuilds completion/validation. Delete calls go to `RemoveScriptedTypes`. Gated by `experimental` under `gameStateLock` writing lock. Retries full refresh after 25 consecutive incremental updates or errors.

## Testing and Verification

Choose tests based on your modifications:

| Modification Area | Suggested Verification |
| --- | --- |
| Documentation | Check links, paths, and commands validity |
| Extension TS | `npm run compile` and `npm run test:unit` |
| AI Tools / Prompts / Workflows | Specific tests, then `npm run test:unit` |
| AI Runner Pipeline | `reducers.test.ts`, `runLedger.test.ts`, `resumeStateV2.test.ts` |
| AI Tool Execution | `editFileReplacer.test.ts`, `argRepair.test.ts`, `toolInvocation.test.ts` |
| Diagnostics i18n / ReadTracker / Command Safety | `diagnosticI18n.test.ts`, `readTracker.test.ts`, `runCommandReadonly.test.ts`, `commandPreflight.test.ts` |
| Project Profile / `/init` | `projectProfile.test.ts` |
| MCP Services | `npm run generate:mcp-schema` and `npm run test:contracts` |
| IndexService / GameProfile | Related unit tests |
| Webview | `npm run compile`, check console in host |
| F# LSP | `dotnet build src/LSP/` |
| Server Main / Release | `dotnet build src/Main/`, then `npm run verify` |
| Incremental Refresh | `dotnet build src/Main/`, test incremental saves in extension host |
| General pre-release check | `npm run verify` |

## Pull Request Checklist

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

## Packaging

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
