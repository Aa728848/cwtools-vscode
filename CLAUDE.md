# CLAUDE.md

This file is a compact working guide for AI coding assistants in this
repository. Keep it short and operational; use `ARCHITECTURE.md` for system
background and `CONTRIBUTING.md` for human contributor workflow.

## Repository Shape

**Eddy's Stellaris CWTools** is a customized fork of CWTools VS Code support for
Paradox modding, with Stellaris as the primary target.

The main runtime layers are:

- `client/extension/`: VS Code extension host code in TypeScript.
- `client/extension/ai/`: integrated AI assistant — providers, tools, workflows,
  runner, orchestrator, project profile, game knowledge, memory, and prompt
  construction.
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

### Extension Core

| Path | Purpose |
| --- | --- |
| `client/extension/extension.ts` | Activation, command registration, LSP client setup |
| `client/extension/gameProfiles.ts` | Shared game profile registry and helpers |
| `client/extension/indexing/indexService.ts` | Shared incremental index service |
| `client/extension/indexing/locParser.ts` | Localisation YML parsing and query helpers |
| `client/extension/indexing/workspaceSymbolParser.ts` | PDXScript / asset / gui symbol parsing and queries |
| `client/extension/codeActions.ts` | AI quick fixes and diagnostic explanations |
| `client/extension/diagnosticI18n.ts` | Client-side diagnostic Chinese translation, fix advice, ignore-key matching |
| `client/extension/fileExtensions.ts` | Shared case-insensitive extension matching (`matchesExt`, `GRAPHICS_EXTS`) |
| `client/extension/fsCaseInsensitive.ts` | Case-insensitive path resolution for case-sensitive filesystems |
| `client/extension/pathScope.ts` | Neutral `isPathInsideOrEqual` / `foldPathCase` shared by UI and AI layers |
| `client/extension/*Panel.ts` / `*Parser.ts` | GUI, solar system, event chain, tech tree, and entity previews |
| `client/extension/vanillaCompare.ts` | Vanilla file diff and block migration commands |
| `client/extension/locDecorations.ts` | Localisation editor features backed by `IndexService` |
| `client/extension/graphicsFeatures.ts` | Graphics resource editor features |
| `client/extension/ddsDecoder.ts` | DDS/TGA texture decoding |
| `client/extension/pdxTokenizer.ts` | PDX script shared tokenizer |

### AI Agent Core

| Path | Purpose |
| --- | --- |
| `client/extension/ai/agentRunner.ts` | Main AI reasoning and tool execution loop |
| `client/extension/ai/agentTools.ts` | Tool dispatch, timeout, shared blackboard, and orchestrator tool entry |
| `client/extension/ai/aiService.ts` | Multi-provider HTTP/SSE AI client, request adaptation, fallback, and custom wire formats (`customApiFormat`) |
| `client/extension/ai/promptBuilder.ts` | Prompt facade, project context, and mode system prompts |
| `client/extension/ai/prompt/sections/baseSystem.ts` | Base system prompt section |
| `client/extension/ai/prompt/sections/modePrompts.ts` | Per-mode prompt sections |
| `client/extension/ai/types.ts` | Messages, tools, modes, context, artifact, and settings types |
| `client/extension/ai/providers.ts` | Provider facade, defaults, and capabilities |
| `client/extension/ai/providers/models/defaults.ts` | Default model configs per provider |
| `client/extension/ai/providers/models/capabilities.ts` | Model capability detection |
| `client/extension/ai/providers/models/pricing.ts` | Pricing engine with cache discount rates |

### AI Agent — Project Profile & Knowledge

| Path | Purpose |
| --- | --- |
| `client/extension/ai/projectProfile.ts` | `/init` project scanning, profile build/read/write, language/encoding detection |
| `client/extension/ai/chatInit.ts` | `/init` command handler, profile generation and CWTOOLS.md rendering |
| `client/extension/ai/gameKnowledge.ts` | Per-game PDXScript knowledge blocks (Stellaris, HOI4, EU4, CK2/3, VIC2/3, Imperator, EU5) |
| `client/extension/ai/skills.ts` | Skill index (built-in/user/project `SKILL.md`), prompt index + on-demand body loading via `run_skill` |
| `client/extension/ai/memoryParser.ts` | Topic-scoped `.cwtools-ai/<topicId>/.cwtools-ai-memory.md` long-term memory read/write/prune (legacy root file read as fallback) |
| `client/extension/ai/contextBudget.ts` | Token budget management and tool result trimming |
| `client/extension/ai/contextReferences.ts` | `@file`, `@folder`, `@symbol`, `@blackboard` reference resolution |

