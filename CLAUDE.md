# CLAUDE.md

This file gives AI coding assistants the current working map for this repository.
`AGENTS.md` mirrors this guidance for agents that prefer that filename.

## Project Overview

**Eddy's Stellaris CWTools** is a heavily customized fork of
[CWTools](https://github.com/cwtools/cwtools-vscode). It is a Visual Studio Code
extension for Paradox game modding, with Stellaris as the primary target.

The project has four major parts:

1. `client/extension/`: VS Code extension host code in TypeScript.
2. `client/extension/ai/`: the integrated AI assistant, providers, tools, and orchestrator.
3. `client/webview/`: browser-sandboxed Webview UIs bundled by Rollup.
4. `src/`: .NET 9 / F# language server and launcher projects backed by the `submodules/cwtools` submodule.

Current package version: `2.1.21`.

## Current Build And Test Commands

Use these from the repository root:

```bash
npm run compile
npm run lint
npm run test:unit
npm run test
dotnet build src/LSP/
dotnet build src/Main/
```

`npm run compile` runs `tsc -p ./tsconfig.extension.json` and then `rollup -c`.
Rollup builds six Webview entry points into `release/bin/client/webview/`:

- `chatPanel.ts`
- `guiPreview.ts`
- `solarSystemPreview.ts`
- `eventChainPreview.ts`
- `techTreePreview.ts`
- `entityPreview.ts`

`npm run test:unit` currently discovers tests under `client/test/unit/**/*.test.ts`.

## High-Value Paths

| Path | Purpose |
| --- | --- |
| `client/extension/extension.ts` | Main activation, command registration, LSP client setup |
| `client/extension/codeActions.ts` | AI quick fixes and explanations for diagnostics |
| `client/extension/guiPanel.ts` / `guiParser.ts` | `.gui` preview host and parser |
| `client/extension/solarSystemPanel.ts` / `solarSystemParser.ts` | Solar system initializer preview |
| `client/extension/eventChainPanel.ts` / `eventChainParser.ts` | Event chain visualizer |
| `client/extension/techTreePanel.ts` / `techTreeParser.ts` | Technology tree visualizer |
| `client/extension/entityPanel.ts` / `entityAssetParser.ts` | 3D entity preview host and asset parser |
| `client/extension/vanillaCompare.ts` | Vanilla file comparison tools |
| `client/extension/locDecorations.ts` | Localization indexing and editor decorations |
| `client/webview/chatPanel.ts` / `chatPanel.css` | Chat Webview runtime UI |
| `client/webview/messageRenderer.ts` | Shared chat message rendering logic |
| `client/webview/entityPreview.ts` | Three.js entity renderer |
| `src/LSP/` | Reusable LSP protocol and parser layer |
| `src/Main/` | `CWTools Server` executable entry point |

## AI Module Map

The AI module lives in `client/extension/ai/`.

| Path | Purpose |
| --- | --- |
| `agentRunner.ts` | Main reasoning loop, mode tool gating, context compaction, checkpoints, write queue |
| `agentTools.ts` | Tool dispatch router and shared tool executor |
| `aiService.ts` | Provider HTTP clients, streaming, request shaping, provider fallbacks |
| `providers.ts` | Built-in provider metadata and capability checks |
| `promptBuilder.ts` | System prompts, mode prompts, project context injection |
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
build | plan | explore | general | review | gui_expert | script_reviewer | loc_translator | loc_writer | orchestrator
```

Orchestrator mode uses `dispatch_agents`, `query_blackboard`, and `merge_results`.
Specialist roles are registered in `client/extension/ai/orchestrator/agentRegistry.ts`
and currently include `explorer`, `architect`, `builder`, `locWriter`, `reviewer`,
`assetGen`, `guiExpert`, and `locTranslator`.

## AI Tool Rules

When adding or changing an AI tool, update all relevant pieces together:

1. `client/extension/ai/tools/definitions.ts`: OpenAI-style JSON schema.
2. `client/extension/ai/agentTools.ts`: execution dispatch.
3. `client/extension/ai/types.ts`: `AgentToolName`, args, and result types.
4. `client/extension/ai/agentRunner.ts`: add file-mutating tools to `WRITE_TOOLS`.

Important current tool details:

- The current schema file defines more than 50 tools.
- File writes are serialized by `PartitionedWriteQueue` per target file.
- Multi-file writes must acquire file locks in sorted path order.
- `todo_write` is intentionally excluded from the global file-write lock path.
- Generic write tools reject `.yml` localization writes; use `write_localisation`.
- `ast_mutate` appears in the type/write-tool plumbing but is not currently defined in `tools/definitions.ts`; treat it as incomplete unless you are explicitly finishing that tool.
- The active multi-agent tool is `dispatch_agents`, not the older `spawn_sub_agents` naming.

## Webview Rules

Webviews run in a restricted browser sandbox. They cannot access Node.js, `fs`,
`path`, `require()`, or the VS Code API directly.

Use `postMessage` for all host/Webview communication:

- Extension host files: `client/extension/*Panel.ts`, `client/extension/ai/chatPanel.ts`.
- Webview files: `client/webview/*.ts`.

Webview CSS must use VS Code theme variables such as
`var(--vscode-editor-background)` and should support `prefers-reduced-motion`.
For Three.js/WebGL code, explicitly dispose geometries, materials, textures,
renderers, event listeners, workers, and animation loops when the Webview is torn
down.

## Provider Notes

Built-in provider configs are in `client/extension/ai/providers.ts`:

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
- Put user-visible Chinese UI strings in `client/extension/ai/messages.ts` when practical.
- Do not hard-code Webview colors; use VS Code theme variables.
- Add bounded caches for data structures that can grow with workspace size.
- For localizations, preserve UTF-8 BOM conventions where the localization writer expects them.

## Common Verification Choices

Use the narrowest validation that matches the change:

- Docs only: no build required; run link/path checks if practical.
- TypeScript extension or AI changes: `npm run compile`, then `npm run test:unit` for risky logic.
- Webview changes: `npm run compile`; manually inspect the relevant Webview in an Extension Development Host.
- F# LSP changes: `dotnet build src/LSP/` or `dotnet build src/Main/`.
- Packaging changes: follow `.agents/workflows/package.md`.

## Packaging

Packaging guidance lives in `.agents/workflows/package.md`. The release package is
built from `release/package.json` using `npx @vscode/vsce package` from inside the
`release/` directory after client and server outputs have been prepared.

Do not reference a root-level `package.ps1`; it is not present in the current tree.
