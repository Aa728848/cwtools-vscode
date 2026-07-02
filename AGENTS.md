# AGENTS.md

Canonical operating guide for AI coding assistants in this repository. Keep this
file short, concrete, and focused on actions an agent needs before editing code.

Use the other root docs for deeper context:

- `README.md`: product overview and user-facing feature guide.
- `CONTRIBUTING.md`: human setup, debug, PR, verification, and packaging workflow.
- `ARCHITECTURE.md`: system background, module boundaries, and data flow.
- `CLAUDE.md`: thin Claude Code compatibility entry that points back here.

## Start Here

Before editing, inspect the current tree. This fork changes quickly.

```bash
git status --short
rg --files
```

Prefer `rg` / `rg --files` for searching. If you change docs or release-facing
content, remember the docs are single-source bilingual documents now:

- `README.md`
- `CONTRIBUTING.md`
- `ARCHITECTURE.md`

Do not reintroduce `README_EN.md`, `README_ZH.md`, `CONTRIBUTING_EN.md`,
`ARCHITECTURE_EN.md`, or `ARCHITECTURE_ZH.md`.

## Common Verification

Run the narrowest useful checks for your change:

```bash
npm run compile
npm run lint
npm run test:unit
npm run test
npm run check:release
npm run verify
npm run build:docs
npm run build:shared
npm run build:mcp
npm run generate:mcp-schema
npm run test:contracts
dotnet build src/LSP/
dotnet build src/Main/
```

`npm run verify` is the broad local gate: lint, compile, unit tests, and release
checks. `npm run build:docs` validates the bilingual root docs and regenerates
`release/README.md` from `README.md`.

## Repository Map

Main runtime layers:

- `client/extension/`: VS Code extension host code.
- `client/extension/ai/`: integrated AI assistant, tools, runner, workflows,
  memory, prompt construction, and orchestrator.
- `client/webview/`: browser-sandboxed Webview UIs bundled by Rollup.
- `src/LSP/` and `src/Main/`: .NET 10 / F# language server and `CWTools Server`.
- `packages/cwtools-shared/` and `packages/cwtools-mcp/`: read-only MCP server
  shipped inside the extension.
- `submodules/cwtools/`: upstream CWTools F# library.
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rule configuration
  data used as the development/fallback rule source.

Shared platform helpers to reuse instead of duplicating logic:

- `client/extension/gameProfiles.ts`: game metadata, paths, cache keys,
  language IDs, capability switches.
- `client/extension/indexing/`: shared localisation and workspace-symbol index.
- `client/extension/pathScope.ts`: neutral path containment helpers.
- `client/extension/fileExtensions.ts`: case-insensitive extension matching.

For full module inventory, read `ARCHITECTURE.md`.

## Submodule Boundaries

There are two important submodules, with different ownership rules:

- `submodules/cwtools/` is the upstream F# CWTools library. It contains parser,
  validation, game model, shader, and scripted-type semantics used by the
  language server. Changes here are separate git commits inside the submodule,
  followed by a root commit updating the submodule pointer.
- `submodules/cwtools-stellaris-config/` is the Stellaris CWT rule/config data.
  Treat it as rules content, not extension code. Rules sync/report workflows
  compare game script documentation, vanilla `common/`, and this config
  baseline. Packaging zips its `config/` directory into
  `release/rules/stellaris-rules.zip` as a fallback rule bundle.

Do not mix library semantics changes and rules-data updates in one undifferentiated
commit. State which submodule moved and why.

For CWT rule authoring details, read `docs/cwt-rule-config.md`.

## Editing Rules

- Keep changes scoped to the requested behavior.
- Prefer existing helpers, local patterns, and structured APIs over new
  abstractions.
- Do not revert user changes or unrelated dirty worktree state.
- Do not duplicate version numbers in docs or comments. The root `package.json`
  and `release/package.json` are the sources of truth.
- Use `ErrorReporter` instead of bare `console.error` in extension/AI code.
- Add bounded caches for data that can grow with workspace or vanilla size.
- Prefer structured reads (`IndexService`, LSP/deep queries, document symbols,
  `get_pdx_block`) before raw workspace scans.
- Preserve localisation encoding/BOM expectations when writing `.yml` files.
- Avoid unnecessary Unicode escapes for normal text and user-visible strings.
  Keep escapes only for control characters or regex safety.
- Keep comments and changelog entries concise. Explain only non-obvious
  constraints or user-visible changes.

Internationalization is required for user-visible copy. Update English and
Chinese strings together for commands, settings, diagnostics, chat/workflow UI,
Webviews, and release-facing docs. Prefer:

- `client/extension/ai/messages.ts`
- `client/extension/ai/workflowI18n.ts`
- `client/webview/chat/i18n.ts`

## Webview Rules

Webviews run in a browser sandbox:

- Do not import `vscode`, `fs`, `path`, or Node-only APIs.
- Do not use `require()`.
- Communicate with the Extension Host via `postMessage`.
- Do not hard-code colors; use VS Code theme variables.
- Support `prefers-reduced-motion`.
- Dispose Three.js/WebGL renderers, geometries, materials, textures, workers,
  listeners, and animation loops.
- Keep file I/O and `ReadTracker` logic in the Extension Host, never in Webview.
- Prefer extracted modules under `client/webview/chat/` over growing
  `client/webview/chatPanel.ts`.

## AI Tool Changes

