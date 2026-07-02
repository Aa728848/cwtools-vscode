# CLAUDE.md

Claude Code compatibility entry for this repository.

The canonical AI-agent operating guide is `AGENTS.md`. Read and follow
`AGENTS.md` before editing. This file exists only because Claude Code discovers
`CLAUDE.md` automatically.

## Required Reading

- `AGENTS.md`: commands, edit rules, AI tool rules, MCP rules, Webview/F# risks.
- `ARCHITECTURE.md`: system background and module boundaries.
- `CONTRIBUTING.md`: human setup, verification, PR, and packaging workflow.

## Quick Rules

- Start with `git status --short` and `rg --files`.
- Keep changes scoped; do not revert unrelated user work.
- Prefer existing helpers and structured APIs over new abstractions.
- Do not duplicate version numbers; use root `package.json` and
  `release/package.json`.
- User-visible text needs English and Chinese updates.
- Webviews cannot use Node.js, `fs`, `path`, `require()`, or direct VS Code APIs.
- Generic write tools must not write localisation `.yml`; use localisation-aware
  paths/tools.
- AI tool changes must update definitions, types, registry, permissions if
  needed, and dispatch.
- MCP server tools are read-only; schema is generated, not hand-written.
- Root docs are single-source bilingual: `README.md`, `CONTRIBUTING.md`,
  `ARCHITECTURE.md`. Do not reintroduce single-language doc copies.
- Submodules have separate roles: `submodules/cwtools/` is the upstream F#
  library; `submodules/cwtools-stellaris-config/` is Stellaris CWT rules data.
  Commit submodule changes inside the submodule first, then update the root
  pointer.

## Common Commands

```bash
npm run build:docs
npm run compile
npm run lint
npm run test:unit
npm run check:release
npm run verify
npm run generate:mcp-schema
npm run test:contracts
dotnet build src/LSP/
dotnet build src/Main/
```

Use `AGENTS.md` for the complete working rules.
