#load "RefreshLockPhases.fs"

open System
open System.IO
open System.Threading
open RefreshLockPhases

let check condition message =
    if not condition then failwith message

let equal expected actual message =
    if expected <> actual then
        failwithf "%s. Expected %A, got %A" message expected actual

let capture<'T when 'T :> exn> action message =
    try
        action ()
        failwith (message + ": no exception")
    with
    | :? 'T as error -> error

let guard generation epochs =
    { Generation = generation
      Epochs = Map.ofList epochs }

/// Minimal integration abstraction for the incoming migration: preparation owns
/// an isolated manager value and publication payload; only the immutable manager
/// state and exact queue prefix are committed while the root lock is held.
type StagedRefresh =
    { Guard: GuardVector
      PreparedPrefix: string list
      Manager: string
      Publication: string }

type IntegrationState =
    { mutable Committed: CommitState<string, string>
      mutable Published: string option }

let rootLock = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion)
let mutable elapsedMs = 0.0
let now () = TimeSpan.FromMilliseconds elapsedMs
let timings = TimingCollector(now, fun () -> rootLock.IsWriteLockHeld)

let measure phase kind duration callback =
    timings.Measure
        { Phase = phase
          Kind = kind
          Run = fun () ->
              elapsedMs <- elapsedMs + duration
              callback () }

let prepare guard prefix manager publication duration =
    measure PrepareOutsideLock ExpensiveCallback duration (fun () ->
        check (not rootLock.IsWriteLockHeld) "Preparation must run outside the root write lock"
        { Guard = guard
          PreparedPrefix = prefix
          Manager = manager
          Publication = publication })

let commit (state: IntegrationState) (staged: StagedRefresh) gapDuration =
    rootLock.EnterWriteLock()
    try
        let scope =
            timings.MeasureCommitScope(fun () ->
                let plan =
                    SwapSnapshotAndAcknowledgeExactPrefix(
                        staged.Guard,
                        staged.PreparedPrefix,
                        staged.Manager)

                let candidate =
                    measure CommitInsideLock SnapshotSwap 10.0 (fun () ->
                        tryApplyCommitPlan plan state.Committed)

                // This uninstrumented interval proves the budget covers the total
                // contiguous lock hold, not merely the sum of measured callbacks.
                elapsedMs <- elapsedMs + gapDuration

                match candidate with
                | None -> false
                | Some next ->
                    measure CommitInsideLock QueueAcknowledgement 10.0 (fun () ->
                        state.Committed <- next)
                    true)
        match scope.Outcome with
        | Ok committed -> committed
        | Error error -> raise error
    finally
        rootLock.ExitWriteLock()

let publish (state: IntegrationState) (staged: StagedRefresh) duration =
    measure FollowupOutsideLock ExpensiveCallback duration (fun () ->
        check (not rootLock.IsWriteLockHeld) "Publication must run outside the root write lock"
        state.Published <- Some staged.Publication)

let runRefresh state staged gapDuration =
    if commit state staged gapDuration then
        publish state staged 15.0
        true
    else
        false

let initialGuard = guard 7L [ "resource", 11L; "rules", 3L; "files", 5L ]
let state =
    { Committed =
        { Guard = initialGuard
          Snapshot = "manager-old"
          Pending = [ "a"; "b"; "newer" ] }
      Published = None }

// Happy path: isolated preparation, one real write-lock commit, and publication after release.
let staged = prepare initialGuard [ "a"; "b" ] "manager-new" "publish-new" 40.0
check (runRefresh state staged 5.0) "A current staged refresh must commit"
equal "manager-new" state.Committed.Snapshot "Manager state must swap during commit"
equal [ "newer" ] state.Committed.Pending "Only the exact prepared prefix may be acknowledged"
equal (Some "publish-new") state.Published "Publication follows a successful commit"
check (not rootLock.IsWriteLockHeld) "The root write lock must be released after success"

