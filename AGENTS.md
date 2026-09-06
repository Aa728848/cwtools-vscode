# AGENTS.md

Canonical operating guide for AI coding assistants in this repository. Keep
changes scoped, preserve user work, and load detailed documentation only when
the task needs it.

## Start Here

Before editing:

1. Run `git status --short` and preserve unrelated working-tree changes.
2. Use targeted `rg` searches; do not dump the entire repository tree unless
   it is genuinely needed.

Read supporting documents by task:

- `README.md`: product behavior and user-facing features.
- `CONTRIBUTING.md`: setup, debugging, verification, PRs, and packaging.
- `ARCHITECTURE.md`: module boundaries and data flow; read before broad runner
  or backend changes.
- `docs/cwt-rule-config.md`: CWT rules work.

## Core Rules

- Keep changes limited to the requested behavior. Do not revert or reformat
  unrelated user work.
- Prefer existing helpers, local patterns, and structured APIs over new
  abstractions or raw workspace scans.
- Use `ErrorReporter` instead of bare `console.error` in extension/AI code.
- Bound caches that can grow with workspace or vanilla-game size.
- Preserve localisation encoding and BOM expectations. Generic write tools
  must not write localisation `.yml`; use `write_localisation`.
- Do not duplicate version numbers in docs or comments. Root `package.json`
  and `release/package.json` are the sources of truth.
- Keep comments and changelog entries concise and explain only non-obvious
  constraints or user-visible behavior.
- Record an Agent Note in `.agents/notes/` for every non-trivial change (features,
  bug fixes, simplifications, architecture adjustments, testing or process changes)
  within the same change. Follow the closed 6-class taxonomy and template in
  `.agents/notes/README.md`, writing all notes in Simplified Chinese (supplementing
  with flowcharts and I/O diagrams where necessary).

## Coding Rules

- Add or update a targeted regression test when fixing a bug or changing
  observable behavior. Test public behavior and failure paths, not private
  implementation details.
- Treat file contents, JSON, Webview messages, tool arguments, LSP/MCP payloads,
  and process output as untrusted input. Validate and narrow them at the
  boundary before use.
- Avoid introducing new `any`, unchecked type assertions, or non-null
  assertions for external data. Prefer `unknown`, type guards, discriminated
  unions, and explicit fallback behavior.
- Preserve cancellation, timeout, and disposal behavior in asynchronous code.
  Do not silently swallow errors; report them with enough operation and target
  context to diagnose the failure.
- Keep behavior deterministic: sort filesystem-derived output where order
  matters, avoid unbounded concurrency, and do not depend on object or directory
  enumeration order.
- Reuse shared protocol and domain types instead of duplicating wire-format
  interfaces across the Extension Host, Webview, LSP, and MCP layers.

## Internationalization And Docs

Update English and Chinese together for user-visible commands, settings,
diagnostics, chat/workflow UI, Webviews, and release-facing docs. Prefer the
existing catalogs:

- `client/extension/ai/messages.ts`
- `client/extension/ai/workflowI18n.ts`
- `client/webview/chat/i18n.ts`

Root docs are single-source bilingual documents:

- `README.md`
- `CONTRIBUTING.md`
- `ARCHITECTURE.md`

Do not recreate separate `_EN` or `_ZH` copies. Run `npm run build:docs` after
changing these docs; it also regenerates `release/README.md` from `README.md`.

## Repository Boundaries

- `client/extension/`: VS Code Extension Host code.
- `client/extension/ai/`: AI runtime, tools, workflows, memory, and orchestration.
- `client/webview/`: browser-sandboxed Webviews.
- `src/LSP/`, `src/Main/`: .NET 10 / F# language server.
- `submodules/cwtools/`: upstream F# library.
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rules data.
- `submodules/cwtools-mcp/`: standalone read-only MCP server (`cwtools-shared` +
  `cwtools-mcp` packages), a separate repository vendored as a submodule. The
  extension VSIX does not bundle it; users install it via `npx -y cwtools-mcp`.

Reuse shared platform helpers such as `gameProfiles.ts`, `indexing/`,
`pathScope.ts`, and `fileExtensions.ts` rather than duplicating them.

Submodules have separate ownership. Commit a `submodules/cwtools` change inside
that submodule first, then update the root pointer. Treat
`cwtools-stellaris-config` as rules content, and do not mix the two kinds of
change in one undifferentiated commit. The same rule applies to
`submodules/cwtools-mcp`: MCP changes are committed and pushed inside that
repository first (it has its own release cycle and npm publishing), then the
root pointer is bumped.

