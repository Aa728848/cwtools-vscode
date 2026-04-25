---
trigger: always_on
---

This file provides guidance to AI coding assistants when working with code in this repository.

## 🌟 Project Overview

**Eddy's Stellaris CWTools** is an advanced Visual Studio Code extension that provides deep language services, GUI visualization, and AI-powered assistance for Paradox Interactive game modding (primarily Stellaris). It is a heavily customized fork of the original [CWTools](https://github.com/cwtools/cwtools-vscode).

The extension architecture consists of three main components:
1. **Frontend (TypeScript)** (`client/`): The VS Code extension client providing UI, commands, Webview logic, and AI Agent orchestration.
2. **Backend (.NET/F#)** (`src/LSP/`): The Language Server Protocol (LSP) implementation, built on top of the F# `CWTools` library.
3. **Webviews** (`client/webview/`): Interactive UI panels like the GUI Preview and Galaxy Visualizer, built with frontend technologies and embedded within VS Code.

## 📂 Key Features & Code Mapping

### 1. 🤖 AI Agent Integration
A sophisticated AI assistant deeply integrated into the editor.
- **Agent Orchestration**: `client/extension/ai/` contains the core AI logic, including execution loops (Build/Plan/Review modes), context compression, and tool routing.
- **Provider & MCP Support**: Supports Anthropic (SSE streaming), OpenAI, Gemini, and Ollama. Includes Model Context Protocol (MCP) clients with stdio/SSE transports.
- **Tools**: Features powerful tools like `multiedit`, workspace symbol extraction, and `validate_code`. Ensures write-safety via exclusive lock mechanism over `READ_ONLY_TOOLS`.
- **Sub-Agent Parallelism**: Implements `Promise.allSettled` to spawn parallel sub-tasks dynamically.

### 2. 🎨 GUI Preview (`client/webview/guiPreview/` & `client/extension/guiParser.ts`)
A real-time Canvas-based visualizer for Paradox `.gui` styling files.
- **Parser & Preview**: Parsed natively into AST. Emulates Paradox layout systems (orientation, origo, centerPosition).
- **Renderer**: Decodes DDS (BC1/BC2/BC3/BC7) and TGA textures directly in the browser. Handles 9-slice sprites (`corneredTileSpriteType`) and animation loops (`noOfFrames`).
- **Interactive UI**: Drag-and-drop repositioning, tree layer panels, and real-time attribute modifications synced back to script files.

### 3. 🌌 Solar System Visualizer (`client/webview/solarPreview/`)
3D interactive preview for `solar_system_initializers/`.
- **Rendering & Editing**: Plots stars, planets, moons, and ring worlds. Supports click-and-drag mechanics to modify celestial orbit radii and positional angles interactively.

### 4. 🧠 Language Services (F# Backend)
- **Language Server Protocol**: Core syntax validation, auto-complete, go-to-definition, and semantic analysis built in F# (.NET).
- **CWTools Engine Integration**: The F# parser engine is included via Git Submodule (`submodules/cwtools`). 
- **Performance Focused**: Utilizes asynchronous DocumentStore O(1) searches, `FileSystemWatcher` for global workspace localizations text indexing, and bounds GC STW pauses.

## 🛠️ Build & Development Guide

### Build Scripts (`package.json`)
- `npm run compile`: Compiles frontend TypeScript (via `tsc`) and Webview scripts (via `rollup`).
- `npm run test`: Executes the test suites.
- **Important Notes**: Webview scripts (like `guiPreview.ts` and `solarPreview.ts`) are compiled using `rollup` into `release/bin/client/webview/`. Extension context scripts are handled purely by `tsc`.

### Backend Compilation
- The C#/F# components are built using `.NET` core. Core tools are managed via `paket`.

## ⚠️ Architectural Guidelines & Gotchas

1. **Webview vs Extension Context**: Be extremely careful about context isolation. Webviews (GUI Preview, Solar Preview) run in restricted sandbox environments and CANNOT access the VS Code API or Node.js directly. Communication must be strictly handled via `postMessage`.
2. **AI Tool Concurrency Risk**: When adding/modifying tools, remember to add mutation tools to the write operations list (guard list) in `agentRunner.ts` to ensure serial AST modification, preventing race-condition corruption.
3. **Data Volume Limits**: The extension deals with massive configurations (hundreds of megabytes of text/images). Memory leaks hit hard here—always utilize limited-size LRU caches for things like textures, handle background operations asynchronously, and clear listeners manually on Webview disposals.