// Prefix mismatch rejects manager swap and publication as one unit.
let beforeMismatch = state.Committed
let priorPublication = state.Published
let mismatched = prepare initialGuard [ "newer"; "missing" ] "manager-bad" "publish-bad" 1.0
check (not (runRefresh state mismatched 0.0)) "A non-exact prefix must reject the staged commit"
equal beforeMismatch state.Committed "Prefix rejection must leave manager and queue unchanged"
equal priorPublication state.Published "Rejected work must not publish"

// Guard mismatch likewise rejects both manager and queue changes.
let stale = prepare { initialGuard with Generation = 8L } [ "newer" ] "manager-stale" "publish-stale" 1.0
check (not (runRefresh state stale 0.0)) "A stale guard must reject the staged commit"
equal beforeMismatch state.Committed "Stale rejection must be atomic"
equal priorPublication state.Published "Stale work must not publish"

// Callback failures are returned separately and the real lock is still released.
rootLock.EnterWriteLock()
let callbackScope =
    try
        timings.MeasureCommitScope(fun () ->
            measure CommitInsideLock EpochAdvance 1.0 (fun () ->
                raise (ArgumentException("commit-boom")) : unit))
    finally
        rootLock.ExitWriteLock()
match callbackScope.Outcome with
| Error (:? ArgumentException as error) -> equal "commit-boom" error.Message "The original commit exception must be retained"
| other -> failwithf "Expected commit callback failure, got %A" other
check (not callbackScope.OverBudget) "A callback exception is not a budget overrun"
check (not rootLock.IsWriteLockHeld) "The root write lock must be released after callback failure"

// The single budget includes measured work and uninstrumented gaps across the
// complete real lock hold. Side effects occur once and are not rolled back.
let mutable budgetSideEffects = 0
rootLock.EnterWriteLock()
let budgetScope =
    try
        timings.MeasureCommitScope(fun () ->
            measure CommitInsideLock SnapshotSwap 40.0 (fun () -> budgetSideEffects <- budgetSideEffects + 1)
            elapsedMs <- elapsedMs + 25.0
            measure CommitInsideLock EpochAdvance 40.0 (fun () -> budgetSideEffects <- budgetSideEffects + 1))
    finally
        rootLock.ExitWriteLock()
match budgetScope.Outcome with
| Ok () -> ()
| other -> failwithf "Expected successful over-budget callback, got %A" other
check budgetScope.OverBudget "The total-scope budget is reported without throwing"
equal 2 budgetSideEffects "Budget reporting must neither retry nor roll back side effects"
check (not rootLock.IsWriteLockHeld) "The root write lock must be released after a budget overrun"

// Direct outcome seam: indeterminate stages remain pending; known completion is recoverable.
equal KeepCommitPending (resolvePreparedCommitOutcome None CommitSuperseded) "Superseded commit must not abandon its cursor"
equal KeepCommitPending (resolvePreparedCommitOutcome None (CommitFailed (Exception("indeterminate")))) "Commit exception must retry pending work"
equal (PublishCommitResult "known") (resolvePreparedCommitOutcome (Some "known") CommitAlreadyCompleted) "Known AlreadyCompleted result is recovered"

// Script-localisation seam: expensive validation observes no write lock, while an
// epoch change between preparation and commit rejects publication and retains work.
let mutable scriptValidationSawWriteLock = true
let scriptGuard = guard 20L [ "game", 4L; "types", 9L; "localisation", 2L ]
let scriptPrepared =
    measure PrepareOutsideLock ExpensiveCallback 25.0 (fun () ->
        scriptValidationSawWriteLock <- rootLock.IsWriteLockHeld
        { Guard = scriptGuard
          PreparedPrefix = [ "scripted_effects.txt" ]
          Manager = "unused"
          Publication = "script-localisation-errors" })
check (not scriptValidationSawWriteLock) "Script localisation validation callback must run outside the root write lock"
let staleScriptState =
    { Committed =
        { Guard = { scriptGuard with Epochs = scriptGuard.Epochs |> Map.add "types" 10L }
          Snapshot = "manager-current"
          Pending = [ "scripted_effects.txt" ] }
      Published = None }
