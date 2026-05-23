# CLAUDE.md

This file is a compact working guide for AI coding assistants in this
repository. Keep it short and operational; use `ARCHITECTURE.md` for system
background and `CONTRIBUTING.md` for human contributor workflow.

## Repository Shape

**Eddy's Stellaris CWTools** is a customized fork of CWTools VS Code support for
Paradox modding, with Stellaris as the primary target.

The main runtime layers are:

- `client/extension/`: VS Code extension host code in TypeScript.
- `client/extension/ai/`: integrated AI assistant, tools, workflows, providers,
  runner, and orchestrator.
- `client/webview/`: browser-sandboxed Webview UIs bundled by Rollup.
- `src/LSP/` and `src/Main/`: .NET 9 / F# language server protocol layer and
  `CWTools Server` executable.
- `submodules/cwtools/`: upstream CWTools F# library, including shared game and
  shader parsing code.

Two shared platform pieces should be reused instead of duplicating logic:

- `client/extension/gameProfiles.ts`: multi-game metadata, paths, cache keys,
  language IDs, and capability switches.
- `client/extension/indexing/`: shared localisation and workspace-symbol index.

Do not duplicate version numbers in docs or code comments. The source of truth
is the root `package.json`; release metadata lives in `release/package.json` and
is checked by the release gate.

## Start Here

Before editing, inspect the current tree because this fork changes quickly:

```bash
git status --short
rg --files
```

Use these common verification commands from the repository root:

```bash
npm run compile
npm run lint
npm run test:unit
npm run test
npm run check:release
npm run verify
dotnet build src/LSP/
dotnet build src/Main/
```

`npm run compile` runs TypeScript compilation and Rollup. Rollup currently
builds these Webview entries into `release/bin/client/webview/`:

- `chatPanel.ts`
- `agentManager.ts`
- `guiPreview.ts`
- `solarSystemPreview.ts`
- `eventChainPreview.ts`
- `techTreePreview.ts`
- `entityPreview.ts`

`npm run verify` is the broad local gate: lint, compile, unit tests, and release
checks.

## High-Value Paths

| Path | Purpose |
| --- | --- |
| `client/extension/extension.ts` | Activation, command registration, LSP client setup |
| `client/extension/gameProfiles.ts` | Shared game profile registry and helpers |
| `client/extension/indexing/` | Localisation and workspace-symbol index layer |
| `client/extension/codeActions.ts` | AI quick fixes and diagnostic explanations |
| `client/extension/*Panel.ts` / `*Parser.ts` | GUI, solar system, event chain, tech tree, and entity previews |
| `client/extension/vanillaCompare.ts` | Vanilla file diff and block migration commands |
| `client/extension/locDecorations.ts` | Localisation editor features backed by `IndexService` |
| `client/extension/ai/agentRunner.ts` | Main AI reasoning and tool execution loop |
| `client/extension/ai/runner/` | Compaction, checkpoints, scheduling, permissions, ledger, memory |
| `client/extension/ai/tools/` | Tool schemas, registry, permissions, handlers, argument repair |
| `client/extension/ai/orchestrator/` | Multi-agent DAG, blackboard, sandbox, conflict and quality gates |
| `client/webview/chat/` | Extracted chat and Agent Manager browser modules |
| `client/webview/entityPreview.ts` | Three.js entity renderer |
| `src/LSP/` | Reusable LSP protocol and parser layer |
| `src/Main/` | `CWTools Server` executable entry point and feature bridge |

## Editing Guardrails

- Prefer existing helpers and local patterns over new abstractions.
- Keep changes scoped to the requested behavior.
- Prefer structured reads (`IndexService`, LSP/deep queries, document symbols,
  `get_pdx_block`) before raw workspace scans or shell commands.
- Add bounded caches for data that can grow with workspace or vanilla size.
- Use `ErrorReporter` instead of bare `console.error` in extension/AI code.
- Put user-visible Chinese text in the existing message/i18n modules when
  practical: `client/extension/ai/messages.ts`,
  `client/extension/ai/workflowI18n.ts`, and `client/webview/chat/i18n.ts`.
- Do not hard-code Webview colors; use VS Code theme variables.
- Preserve localisation encoding/BOM expectations when writing `.yml` files.

## AI Tool Changes

When adding or changing an AI tool, update the coordinated surfaces together:

