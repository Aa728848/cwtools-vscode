module LSP.Locking

open System.Threading

type ReadLockResult<'T> =
    | Acquired of 'T
    | TimedOut

[<RequireQualifiedAccess>]
type RequestTerminalCause =
    | Success of response: string
    | Cancelled
    | Timeout
    | Exception

[<RequireQualifiedAccess>]
type RequestTerminalResponse =
    | Result of response: string
    | Error of code: int * message: string

type RequestTerminalDecision =
    { outcome: string
      response: RequestTerminalResponse }

let decideRequestTerminal cause =
    match cause with
    | RequestTerminalCause.Success response ->
        { outcome = "success"
          response = RequestTerminalResponse.Result response }
    | RequestTerminalCause.Cancelled ->
        { outcome = "cancelled"
          response = RequestTerminalResponse.Error(-32800, "Request cancelled") }
    | RequestTerminalCause.Timeout ->
        { outcome = "timeout"
          response = RequestTerminalResponse.Error(-32000, "Request timed out") }
    | RequestTerminalCause.Exception ->
        { outcome = "error"
          response = RequestTerminalResponse.Error(-32603, "Internal error") }

let tryTerminalizeRequest tryClaim emit cause =
    match tryClaim () with
    | Some claimed ->
        emit claimed (decideRequestTerminal cause)
        true
    | None -> false

let runWriteRequestTerminal
    (enterWriteLock: unit -> unit)
    (exitWriteLock: unit -> unit)
    (cancellationToken: CancellationToken)
    (workflow: Async<string option>)
    =
    if cancellationToken.IsCancellationRequested then
        RequestTerminalCause.Cancelled
    else
        try
            enterWriteLock ()
            try
                Async.RunSynchronously(workflow, cancellationToken = cancellationToken)
                |> Option.defaultValue "null"
                |> RequestTerminalCause.Success
            finally
                exitWriteLock ()
        with
        | :? System.OperationCanceledException -> RequestTerminalCause.Cancelled
        | :? System.TimeoutException -> RequestTerminalCause.Timeout
        | _ -> RequestTerminalCause.Exception

type RequestExecutionTiming =
    { mutable lockWaitEndAt: int64 option
      mutable lockAcquired: bool option
      mutable methodStartAt: int64 option
      mutable methodEndAt: int64 option
      mutable fallbackStartAt: int64 option
      mutable fallbackEndAt: int64 option }

type RequestExecutionSegments<'T> =
    { methodDuration: 'T option
      fallbackDuration: 'T option }

let createRequestExecutionTiming () =
    { lockWaitEndAt = None
      lockAcquired = None
      methodStartAt = None
      methodEndAt = None
      fallbackStartAt = None
      fallbackEndAt = None }

let markLockAcquired now timing =
    timing.lockWaitEndAt <- Some now
    timing.lockAcquired <- Some true
    timing.methodStartAt <- Some now

let markLockTimedOut now timing =
    // An acquired workflow can throw before returning a ReadLockResult. Never let
    // an exception/cancellation rewrite the acquisition callback's trace state.
    if timing.lockAcquired <> Some true then
        timing.lockWaitEndAt <- Some now
        timing.lockAcquired <- Some false

let closeMethod now timing =
    match timing.lockAcquired, timing.methodStartAt, timing.methodEndAt with
    | Some true, Some _, None -> timing.methodEndAt <- Some now
    | _ -> ()

let startFallback now timing =
    timing.fallbackStartAt <- Some now

let closeFallback now timing =
    if timing.fallbackStartAt.IsSome && timing.fallbackEndAt.IsNone then
        timing.fallbackEndAt <- Some now

let private segmentDuration measure startAt endAt =
    match startAt, endAt with
    | Some startTime, Some endTime when endTime >= startTime -> Some(measure startTime endTime)
    | _ -> None

let requestExecutionSegments measure timing =
    { methodDuration = segmentDuration measure timing.methodStartAt timing.methodEndAt
      fallbackDuration = segmentDuration measure timing.fallbackStartAt timing.fallbackEndAt }

/// ReaderWriterLockSlim ownership is thread-affine. Run the complete async
/// workflow synchronously on the acquiring worker so the same thread always
/// releases the read lock, even when the workflow itself yields.
let private runReadLockedWithCallbacks
    (stateLock: ReaderWriterLockSlim)
    (timeoutMs: int option)
    (cancellationToken: CancellationToken)
    (onAcquired: unit -> unit)
    (onCompleted: unit -> unit)
    (workflow: Async<'T>)
    =
    let acquired =
        match timeoutMs with
        | Some timeout -> stateLock.TryEnterReadLock(timeout)
        | None ->
            stateLock.EnterReadLock()
            true

    if not acquired then
        TimedOut
    else
        try
            // Keep this callback adjacent to Enter/TryEnter and before the handler
            // so lock wait and method time cannot overlap.
            onAcquired ()
            try
                Async.RunSynchronously(workflow, cancellationToken = cancellationToken)
                |> Acquired
            finally
                // Close handler time before releasing the lock, including when the
                // acquired workflow is cancelled or throws.
                onCompleted ()
        finally
            stateLock.ExitReadLock()

let runTracedReadLocked
    (stateLock: ReaderWriterLockSlim)
    (timeoutMs: int option)
    (cancellationToken: CancellationToken)
    (timestamp: unit -> int64)
    (timing: RequestExecutionTiming)
    (workflow: Async<'T>)
    =
    let mutable acquired = false
    let result =
        runReadLockedWithCallbacks
            stateLock
            timeoutMs
            cancellationToken
            (fun () ->
                acquired <- true
                markLockAcquired (timestamp ()) timing)
            (fun () -> closeMethod (timestamp ()) timing)
            workflow

    if not acquired then
        markLockTimedOut (timestamp ()) timing

    result

