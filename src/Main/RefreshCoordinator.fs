module RefreshCoordinator

open System
open System.Collections.Generic

/// An immutable, privately issued capability describing the state for which work was requested.
/// Completion authority is the identity of this exact reference, not its observable values.
[<Sealed>]
type Ticket<'Identity when 'Identity: equality> internal (nonce: obj, generation: int64, identity: 'Identity, identityGeneration: int64, epochs: Map<string, int64>) =
    member _.Generation = generation
    member _.Identity = identity
    member _.IdentityGeneration = identityGeneration
    member _.Epochs = epochs
    member internal _.Nonce = nonce

type Completion<'Identity when 'Identity: equality> =
    | Idle
    | Run of Ticket<'Identity>

let needsWake = function
    | Run _ -> true
    | Idle -> false

let sameGameIdentity (captured: obj) (live: obj) =
    Object.ReferenceEquals(captured, live)

type Coordinator<'Identity when 'Identity: equality>() =
    let gate = obj ()
    // This per-coordinator reference is never exposed. Even same-assembly code that invokes the
    // internal constructor cannot mint a capability accepted by Complete.
    let nonce = obj ()
    let generations = Dictionary<'Identity, int64>()
    let epochs = Dictionary<string, int64>(StringComparer.Ordinal)
    let mutable generation = 0L
    let mutable running: Ticket<'Identity> option = None
    let mutable wake: Ticket<'Identity> option = None

    let epochVector () = epochs |> Seq.map (fun pair -> pair.Key, pair.Value) |> Map.ofSeq

    let makeTicket identity =
        generation <- generation + 1L
        let identityGeneration =
            match generations.TryGetValue identity with
            | true, value -> value + 1L
            | false, _ -> 1L
        generations[identity] <- identityGeneration
        Ticket<'Identity>(nonce, generation, identity, identityGeneration, epochVector ())

    /// Request work. Null identities are invalid; other values, including an empty string,
    /// are ordinary identities. Exactly one caller receives Run immediately; while it runs,
    /// all requests collapse into one wake containing the newest exact ticket.
    member _.Request(identity: 'Identity) =
        if obj.ReferenceEquals(identity, null) then nullArg (nameof identity)
        lock gate (fun () ->
            let ticket = makeTicket identity
            match running with
            | Some _ ->
                wake <- Some ticket
                Idle
            | None ->
                running <- Some ticket
                Run ticket)

    /// Complete exactly the issued capability currently running. There is deliberately no
    /// Stale, foreign, or reconstructed values cannot consume a wake.
    member _.Complete(ticket: Ticket<'Identity>) =
        if obj.ReferenceEquals(ticket, null) then nullArg (nameof ticket)
        lock gate (fun () ->
            match running with
            | None -> invalidOp "No refresh is running."
            | Some current when
                not (obj.ReferenceEquals(ticket.Nonce, nonce))
                || not (obj.ReferenceEquals(current, ticket)) ->
                invalidArg (nameof ticket) "Ticket is not the refresh currently running."
            | Some _ ->
                match wake with
                | Some next ->
                    wake <- None
                    running <- Some next
                    Run next
                | None ->
                    running <- None
                    Idle)

    /// Advance one named invalidation epoch and forget queued work. Null names are invalid;
    /// the empty name is a valid namespace key. Running work may finish, but its captured
    /// epoch vector remains observably stale.
    member _.Clear(name: string) =
        if isNull name then nullArg (nameof name)
        lock gate (fun () ->
            let value =
                match epochs.TryGetValue name with
                | true, current -> current + 1L
                | false, _ -> 1L
            epochs[name] <- value
            wake <- None)

    member _.IsCurrent(ticket: Ticket<'Identity>) =
        if obj.ReferenceEquals(ticket, null) then false
        else
            lock gate (fun () ->
                if not (obj.ReferenceEquals(ticket.Nonce, nonce)) then false
                else
                    let identityCurrent =
                        match generations.TryGetValue ticket.Identity with
                        | true, value -> value = ticket.IdentityGeneration
                        | false, _ -> false
                    identityCurrent && ticket.Epochs = epochVector ())

    member _.SnapshotEpochs() = lock gate epochVector
    member _.IsRunning = lock gate (fun () -> running.IsSome)
    member _.NeedsWake = lock gate (fun () -> wake.IsSome)
