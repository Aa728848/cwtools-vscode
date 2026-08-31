#load "DiagnosticInvalidation.fs"

open CWTools.Main.DiagnosticInvalidation

let check name condition = if not condition then failwithf "FAILED: %s" name
let acknowledge domain path state =
    match tryAdmit domain path state with
    | Some token -> complete true token state
    | None -> failwithf "Expected admission for %s" path

let targeted = empty |> invalidate Domain.NonLocalisation (Targeted(Set.ofList [ "b"; "a" ]))
check "targeted a" (isPending Domain.NonLocalisation "a" targeted)
check "targeted b" (isPending Domain.NonLocalisation "b" targeted)
check "targeted excludes c" (not (isPending Domain.NonLocalisation "c" targeted))
check "deterministic paths" (pendingPaths Domain.NonLocalisation [ "b"; "a"; "b" ] targeted = [ "a"; "b" ])

let globalState = empty |> invalidate Domain.NonLocalisation GlobalUnknown
check "global unknown" (isPending Domain.NonLocalisation "not-seen-before" globalState)
let globalAck = acknowledge Domain.NonLocalisation "one" globalState
check "exact per-file acknowledge" (not (isPending Domain.NonLocalisation "one" globalAck))
check "other globally pending" (isPending Domain.NonLocalisation "two" globalAck)

let coalesced =
    empty
    |> invalidate Domain.NonLocalisation (Targeted(Set.ofList [ "a"; "b" ]))
    |> invalidate Domain.NonLocalisation (Targeted(Set.ofList [ "b"; "c" ]))
check "coalescing" (pendingPaths Domain.NonLocalisation [ "c"; "b"; "a" ] coalesced = [ "a"; "b"; "c" ])
let promoted = coalesced |> invalidate Domain.NonLocalisation GlobalUnknown
check "promotion" (isPending Domain.NonLocalisation "unrelated" promoted)

// A targeted invalidation after GlobalUnknown advances the exact path beyond the global epoch.
let globalThenTargeted0 = empty |> invalidate Domain.NonLocalisation GlobalUnknown
let globalToken = tryAdmit Domain.NonLocalisation "x" globalThenTargeted0 |> Option.get
let globalThenTargeted1 = globalThenTargeted0 |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "x"))
let targetedToken = tryAdmit Domain.NonLocalisation "x" globalThenTargeted1 |> Option.get
check "global-to-targeted advances epoch" (admissionEpoch targetedToken > admissionEpoch globalToken)
let globalThenTargeted2 = complete true globalToken globalThenTargeted1
check "global token stale after targeted" (isPending Domain.NonLocalisation "x" globalThenTargeted2)
let globalThenTargeted3 = complete true targetedToken globalThenTargeted2
check "targeted token completes latest" (not (isPending Domain.NonLocalisation "x" globalThenTargeted3))
check "unrelated remains globally pending" (isPending Domain.NonLocalisation "other" globalThenTargeted3)

check "loc domain" (domainForFile FileKind.Localisation = Domain.Localisation)
check "nonloc domain" (domainForFile FileKind.NonLocalisation = Domain.NonLocalisation)
let locOnly = empty |> invalidate Domain.Localisation GlobalUnknown
check "loc pending" (isPending Domain.Localisation "x.yml" locOnly)
check "loc does not dirty nonloc" (not (isPending Domain.NonLocalisation "x.txt" locOnly))
let nonLocOnly = empty |> invalidate Domain.NonLocalisation GlobalUnknown
check "nonloc does not dirty loc" (not (isPending Domain.Localisation "x.yml" nonLocOnly))

// Epochs and admission tokens are domain-scoped even for the same path.
let cross0 =
    empty
    |> invalidate Domain.Localisation (Targeted(Set.singleton "same"))
    |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "same"))
let locToken = tryAdmit Domain.Localisation "same" cross0 |> Option.get
let nonLocToken = tryAdmit Domain.NonLocalisation "same" cross0 |> Option.get
check "token records loc domain" (admissionDomain locToken = Domain.Localisation)
check "token records nonloc domain" (admissionDomain nonLocToken = Domain.NonLocalisation)
let cross1 = cross0 |> invalidate Domain.Localisation (Targeted(Set.singleton "same"))
check "loc epoch advances independently" ((tryAdmit Domain.Localisation "same" cross1 |> Option.map admissionEpoch) > Some(admissionEpoch locToken))
check "nonloc epoch unchanged" ((tryAdmit Domain.NonLocalisation "same" cross1 |> Option.map admissionEpoch) = Some(admissionEpoch nonLocToken))
let cross2 = complete true locToken cross1
check "stale loc token rejected" (isPending Domain.Localisation "same" cross2)
let cross3 = complete true nonLocToken cross2
check "nonloc token completes own domain" (not (isPending Domain.NonLocalisation "same" cross3))
check "nonloc completion does not complete loc" (isPending Domain.Localisation "same" cross3)

