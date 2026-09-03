#load "../TestHelpers.fsx"
#load "RefreshLockPhases.fs"

open System
open RefreshLockPhases
open TestHelpers

let mutable elapsedMs = 0.0
let mutable actualLockHeld = false
let now () = TimeSpan.FromMilliseconds elapsedMs
throws<ArgumentException> (fun () -> TimingCollector(now, (fun () -> actualLockHeld), capacity = 0) |> ignore) "Non-positive timing capacity rejected"
let collector = TimingCollector(now, fun () -> actualLockHeld)
let run phase kind duration =
    collector.Measure
        { Phase = phase
          Kind = kind
          Run = fun () -> elapsedMs <- elapsedMs + duration }

run PrepareOutsideLock ExpensiveCallback 25.0
actualLockHeld <- true
run CommitInsideLock SnapshotSwap 25.0
run CommitInsideLock EpochAdvance 25.0
run CommitInsideLock QueueAcknowledgement 25.0
actualLockHeld <- false
run FollowupOutsideLock ExpensiveCallback 25.0
let timings = collector.Snapshot()
equal 5 timings.Length "Every successful phase invocation must be timed"
check (timings |> List.forall (fun timing -> timing.Elapsed = TimeSpan.FromMilliseconds 25.0 && timing.Outcome = Completed)) "Injected clock must determine successful timing"

// Forbidden work is rejected before execution but still appears in diagnostics.
actualLockHeld <- true
let mutable forbiddenRan = false
throws<InvalidOperationException>
    (fun () ->
        collector.Measure
            { Phase = CommitInsideLock
              Kind = ExpensiveCallback
              Run = fun () -> forbiddenRan <- true })
    "Forbidden commit work rejected"
check (not forbiddenRan) "Forbidden callback must not run"
match collector.Snapshot() |> List.last with
| { Kind = ExpensiveCallback; Outcome = Failed message } -> check (message.Contains("not allowed")) "Forbidden work failure is timed"
| other -> failwithf "Expected forbidden-work timing, got %A" other

// A false declaration/actual ownership combination is rejected before work.
actualLockHeld <- false
let mutable mismatchRan = false
throws<InvalidOperationException>
    (fun () ->
        collector.Measure
            { Phase = CommitInsideLock
              Kind = SnapshotSwap
              Run = fun () -> mismatchRan <- true })
    "Commit declaration with no actual lock rejected"
check (not mismatchRan) "Ownership mismatch must reject before callback work"
match collector.Snapshot() |> List.last with
| { Phase = CommitInsideLock; Outcome = Failed message } -> check (message.Contains("actual probe returned false")) "Mismatch failure is recorded"
| other -> failwithf "Expected recorded ownership failure, got %A" other

// Post-work ownership is probed even when the callback first releases then throws.
actualLockHeld <- true
let releasedError =
    capture<InvalidOperationException>
        (fun () ->
            collector.Measure
                { Phase = CommitInsideLock
                  Kind = SnapshotSwap
                  Run = fun () -> actualLockHeld <- false; raise (ArgumentException("release-boom")) })
        "Release plus callback failure"
check (releasedError.Message.Contains("actual probe returned false")) "Ownership invariant is surfaced over callback failure"
let releasedAggregate = releasedError.InnerException :?> AggregateException
check (releasedAggregate.InnerExceptions |> Seq.exists (fun error -> error :? ArgumentException && error.Message = "release-boom")) "Original callback exception is retained"
match collector.Snapshot() |> List.last with
| { Outcome = Failed message } -> check (message.Contains("actual probe returned false")) "Dual failure is recorded as Failed"
| other -> failwithf "Expected dual failure timing, got %A" other

// Acquiring an outside-phase lock and throwing has the same invariant precedence.
actualLockHeld <- false
let acquiredError =
    capture<InvalidOperationException>
        (fun () ->
            collector.Measure
                { Phase = FollowupOutsideLock
                  Kind = ExpensiveCallback
                  Run = fun () -> actualLockHeld <- true; raise (ApplicationException("acquire-boom")) })
        "Acquire plus callback failure"
check (acquiredError.Message.Contains("actual probe returned true")) "Outside-phase acquisition violation is surfaced"
check ((acquiredError.InnerException :?> AggregateException).InnerExceptions |> Seq.exists (fun error -> error.Message = "acquire-boom")) "Acquire callback failure is retained"

// A throwing post-work probe is handled and retains a simultaneous callback failure.
let mutable probeCalls = 0
let probeCollector =
    TimingCollector(now, fun () ->
        probeCalls <- probeCalls + 1
        if probeCalls = 2 then raise (InvalidOperationException("probe-boom"))
        false)
let probeError =
    capture<InvalidOperationException>
        (fun () ->
            probeCollector.Measure
                { Phase = PrepareOutsideLock
                  Kind = ExpensiveCallback
                  Run = fun () -> raise (ArgumentException("callback-boom")) })
        "Probe and callback failure"
check (probeError.Message.Contains("probe threw")) "Probe failure is surfaced as ownership invariant"
let probeAggregate = probeError.InnerException :?> AggregateException
check (probeAggregate.InnerExceptions |> Seq.exists (fun error -> error.Message = "callback-boom")) "Callback failure survives probe failure"
check (probeAggregate.InnerExceptions |> Seq.exists (fun error -> error.Message = "probe-boom")) "Probe failure is retained"

