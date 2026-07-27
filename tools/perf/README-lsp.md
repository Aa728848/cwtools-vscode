# LSP performance reproduction

These tools make the freeze and 100-edit memory checks repeatable without
changing files on disk.

## Fixed 100-edit run

Build the server first, then run the harness against a large Stellaris workspace:

```powershell
node tools/perf/lsp-memory-profile.mjs `
  --root C:\path\to\mod `
  --server artifacts\bin\Main\debug\Main.exe `
  --rules submodules\cwtools-stellaris-config `
  --edit-file events\large_events.txt `
  --iterations 100 `
  --iteration-delay-ms 2000 `
  --hold-ms 300000
```

The harness prints the server PID, sends a comment-only change, save, and
completion request each iteration, then leaves a five-minute stabilization
window. Compare `Memory`, `Performance`, `Refresh`, `CarrierSnapshot`, and
validation phase logs. The edited file is restored by `didClose`; disk content
is never written.

## Runtime trace

While the harness is in its edit or stabilization window, attach the trace
collector using the printed PID:

```powershell
powershell -ExecutionPolicy Bypass -File tools/perf/capture-lsp-trace.ps1 `
  -ProcessId 12345 -DurationSeconds 90
```

The trace includes CPU samples plus runtime GC, allocation, contention,
ThreadPool and exception events. Open the resulting `.nettrace` in PerfView or
Visual Studio. A freeze should now be attributable to one dominant request
phase using the matching request IDs and heartbeat gaps in the LSP log.

## Acceptance matrix

Run the same build and workspace for each case:

1. Save a large event file while repeatedly requesting completion in another file.
2. Edit a section template, then request completion and definition navigation.
3. Perform 25 saves each across solar initializers, section templates, component sets, and events.
4. Create, rename, and delete duplicate/overridden definitions.
5. Edit scripted triggers/effects and inline scripts together with their callers.

Do not claim latency or memory thresholds from logs alone. Retain the `.nettrace`,
the complete monitor log, build commit, workspace file count, and operation
sequence with every reported measurement.
