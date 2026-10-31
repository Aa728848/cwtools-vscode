# Reproducing LSP performance problems

The scripts in this directory reproduce edit-time freezes and memory growth without changing files on disk. Keep the workspace, build commit, operation sequence, and trace together; a log by itself is not enough for a performance claim.

## Run the 100-edit harness

Build the server, choose a large Stellaris workspace and a representative event file, then run it against the `CWTools Server` binary (`CWTools Server.exe` on Windows, no file extension on Linux, e.g. `artifacts/bin/Main/release_linux-x64/CWTools Server`; the assembly name contains a space, so quote the path):

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

Each iteration sends a comment-only change, a save, and a completion request. The process then remains open for five minutes so memory can settle. `didClose` restores the in-memory document; the harness never writes the edited content to disk.

Record the printed server PID and retain the `Memory`, `Performance`, `Refresh`, `CarrierSnapshot`, and validation-phase logs.

## Before/after comparison on the same baseline

To attribute a memory delta to the server build, run two binaries against the same workspace with the same arguments and operation sequence:

1. Build a baseline server (e.g. the previous submodule pointer) and an optimized server from the same commit, with the same configuration (`debug` vs `release`, same RID). The current optimization round lives entirely in `submodules/cwtools`; the root `src/` tree is unchanged.
2. Run the harness once per binary and keep the complete monitor log for each run.
3. Record the `mem[...]` line from the `Memory` monitorLog at the end of the run and again after full background validation finishes, plus the final diagnostic counts. `alloc` is cumulative allocated bytes (`GC.GetTotalAllocatedBytes`) and `working` is the process working set; treat `alloc` as the allocation-pressure signal and `working` as the retained-memory signal.
4. Require identical diagnostics between the two runs (same error and warning counts). A memory improvement with changed diagnostics is a correctness regression, not a win.

Current same-baseline result, Windows small fixture only (20 edits, 100 ms iteration delay, 5 s settle, `client/test/sample`, no vanilla data): end-of-run `alloc` 1052 MB -> 931 MB (about -11.5%) with `working` unchanged (174 MB -> 172 MB); after full background validation `alloc` 1002 MB -> 881 MB (about -12.1%). Diagnostics were identical (errors=572, warnings=749). These figures describe cumulative allocation on a small fixture; they do not represent the Linux 14 GB-scale workspace. Run the same comparison on Linux with a large workspace before claiming anything about that scenario.

## Capture a runtime trace

While the harness is editing or waiting, attach the trace collector to the printed PID:

```powershell
powershell -ExecutionPolicy Bypass -File tools/perf/capture-lsp-trace.ps1 `
  -ProcessId 12345 -DurationSeconds 90
```

The `.nettrace` includes CPU samples, GC and allocation events, contention, ThreadPool events, and exceptions. Open it in PerfView or Visual Studio. Match request IDs and heartbeat gaps from the LSP log to the dominant request phase in the trace.

## Live counters and idle heap snapshots

For a live view of GC and ThreadPool behavior while the harness runs, attach `dotnet-counters` to the printed PID (works on Windows and Linux):

```bash
dotnet-counters monitor --process-id 12345 --counters System.Runtime
```

For a retained-heap snapshot, let the run go idle first. The server trims at business milestones with a full compacting GC (`GC.Collect(2, Aggressive)` plus LOH compaction); wait until the `Memory` monitorLog reports the post-validation or post-refresh idle trim (`Memory trimmed (...)` / `GC after global refresh (idle)`), then collect:

```bash
dotnet-gcdump collect --process-id 12345 --output heap-after-idle.gcdump
```

Compare baseline and optimized dumps in PerfView at the same lifecycle point — always after idle and trim, never mid-edit. Differences taken mid-run mostly capture validation batch garbage.

## Scenarios to compare

Use the same build and workspace for each case:

1. Save a large event file while requesting completion in another file.
2. Edit a section template, then request completion and definition navigation.
3. Perform 25 saves each across solar initializers, section templates, component sets, and events.
4. Create, rename, and delete duplicate or overridden definitions.
5. Edit scripted triggers, scripted effects, inline scripts, and their callers in the same run.

For every reported measurement, keep the trace, complete monitor log, build commit, workspace file count, and exact operation sequence.