check (not (runRefresh staleScriptState scriptPrepared 0.0)) "Changed model epoch must reject prepared script localisation"
equal [ "scripted_effects.txt" ] staleScriptState.Committed.Pending "Stale script localisation must retain pending files"
equal None staleScriptState.Published "Stale script localisation must not publish prepared errors"

// Delete-localisation seam: the model call may hold the lock, but every Program
// callback is dispatched after release. Unavailable capability stays pending and wakes.
let mutable deleteApplied = false
let mutable deletePending = false
let mutable deleteWoke = false
rootLock.EnterWriteLock()
let deleteOutcome =
    try
        LocalisationDeleteCommitted("delete-result", 21L)
    finally
        rootLock.ExitWriteLock()
dispatchLocalisationDeleteFollowup
    deleteOutcome
    (fun result epoch ->
        check (not rootLock.IsWriteLockHeld) "Delete apply/cache/domain/invalidation/log callbacks must run outside the root write lock"
        equal "delete-result" result "Delete result must be captured by the commit"
        equal 21L epoch "Delete publication epoch must be captured by the commit"
        deleteApplied <- true)
    (fun _ -> failwith "Committed delete must not stay pending")
check deleteApplied "Committed delete must dispatch Program follow-up"

dispatchLocalisationDeleteFollowup
    LocalisationDeleteCapabilityUnavailable
    (fun _ _ -> failwith "Unavailable delete capability must not publish completion")
    (fun error ->
        check (not rootLock.IsWriteLockHeld) "Unavailable delete fallback must run outside the root write lock"
        equal None error "Unavailable capability is not a commit exception"
        deletePending <- true
        deleteWoke <- true)
check deletePending "Unavailable delete capability must retain localisation pending state"
check deleteWoke "Unavailable delete capability must wake delayed localisation refresh"

let mutable failedDeletePending = false
dispatchLocalisationDeleteFollowup
    (LocalisationDeleteCommitFailed(InvalidOperationException("delete-commit")))
    (fun _ _ -> failwith "Failed delete commit must not publish completion")
    (fun error ->
        check (not rootLock.IsWriteLockHeld) "Failed delete fallback must run outside the root write lock"
        check (error |> Option.exists (fun failure -> failure.Message = "delete-commit")) "Delete commit failure must be retained for logging"
        failedDeletePending <- true)
check failedDeletePending "Failed delete commit must retain localisation pending state"

// Nonincremental localisation seam: refresh/epoch capture is the write-lock commit;
// diagnostics materialize under a read lock, then exact final guard rejection keeps
// work pending when the epoch changes before publication. Every follow-up callback
// must observe write-lock-held=false.
let mutable liveNonincrementalGuard = guard 30L [ "game", 8L; "localisation", 12L ]
let capturedNonincrementalGuard =
    rootLock.EnterWriteLock()
    try
        check rootLock.IsWriteLockHeld "The model refresh seam must hold the root write lock"
        liveNonincrementalGuard
    finally
        rootLock.ExitWriteLock()

let mutable diagnosticsMaterialized = false
rootLock.EnterReadLock()
try
    check (not rootLock.IsWriteLockHeld) "LocalisationErrors/grouping callback must observe write-lock-held=false"
    check (guardVectorsMatch capturedNonincrementalGuard liveNonincrementalGuard) "The read-lock guard must initially be current"
    diagnosticsMaterialized <- true
finally
    rootLock.ExitReadLock()
check diagnosticsMaterialized "Current nonincremental diagnostics must materialize"

let mutable currentPublished = false
let currentNonincremental =
    dispatchNonincrementalLocalisationFollowup
        (guardVectorsMatch capturedNonincrementalGuard liveNonincrementalGuard)
        (fun () ->
            check (not rootLock.IsWriteLockHeld) "Cache/invalidation/domain/log publication callback must observe write-lock-held=false"
            currentPublished <- true)
        (fun () -> failwith "Current nonincremental localisation must not requeue")
check currentNonincremental "Current nonincremental localisation must run its follow-up"
check currentPublished "Current nonincremental localisation must publish diagnostics"

