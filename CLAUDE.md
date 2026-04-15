# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CWTools is a Visual Studio Code extension that provides language services for Paradox Interactive game modding, supporting games like Stellaris, Hearts of Iron IV, Europa Universalis IV, Crusader Kings II/III, Victoria 2/3, and Imperator: Rome. The extension offers syntax validation, autocomplete, tooltips, localization checking, and visual graph analysis for game scripts.

## Architecture

This is a hybrid .NET/TypeScript VS Code extension with three main components:

### Backend (.NET/F#)
- **Main** (`src/Main/`): Core F# language server providing validation, completion, and analysis
- **LSP** (`src/LSP/`): Language Server Protocol implementation in F#  
- **CSharpExtensions** (`src/CSharpExtensions/`): C# helper utilities
- Dependencies: Uses CWTools library via Paket (git submodule in `paket-files/`)

### Frontend (TypeScript)
- **Client Extension** (`client/extension/`): VS Code extension host and commands
- **Webview** (`client/webview/`): Graph visualization using Cytoscape.js
- **Test Suite** (`client/test/`): Extension tests with sample Stellaris mod files

### Build System
- **FAKE build script** (`build/Program.fs`): Cross-platform F# build automation
- **TypeScript compilation**: Uses `tsc` and `rollup` for client bundling
- **Release packaging**: Creates `.vsix` files for VS Code marketplace

## Development Commands

### Building
```bash
# Windows
./build.cmd QuickBuild

# Unix/Linux  
./build.sh QuickBuild

# Debug build
./build.cmd QuickBuildDebug
```

### TypeScript Client
```bash
npm install
npm run compile  # Compile TypeScript + bundle webview
npm test        # Run VS Code extension tests
```

### Available Build Targets
- `QuickBuild`: Build for local development (Release)
- `QuickBuildDebug`: Build for local development (Debug)  
- `DryRelease`: Full package build without publishing
- `Release`: Full build + publish to marketplace

### Testing
VS Code extension tests are located in `client/test/suite/` and use the sample Stellaris mod in `client/test/sample/` for validation scenarios.

## Key Files

- `package.json`: Node.js dependencies and scripts for TypeScript client
- `release/package.json`: VS Code extension manifest and configuration
- `fsharp-language-server.sln`: .NET solution with F# projects
- `paket.dependencies`: .NET package management
- Build scripts: `build.cmd` (Windows) / `build.sh` (Unix)

## Development Workflow

1. Use `./build.cmd QuickBuild` for initial setup and F# server compilation
2. Use `npm run compile` for TypeScript changes during development  
3. Debug by launching "Launch Extension" configuration in VS Code
4. Test with sample Paradox game mod files in `client/test/sample/`
5. Run tests with `npm test` before committing changes

## GUI Preview Feature

The extension includes a visual GUI Preview for Stellaris `.gui` files. Architecture:

### Components
- **Parser** (`client/extension/guiParser.ts`): Tokenizer + recursive-descent parser for PDXScript GUI syntax. Handles `@variable` definitions, `@[expr]` arithmetic, `.gfx` sprite indexing. Produces a `GuiElement` tree. Supports case-insensitive type matching, percentage sizes, `margin`/`spacing`/`slotSize` properties.
- **Panel** (`client/extension/guiPanel.ts`): VS Code webview panel manager. Discovers mod root, loads `.gfx` files, resolves DDS textures â†?PNG data URIs via `ddsDecoder.ts`, sends resolved `GuiElement` data to webview.
- **Webview Renderer** (`client/webview/guiPreview.ts` + `guiPreview.css`): Renders `GuiElement` tree as nested absolutely-positioned HTML divs with pan/zoom viewport. Supports sprite display, orientation anchoring, percentage sizing, margin offsets, tooltip on hover, click-to-jump-to-line, element search (Ctrl+F).
- **DDS Decoder** (`client/extension/ddsDecoder.ts`): Pure Node.js DDSâ†’PNG decoder supporting DXT1/3/5 and uncompressed BGRA/BGR/8bpp.

### Supported GUI Element Types
`containerWindowType`, `buttonType`, `effectButtonType`, `guiButtonType`, `iconType`, `instantTextBoxType`, `textboxType`, `editBoxType`, `smoothListboxType`, `listBoxType`, `scrollbarType`, `extendedScrollbarType`, `checkboxType`, `spinnerType`, `OverlappingElementsBoxType`, `positionType`, `browserType`, `gridBoxType`, `windowType`, `dropDownBoxType`

### Build Notes
- `guiParser.ts` is compiled by `tsc` (extension context), NOT by rollup
- `guiPreview.ts` is compiled by `rollup` (webview context) â†?`release/bin/client/webview/guiPreview.js`
- `guiPreview.css` must be manually copied to `release/bin/client/webview/`

## CWTools Integration

The extension integrates with the CWTools library (F# game script parser/validator) via git submodule. The build system automatically pulls the latest CWTools when building the language server.