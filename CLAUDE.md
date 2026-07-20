# CLAUDE.md

Claude Code compatibility entry for this repository.

Read and follow the canonical instructions in `AGENTS.md` before editing. Load
`ARCHITECTURE.md` or `CONTRIBUTING.md` only when relevant to the current task.

Critical rules:

- Preserve unrelated working-tree changes and keep edits scoped.
- Use CodeGraph first when `.codegraph/` exists, then targeted `rg` searches.
- Update English and Chinese user-visible text together.
- Do not use Node.js or VS Code APIs inside Webviews.
- Keep the bundled MCP server read-only and do not hand-edit generated schemas.
- Use localisation-aware writing for `.yml` files.
- Commit changes inside `submodules/cwtools` before updating the root pointer.
- Run the narrowest relevant verification from `AGENTS.md`.