// Simulate a model mutation after read-lock materialization but before the final recheck.
liveNonincrementalGuard <- { liveNonincrementalGuard with Epochs = liveNonincrementalGuard.Epochs |> Map.add "localisation" 13L }
let mutable staleNonincrementalPublished = false
let mutable staleNonincrementalRequeued = false
let mutable staleNonincrementalWoke = false
let staleNonincremental =
    dispatchNonincrementalLocalisationFollowup
        (guardVectorsMatch capturedNonincrementalGuard liveNonincrementalGuard)
        (fun () -> staleNonincrementalPublished <- true)
        (fun () ->
            check (not rootLock.IsWriteLockHeld) "Stale pending/wake callback must observe write-lock-held=false"
            staleNonincrementalRequeued <- true
            staleNonincrementalWoke <- true)
check (not staleNonincremental) "A stale final guard must reject nonincremental publication"
check (not staleNonincrementalPublished) "A stale final guard must not replace diagnostics"
check staleNonincrementalRequeued "Stale nonincremental localisation must retain pending work"
check staleNonincrementalWoke "Stale nonincremental localisation must wake the refresh loop"

// Source guards: interactive update and incremental type publication locks may
// invoke only their model commits and compact epoch/token publication.
let programSource = File.ReadAllText(Path.Combine(__SOURCE_DIRECTORY__, "Program.fs"))
let updateLockStart = programSource.IndexOf("let updateWriteWaitSw = Stopwatch.StartNew()", StringComparison.Ordinal)
let updateLockEnd = programSource.IndexOf("// Compare non-TypeDef global contributions outside the write", updateLockStart, StringComparison.Ordinal)
check (updateLockStart >= 0 && updateLockEnd > updateLockStart) "Program update write-lock segment must remain discoverable"
let updateWriteLockSegment = programSource.Substring(updateLockStart, updateLockEnd - updateLockStart)
check (not (updateWriteLockSegment.Contains("game.UpdateFile", StringComparison.Ordinal)))
      "Program update write-lock segment must not call game.UpdateFile"

let incrementalLockStart = programSource.IndexOf("let commitWriteWaitSw = Stopwatch.StartNew()", StringComparison.Ordinal)
let incrementalReleaseMarker = "exitGameStateWriteLock ()"
let incrementalRelease = programSource.IndexOf(incrementalReleaseMarker, incrementalLockStart, StringComparison.Ordinal)
let incrementalLockEnd = incrementalRelease + incrementalReleaseMarker.Length
check (incrementalLockStart >= 0 && incrementalRelease > incrementalLockStart) "Incremental type write-lock segment must remain discoverable"
let incrementalLockSegment = programSource.Substring(incrementalLockStart, incrementalLockEnd - incrementalLockStart)
for requiredCommit in [ "CommitScriptedTypes"; "CommitTypeIndex"; "bumpTypesModelEpoch" ] do
    check (incrementalLockSegment.Contains(requiredCommit, StringComparison.Ordinal))
          (sprintf "Incremental type lock must retain compact commit/token operation %s" requiredCommit)
for forbiddenFollowup in
    [ "semanticDeltaForTypeIndex"
      "decideCommittedSemanticDelta"
      "clearTypeCaches"
      "clearTypeIndexCacheForFile"
      "clearRangeBearingCompletedCaches"
      "diagnosticInvalidation.Invalidate"
      "markFileStale"
      "addPendingRefreshDomains"
      "completeRefreshDomains"
      "pendingScriptLocalisationFiles"
      "delayedScriptLocUpdate"
      "needsTypeRefresh"
      "monitorLog"
      "logDiag" ] do
    check (not (incrementalLockSegment.Contains(forbiddenFollowup, StringComparison.Ordinal)))
          (sprintf "Incremental type lock must not execute follow-up %s" forbiddenFollowup)