let stale0 = empty |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "x"))
let staleToken = tryAdmit Domain.NonLocalisation "x" stale0 |> Option.get
let stale1 = stale0 |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "x"))
let stale2 = complete true staleToken stale1
check "stale admission rejected" (isPending Domain.NonLocalisation "x" stale2)
check "new admission epoch" ((tryAdmit Domain.NonLocalisation "x" stale2 |> Option.map admissionEpoch) > Some(admissionEpoch staleToken))

let deleted = targeted |> delete "a"
check "delete targeted" (not (isPending Domain.NonLocalisation "a" deleted))
let deletedGlobal = globalAck |> delete "one"
check "delete forgets global acknowledgement" (isPending Domain.NonLocalisation "one" deletedGlobal)

let failed0 = empty |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "failed"))
let failedToken = tryAdmit Domain.NonLocalisation "failed" failed0 |> Option.get
let failed1 = complete false failedToken failed0
check "failure remains pending" (isPending Domain.NonLocalisation "failed" failed1)


// Effective freshness is domain-specific: rules/types do not stale localisation.
check "loc effective epoch ignores rules/types"
    (sameEffectiveModelEpoch Domain.Localisation 7L 1L 2L 9L 7L 99L 100L 9L)
check "loc effective epoch observes game"
    (not (sameEffectiveModelEpoch Domain.Localisation 7L 1L 2L 9L 8L 1L 2L 9L))
check "loc effective epoch observes localisation"
    (not (sameEffectiveModelEpoch Domain.Localisation 7L 1L 2L 9L 7L 1L 2L 10L))
check "nonloc effective epoch ignores localisation"
    (sameEffectiveModelEpoch Domain.NonLocalisation 7L 1L 2L 9L 7L 1L 2L 100L)
check "nonloc effective epoch observes rules/types"
    (not (sameEffectiveModelEpoch Domain.NonLocalisation 7L 1L 2L 9L 7L 1L 3L 9L))

// Each target must retain the exact token captured before its computation.
let crossTarget0 = empty |> invalidate Domain.NonLocalisation (Targeted(Set.ofList [ "source"; "target" ]))
let targetBeforeCompute = tryAdmit Domain.NonLocalisation "target" crossTarget0
let crossTarget1 = crossTarget0 |> invalidate Domain.NonLocalisation (Targeted(Set.singleton "target"))
let targetBeforePublish = tryAdmit Domain.NonLocalisation "target" crossTarget1
check "cross-target stale admission rejected" (not (sameAdmission targetBeforeCompute targetBeforePublish))

let background0 = empty |> invalidate Domain.NonLocalisation GlobalUnknown
let backgroundBeforeCompute = tryAdmit Domain.NonLocalisation "workspace-file" background0
let background1 = background0 |> invalidate Domain.NonLocalisation GlobalUnknown
check "background epoch change rejected"
    (not (sameAdmission backgroundBeforeCompute (tryAdmit Domain.NonLocalisation "workspace-file" background1)))

let localisation0 = empty |> invalidate Domain.Localisation (Targeted(Set.singleton "x.yml"))
let localisationBeforeCompute = tryAdmit Domain.Localisation "x.yml" localisation0
let localisation1 = localisation0 |> invalidate Domain.Localisation (Targeted(Set.singleton "x.yml"))
check "localisation newer invalidation rejected"
    (not (sameAdmission localisationBeforeCompute (tryAdmit Domain.Localisation "x.yml" localisation1)))

let knownUnion = knownPaths [ [ "closed-b"; "loaded-a" ]; [ "loaded-a"; "closed-a" ]; [ "state-c" ] ]
check "known resources union includes loaded closed and state paths"
    (knownUnion = [ "closed-a"; "closed-b"; "loaded-a"; "state-c" ])
let queueBatch, queueRemainder = boundedSnapshot 2 [ "d"; "b"; "a"; "c"; "a" ]
check "bounded queue snapshot deterministic" (queueBatch = [ "a"; "b" ])
check "bounded queue snapshot preserves remainder" (queueRemainder = [ "c"; "d" ])

let scalePaths = [ for i in 0 .. 5657 -> sprintf "path-%04d" i ]
let scaleState = empty |> invalidate Domain.NonLocalisation (Targeted(Set.ofList scalePaths))
let scalePending = pendingPaths Domain.NonLocalisation (List.rev scalePaths) scaleState
check "5658 no truncation" (scalePending.Length = 5658)
check "5658 deterministic first" (scalePending.Head = "path-0000")
check "5658 deterministic last" (List.last scalePending = "path-5657")

