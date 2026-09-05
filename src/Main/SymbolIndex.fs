module SymbolIndex

open System
open System.Collections.Generic
open System.Threading
open System.Threading.Tasks

[<Struct; StructuralEquality; StructuralComparison>]
type Position = { Line: int; Character: int }

[<Struct; StructuralEquality; StructuralComparison>]
type Range = { Start: Position; End: Position }

[<StructuralEquality; StructuralComparison>]
type Symbol<'Kind> =
    { Name: string
      Kind: 'Kind
      Range: Range
      SelectionRange: Range
      Detail: string option }

[<StructuralEquality; StructuralComparison>]
type DocumentSymbol<'Kind> =
    { Symbol: Symbol<'Kind>
      Children: DocumentSymbol<'Kind> list }

[<StructuralEquality; StructuralComparison>]
type WorkspaceSymbol<'File, 'Kind> =
    { File: 'File
      Symbol: Symbol<'Kind> }

let private validRange range = range.Start <= range.End
let private contains outer inner = outer <> inner && outer.Start <= inner.Start && inner.End <= outer.End
let private spanKey range = range.End.Line - range.Start.Line, range.End.Character - range.Start.Character
let private symbolOrder (index, symbol: Symbol<'Kind>) =
    // The original position is deliberately the final discriminator for non-equal
    // ranges, but the first discriminator once the ranges are identical.
    symbol.Range.Start, (spanKey symbol.Range |> fun (l, c) -> -l, -c), symbol.Range.End, index

/// Builds a deterministic hierarchy. Equal and crossing ranges remain siblings.
let documentCorpus (symbols: seq<Symbol<'Kind>>) : DocumentSymbol<'Kind> list =
    let ordered =
        symbols
        |> Seq.distinct
        |> Seq.mapi (fun i symbol -> i, symbol)
        |> Seq.filter (fun (_, symbol) -> not (isNull symbol.Name) && validRange symbol.Range && validRange symbol.SelectionRange)
        |> Seq.sortBy symbolOrder
        |> Seq.toArray
    let roots = ResizeArray<DocumentSymbol<'Kind>>()
    let stack = ResizeArray<Symbol<'Kind> * ResizeArray<DocumentSymbol<'Kind>>>()
    let closeTop () =
        let symbol, children = stack[stack.Count - 1]
        stack.RemoveAt(stack.Count - 1)
        let node = { Symbol = symbol; Children = List.ofSeq children }
        if stack.Count = 0 then roots.Add node else snd stack[stack.Count - 1] |> fun xs -> xs.Add node
    for _, symbol in ordered do
        while stack.Count > 0 && not (contains (fst stack[stack.Count - 1]).Range symbol.Range) do closeTop ()
        stack.Add(symbol, ResizeArray())
    while stack.Count > 0 do closeTop ()
    List.ofSeq roots

/// Small FIFO epoch cache. There is exactly one ordering node per live key.
type EpochCache<'Key, 'Value when 'Key: equality>(capacity: int) =
    do if capacity <= 0 then invalidArg (nameof capacity) "Capacity must be positive."
    let values = Dictionary<'Key, 'Value * LinkedListNode<'Key>>()
    let order = LinkedList<'Key>()
    let mutable epoch = 0L
    member _.Epoch = epoch
    member _.Count = values.Count
    member internal _.OrderingNodeCount = order.Count
    member _.Advance() = epoch <- epoch + 1L; values.Clear(); order.Clear(); epoch
    member _.TryGet(key: 'Key) =
        match values.TryGetValue key with
        | true, (value, _) -> Some value
        | _ -> None
    member _.Set(key: 'Key, value: 'Value) =
        match values.TryGetValue key with
        | true, (_, node) ->
            values[key] <- value, node
        | _ ->
            let node = order.AddLast key
            values.Add(key, (value, node))
        while values.Count > capacity do
            let node = order.First
            order.RemoveFirst()
            values.Remove node.Value |> ignore

let private rank (query: string) (name: string) =
    let q = query.Trim()
    if q.Length = 0 then 3, 0, name.Length
    elif String.Equals(name, q, StringComparison.OrdinalIgnoreCase) then 0, 0, name.Length
    elif name.StartsWith(q, StringComparison.OrdinalIgnoreCase) then 1, 0, name.Length
    else
        let at = name.IndexOf(q, StringComparison.OrdinalIgnoreCase)
        if at >= 0 then 2, at, name.Length else Int32.MaxValue, Int32.MaxValue, name.Length

let private fst3 (a, _, _) = a

/// Searches all file corpora, removes exact duplicate locations, and returns at most 200 stable results.
let workspaceCorpus (query: string) (files: seq<'File * seq<Symbol<'Kind>>>) : WorkspaceSymbol<'File, 'Kind> list when 'File: comparison and 'Kind: comparison =
    if isNull query then nullArg (nameof query)
    files
    |> Seq.collect (fun (file, symbols) -> symbols |> Seq.map (fun symbol -> { File = file; Symbol = symbol }))
    |> Seq.filter (fun item -> not (isNull item.Symbol.Name) && fst3 (rank query item.Symbol.Name) <> Int32.MaxValue)
    |> Seq.distinctBy (fun item -> item.File, item.Symbol.Name, item.Symbol.Kind, item.Symbol.Range, item.Symbol.SelectionRange)
    |> Seq.sortBy (fun item -> rank query item.Symbol.Name, item.Symbol.Name.ToUpperInvariant(), item.Symbol.Name, item.File, item.Symbol.Range, item.Symbol.SelectionRange, item.Symbol.Kind, item.Symbol.Detail)
    |> Seq.truncate 200
    |> List.ofSeq


/// Bounded per-key async cache. Active flights are never evicted and admission is hard-bounded.
/// Overflow callers wait for an active slot; after the wake they recheck both maps, so equal
/// overflow keys coalesce without starting duplicate work. Completed successes use a FIFO bound.
type SingleFlightCache<'Key, 'Value when 'Key: equality>(capacity: int) =
    do if capacity <= 0 then invalidArg (nameof capacity) "Capacity must be positive."
    let gate = obj ()
    let inFlight = Dictionary<'Key, Task<'Value>>()
    let completed = Dictionary<'Key, Task<'Value>>()
    let completedOrder = LinkedList<'Key>()
    let mutable capacityChanged = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)

    let releaseWaiters () =
        let waiters = capacityChanged
        capacityChanged <- TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
        waiters.TrySetResult() |> ignore

    let removeIfCurrent key (task: Task<'Value>) =
        lock gate (fun () ->
            match inFlight.TryGetValue key with
            | true, currentTask when Object.ReferenceEquals(currentTask, task) ->
                inFlight.Remove key |> ignore
                releaseWaiters ()
            | _ -> ())

    let publishIfCurrent key (task: Task<'Value>) =
        lock gate (fun () ->
            match inFlight.TryGetValue key with
            | true, currentTask when Object.ReferenceEquals(currentTask, task) ->
                inFlight.Remove key |> ignore
                releaseWaiters ()
                completed[key] <- task
                completedOrder.AddLast key |> ignore
                while completed.Count > capacity do
                    let oldest = completedOrder.First
                    completedOrder.RemoveFirst()
                    completed.Remove oldest.Value |> ignore
            | _ -> ())

    member this.Get(key: 'Key, factory: unit -> Task<'Value>) =
        this.Get(key, factory, CancellationToken.None)

    member this.Get(key: 'Key, factory: unit -> Task<'Value>, cancellationToken: CancellationToken) =
        if isNull (box factory) then nullArg (nameof factory)
        cancellationToken.ThrowIfCancellationRequested()
        let mutable producer: TaskCompletionSource<'Value> option = None
        let mutable admissionWait: Task option = None
        let shared =
            lock gate (fun () ->
                match completed.TryGetValue key with
                | true, task -> task
                | _ ->
                    match inFlight.TryGetValue key with
                    | true, task -> task
                    | _ when inFlight.Count < capacity ->
                        let completion = TaskCompletionSource<'Value>(TaskCreationOptions.RunContinuationsAsynchronously)
                        producer <- Some completion
                        inFlight.Add(key, completion.Task)
                        completion.Task
                    | _ ->
                        admissionWait <- Some(capacityChanged.Task :> Task)
                        null)

        match admissionWait with
        | Some wait ->
            task {
                do! wait.WaitAsync(cancellationToken)
                return! this.Get(key, factory, cancellationToken)
            }
        | None ->
            match producer with
            | None -> shared
            | Some completion ->
                let source =
                    try
                        let task = factory ()
                        if isNull (box task) then Task.FromException<'Value>(InvalidOperationException("The factory returned null."))
                        else task
                    with error ->
                        Task.FromException<'Value>(error)

                source.ContinueWith(
                    (fun (finished: Task<'Value>) ->
                        if finished.IsCanceled then completion.TrySetCanceled() |> ignore
                        elif finished.IsFaulted then completion.TrySetException(finished.Exception.InnerExceptions) |> ignore
                        else completion.TrySetResult(finished.Result) |> ignore
                        if finished.IsCompletedSuccessfully then publishIfCurrent key shared
                        else removeIfCurrent key shared),
                    TaskContinuationOptions.ExecuteSynchronously)
                |> ignore
                shared

    member _.ClearCompleted() =
        lock gate (fun () ->
            completed.Clear()
            completedOrder.Clear())

    member _.Clear() =
        lock gate (fun () ->
            inFlight.Clear()
            completed.Clear()
            completedOrder.Clear()
            releaseWaiters ())

/// Coalesces equal epoch/key misses and refuses to publish a value built from a stale epoch.
/// The epoch is checked after every build; exhaustion faults rather than returning stale data.
let getFreshSingleFlight
    (maxRetries: int)
    (readEpoch: unit -> int64)
    (cache: SingleFlightCache<int64 * 'Key, 'Value>)
    (key: 'Key)
    (factory: int64 -> Task<'Value>)
    : Task<'Value> when 'Key: equality =
    if maxRetries < 0 then invalidArg (nameof maxRetries) "Retry count cannot be negative."
    let rec attempt remaining =
        task {
            let capturedEpoch = readEpoch ()
            let! value = cache.Get((capturedEpoch, key), fun () -> factory capturedEpoch)
            if readEpoch () = capturedEpoch then
                return value
            elif remaining > 0 then
                return! attempt (remaining - 1)
            else
                return raise (InvalidOperationException("The model epoch changed while building the symbol corpus."))
        }
    attempt maxRetries