### AI Agent — Runner Pipeline

| Path | Purpose |
| --- | --- |
| `client/extension/ai/runnerPolicy.ts` | Mode-based tool filtering, iteration limits, and slim sub-agent budget |
| `client/extension/ai/planModeGuard.ts` | Plan-mode write guard (plan/blueprint/walkthrough artifact files only) and read-only `git_ops` gating (`validateGitOpsForMode`) for non-writing modes |
| `client/extension/ai/runner/compaction.ts` | History compaction and context window helpers |
| `client/extension/ai/runner/checkpoint.ts` | V2 resume state and orphan `tool_call` synthetic replies |
| `client/extension/ai/runner/writeCoordinator.ts` | `PartitionedWriteQueue` write coordination + `afterCurrentWrites` read-after-write barrier |
| `client/extension/ai/runner/fallbackPolicy.ts` | Model fallback and API error retry management |
| `client/extension/ai/runner/cancellation.ts` | LLM generation termination and exception throwing |
| `client/extension/ai/runner/stepEmitter.ts` | Fine-grained step and token delta streaming broadcast |
| `client/extension/ai/runner/toolScheduler.ts` | Concurrency class-based scheduling and per-file write exclusion |
| `client/extension/ai/runner/toolInvocation.ts` | Tool call normalization, risk metadata, target path extraction, stable IDs |
| `client/extension/ai/runner/commandPreflight.ts` | `run_command` tokenization and risk classification |
| `client/extension/ai/runner/permissionPolicy.ts` | Low-risk pre-approval rules, `cwdScope` validation, checkpoint serialize/restore |
| `client/extension/ai/runner/policyEngine.ts` | Layered permission profiles, typed rule matching/specificity, actionable denials (shadow-mode resolver) |
| `client/extension/ai/runner/autoReviewer.ts` | Read-only LLM approval reviewer: decision cache, fail-open to ask_user, never widens sandbox |
| `client/extension/ai/runner/shellEnv.ts` | Shell env allowlist builder (per-platform baseline + user additions) |
| `client/extension/ai/runner/runLedger.ts` | Run accounting, event JSONL, and frontend `runSnapshot` data source |
| `client/extension/ai/runner/runReducers.ts` | Pure event-projection reducers: run state, tool timeline, agent graph, cache stats |
| `client/extension/ai/runner/runReplay.ts` | Run replay engine — recorded-tool mode with LLM re-invocation |
| `client/extension/ai/runner/readTracker.ts` | File read/write integrity tracking (mtime + SHA-256 hash) |
| `client/extension/ai/runner/contextMemory.ts` | LLM-driven structured history compaction |
| `client/extension/ai/runner/doomLoopDetector.ts` | Anti-loop semantic detection |

### AI Agent — Tools

| Path | Purpose |
| --- | --- |
| `client/extension/ai/tools/definitions.ts` | Tool JSON Schema definitions (all tools) |
| `client/extension/ai/tools/registry.ts` | Mode gating, read/write classification, effect/risk/concurrency metadata |
| `client/extension/ai/tools/permissions.ts` | Mode and sub-agent access control |
| `client/extension/ai/tools/argRepair.ts` | Pre-execution argument name and type drift repair |
| `client/extension/ai/tools/externalTools.ts` | `run_command` and external process tool handlers |
| `client/extension/ai/tools/fileTools.ts` | File read/write/edit tool handlers |
| `client/extension/ai/tools/lspTools.ts` | LSP query, diagnostics, completion, and deep API tool handlers |
| `client/extension/ai/tools/diagnosticMetadata.ts` | Diagnostic category classification and repair-hint metadata for `analyze_diagnostic_error` |
| `client/extension/ai/tools/memoryTools.ts` | Memory read/write tool handlers |
| `client/extension/ai/tools/replacerSuite.ts` | 10-strategy fuzzy string replacement engine (Levenshtein, block anchor, similarity, etc.) |
| `client/extension/ai/tools/schemaFlatten.ts` | Tool schema auto-flattening for weak-tool-call providers |