## Task-Specific Constraints

### Webviews (`client/webview/`)

- Do not import `vscode`, `fs`, `path`, use `require()`, or call Node-only APIs.
- Communicate with the Extension Host through `postMessage`.
- Use VS Code theme variables and support `prefers-reduced-motion`.
- Dispose renderers, GPU resources, workers, listeners, and animation loops.
- Keep file I/O and `ReadTracker` in the Extension Host.

### AI tools and runner (`client/extension/ai/`)

When changing a model-visible tool, update its definitions, types, registry,
permissions when applicable, and dispatch in `agentTools.ts`. The registry is
the source of truth for gating, effects, risk, and concurrency.

Keep every tool call behind the policy engine. Preserve hardened `path.relative`
cwd checks, sorted multi-file locking, per-file write exclusion, command
preflight, and plan-mode write gates. Active multi-agent tools are
`dispatch_agents`, `query_blackboard`, and `merge_results`; do not revive old
tool names or retired model-visible patch tools.

New run-event types must update reducers and Webview renderers. Resume changes
must retain V2 compatibility. Read `ARCHITECTURE.md` before large runner changes.

### MCP (`submodules/cwtools-mcp/`)

- The MCP server is read-only and must reject non-whitelisted writes.
- Add new semantic capability as a `cwtools.ai.*` LSP command first.
- Keep tool names and schema generation inputs synchronized; do not hand-edit
  `submodules/cwtools-mcp/packages/cwtools-shared/src/generated/mcpTools.ts`.
- Add read-only LSP commands to `LanguageServer.fs` `isReadCmd`.
- Tool-schema workflow after changing `client/extension/ai/tools/definitions.ts`:
  run `npm run generate:mcp-schema` (writes into the submodule), commit and push
  inside `submodules/cwtools-mcp`, then bump the root submodule pointer. Publish
  a new `cwtools-mcp` version from that repository so external agents pick up
  the change.
- MCP builds and contract tests run inside the submodule:
  `cd submodules/cwtools-mcp && npm run build && npm run test:contracts`.

### F# and shader work (`src/`, `submodules/cwtools/`)

Reuse `PdxShaderFeatures`; cache expensive parsing where supported, use
bracket-depth scanning for nested blocks, preserve escaped-quote handling, and
use case-insensitive path comparison only on Windows.

Incremental scripted-type refresh spans `src/Main/Program.fs` and the upstream
CWTools submodule. Only Stellaris has a real incremental implementation. When
changing it, compare incremental results with a full refresh and keep submodule
and root commits separate.

## Verification

Run the narrowest useful checks, then broaden according to risk:

- Docs: `npm run build:docs` and
  `npm run check:release -- --skip-compile --skip-test`.
- Extension TypeScript or Webview: `npm run compile` and `npm run typecheck:test`
  (strict check over the whole `client/` tree including tests), then targeted
  unit tests.
- AI runtime/tools: targeted unit tests, then `npm run test:unit`.
- Extension Host integration suites: `npm test` (compiles the suite JS via
  `tsconfig.test-build.json`, copies `client/test/sample` fixtures, and runs the
  completion/hover/folding/extension suites; the shader contract suite is run
  separately via `npm run test:shader-lsp`). Fixture workspace settings are
  created by `tools/copy-test-fixtures.js` with Stellaris language associations
  (`*.txt/gui/gfx/asset/cwt -> stellaris`) and the vendored
  `submodules/cwtools-stellaris-config/config` rules. The Stellaris game model
  needs vanilla data (game install or `stl.cwb` cache) and takes ~20s to build;
  when neither exists the server degrades to the generic game (see
  `hasStellarisVanillaData` in `src/Main/GameLoader.fs`).
- MCP: `npm run generate:mcp-schema`, then inside `submodules/cwtools-mcp`:
  `npm run build` and `npm run test:contracts`.
- F# backend: `dotnet build src/LSP/` and/or `dotnet build src/Main/`, plus the
  `src/**/*.Tests.fsx` regression scripts via `dotnet fsi` (run from each
  script's directory).
- Broad pre-release gate: `npm run verify`.

If a relevant check cannot run, report that explicitly instead of silently
skipping it.