// Per-work timings remain diagnostic and do not independently claim the budget.
actualLockHeld <- true
elapsedMs <- 500.0
run CommitInsideLock SnapshotSwap 101.0
match collector.Snapshot() |> List.last with
| { Elapsed = elapsed; Outcome = Completed } -> equal (TimeSpan.FromMilliseconds 101.0) elapsed "Slow individual work is diagnostic only"
| other -> failwithf "Expected completed diagnostic timing, got %A" other

// The diagnostic ring is hard-bounded while lifetime aggregates remain exact.
let mutable ringNowMs = 0.0
let ringCollector = TimingCollector((fun () -> TimeSpan.FromMilliseconds ringNowMs), (fun () -> false))
for i in 1 .. 1000 do
    let duration = float i
    let work =
        { Phase = PrepareOutsideLock
          Kind = ExpensiveCallback
          Run = fun () ->
              ringNowMs <- ringNowMs + duration
              if i % 10 = 0 then raise (InvalidOperationException(sprintf "failure-%d" i)) }
    if i % 10 = 0 then throws<InvalidOperationException> (fun () -> ringCollector.Measure work) "Synthetic ring failure"
    else ringCollector.Measure work
let ringSnapshot = ringCollector.Snapshot()
let ringAggregate = ringCollector.AggregateSnapshot()
equal 256 ringCollector.Capacity "Default timing capacity is fixed"
check (ringSnapshot.Length <= 256) "Timing snapshot must never exceed ring capacity"
equal 256 ringSnapshot.Length "Full timing ring retains exactly its capacity"
equal (TimeSpan.FromMilliseconds 745.0) ringSnapshot.Head.Elapsed "Snapshot starts at oldest retained timing"
equal (TimeSpan.FromMilliseconds 1000.0) (List.last ringSnapshot).Elapsed "Snapshot ends at latest timing"
equal 1000L ringAggregate.Count "Aggregate count covers evicted timings"
equal 100L ringAggregate.FailureCount "Aggregate failure count is exact"
equal 900L ringAggregate.OverBudgetCount "Aggregate over-budget count is exact"
equal (TimeSpan.FromMilliseconds 1000.0) ringAggregate.MaxElapsed "Aggregate max is exact"
match ringAggregate.Last with
| Some { Elapsed = elapsed; Outcome = Failed "failure-1000" } -> equal (TimeSpan.FromMilliseconds 1000.0) elapsed "Aggregate last timing is exact"
| other -> failwithf "Expected exact last aggregate timing, got %A" other

// MeasureCommitScope reports callback outcome and budget independently: all four combinations.
let measureScope duration callback =
    elapsedMs <- elapsedMs + 1000.0
    collector.MeasureCommitScope(fun () ->
        elapsedMs <- elapsedMs + duration
        callback ())

let withinSuccess = measureScope 100.0 (fun () -> 42)
equal (Ok 42) withinSuccess.Outcome "Within-budget callback success is returned"
equal (TimeSpan.FromMilliseconds 100.0) withinSuccess.Elapsed "Scope reports elapsed time"
check (not withinSuccess.OverBudget) "The exact budget boundary is not over budget"

let overSuccess = measureScope 101.0 (fun () -> 43)
equal (Ok 43) overSuccess.Outcome "Over-budget callback success is still returned"
check overSuccess.OverBudget "Successful over-budget scope is telemetry, not an exception"

let withinFailure = measureScope 50.0 (fun () -> raise (ArgumentException("within-callback")) : int)
match withinFailure.Outcome with
| Error (:? ArgumentException as error) -> equal "within-callback" error.Message "Within-budget callback failure remains separate"
| other -> failwithf "Expected within-budget callback failure, got %A" other
check (not withinFailure.OverBudget) "Callback failure does not imply budget failure"

let mutable sideEffects = 0
let overFailure =
    measureScope 101.0 (fun () ->
        sideEffects <- sideEffects + 1
        raise (ApplicationException("over-callback")) : int)
match overFailure.Outcome with
| Error (:? ApplicationException as error) -> equal "over-callback" error.Message "Over-budget callback failure is retained"
| other -> failwithf "Expected over-budget callback failure, got %A" other
check overFailure.OverBudget "Callback failure and budget overrun are both represented"
equal 1 sideEffects "Structured reporting neither retries nor rolls back callback side effects"

// Pure commit resolution seam protects indeterminate stages and recovers known completion results.
equal (PublishCommitResult "fresh") (resolvePreparedCommitOutcome None (CommitSucceeded "fresh")) "Committed result publishes"
equal KeepCommitPending (resolvePreparedCommitOutcome None CommitSuperseded) "Superseded stage remains pending"
equal KeepCommitPending (resolvePreparedCommitOutcome None (CommitFailed (InvalidOperationException("boom")))) "Commit exception remains pending"
equal (PublishCommitResult "recovered") (resolvePreparedCommitOutcome (Some "recovered") CommitAlreadyCompleted) "AlreadyCompleted publishes a recoverable result"
equal KeepCommitPending (resolvePreparedCommitOutcome None CommitAlreadyCompleted) "AlreadyCompleted without a result reparses pending work"

check (isWithinCommitBudget (TimeSpan.FromMilliseconds 100.0)) "The shared 100ms boundary is within budget"
check (not (isWithinCommitBudget (TimeSpan.FromMilliseconds 100.001))) "Over-budget commits are rejected"

printfn "RefreshLockPhases tests passed"
