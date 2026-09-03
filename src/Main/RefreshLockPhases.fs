module RefreshLockPhases

open System
open System.Collections.Generic

/// The three phases of a refresh. Only CommitInsideLock may run while the root
/// game write lock is held.
type RefreshPhase =
    | PrepareOutsideLock
    | CommitInsideLock
    | FollowupOutsideLock

/// Work categories are deliberately closed so newly-added commit work must make
/// an explicit decision about whether it is safe under the root write lock.
type CommitWorkKind =
    | SnapshotSwap
    | EpochAdvance
    | QueueAcknowledgement
    | DiagnosticMerge
    | ExpensiveCallback

let isWriteLockHeldForPhase = function
    | CommitInsideLock -> true
    | PrepareOutsideLock
    | FollowupOutsideLock -> false

let isCommitWorkWhitelisted = function
    | SnapshotSwap
    | EpochAdvance
    | QueueAcknowledgement -> true
    | DiagnosticMerge
    | ExpensiveCallback -> false

let assertWorkAllowed phase workKind =
    match phase with
    | CommitInsideLock when not (isCommitWorkWhitelisted workKind) ->
        invalidOp (sprintf "Work kind %A is not allowed while the root write lock is held." workKind)
    | _ -> ()

type PhaseWork<'Result> =
    { Phase: RefreshPhase
      Kind: CommitWorkKind
      Run: unit -> 'Result }

type PhaseTimingOutcome =
    | Completed
    | Failed of string

type PhaseTiming =
    { Phase: RefreshPhase
      Kind: CommitWorkKind
      Elapsed: TimeSpan
      Outcome: PhaseTimingOutcome }

[<Literal>]
let CommitBudgetMilliseconds = 100

let commitBudget = TimeSpan.FromMilliseconds(float CommitBudgetMilliseconds)
let isWithinCommitBudget elapsed = elapsed <= commitBudget

type CommitScopeResult<'T> =
    { Outcome: Result<'T, exn>
      Elapsed: TimeSpan
      OverBudget: bool }

type PreparedCommitOutcome<'T> =
    | CommitSucceeded of 'T
    | CommitSuperseded
    | CommitAlreadyCompleted
    | CommitFailed of exn

type PreparedCommitResolution<'T> =
    | PublishCommitResult of 'T
    | KeepCommitPending

/// The delete commit owns only the model mutation and scalar publication epoch.
/// Program follow-up work is dispatched after the root write lock is released.
type LocalisationDeleteOutcome<'Result, 'Epoch> =
    | LocalisationDeleteCommitted of result: 'Result * epoch: 'Epoch
    | LocalisationDeleteCapabilityUnavailable
    | LocalisationDeleteCommitFailed of exn

let dispatchLocalisationDeleteFollowup outcome onCommitted onPending =
    match outcome with
    | LocalisationDeleteCommitted(result, epoch) -> onCommitted result epoch
    | LocalisationDeleteCapabilityUnavailable -> onPending None
    | LocalisationDeleteCommitFailed error -> onPending (Some error)

/// A known result is safe to publish even when a repeated commit reports that
/// the stage already completed. Every indeterminate outcome remains pending.
let resolvePreparedCommitOutcome recoveredResult outcome =
    match outcome with
    | CommitSucceeded result -> PublishCommitResult result
    | CommitAlreadyCompleted ->
        recoveredResult
        |> Option.map PublishCommitResult
        |> Option.defaultValue KeepCommitPending
    | CommitSuperseded
    | CommitFailed _ -> KeepCommitPending

let private ownershipInvariant phase actual =
    let expected = isWriteLockHeldForPhase phase
    if actual = expected then None
    else
        Some(
            InvalidOperationException(
                sprintf "Phase %A expected root write-lock ownership to be %b, but the actual probe returned %b." phase expected actual))

let private probeOwnership phase (isWriteLockHeld: unit -> bool) =
    try ownershipInvariant phase (isWriteLockHeld ())
    with probeError ->
        Some(
            InvalidOperationException(
                sprintf "Phase %A root write-lock ownership probe threw." phase,
                probeError))

let private combineCallbackAndInvariant (callbackError: exn) (invariantError: InvalidOperationException) =
    let causes =
        match invariantError.InnerException with
        | null -> [| callbackError |]
        | probeError -> [| callbackError; probeError |]
    InvalidOperationException(invariantError.Message, AggregateException("Callback and lock-ownership validation both failed.", causes))

type TimingAggregate =
    { Count: int64
      FailureCount: int64
      OverBudgetCount: int64
      MaxElapsed: TimeSpan
      Last: PhaseTiming option }

/// Records every attempted work item. The bounded ring retains only the latest
/// diagnostics while aggregate telemetry covers the collector's full lifetime.
/// The shared budget is enforced once around the entire contiguous lock hold by
/// MeasureCommitScope, including gaps between individual operations.
type TimingCollector(now: unit -> TimeSpan, isWriteLockHeld: unit -> bool, ?capacity: int) =
    let gate = obj ()
    let capacity = defaultArg capacity 256
    do if capacity <= 0 then invalidArg (nameof capacity) "Capacity must be positive."
    let timings: PhaseTiming option array = Array.create capacity None
    let mutable nextTiming = 0
    let mutable retainedCount = 0
    let mutable aggregate =
        { Count = 0L
          FailureCount = 0L
          OverBudgetCount = 0L
          MaxElapsed = TimeSpan.Zero
          Last = None }

    let append timing =
        timings[nextTiming] <- Some timing
        nextTiming <- (nextTiming + 1) % capacity
        retainedCount <- min capacity (retainedCount + 1)
        aggregate <-
            { Count = aggregate.Count + 1L
              FailureCount =
                  aggregate.FailureCount
                  + (match timing.Outcome with Completed -> 0L | Failed _ -> 1L)
              OverBudgetCount = aggregate.OverBudgetCount + (if isWithinCommitBudget timing.Elapsed then 0L else 1L)
              MaxElapsed = max aggregate.MaxElapsed timing.Elapsed
              Last = Some timing }

    member _.Measure(work: PhaseWork<'Result>) =
        let started = now ()
        let mutable recorded = false

        let record outcome =
            let elapsed = max TimeSpan.Zero (now () - started)
            lock gate (fun () ->
                append
                    { Phase = work.Phase
                      Kind = work.Kind
                      Elapsed = elapsed
                      Outcome = outcome })
            recorded <- true

        let fail (error: exn) =
            record (Failed error.Message)
            raise error

        try
            assertWorkAllowed work.Phase work.Kind
            match probeOwnership work.Phase isWriteLockHeld with
            | Some error -> fail error
            | None ->
                let callbackResult =
                    try Ok(work.Run ())
                    with callbackError -> Error callbackError

                // This probe intentionally runs after both callback success and failure.
                match callbackResult, probeOwnership work.Phase isWriteLockHeld with
                | Ok result, None ->
                    record Completed
                    result
                | Error callbackError, None -> fail callbackError
                | Ok _, Some invariantError -> fail invariantError
                | Error callbackError, Some invariantError ->
                    fail (combineCallbackAndInvariant callbackError invariantError)
        with error ->
            // Failures raised by fail are already recorded. This path covers
            // validation failures before callback execution, including forbidden work.
            if not recorded then record (Failed error.Message)
            reraise ()

    member _.MeasureCommitScope(run: unit -> 'Result) : CommitScopeResult<'Result> =
        let started = now ()
        match probeOwnership CommitInsideLock isWriteLockHeld with
        | Some error -> raise error
        | None ->
            let callbackResult =
                try Ok(run ())
                with callbackError -> Error callbackError
            let ownershipResult = probeOwnership CommitInsideLock isWriteLockHeld
            let elapsed = max TimeSpan.Zero (now () - started)

            match callbackResult, ownershipResult with
            | Ok _, Some invariantError -> raise invariantError
            | Error callbackError, Some invariantError ->
                raise (combineCallbackAndInvariant callbackError invariantError)
            | outcome, None ->
                { Outcome = outcome
                  Elapsed = elapsed
                  OverBudget = not (isWithinCommitBudget elapsed) }

    member _.Snapshot() =
        lock gate (fun () ->
            let start = if retainedCount = capacity then nextTiming else 0
            [ for offset in 0 .. retainedCount - 1 do
                  let index = (start + offset) % capacity
                  match timings[index] with
                  | Some timing -> yield timing
                  | None -> () ])

    member _.AggregateSnapshot() = lock gate (fun () -> aggregate)
    member _.Capacity = capacity