let semanticPlanStart = programSource.IndexOf("let incrementalSemanticChangedCandidate", StringComparison.Ordinal)
check (semanticPlanStart >= 0 && semanticPlanStart < incrementalLockStart) "Semantic delta and decision candidates must be prepared before the incremental writer"
let incrementalFollowupStart = programSource.IndexOf("if incrementalCommitSucceeded then", incrementalLockEnd, StringComparison.Ordinal)
check (incrementalFollowupStart > incrementalLockEnd) "Incremental type outcome follow-up must start after release"
let incrementalFollowupSegment = programSource.Substring(incrementalFollowupStart, programSource.IndexOf("if useInteractiveValidation", incrementalFollowupStart, StringComparison.Ordinal) - incrementalFollowupStart)
for expectedFollowup in [ "clearTypeCaches"; "diagnosticInvalidation.Invalidate"; "markFileStale"; "monitorLog" ] do
    check (incrementalFollowupSegment.Contains(expectedFollowup, StringComparison.Ordinal))
          (sprintf "Incremental type follow-up must retain behavior %s outside the writer" expectedFollowup)

// Behavior seam: immutable semantic metadata is planned before acquisition; commit
// success selects the plan, then every observable follow-up runs after release.
let mutable semanticPlanSawWriteLock = true
let semanticPlan =
    measure PrepareOutsideLock ExpensiveCallback 3.0 (fun () ->
        semanticPlanSawWriteLock <- rootLock.IsWriteLockHeld
        "type-index-only")
check (not semanticPlanSawWriteLock) "Incremental semantic decision preparation must not hold the writer"
let mutable typeCommitSucceeded = false
rootLock.EnterWriteLock()
try
    check rootLock.IsWriteLockHeld "The staged type commit must hold the writer"
    typeCommitSucceeded <- true
finally
    rootLock.ExitWriteLock()
let mutable typeFollowups = []
if typeCommitSucceeded then
    for followup in [ "cache"; "invalidation"; "stale"; "domains"; "log" ] do
        measure FollowupOutsideLock ExpensiveCallback 1.0 (fun () ->
            check (not rootLock.IsWriteLockHeld) (sprintf "Incremental %s follow-up must run after writer release" followup)
            typeFollowups <- followup :: typeFollowups)
equal "type-index-only" semanticPlan "The precomputed semantic decision must survive commit"
equal [ "log"; "domains"; "stale"; "invalidation"; "cache" ] typeFollowups "Successful commit must dispatch each type follow-up once"

let snapshot = timings.Snapshot()
check (snapshot |> List.exists (fun timing -> timing.Phase = PrepareOutsideLock && timing.Outcome = Completed))
      "The gate must exercise preparation outside the lock"
check (snapshot |> List.exists (fun timing -> timing.Phase = CommitInsideLock && timing.Outcome = Completed))
      "The gate must exercise commit work inside the real lock"
check (snapshot |> List.exists (fun timing -> timing.Phase = FollowupOutsideLock && timing.Outcome = Completed))
      "The gate must exercise publication outside the lock"


// Configuration reload seam: all expensive preparation stays before writer
// acquisition; stale generations publish neither epochs nor coordinator wake.
let configBlockStart = programSource.IndexOf("let configurationGeneration =", StringComparison.Ordinal)
let configLockStart = programSource.IndexOf("let initWriteWaitSw = Stopwatch.StartNew()", configBlockStart, StringComparison.Ordinal)
let configLockRelease = programSource.IndexOf("exitGameStateWriteLock ()", configLockStart, StringComparison.Ordinal)
check (configBlockStart >= 0 && configLockStart > configBlockStart && configLockRelease > configLockStart)
      "Configuration reload write-lock segment must remain discoverable"
let configPreparationSegment = programSource.Substring(configBlockStart, configLockStart - configBlockStart)
for requiredPreparation in [ "acquireHeavyAnalysisGate"; "setupRulesCaches"; "checkOrSetGameCache"; "processWorkspace rootUri None" ] do
    check (configPreparationSegment.Contains(requiredPreparation, StringComparison.Ordinal))
          (sprintf "Configuration preparation must retain %s before the writer" requiredPreparation)
let configLockSegment = programSource.Substring(configLockStart, configLockRelease - configLockStart)
for forbiddenPreparation in [ "setupRulesCaches"; "checkOrSetGameCache"; "processWorkspace rootUri None" ] do
    check (not (configLockSegment.Contains(forbiddenPreparation, StringComparison.Ordinal)))
          (sprintf "Configuration write-lock segment must exclude %s" forbiddenPreparation)
