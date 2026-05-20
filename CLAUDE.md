# CLAUDE.md

This file gives AI coding assistants the current working map for this repository.

## Project Overview

**Eddy's Stellaris CWTools** is a heavily customized fork of
[CWTools](https://github.com/cwtools/cwtools-vscode). It is a Visual Studio Code
extension for Paradox game modding, with Stellaris as the primary target.

The project has four main runtime layers:

1. `client/extension/`: VS Code extension host code in TypeScript.
2. `client/extension/ai/`: the integrated AI assistant, providers, tools, workflows, and orchestrator.
3. `client/webview/`: browser-sandboxed Webview UIs bundled by Rollup.
4. `src/`: .NET 9 / F# language server and launcher projects backed by the `submodules/cwtools` submodule.

Two shared platform pieces now matter across those layers:

- `client/extension/gameProfiles.ts`: centralized multi-game profile metadata.
- `client/extension/indexing/`: shared localisation and workspace-symbol indexing.

Do not duplicate version numbers in guidance docs. The source of truth is the
root `package.json`; release metadata lives in `release/package.json` and is
checked by the release gate.

## Current Build And Test Commands

Use these from the repository root:

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

`npm run compile` runs `tsc -p ./tsconfig.extension.json` and then `rollup -c`.
Rollup builds seven Webview entry points into `release/bin/client/webview/`:

- `chatPanel.ts`
- `agentManager.ts`
- `guiPreview.ts`
- `solarSystemPreview.ts`
- `eventChainPreview.ts`
- `techTreePreview.ts`
- `entityPreview.ts`

`npm run verify` is the broad project gate: lint, compile, unit tests, and the
release checks. `npm run test:unit` discovers tests under
`client/test/unit/**/*.test.ts`.

## High-Value Paths

| Path | Purpose |
| --- | --- |
| `client/extension/extension.ts` | Main activation, command registration, LSP client setup |
| `client/extension/gameProfiles.ts` | Shared game profile registry and path/capability helpers |
| `client/extension/indexing/` | Shared localisation and workspace symbol/asset index layer |
| `client/extension/codeActions.ts` | AI quick fixes and explanations for diagnostics |
| `client/extension/guiPanel.ts` / `guiParser.ts` | `.gui` preview host and parser |
| `client/extension/solarSystemPanel.ts` / `solarSystemParser.ts` | Solar system initializer preview |
| `client/extension/eventChainPanel.ts` / `eventChainParser.ts` | Event chain visualizer |
| `client/extension/techTreePanel.ts` / `techTreeParser.ts` | Technology tree visualizer |
| `client/extension/entityPanel.ts` / `entityAssetParser.ts` | 3D entity preview host and asset parser |
| `client/extension/vanillaCompare.ts` | Vanilla file comparison tools |
| `client/extension/locDecorations.ts` | Localization editor features backed by `IndexService` |
| `client/extension/ai/agentManagerHtml.ts` | Detached Agent Manager Webview HTML host |
| `client/webview/chatPanel.ts` / `client/webview/chat/` | Chat Webview shell plus extracted view/model helpers |
| `client/webview/agentManager.ts` / `agentManager.css` | Agent Manager surface for agents, artifacts, and tasks |
| `client/webview/messageRenderer.ts` | Shared chat message rendering logic |
| `client/webview/entityPreview.ts` | Three.js entity renderer |
| `src/LSP/` | Reusable LSP protocol and parser layer |
| `src/Main/` | `CWTools Server` executable entry point |

## Platform And Index Layer

`gameProfiles.ts` centralizes game-specific metadata instead of scattering game
names, cache keys, localisation folders, and preview capabilities throughout the
extension. Consumers should query the profile helpers rather than add new
hard-coded branches.

`IndexService` in `client/extension/indexing/indexService.ts` is the shared
knowledge layer for editor features and AI tools:

- Localisation keys are indexed eagerly during activation.
- The heavier workspace/vanilla symbol and asset index is built lazily through
  `ensureWorkspaceSymbolsReady()`.
- `locParser.ts` and `workspaceSymbolParser.ts` keep the pure parsing/query logic
  testable without VS Code dependencies.
- AI tools expose the layer through `query_localisation_index` and
  `query_workspace_index`.

When a shared index or AST/LSP query already answers the question, prefer that
over adding another ad hoc workspace scan.

## AI Module Map

The AI module lives in `client/extension/ai/`.

| Path | Purpose |
| --- | --- |
| `agentRunner.ts` | Main reasoning loop and execution flow coordinator |
| `runner/` | Orchestration helpers: `compaction.ts`, `checkpoint.ts`, `writeCoordinator.ts`, `fallbackPolicy.ts`, `cancellation.ts`, `stepEmitter.ts`, `toolScheduler.ts`, and `doomLoopDetector.ts` |
| `chat/` | Extracted Webview host bridge: `bridge.ts` for sandboxed message routing |
| `agentSessionCoordinator.ts` | Shared chat/manager session state holder |
| `agentUiBroadcaster.ts` | Broadcasts host messages to chat and manager surfaces |
| `artifactStore.ts` | Session-scoped artifact storage and stable artifact IDs |
| `agentManagerHtml.ts` | HTML template for the detached Agent Manager panel |
| `agentTools.ts` | Slim tool dispatch router to dedicated handlers |
| `tools/registry.ts` | Canonical tool registry, mode allowlists, write/read-only classification |
| `tools/permissions.ts` | Centralized tool access validation for modes and sub-agents |
| `tools/argRepair.ts` | Schema-aware tool-call argument repair |
| `tools/*.ts` | Dedicated tool handlers: `fileTools.ts`, `lspTools.ts`, `memoryTools.ts`, `externalTools.ts`, and `replacerSuite.ts` |
| `aiService.ts` | Provider HTTP clients, streaming, request shaping, provider fallbacks |
| `providers.ts` | Built-in provider metadata and capability checks |
| `providers/models/` | Provider defaults, model capabilities, pricing table |
| `promptBuilder.ts` | System prompts, mode prompts, project context injection facade |
| `prompt/sections/` | Extracted base rules and mode prompt builders |
| `workflowRegistry.ts` | Stable workflow metadata and tool policies |
| `workflowI18n.ts` / `workflowViewModel.ts` | Localized workflow presentation for the chat UI |
| `types.ts` | Agent mode, tool, message, artifact, and context types |
| `contextBudget.ts` | Token budgeting and tool-result truncation |
| `contextReferences.ts` | `@file`, `@folder`, `@symbol`, `@blackboard` references |
| `chatPanel.ts` / `chatHtml.ts` | Extension-side chat host and Webview HTML template |
| `chatSettings.ts` / `chatTopics.ts` | Persistent settings and chat topic storage |
| `toolCallParser.ts` / `jsonRepair.ts` | Non-standard tool call and malformed JSON recovery |
| `mcpClient.ts` | MCP stdio/SSE client |
| `inlineProvider.ts` | AI inline completion provider |
| `orchestrator/` | DAG-based multi-agent orchestration, blackboard, conflict detection, quality gate |

Agent modes are defined in `types.ts`:

```ts
build | plan | explore | general | utility | review | gui_expert | script_reviewer | loc_translator | loc_writer | orchestrator
```

`general` is kept for saved-topic compatibility; `utility` is the current
general-purpose workspace mode for non-PDXScript scripts and tools.

### Workflows And Orchestration

`workflowRegistry.ts` currently registers five guided workflows:

- `diagnostic-fix`
- `loc-generation`
- `event-chain-design`
- `rules-sync-review`
- `asset-wiring`

The runner applies workflow tool policies and prompt supplements, while the chat
UI renders localized workflow metadata through the workflow view-model layer.

Orchestrator mode uses `dispatch_agents`, `query_blackboard`, and `merge_results`.
Specialist roles are registered in `client/extension/ai/orchestrator/agentRegistry.ts`
and currently include `explorer`, `architect`, `builder`, `locWriter`, `reviewer`,
`assetGen`, `guiExpert`, and `locTranslator`.

## AI Tool Rules

When adding or changing an AI tool, update the coordinated surfaces together:

1. `client/extension/ai/tools/definitions.ts`: OpenAI-style JSON schema.
2. `client/extension/ai/types.ts`: args and result contracts.
3. `client/extension/ai/tools/registry.ts`: tool name, allowed modes, write/read-only flags, sub-agent policy.
4. `client/extension/ai/tools/permissions.ts`: access behavior if mode/sub-agent policy changes.
5. `client/extension/ai/agentTools.ts`: execution dispatch.

Important current tool details:

- The schema file defines more than 50 tools.
- `tools/registry.ts`, not `agentRunner.ts`, is the source of truth for
  `WRITE_TOOLS`, `READ_ONLY_TOOLS`, and tool-mode gating.
- `tools/permissions.ts` validates mode and sub-agent access from the registry.
- `tools/argRepair.ts` repairs common malformed tool-call arguments before execution.
- File writes are serialized by `PartitionedWriteQueue` per target file.
- Multi-file writes must acquire file locks in sorted path order.
- `todo_write` is intentionally excluded from the global file-write lock path.
- Generic write tools reject `.yml` localization writes; use `write_localisation`.
- Prefer semantic read paths such as `query_workspace_index`, `document_symbols`,
  `get_pdx_block`, and targeted `read_file` ranges before falling back to raw
  shell reads.
- `run_command` is a supplemental execution channel with permission gating, not
  the primary way to understand PDXScript structure.
- The active multi-agent tool is `dispatch_agents`, not the older
  `spawn_sub_agents` naming.

## Webview Rules

Webviews run in a restricted browser sandbox. They cannot access Node.js, `fs`,
`path`, `require()`, or the VS Code API directly.

Use `postMessage` for all host/Webview communication:

- Extension host files: `client/extension/*Panel.ts`, `client/extension/ai/chatPanel.ts` (bridged via `ai/chat/bridge.ts`).
- Webview files: `client/webview/*.ts`.

The chat UI and detached Agent Manager share host-side state through
`AgentSessionCoordinator`, `AgentUiBroadcaster`, and `ArtifactStore`. Shared
browser helpers live under `client/webview/chat/`, including message contracts,
workflow, topic, artifact, markdown, annotation, i18n, and live-step modules.
Keep additional extractions aligned with that split.

Webview CSS must use VS Code theme variables such as
`var(--vscode-editor-background)` and should support `prefers-reduced-motion`.
For Three.js/WebGL code, explicitly dispose geometries, materials, textures,
renderers, event listeners, workers, and animation loops when the Webview is torn
down.

## Provider Notes

Provider compatibility helpers are exposed through `client/extension/ai/providers.ts`;
built-in defaults live in `client/extension/ai/providers/models/defaults.ts`:

- OpenAI
- Claude / Anthropic Messages API
- DeepSeek
- MiniMax and MiniMax Token Plan
- GLM / Zhipu
- Qwen
- MiMo and MiMo Token Plan
- Google Gemini
- Ollama
- SiliconFlow
- OpenRouter
- GitHub Models
- Together AI
- DeepInfra
- OpenCode Zen

`providers.ts` is the public facade. Provider defaults, model-level capability
checks, and pricing live under `client/extension/ai/providers/models/`.

Provider quirks that matter:

- GLM keys use `{id}.{secret}` and `aiService.ts` generates HS256 JWT auth.
- Anthropic uses a Messages API adapter rather than the OpenAI wire format.
- DeepSeek or local deployments may return DSML-like tool call markup; parsing is in `toolCallParser.ts`.
- Some providers do not support `tool_choice`; request sanitization handles this.
- Vision fallback can use the MiniMax CLI (`mmx`) when the selected provider cannot process images.

## Language Server Layout

`src/LSP/` contains protocol and parsing support:

- `LanguageServer.fs`
- `DocumentStore.fs`
- `Parser.fs`
- `Tokenizer.fs`
- `Types.fs`
- `Ser.fs`

`src/Main/` builds the `CWTools Server` executable used by the extension. It references
`src/LSP`, `src/Languages`, `src/CSharpExtensions`, and either the `submodules/cwtools`
project or a local CWTools override via `src/Main/cwtools.local.props`.

`global.json` pins .NET SDK `9.0.300` with `latestMinor` roll-forward.

## Coding Guidelines

- Prefer existing local patterns and helper APIs over new abstractions.
- Keep edits scoped to the requested behavior.
- Do not use `any` in production code without a clear reason, even though ESLint currently permits it.
- Respect the ESLint 9 async safety rules: `no-floating-promises`, `no-misused-promises`, and `prefer-promise-reject-errors`.
- Use `ErrorReporter` instead of bare `console.error` in extension/AI code.
- Put user-visible Chinese UI strings in the established i18n/message modules when practical:
  `client/extension/ai/messages.ts`, `workflowI18n.ts`, and `client/webview/chat/i18n.ts`.
- Do not hard-code Webview colors; use VS Code theme variables.
- Add bounded caches for data structures that can grow with workspace size.
- For localizations, preserve UTF-8 BOM conventions where the localization writer expects them.

## Common Verification Choices

Use the narrowest validation that matches the change:

- Docs only: check paths, links, and commands against the current tree.
- TypeScript extension or AI changes: `npm run compile`, then `npm run test:unit` for risky logic.
- Workflow/index/tool changes: run the relevant focused unit tests, then `npm run test:unit` if behavior crosses modules.
- Webview changes: `npm run compile`; inspect the relevant Webview in an Extension Development Host when UI behavior changes.
- F# LSP changes: `dotnet build src/LSP/` or `dotnet build src/Main/`.
- Release-sensitive changes: `npm run verify`.
- Packaging changes: follow `.agents/workflows/package.md`.

## Packaging

Packaging guidance lives in `.agents/workflows/package.md`. The release package is
built from `release/package.json` using `npx @vscode/vsce package` from inside the
`release/` directory after client and server outputs have been prepared.

Do not reference a root-level `package.ps1`; it is not present in the current tree.
