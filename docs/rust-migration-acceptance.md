# Rust migration acceptance status

This document records the remaining acceptance work after implementation. It is intentionally separate from the historical execution plan in `docs/fsharp-to-rust-migration-plan.md`.

## Implemented repository state

- The extension launches only `release/bin/server/<rid>/CWTools Server[.exe]`.
- The standalone server is Rust-only; no F#/.NET worker, selector, proxy, sidecar, or automatic fallback remains.
- The Rust core workspace contains source/document overlays, parser/domain/process, CWT syntax/project/service, rule IR/engine, workspace snapshots, cache, game profiles, scope catalogs, Shader, and semantic/knowledge functionality.
- The Rust LSP consumes the game, Shader, and semantic crates and handles standard LSP and custom commands directly.
- MCP remains a separately published read-only TypeScript package and is not bundled in the VSIX.
- The migration execution plan remains in source control until acceptance closes; its presence is not a runtime or release artifact.

## Universal release invariant

Every published VSIX must contain exactly these three native Rust servers:

- `bin/server/win-x64/CWTools Server.exe` (PE)
- `bin/server/linux-x64/CWTools Server` (ELF)
- `bin/server/osx-x64/CWTools Server` (Mach-O)

`npm run pack` creates a host-only development VSIX and cannot publish. The CI matrix builds explicit x86-64 targets on native Windows, Linux, and macOS runners. `npm run pack:universal` merges downloaded artifacts, executes the strict staging gate, creates the VSIX, and validates the archive. `npm run pack:release` refuses a dirty tree, mismatched tag/version, ambiguous VSIX, or archive that fails the universal gate. Tag CI publishes only the immutable verified universal artifact.

The archive gate also requires release manifest/README/rules metadata, three distinct binary hashes, no bundled MCP, no unexpected server files, and no .NET or migration runtime artifacts.

## Work that remains acceptance-only

The implementation is not declared complete until all non-long-running checks are executed on the final clean commit and its universal VSIX. Cross-platform and licensed real-game evidence must come from their appropriate runners. The final 24-hour soak starts only after those checks pass and must satisfy the strict report verifier.

No checkbox or prose assertion in the historical plan substitutes for executable evidence.
