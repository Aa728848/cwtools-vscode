# Reproducing Rust LSP performance problems

Use `tools/benchmarks/rust-lsp-soak.cjs` for repeatable edit, query, cancellation, restart, RSS, and lifecycle measurements against the standalone Rust executable. Keep the workspace, build commit, artifact SHA-256, operation sequence, and JSON report together.

Build and stage the server with `npm run pack`, then run a bounded smoke or the final lane documented in `benchmarks/README.md`. For CPU profiling, attach Windows Performance Recorder, Linux `perf`, or macOS Instruments directly to the reported `cwtools-lsp` PID. Use the platform-native profiler rather than runtime-specific collectors.

Compare identical builds and workspaces across saves, concurrent completion/navigation requests, create/rename/delete operations, and scripted-trigger/effect/inline-script callers. Preserve the profiler output, full soak JSON, commit, artifact hash, file count, and exact arguments with every performance claim.
