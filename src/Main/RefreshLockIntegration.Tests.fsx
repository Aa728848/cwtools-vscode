#load "../TestHelpers.fsx"
#load "RefreshLockPhases.fs"

open System
open System.IO
open System.Threading
open RefreshLockPhases
open TestHelpers

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

// Workspace publication seam: candidate construction and diagnostics remain
// detached; only typed/untyped references are swapped under the root writer.
let workspacePrepareStart = programSource.IndexOf("    let prepareWorkspace ", StringComparison.Ordinal)
let workspacePublishStart = programSource.IndexOf("    let publishPreparedWorkspace ", workspacePrepareStart, StringComparison.Ordinal)
let workspaceDiscardStart = programSource.IndexOf("    let completePreparedWorkspacePublication ", workspacePublishStart, StringComparison.Ordinal)
check (workspacePrepareStart >= 0 && workspacePublishStart > workspacePrepareStart && workspaceDiscardStart > workspacePublishStart)
      "Workspace preparation/publication segments must remain discoverable"
let workspacePrepareSegment = programSource.Substring(workspacePrepareStart, workspacePublishStart - workspacePrepareStart)
for forbiddenAssignment in [ "gameObj <-"; "typedGame <-"; "activeGame <-" ] do
    check (not (workspacePrepareSegment.Contains(forbiddenAssignment, StringComparison.Ordinal)))
          (sprintf "Detached workspace preparation must exclude %s" forbiddenAssignment)
let workspacePublishSegment = programSource.Substring(workspacePublishStart, workspaceDiscardStart - workspacePublishStart)
for requiredAtomicAssignment in [ "gameObj <- prepared.game"; "typedGame <- prepared.typedGame" ] do
    check (workspacePublishSegment.Contains(requiredAtomicAssignment, StringComparison.Ordinal))
          (sprintf "Workspace writer must retain %s" requiredAtomicAssignment)
for forbiddenFollowup in [ "CustomNotification"; "PublishDiagnostics"; "sendDiagnostics"; "CleanupCache"; "logInfo" ] do
    check (not (workspacePublishSegment.Contains(forbiddenFollowup, StringComparison.Ordinal)))
          (sprintf "Workspace writer must exclude %s follow-up" forbiddenFollowup)

printfn "RefreshLockIntegration tests passed: lock-free callbacks/type follow-up; detached workspace publication; stale final localisation rejection; exact-prefix commits; total 100ms budget"
