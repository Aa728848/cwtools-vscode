# Contributing to Eddy's Stellaris CWTools

Thank you for your interest in contributing! This guide covers environment setup, development workflow, debugging, and code conventions.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | ≥ 20.x | TypeScript compilation, webview bundling |
| **npm** | ≥ 10.x | Package management |
| **.NET SDK** | ≥ 8.0 | F# Language Server compilation |
| **VS Code** | ≥ 1.90 | Extension host runtime |
| **Git** | Latest | Source control + submodule management |

---

## Getting Started

### 1. Clone with Submodules

```bash
git clone --recurse-submodules https://github.com/Aa728848/cwtools-vscode.git
cd cwtools-vscode
```

If you already cloned without submodules:
```bash
git submodule update --init --recursive
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build the F# Language Server

```bash
dotnet build src/LSP/
```

Or use the convenience scripts:
```bash
# Windows
.\build.cmd

# Linux / macOS
./build.sh
```

### 4. Build the TypeScript Extension

```bash
npm run compile
```

This runs two steps:
1. `tsc -p ./tsconfig.extension.json` — compiles extension context code to `release/bin/`
2. `rollup -c` — bundles webview scripts (`chatPanel.ts`, `guiPreview.ts`, `solarSystemPreview.ts`) into `release/bin/client/webview/`

### 5. Using a Local CWTools F# Repo

To develop against a local cwtools git repo, create `cwtools.local.props`:

```xml
<Project>
  <PropertyGroup>
    <UseLocalCwtools Condition="'$(UseLocalCwtools)' == ''">True</UseLocalCwtools>
    <CwtoolsPath>../../../cwtools/cwtools/cwtools.fsproj</CwtoolsPath>
  </PropertyGroup>
</Project>
```

Adjust `<CwtoolsPath>` to point to your local repo. The default assumes it's adjacent to this repo.

---

## Development Workflow

### Running & Debugging

1. Open the repo in VS Code
2. Press **F5** (or Run → Start Debugging)
3. This launches a new **Extension Development Host** window with the extension loaded
4. Make changes → restart the host (Ctrl+Shift+F5) to reload

### Webview Debugging

Webview scripts (chat panel, GUI preview, solar preview) run in isolated browser sandboxes. To debug them:

1. In the Extension Development Host window, open the Command Palette (`Ctrl+Shift+P`)
2. Run: **Developer: Open Webview Developer Tools**
3. This opens Chrome DevTools for the active webview — you can set breakpoints, inspect DOM, etc.

> ⚠️ **Important**: Webview scripts cannot access `require()`, `vscode` API, or Node.js modules. All communication with the extension host must go through `postMessage`. See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

### Watch Mode

For rapid iteration on extension code:
```bash
# Terminal 1: Watch TypeScript
npx tsc -p ./tsconfig.extension.json --watch

# Terminal 2: Watch webview bundles (re-run manually after changes)
npx rollup -c --watch
```

---

## Build Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Full build (extension + webviews) |
| `npm run lint` | ESLint on `client/` |
| `npm run test` | Compile + VS Code integration tests |
| `npm run test:unit` | Unit tests via `ts-mocha` |
| `npm run test:coverage` | Unit tests with coverage report |

---

## Project Structure

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map. Quick summary:

```
client/
├── extension/          # Extension context (Node.js)
│   ├── ai/             # AI agent module
│   │   ├── tools/      # Tool implementations
│   │   ├── agentRunner.ts    # Core reasoning loop
│   │   ├── aiService.ts      # Provider HTTP client
│   │   └── chatPanel.ts      # Webview host
│   └── extension.ts    # Main entry
├── webview/             # Webview scripts (browser sandbox)
│   ├── chatPanel.ts     # Chat UI + markdown renderer
│   ├── guiPreview.ts    # GUI canvas renderer
│   └── solarSystemPreview.ts
└── test/                # Tests

src/LSP/                 # F# Language Server
submodules/cwtools/      # CWTools library (git submodule)
```

---

## Code Conventions

### TypeScript

- **Strict mode**: `strict: true` in all tsconfig files
- **No `any`**: Prefer proper types. Use `unknown` + type guards if the type is truly unknown
- **Naming**: `camelCase` for variables/functions, `PascalCase` for types/interfaces, `UPPER_SNAKE_CASE` for constants
- **Imports**: Group by: (1) Node.js builtins, (2) VS Code API, (3) local modules
- **Error handling**: Use `ErrorReporter` (in `ai/errorReporter.ts`) instead of bare `console.error`. Three tiers:
  - `ErrorReporter.fatal(source, msg)` — shows notification to user
  - `ErrorReporter.warn(source, msg)` — shows in status bar
  - `ErrorReporter.debug(source, msg)` — output channel only
- **UI strings**: All user-visible Chinese text should go in `ai/messages.ts`, not hardcoded

### AI Module Specifics

- **Tool safety**: When adding a new tool that mutates files, add it to the write-lock guard list in `agentRunner.ts` to prevent race conditions during parallel sub-agent execution
- **Context isolation**: Never import `vscode` in webview scripts. Never use `require()` in webview code
- **Memory safety**: Use bounded caches (LRU) for any data that grows with usage. The LSP cache in `lspTools.ts` is the reference pattern (128 entries max + TTL)
- **Token estimation**: Use `estimateTokenCount()` in `agentRunner.ts` for all token math. It auto-selects fast vs. precise path

### CSS

- Use VS Code theme CSS variables (e.g., `var(--vscode-editor-background)`) instead of hardcoded colors
- Ensure minimum contrast ratio of 4.5:1 for accessibility
- Support `prefers-reduced-motion` for animations

---

## Pull Request Checklist

Before submitting a PR, please verify:

- [ ] `npm run compile` passes with zero errors
- [ ] `npm run lint` passes (or new warnings are justified)
- [ ] Existing comments and docstrings are preserved
- [ ] No new `any` types without justification
- [ ] UI strings are in `messages.ts`, not hardcoded
- [ ] New write-capable tools are added to the lock guard list
- [ ] New webview features use `postMessage` for extension communication
- [ ] Tested in Extension Development Host:
  - [ ] Chat panel opens and sends messages
  - [ ] Mode switching works (Build/Plan/Explore/General/Review)
  - [ ] GUI Preview renders (if touched)
  - [ ] No console errors in Webview DevTools

---

## Packaging

To build `.vsix` packages for distribution:

```powershell
# Windows — builds for all 3 platforms
.\package.ps1
```

This produces platform-specific packages in the project root:
- `cwtools-vscode-*-win32-x64.vsix`
- `cwtools-vscode-*-linux-x64.vsix`
- `cwtools-vscode-*-darwin-x64.vsix`

---

## Getting Help

- **Architecture overview**: See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **AI coding guide**: See [CLAUDE.md](./CLAUDE.md) (guidance for AI assistants working on this repo)
- **Issues**: Open a GitHub Issue for bugs or feature requests