When adding or changing an AI tool, update coordinated surfaces together:

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts` if access policy changes
5. `client/extension/ai/agentTools.ts`

Key constraints:

- `tools/registry.ts` is the source of truth for mode gating, read/write
  classification, `effect`, `riskLevel`, and `concurrencyClass`.
- `runner/toolInvocation.ts` normalizes tool calls, repairs args, derives risk
  metadata, extracts target paths, and assigns stable invocation IDs.
- `runner/toolScheduler.ts` enforces concurrency classes and per-file write
  exclusion. Reads of files with in-flight writes wait via
  `writeCoordinator.afterCurrentWrites`.
- `runner/commandPreflight.ts` classifies `run_command`; high-risk or escalated
  commands require permission.
- `planModeGuard.ts` gates writes and read-only `git_ops` in non-writing modes.
- `runner/permissionPolicy.ts` must keep hardened `cwdScope` checks based on
  `path.relative`, not string-prefix tests.
- File writes go through `PartitionedWriteQueue`; multi-file writes acquire
  locks in sorted path order.
- Generic write tools reject `.yml` localisation writes; use
  `write_localisation`.
- `edit_file(filePath, oldString, newString, replaceAll?)` is the single
  occurrence fuzzy edit primitive. Update `editFileReplacer.test.ts` if
  replacement strategies change.
- `apply_patch`, `multi_replace_file_content`, and `ast_mutate` are retired from
  the model-visible toolset. Do not re-expose them.
- Weak-tool-call providers use `tools/schemaFlatten.ts`; `nestArguments()`
  reverses flattening before execution.
- Active multi-agent tools are `dispatch_agents`, `query_blackboard`, and
  `merge_results`. Do not revive older `spawn_sub_agents` naming.

## AI Runtime Hotspots

Read `ARCHITECTURE.md` before making large runner changes. High-risk files:

- `client/extension/ai/agentRunner.ts`
- `client/extension/ai/runner/checkpoint.ts`
- `client/extension/ai/runner/writeCoordinator.ts`
- `client/extension/ai/runner/toolScheduler.ts`
- `client/extension/ai/runner/permissionPolicy.ts`
- `client/extension/ai/runner/policyEngine.ts`
- `client/extension/ai/runner/autoReviewer.ts`
- `client/extension/ai/runner/runLedger.ts`
- `client/extension/ai/runner/runReducers.ts`
- `client/extension/ai/runner/readTracker.ts`
- `client/extension/ai/orchestrator/subAgentSandbox.ts`

New run event types must update reducers and Webview renderers. Resume state must
keep V2 compatibility.

## MCP Server

The MCP server in `packages/` is read-only by design.

- `packages/cwtools-shared/src/tools/names.ts` and
  `tools/generate-mcp-schema.cjs` must stay in sync.
- Schema is generated to
  `packages/cwtools-shared/src/generated/mcpTools.ts`; do not hand-write it.
- Run `npm run generate:mcp-schema` and `npm run test:contracts` after MCP tool
  changes.
- New semantic capability must land as a `cwtools.ai.*` LSP command first, then
  route through `packages/cwtools-shared/src/tools/toolHandlers.ts`.
- Any read-only `cwtools.ai.*` command must also be added to
  `LanguageServer.fs` `isReadCmd`.
- `cwtools-mcp` must reject non-whitelisted write tools with
  `tool_not_available`.
- Packaging bundles MCP to `release/bin/mcp/cwtools-mcp.cjs`.
- Same-version VS Code reinstalls do not replace installed files. Delivering MCP
  changes to an installed extension requires a version bump and reinstall.

## F# And Shader Notes

When touching F# backend or shader features:

- Reuse `PdxShaderFeatures` helpers instead of duplicating shader parsing in
  `Program.fs`.
- Keep expensive shader parsing cached by file text hash where supported.
- Use bracket-depth scanning for nested blocks such as `Samplers` and
  `VertexStruct`; avoid single-layer regexes for nested structures.
- Keep built-in lazy sets outside `Program.fs` top-level clutter.
- Preserve escaped quote handling in string interval logic.
- Keep filesystem path comparisons platform-conditional:
  `OrdinalIgnoreCase` only on Windows.

## Incremental Scripted-Type Refresh

The custom scripted-type incremental refresh path spans both this repo and the
`submodules/cwtools` git submodule. Be careful:

- `src/Main/Program.fs` detects incremental scripted paths, then calls
  `IGame.RefreshScriptedTypes` / `RemoveScriptedTypes` under the game-state
  write lock.
- Upstream CWTools refresh removes old `typeDefInfo` entries by `range.FileName`,
  runs `getTypesFromDefinitions`, and rebuilds only changed type keys.
- Only Stellaris currently has a real incremental implementation; other games
  may return `false` and fall back to full refresh.
- If you modify the submodule, commit inside `submodules/cwtools` first, then
  commit the updated submodule pointer in the root repo.
- There is little upstream test coverage here. Compare incremental and full
  outputs when changing semantics.

## Packaging And Docs

- Root docs are single-source bilingual: `README.md`, `CONTRIBUTING.md`,
  `ARCHITECTURE.md`.
- `tools/build-github-docs.js` validates those docs.
- `tools/build-release-readme.js` builds `release/README.md` from root
  `README.md`.
- `package.ps1` runs the docs checks unless `-SkipDocs` is used.
- `release/package.json` is the release manifest; root `package.json` is the
  workspace source manifest. Keep release gates green before publishing.

## Verification Choices

- Docs only: `npm run build:docs`, link/path check, `npm run check:release -- --skip-compile --skip-test`.
- Extension TS: `npm run compile`, then targeted `npm run test:unit`.
- AI runner/tools: targeted unit tests, then `npm run test:unit`.
- MCP: `npm run generate:mcp-schema`, `npm run build:shared`,
  `npm run build:mcp`, `npm run test:contracts`.
- Webview: `npm run compile`, inspect Webview console in Extension Development
  Host for UI changes.
- F# backend: `dotnet build src/LSP/` and/or `dotnet build src/Main/`.
- Broad pre-release: `npm run verify`.