let drainTracker = Tracker()
drainTracker.Invalidate(Domain.NonLocalisation, GlobalUnknown)
let mutable remainingKnown = scalePaths
let mutable drained = 0
while not remainingKnown.IsEmpty do
    let batch = drainTracker.PendingPaths(Domain.NonLocalisation, scalePaths) |> List.truncate 73
    check "bounded production-style drain makes progress" (not batch.IsEmpty)
    for path in batch do
        let admission = drainTracker.TryAdmit(Domain.NonLocalisation, path) |> Option.get
        drainTracker.Complete(true, admission)
    drained <- drained + batch.Length
    remainingKnown <- drainTracker.PendingPaths(Domain.NonLocalisation, scalePaths)
check "5658 bounded drain complete" (drained = 5658)
check "5658 bounded drain leaves none" (drainTracker.PendingPaths(Domain.NonLocalisation, scalePaths).IsEmpty)
let drainedCounts = drainTracker.Counts(Domain.NonLocalisation)
check "5658 global drain compacts acknowledged overrides" (drainedCounts.AcknowledgedOverrides = 0)
check "5658 global drain retains no per-path history" (drainedCounts.RetainedEntries = 0)

// Repeated workspace churn must not retain completed targeted paths.
let churnTracker = Tracker()
for i in 0 .. 9999 do
    let path = sprintf "churn-%05d" i
    churnTracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton path))
    let admission = churnTracker.TryAdmit(Domain.NonLocalisation, path) |> Option.get
    churnTracker.Complete(true, admission)
    if i % 997 = 0 then
        let current = churnTracker.Counts(Domain.NonLocalisation)
        check "10k churn stays compact during processing" (current.RetainedEntries = 0)
let churnCounts = churnTracker.Counts(Domain.NonLocalisation)
check "10k churn leaves no targeted history" (churnCounts.TargetedRequired = 0)
check "10k churn leaves no acknowledgement history" (churnCounts.AcknowledgedOverrides = 0)

// During a partial global drain, reconciliation bounds exceptions to current known paths.
let partialTracker = Tracker()
partialTracker.Invalidate(Domain.NonLocalisation, GlobalUnknown)
let oldKnown = [ for i in 0 .. 9999 -> sprintf "old-%05d" i ]
for path in oldKnown do
    let admission = partialTracker.TryAdmit(Domain.NonLocalisation, path) |> Option.get
    partialTracker.Complete(true, admission)
let replacementKnown = [ for i in 0 .. 36 -> sprintf "current-%02d" i ]
partialTracker.ReconcileKnownPaths(Domain.NonLocalisation, replacementKnown)
let partialCounts = partialTracker.Counts(Domain.NonLocalisation)
check "reconcile drops workspace-history acknowledgements" (partialCounts.AcknowledgedOverrides = 0)
check "retained entries bounded by current known targeted paths" (partialCounts.RetainedEntries <= replacementKnown.Length)
check "replacement paths remain globally pending" (partialTracker.PendingPaths(Domain.NonLocalisation, replacementKnown) = replacementKnown)

let tracker = Tracker()
tracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton "thread-safe"))
let trackerToken = tracker.TryAdmit(Domain.NonLocalisation, "thread-safe") |> Option.get
tracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton "thread-safe"))
tracker.Complete(true, trackerToken)
check "tracker rejects stale completion" (tracker.IsPending(Domain.NonLocalisation, "thread-safe"))
let currentTrackerToken = tracker.TryAdmit(Domain.NonLocalisation, "thread-safe") |> Option.get
tracker.Complete(true, currentTrackerToken)
check "tracker completes current admission" (not (tracker.IsPending(Domain.NonLocalisation, "thread-safe")))
tracker.Delete("thread-safe")
check "tracker delete removes targeted state" (not (tracker.IsPending(Domain.NonLocalisation, "thread-safe")))
tracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton "thread-safe"))
check "delete and recreate admits a new targeted generation" (tracker.TryAdmit(Domain.NonLocalisation, "thread-safe").IsSome)
let recreatedToken = tracker.TryAdmit(Domain.NonLocalisation, "thread-safe") |> Option.get
tracker.Complete(true, recreatedToken)
check "recreated path completes normally" (not (tracker.IsPending(Domain.NonLocalisation, "thread-safe")))
check "delete recreate leaves no retained history" (tracker.Counts(Domain.NonLocalisation).RetainedEntries = 0)

printfn "DiagnosticInvalidation: all tests passed (%d scale paths)" scalePending.Length