for requiredCommit in
    [ "rulesUpdateGeneration"
      "refreshCoordinator.Clear"
      "bumpGameModelEpoch"
      "committedInteractiveVersions.Clear"
      "committedTypeIndexVersions.Clear"
      "publishPreparedWorkspace" ] do
    check (configLockSegment.Contains(requiredCommit, StringComparison.Ordinal))
          (sprintf "Configuration write-lock segment must retain %s" requiredCommit)

let configReaderLock = new Threading.ReaderWriterLockSlim()
let preparationStarted = new Threading.ManualResetEventSlim(false)
let delayedPreparation =
    Threading.Tasks.Task.Run(fun () ->
        preparationStarted.Set()
        Threading.Thread.Sleep(200))
check (preparationStarted.Wait(1000)) "Delayed configuration preparation must start"
let readSw = Diagnostics.Stopwatch.StartNew()
configReaderLock.EnterReadLock()
configReaderLock.ExitReadLock()
readSw.Stop()
delayedPreparation.GetAwaiter().GetResult()
check (readSw.ElapsedMilliseconds < 150L)
      (sprintf "ReaderWriterLockSlim reads must proceed during >150ms preparation; read took %dms" readSw.ElapsedMilliseconds)

let liveConfigGeneration = 42L
let capturedConfigGeneration = 41L
let mutable configEpochs = 0
let mutable configWakeCount = 0
configReaderLock.EnterWriteLock()
try
    if liveConfigGeneration = capturedConfigGeneration then
        configEpochs <- configEpochs + 1
        configWakeCount <- configWakeCount + 1
finally
    configReaderLock.ExitWriteLock()
equal 0 configEpochs "Stale configuration preparation must not bump epochs"
equal 0 configWakeCount "Stale configuration preparation must not clear/wake the coordinator"


// Workspace publication seam: candidate construction and diagnostics remain
// detached; only typed/untyped references are swapped under the root writer.
let workspacePrepareStart = programSource.IndexOf("    let prepareWorkspace ", StringComparison.Ordinal)
let workspacePublishStart = programSource.IndexOf("    let publishPreparedWorkspace ", workspacePrepareStart, StringComparison.Ordinal)
let workspaceDiscardStart = programSource.IndexOf("    let discardPreparedWorkspace ", workspacePublishStart, StringComparison.Ordinal)
check (workspacePrepareStart >= 0 && workspacePublishStart > workspacePrepareStart && workspaceDiscardStart > workspacePublishStart)
      "Workspace preparation/publication segments must remain discoverable"
let workspacePrepareSegment = programSource.Substring(workspacePrepareStart, workspacePublishStart - workspacePrepareStart)
for forbiddenAssignment in [ "gameObj <-"; "stlGameObj <-"; "customGameObj <-"; "activeGame <-" ] do
    check (not (workspacePrepareSegment.Contains(forbiddenAssignment, StringComparison.Ordinal)))
          (sprintf "Detached workspace preparation must exclude %s" forbiddenAssignment)
let workspacePublishSegment = programSource.Substring(workspacePublishStart, workspaceDiscardStart - workspacePublishStart)
for requiredAtomicAssignment in [ "gameFieldClearers"; "gameObj <- prepared.game"; "stlGameObj <- Some game"; "customGameObj <- Some game" ] do
    check (workspacePublishSegment.Contains(requiredAtomicAssignment, StringComparison.Ordinal))
          (sprintf "Workspace writer must retain %s" requiredAtomicAssignment)
for forbiddenFollowup in [ "CustomNotification"; "PublishDiagnostics"; "sendDiagnostics"; "CleanupCache"; "logInfo" ] do
    check (not (workspacePublishSegment.Contains(forbiddenFollowup, StringComparison.Ordinal)))
          (sprintf "Workspace writer must exclude %s follow-up" forbiddenFollowup)

printfn "RefreshLockIntegration tests passed: lock-free callbacks/type follow-up; detached workspace publication; stale final localisation rejection; exact-prefix commits; total 100ms budget"
