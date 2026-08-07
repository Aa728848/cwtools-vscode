# Reproducing LSP performance problems

The scripts in this directory reproduce edit-time freezes and memory growth without changing files on disk. Keep the workspace, build commit, operation sequence, and trace together; a log by itself is not enough for a performance claim.

## Run the 100-edit harness

Build the server, choose a large Stellaris workspace and a representative event file, then run:

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

Each iteration sends a comment-only change, a save, and a completion request. The process then remains open for five minutes so memory can settle. `didClose` restores the in-memory document; the harness never writes the edited content to disk.

Record the printed server PID and retain the `Memory`, `Performance`, `Refresh`, `CarrierSnapshot`, and validation-phase logs.

## Capture a runtime trace

While the harness is editing or waiting, attach the trace collector to the printed PID:

```powershell
powershell -ExecutionPolicy Bypass -File tools/perf/capture-lsp-trace.ps1 `
  -ProcessId 12345 -DurationSeconds 90
```

The `.nettrace` includes CPU samples, GC and allocation events, contention, ThreadPool events, and exceptions. Open it in PerfView or Visual Studio. Match request IDs and heartbeat gaps from the LSP log to the dominant request phase in the trace.

## Scenarios to compare

Use the same build and workspace for each case:

1. Save a large event file while requesting completion in another file.
2. Edit a section template, then request completion and definition navigation.
3. Perform 25 saves each across solar initializers, section templates, component sets, and events.
4. Create, rename, and delete duplicate or overridden definitions.
5. Edit scripted triggers, scripted effects, inline scripts, and their callers in the same run.

For every reported measurement, keep the trace, complete monitor log, build commit, workspace file count, and exact operation sequence.