### AI Agent — Orchestrator

| Path | Purpose |
| --- | --- |
| `client/extension/ai/orchestrator/orchestrator.ts` | Multi-agent dispatch entry, context injection, quality gate integration |
| `client/extension/ai/orchestrator/agentRegistry.ts` | Sub-agent roles, modes, budgets, and default configs |
| `client/extension/ai/orchestrator/blackboard.ts` | Cross-agent shared data with key/prefix/type queries |
| `client/extension/ai/orchestrator/taskGraphEngine.ts` | DAG construction, topological sort, ready nodes, cycle detection |
| `client/extension/ai/orchestrator/parallelExecutor.ts` | Dependency-batched parallel sub-task execution |
| `client/extension/ai/orchestrator/conflictDetector.ts` | Blackboard-based write intent and entity registration conflict detection |
| `client/extension/ai/orchestrator/qualityGate.ts` | Review and auto-fix pipeline |
| `client/extension/ai/orchestrator/subAgentSandbox.ts` | `SubAgentSandbox` construction and `enforceSubAgentSafety` interception |
| `client/extension/ai/orchestrator/worktreeManager.ts` | Opt-in per-agent git worktree isolation: create / `--binary` diff / apply / retention cleanup |

### AI Agent — Workspace & Chat Infrastructure

| Path | Purpose |
| --- | --- |
| `client/extension/ai/workspacePaths.ts` | AI storage root resolution, topic/scratch dir helpers |
| `client/extension/ai/workspaceSandbox.ts` | Path sanitization, scope resolution, and sandbox trust classification |
| `client/extension/ai/chat/bridge.ts` | Webview ↔ Extension Host communication bridge |
| `client/extension/ai/chatPanel.ts` | Extension-side chat host and Webview HTML template |
| `client/extension/ai/chatSettings.ts` | AI settings persistence |
| `client/extension/ai/chatTopics.ts` | Session topic persistence |
| `client/extension/ai/agentSessionCoordinator.ts` | Chat/manager shared session state, mode, workflow, live steps |
| `client/extension/ai/agentUiBroadcaster.ts` | Multi-Webview surface broadcast and directed send |
| `client/extension/ai/artifactStore.ts` | Agent artifact session-level storage, sorting, and stable IDs |
| `client/extension/ai/usageTracker.ts` | Cumulative token usage, cost, and cache statistics persistence |
| `client/extension/ai/diffEngine.ts` | Structural diff engine for file edits |
| `client/extension/ai/fileCache.ts` | Bounded file content cache for AI tools |
| `client/extension/ai/errorReporter.ts` | Structured error reporting (fatal/warn/debug) |
| `client/extension/ai/toolCallParser.ts` | Non-standard tool call format parsing (DSML, Qwen, etc.) |
| `client/extension/ai/jsonRepair.ts` | Incomplete JSON repair |
| `client/extension/ai/mcpClient.ts` | MCP stdio/SSE client |
| `client/extension/ai/inlineProvider.ts` | AI inline (FIM) completion for PDXScript with local/LSP fast-paths and LRU cache |

### Webview

| Path | Purpose |
| --- | --- |
| `client/webview/chatPanel.ts` | AI chat UI, workflow, settings, artifacts, plan cards, diff display |
| `client/webview/agentManager.ts` | Detached Agent Manager: runs, agents, artifacts, tasks |
| `client/webview/messageRenderer.ts` | Message rendering including cache sparkline cards |
| `client/webview/svgIcons.ts` | High-fidelity SVG icon library |
| `client/webview/chat/` | Extracted chat and Agent Manager browser modules (22 files) |
| `client/webview/entityPreview.ts` | Three.js entity renderer |
| `client/webview/guiPreview.ts` | `.gui` Canvas preview, drag editing, DDS/TGA display |
| `client/webview/solarSystemPreview.ts` | Star system, orbit, planet interactive preview |
| `client/webview/eventChainPreview.ts` | Cytoscape.js event reference graph |
| `client/webview/techTreePreview.ts` | Cytoscape.js tech dependency graph |

