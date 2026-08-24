# Phase 0 reproducible migration baseline

This directory contains the Phase 0 migration benchmark harness. The harness measures the configured CWTools LSP server over stdio and writes two artifacts per invocation: raw per-run observations and a derived summary.

## Rust standalone 24h soak

The migration-only document-store loop has been replaced by a Rust-only stdio workload. It stages the selected standalone Rust executable in a temporary directory with the F# worker disabled, then exercises initialize/initialized/shutdown/exit, open/full-edit/range-edit/save/close, mixed LSP queries, cancellation, and deterministic restarts. RSS is sampled from the server PID (`tasklist` on Windows or `ps` elsewhere), never from Node. Reports use schema version 1 and include repository/artifact identity, counters, RSS-growth analysis, and explicit pass criteria.

Smoke (safe; does not run the final lane):

    npm run soak:rust-smoke

The final lane defaults to exactly 1440 minutes and must not be run casually:

    npm run soak:rust-24h

Verify a completed report:

    npm run soak:rust-verify

Use `--iterations N` or `--minutes N` for short smoke runs. The final verifier additionally requires a clean repository identity and at least 1440 minutes of elapsed evidence. Generated reports should remain outside version control.

## Migration baseline

From the repository root (use at least three runs; the default is three):

    node tools/benchmarks/run-baseline.cjs --manifest benchmarks/phase0-baseline.manifest.json --workspace . --server <path-to-server> --runs 3 --out-dir benchmarks/results

Use `--dry-run` to validate arguments and print the planned measurements without starting a server; `--help` prints usage. The checked-in manifest is a template: provide a real server path and a workspace containing `benchmark.txt` (or adjust operation parameters).

Each run starts a fresh process. Run 1 is labelled **cold** and runs 2..N **warm**; this is a measurement label, not a cache-clearing claim. Every observation is retained, including unavailable values as `null`; the harness never substitutes estimates. Summary statistics are median/min/max over numeric observations only.

Captured metadata includes UTC timestamp, git commit (or null when unavailable), platform, architecture, Node version, resolved workspace and server paths, server binary byte size, and optional VSIX byte size. Measurements include startup-to-initialize response, each configured operation latency, validation/readiness latency, peak observed RSS where the platform exposes it, and process exit status.

The manifest format is described by [`phase0-baseline.schema.json`](./phase0-baseline.schema.json). Operation parameters may contain `<workspaceUri>`, replaced with a file URI safely on Windows and Unix. JSON-RPC uses the shared framing implementation in [`tools/lsp-transcript/lib/jsonrpc.cjs`](../tools/lsp-transcript/lib/jsonrpc.cjs).

Do not compare results across different server/workspace/Node/platform metadata without recording the difference. Keep generated results outside version control unless a benchmark result is intentionally being reviewed.
