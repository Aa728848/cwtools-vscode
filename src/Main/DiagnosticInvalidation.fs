namespace CWTools.Main

module DiagnosticInvalidation =
    open System

    [<RequireQualifiedAccess>]
    type Domain =
        | Localisation
        | NonLocalisation

    type Invalidation =
        | Targeted of Set<string>
        | GlobalUnknown

    [<RequireQualifiedAccess>]
    type FileKind =
        | Localisation
        | NonLocalisation

    type Admission = private Admission of path: string * domain: Domain * requiredEpoch: int64

    type private DomainState = {
        Epoch: int64
        GlobalRequired: int64
        GlobalAcknowledged: int64
        TargetedRequired: Map<string, int64>
        AcknowledgedOverrides: Map<string, int64>
    }

    type StateCounts =
        { TargetedRequired: int
          AcknowledgedOverrides: int
          RetainedEntries: int }

    type State = private State of localisation: DomainState * nonLocalisation: DomainState

    let private emptyDomain = {
        Epoch = 0L
        GlobalRequired = 0L
        GlobalAcknowledged = 0L
        TargetedRequired = Map.empty
        AcknowledgedOverrides = Map.empty
    }

    let empty = State(emptyDomain, emptyDomain)

    let private get domain (State(loc, nonLoc)) =
        match domain with
        | Domain.Localisation -> loc
        | Domain.NonLocalisation -> nonLoc

    let private put domain value (State(loc, nonLoc)) =
        match domain with
        | Domain.Localisation -> State(value, nonLoc)
        | Domain.NonLocalisation -> State(loc, value)

    let private requiredEpoch path state =
        max state.GlobalRequired (state.TargetedRequired |> Map.tryFind path |> Option.defaultValue 0L)

    let private acknowledgedEpoch path state =
        max state.GlobalAcknowledged (state.AcknowledgedOverrides |> Map.tryFind path |> Option.defaultValue 0L)

    /// Merge an invalidation into one domain. Epochs advance only when that domain is invalidated.
    /// Targeted paths coalesce at the new epoch; GlobalUnknown promotes every file lazily.
    let invalidate domain invalidation state =
        let current = get domain state
        let epoch = current.Epoch + 1L
        let next =
            match invalidation with
            | Targeted paths ->
                { current with
                    Epoch = epoch
                    TargetedRequired =
                        (current.TargetedRequired, paths)
                        ||> Set.fold (fun required path -> Map.add path epoch required) }
            | GlobalUnknown ->
                { current with
                    Epoch = epoch
                    GlobalRequired = epoch
                    TargetedRequired = Map.empty
                    AcknowledgedOverrides = Map.empty }
        put domain next state

    /// Localisation files participate only in the localisation domain. Other files participate
    /// only in the non-localisation domain, preventing loc-only work from leaking into it.
    let domainForFile kind =
        match kind with
        | FileKind.Localisation -> Domain.Localisation
        | FileKind.NonLocalisation -> Domain.NonLocalisation

    let isPending domain path state =
        let d = get domain state
        let required = requiredEpoch path d
        required > acknowledgedEpoch path d

    /// Returns a token for the exact required epoch observed by this admission.
    let tryAdmit domain path state =
        let d = get domain state
        let required = requiredEpoch path d
        let acknowledged = acknowledgedEpoch path d
        if required > acknowledged then Some(Admission(path, domain, required)) else None

    let admissionEpoch (Admission(_, _, epoch)) = epoch
    let admissionPath (Admission(path, _, _)) = path
    let admissionDomain (Admission(_, domain, _)) = domain

    /// Compare only model epochs that can affect diagnostics in the selected domain.
    /// Localisation diagnostics depend on the game/localisation model, never rules/types.
    let sameEffectiveModelEpoch domain gameA rulesA typesA localisationA gameB rulesB typesB localisationB =
        match domain with
        | Domain.Localisation -> gameA = gameB && localisationA = localisationB
        | Domain.NonLocalisation -> gameA = gameB && rulesA = rulesB && typesA = typesB

    /// A result may publish only when the admission captured before computation is still exact.
    let sameAdmission left right =
        match left, right with
        | None, None -> true
        | Some(Admission(pathA, domainA, epochA)), Some(Admission(pathB, domainB, epochB)) ->
            pathA = pathB && domainA = domainB && epochA = epochB
        | _ -> false

    /// Success acknowledges only this file and only when the admission is still current.
    /// A stale completion, or any failed completion, leaves the file pending.
    let complete succeeded (Admission(path, domain, admittedEpoch)) state =
        if not succeeded then state
        else
            let d = get domain state
            if requiredEpoch path d <> admittedEpoch then state
            else
                let overrides =
                    if d.GlobalAcknowledged < d.GlobalRequired then
                        Map.add path admittedEpoch d.AcknowledgedOverrides
                    else
                        Map.remove path d.AcknowledgedOverrides
                put domain
                    { d with
                        AcknowledgedOverrides = overrides
                        TargetedRequired = Map.remove path d.TargetedRequired }
                    state

    /// Forget all per-file state. A current global requirement still applies if the path reappears.
    let delete path (State(loc, nonLoc)) =
        let remove (d: DomainState) =
            { d with
                TargetedRequired = Map.remove path d.TargetedRequired
                AcknowledgedOverrides = Map.remove path d.AcknowledgedOverrides }
        State(remove loc, remove nonLoc)

    /// Builds a stable union of every currently known resource source.
    let knownPaths (sources: seq<#seq<string>>) =
        sources
        |> Seq.collect id
        |> Seq.distinct
        |> Seq.sortWith (fun left right -> StringComparer.Ordinal.Compare(left, right))
        |> Seq.toList

    /// Takes one deterministic bounded queue snapshot without losing the remainder.
    let boundedSnapshot capacity (paths: seq<string>) =
        if capacity <= 0 then invalidArg (nameof capacity) "Capacity must be positive."
        let ordered = paths |> Seq.distinct |> Seq.sortWith (fun left right -> StringComparer.Ordinal.Compare(left, right)) |> Seq.toList
        List.truncate capacity ordered, List.skip (min capacity ordered.Length) ordered

    /// Compacts per-path state against the current authoritative path set. Once every
    /// known path has completed a global epoch, that epoch becomes the acknowledged
    /// default and all temporary per-path acknowledgements can be discarded.
    let reconcileKnownPaths domain paths state =
        let known = paths |> Set.ofSeq
        let d = get domain state
        let targeted = d.TargetedRequired |> Map.filter (fun path _ -> Set.contains path known)
        let overrides = d.AcknowledgedOverrides |> Map.filter (fun path _ -> Set.contains path known)
        let compacted = { d with TargetedRequired = targeted; AcknowledgedOverrides = overrides }
        let globalComplete =
            compacted.GlobalAcknowledged < compacted.GlobalRequired
            && (known |> Set.forall (fun path -> requiredEpoch path compacted <= acknowledgedEpoch path compacted))
        let reconciled =
            if globalComplete then
                { compacted with
                    GlobalAcknowledged = compacted.GlobalRequired
                    AcknowledgedOverrides = Map.empty }
            else compacted
        put domain reconciled state

    let counts domain state =
        let d = get domain state
        { TargetedRequired = d.TargetedRequired.Count
          AcknowledgedOverrides = d.AcknowledgedOverrides.Count
          RetainedEntries = d.TargetedRequired.Count + d.AcknowledgedOverrides.Count }

    /// Enumerates every pending known path in ordinal order; results are never truncated.
    let pendingPaths domain paths state =
        paths
        |> Seq.distinct
        |> Seq.filter (fun path -> isPending domain path state)
        |> Seq.sortWith (fun left right -> StringComparer.Ordinal.Compare(left, right))
        |> Seq.toList

    /// Thread-safe owner used by the server. All compound admission/completion
    /// operations are serialized against invalidation so stale work cannot acknowledge newer work.
    type Tracker() =
        let gate = obj ()
        let mutable state = empty

        member _.Invalidate(domain, invalidation) =
            lock gate (fun () -> state <- invalidate domain invalidation state)

        member _.IsPending(domain, path) =
            lock gate (fun () -> isPending domain path state)

        member _.TryAdmit(domain, path) =
            lock gate (fun () -> tryAdmit domain path state)

        member _.Complete(succeeded, admission) =
            lock gate (fun () -> state <- complete succeeded admission state)

        member _.Delete(path) =
            lock gate (fun () -> state <- delete path state)

        member _.ReconcileKnownPaths(domain, paths) =
            lock gate (fun () -> state <- reconcileKnownPaths domain paths state)

        member _.Counts(domain) =
            lock gate (fun () -> counts domain state)

        member _.PendingPaths(domain, paths) =
            lock gate (fun () ->
                let known = paths |> Seq.toList
                state <- reconcileKnownPaths domain known state
                pendingPaths domain known state)