### F# Backend

| Path | Purpose |
| --- | --- |
| `src/LSP/` | Reusable LSP protocol and parser layer |
| `src/Main/Program.fs` | `CWTools Server` entry, semantic tokens, document symbols, shader bridge |
| `src/Main/GameLoader.fs` | Vanilla FX source loading |
| `submodules/cwtools/CWTools/Game/PdxShaderFeatures.fs` | Shader parsing and feature extraction |

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
  exclusion. Reads of a file with an in-flight write are ordered after it via
  `writeCoordinator.afterCurrentWrites`; `getAgentToolTargetFiles` extracts paths
  for `read_file`/`get_pdx_block`/`get_file_context`/`edit_file` too.
- `runner/commandPreflight.ts` classifies `run_command`; high-risk or escalated
  commands must require user permission.
- `planModeGuard.ts` also gates `git_ops` in non-writing modes
  (`validateGitOpsForMode`): explore/review/script/orchestrator/plan may only run
  `status`/`diff`; enforced before execution in `agentRunner` and `agentTools`.
- `runner/permissionPolicy.ts` must keep hardened `cwdScope` checks based on
  `path.relative`, not string-prefix tests.
- File writes go through `PartitionedWriteQueue`; multi-file writes acquire
  locks in sorted path order.
- Generic write tools reject `.yml` localisation writes; use
  `write_localisation`.
- `edit_file(filePath, oldString, newString, replaceAll?)` is the single-occurrence
  fuzzy edit primitive (registry `EDIT`, `per-file-write`); it shares the same
  guards as the other edit tools (`.yml` reject, ReadTracker, pending-write
  confirmation).
- `apply_patch`, `multi_replace_file_content`, and `ast_mutate` are retired from
  the model-visible toolset (`agentTools.execute()` redirects them to
  `edit_file`/`replace_lines`/`edit_pdx_block`/`write_localisation`); their
  implementations remain for internal callers only. Do not re-expose them.
- `read_file` output is line-number prefixed (`N | line`);
  `tools/replacerSuite.ts` exports `stripLineNumberPrefixes` and `fuzzyReplace`
  strips pasted prefixes as a fallback strategy so prefixed text in
  `edit_file` args still matches.
- `tools/replacerSuite.ts` provides a 10-strategy fuzzy replacement engine
  (`fuzzyReplace`) used by the `FileToolHandler.replace()` helper backing the
  `edit_file` tool and internal hunk application in `tools/fileTools.ts`
  (`replace_lines` is purely line-range based); changes to replacement
  strategies should update `editFileReplacer.test.ts`.
- `tools/schemaFlatten.ts` auto-flattens deep tool schemas for weak providers;
  `nestArguments()` reverses the flattening before tool execution.

The active multi-agent tools are `dispatch_agents`, `query_blackboard`, and
`merge_results`. Do not revive older `spawn_sub_agents` naming.

## AI Runtime Notes

- `runner/runLedger.ts` records each run as an `AgentRunRecord` plus append-only
  `AgentRunEvent` JSONL. Events use per-run sequence numbers, and snapshots feed
  chat and Agent Manager UI. Supports `cache_stats` events carrying `cachedTokens`,
  `cacheCreationTokens`, `hitRate`, and `savedCostCny` for real-time sparkline cards.
- `runner/runReducers.ts` contains pure event-projection reducers:
  `reduceRunState`, `reduceToolTimeline`, `reduceAgentGraph`, `reduceCacheStats`,
  `reducePolicyActivity`, and `reduceAll`. These are side-effect-free and designed
  for unit testing and JSONL replay. New event types must update the relevant reducer.
- `runner/runReplay.ts` enables re-running a recorded agent run with new
  prompt/model/provider overrides. Mode A (recorded-tool) answers tool calls
  from the original ledger; Mode B (full-replay) is deferred. `ReplaySession`
  indexes tool call results by canonicalized args.
