# MCP Index Architecture Decision

## Status

Accepted for Phase 0.

## Context

The VS Code extension already has `client/extension/indexing/IndexService`, but that service depends on VS Code workspace APIs, disposables, and extension runtime state. The MCP server needs the same public capability names without becoming a second VS Code extension host.

## Decision

Phase 0 uses route B from the implementation plan: `cwtools-mcp` ships a thin Node index for `query_workspace_index` and `query_localisation_index`.

The thin index is intentionally bounded:

- It scans only the MCP workspace root.
- It returns lightweight workspace/localisation facts.
- It marks results with hints that LSP/index commands remain the Phase 1 source of truth.
- It does not copy or fork `IndexService`.

For Phase 1, preferred route A remains adding or wiring LSP-backed index query commands so VS Code and MCP can converge on the same semantic source. The thin Node index can stay as a startup fallback for `loading` or `unavailable` states, but it must not grow into a parallel long-term implementation of VS Code `IndexService`.

## Consequences

- MCP clients can call the first index tools in Phase 0 without VS Code.
- Semantic completeness stays explicitly limited until LSP-backed index commands exist.
- Any future expansion of index semantics should happen in LSP/shared contracts first, then be consumed by both VS Code and MCP adapters.
