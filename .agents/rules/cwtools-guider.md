---
trigger: always_on
---

# CLAUDE.md

This file provides guidance to AI coding assistants when working with code in this repository.

## 🌟 Project Overview

**Eddy's Stellaris CWTools** is an advanced Visual Studio Code extension that provides deep language services, GUI visualization, and AI-powered assistance for Paradox Interactive game modding (primarily Stellaris). It is a heavily customized fork of the original [CWTools](https://github.com/cwtools/cwtools-vscode).

The extension architecture consists of three main components:
1. **Frontend (TypeScript)** (`client/`): The VS Code extension client providing UI, commands, Webview logic, and AI Agent orchestration.
2. **Backend (.NET/F#)** (`src/LSP/`): The Language Server Protocol (LSP) implementation, built on top of the F# `CWTools` library.
3. **Webviews** (`client/webview/`): Interactive UI panels embedded within VS Code, running in isolated browser sandboxes.

## 📂 Key Features & Code Mapping

### 1. 🤖 AI Agent Integration
A sophisticated AI assistant deeply integrated into the editor.
- **Agent Orchestration**: `client/extension/ai/` contains the core AI logic (27+ files), including execution loops (Build/Plan/Explore/General/Review/LocTranslator/LocWriter modes), context compression, doom-loop detection, and tool routing.
- **Provider Support**: 16+ built-in providers — OpenAI, Claude (Anthropic), Google Gemini, DeepSeek, MiniMax (pay-as-you-go + Token Plan), GLM (Zhipu), Qwen (Tongyi), MiMo (Xiaomi), Ollama, SiliconFlow, OpenRouter, GitHub Models, Together AI, DeepInfra, OpenCode Zen. Includes Anthropic Messages API adapter and GLM JWT auth.
- **MCP Support**: Model Context Protocol clients with stdio/SSE transports (`mcpClient.ts`).
- **Tools**: 40+ agent tools including `read_file`, `write_file`, `edit_file` (8-strategy fuzzy replacer), `multiedit`, `apply_patch`, `ast_mutate`, `codesearch`, `glob_files`, `spawn_sub_agents`, CWTools Deep API tools (`query_definition`, `query_scripted_effects`, `query_enums`, `get_entity_info`, etc.), media tools (`mmx_generate_image`, `convert_image_to_dds`), and memory tools.
- **Write Safety**: Partitioned write queue (`PartitionedWriteQueue`) serializes per-file writes while allowing parallel writes to different files. Multi-file operations acquire locks in sorted order to prevent deadlocks.
- **Sub-Agent Parallelism**: `spawn_sub_agents` tool supports DAG-based dependency scheduling, per-task deadlines, and 8+ sub-agent types.
- **Vision Fallback**: For non-vision providers, automatically detects MiniMax CLI (`mmx`) and uses its VLM to analyze user-attached images, injecting text descriptions into context.

### 2. 🎨 GUI Preview (`client/webview/guiPreview.ts` & `client/extension/guiParser.ts`)
A real-time Canvas-based visualizer for Paradox `.gui` styling files.
- **Parser & Preview**: Parsed natively via shared `pdxTokenizer.ts` into AST. Emulates Paradox layout systems (orientation, origo, centerPosition).
- **Renderer**: Decodes DDS (BC1/BC2/BC3/BC7) and TGA textures directly in the browser. Handles 9-slice sprites (`corneredTileSpriteType`) and animation loops (`noOfFrames`).
- **Interactive UI**: Drag-and-drop repositioning, tree layer panels, and real-time attribute modifications synced back to script files.

### 3. 🌌 Solar System Visualizer (`client/webview/solarSystemPreview.ts`)
3D interactive preview for `solar_system_initializers/`.
- **Rendering & Editing**: Plots stars, planets, moons, and ring worlds. Supports click-and-drag mechanics to modify celestial orbit radii and positional angles interactively.

### 4. 🔗 Event Chain Visualizer (`client/webview/eventChainPreview.ts` & `client/extension/eventChainPanel.ts`)
Directed graph visualization of event trigger chains using Cytoscape.js.
- **Full Workspace Scan**: Scans ALL `events/` files AND 20+ `common/` subdirectories (on_actions, decisions, scripted_effects, technologies, etc.) to build a complete event reference graph.
- **BFS Subgraph**: Seeds from the active file's events and BFS-expands (depth 2) to show only the connected subgraph, preventing visual overload.
- **Localization Resolution**: Resolves event titles via YML localisation files, with configurable language priority (Chinese preferred when available).
- **Interactive**: Namespace filtering, event ID search, click-to-navigate to source file/line, zoom controls.

### 5. 🔬 Tech Tree Visualizer (`client/webview/techTreePreview.ts` & `client/extension/techTreePanel.ts`)
Directed graph visualization of technology prerequisite chains using Cytoscape.js.
- **Full Scan**: Scans ALL `common/technology/**/*.txt` files in the workspace.
- **Filtering**: Filter by research area (Physics/Society/Engineering), tier, rare/dangerous tech flags.
- **Localization**: Resolves tech names via YML localisation files.
- **Seed Mode**: When a tech file is active, seeds the graph from its techs (BFS-expand depth 10); otherwise shows the full tech tree.

### 6. ⚡ Code Actions (`client/extension/codeActions.ts`)
CodeActionProvider that surfaces AI-powered quick fixes on CWTools diagnostics:
- "AI: Fix this error" — sends diagnostic context to AI chat for automated repair
- "AI: Explain this error" — sends diagnostic for explanation
- "AI: Fix all errors in file" — bulk repair mode
- Bilingual (Chinese/English) based on VS Code locale

### 7. 🧠 Language Services (F# Backend)
- **Language Server Protocol**: Core syntax validation, auto-complete, go-to-definition, and semantic analysis built in F# (.NET 9.0).
- **CWTools Engine Integration**: The F# parser engine is included via Git Submodule (`submodules/cwtools`).
- **Performance Focused**: Utilizes asynchronous DocumentStore O(1) searches, `FileSystemWatcher` for global workspace localizations text indexing, and bounds GC STW pauses.

## 🛠️ Build & Development Guide

### Build Scripts (`package.json`)
- `npm run compile`: Compiles extension TypeScript (via `tsc`) and bundles 5 Webview scripts (via `rollup`).
- `npm run test`: Executes the test suites.
- `npm run test:unit`: Runs 7 unit test files via `ts-mocha` (covers contextBudget, diffEngine, editFileReplacer, jsonRepair, pricing, providers, toolCallParser).
- `npm run lint`: ESLint 9 flat config with critical async safety rules (`no-floating-promises`, `no-misused-promises`).
- **Important Notes**: Webview scripts (`chatPanel.ts`, `guiPreview.ts`, `solarSystemPreview.ts`, `eventChainPreview.ts`, `techTreePreview.ts`) are compiled using `rollup` into `release/bin/client/webview/`. Extension context scripts are handled purely by `tsc`.

### Backend Compilation
- The F# components are built using .NET 9.0 SDK. Use `dotnet build src/LSP/`.
- Convenience scripts: `build.cmd` (Windows), `build.sh` (Linux/macOS).

## ⚠️ Architectural Guidelines & Gotchas

1. **Webview vs Extension Context**: Be extremely careful about context isolation. Webviews (GUI Preview, Solar Preview, Event Chain, Tech Tree, Chat Panel) run in restricted sandbox environments and CANNOT access the VS Code API or Node.js directly. Communication must be strictly handled via `postMessage`.

2. **AI Tool Concurrency Risk**: When adding/modifying tools that mutate files, add them to `WRITE_TOOLS` set in `agentRunner.ts`. The `PartitionedWriteQueue` serializes writes per-file-path to prevent race-condition corruption. Multi-file writes acquire locks in sorted lexicographic order to prevent AB/BA deadlocks.

3. **Data Volume Limits**: The extension deals with massive configurations (hundreds of megabytes of text/images). Memory leaks hit hard here—always utilize limited-size LRU caches for things like textures, handle background operations asynchronously, and clear listeners manually on Webview disposals.

4. **Tool Registration Triad**: When adding a new tool, you must update THREE files simultaneously:
   - `tools/definitions.ts` — JSON Schema definition
   - `agentTools.ts` — dispatch router mapping
   - `types.ts` — TypeScript types (AgentToolName union, Args/Result interfaces)

5. **Provider Quirks**: Different providers have unique behaviors:
   - GLM (Zhipu): API key is `{id}.{secret}` format; auth header uses HS256 JWT auto-generated in `aiService.ts`
   - MiniMax: Does NOT support `tool_choice` — stripped in request sanitization
   - DeepSeek: Raw/local deployments may use `<｜DSML｜function_calls>` format instead of standard JSON tool_calls — handled by `toolCallParser.ts`
   - Anthropic: Uses Messages API (non-OpenAI-compatible) — adapted in `aiService.ts`

6. **Doom-Loop Detection**: The agent runner uses a two-phase approach to detect when the AI is stuck in a loop: (1) signature-pair tracking (≥4 repeats triggers phase 2), (2) normalized result hash comparison (same hash = confirmed loop → stop).

7. **Fuzzy Replacer**: `edit_file` uses 8 progressively fuzzy matching strategies (ported from OpenCode's `replacerSuite.ts`) to handle imprecise AI output: simple → line-trimmed → block-anchor → whitespace-normalized → indentation-flexible → escape-normalized → trimmed-boundary → context-aware.

8. **UI Strings**: All user-visible Chinese text should go in `ai/messages.ts`. Error reporting uses the `ErrorReporter` three-tier system (fatal/warn/debug) — never use bare `console.error`.

9. **CSS Variables**: Webview CSS must use VS Code theme variables (`var(--vscode-editor-background)`) and support `prefers-reduced-motion` for animations.

## 📁 Directory Structure

```
cwtools-vscode/
├── client/
│   ├── extension/              # VS Code extension context (Node.js)
│   │   ├── ai/                 # AI agent module (27+ files)
│   │   │   ├── tools/          # Agent tool implementations (5 files)
│   │   │   │   ├── definitions.ts    # Tool JSON Schema (40+ tools)
│   │   │   │   ├── fileTools.ts      # File operations
│   │   │   │   ├── lspTools.ts       # LSP queries + Deep API
│   │   │   │   ├── externalTools.ts  # Commands, web, sub-agents, media
│   │   │   │   └── replacerSuite.ts  # 8-strategy fuzzy replacer
│   │   │   ├── agentRunner.ts        # Core reasoning loop + write queue
│   │   │   ├── aiService.ts          # Provider HTTP client (16+ providers)
│   │   │   ├── promptBuilder.ts      # System prompt assembly
│   │   │   ├── chatPanel.ts          # Chat Webview host
│   │   │   ├── providers.ts          # Provider configs + capability maps
│   │   │   └── diffEngine.ts         # Myers line-diff algorithm
│   │   ├── extension.ts              # Main entry point
│   │   ├── guiPanel.ts               # GUI Preview host
│   │   ├── solarSystemPanel.ts       # Solar System host
│   │   ├── eventChainPanel.ts        # Event Chain Visualizer host
│   │   ├── techTreePanel.ts          # Tech Tree Visualizer host
│   │   ├── codeActions.ts            # AI Quick Fix CodeActions
│   │   ├── pdxTokenizer.ts           # Shared PDX script tokenizer
│   │   └── exprEval.ts               # Safe math expression evaluator
│   ├── webview/                # Webview scripts (browser sandbox)
│   │   ├── chatPanel.ts        # Chat UI (167KB)
│   │   ├── guiPreview.ts       # GUI canvas renderer (118KB)
│   │   ├── solarSystemPreview.ts  # Solar system visualizer (81KB)
│   │   ├── eventChainPreview.ts   # Event chain graph (Cytoscape.js)
│   │   └── techTreePreview.ts     # Tech tree graph (Cytoscape.js)
│   └── test/
│       ├── unit/               # Unit tests (7 files)
│       └── suite/              # Integration tests
├── src/LSP/                    # F# Language Server (.NET 9.0)
├── submodules/cwtools/         # CWTools F# library (git submodule)
├── .agents/
│   ├── rules/cwtools-guider.md # AI coding guidelines
│   └── workflows/package.md   # Packaging workflow
├── rollup.config.mjs          # Webview bundler (5 entry points)
├── eslint.config.mjs          # ESLint 9 flat config
└── global.json                # .NET SDK 9.0 configuration
```