- `runner/readTracker.ts` tracks file reads with mtime + SHA-256 hash and
  prevents writes to files not yet read or modified externally since last read.
  Sits in Extension Host only — never in Webview.
- `runner/checkpoint.ts` owns V2 resume state and synthetic interrupted tool
  replies for orphaned `tool_call`s. Keep V2 resume compatibility.
- `runner/contextMemory.ts` produces structured compacted summaries that
  `promptBuilder.ts` can inject on resume.
- `client/webview/chat/runTimeline.ts` and `runInspector.ts` render run events.
  New event types (such as `cache_stats`) should update both.
- ReadTracker & File I/O is constrained in Extension Host. Webviews must only
  request files via IPC; do not perform direct raw file handling or I/O tracking inside the browser sandbox.
- Orchestrator sub-agents must be constrained through
  `orchestrator/subAgentSandbox.ts` and `enforceSubAgentSafety`. Sub-agents whose
  `plannedFiles` are all localisation `.yml` are forced onto `write_localisation`
  (generic write tools excluded) and `dispatch_agents` upgrades such tasks to
  `loc_writer`.
- Agent boundary & permissions (docs/agent-boundary-permissions-plan.md):
  - `runner/policyEngine.ts` resolves layered profiles (only `user` and
    `approvals` layers may loosen; mode/workflow/role/task tighten-only;
    protectedPaths lower into global-default deny rules). It currently runs in
    shadow mode from `agentRunner.shadowPolicyResolve` (`cwtools.ai.policy.shadow`,
    default on; preset via `cwtools.ai.policy.preset`) and logs `policy_resolved`
    events without enforcing.
  - Approval learning: the permission card's "always allow" and auto-review's
    `approve_with_rule` create session rules in `PermissionPolicyStore`
    (deduped) via `deriveCommandPrefix`; commands carrying inline-eval flags
    (`-c`/`-e`/`-p`/`--eval`/`-Command`/`-EncodedCommand`) never learn rules.
    Rules persist through V2 checkpoints (`AgentResumeState.permissionRules`)
    so resumed runs do not re-prompt. Rule changes invalidate the reviewer cache.
  - Auto-review (`cwtools.ai.approvals.reviewer` = `user` | `auto_review`):
    `runner/autoReviewer.ts` reviews from structured metadata only; escalations
    and risk-3 always go to the user; reviewer rules are session-scoped and
    capped at risk 2; inline-eval commands are never served from or written to
    the reviewer decision cache (`hasInlineEvalPayload`).
  - Write-mode quick ladder (composer selector / `quickChangeWriteMode`):
    confirm < auto < auto_review < full. auto_review sets
    `agentFileWriteMode=auto` + `approvals.reviewer=auto_review`; full maps to
    `cwtools.ai.developer.disableSecuritySandbox=true` (everything
    auto-resolves at the approval boundary, still fully logged; the ladder is
    its only entry/exit). The ladder aligns `cwtools.ai.policy.preset` across
    `workspace-auto` / `workspace-auto-review` / `full-access` (manual
    `read-only`/`trusted-automation` presets are not clobbered). Approval is
    mode-agnostic: utility has no auto-approve privilege — every mode shares
    safe-command auto-approval, learned rules, reviewer, then user. Escalation
    is decided from structured flags (`preflight.escalation` /
    `requiresEscalation` / `context.escalation`); the `[ESCALATION]`
    description regex is only a fallback.
  - MCP: dynamic `mcp_<server>_<tool>` names share `mcp_call` registry gating;
    `executeMcpTool` is the single permission chokepoint (sub-agents default
    deny unless a `cwtools.ai.permissions.mcp` allow pattern matches). The main
    agent intentionally defaults to allow when no pattern matches (compat
    default until the enforcement rollout step); add a `"*": "ask"` pattern to
    fail closed. Optional dynamic registration via
    `cwtools.ai.mcp.registerDynamicTools` keeps a reverse name map so server
    names containing `_` resolve unambiguously.
  - Shell env allowlist via `cwtools.ai.shell.envAllowlist` (`off`/`log`/`enforce`,
    default `log`) with additions in `cwtools.ai.shell.envAllowlistAdditions`.
  - `dispatch_agents` rejects tasks whose `plannedFiles` escape the workspace;
    `buildSubAgentSandbox` clamps child write scope to parent writable roots and
    reports `rejectedScopes` (`subagent_policy_derived` event).
