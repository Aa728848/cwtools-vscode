module LSP.Locking

open System.Threading

type ReadLockResult<'T> =
    | Acquired of 'T
    | TimedOut

/// ReaderWriterLockSlim ownership is thread-affine. Run the complete async
/// workflow synchronously on the acquiring worker so the same thread always
/// releases the read lock, even when the workflow itself yields.
let runReadLocked
    (stateLock: ReaderWriterLockSlim)
    (timeoutMs: int option)
    (cancellationToken: CancellationToken)
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
            Async.RunSynchronously(workflow, cancellationToken = cancellationToken)
            |> Acquired
        finally
            stateLock.ExitReadLock()
