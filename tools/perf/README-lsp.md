# Performance Tooling & LSP Profiling

Scripts in `tools/perf/` measure LSP edit/memory behavior, AI context baselines, and performance-log summaries without mutating workspace files on disk.

## Scripts in this directory

| Script | Purpose |
| --- | --- |
| `lsp-memory-profile.mjs` | Reproduces edit-time freezes and memory growth against a `CWTools Server` binary (comment-only edits + save + completion, restored on `didClose`). |
| `capture-lsp-trace.ps1` | Attaches `dotnet-trace` to a running server PID to capture CPU, GC, allocation, contention, ThreadPool, and exception events. |
| `ai-context-baseline.mjs` | Measures AI prompt/context assembly budgets (`npm run baseline:ai-context`). |
| `analyze-performance-log.mjs` | Parses and summarizes LSP performance logs (covered by `npm run test:perf`). |

Always keep the workspace metadata, build commit, exact operation sequence, and trace together—a log excerpt alone is insufficient for a performance claim.

## Run the 100-edit LSP harness

Build the server, pick a representative Stellaris workspace and event file, and point `--server` at the `CWTools Server` binary (quote the path because the assembly name contains a space):

```powershell
node tools/perf/lsp-memory-profile.mjs `
  --root C:\path\to\mod `
  --server "artifacts\bin\Main\debug\CWTools Server.exe" `
  --rules submodules\cwtools-stellaris-config `
  --edit-file events\large_events.txt `
  --iterations 100 `
  --iteration-delay-ms 2000 `
  --hold-ms 300000
```

Record the printed server PID and keep the `Memory`, `Performance`, `Refresh`, `CarrierSnapshot`, and validation-phase logs.

## Before/after baseline comparison

1. Build baseline and candidate binaries with identical configuration (`debug` vs `release`, same RID) and run both against the same workspace and arguments.
2. Record the `mem[...]` line from the `Memory` monitorLog at end-of-run and after full background validation completes (`alloc` = cumulative `GC.GetTotalAllocatedBytes`, `working` = process working set).
3. Require identical final diagnostic counts (errors and warnings); a memory drop with changed diagnostics is a correctness regression.

## Capture traces, live counters, and idle heap dumps

- **Runtime trace** (attach while editing or settling; open `.nettrace` in PerfView or Visual Studio):
  ```powershell
  powershell -ExecutionPolicy Bypass -File tools/perf/capture-lsp-trace.ps1 -ProcessId 12345 -DurationSeconds 90
  ```
- **Live counters** (Windows and Linux):
  ```bash
  dotnet-counters monitor --process-id 12345 --counters System.Runtime
  ```
- **Idle retained-heap snapshot**: wait until the `Memory` monitorLog logs the post-validation or post-refresh idle trim (`Memory trimmed (...)` / `GC after global refresh (idle)`), then capture and compare dumps taken at the same lifecycle point:
  ```bash
  dotnet-gcdump collect --process-id 12345 --output heap-after-idle.gcdump
  ```

## Recommended comparison scenarios

1. Save a large event file while requesting completion in another file.
2. Edit a section template, then request completion and go-to-definition.
3. Run 25 saves each across solar initializers, section templates, component sets, and events.
4. Create, rename, and delete duplicate or overridden definitions.
5. Edit scripted triggers, scripted effects, inline scripts, and their callers in one run.