- The custom provider supports four wire formats via `customApiFormat`
  (`openai-chat-completions`, `openai-responses`, `anthropic-messages`,
  `gemini-generate-content`). Endpoints are stored per provider in
  `cwtools.ai.providerEndpoints`; the legacy global `cwtools.ai.endpoint` is
  migrated by `aiService.migrateLegacyEndpoint()` — do not reintroduce it.
- `extension.ts` enriches LSP diagnostics through
  `client/extension/diagnosticI18n.ts` (Chinese translation + fix advice,
  gated by `cwtools.ai.enhancedDiagnostics`); ignore-list matching runs against
  the original server message before enrichment. Diagnostic codes link to
  `docs/diagnostic-codes.md` via server-side `codeDescription`.

## Project Profile & `/init`

- `chatInit.ts` handles the `/init` slash command: scans workspace, builds
  `ProjectProfile`, writes `.cwtools-ai/project/profile.json`, and renders
  `CWTOOLS.md` markdown rules.
- `projectProfile.ts` contains all scanning logic: directory detection,
  localisation language/encoding detection, namespace/identifier sampling,
  game detection, prompt card generation, and the `queryProjectProfile` tool handler.
- Language detection regex uses word-boundary + negative lookahead to extract the
  rightmost `l_<lang>` tag from `.yml` filenames (e.g., `_l_simp_chinese.yml`
  → `l_simp_chinese`). Do not regress to greedy `l_([a-z_]+)\.yml$`.
- `promptBuilder.ts` caches the profile and injects it as a `PROJECT PROFILE`
  block in the system prompt when available.

## AI Workspace Paths & Sandbox

- `workspacePaths.ts` resolves AI storage root (`.cwtools-ai/`), topic dirs,
  scratch dirs, and multi-candidate paths across workspace folders.
- `workspaceSandbox.ts` sanitizes path input, resolves workspace folder aliases,
  classifies path scope (`project`/`ai`/`workspace`/`outside`), and provides
  `isPathInsideOrEqual` using `path.relative`.
- `runnerPolicy.ts` centralizes mode-based tool filtering, per-mode iteration
  limits, slim sub-agent output budget, and tool exclusion logic.

## Game Knowledge & Memory

- `gameKnowledge.ts` provides per-game PDXScript knowledge blocks for 9 games
  (Stellaris, HOI4, EU4, CK2, CK3, VIC2, VIC3, Imperator, EU5) plus a generic
  Paradox fallback. `getGameKnowledge(languageId)` returns the appropriate block.
- `skills.ts` indexes `SKILL.md` files (built-in, user, and project scopes) and
  parses their frontmatter. `promptBuilder.ts` injects a compact skill index via
  `buildSkillIndexPrompt`; full skill bodies are loaded on demand through the
  `run_skill` tool, keeping the base prompt small.
- `memoryParser.ts` manages topic-scoped long-term memory at
  `.cwtools-ai/<topicId>/.cwtools-ai-memory.md` (the legacy workspace-root file
  is still read as a fallback): cached reads keyed by topic, appends, and
  priority-based auto-prune when exceeding `MAX_MEMORY_CHARS` (4000 chars /
  ~1000 tokens).
- `usageTracker.ts` persists cumulative token usage, cost, and cache statistics
  across sessions. Used by the settings overview and Agent Manager dashboard.

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
`src/Main/Main.fsproj` lists `RuntimeIdentifiers` for `win-x64`, `linux-x64`,
and `osx-x64`; a plain `dotnet build` works without an explicit RID.

Server-side diagnostics carry `codeDescription` links to
`docs/diagnostic-codes.md` plus LSP `tags`; keep new diagnostic codes documented
there. The server also implements `.yml`/PDX document formatting and a
completion read-lock timeout fallback (stale-cache degraded response) — keep
filesystem path comparisons platform-conditional (`OrdinalIgnoreCase` only on
Windows).

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
- Packaging: follow `.agents/workflows/package.md`, or run `package.ps1` (or npm run pack:install) to build and install locally.
