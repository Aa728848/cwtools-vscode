# AGENTS.md

Standing operating orders for AI coding assistants in this repository. Keep changes scoped, preserve unrelated work, and load supporting docs only as needed:

- [README.md](README.md): product features and user workflows.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, verification matrix, coding expectations, and packaging/release.
- [ARCHITECTURE.md](ARCHITECTURE.md): runtime boundaries, locks, and data flows (read before broad runner or backend changes).
- [docs/cwt-rule-config.md](docs/cwt-rule-config.md): CWT rule authoring.

## Before Editing

1. Run `git status --short` and preserve unrelated working-tree changes.
2. Before non-trivial changes to an existing subsystem or feature, search `.agents/notes/implemented/` for the **Owning Note** to review past constraints, rationale, and rejected alternatives.
3. Use targeted searches instead of dumping the entire repository tree.

## Core Rules

- **Scope & reuse**: limit changes to the requested behavior; reuse existing helpers (`gameProfiles.ts`, `indexing/`, `pathScope.ts`, `fileExtensions.ts`) instead of adding parallel abstractions. `pathScope.ts` holds pure path primitives; MCP/Node read-path policy lives in `cwtools-shared/src/safety/paths.ts`.
- **Errors & bounds**: use `ErrorReporter` (not bare `console.error`) in Extension Host and MCP host code; bound caches that scale with workspace or vanilla size; sort filesystem-derived outputs deterministically; avoid unbounded concurrency.
- **Boundary safety**: treat files, JSON, Webview messages, tool arguments, LSP/MCP payloads, and process output as untrusted input—narrow with `unknown`, type guards, and discriminated unions rather than new `any` or unchecked assertions. Preserve async cancellation, timeouts, and disposal.
- **Localisation & versions**: never rewrite localisation `.yml` with a generic writer—use `write_localisation` to preserve encoding/BOM. Never duplicate version numbers in docs or comments (`package.json` and `release/package.json` are authoritative). Keep comments and changelogs concise (explain non-obvious constraints or user-visible behavior only).
- **One home per fact**: product behavior → `README.md`/docs; boundaries & data flows → `ARCHITECTURE.md`; standing AI rules → `AGENTS.md`; design rationale, trade-offs, and rejected alternatives → `.agents/notes/`. Link across tiers instead of duplicating.
- **Agent Notes**: record or update a Simplified Chinese note in `.agents/notes/` for every non-trivial change within the same change, following the 6-class taxonomy and Owning Note rules in [.agents/notes/README.md](.agents/notes/README.md) and [.agents/notes/implemented/AGENTS.md](.agents/notes/implemented/AGENTS.md).
- **Regression tests**: add or update a targeted test for observable behavior changes or bug fixes (test public behavior and failure paths).

## Internationalization And Docs

- Update English and Chinese together for user-visible commands, settings, diagnostics, UI (`client/extension/messages.ts`), Webviews, and release-facing docs.
- `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `docs/cwt-rule-config.md`, and `docs/marketplace-readme.md` are single-source bilingual documents—never create `_EN`/`_ZH` copies. Run `npm run build:docs` after editing them (validates structure and regenerates `release/README.md`).

## Submodules

Commit and test inside a submodule before bumping the root pointer; never mix library, rules, and MCP changes in one undifferentiated commit:

- `submodules/cwtools/`: upstream F# library.
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rules content.
- `submodules/cwtools-mcp/`: standalone MCP packages (`cwtools-shared`, `cwtools-node`, `cwtools-mcp`). Build `cwtools-shared` before compiling on a fresh checkout; the VSIX does not bundle the MCP server.

## Subsystem Constraints

- **Webviews (`client/webview/`)**: no `vscode`, `fs`, `path`, `require()`, or Node APIs; communicate via `postMessage`; use VS Code theme variables and `prefers-reduced-motion`; dispose renderers, GPU resources, workers, listeners, and loops; keep file I/O and `ReadTracker` in the Host.
- **MCP and host tools (`submodules/cwtools-mcp/`, `client/extension/mcp/`)**: keep `cwtools-shared/src/tools/catalog.ts`, host capability filters, and shared dispatch synchronized. Preserve path containment, sorted multi-file locking, per-file exclusion, cancellation, and evidence prechecks. External Agents own planning, shell, memory, and general editing; do not recreate those as CWTools domain tools.
- **MCP (`submodules/cwtools-mcp/`)**: whitelisted domain writes are enabled by default; reject non-whitelisted writes. Add new semantic capabilities as read-only `cwtools.ai.*` LSP commands via `readCmd` in `src/LSP/Commands.fs` (`allCommands`) first. Never hand-edit generated detection files; update `cwtools-shared/src/tools/catalog.ts` with dispatch and contract tests. After changing `client/extension/workspaceGameDetection.ts`, run `npm run generate:mcp-detection` (or `check:mcp-detection`), then build and run `npm run test:contracts` inside `submodules/cwtools-mcp`.
- **F# & Shader (`src/`, `submodules/cwtools/`)**: reuse `PdxShaderFeatures`; preserve bracket-depth scanning, escaped-quote handling, supported caches, and Windows-only case-insensitive path comparison. Stellaris incremental scripted-type refresh spans `src/Main/Program.fs` and `submodules/cwtools/`—compare against full refresh and keep commits separate.

## Verification

Run the narrowest check covering your change, then broaden by risk (full table in [CONTRIBUTING.md](CONTRIBUTING.md#verification-matrix)):

- Docs: `npm run build:docs` and `npm run check:release -- --skip-compile --skip-test`.
- TS / Webview / MCP host: `npm run compile`, `npm run typecheck:test`, targeted unit tests, then `npm run test:unit`.
- F# backend: `dotnet build src/LSP/`, `dotnet build src/Main/`, `npm run test:fsx`.
- Integration / LSP contracts: `npm test`, `npm run test:shader-lsp`, `npm run test:cwt-lsp`, `npm run test:cwt-game-lsp` (Stellaris game model requires vanilla data or `stl.cwb`; otherwise degrades to generic game).
- Pre-release gate: `npm run verify`.

Report explicitly if a relevant check cannot run; never silently skip it.