1. `client/extension/ai/tools/definitions.ts`
2. `client/extension/ai/types.ts`
3. `client/extension/ai/tools/registry.ts`
4. `client/extension/ai/tools/permissions.ts` if access policy changes
5. `client/extension/ai/agentTools.ts`

Important constraints:

- `tools/registry.ts` is the source of truth for tool mode gating, read/write
  classification, `effect`, `riskLevel`, and `concurrencyClass`.
- `runner/toolInvocation.ts` normalizes tool calls, repairs args, derives risk
  metadata, extracts target paths, and assigns stable invocation IDs.
- `runner/toolScheduler.ts` enforces concurrency classes and per-file write
  exclusion.
- `runner/commandPreflight.ts` classifies `run_command`; high-risk or escalated
  commands must require user permission.
- `runner/permissionPolicy.ts` must keep hardened `cwdScope` checks based on
  `path.relative`, not string-prefix tests.
- File writes go through `PartitionedWriteQueue`; multi-file writes acquire
  locks in sorted path order.
- Generic write tools reject `.yml` localisation writes; use
  `write_localisation`.

The active multi-agent tools are `dispatch_agents`, `query_blackboard`, and
`merge_results`. Do not revive older `spawn_sub_agents` naming.

## AI Runtime Notes

- `runner/runLedger.ts` records each run as an `AgentRunRecord` plus append-only
  `AgentRunEvent` JSONL. Events use per-run sequence numbers, and snapshots feed
  chat and Agent Manager UI. Supports `cache_stats` events carrying `cachedTokens`,
  `cacheCreationTokens`, `hitRate`, and `savedCostCny` for real-time sparkline cards.
- `runner/checkpoint.ts` owns V2 resume state and synthetic interrupted tool
  replies for orphaned `tool_call`s. Keep V2 resume compatibility.
- `runner/contextMemory.ts` produces structured compacted summaries that
  `promptBuilder.ts` can inject on resume.
- `client/webview/chat/runTimeline.ts` and `runInspector.ts` render run events.
  New event types (such as `cache_stats`) should update both.
- ReadTracker & File I/O is constrained in Extension Host. Webviews must only
  request files via IPC; do not perform direct raw file handling or I/O tracking inside the browser sandbox.
- Orchestrator sub-agents must be constrained through
  `orchestrator/subAgentSandbox.ts` and `enforceSubAgentSafety`.

## Webview Rules

Webviews run in a browser sandbox. They cannot access Node.js, `fs`, `path`,
`require()`, or the VS Code API directly.

- Communicate with the extension host only through `postMessage`.
- Keep host-side state shared through `AgentSessionCoordinator`,
  `AgentUiBroadcaster`, and `ArtifactStore` where applicable.
- Prefer extracted modules under `client/webview/chat/` over growing
  `chatPanel.ts`.
- Support `prefers-reduced-motion`.
- Dispose Three.js/WebGL geometries, materials, textures, renderers, workers,
  event listeners, and animation loops when panels are torn down.

## F# And Shader Notes

`global.json` pins .NET SDK `9.0.300` with `latestMinor` roll-forward.

Shader support spans `src/Main/Program.fs`, `src/Main/GameLoader.fs`, and
`submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs`.

When touching shader features:

- Reuse `PdxShaderFeatures` helpers instead of duplicating shader parsing in
  `Program.fs`.
- Keep expensive shader parsing cached by file text hash where supported.
- Use bracket-depth scanning for nested blocks such as `Samplers` and
  `VertexStruct`; avoid single-layer `[^}]+` regexes for nested structures.
- Keep built-in lazy sets outside `Program.fs` top-level clutter; F# top-level
  indentation is fragile.
- Preserve escaped quote handling in string interval logic.

Vanilla block migration lives in `client/extension/vanillaCompare.ts`. When
editing block migration, keep replacements ordered from bottom to top so earlier
line offsets are not invalidated by later edits.

## Verification Choices

Use the narrowest validation that matches the change:

- Docs only: check links, paths, and commands against the current tree.
- TypeScript extension or AI changes: `npm run compile`; add
  `npm run test:unit` for risky shared behavior.
- Tool/workflow/index changes: run the focused unit tests, then broaden if the
  behavior crosses modules.
- Webview changes: `npm run compile`; inspect the relevant panel in an Extension
  Development Host when UI behavior changes.
- F# LSP changes: `dotnet build src/LSP/` or `dotnet build src/Main/`.
- Release-sensitive changes: `npm run verify`.
- Packaging: follow `.agents/workflows/package.md`; the root currently has no
  `package.ps1`.
